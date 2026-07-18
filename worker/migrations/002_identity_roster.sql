CREATE TABLE IF NOT EXISTS members_roster (
  member_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  discord_user_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_roster_owner_name ON members_roster(owner, display_name);

CREATE TABLE IF NOT EXISTS member_aliases (
  alias_name TEXT NOT NULL,
  owner TEXT NOT NULL,
  member_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (alias_name, owner)
);
CREATE INDEX IF NOT EXISTS idx_aliases_member ON member_aliases(owner, member_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  actor TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_owner_time ON audit_log(owner, created_at DESC);
