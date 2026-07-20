CREATE TABLE IF NOT EXISTS lineups (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  title TEXT,
  window_id TEXT,
  data_json TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lineups_owner ON lineups(owner);
