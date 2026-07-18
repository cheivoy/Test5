# NSH Worker 後端

這裡存放 Cloudflare Worker（`d1-template.cherrycywong0907.workers.dev`）的原始碼與 D1 migration，跟前端（`../index.html` / `../app.js`）分開版控，方便追蹤後端變更。

## 部署方式：純網頁操作（你目前的做法，不需要裝任何工具）

每次有新的 migration 或 `index.js` 改版，都是這兩步：**先跑資料庫指令，再貼新程式碼**。

### 第一步：跑 migration SQL

1. 登入 https://dash.cloudflare.com
2. 左側選單找到 **D1**（可能在「Storage & Databases」底下，也可能直接叫 D1 SQL Database）。
3. 如果不確定是哪一個資料庫：去 **Workers & Pages** → 點進你的 Worker（叫 `d1-template` 或類似名字）→ **Settings** → **Bindings**，裡面應該有一個 binding 名稱是 `DB`，旁邊寫的就是綁定的 D1 資料庫名稱，點它可以直接跳過去。
4. 進入該資料庫頁面後，找上方分頁的 **Console**（查詢主控台）。
5. 打開這個 repo 裡的 `worker/migrations/002_identity_roster.sql`，把整個檔案內容複製起來，貼到 Console 的輸入框，按 **Execute / 執行**。
   - 如果一次貼全部跑不過（有些介面一次只吃一個語句），就把檔案裡用空行隔開的每一段（每個 `CREATE TABLE ...;` 或 `CREATE INDEX ...;`）分開貼、一段一段執行。
   - 每個語句都有 `IF NOT EXISTS`，所以重複執行不會出錯，不用擔心手滑跑兩次。
6. 沒有紅字錯誤訊息就代表成功。

### 第二步：更新 Worker 程式碼

1. 回到 **Workers & Pages**，點進同一個 Worker。
2. 找 **Edit Code**（或叫 **Quick Edit**）按鈕，會打開線上程式碼編輯器。
3. 把編輯器裡原本的內容**全部刪除**，貼上這個 repo 裡 `worker/index.js` 的最新內容（整份複製貼上，不要只貼部分）。
4. 按右上角 **Deploy / 部署**。
5. 部署完成後，回到你的網站試著匯入一場含新名字的戰報，確認會跳出「陌生名字」確認視窗。

以後每個里程碑都是重複這兩步：先跑當次新增的 migration 檔（在 `worker/migrations/` 資料夾，檔名數字比之前大的那個），再把最新的 `worker/index.js` 整份貼上去部署。

## Migration 清單

| 檔案 | 里程碑 | 內容 |
|---|---|---|
| `001_reference_existing_schema.sql` | — | 純參考，不要執行，記錄目前正式環境已有的表結構 |
| `002_identity_roster.sql` | 里程碑 1 | `members_roster` / `member_aliases`（穩定身分）+ `audit_log`（操作紀錄） |
| `003_leave_sessions.sql` | 里程碑 2–6 | `sessions`（多重登入）、`leave_windows` / `leave_actions`（請假）、`stat_overrides`（人工覆蓋次數）、`user_settings`（Discord 設定） |
| `004_leave_window_type.sql` | 類型細分 | 幫 `leave_windows` 加 `match_type` 欄位（幫戰/約戰/領地戰），讓請假也能依類型分類與統計。**一句 ALTER，直接整段貼上執行即可**。 |
| `005_roster_job.sql` | 自助建檔 | 幫 `members_roster` 加 `job` 欄位，讓公開頁自助建檔時可填職業。**一句 ALTER，直接整段貼上執行即可**。 |

## 驗證資料表是否都建好了（貼到 D1 Console 執行）

如果「更名」或請假功能報錯，先跑這一句確認所有表都存在。應該要看到 10 個表名：

```
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
```

要包含：`audit_log`、`leave_actions`、`leave_windows`、`member_aliases`、`members`、`members_roster`、`reports`、`sessions`、`stat_overrides`、`transfers`、`user_settings`、`users`。
少了哪個，就回去把對應的 migration 檔重跑一次（每段都有 `IF NOT EXISTS`，重複執行不會壞）。

## 里程碑 1 帶來的行為變化

- **改名 / 合併不再重寫歷史戰報**：`/api/rename`、`/api/merge-member` 改成操作 `members_roster` + `member_aliases`，回應裡的 `updated` 欄位固定回 `0`（只是保留給舊前端相容，不代表沒有生效——歷史資料本來就不需要被改寫了）。
- **陌生名字確認**：登入雲端帳號後，儲存一場含有名冊裡沒有的名字的戰報時，會先跳出確認視窗，逐一選擇「既有成員改名」或「全新成員」。成員檔案室頁面也有「🆕 檢查待確認名字」按鈕，可以隨時回來處理漏掉的名字。
- **首次使用會自動 backfill**：第一次呼叫任何 `/api/roster/*` 端點時，會自動把舊的 `members` 表與歷史戰報裡出現過的名字，各自建一筆 `member_id`（冪等操作，只會做一次）。
- 本地模式（未登入）不受影響——名冊/陌生名字確認是雲端帳號限定功能。
