import { config } from '../config.ts';
import { bus } from '../bus.ts';
import { db, kvGet, kvSet } from '../db/db.ts';
import { fillMissingCoordinates } from '../geo/geocode.ts';
import { gitlab } from '../sources/gitlab.ts';
import { mapPool } from '../sources/http.ts';
import { stalestTeams, syncTeamCommits, teamByProjectId, teamsNeedingBackfill } from './commits.ts';
import { syncTeams } from './teams.ts';

/** Safety-net sweep size per poll; GitLab's last_activity_at can lag behind pushes. */
const SWEEP_BATCH = config.gitlabToken ? 40 : 6;
/** Only sweep when at least this many requests are left beyond the reserve. */
const SWEEP_HEADROOM = 60;

export interface SyncStatus {
  phase: 'idle' | 'teams' | 'backfill' | 'polling';
  teamsSyncedAt: number | null;
  lastPollAt: number | null;
  lastPollError: string | null;
  backfill: { total: number; done: number; errors: number; running: boolean };
}

export const status: SyncStatus = {
  phase: 'idle',
  teamsSyncedAt: null,
  lastPollAt: null,
  lastPollError: null,
  backfill: { total: 0, done: 0, errors: 0, running: false },
};

function emitStatus() {
  bus.emit('status', status);
}

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

async function ensureTeams() {
  const syncedAt = Number(kvGet('teams_synced_at') ?? 0);
  const count = (db.prepare('SELECT COUNT(*) AS n FROM teams').get() as { n: number }).n;
  if (count > 0 && kvGet('villages_synced_at') && Date.now() - syncedAt < config.teamsRefreshHours * 3600_000) {
    status.teamsSyncedAt = syncedAt;
    // Cheap when nothing is missing; geocode results are cached.
    if ((await fillMissingCoordinates(log)).fixed) bus.emit('teams-updated');
    return;
  }
  status.phase = 'teams';
  emitStatus();
  await syncTeams(log);
  status.teamsSyncedAt = Date.now();
  bus.emit('teams-updated');
}

async function runBackfill() {
  if (status.backfill.running) return;
  const todo = teamsNeedingBackfill();
  if (!todo.length) return;
  status.phase = 'backfill';
  status.backfill = { total: todo.length, done: 0, errors: 0, running: true };
  emitStatus();
  log(`[backfill] ${todo.length} teams to backfill`);
  const { errors } = await mapPool(todo, config.gitlabConcurrency, async (team) => {
    await syncTeamCommits(team, { full: true });
    status.backfill.done++;
    if (status.backfill.done % 10 === 0) {
      emitStatus();
      bus.emit('teams-updated');
    }
  });
  status.backfill.errors = errors.length;
  status.backfill.running = false;
  for (const e of errors.slice(0, 5)) log(`[backfill] ${e.item.slug}: ${String(e.error)}`);
  log(`[backfill] done: ${status.backfill.done} ok, ${errors.length} errors`);
  bus.emit('teams-updated');
}

let polling = false;

export async function poll() {
  if (polling) return;
  polling = true;
  const startedAt = Date.now();
  try {
    const cursor = Number(kvGet('poll_cursor') ?? startedAt - 3600_000);
    // Overlap the window slightly so nothing slips between polls.
    const projects = await gitlab.listActiveProjectsSince(config.year, new Date(cursor - 120_000));
    const updateActivity = db.prepare('UPDATE teams SET last_activity_at = ? WHERE id = ?');
    let synced = 0;
    for (const p of projects) {
      const team = teamByProjectId(p.id);
      if (!team) continue;
      const activity = Date.parse(p.last_activity_at);
      updateActivity.run(activity, team.id);
      if (team.synced_activity && activity <= team.synced_activity) continue;
      const fresh = await syncTeamCommits(team, { critical: true, full: !team.backfilled, activityAt: activity });
      synced++;
      if (fresh.length) log(`[poll] ${team.name}: ${fresh.length} new commit(s)`);
    }
    kvSet('poll_cursor', String(startedAt));

    const { remaining } = gitlab.budget;
    if (!status.backfill.running && (remaining === null || remaining > config.gitlabReserve + SWEEP_HEADROOM)) {
      await mapPool(stalestTeams(SWEEP_BATCH), 2, (team) => syncTeamCommits(team));
    }

    status.lastPollAt = Date.now();
    status.lastPollError = null;
    if (synced) bus.emit('teams-updated');
  } catch (err) {
    status.lastPollError = String(err);
    log(`[poll] error: ${String(err)}`);
  } finally {
    polling = false;
    emitStatus();
  }
}

export async function startScheduler() {
  try {
    await ensureTeams();
  } catch (err) {
    log(`[teams] sync failed: ${String(err)}`);
  }
  // Backfill runs in the background on the non-reserved budget; polling keeps the map live meanwhile.
  runBackfill()
    .catch((err) => log(`[backfill] failed: ${String(err)}`))
    .finally(() => {
      status.phase = 'polling';
      emitStatus();
    });

  await poll();
  setInterval(poll, config.pollIntervalSec * 1000);
  setInterval(() => {
    ensureTeams()
      .then(runBackfill)
      .catch((err) => log(`[teams] refresh failed: ${String(err)}`));
  }, 3600_000);
}
