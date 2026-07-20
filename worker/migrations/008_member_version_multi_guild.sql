-- 成員檔案版本欄：防止多位幹部同時編輯同一成員的評語/職業/標籤時互相覆蓋
ALTER TABLE members ADD COLUMN version INTEGER DEFAULT 0;

-- 一個帳號可綁定多個 Discord 伺服器（機器人查詢用）
CREATE TABLE IF NOT EXISTS discord_guilds (
  owner TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  created_at INTEGER,
  PRIMARY KEY (owner, guild_id)
);
CREATE INDEX IF NOT EXISTS idx_discord_guilds_guild ON discord_guilds(guild_id);
