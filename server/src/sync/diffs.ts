import { bus } from '../bus.ts';
import { config } from '../config.ts';
import { db, transaction } from '../db/db.ts';
import { detailTeamIds } from '../intel/watch.ts';
import { gitlab, type GitlabDiff } from '../sources/gitlab.ts';
import { sleep } from '../sources/http.ts';

/**
 * File-level detail for watched teams (home + subscribed): which wiki pages and assets each commit
 * touched, with line counts. One GitLab request per commit, so it is limited to watched teams,
 * to the last DETAIL_DAYS, and runs only while the budget has headroom beyond the poller's reserve.
 */
const DETAIL_DAYS = 7;
const PER_TEAM_CAP = 150;
const HEADROOM = 40;

function countLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

const changeOf = (d: GitlabDiff) => (d.new_file ? 'added' : d.deleted_file ? 'deleted' : d.renamed_file ? 'renamed' : 'modified');

function pending(): { team_id: number; sha: string; project: number }[] {
  const ids = [...detailTeamIds()];
  if (!ids.length) return [];
  return db
    .prepare(`
      SELECT c.team_id, c.sha, t.gitlab_project_id AS project
      FROM commits c JOIN teams t ON t.id = c.team_id
      LEFT JOIN commit_diff_state d ON d.team_id = c.team_id AND d.sha = c.sha
      WHERE c.team_id IN (${ids.map(() => '?').join(',')}) AND c.is_template = 0 AND d.sha IS NULL
        AND c.committed_at >= ? AND t.gitlab_project_id IS NOT NULL
      ORDER BY c.committed_at DESC LIMIT ?`)
    .all(...ids, Date.now() - DETAIL_DAYS * 86400_000, PER_TEAM_CAP * ids.length) as { team_id: number; sha: string; project: number }[];
}

const insFile = db.prepare(
  'INSERT OR REPLACE INTO commit_files (team_id, sha, path, additions, deletions, change) VALUES (?, ?, ?, ?, ?, ?)',
);
const markState = db.prepare('INSERT OR REPLACE INTO commit_diff_state (team_id, sha, status) VALUES (?, ?, ?)');

async function fetchOne(item: { team_id: number; sha: string; project: number }) {
  try {
    const diffs = await gitlab.commitDiff(item.project, item.sha);
    transaction(() => {
      for (const d of diffs) {
        const { additions, deletions } = countLines(d.diff ?? '');
        insFile.run(item.team_id, item.sha, d.new_path || d.old_path, additions, deletions, changeOf(d));
      }
      markState.run(item.team_id, item.sha, 'done');
    });
  } catch (err) {
    markState.run(item.team_id, item.sha, 'failed');
    console.log(`${new Date().toISOString()} [diffs] ${item.sha.slice(0, 8)} failed: ${String(err)}`);
  }
}

let wake: (() => void) | null = null;

/** Background loop; woken early by new commits or subscription changes. */
export async function startDiffWorker() {
  const nudge = () => wake?.();
  bus.on('commits', nudge);
  bus.on('subscriptions-changed', nudge);
  let done = 0;
  for (;;) {
    const { remaining } = gitlab.budget;
    const affordable = remaining === null || remaining > config.gitlabReserve + HEADROOM;
    const todo = affordable ? pending() : [];
    if (!todo.length) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 5 * 60_000);
      });
      wake = null;
      continue;
    }
    await fetchOne(todo[0]);
    if (++done % 10 === 0) bus.emit('teams-updated');
    await sleep(250);
  }
}

/** Wiki pages / assets a team touched in a window, most-changed first. */
export function pagesTouched(teamId: number, since: number, limit = 15) {
  return (
    db
      .prepare(`
        SELECT f.path, COUNT(DISTINCT f.sha) AS commits, SUM(f.additions) AS additions, SUM(f.deletions) AS deletions,
               MAX(c.committed_at) AS lastAt, MAX(f.change = 'added') AS created
        FROM commit_files f JOIN commits c ON c.team_id = f.team_id AND c.sha = f.sha
        WHERE f.team_id = ? AND c.committed_at >= ?
        GROUP BY f.path ORDER BY (SUM(f.additions) + SUM(f.deletions)) DESC, commits DESC LIMIT ?`)
      .all(teamId, since, limit) as any[]
  ).map((r) => ({ ...r, created: Boolean(r.created) }));
}

export function detailCoverage(teamId: number, since: number) {
  return db
    .prepare(`
      SELECT COUNT(*) AS commits, COUNT(d.sha) AS detailed
      FROM commits c LEFT JOIN commit_diff_state d ON d.team_id = c.team_id AND d.sha = c.sha AND d.status = 'done'
      WHERE c.team_id = ? AND c.is_template = 0 AND c.committed_at >= ?`)
    .get(teamId, since) as { commits: number; detailed: number };
}
