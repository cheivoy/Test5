CREATE TABLE IF NOT EXISTS long_leaves (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  member_id TEXT NOT NULL,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_long_leaves_owner ON long_leaves(owner, member_id);
