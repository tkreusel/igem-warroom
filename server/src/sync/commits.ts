import { db, transaction } from '../db/db.ts';
import { bus } from '../bus.ts';
import { gitlab, type GitlabCommit } from '../sources/gitlab.ts';

/** Commits up to this long after project creation are the iGEM template, not team work. */
const TEMPLATE_GRACE_MS = 5 * 60_000;

export interface TeamRow {
  id: number;
  slug: string;
  name: string;
  gitlab_project_id: number;
  project_created_at: number | null;
  last_activity_at: number | null;
}

export interface NewCommit {
  teamId: number;
  sha: string;
  committedAt: number;
  authorName: string;
  title: string;
  additions: number;
  deletions: number;
}

const insertCommit = db.prepare(`
  INSERT OR IGNORE INTO commits (team_id, sha, committed_at, authored_at, author_name, author_email, title, additions, deletions, is_template, seen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const markSynced = db.prepare(`
  INSERT INTO sync_state (team_id, synced_activity, backfilled, last_sync_at, error_count, last_error)
  VALUES (?, ?, ?, ?, 0, NULL)
  ON CONFLICT(team_id) DO UPDATE SET
    synced_activity = excluded.synced_activity,
    backfilled = MAX(sync_state.backfilled, excluded.backfilled),
    last_sync_at = excluded.last_sync_at, error_count = 0, last_error = NULL`);

const markError = db.prepare(`
  INSERT INTO sync_state (team_id, error_count, last_error, last_sync_at) VALUES (?, 1, ?, ?)
  ON CONFLICT(team_id) DO UPDATE SET error_count = sync_state.error_count + 1, last_error = excluded.last_error,
    last_sync_at = excluded.last_sync_at`);

/** `seenAt` is null for full (history) syncs so backfilled history never looks like a fresh push. */
function store(team: TeamRow, commits: GitlabCommit[], seenAt: number | null): NewCommit[] {
  const fresh: NewCommit[] = [];
  const createdAt = team.project_created_at ?? 0;
  transaction(() => {
    for (const c of commits) {
      const committedAt = Date.parse(c.committed_date);
      const isTemplate = committedAt <= createdAt + TEMPLATE_GRACE_MS ? 1 : 0;
      const res = insertCommit.run(
        team.id, c.id, committedAt, Date.parse(c.authored_date), c.author_name, c.author_email, c.title,
        c.stats?.additions ?? 0, c.stats?.deletions ?? 0, isTemplate, seenAt,
      );
      if (res.changes > 0 && !isTemplate) {
        fresh.push({
          teamId: team.id, sha: c.id, committedAt, authorName: c.author_name, title: c.title,
          additions: c.stats?.additions ?? 0, deletions: c.stats?.deletions ?? 0,
        });
      }
    }
  });
  return fresh;
}

/**
 * Sync one team's commits. A full sync walks the whole history; an incremental sync reads
 * newest-first and stops at the first page containing a commit we already have. We don't
 * filter by `since` because commits can be pushed long after their committer date.
 */
export async function syncTeamCommits(
  team: TeamRow,
  opts: { full?: boolean; critical?: boolean; activityAt?: number } = {},
): Promise<NewCommit[]> {
  const known = db.prepare('SELECT 1 FROM commits WHERE team_id = ? AND sha = ?');
  try {
    const commits = await gitlab.listCommits(team.gitlab_project_id, {
      critical: opts.critical,
      stop: opts.full ? undefined : (page) => page.some((c) => known.get(team.id, c.id)),
    });
    const fresh = store(team, commits, opts.full ? null : Date.now());
    markSynced.run(team.id, opts.activityAt ?? team.last_activity_at, opts.full ? 1 : 0, Date.now());
    // A full sync is history, not news; only incremental results go to the live feed.
    if (fresh.length && !opts.full) bus.emit('commits', fresh);
    return fresh;
  } catch (err) {
    markError.run(team.id, String(err), Date.now());
    throw err;
  }
}

export function teamsNeedingBackfill(): TeamRow[] {
  return db
    .prepare(`
      SELECT t.id, t.slug, t.name, t.gitlab_project_id, t.project_created_at, t.last_activity_at
      FROM teams t LEFT JOIN sync_state s ON s.team_id = t.id
      WHERE t.gitlab_project_id IS NOT NULL AND COALESCE(s.backfilled, 0) = 0 AND COALESCE(s.error_count, 0) < 5
      ORDER BY t.last_activity_at DESC`)
    .all() as unknown as TeamRow[];
}

/** Teams least recently synced, for the rolling safety sweep. */
export function stalestTeams(limit: number): TeamRow[] {
  return db
    .prepare(`
      SELECT t.id, t.slug, t.name, t.gitlab_project_id, t.project_created_at, t.last_activity_at
      FROM teams t JOIN sync_state s ON s.team_id = t.id
      WHERE t.gitlab_project_id IS NOT NULL AND s.backfilled = 1
      ORDER BY s.last_sync_at ASC LIMIT ?`)
    .all(limit) as unknown as TeamRow[];
}

export function teamByProjectId(projectId: number): (TeamRow & { synced_activity: number | null; backfilled: number | null }) | undefined {
  return db
    .prepare(`
      SELECT t.id, t.slug, t.name, t.gitlab_project_id, t.project_created_at, t.last_activity_at, s.synced_activity, s.backfilled
      FROM teams t LEFT JOIN sync_state s ON s.team_id = t.id WHERE t.gitlab_project_id = ?`)
    .get(projectId) as (TeamRow & { synced_activity: number | null; backfilled: number | null }) | undefined;
}
