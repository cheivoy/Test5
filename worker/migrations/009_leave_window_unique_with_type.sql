-- 讓「同一天同場次」可以分別開 幫戰／約戰／領地戰：
-- 舊的唯一索引只鎖 (owner, event_date, session)，導致同日同場次的第二個類型被資料庫擋下（500）。
-- 先把還是 NULL 的類型補成「幫戰」，再把唯一索引換成含 match_type 的版本。
UPDATE leave_windows SET match_type = '幫戰' WHERE match_type IS NULL;

DROP INDEX IF EXISTS idx_window_owner_date_session;
CREATE UNIQUE INDEX IF NOT EXISTS idx_window_owner_date_session_type
  ON leave_windows(owner, event_date, session, match_type);
