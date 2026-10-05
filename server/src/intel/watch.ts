import { bus } from '../bus.ts';
import { config } from '../config.ts';
import { db } from '../db/db.ts';

/**
 * Who we care about, and how much. Weights scale alert sensitivity and briefing priority:
 * home team and subscribed teams are watched closest, then village rivals (same iGEM village =
 * same judging pool), then everyone else.
 */
export type Relation = 'home' | 'subscribed' | 'village' | 'other';

export const RELATION_WEIGHT: Record<Relation, number> = {
  home: 3,
  subscribed: 3,
  village: 2,
  other: 1,
};

export function subscribedIds(): Set<number> {
  return new Set((db.prepare('SELECT team_id FROM subscriptions').all() as { team_id: number }[]).map((r) => r.team_id));
}

export function homeTeam(): { id: number; name: string; village: string | null } | undefined {
  return db.prepare('SELECT id, name, village FROM teams WHERE slug = ?').get(config.homeTeam) as
    | { id: number; name: string; village: string | null }
    | undefined;
}

export function relationOf(teamId: number): Relation {
  const home = homeTeam();
  if (home?.id === teamId) return 'home';
  if (subscribedIds().has(teamId)) return 'subscribed';
  if (home?.village) {
    const t = db.prepare('SELECT village FROM teams WHERE id = ?').get(teamId) as { village: string | null } | undefined;
    if (t?.village === home.village) return 'village';
  }
  return 'other';
}

/** Teams whose commits get per-file detail (diff requests cost GitLab budget, so keep this small). */
export function detailTeamIds(): Set<number> {
  const ids = subscribedIds();
  const home = homeTeam();
  if (home) ids.add(home.id);
  return ids;
}

export function subscribe(teamId: number): boolean {
  const exists = db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId);
  if (!exists) return false;
  const res = db.prepare('INSERT OR IGNORE INTO subscriptions (team_id, created_at) VALUES (?, ?)').run(teamId, Date.now());
  if (res.changes) bus.emit('subscriptions-changed', { teamId, subscribed: true });
  return true;
}

export function unsubscribe(teamId: number) {
  const res = db.prepare('DELETE FROM subscriptions WHERE team_id = ?').run(teamId);
  if (res.changes) bus.emit('subscriptions-changed', { teamId, subscribed: false });
}
