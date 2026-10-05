import { config } from '../config.ts';
import { db, kvSet, transaction } from '../db/db.ts';
import { gitlab, type GitlabProject } from '../sources/gitlab.ts';
import { fillMissingCoordinates, usableCoords } from '../geo/geocode.ts';
import { HttpError, mapPool } from '../sources/http.ts';
import { getTeam, listTeams, listVillages } from '../sources/igem.ts';

const DETAIL_MAX_AGE_MS = 7 * 24 * 3600_000;

export interface TeamSyncReport {
  teams: number;
  detailsFetched: number;
  matched: number;
  unmatched: { id: number; name: string; slug: string }[];
  detailErrors: { id: number; name: string; error: string }[];
}

export async function syncTeams(log: (msg: string) => void = console.log): Promise<TeamSyncReport> {
  const year = config.year;
  log(`[teams] fetching iGEM ${year} registry…`);
  const summaries = await listTeams(year);
  log(`[teams] ${summaries.length} teams in registry`);
  // Villages are a nice-to-have: if the lookup fails, keep the stored names rather than failing the sync.
  let villages: Map<string, string> | null = null;
  try {
    villages = new Map((await listVillages()).map((village) => [village.uuid, village.name]));
  } catch (err) {
    log(`[teams] village lookup failed, keeping stored villages: ${String(err)}`);
  }
  const villageOf = (uuid: string | null | undefined) => (villages ? (villages.get(uuid ?? '') ?? null) : undefined);

  const known = new Map(
    (db.prepare('SELECT id, slug, detail_fetched_at FROM teams').all() as { id: number; slug: string; detail_fetched_at: number | null }[]).map(
      (r) => [r.id, r],
    ),
  );
  const now = Date.now();
  const needDetail = summaries.filter((s) => {
    const k = known.get(s.id);
    return !k || !k.detail_fetched_at || now - k.detail_fetched_at > DETAIL_MAX_AGE_MS;
  });
  log(`[teams] fetching ${needDetail.length} team detail records (coords, slug)…`);

  const upsertDetail = db.prepare(`
    INSERT INTO teams (id, slug, name, village, institution, city, country, region, section, status, is_remote, lat, lng, coord_source, detail_fetched_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      slug = excluded.slug, name = excluded.name, village = COALESCE(excluded.village, teams.village), institution = excluded.institution, city = excluded.city,
      country = excluded.country, region = excluded.region, section = excluded.section, status = excluded.status,
      is_remote = excluded.is_remote, detail_fetched_at = excluded.detail_fetched_at, updated_at = excluded.updated_at,
      -- Keep previously geocoded coordinates when the registry still has none.
      lat = CASE WHEN excluded.coord_source = 'registry' THEN excluded.lat ELSE teams.lat END,
      lng = CASE WHEN excluded.coord_source = 'registry' THEN excluded.lng ELSE teams.lng END,
      coord_source = CASE WHEN excluded.coord_source = 'registry' THEN 'registry' ELSE teams.coord_source END`);

  let done = 0;
  const { errors } = await mapPool(needDetail, 4, async (s) => {
    const d = await getTeam(s.id);
    const inst = d.institutions?.[0];
    const valid = usableCoords(d.lat ?? null, d.lng ?? null, d.country);
    upsertDetail.run(
      d.id, d.slug, d.name, villageOf(s.villageUUID) ?? null, inst?.name ?? null, d.city, d.country, d.region, d.section, d.status,
      d.isRemote ? 1 : 0, valid ? d.lat : null, valid ? d.lng : null, valid ? 'registry' : null, Date.now(), Date.now(),
    );
    if (++done % 50 === 0) log(`[teams]   ${done}/${needDetail.length}`);
  });

  // Registry fields that may change between detail refreshes (status, name).
  const updateSummary = db.prepare('UPDATE teams SET name = ?, status = ?, section = ?, region = ?, updated_at = ? WHERE id = ?');
  const updateVillage = db.prepare('UPDATE teams SET village = ? WHERE id = ?');
  transaction(() => {
    for (const s of summaries) {
      updateSummary.run(s.name, s.status, s.section, s.region, now, s.id);
      if (villages) updateVillage.run(villageOf(s.villageUUID) ?? null, s.id);
    }
  });
  if (villages) kvSet('villages_synced_at', String(now));

  await fillMissingCoordinates(log);

  log('[teams] listing GitLab projects in namespace…');
  const projects = await gitlab.listYearProjects(year);
  log(`[teams] ${projects.length} GitLab projects found in ${year}/`);
  const bySlug = new Map(projects.map((p) => [p.path.toLowerCase(), p]));

  const teams = db.prepare('SELECT id, slug, name FROM teams').all() as { id: number; slug: string; name: string }[];
  const missing = teams.filter((t) => !bySlug.has(t.slug.toLowerCase()));
  // Namespace search can miss a few; try a direct lookup before declaring a team unmatched.
  await mapPool(missing, 4, async (t) => {
    try {
      const p = await gitlab.getProject(`${year}/${t.slug}`);
      bySlug.set(t.slug.toLowerCase(), p);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
  });

  const setProject = db.prepare(`
    UPDATE teams SET gitlab_project_id = ?, gitlab_path = ?, project_created_at = ?, last_activity_at = ? WHERE id = ?`);
  const unmatched: TeamSyncReport['unmatched'] = [];
  transaction(() => {
    for (const t of teams) {
      const p: GitlabProject | undefined = bySlug.get(t.slug.toLowerCase());
      if (!p) {
        unmatched.push(t);
        continue;
      }
      setProject.run(p.id, p.path_with_namespace, Date.parse(p.created_at), Date.parse(p.last_activity_at), t.id);
    }
  });
  kvSet('teams_synced_at', String(Date.now()));

  const report: TeamSyncReport = {
    teams: teams.length,
    detailsFetched: needDetail.length - errors.length,
    matched: teams.length - unmatched.length,
    unmatched,
    detailErrors: errors.map((e) => ({ id: e.item.id, name: e.item.name, error: String(e.error) })),
  };
  log(`[teams] matched ${report.matched}/${report.teams} teams to GitLab projects; ${unmatched.length} unmatched, ${errors.length} detail errors`);
  return report;
}
