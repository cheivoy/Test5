-- 多個 Discord 通知頻道：每個頻道各自的 webhook、要接收的事件、要 @ 的身分組
CREATE TABLE IF NOT EXISTS discord_channels (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT,
  webhook_url TEXT,
  events TEXT,            
  mention_role_id TEXT,   
  enabled INTEGER DEFAULT 1,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_discord_channels_owner ON discord_channels(owner);

-- 站台基底網址：用來在「開放請假」通知自動附上請假連結（可空，會退回用請求 Origin）
ALTER TABLE user_settings ADD COLUMN site_base_url TEXT;
