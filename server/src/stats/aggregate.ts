import { db } from '../db/db.ts';
import { recentNews } from '../intel/breaking.ts';
import { homeTeam, subscribedIds } from '../intel/watch.ts';
import { detailCoverage, pagesTouched } from '../sync/diffs.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Heat decays with a 48h time constant: a commit now counts 1, one two days ago ~0.37. */
const HEAT_TAU_MS = 48 * HOUR;
const SPARK_DAYS = 14;

export interface TeamSummary {
  id: number;
  slug: string;
  name: string;
  village: string | null;
  institution: string | null;
  city: string | null;
  country: string | null;
  region: string | null;
  section: string | null;
  status: string | null;
  lat: number | null;
  lng: number | null;
  /** registry | institution | city — 'city' means the marker is only city-accurate. */
  coordSource: string | null;
  gitlabPath: string | null;
  synced: boolean;
  commits: number;
  lastCommitAt: number | null;
  c24h: number;
  c7d: number;
  c30d: number;
  additions: number;
  deletions: number;
  contributors: number;
  heat: number;
  spark: number[]; // daily commit counts, oldest first, last element = today (UTC)
  rank7d: number | null;
  rankTotal: number | null;
  /** Parts registry counts; null until the team's summary has been fetched. */
  registry: { published: number; draft: number; screening: number } | null;
  subscribed: boolean;
  /** Same iGEM village as the home team (direct competitors). */
  sameVillage: boolean;
}

const dayStart = (t: number) => Math.floor(t / DAY) * DAY;

export function teamSummaries(now = Date.now()): TeamSummary[] {
  const rows = db
    .prepare(`
      SELECT t.id, t.slug, t.name, t.village, t.institution, t.city, t.country, t.region, t.section, t.status, t.lat, t.lng,
             t.coord_source, t.gitlab_path, COALESCE(s.backfilled, 0) AS backfilled,
             COUNT(c.sha) AS commits, MAX(c.committed_at) AS last_commit_at,
             COALESCE(SUM(c.committed_at >= :d1), 0) AS c24h,
             COALESCE(SUM(c.committed_at >= :d7), 0) AS c7d,
             COALESCE(SUM(c.committed_at >= :d30), 0) AS c30d,
             COALESCE(SUM(c.additions), 0) AS additions, COALESCE(SUM(c.deletions), 0) AS deletions,
             COUNT(DISTINCT LOWER(c.author_email)) AS contributors,
             rs.found AS reg_found, rs.published AS reg_published, rs.draft AS reg_draft, rs.screening AS reg_screening
      FROM teams t
      LEFT JOIN reg_summary rs ON rs.team_id = t.id
      -- Ignore commits dated in the future (misconfigured clocks) so they can't pin "last commit".
      LEFT JOIN commits c ON c.team_id = t.id AND c.is_template = 0 AND c.committed_at <= :future
      LEFT JOIN sync_state s ON s.team_id = t.id
      GROUP BY t.id`)
    .all({ d1: now - DAY, d7: now - 7 * DAY, d30: now - 30 * DAY, future: now + HOUR }) as Record<string, any>[];

  const sparkStart = dayStart(now) - (SPARK_DAYS - 1) * DAY;
  const recent = db
    .prepare('SELECT team_id, committed_at FROM commits WHERE is_template = 0 AND committed_at >= ?')
    .all(sparkStart) as { team_id: number; committed_at: number }[];
  const heat = new Map<number, number>();
  const spark = new Map<number, number[]>();
  for (const r of recent) {
    const age = Math.max(0, now - r.committed_at);
    heat.set(r.team_id, (heat.get(r.team_id) ?? 0) + Math.exp(-age / HEAT_TAU_MS));
    let s = spark.get(r.team_id);
    if (!s) spark.set(r.team_id, (s = new Array(SPARK_DAYS).fill(0)));
    const idx = Math.floor((r.committed_at - sparkStart) / DAY);
    if (idx >= 0 && idx < SPARK_DAYS) s[idx]++;
  }

  const teams: TeamSummary[] = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    village: r.village,
    institution: r.institution,
    city: r.city,
    country: r.country,
    region: r.region,
    section: r.section,
    status: r.status,
    lat: r.lat,
    lng: r.lng,
    coordSource: r.coord_source,
    gitlabPath: r.gitlab_path,
    synced: Boolean(r.backfilled),
    commits: r.commits,
    lastCommitAt: r.last_commit_at,
    c24h: r.c24h,
    c7d: r.c7d,
    c30d: r.c30d,
    additions: r.additions,
    deletions: r.deletions,
    contributors: r.contributors,
    heat: Math.round((heat.get(r.id) ?? 0) * 1000) / 1000,
    spark: spark.get(r.id) ?? new Array(SPARK_DAYS).fill(0),
    rank7d: null,
    rankTotal: null,
    registry: r.reg_found ? { published: r.reg_published, draft: r.reg_draft, screening: r.reg_screening } : null,
    subscribed: false,
    sameVillage: false,
  }));

  const subs = subscribedIds();
  const homeVillage = homeTeam()?.village ?? null;
  for (const t of teams) {
    t.subscribed = subs.has(t.id);
    t.sameVillage = homeVillage !== null && t.village === homeVillage;
  }

  assignRanks(teams, 'c7d', 'rank7d');
  assignRanks(teams, 'commits', 'rankTotal');
  return teams;
}

/** Standard competition ranking (1, 2, 2, 4); teams with zero get no rank. */
function assignRanks(teams: TeamSummary[], key: 'c7d' | 'commits', out: 'rank7d' | 'rankTotal') {
  const sorted = teams.filter((t) => t[key] > 0).sort((a, b) => b[key] - a[key]);
  sorted.forEach((t, i) => {
    t[out] = i > 0 && sorted[i - 1][key] === t[key] ? sorted[i - 1][out] : i + 1;
  });
}

export interface TeamDetail extends TeamSummary {
  wikiUrl: string;
  repoUrl: string | null;
  regionRank7d: number | null;
  regionTeams: number;
  daily: { start: number; counts: number[] }; // last 60 UTC days
  hourWeekday: number[][]; // [weekday 0=Sun][UTC hour] commit counts
  authors: { name: string; commits: number; additions: number; deletions: number; lastAt: number }[];
  recent: { sha: string; title: string; author: string; at: number; additions: number; deletions: number }[];
  /** File-level detail; only collected for the home team and subscribed teams. */
  pages: ReturnType<typeof pagesTouched> | null;
  pageCoverage: { commits: number; detailed: number } | null;
  news: { id: number; at: number; headline: string; severity: string }[];
}

export function teamDetail(id: number, now = Date.now()): TeamDetail | undefined {
  const all = teamSummaries(now);
  const t = all.find((x) => x.id === id);
  if (!t) return undefined;

  const regionTeams = all.filter((x) => x.region === t.region);
  const regionActive = regionTeams.filter((x) => x.c7d > 0).sort((a, b) => b.c7d - a.c7d);
  const regionIdx = regionActive.findIndex((x) => x.id === id);

  const DAYS = 60;
  const start = dayStart(now) - (DAYS - 1) * DAY;
  const counts = new Array(DAYS).fill(0);
  const hourWeekday = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const commits = db
    .prepare('SELECT committed_at FROM commits WHERE team_id = ? AND is_template = 0')
    .all(id) as { committed_at: number }[];
  for (const c of commits) {
    const idx = Math.floor((c.committed_at - start) / DAY);
    if (idx >= 0 && idx < DAYS) counts[idx]++;
    const d = new Date(c.committed_at);
    hourWeekday[d.getUTCDay()][d.getUTCHours()]++;
  }

  const authors = (
    db
      .prepare(`
        SELECT MAX(author_name) AS name, COUNT(*) AS commits, SUM(additions) AS additions, SUM(deletions) AS deletions,
               MAX(committed_at) AS lastAt
        FROM commits WHERE team_id = ? AND is_template = 0
        GROUP BY LOWER(author_email) ORDER BY commits DESC LIMIT 12`)
      .all(id) as any[]
  ).map((a) => ({ ...a }));

  const recent = (
    db
      .prepare(`
        SELECT sha, title, author_name AS author, committed_at AS at, additions, deletions
        FROM commits WHERE team_id = ? AND is_template = 0 ORDER BY committed_at DESC LIMIT 25`)
      .all(id) as any[]
  ).map((r) => ({ ...r }));

  const watched = t.subscribed || t.id === homeTeam()?.id;
  const weekAgo = now - 7 * DAY;
  return {
    ...t,
    pages: watched ? pagesTouched(id, weekAgo, 20) : null,
    pageCoverage: watched ? detailCoverage(id, weekAgo) : null,
    news: recentNews(100)
      .filter((n) => n.team?.id === id)
      .slice(0, 10)
      .map((n) => ({ id: n.id, at: n.at, headline: n.headline, severity: n.severity })),
    wikiUrl: `https://2026.igem.wiki/${t.slug}`,
    repoUrl: t.gitlabPath ? `https://gitlab.igem.org/${t.gitlabPath}` : null,
    regionRank7d: regionIdx >= 0 ? regionIdx + 1 : null,
    regionTeams: regionTeams.length,
    daily: { start, counts },
    hourWeekday,
    authors,
    recent,
  };
}

export interface FeedItem {
  teamId: number;
  teamName: string;
  slug: string;
  sha: string;
  title: string;
  author: string;
  at: number;
  additions: number;
  deletions: number;
}

export function feed(limit = 60): FeedItem[] {
  return (
    db
      .prepare(`
        SELECT c.team_id AS teamId, t.name AS teamName, t.slug, c.sha, c.title, c.author_name AS author,
               c.committed_at AS at, c.additions, c.deletions
        FROM commits c JOIN teams t ON t.id = c.team_id
        WHERE c.is_template = 0 AND c.committed_at <= ?
        ORDER BY c.committed_at DESC LIMIT ?`)
      .all(Date.now() + HOUR, limit) as any[]
  ).map((r) => ({ ...r }));
}

/** Per-team daily commit counts for the time-replay scrubber. */
export function activity(days = 120, now = Date.now()) {
  const start = dayStart(now) - (days - 1) * DAY;
  const rows = db
    .prepare(`
      SELECT team_id, (committed_at - ?) / ${DAY} AS day, COUNT(*) AS n
      FROM commits WHERE is_template = 0 AND committed_at >= ?
      GROUP BY team_id, day`)
    .all(start, start) as { team_id: number; day: number; n: number }[];
  const series: Record<number, number[]> = {};
  for (const r of rows) {
    const day = Math.floor(r.day);
    if (day >= days) continue;
    (series[r.team_id] ??= new Array(days).fill(0))[day] += r.n;
  }
  return { start, days, dayMs: DAY, series };
}

export function globalStats(now = Date.now()) {
  const q = (since: number) =>
    db
      .prepare('SELECT COUNT(*) AS commits, COUNT(DISTINCT team_id) AS teams FROM commits WHERE is_template = 0 AND committed_at >= ?')
      .get(since) as { commits: number; teams: number };
  const total = db.prepare('SELECT COUNT(*) AS n FROM commits WHERE is_template = 0').get() as { n: number };
  return { last24h: q(now - DAY), last7d: q(now - 7 * DAY), totalCommits: total.n };
}
