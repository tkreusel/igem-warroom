import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id                 INTEGER PRIMARY KEY,        -- iGEM team id
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  village            TEXT,
  institution        TEXT,
  city               TEXT,
  country            TEXT,                       -- ISO 3166-1 alpha-3
  region             TEXT,
  section            TEXT,
  status             TEXT,
  is_remote          INTEGER NOT NULL DEFAULT 0,
  lat                REAL,
  lng                REAL,
  gitlab_project_id  INTEGER,
  gitlab_path        TEXT,
  project_created_at INTEGER,                    -- ms epoch
  last_activity_at   INTEGER,                    -- ms epoch, from GitLab project
  detail_fetched_at  INTEGER,
  updated_at         INTEGER NOT NULL
);

-- Template commits share SHAs across every team repo, hence the composite key.
CREATE TABLE IF NOT EXISTS commits (
  team_id      INTEGER NOT NULL REFERENCES teams(id),
  sha          TEXT NOT NULL,
  committed_at INTEGER NOT NULL,                 -- ms epoch
  authored_at  INTEGER NOT NULL,
  author_name  TEXT,
  author_email TEXT,
  title        TEXT,
  additions    INTEGER NOT NULL DEFAULT 0,
  deletions    INTEGER NOT NULL DEFAULT 0,
  is_template  INTEGER NOT NULL DEFAULT 0,       -- predates the team's project (iGEM template)
  PRIMARY KEY (team_id, sha)
);
CREATE INDEX IF NOT EXISTS idx_commits_time ON commits(committed_at);
CREATE INDEX IF NOT EXISTS idx_commits_team_time ON commits(team_id, committed_at);

CREATE TABLE IF NOT EXISTS sync_state (
  team_id          INTEGER PRIMARY KEY REFERENCES teams(id),
  synced_activity  INTEGER,                      -- last_activity_at value we last synced up to
  backfilled       INTEGER NOT NULL DEFAULT 0,
  last_sync_at     INTEGER,
  error_count      INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT
);

-- iGEM parts registry (registry.igem.org). Only *published* parts are stored;
-- unpublished work is represented solely by the registry's public aggregate counts.
CREATE TABLE IF NOT EXISTS reg_parts (
  uuid          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,                  -- BBa_26…
  slug          TEXT NOT NULL,
  title         TEXT,
  role_label    TEXT,
  role_accession TEXT,
  seq_length    INTEGER,
  usage_count   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,               -- ms epoch (registry audit.created)
  updated_at    INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,               -- when we first saw it published
  attributed    INTEGER NOT NULL DEFAULT 0,     -- team lookup done
  last_listed_at INTEGER NOT NULL               -- last full listing that contained it
);
CREATE INDEX IF NOT EXISTS idx_reg_parts_created ON reg_parts(created_at);
CREATE INDEX IF NOT EXISTS idx_reg_parts_updated ON reg_parts(updated_at);

CREATE TABLE IF NOT EXISTS reg_part_teams (
  part_uuid TEXT NOT NULL REFERENCES reg_parts(uuid) ON DELETE CASCADE,
  team_id   INTEGER NOT NULL,
  PRIMARY KEY (part_uuid, team_id)
);
CREATE INDEX IF NOT EXISTS idx_reg_part_teams_team ON reg_part_teams(team_id);

CREATE TABLE IF NOT EXISTS reg_summary (
  team_id        INTEGER PRIMARY KEY,
  found          INTEGER NOT NULL,              -- 0 = team has no registry organisation
  published      INTEGER NOT NULL DEFAULT 0,
  draft          INTEGER NOT NULL DEFAULT 0,
  screening      INTEGER NOT NULL DEFAULT 0,
  rejected       INTEGER NOT NULL DEFAULT 0,
  with_docs      INTEGER NOT NULL DEFAULT 0,
  documentation  INTEGER NOT NULL DEFAULT 0,
  collections    INTEGER NOT NULL DEFAULT 0,
  fetched_at     INTEGER NOT NULL
);

-- Count snapshots, written only when a team's counts change.
CREATE TABLE IF NOT EXISTS reg_summary_history (
  team_id   INTEGER NOT NULL,
  at        INTEGER NOT NULL,
  published INTEGER NOT NULL,
  draft     INTEGER NOT NULL,
  screening INTEGER NOT NULL,
  rejected  INTEGER NOT NULL,
  PRIMARY KEY (team_id, at)
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
db.exec(SCHEMA);

// Migrations for databases created by earlier versions.
const teamCols = new Set((db.prepare('PRAGMA table_info(teams)').all() as { name: string }[]).map((c) => c.name));
if (!teamCols.has('village')) db.exec('ALTER TABLE teams ADD COLUMN village TEXT');
if (!teamCols.has('coord_source')) {
  db.exec('ALTER TABLE teams ADD COLUMN coord_source TEXT'); // registry | institution | city | missing
  db.exec(`UPDATE teams SET coord_source = 'registry'
           WHERE lat IS NOT NULL AND lng IS NOT NULL AND NOT (ABS(lat) < 0.01 AND ABS(lng) < 0.01)`);
}

export function kvGet(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
