-- 效能索引：這些查詢都以 owner 過濾，加索引可大幅減少掃描列數（也降低 D1 每日讀取用量）。
-- 全部 IF NOT EXISTS，非破壞、可重複執行；要移除可 DROP INDEX。
CREATE INDEX IF NOT EXISTS idx_reports_owner ON reports(owner);
CREATE INDEX IF NOT EXISTS idx_members_owner ON members(owner);
CREATE INDEX IF NOT EXISTS idx_member_aliases_owner ON member_aliases(owner);
CREATE INDEX IF NOT EXISTS idx_members_roster_owner ON members_roster(owner, status);
CREATE INDEX IF NOT EXISTS idx_stat_overrides_owner ON stat_overrides(owner);
