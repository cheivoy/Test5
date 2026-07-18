CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  device_label TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username);

CREATE TABLE IF NOT EXISTS leave_windows (
  window_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  event_date TEXT NOT NULL,
  session TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_window_owner_date_session ON leave_windows(owner, event_date, session);

CREATE TABLE IF NOT EXISTS leave_actions (
  action_id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  member_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_owner ON leave_actions(owner, window_id, member_id, created_at);

CREATE TABLE IF NOT EXISTS stat_overrides (
  member_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  attendance_override INTEGER,
  leave_override INTEGER,
  reserve_override INTEGER,
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (member_id, owner)
);

CREATE TABLE IF NOT EXISTS user_settings (
  owner TEXT PRIMARY KEY,
  discord_webhook_url TEXT,
  discord_guild_id TEXT,
  updated_at INTEGER
);
