import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch {
  // .env is optional
}

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
  year: 2026,
  gitlabApi: 'https://gitlab.igem.org/api/v4',
  igemApi: 'https://api.igem.org/v1',
  gitlabToken: env.GITLAB_TOKEN?.trim() || undefined,
  pollIntervalSec: Number(env.POLL_INTERVAL_SEC ?? 180),
  teamsRefreshHours: 24,
  homeTeam: env.HOME_TEAM ?? 'heidelberg',
  wikiFreezeAt: env.WIKI_FREEZE_AT ?? '2026-10-21T15:00:00Z',
  dbPath: path.join(ROOT_DIR, 'data', 'warroom.sqlite'),
  clientDist: path.join(ROOT_DIR, 'client', 'dist'),
  /** Keep this many anonymous requests in reserve for the live poller. */
  gitlabReserve: 25,
  gitlabConcurrency: 4,
  /** Daily briefing: published at this wall-clock time in this zone, covering the preceding 24 h. */
  briefingTime: env.BRIEFING_TIME ?? '09:00',
  briefingTimeZone: env.BRIEFING_TZ ?? 'Europe/Berlin',
  /** Lines changed by one team within the burst window that count as "breaking" for an ordinary team. */
  breakingLines: Number(env.BREAKING_LINES ?? 4000),
};
