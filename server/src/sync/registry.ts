import { bus } from '../bus.ts';
import { config } from '../config.ts';
import { db, kvGet, kvSet, transaction } from '../db/db.ts';
import { sleep } from '../sources/http.ts';
import { registry, teamIdFromOrg, type RegistryPart } from '../sources/registry.ts';

const LIVE_INTERVAL_MS = 2 * 60_000;
const FULL_LIST_INTERVAL_MS = 24 * 3600_000;
const SUMMARY_MAX_AGE_MS = 2 * 3600_000;
const LIVE_PAGE = 50;

export interface RegistryStatus {
  fullListAt: number | null;
  listing: boolean;
  lastLiveAt: number | null;
  lastError: string | null;
}

export const registryStatus: RegistryStatus = {
  fullListAt: Number(kvGet('reg_full_list_at') ?? 0) || null,
  listing: false,
  lastLiveAt: null,
  lastError: null,
};

export interface LivePart {
  uuid: string;
  name: string;
  slug: string;
  title: string | null;
  role: string | null;
  seqLength: number | null;
  at: number;
  teams: { id: number; name: string; slug: string }[];
}

const log = (msg: string) => console.log(`${new Date().toISOString()} [registry] ${msg}`);
const emitStatus = () => bus.emit('registry-status');

const partExists = db.prepare('SELECT updated_at FROM reg_parts WHERE uuid = ?');
const upsertPart = db.prepare(`
  INSERT INTO reg_parts (uuid, name, slug, title, role_label, role_accession, seq_length, usage_count, created_at, updated_at, first_seen_at, last_listed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(uuid) DO UPDATE SET
    name = excluded.name, slug = excluded.slug, title = excluded.title, role_label = excluded.role_label,
    role_accession = excluded.role_accession, seq_length = excluded.seq_length, usage_count = excluded.usage_count,
    updated_at = excluded.updated_at, last_listed_at = MAX(reg_parts.last_listed_at, excluded.last_listed_at)`);

/** Store a part. Anything not `published` is dropped on the floor, never persisted. */
function storePart(p: RegistryPart, now: number): 'new' | 'changed' | 'same' | 'skipped' {
  if (p.status !== 'published') return 'skipped';
  const prev = partExists.get(p.uuid) as { updated_at: number } | undefined;
  const updatedAt = Date.parse(p.audit.updated);
  upsertPart.run(
    p.uuid, p.name, p.slug, p.title ?? null, p.role?.label ?? null, p.role?.accession ?? null,
    p.sequenceLength ?? null, p.usageCount ?? 0, Date.parse(p.audit.created), updatedAt, now, now,
  );
  if (!prev) return 'new';
  return prev.updated_at !== updatedAt ? 'changed' : 'same';
}

/** Full listing of every published 2026 part (~10 requests). Removes parts that are no longer published. */
async function fullListing() {
  registryStatus.listing = true;
  emitStatus();
  const started = Date.now();
  let page = 1;
  let seen = 0;
  for (;;) {
    const res = await registry.listPublished({ page, pageSize: 100, sort: 'audit.created:desc' });
    transaction(() => {
      for (const p of res.data) storePart(p, started);
    });
    seen += res.data.length;
    if (res.data.length < 100 || seen >= res.total) break;
    page++;
  }
  // Only prune after a complete listing.
  const removed = db.prepare('DELETE FROM reg_parts WHERE last_listed_at < ?').run(started).changes;
  registryStatus.fullListAt = started;
  registryStatus.listing = false;
  kvSet('reg_full_list_at', String(started));
  log(`full listing: ${seen} published 2026 parts${removed ? `, ${removed} no longer published` : ''}`);
  emitStatus();
  bus.emit('registry-updated');
}

async function attribute(uuid: string, critical = false): Promise<number[]> {
  const orgs = await registry.partOrganisations(uuid, critical);
  const teamIds = [...new Set(orgs.map(teamIdFromOrg).filter((x): x is number => x !== null))];
  transaction(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO reg_part_teams (part_uuid, team_id) VALUES (?, ?)');
    for (const t of teamIds) ins.run(uuid, t);
    db.prepare('UPDATE reg_parts SET attributed = 1 WHERE uuid = ?').run(uuid);
  });
  return teamIds;
}

const upsertSummary = db.prepare(`
  INSERT INTO reg_summary (team_id, found, published, draft, screening, rejected, with_docs, documentation, collections, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(team_id) DO UPDATE SET
    found = excluded.found, published = excluded.published, draft = excluded.draft, screening = excluded.screening,
    rejected = excluded.rejected, with_docs = excluded.with_docs, documentation = excluded.documentation,
    collections = excluded.collections, fetched_at = excluded.fetched_at`);

async function refreshSummary(teamId: number) {
  const s = await registry.teamSummary(teamId);
  const now = Date.now();
  if (!s) {
    upsertSummary.run(teamId, 0, 0, 0, 0, 0, 0, 0, 0, now);
    return;
  }
  const b = s.parts.byStatus;
  const prev = db.prepare('SELECT published, draft, screening, rejected FROM reg_summary WHERE team_id = ? AND found = 1').get(teamId) as
    | { published: number; draft: number; screening: number; rejected: number }
    | undefined;
  upsertSummary.run(teamId, 1, b.published, b.draft, b.screening, b.rejected, s.parts.withDocumentation, s.documentation.total, s.collections.total, now);
  const changed = !prev || prev.published !== b.published || prev.draft !== b.draft || prev.screening !== b.screening || prev.rejected !== b.rejected;
  if (changed) {
    db.prepare('INSERT OR REPLACE INTO reg_summary_history (team_id, at, published, draft, screening, rejected) VALUES (?, ?, ?, ?, ?, ?)').run(
      teamId, now, b.published, b.draft, b.screening, b.rejected,
    );
    if (prev) {
      bus.emit('registry-updated');
      bus.emit('summary-delta', {
        teamId,
        published: b.published - prev.published,
        draft: b.draft - prev.draft,
        screening: b.screening - prev.screening,
        totals: { published: b.published, draft: b.draft, screening: b.screening },
      });
    }
  }
}

const teamNames = db.prepare('SELECT id, name, slug FROM teams WHERE id = ?');

/** Newest-updated published parts, every 2 minutes, on the reserved budget. */
async function livePoll() {
  try {
    const res = await registry.listPublished({ page: 1, pageSize: LIVE_PAGE, sort: 'audit.updated:desc', critical: true });
    const now = Date.now();
    const announce: LivePart[] = [];
    const touchedTeams = new Set<number>();
    for (const p of res.data) {
      const state = storePart(p, now);
      if (state === 'same' || state === 'skipped') continue;
      let teamIds: number[];
      if (state === 'new') teamIds = await attribute(p.uuid, true);
      else teamIds = (db.prepare('SELECT team_id FROM reg_part_teams WHERE part_uuid = ?').all(p.uuid) as { team_id: number }[]).map((r) => r.team_id);
      teamIds.forEach((t) => touchedTeams.add(t));
      // Before the first full listing everything looks new; that's backlog, not news.
      if (state === 'new' && registryStatus.fullListAt) {
        announce.push({
          uuid: p.uuid, name: p.name, slug: p.slug, title: p.title, role: p.role?.label ?? null,
          seqLength: p.sequenceLength, at: Date.parse(p.audit.updated),
          teams: teamIds.map((t) => teamNames.get(t) as { id: number; name: string; slug: string }).filter(Boolean),
        });
      }
    }
    // Counts for teams whose parts just changed are refreshed next by the worker.
    const stale = db.prepare('UPDATE reg_summary SET fetched_at = 0 WHERE team_id = ?');
    for (const t of touchedTeams) stale.run(t);
    if (announce.length) bus.emit('parts', announce);
    if (touchedTeams.size || announce.length) bus.emit('registry-updated');
    registryStatus.lastLiveAt = now;
    registryStatus.lastError = null;
  } catch (err) {
    registryStatus.lastError = String(err);
    log(`live poll error: ${String(err)}`);
  }
  emitStatus();
}

type Task = { label: string; run: () => Promise<unknown> };

/**
 * Next unit of background work. During the initial load, never-fetched team counts and
 * unattributed parts alternate so both views fill in together; stale counts come last.
 */
function nextTask(preferParts: boolean): Task | null {
  // Teams never summarised — counts are the headline numbers. Home team first, then most active.
  const unsummarised = db
    .prepare(`
      SELECT t.id FROM teams t LEFT JOIN reg_summary s ON s.team_id = t.id
      WHERE s.team_id IS NULL
      ORDER BY (t.slug = ?) DESC, COALESCE(t.last_activity_at, 0) DESC LIMIT 1`)
    .get(config.homeTeam) as { id: number } | undefined;
  // Parts not yet attributed to a team, newest first.
  const part = db.prepare('SELECT uuid FROM reg_parts WHERE attributed = 0 ORDER BY created_at DESC LIMIT 1').get() as
    | { uuid: string }
    | undefined;
  const summaryTask = unsummarised && { label: 'summary', run: () => refreshSummary(unsummarised.id) };
  const partTask = part && { label: 'attribute', run: () => attribute(part.uuid) };
  const first = preferParts ? partTask || summaryTask : summaryTask || partTask;
  if (first) return first;

  // Stale summaries (live poll zeroes fetched_at for teams with fresh part activity).
  const stale = db
    .prepare(`
      SELECT s.team_id FROM reg_summary s JOIN teams t ON t.id = s.team_id
      WHERE s.fetched_at < ? ORDER BY s.fetched_at ASC LIMIT 1`)
    .get(Date.now() - SUMMARY_MAX_AGE_MS) as { team_id: number } | undefined;
  if (stale) return { label: 'summary', run: () => refreshSummary(stale.team_id) };
  return null;
}

async function worker() {
  let sinceEmit = 0;
  let turn = 0;
  for (;;) {
    const task = nextTask(turn++ % 2 === 1);
    if (!task) {
      await sleep(30_000);
      continue;
    }
    try {
      await task.run();
      // Batch UI refresh hints during the long initial load.
      if (++sinceEmit >= 10) {
        sinceEmit = 0;
        bus.emit('registry-updated');
        emitStatus();
      }
    } catch (err) {
      registryStatus.lastError = `${task.label}: ${String(err)}`;
      log(`${task.label} failed: ${String(err)}`);
      await sleep(10_000);
    }
  }
}

export async function startRegistry() {
  const due = () => !registryStatus.fullListAt || Date.now() - registryStatus.fullListAt > FULL_LIST_INTERVAL_MS;
  try {
    if (due()) await fullListing();
  } catch (err) {
    registryStatus.listing = false;
    registryStatus.lastError = String(err);
    log(`full listing failed: ${String(err)}`);
  }
  await livePoll();
  setInterval(livePoll, LIVE_INTERVAL_MS);
  setInterval(() => {
    if (due()) fullListing().catch((err) => log(`full listing failed: ${String(err)}`));
  }, 3600_000);
  worker();
}
