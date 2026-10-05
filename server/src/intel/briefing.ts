import { bus } from '../bus.ts';
import { config } from '../config.ts';
import { db } from '../db/db.ts';
import { detailCoverage, pagesTouched } from '../sync/diffs.ts';
import { recentNews, type NewsEvent } from './breaking.ts';
import { homeTeam, relationOf, subscribedIds, type Relation } from './watch.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// ---------- time zone helpers (no dependencies; DST-correct via Intl) ----------

function zonedParts(t: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
}

/** UTC instant of a wall-clock time in `tz`. */
function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const target = Date.UTC(y, m - 1, d, h, min);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, tz);
    guess += target - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  }
  return guess;
}

function slotOn(t: number): number {
  const [h, min] = config.briefingTime.split(':').map(Number);
  const p = zonedParts(t, config.briefingTimeZone);
  return zonedToUtc(p.y, p.m, p.d, h, min, config.briefingTimeZone);
}

/** Most recent briefing slot at or before `now`. */
export function latestSlot(now = Date.now()): number {
  const today = slotOn(now);
  return today <= now ? today : slotOn(now - DAY);
}

export function nextSlot(now = Date.now()): number {
  const today = slotOn(now);
  return today > now ? today : slotOn(now + DAY);
}

// ---------- briefing assembly ----------

interface TeamRef {
  id: number;
  name: string;
  slug: string;
  country: string | null;
  village: string | null;
  relation: Relation;
}

const teamRef = (id: number): TeamRef | null => {
  const t = db.prepare('SELECT id, name, slug, country, village FROM teams WHERE id = ?').get(id) as Omit<TeamRef, 'relation'> | undefined;
  return t ? { ...t, relation: relationOf(t.id) } : null;
};

/** Standard competition ranks by commits in [end − 7d, end). */
function ranks7d(end: number): Map<number, number> {
  const rows = db
    .prepare(`
      SELECT team_id, COUNT(*) AS n FROM commits
      WHERE is_template = 0 AND committed_at >= ? AND committed_at < ? GROUP BY team_id ORDER BY n DESC`)
    .all(end - 7 * DAY, end) as { team_id: number; n: number }[];
  const out = new Map<number, number>();
  rows.forEach((r, i) => out.set(r.team_id, i > 0 && rows[i - 1].n === r.n ? out.get(rows[i - 1].team_id)! : i + 1));
  return out;
}

function windowCommitsByTeam(start: number, end: number) {
  return db
    .prepare(`
      SELECT team_id, COUNT(*) AS commits, SUM(additions) AS additions, SUM(deletions) AS deletions,
             COUNT(DISTINCT LOWER(author_email)) AS contributors
      FROM commits WHERE is_template = 0 AND committed_at >= ? AND committed_at < ?
      GROUP BY team_id`)
    .all(start, end) as { team_id: number; commits: number; additions: number; deletions: number; contributors: number }[];
}

/** Registry counts as of a moment, from the change history. */
function registryAt(teamId: number, t: number) {
  return db
    .prepare('SELECT published, draft, screening FROM reg_summary_history WHERE team_id = ? AND at <= ? ORDER BY at DESC LIMIT 1')
    .get(teamId, t) as { published: number; draft: number; screening: number } | undefined;
}

function registryDelta(teamId: number, start: number, end: number) {
  const before = registryAt(teamId, start);
  const after = registryAt(teamId, end);
  if (!after) return null;
  return {
    published: after.published,
    draft: after.draft,
    screening: after.screening,
    publishedChange: before ? after.published - before.published : null,
    draftChange: before ? after.draft - before.draft : null,
  };
}

function teamDossier(teamId: number, start: number, end: number, ranksNow: Map<number, number>, ranksBefore: Map<number, number>, news: NewsEvent[]) {
  const ref = teamRef(teamId);
  if (!ref) return null;
  const agg = windowCommitsByTeam(start, end).find((r) => r.team_id === teamId);
  const commits = (
    db
      .prepare(`
        SELECT sha, title, author_name AS author, committed_at AS at, additions, deletions FROM commits
        WHERE team_id = ? AND is_template = 0 AND committed_at >= ? AND committed_at < ? ORDER BY committed_at DESC LIMIT 15`)
      .all(teamId, start, end) as any[]
  ).map((c) => ({ ...c }));
  const authors = (
    db
      .prepare(`
        SELECT MAX(author_name) AS name, COUNT(*) AS commits FROM commits
        WHERE team_id = ? AND is_template = 0 AND committed_at >= ? AND committed_at < ?
        GROUP BY LOWER(author_email) ORDER BY commits DESC`)
      .all(teamId, start, end) as any[]
  ).map((a) => ({ ...a }));
  const lastCommit = db.prepare('SELECT MAX(committed_at) AS t FROM commits WHERE team_id = ? AND is_template = 0').get(teamId) as { t: number | null };
  return {
    team: ref,
    commits: agg?.commits ?? 0,
    additions: agg?.additions ?? 0,
    deletions: agg?.deletions ?? 0,
    contributors: agg?.contributors ?? 0,
    lastCommitAt: lastCommit.t,
    rank7d: ranksNow.get(teamId) ?? null,
    rank7dBefore: ranksBefore.get(teamId) ?? null,
    recentCommits: commits,
    authors,
    pages: pagesTouched(teamId, start, 12),
    pageCoverage: detailCoverage(teamId, start),
    registry: registryDelta(teamId, start, end),
    news: news.filter((n) => n.team?.id === teamId).map((n) => ({ at: n.at, headline: n.headline, severity: n.severity })),
  };
}

export type TeamDossier = NonNullable<ReturnType<typeof teamDossier>>;

export function buildBriefing(end: number) {
  const start = end - DAY;
  const ranksNow = ranks7d(end);
  const ranksBefore = ranks7d(start);
  const byTeam = windowCommitsByTeam(start, end);
  const news = recentNews(200, start).filter((n) => n.at < end);

  const totalCommits = byTeam.reduce((a, r) => a + r.commits, 0);
  const additions = byTeam.reduce((a, r) => a + r.additions, 0);
  const deletions = byTeam.reduce((a, r) => a + r.deletions, 0);

  const newlyActive = (
    db
      .prepare(`
        SELECT team_id FROM commits WHERE is_template = 0 GROUP BY team_id
        HAVING MIN(committed_at) >= ? AND MIN(committed_at) < ?`)
      .all(start, end) as { team_id: number }[]
  )
    .map((r) => teamRef(r.team_id))
    .filter(Boolean);

  const withRef = <T extends { team_id: number }>(r: T) => ({ ...r, team: teamRef(r.team_id)! });
  const topMovers = [...byTeam].sort((a, b) => b.commits - a.commits).slice(0, 10).map(withRef);
  const biggestDrops = [...byTeam]
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, 5)
    .map(withRef);

  const climbers = [...ranksNow]
    .filter(([id, r]) => r <= 60 && (ranksBefore.get(id) ?? 999) - r >= 5)
    .map(([id, r]) => ({ team: teamRef(id)!, rank: r, before: ranksBefore.get(id) ?? null, gain: (ranksBefore.get(id) ?? 200) - r }))
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 6);

  const wentQuiet = (
    db
      .prepare(`
        SELECT team_id, SUM(committed_at >= ? AND committed_at < ?) AS before, SUM(committed_at >= ?) AS recent
        FROM commits WHERE is_template = 0 AND committed_at >= ? AND committed_at < ?
        GROUP BY team_id HAVING before >= 15 AND recent = 0 ORDER BY before DESC LIMIT 8`)
      .all(end - 9 * DAY, end - 2 * DAY, end - 2 * DAY, end - 9 * DAY, end) as { team_id: number; before: number }[]
  ).map((r) => ({ team: teamRef(r.team_id)!, commitsBefore: r.before }));

  // Registry: newly published parts per team (first seen in window). Parts first seen during the very first
  // full listing are the pre-existing backlog, not news, so anything within 10 min of that load is excluded.
  const bootstrap = ((db.prepare('SELECT MIN(first_seen_at) AS t FROM reg_parts').get() as { t: number | null }).t ?? 0) + 10 * 60_000;
  const from = Math.max(start, bootstrap);
  const partsPublished = (
    db
      .prepare(`
        SELECT pt.team_id, COUNT(*) AS n FROM reg_parts p JOIN reg_part_teams pt ON pt.part_uuid = p.uuid
        WHERE p.first_seen_at >= ? AND p.first_seen_at < ? GROUP BY pt.team_id ORDER BY n DESC LIMIT 8`)
      .all(from, end) as { team_id: number; n: number }[]
  ).map((r) => ({ team: teamRef(r.team_id)!, parts: r.n }));
  const partsTotal = (
    db.prepare('SELECT COUNT(*) AS n FROM reg_parts WHERE first_seen_at >= ? AND first_seen_at < ?').get(from, end) as { n: number }
  ).n;
  const regNow = db.prepare('SELECT COALESCE(SUM(published),0) AS published, COALESCE(SUM(draft),0) AS draft FROM reg_summary').get() as {
    published: number;
    draft: number;
  };

  // Village standings: the teams judged alongside the home team.
  const home = homeTeam();
  let village = null;
  if (home?.village) {
    const members = db.prepare('SELECT id FROM teams WHERE village = ? AND status = ?').all(home.village, 'accepted') as { id: number }[];
    const c7 = new Map(
      (
        db
          .prepare(`SELECT team_id, COUNT(*) AS n FROM commits WHERE is_template = 0 AND committed_at >= ? AND committed_at < ? GROUP BY team_id`)
          .all(end - 7 * DAY, end) as { team_id: number; n: number }[]
      ).map((r) => [r.team_id, r.n]),
    );
    const c24 = new Map(byTeam.map((r) => [r.team_id, r]));
    const rows = members
      .map(({ id }) => {
        const reg = db.prepare('SELECT published, draft FROM reg_summary WHERE team_id = ? AND found = 1').get(id) as
          | { published: number; draft: number }
          | undefined;
        return {
          team: teamRef(id)!,
          commits24h: c24.get(id)?.commits ?? 0,
          lines24h: (c24.get(id)?.additions ?? 0) + (c24.get(id)?.deletions ?? 0),
          commits7d: c7.get(id) ?? 0,
          published: reg?.published ?? null,
          draft: reg?.draft ?? null,
          rank7d: ranksNow.get(id) ?? null,
        };
      })
      .sort((a, b) => b.commits7d - a.commits7d || b.commits24h - a.commits24h);
    village = { name: home.village, teams: rows, homeRank: rows.findIndex((r) => r.team.id === home.id) + 1 };
  }

  const homeDossier = home ? teamDossier(home.id, start, end, ranksNow, ranksBefore, news) : null;
  const subscribed = [...subscribedIds()]
    .filter((id) => id !== home?.id)
    .map((id) => teamDossier(id, start, end, ranksNow, ranksBefore, news))
    .filter((d): d is TeamDossier => d !== null)
    .sort((a, b) => b.commits - a.commits);

  const freezeAt = Date.parse(config.wikiFreezeAt);
  const leader = topMovers[0];
  const summary = [
    `${totalCommits.toLocaleString('en-US')} commits from ${byTeam.length} teams in the last 24 hours`,
    leader ? `${leader.team.name} led with ${leader.commits}` : null,
    partsTotal ? `${partsTotal} new parts published to the Registry` : null,
    homeDossier
      ? `${homeDossier.team.name}: ${homeDossier.commits} commit${homeDossier.commits === 1 ? '' : 's'}${
          homeDossier.rank7d ? `, 7-day rank #${homeDossier.rank7d}${homeDossier.rank7dBefore ? ` (was #${homeDossier.rank7dBefore})` : ''}` : ''
        }`
      : null,
  ]
    .filter(Boolean)
    .join('. ') + '.';

  return {
    periodStart: start,
    periodEnd: end,
    generatedAt: Date.now(),
    timeZone: config.briefingTimeZone,
    summary,
    freeze: { at: freezeAt, remainingMs: freezeAt - end },
    global: {
      commits: totalCommits,
      activeTeams: byTeam.length,
      additions,
      deletions,
      newlyActive,
      partsPublished: partsTotal,
      registryTotals: regNow,
    },
    home: homeDossier,
    village,
    subscribed,
    topMovers,
    biggestDrops,
    climbers,
    wentQuiet,
    partsLeaders: partsPublished,
    news: news.map((n) => ({ at: n.at, headline: n.headline, severity: n.severity, kicker: n.kicker, teamId: n.team?.id ?? null })),
  };
}

export type Briefing = ReturnType<typeof buildBriefing>;

function store(b: Briefing): number {
  const res = db
    .prepare('INSERT OR REPLACE INTO briefings (period_start, period_end, created_at, body) VALUES (?, ?, ?, ?)')
    .run(b.periodStart, b.periodEnd, b.generatedAt, JSON.stringify(b));
  return Number(res.lastInsertRowid);
}

export function listBriefings(limit = 30) {
  return (
    db
      .prepare(`SELECT id, period_start AS periodStart, period_end AS periodEnd, created_at AS createdAt, json_extract(body, '$.summary') AS summary
                FROM briefings ORDER BY period_end DESC LIMIT ?`)
      .all(limit) as any[]
  ).map((r) => ({ ...r }));
}

export function getBriefing(id: number): (Briefing & { id: number }) | undefined {
  const row = db.prepare('SELECT id, body FROM briefings WHERE id = ?').get(id) as { id: number; body: string } | undefined;
  return row ? { ...(JSON.parse(row.body) as Briefing), id: row.id } : undefined;
}

function publishSlot(end: number) {
  const b = buildBriefing(end);
  const id = store(b);
  console.log(`${new Date().toISOString()} [briefing] published #${id} for period ending ${new Date(end).toISOString()}`);
  bus.emit('briefing', { id, periodEnd: end, summary: b.summary });
}

export function startBriefings() {
  // Catch up on the most recent slot if the server was down at briefing time.
  const last = (db.prepare('SELECT MAX(period_end) AS t FROM briefings').get() as { t: number | null }).t ?? 0;
  const slot = latestSlot();
  if (slot > last) publishSlot(slot);

  const schedule = () => {
    const at = nextSlot();
    // Long timers drift; re-arm at most every hour and publish when due.
    setTimeout(() => {
      if (Date.now() >= at) publishSlot(at);
      schedule();
    }, Math.min(at - Date.now() + 1000, HOUR));
  };
  schedule();
}
