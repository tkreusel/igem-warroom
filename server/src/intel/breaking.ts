import { bus } from '../bus.ts';
import { config } from '../config.ts';
import { db } from '../db/db.ts';
import type { NewCommit } from '../sync/commits.ts';
import { RELATION_WEIGHT, relationOf, type Relation } from './watch.ts';

/**
 * Turns raw activity into news. Every signal is scored against a threshold that shrinks with how
 * much we care about the team (home/subscribed ×3, village rival ×2), so a rival's 1,500-line push
 * is breaking news while a stranger's isn't.
 *
 *   score ≥ 1    → BREAKING (full-screen intermission in the client)
 *   score ≥ 0.5  → FLASH    (toast + feed entry)
 */
const CODE_WINDOW_MS = 20 * 60_000;
const BURST_WINDOW_MS = 30 * 60_000;
const BURST_COMMITS = 20; // ordinary team, per BURST_WINDOW
const PARTS_DROP = 8; // published parts in one jump, ordinary team
const COOLDOWN_MS = 2 * 3600_000;
const FLASH_AT = 0.5;

export type Severity = 'breaking' | 'flash';

export interface NewsEvent {
  id: number;
  at: number;
  type: 'code-drop' | 'burst' | 'parts-drop' | 'milestone';
  severity: Severity;
  score: number;
  headline: string;
  kicker: string;
  team: { id: number; name: string; slug: string; country: string | null; village: string | null; lat: number | null; lng: number | null } | null;
  relation: Relation | null;
  detail: Record<string, unknown>;
  test?: boolean;
}

const KICKER: Record<Relation, string> = {
  home: 'HOME TEAM',
  subscribed: 'WATCHLIST',
  village: 'VILLAGE RIVAL',
  other: 'WORLDWIDE',
};

const fmt = (n: number) => new Intl.NumberFormat('en-US').format(n);
const teamRow = db.prepare('SELECT id, name, slug, country, village, lat, lng FROM teams WHERE id = ?');

function recentlyReported(teamId: number | null, type: string, severity: Severity): boolean {
  // A flash doesn't block a later breaking upgrade; a breaking blocks both.
  const sev = severity === 'breaking' ? "('breaking')" : "('breaking','flash')";
  return Boolean(
    db
      .prepare(`SELECT 1 FROM events WHERE team_id IS ? AND type = ? AND severity IN ${sev} AND at > ? LIMIT 1`)
      .get(teamId, type, Date.now() - COOLDOWN_MS),
  );
}

function publish(e: Omit<NewsEvent, 'id' | 'at' | 'kicker' | 'team' | 'relation'> & { teamId: number | null; dedupeKey: string; kicker?: string }) {
  if (recentlyReported(e.teamId, e.type, e.severity)) return;
  const at = Date.now();
  const detail = JSON.stringify(e.kicker ? { ...e.detail, kicker: e.kicker } : e.detail);
  const res = db
    .prepare('INSERT OR IGNORE INTO events (at, type, severity, team_id, score, headline, detail, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(at, e.type, e.severity, e.teamId, e.score, e.headline, detail, e.dedupeKey);
  if (!res.changes) return;
  const event = hydrate({
    id: Number(res.lastInsertRowid), at, type: e.type, severity: e.severity, team_id: e.teamId, score: e.score,
    headline: e.headline, detail,
  });
  console.log(`${new Date().toISOString()} [news] ${event.severity.toUpperCase()}: ${event.headline}`);
  bus.emit('news', event);
}

function hydrate(r: { id: number; at: number; type: string; severity: string; team_id: number | null; score: number; headline: string; detail: string }): NewsEvent {
  const detail = JSON.parse(r.detail) as Record<string, unknown>;
  const team = r.team_id !== null ? ((teamRow.get(r.team_id) as NewsEvent['team']) ?? null) : null;
  const relation = team ? relationOf(team.id) : null;
  return {
    id: r.id,
    at: r.at,
    type: r.type as NewsEvent['type'],
    severity: r.severity as Severity,
    score: r.score,
    headline: r.headline,
    kicker: (detail.kicker as string) ?? (relation ? KICKER[relation] : 'COMPETITION'),
    team: team ? { ...team } : null,
    relation,
    detail,
  };
}

const severityOf = (score: number): Severity | null => (score >= 1 ? 'breaking' : score >= FLASH_AT ? 'flash' : null);

function onCommits(commits: NewCommit[]) {
  const now = Date.now();
  for (const teamId of new Set(commits.map((c) => c.teamId))) {
    const relation = relationOf(teamId);
    const weight = RELATION_WEIGHT[relation];
    const team = teamRow.get(teamId) as { name: string } | undefined;
    if (!team) continue;

    // Code drop: lines pushed (by first-seen time) within the window.
    const w = db
      .prepare(`
        SELECT COUNT(*) AS n, COALESCE(SUM(additions), 0) AS adds, COALESCE(SUM(deletions), 0) AS dels,
               MIN(seen_at) AS first
        FROM commits WHERE team_id = ? AND is_template = 0 AND seen_at >= ?`)
      .get(teamId, now - CODE_WINDOW_MS) as { n: number; adds: number; dels: number; first: number };
    const lines = w.adds + w.dels;
    const codeScore = lines / (config.breakingLines / weight);
    const codeSev = severityOf(codeScore);
    if (codeSev) {
      const biggest = db
        .prepare('SELECT title, additions + deletions AS lines FROM commits WHERE team_id = ? AND is_template = 0 AND seen_at >= ? ORDER BY lines DESC LIMIT 1')
        .get(teamId, now - CODE_WINDOW_MS) as { title: string; lines: number } | undefined;
      publish({
        type: 'code-drop', severity: codeSev, score: codeScore, teamId,
        headline: `${team.name} pushes ${fmt(lines)} lines${w.n > 1 ? ` in ${w.n} commits` : ''}`,
        detail: { lines, additions: w.adds, deletions: w.dels, commits: w.n, biggestCommit: biggest?.title ?? null, biggestLines: biggest?.lines ?? 0 },
        dedupeKey: `code-drop:${teamId}:${codeSev}:${Math.floor(now / COOLDOWN_MS)}`,
      });
    }

    // Commit burst.
    const burst = (
      db.prepare('SELECT COUNT(*) AS n FROM commits WHERE team_id = ? AND is_template = 0 AND seen_at >= ?').get(teamId, now - BURST_WINDOW_MS) as {
        n: number;
      }
    ).n;
    const burstScore = burst / (BURST_COMMITS / weight);
    const burstSev = severityOf(burstScore);
    if (burstSev && burst >= 5) {
      publish({
        type: 'burst', severity: burstSev, score: burstScore, teamId,
        headline: `${team.name} fires off ${burst} commits in 30 minutes`,
        detail: { commits: burst },
        dedupeKey: `burst:${teamId}:${burstSev}:${Math.floor(now / COOLDOWN_MS)}`,
      });
    }
  }
}

function onSummaryDelta(d: { teamId: number; published: number; draft: number; totals: { published: number; draft: number } }) {
  if (d.published <= 0) return;
  const relation = relationOf(d.teamId);
  const score = d.published / (PARTS_DROP / RELATION_WEIGHT[relation]);
  const sev = severityOf(score);
  const team = teamRow.get(d.teamId) as { name: string } | undefined;
  if (!sev || !team || d.published < 2) return;
  publish({
    type: 'parts-drop', severity: sev, score, teamId: d.teamId,
    headline: `${team.name} publishes ${d.published} new part${d.published === 1 ? '' : 's'} to the Registry`,
    detail: { published: d.published, draftChange: d.draft, totalPublished: d.totals.published, draftsLeft: d.totals.draft },
    dedupeKey: `parts-drop:${d.teamId}:${sev}:${Math.floor(Date.now() / COOLDOWN_MS)}`,
  });
}

/** Wiki-freeze countdown milestones. */
const MILESTONES: [number, string][] = [
  [7 * 86400_000, 'One week until wiki freeze'],
  [3 * 86400_000, 'Three days until wiki freeze'],
  [86400_000, '24 hours until wiki freeze'],
  [6 * 3600_000, 'Six hours until wiki freeze'],
  [3600_000, 'One hour until wiki freeze'],
  [0, 'Wiki freeze: all wikis are now locked'],
];

function checkMilestones() {
  const left = Date.parse(config.wikiFreezeAt) - Date.now();
  // Fire a milestone once, within 10 minutes after crossing it (so restarts don't replay old ones).
  for (const [at, headline] of MILESTONES) {
    if (left <= at && left > at - 10 * 60_000) {
      publish({
        type: 'milestone', severity: 'breaking', score: 1, teamId: null, headline, kicker: 'COUNTDOWN',
        detail: { freezeAt: config.wikiFreezeAt },
        dedupeKey: `milestone:${at}`,
      });
    }
  }
}

export function recentNews(limit = 50, since = 0): NewsEvent[] {
  return (
    db.prepare('SELECT id, at, type, severity, team_id, score, headline, detail FROM events WHERE at >= ? ORDER BY at DESC LIMIT ?').all(since, limit) as any[]
  ).map(hydrate);
}

/** A demo event built from the biggest real push of the last 24 h (not stored). */
export function testNews(): NewsEvent {
  const row = db
    .prepare(`
      SELECT team_id, SUM(additions + deletions) AS lines, SUM(additions) AS adds, SUM(deletions) AS dels, COUNT(*) AS n FROM commits
      WHERE is_template = 0 AND committed_at >= ? GROUP BY team_id ORDER BY lines DESC LIMIT 1`)
    .get(Date.now() - 86400_000) as { team_id: number; lines: number; adds: number; dels: number; n: number } | undefined;
  const teamId = row?.team_id ?? (db.prepare('SELECT id FROM teams WHERE slug = ?').get(config.homeTeam) as { id: number }).id;
  const team = teamRow.get(teamId) as { name: string };
  return {
    ...hydrate({
      id: -Date.now(), at: Date.now(), type: 'code-drop', severity: 'breaking', team_id: teamId, score: 1,
      headline: `${team.name} pushes ${fmt(row?.lines ?? 0)} lines in ${row?.n ?? 0} commits`,
      detail: JSON.stringify({
        lines: row?.lines ?? 0, additions: row?.adds ?? 0, deletions: row?.dels ?? 0, commits: row?.n ?? 0,
        kicker: 'DRILL · TEST ALERT',
      }),
    }),
    test: true,
  };
}

export function startNewsDesk() {
  bus.on('commits', (c: NewCommit[]) => {
    try {
      onCommits(c);
    } catch (err) {
      console.error('[news] commit analysis failed', err);
    }
  });
  bus.on('summary-delta', (d) => {
    try {
      onSummaryDelta(d);
    } catch (err) {
      console.error('[news] registry analysis failed', err);
    }
  });
  checkMilestones();
  setInterval(checkMilestones, 60_000);
}
