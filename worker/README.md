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
| `006_category_type_override.sql` | 身份類別 + 分類覆蓋 | 幫 `members_roster` 加 `category`（主幫/副幫/俱樂部…），幫 `stat_overrides` 加 `overrides_json`（依類型的人工覆蓋）。**兩句 ALTER，一句一句貼上執行**。若出現 `duplicate column name` 代表已加過，略過即可。 |

## 載入速度優化（這次改版）

> **這次不用跑 migration**，資料表沒有任何變動。只要把 `worker/index.js` 整份重貼上去 Deploy 就好。
> 前端（`index.html` / `app.js`）也要一起更新，兩邊搭配才有完整效果。

改了什麼：

| 項目 | 說明 |
|---|---|
| `Access-Control-Max-Age: 86400` | 帶 `Authorization` 的請求，瀏覽器一定會先發一次 preflight(OPTIONS)。原本沒設這個標頭 → 瀏覽器只快取 5 秒，幾乎**每個 API 都要多跑一趟來回**。設定後一天內不再重複問。 |
| `/api/histories?meta=1` | 只回傳列表要顯示的欄位（日期／幫會／勝敗／類型／場次），不回傳整包 `raw_json`。開站的傳輸量從「每場所有選手的完整數據」降到幾 KB。 |
| `/api/history?id=` | 新端點：點開某一場戰報時才抓那一場的完整內容。 |
| `/api/db-bundle` | 新端點：把成員檔案室原本要打的 6 個請求（名冊對照／代打／補登出席／成員備註／請假統計／人工覆蓋）合併成**一次**來回。 |

相容性：前端會自己偵測。worker 還沒重貼之前，`meta=1` 會被舊程式忽略（照樣回完整資料），
`/api/db-bundle` 會回 404 → 前端自動退回舊的逐一抓取流程，功能不會壞，只是速度沒有變快。

`meta=1` 的查詢用 `CASE WHEN json_valid(raw_json) THEN json_extract(...) END` 包起來，
因為只要有**一筆** `raw_json` 損壞，直接呼叫 `json_extract` 會讓整句查詢失敗（不是只有那一筆變空）。

## 載入速度優化（第二輪：請假管理 / 成員檔案室）

> 同樣**不用跑 migration**。把 `worker/index.js` 整份重貼 Deploy 即可。

第一輪只減少了「請求次數」，但這兩頁真正的瓶頸在 worker 端的計算：

`computeLeaveStats` 和 `computeMemberStats` **各自** `SELECT date, raw_json FROM reports`
再把每一場 `JSON.parse` 一遍。而 `/api/leave/board`（請假管理／請假登記都走它）
會同時呼叫兩者，其中 `computeMemberStats` 內部又再呼叫一次 `computeLeaveStats`
→ 整個 `reports` 表被讀進 worker 解析**三遍**。

改法：

1. 新增 `loadReportFacts(env, owner, from, to)`，把「每場有誰上場（已對照 member_id）＋
   有哪些場次」算成一份事實表，**一次載好給兩個統計共用**（三遍 → 一遍）。
2. SQL 只挑出 `gA`（本隊名單）與場次欄位，不再把敵隊 `gB` 的完整數據也傳進 worker。
3. 有時間範圍時直接在 SQL `WHERE date BETWEEN`，不要整表拉回來才過濾。

### 為什麼不用 `json_each` 在 SQL 裡展開成「每個玩家一列」

試過，實測**反而更慢**：傳輸量少 8 倍，但 SQLite CPU 是 3.6 倍
（`json_extract` 對每一列都要重新 parse 整包 blob，40 人就 parse 40 次），
而且 `gA` 裡若有非物件元素會讓**整句查詢失敗**。
所以 SQL 只做「挑出 gA 字串」這件便宜事，逐筆解析仍交給 V8（`JSON.parse` 很快）。

### 兩個一併修掉的潛在崩潰

舊版這兩種資料會讓整個請求 500：

| 資料 | 舊版 | 新版 |
|---|---|---|
| `raw_json` 為 `NULL` | `JSON.parse(null)` 回傳 `null`，接著讀 `d.session` → TypeError | 整筆略過 |
| `gA` 存在但不是陣列 | `(d.gA \|\| []).forEach is not a function` | 整筆略過 |

### 還是慢的話，下一步

目前每次請求仍要掃一次 `reports`。要徹底解決就得把事實表**存起來**
（新增 `report_players` 表，在存檔／刪除戰報時同步維護，首次使用時 backfill），
之後查詢就是一個有索引的小查詢、完全不用碰 JSON。這需要 migration 與寫入路徑改動，
所以先做完上面這些、確認實際感受之後再決定要不要走這一步。

## 載入速度優化（第三輪：真正的元凶）

> 同樣**不用跑 migration**。`worker/index.js` 整份重貼 Deploy，前端也要一起更新。

前兩輪都沒抓到重點。實際量出來的元凶是：**成員檔案室把所有戰報的完整 `raw_json`
下載到瀏覽器，然後在前端自己算**。但成員表格根本沒有顯示任何數據加總——
它只顯示名字／職業／身份／標籤／出席場數／各類型次數／請假後備／出席率／備註，
這些 worker 的 `computeMemberStats` 早就算好了。

實測（每場 40 人、數值有變化以反映真實壓縮率）：

| 資料量 | 舊（前端自己算） | 新（worker 算好） |
|---|---|---|
| 100 場 | 1.44 MB，gzip **246 KB** | 39 KB，gzip **2 KB** |
| 300 場 | 4.31 MB，gzip **730 KB** | 73 KB，gzip **3 KB** |
| 600 場 | 8.61 MB，gzip **1.4 MB** | 120 KB，gzip **4 KB** |

手機 4 Mbps 粗估：300 場的情況從約 1.5 秒的純下載時間降到 0.01 秒。

改法：

1. `/api/db-bundle?computed=1`：worker 算好，一列一個成員回傳（幾十 KB）。
2. 前端成員表格改用它，**完全不下載 raw_json**。
3. 每場數據快照（成員明細視窗、雷達圖）延後到**真的點開某個成員**才抓，抓過就留著。
4. `Server-Timing` 標頭：`/api/db-bundle?computed=1` 與 `/api/leave/board` 會回報
   `facts;dur=` / `stats;dur=` 與戰報列數。開 DevTools 的 Network 就能看到伺服器各階段
   花多久，前端也會在 console 印出來——以後不用再猜。

順帶量到：`/api/leave/board` 壓縮後只有 9 KB，**不是**傳輸問題，它的成本是伺服器計算
（第二輪已從掃三遍降到一遍）。

### 一併修掉的計算錯誤

第一輪把 `sessionSet` 的 `JSON.parse` + try/catch 換成共用的 `repOf()` 時，
損壞的戰報從「整筆略過」變成「照樣佔一個場次名額」，
導致**出席率分母被墊高、所有人的出席率偏低**。已修正（`repBad()`）。

### 這些改動怎麼驗證的

`worker/index.js` 的 `export default` 之前都是純函式，可以在 node 裡直接載入；
搭配 `node:sqlite` 就能拿舊版（`git show HEAD:worker/index.js`）與新版跑同一份資料對比。
另外 `app.js` 也能用 stub 過的 `document`/`fetch` 載進 node，讓 fetch 直接打到 worker
的 `fetch()`，就成了「真前端 ↔ 真 worker ↔ 真 sqlite」的端對端比對。
測過的重點：新舊統計在 5 種時間範圍下完全一致、worker 算的表格與前端算的每個欄位
逐一相同、代打／改名別名／長期請假／人工覆蓋／待確認名字都涵蓋。

## 載入速度優化（第四輪：真正的瓶頸是「D1 來回次數」）

> 同樣**不用跑 migration**。`worker/index.js` 整份重貼 Deploy。前端不用動。

前三輪都在猜。第三輪加上量測之後，實測數字直接指出答案：

```
 639ms  戰報列表   — 下載   1 KB
2091ms  成員表格   — 下載  46 KB
3559ms  請假看板   — 下載  72 KB
```

**下載量只有幾十 KB，但每個請求要 2-3.5 秒** → 成本不在資料量，也不在 CPU，
而在「一個接一個」的 D1 查詢次數。D1 資料庫只存在單一區域，每次查詢都是一趟網路來回
（實測約 130ms）。`2091ms ÷ 16 次查詢 ≈ 130ms`，對得起來。

改法：

1. **`env.DB.batch()`**：把統計要用的十來句 SELECT 一次送出，只付一趟來回的延遲
   （`loadStatsInputs()`）。兩個統計函式改成可以吃這份預抓資料。
2. 請假看板自己的兩個查詢（場次列表、幫會名稱）與 batch 彼此獨立 → 改成並行，
   等待時間變成三者的最大值而非加總。
3. computed 模式的 `ensureRosterBackfilled` 檢查併入判斷（名冊非空就代表早就跑過），少一趟來回。
4. `Access-Control-Expose-Headers: Server-Timing`——跨網域時瀏覽器的 JS 預設讀不到自訂
   回應標頭，少了這個前端永遠看不到伺服器耗時（第三輪就是因此沒顯示）。
5. 每個回應都附上 `Server-Timing: total;dur=…, d1;dur=…, d1n;desc="N calls / M batches"`，
   D1 用量從此是可觀測的。

效果（D1 來回次數）：

| 端點 | 改之前 | 改之後 |
|---|---|---|
| `/api/db-bundle?computed=1` | 16 次 | **3 次**（其中 1 次是 batch） |
| `/api/leave/board` | 20 次 | **5 次**（其中 3 次並行） |

以每次 130ms 模擬端到端回應時間：

| | 改之前 | 改之後 |
|---|---|---|
| 成員表格 | 1812ms | **276ms** |
| 請假看板 | 3210ms | **279ms** |

`batch()` 不可用時（舊資料庫少欄位等）會自動退回逐一查詢，
測試驗證過兩條路徑**結果完全一致**，只是慢。

### 不需要升級付費方案

瓶頸是查詢次數，不是 CPU 也不是免費額度。付費方案的 Smart Placement
（把 Worker 排到靠近 D1 的地方）在改之前會有感，改完之後只剩 2 趟來回，效益不大。

## 修正：臨時請假不會出現在請假名單

`computeLeaveStats` 對「臨時請假（`late_set`）」的處理原本是矛盾的：

```js
m.leave++;                        // 次數：併入請假 ✓
m.leaveByType[t]++;               // 次數：併入請假 ✓
ensureWin(wid).late.push(mid);    // 名單：只進 late
                                  // 名單：沒進 leave ✗
```

而每一個「該場請假名單」的使用者讀的都是 `byWindow[wid].leave`：

| 位置 | 用途 |
|---|---|
| `/api/leave/board` → `leaveByWindow` | 請假管理的各場次請假名單 |
| `/api/leave/windows` → `leave_count` | 場次列表顯示的請假人數 |
| `/api/leave/windows/notify` | Discord 開場通知的請假名單 |
| Discord `/請假名單` | 機器人查詢 |

所以只登記了「臨時請假」的人，會出現「**數字說他有請假、名單卻找不到人**」，
上面四個地方全都漏掉他。

修法：既然次數已經併入請假，名單也一起併入（`ensureWin(wid).leave.push(mid)`），
並在回傳前對所有名單去重。另外新增 `lateByWindow` 讓畫面能把這些人標成「臨時」，
所以合併後仍分得出「事前請假」與「臨時請假」。

**次數完全沒有變動**——臨時請假本來就已計入請假，這次只補名單，不會重複計算。
測試對五種時間範圍逐一驗證 `byMember` 完全不變，且 `byWindow.leave` 只允許
多出「該場的臨時請假者」、不得有重複、後備與缺席名單不得改變。

## 修正：成員檔案室的「合併」與請假管理的「使用 ID 合併」不是同一套邏輯

兩個功能各有一份實作，而成員檔案室那份是不完整的：

| 要轉移的資料 | `/api/roster/merge-by-id`（使用 ID） | `/api/merge-member`（檔案室，修正前） |
|---|---|---|
| 別名（歷史戰報歸戶） | ✅ | ✅ |
| 請假／後備／缺席／臨時請假／補登出席 | ✅ | ❌ |
| 代打（本人與代打者兩個方向） | ✅ | ❌ |
| 長期請假 | ✅ | ❌ |
| 人工覆蓋次數 | ✅ | ❌ |

檔案室那份只轉別名，然後把來源標成 `status='removed'`。因為統計只看 active 名冊，
來源名下的請假紀錄就變成**掛在已移除成員底下的孤兒資料**——到處都查不到，
所以使用者的感受是「合併看起來像刪除」。

修法：抽出共用函式 `mergeMemberIds()`，兩個端點都改用它，只留一份邏輯。
順便補上兩個原本兩邊都沒處理好的細節：

- `stat_overrides` 主鍵是 (member_id, owner)：目標已有自己的設定時，來源那筆要刪掉，
  否則 UPDATE 會撞主鍵而靜靜失敗。
- `members`（備註／標籤）是以**顯示名稱**為 key：合併後要把來源那筆刪掉，
  否則日後有同名新成員會莫名繼承到舊備註。

測試（`merge.mjs`）先用修正前的版本重現「請假/代打/長期請假/人工覆蓋全部沒轉走」，
再驗證修正後兩個端點產生的**資料庫狀態完全逐位元相同**，且第三人的資料不受影響。

### 已經合併過的資料要救回來

修正前在成員檔案室做過的合併，來源的請假紀錄還在資料庫裡（只是孤兒），沒有被刪掉。
`audit_log` 有記下每次合併的 `{from, to, into}`，所以可以補救。要處理的話，
先在 D1 Console 查出有哪些：

```sql
SELECT created_at, entity_id AS from_member_id, detail
FROM audit_log WHERE owner = '你的帳號' AND action = 'merge'
ORDER BY created_at DESC;
```

再對每一筆用 `detail` 裡的 `into`（目標 member_id）補跑一次「使用 ID 合併」即可。

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
