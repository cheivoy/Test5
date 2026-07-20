-- 代替上號：某場次某成員本人請假，但有人幫他開號打，
-- 戰報會出現本人名字，實際出席要算到「代打者」身上。
CREATE TABLE IF NOT EXISTS leave_substitutes (
  window_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  member_id TEXT NOT NULL,            
  substitute_member_id TEXT NOT NULL, 
  created_at INTEGER,
  PRIMARY KEY (window_id, owner, member_id)
);
CREATE INDEX IF NOT EXISTS idx_leave_sub_owner ON leave_substitutes(owner);
