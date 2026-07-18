// =====================================================
// ===  身分系統輔助函式（member_id / alias）
// =====================================================
async function resolveMemberId(env, owner, name) {
  const row = await env.DB.prepare(
    "SELECT member_id FROM member_aliases WHERE owner = ? AND alias_name = ?"
  ).bind(owner, name).first();
  return row ? row.member_id : null;
}

async function getReportNamesSet(env, owner) {
  const { results: reports } = await env.DB.prepare(
    "SELECT raw_json FROM reports WHERE owner = ?"
  ).bind(owner).all();
  const names = new Set();
  for (const r of reports || []) {
    let data;
    try { data = JSON.parse(r.raw_json); } catch { continue; }
    (data.gA || []).forEach(p => { if (p && p.name) names.add(p.name); });
  }
  return names;
}

// 只在「名冊還完全是空的」時做一次性 backfill：把舊 `members` 表 + 歷史戰報出現過的名字
// 各自建成一筆穩定 member_id。之後就不再自動掃戰報——新名字要走「陌生名字確認」流程，
// 這樣「待確認名單」才有意義，也避免把新面孔悄悄當成新成員。
async function ensureRosterBackfilled(env, owner) {
  const existing = await env.DB.prepare(
    "SELECT COUNT(*) c FROM members_roster WHERE owner = ?"
  ).bind(owner).first();
  if ((existing?.c || 0) > 0) return; // 已初始化過，不再自動掃描

  const { results: legacyRows } = await env.DB.prepare("SELECT id FROM members WHERE owner = ?").bind(owner).all();
  const reportNames = await getReportNamesSet(env, owner);
  const allNames = new Set([...(legacyRows || []).map(r => r.id), ...reportNames]);
  const now = Date.now();
  for (const name of allNames) {
    if (!name) continue;
    const memberId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO members_roster (member_id, owner, display_name, status, version, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?) ON CONFLICT(owner, display_name) DO NOTHING"
    ).bind(memberId, owner, name, now, now).run();
    const roster = await env.DB.prepare(
      "SELECT member_id FROM members_roster WHERE owner = ? AND display_name = ?"
    ).bind(owner, name).first();
    await env.DB.prepare(
      "INSERT INTO member_aliases (alias_name, owner, member_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(alias_name, owner) DO NOTHING"
    ).bind(name, owner, roster?.member_id || memberId, now).run();
  }
}

// 保證某個名字一定有對應的 member_id（rename/合併時的自我修復用，避免資料半殘就整個壞掉）
async function ensureMemberFor(env, owner, name) {
  const existing = await resolveMemberId(env, owner, name);
  if (existing) return existing;
  const now = Date.now();
  const memberId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO members_roster (member_id, owner, display_name, status, version, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?) ON CONFLICT(owner, display_name) DO NOTHING"
  ).bind(memberId, owner, name, now, now).run();
  const roster = await env.DB.prepare(
    "SELECT member_id FROM members_roster WHERE owner = ? AND display_name = ?"
  ).bind(owner, name).first();
  const finalId = roster?.member_id || memberId;
  await env.DB.prepare(
    "INSERT INTO member_aliases (alias_name, owner, member_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(alias_name, owner) DO NOTHING"
  ).bind(name, owner, finalId, now).run();
  return finalId;
}

// 從 leave_actions 算出每個成員目前的請假/後備狀態（最新一筆事件決定狀態）
// 回傳 { byMember: {member_id: {leave, reserve}}, byWindow: {window_id: {leave:Set, reserve:Set}} }
async function computeLeaveStats(env, owner) {
  const { results } = await env.DB.prepare(
    "SELECT window_id, member_id, action, created_at FROM leave_actions WHERE owner = ? ORDER BY created_at ASC"
  ).bind(owner).all();
  // 針對每個 (window, member) 分別記錄「請假類」與「後備類」的最新狀態
  const leaveState = {};   // key `${window}|${member}` -> bool
  const reserveState = {};
  for (const a of results || []) {
    const key = a.window_id + "|" + a.member_id;
    if (a.action === 'leave_request') leaveState[key] = true;
    else if (a.action === 'leave_cancel') leaveState[key] = false;
    else if (a.action === 'reserve_set') reserveState[key] = true;
    else if (a.action === 'reserve_unset') reserveState[key] = false;
  }
  const byMember = {};
  const byWindow = {};
  const bump = (mid, field) => {
    if (!byMember[mid]) byMember[mid] = { leave: 0, reserve: 0 };
    byMember[mid][field]++;
  };
  const ensureWin = (wid) => {
    if (!byWindow[wid]) byWindow[wid] = { leave: [], reserve: [] };
    return byWindow[wid];
  };
  for (const key in leaveState) {
    if (!leaveState[key]) continue;
    const [wid, mid] = key.split("|");
    bump(mid, 'leave');
    ensureWin(wid).leave.push(mid);
  }
  for (const key in reserveState) {
    if (!reserveState[key]) continue;
    const [wid, mid] = key.split("|");
    bump(mid, 'reserve');
    ensureWin(wid).reserve.push(mid);
  }
  return { byMember, byWindow };
}

// 把 IP 雜湊成短字串（只用來粗略辨識/限流，不還原真實 IP）
async function hashIp(ip) {
  try {
    const data = new TextEncoder().encode(ip || "");
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].slice(0, 6).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch (e) { return ""; }
}

// 發 Discord 通知（用 owner 設定的 Incoming Webhook；沒設定就安靜跳過）
async function notifyDiscord(env, owner, payload) {
  try {
    const row = await env.DB.prepare(
      "SELECT discord_webhook_url FROM user_settings WHERE owner = ?"
    ).bind(owner).first();
    const urlStr = row?.discord_webhook_url;
    if (!urlStr) return;
    await fetch(urlStr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) { console.error("Discord 通知失敗", e); }
}

// 操作紀錄寫入（best-effort：migration 還沒跑之前不能讓這個把主要功能弄壞）
async function writeAudit(env, owner, actor, entityType, entityId, action, detail) {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (id, owner, actor, entity_type, entity_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), owner, actor, entityType, entityId || '', action, JSON.stringify(detail || {}), Date.now()).run();
  } catch (e) { console.error("audit_log 寫入失敗", e); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: corsHeaders });

    try {
      const authHeader = request.headers.get("Authorization");
      const token = authHeader?.replace("Bearer ", "");
      let user = null;

      if (token) {
        // 多重登入：優先查 sessions 表（允許多裝置各自的 token 並存）
        try {
          const s = await env.DB.prepare(
            "SELECT username FROM sessions WHERE token = ?"
          ).bind(token).first();
          if (s) {
            user = s.username;
            // 更新最後活動時間（best-effort）
            env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE token = ?")
              .bind(Date.now(), token).run().catch(() => {});
          }
        } catch (e) { /* sessions 表還沒建立時，往下退回舊機制 */ }

        // 向後相容：舊的 users.token 仍然有效（尚未重新登入的使用者不會被踢出）
        if (!user) {
          const u = await env.DB.prepare(
            "SELECT username FROM users WHERE token = ?"
          ).bind(token).first();
          if (u) user = u.username;
        }
      }

      const shareId = url.searchParams.get("share");
      const isShareMode = !user && shareId;

      const getShareOwner = async () => {
        if (!shareId) return null;
        const u = await env.DB.prepare(
          "SELECT username FROM users WHERE share_id = ?"
        ).bind(shareId).first();
        return u?.username || null;
      };

      // =========================
      // 🔐 註冊
      // =========================
      if (url.pathname === "/api/auth/register" && request.method === "POST") {
        const { username, password, guild } = await request.json();
        if (!username || !password) {
          return json({ error: "帳號密碼不能空" }, 400);
        }
        const exist = await env.DB.prepare(
          "SELECT username FROM users WHERE username = ?"
        ).bind(username).first();
        if (exist) {
          return json({ error: "帳號已存在" }, 400);
        }
        const newToken = crypto.randomUUID();
        const share_id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO users (username, password, token, share_id, guild) VALUES (?, ?, ?, ?, ?)"
        ).bind(username, password, newToken, share_id, guild || "").run();
        return json({ token: newToken, username, share_id, guild: guild || "" });
      }

      // =========================
      // 🔐 登入
      // =========================
      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        const loginBody = await request.json();
        const { username, password } = loginBody;
        const userRow = await env.DB.prepare(
          "SELECT * FROM users WHERE username = ? AND password = ?"
        ).bind(username, password).first();
        if (!userRow) {
          return json({ error: "帳密錯誤" }, 401);
        }
        const newToken = crypto.randomUUID();
        const now = Date.now();
        // 多重登入：每次登入建立一筆獨立 session，不再頂替其他裝置
        let deviceLabel = loginBody.device_label || "";
        const ua = request.headers.get("User-Agent") || "";
        if (!deviceLabel) deviceLabel = ua.slice(0, 60);
        try {
          await env.DB.prepare(
            "INSERT INTO sessions (token, username, device_label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)"
          ).bind(newToken, username, deviceLabel, now, now).run();
        } catch (e) {
          // sessions 表還沒建立時退回舊機制（單一 token）
          await env.DB.prepare("UPDATE users SET token = ? WHERE username = ?").bind(newToken, username).run();
        }
        return json({
          token: newToken,
          username,
          guild: userRow.guild || "",
          share_id: userRow.share_id
        });
      }

      // =========================
      // 🚪 登出（只刪自己這個 session）
      // =========================
      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        if (token) {
          await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run().catch(() => {});
        }
        return json({ status: "OK" });
      }

      // =========================
      // 💻 目前登入裝置清單
      // =========================
      if (url.pathname === "/api/auth/sessions" && request.method === "GET") {
        if (!user) return json({ error: "未授權" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT token, device_label, created_at, last_seen_at FROM sessions WHERE username = ? ORDER BY last_seen_at DESC"
        ).bind(user).all();
        // 標記哪一個是「目前這台」，token 本身不外流完整值
        const list = (results || []).map(s => ({
          id: s.token,
          is_current: s.token === token,
          device_label: s.device_label || "",
          created_at: s.created_at,
          last_seen_at: s.last_seen_at
        }));
        return json(list);
      }

      // =========================
      // 🔒 踢除指定裝置
      // =========================
      if (url.pathname === "/api/auth/revoke-session" && request.method === "POST") {
        if (!user) return json({ error: "未授權" }, 401);
        const { session_id } = await request.json();
        if (!session_id) return json({ error: "參數錯誤" }, 400);
        await env.DB.prepare(
          "DELETE FROM sessions WHERE token = ? AND username = ?"
        ).bind(session_id, user).run();
        return json({ status: "OK" });
      }

      // =========================
      // 🔑 修改密碼
      // =========================
      if (url.pathname === "/api/change-password" && request.method === "POST") {
        const { username, guild, newPassword } = await request.json();
        if (!username || !guild || !newPassword) return json({ error: "參數錯誤" }, 400);
        const u = await env.DB.prepare(
          "SELECT username FROM users WHERE username = ? AND guild = ?"
        ).bind(username, guild).first();
        if (!u) return json({ error: "帳號或幫會名稱不正確" }, 400);
        await env.DB.prepare(
          "UPDATE users SET password = ? WHERE username = ?"
        ).bind(newPassword, username).run();
        return json({ status: "OK" });
      }

      // =========================
      // 🔒 權限檢查函式
      // =========================
      const requireAuth = () => {
        if (!user) throw new Error("未授權");
      };

      // =========================
      // 📜 戰報列表
      // =========================
      if (url.pathname === "/api/histories") {
        if (isShareMode) {
          const owner = await getShareOwner();
          if (!owner) return json([]);
          const { results } = await env.DB.prepare(
            "SELECT * FROM reports WHERE owner = ? ORDER BY date DESC"
          ).bind(owner).all();
          return json(results || []);
        }
        requireAuth();
        const { results } = await env.DB.prepare(
          "SELECT * FROM reports WHERE owner = ? ORDER BY date DESC"
        ).bind(user).all();
        return json(results || []);
      }

      // =========================
      // 👥 成員（只回傳備註/標籤）
      // =========================
      if (url.pathname === "/api/members") {
        if (isShareMode) {
          const owner = await getShareOwner();
          if (!owner) return json([]);
          const { results } = await env.DB.prepare(
            "SELECT id, last_job, note FROM members WHERE owner = ?"
          ).bind(owner).all();
          return json(results || []);
        }
        requireAuth();
        const { results } = await env.DB.prepare(
          "SELECT id, last_job, note FROM members WHERE owner = ?"
        ).bind(user).all();
        return json(results || []);
      }

      // =========================
      // 📝 成員備註（單筆查詢）
      // =========================
      if (url.pathname === "/api/member-note") {
        const id = url.searchParams.get("id");
        if (isShareMode) {
          const owner = await getShareOwner();
          if (!owner) return json({ note: "" });
          const res = await env.DB.prepare(
            "SELECT note FROM members WHERE id = ? AND owner = ?"
          ).bind(id, owner).first();
          return json(res || { note: "" });
        }
        requireAuth();
        const res = await env.DB.prepare(
          "SELECT note FROM members WHERE id = ? AND owner = ?"
        ).bind(id, user).first();
        return json(res || { note: "" });
      }

      // =========================
      // 🪪 身分對照表（member_id / alias），供前端把歷史戰報名字歸戶到同一個穩定成員
      // =========================
      if (url.pathname === "/api/roster/aliases") {
        if (isShareMode) {
          const owner = await getShareOwner();
          if (!owner) return json({ aliases: [], roster: [] });
          const { results: aliases } = await env.DB.prepare(
            "SELECT alias_name, member_id FROM member_aliases WHERE owner = ?"
          ).bind(owner).all();
          const { results: roster } = await env.DB.prepare(
            "SELECT member_id, display_name FROM members_roster WHERE owner = ? AND status = 'active'"
          ).bind(owner).all();
          return json({ aliases: aliases || [], roster: roster || [] });
        }
        requireAuth();
        await ensureRosterBackfilled(env, user);
        const { results: aliases } = await env.DB.prepare(
          "SELECT alias_name, member_id FROM member_aliases WHERE owner = ?"
        ).bind(user).all();
        const { results: roster } = await env.DB.prepare(
          "SELECT member_id, display_name FROM members_roster WHERE owner = ? AND status = 'active'"
        ).bind(user).all();
        return json({ aliases: aliases || [], roster: roster || [] });
      }

      // =========================
      // 👤 名冊（roster）：列表 / 新增 / 刪除 / 陌生名字確認
      // =========================
      if (url.pathname === "/api/roster" && request.method === "GET") {
        requireAuth();
        await ensureRosterBackfilled(env, user);
        const { results } = await env.DB.prepare(
          "SELECT member_id, display_name, status FROM members_roster WHERE owner = ? AND status = 'active' ORDER BY display_name"
        ).bind(user).all();
        return json(results || []);
      }

      if (url.pathname === "/api/roster/add" && request.method === "POST") {
        requireAuth();
        const { display_name } = await request.json();
        if (!display_name) return json({ error: "名稱不能為空" }, 400);
        const exist = await env.DB.prepare(
          "SELECT member_id FROM members_roster WHERE owner = ? AND display_name = ?"
        ).bind(user, display_name).first();
        if (exist) return json({ error: "名稱已存在" }, 400);
        const memberId = crypto.randomUUID();
        const now = Date.now();
        await env.DB.prepare(
          "INSERT INTO members_roster (member_id, owner, display_name, status, version, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?)"
        ).bind(memberId, user, display_name, now, now).run();
        await env.DB.prepare(
          "INSERT INTO member_aliases (alias_name, owner, member_id, created_at) VALUES (?, ?, ?, ?)"
        ).bind(display_name, user, memberId, now).run();
        await writeAudit(env, user, user, 'roster', memberId, 'create', { display_name });
        return json({ status: "OK", member_id: memberId });
      }

      if (url.pathname === "/api/roster/delete" && request.method === "POST") {
        requireAuth();
        const { member_id } = await request.json();
        if (!member_id) return json({ error: "參數錯誤" }, 400);
        await env.DB.prepare(
          "UPDATE members_roster SET status='removed', updated_at=?, version=version+1 WHERE member_id=? AND owner=?"
        ).bind(Date.now(), member_id, user).run();
        await writeAudit(env, user, user, 'roster', member_id, 'delete', {});
        return json({ status: "OK" });
      }

      // 匯入戰報前先檢查有哪些名字還沒歸戶
      if (url.pathname === "/api/roster/check-names" && request.method === "POST") {
        requireAuth();
        await ensureRosterBackfilled(env, user);
        const { names } = await request.json();
        const unresolved = [];
        for (const n of (names || [])) {
          const row = await env.DB.prepare(
            "SELECT member_id FROM member_aliases WHERE owner=? AND alias_name=?"
          ).bind(user, n).first();
          if (!row) unresolved.push(n);
        }
        return json({ unresolved });
      }

      // 掃全部歷史戰報，列出目前還沒歸戶的名字（名冊頁「待確認名單」用）
      if (url.pathname === "/api/roster/unresolved" && request.method === "GET") {
        requireAuth();
        await ensureRosterBackfilled(env, user);
        const reportNames = await getReportNamesSet(env, user);
        const unresolved = [];
        for (const n of reportNames) {
          const row = await env.DB.prepare(
            "SELECT member_id FROM member_aliases WHERE owner=? AND alias_name=?"
          ).bind(user, n).first();
          if (!row) unresolved.push(n);
        }
        return json({ unresolved });
      }

      // 陌生名字確認：這是既有成員改名，還是全新成員
      if (url.pathname === "/api/roster/resolve-name" && request.method === "POST") {
        requireAuth();
        const { alias_name, target, member_id, set_as_current_name } = await request.json();
        if (!alias_name || !target) return json({ error: "參數錯誤" }, 400);

        const now = Date.now();
        const existingAlias = await env.DB.prepare(
          "SELECT member_id FROM member_aliases WHERE owner=? AND alias_name=?"
        ).bind(user, alias_name).first();
        if (existingAlias) return json({ error: "這個名字已經連結過了" }, 400);

        let targetMemberId = member_id;
        let rosterRow = null;
        if (target === 'new') {
          targetMemberId = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO members_roster (member_id, owner, display_name, status, version, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?)"
          ).bind(targetMemberId, user, alias_name, now, now).run();
          await writeAudit(env, user, user, 'roster', targetMemberId, 'create', { display_name: alias_name, via: 'csv-import' });
        } else {
          if (!targetMemberId) return json({ error: "缺少目標成員" }, 400);
          rosterRow = await env.DB.prepare(
            "SELECT member_id, display_name FROM members_roster WHERE member_id=? AND owner=?"
          ).bind(targetMemberId, user).first();
          if (!rosterRow) return json({ error: "找不到目標成員" }, 400);
        }

        await env.DB.prepare(
          "INSERT INTO member_aliases (alias_name, owner, member_id, created_at) VALUES (?, ?, ?, ?)"
        ).bind(alias_name, user, targetMemberId, now).run();
        await writeAudit(env, user, user, 'roster', targetMemberId, 'alias_link', { alias_name });

        if (target === 'existing' && set_as_current_name && rosterRow) {
          const oldName = rosterRow.display_name;
          await env.DB.prepare(
            "UPDATE members_roster SET display_name=?, updated_at=?, version=version+1 WHERE member_id=? AND owner=?"
          ).bind(alias_name, now, targetMemberId, user).run();
          await env.DB.prepare(
            "UPDATE members SET id=? WHERE id=? AND owner=?"
          ).bind(alias_name, oldName, user).run();
          await writeAudit(env, user, user, 'roster', targetMemberId, 'rename', { from: oldName, to: alias_name });
        }

        return json({ status: "OK", member_id: targetMemberId });
      }

      // =========================
      // 📋 名冊批次匯入
      // =========================
      if (url.pathname === "/api/roster/import" && request.method === "POST") {
        requireAuth();
        await ensureRosterBackfilled(env, user);
        const { names } = await request.json();
        if (!Array.isArray(names)) return json({ error: "參數錯誤" }, 400);
        const now = Date.now();
        let added = 0, skipped = 0;
        for (const raw of names) {
          const name = (raw || "").trim();
          if (!name) continue;
          const exist = await env.DB.prepare(
            "SELECT member_id FROM members_roster WHERE owner = ? AND display_name = ?"
          ).bind(user, name).first();
          if (exist) { skipped++; continue; }
          const memberId = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO members_roster (member_id, owner, display_name, status, version, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?)"
          ).bind(memberId, user, name, now, now).run();
          await env.DB.prepare(
            "INSERT INTO member_aliases (alias_name, owner, member_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(alias_name, owner) DO NOTHING"
          ).bind(name, user, memberId, now).run();
          added++;
        }
        await writeAudit(env, user, user, 'roster', '', 'import', { added, skipped });
        return json({ status: "OK", added, skipped });
      }

      // =========================
      // 🔢 出席/請假/後備：人工覆蓋（樂觀鎖）
      // =========================
      if (url.pathname === "/api/roster/override" && request.method === "POST") {
        requireAuth();
        const b = await request.json();
        const { member_id, attendance_override, leave_override, reserve_override, note, expected_version } = b;
        if (!member_id) return json({ error: "參數錯誤" }, 400);
        const now = Date.now();
        const cur = await env.DB.prepare(
          "SELECT version FROM stat_overrides WHERE member_id = ? AND owner = ?"
        ).bind(member_id, user).first();

        const norm = (v) => (v === '' || v === null || v === undefined) ? null : Number(v);

        if (!cur) {
          await env.DB.prepare(
            "INSERT INTO stat_overrides (member_id, owner, attendance_override, leave_override, reserve_override, note, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)"
          ).bind(member_id, user, norm(attendance_override), norm(leave_override), norm(reserve_override), note || null, now, user).run();
          await writeAudit(env, user, user, 'override', member_id, 'create', b);
          return json({ status: "OK", version: 1 });
        }
        if (typeof expected_version === 'number' && expected_version !== cur.version) {
          return json({ error: "資料已被其他人更新，請重新整理後再改", current_version: cur.version }, 409);
        }
        const res = await env.DB.prepare(
          "UPDATE stat_overrides SET attendance_override=?, leave_override=?, reserve_override=?, note=?, version=version+1, updated_at=?, updated_by=? WHERE member_id=? AND owner=? AND version=?"
        ).bind(norm(attendance_override), norm(leave_override), norm(reserve_override), note || null, now, user, member_id, user, cur.version).run();
        if (!res.meta || res.meta.changes === 0) {
          return json({ error: "資料已被其他人更新，請重新整理後再改", current_version: cur.version }, 409);
        }
        await writeAudit(env, user, user, 'override', member_id, 'update', b);
        return json({ status: "OK", version: cur.version + 1 });
      }

      // =========================
      // 🔢 讀取所有人工覆蓋（share 唯讀 / 登入）
      // =========================
      if (url.pathname === "/api/overrides") {
        let owner = user;
        if (isShareMode) owner = await getShareOwner();
        if (!owner) return json([]);
        const { results } = await env.DB.prepare(
          "SELECT member_id, attendance_override, leave_override, reserve_override, note, version FROM stat_overrides WHERE owner = ?"
        ).bind(owner).all();
        return json(results || []);
      }

      // =========================
      // 🗓️ 請假場次：列表（含每場請假/後備人數）
      // =========================
      if (url.pathname === "/api/leave/windows" && request.method === "GET") {
        let owner = user;
        if (isShareMode) owner = await getShareOwner();
        if (!owner) return json([]);
        const { results } = await env.DB.prepare(
          "SELECT window_id, event_date, session, title, status, version, created_at FROM leave_windows WHERE owner = ? ORDER BY event_date DESC, session ASC"
        ).bind(owner).all();
        const stats = await computeLeaveStats(env, owner);
        const list = (results || []).map(w => ({
          ...w,
          leave_count: (stats.byWindow[w.window_id]?.leave || []).length,
          reserve_count: (stats.byWindow[w.window_id]?.reserve || []).length
        }));
        return json(list);
      }

      // 建立請假場次（日期+第幾場，唯一）
      if (url.pathname === "/api/leave/windows/create" && request.method === "POST") {
        requireAuth();
        const { event_date, session, title } = await request.json();
        if (!event_date || !session) return json({ error: "請選擇日期與場次" }, 400);
        const dup = await env.DB.prepare(
          "SELECT window_id FROM leave_windows WHERE owner = ? AND event_date = ? AND session = ?"
        ).bind(user, event_date, session).first();
        if (dup) return json({ error: "這個日期＋場次已經開過請假了" }, 400);
        const windowId = crypto.randomUUID();
        const now = Date.now();
        await env.DB.prepare(
          "INSERT INTO leave_windows (window_id, owner, event_date, session, title, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?)"
        ).bind(windowId, user, event_date, session, title || "", now, now).run();
        await writeAudit(env, user, user, 'leave_window', windowId, 'create', { event_date, session, title });
        await notifyDiscord(env, user, {
          embeds: [{
            title: "🗓️ 已開放請假",
            description: `**${event_date}　${session}**${title ? "\n" + title : ""}\n請到請假連結登記。`,
            color: 3447003
          }]
        });
        return json({ status: "OK", window_id: windowId });
      }

      // 開放 / 關閉場次
      if (url.pathname === "/api/leave/windows/toggle" && request.method === "POST") {
        requireAuth();
        const { window_id, status, expected_version } = await request.json();
        if (!window_id || !status) return json({ error: "參數錯誤" }, 400);
        const cur = await env.DB.prepare(
          "SELECT version FROM leave_windows WHERE window_id = ? AND owner = ?"
        ).bind(window_id, user).first();
        if (!cur) return json({ error: "找不到場次" }, 404);
        if (typeof expected_version === 'number' && expected_version !== cur.version) {
          return json({ error: "場次已被其他人更新，請重新整理", current_version: cur.version }, 409);
        }
        const res = await env.DB.prepare(
          "UPDATE leave_windows SET status=?, version=version+1, updated_at=? WHERE window_id=? AND owner=? AND version=?"
        ).bind(status, Date.now(), window_id, user, cur.version).run();
        if (!res.meta || res.meta.changes === 0) {
          return json({ error: "場次已被其他人更新，請重新整理", current_version: cur.version }, 409);
        }
        await writeAudit(env, user, user, 'leave_window', window_id, 'toggle', { status });
        return json({ status: "OK", version: cur.version + 1 });
      }

      // 刪除場次（連同該場所有請假/後備事件）
      if (url.pathname === "/api/leave/windows/delete" && request.method === "POST") {
        requireAuth();
        const { window_id } = await request.json();
        if (!window_id) return json({ error: "參數錯誤" }, 400);
        await env.DB.prepare("DELETE FROM leave_windows WHERE window_id = ? AND owner = ?").bind(window_id, user).run();
        await env.DB.prepare("DELETE FROM leave_actions WHERE window_id = ? AND owner = ?").bind(window_id, user).run();
        await writeAudit(env, user, user, 'leave_window', window_id, 'delete', {});
        return json({ status: "OK" });
      }

      // 管理員手動操作（請假/取消/設後備/取消後備）
      if (url.pathname === "/api/leave/actions" && request.method === "POST") {
        requireAuth();
        const { window_id, member_id, action } = await request.json();
        const allowed = ['leave_request', 'leave_cancel', 'reserve_set', 'reserve_unset'];
        if (!window_id || !member_id || !allowed.includes(action)) return json({ error: "參數錯誤" }, 400);
        const win = await env.DB.prepare("SELECT window_id FROM leave_windows WHERE window_id = ? AND owner = ?").bind(window_id, user).first();
        if (!win) return json({ error: "找不到場次" }, 404);
        await env.DB.prepare(
          "INSERT INTO leave_actions (action_id, window_id, owner, member_id, action, actor, actor_meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), window_id, user, member_id, action, user, JSON.stringify({ by: 'admin' }), Date.now()).run();
        await writeAudit(env, user, user, 'leave_action', window_id, action, { member_id });
        return json({ status: "OK" });
      }

      // 單一場次目前的請假/後備名單（管理員用）
      if (url.pathname === "/api/leave/window-members" && request.method === "GET") {
        requireAuth();
        const windowId = url.searchParams.get("window_id");
        if (!windowId) return json({ error: "參數錯誤" }, 400);
        const stats = await computeLeaveStats(env, user);
        return json({
          leave: stats.byWindow[windowId]?.leave || [],
          reserve: stats.byWindow[windowId]?.reserve || []
        });
      }

      // 每個成員的請假/後備次數（share 唯讀 / 登入）
      if (url.pathname === "/api/leave/stats") {
        let owner = user;
        if (isShareMode) owner = await getShareOwner();
        if (!owner) return json({});
        const stats = await computeLeaveStats(env, owner);
        return json(stats.byMember);
      }

      // =========================
      // 🌐 公開請假頁：讀取看板（免登入，用 share_id）
      // =========================
      if (url.pathname === "/api/leave/public/board") {
        if (!shareId) return json({ error: "缺少 share" }, 400);
        const owner = await getShareOwner();
        if (!owner) return json({ error: "連結無效" }, 404);
        const { results: windows } = await env.DB.prepare(
          "SELECT window_id, event_date, session, title, status FROM leave_windows WHERE owner = ? AND status = 'open' ORDER BY event_date DESC, session ASC"
        ).bind(owner).all();
        const { results: roster } = await env.DB.prepare(
          "SELECT member_id, display_name FROM members_roster WHERE owner = ? AND status = 'active' ORDER BY display_name"
        ).bind(owner).all();
        const stats = await computeLeaveStats(env, owner);
        const leaveByWindow = {}, reserveByWindow = {};
        (windows || []).forEach(w => {
          leaveByWindow[w.window_id] = stats.byWindow[w.window_id]?.leave || [];
          reserveByWindow[w.window_id] = stats.byWindow[w.window_id]?.reserve || [];
        });
        const u = await env.DB.prepare("SELECT guild FROM users WHERE username = ?").bind(owner).first();
        return json({ guild: u?.guild || "", windows: windows || [], roster: roster || [], leaveByWindow, reserveByWindow });
      }

      // =========================
      // 🌐 公開請假頁：送出請假 / 取消（免登入）
      // =========================
      if (url.pathname === "/api/leave/public/submit" && request.method === "POST") {
        if (!shareId) return json({ error: "缺少 share" }, 400);
        const owner = await getShareOwner();
        if (!owner) return json({ error: "連結無效" }, 404);
        const { window_id, member_id, action } = await request.json();
        if (!window_id || !member_id || !['leave_request', 'leave_cancel'].includes(action)) {
          return json({ error: "參數錯誤" }, 400);
        }
        const win = await env.DB.prepare(
          "SELECT status FROM leave_windows WHERE window_id = ? AND owner = ?"
        ).bind(window_id, owner).first();
        if (!win) return json({ error: "找不到場次" }, 404);
        if (win.status !== 'open') return json({ error: "這個場次已關閉，無法再請假" }, 403);
        const mem = await env.DB.prepare(
          "SELECT display_name FROM members_roster WHERE member_id = ? AND owner = ? AND status = 'active'"
        ).bind(member_id, owner).first();
        if (!mem) return json({ error: "找不到這個名字，請確認或聯絡管理員" }, 404);

        // 粗略限流：同一 owner 5 秒內公開操作過多 → 擋掉
        const since = Date.now() - 5000;
        const recent = await env.DB.prepare(
          "SELECT COUNT(*) c FROM leave_actions WHERE owner = ? AND actor = 'public' AND created_at > ?"
        ).bind(owner, since).first();
        if ((recent?.c || 0) > 30) return json({ error: "操作太頻繁，請稍後再試" }, 429);

        const ipHash = await hashIp(request.headers.get("CF-Connecting-IP"));
        const ua = (request.headers.get("User-Agent") || "").slice(0, 80);
        await env.DB.prepare(
          "INSERT INTO leave_actions (action_id, window_id, owner, member_id, action, actor, actor_meta, created_at) VALUES (?, ?, ?, ?, ?, 'public', ?, ?)"
        ).bind(crypto.randomUUID(), window_id, owner, member_id, action, JSON.stringify({ ip: ipHash, ua }), Date.now()).run();
        await writeAudit(env, owner, 'public', 'leave_action', window_id, action, { member_id, ip: ipHash });

        const verb = action === 'leave_request' ? "🙋 請假" : "↩️ 取消請假";
        await notifyDiscord(env, owner, {
          embeds: [{
            title: verb,
            description: `**${mem.display_name}**`,
            color: action === 'leave_request' ? 15158332 : 9807270
          }]
        });
        return json({ status: "OK" });
      }

      // =========================
      // 🧾 操作紀錄（後台）
      // =========================
      if (url.pathname === "/api/audit" && request.method === "GET") {
        requireAuth();
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);
        const { results } = await env.DB.prepare(
          "SELECT id, actor, entity_type, entity_id, action, detail, created_at FROM audit_log WHERE owner = ? ORDER BY created_at DESC LIMIT ?"
        ).bind(user, limit).all();
        return json(results || []);
      }

      // =========================
      // 🤖 Discord 設定
      // =========================
      if (url.pathname === "/api/settings/discord" && request.method === "GET") {
        requireAuth();
        const row = await env.DB.prepare(
          "SELECT discord_webhook_url, discord_guild_id FROM user_settings WHERE owner = ?"
        ).bind(user).first();
        return json(row || { discord_webhook_url: "", discord_guild_id: "" });
      }
      if (url.pathname === "/api/settings/discord" && request.method === "POST") {
        requireAuth();
        const { webhook_url, guild_id } = await request.json();
        await env.DB.prepare(
          "INSERT INTO user_settings (owner, discord_webhook_url, discord_guild_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner) DO UPDATE SET discord_webhook_url = excluded.discord_webhook_url, discord_guild_id = excluded.discord_guild_id, updated_at = excluded.updated_at"
        ).bind(user, webhook_url || "", guild_id || "", Date.now()).run();
        await writeAudit(env, user, user, 'session', '', 'discord_settings', {});
        return json({ status: "OK" });
      }

      // =========================
      // 🔀 共享戰報：建立 Token
      // ✅ 需要先在 D1 執行：
      //    CREATE TABLE IF NOT EXISTS transfers (
      //      token TEXT PRIMARY KEY,
      //      owner TEXT NOT NULL,
      //      ids_json TEXT NOT NULL,
      //      expires_at INTEGER NOT NULL
      //    );
      // =========================
      if (url.pathname === "/api/transfer/create" && request.method === "POST") {
        requireAuth();
        const { ids } = await request.json();
        if (!Array.isArray(ids) || ids.length === 0) {
          return json({ error: "無效的戰報 ID 列表" }, 400);
        }
        const transferToken = crypto.randomUUID();
        const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 天有效
        await env.DB.prepare(
          "INSERT INTO transfers (token, owner, ids_json, expires_at) VALUES (?, ?, ?, ?)"
        ).bind(transferToken, user, JSON.stringify(ids), expiresAt).run();
        return json({ token: transferToken });
      }

      // =========================
      // 🔀 共享戰報：用 Token 拉取
      // =========================
      if (url.pathname === "/api/transfer/fetch" && request.method === "GET") {
        const transferToken = url.searchParams.get("token");
        if (!transferToken) return json({ error: "缺少 token" }, 400);
        const row = await env.DB.prepare(
          "SELECT * FROM transfers WHERE token = ?"
        ).bind(transferToken).first();
        if (!row) return json({ error: "共享鏈結不存在或已過期" }, 404);
        if (row.expires_at < Date.now()) {
          await env.DB.prepare(
            "DELETE FROM transfers WHERE token = ?"
          ).bind(transferToken).run();
          return json({ error: "共享鏈結已過期（7天有效）" }, 410);
        }
        let ids = [];
        try { ids = JSON.parse(row.ids_json); } catch (e) { }
        if (ids.length === 0) return json([]);
        const placeholders = ids.map(() => "?").join(",");
        const { results } = await env.DB.prepare(
          `SELECT * FROM reports WHERE owner = ? AND id IN (${placeholders})`
        ).bind(row.owner, ...ids).all();
        return json(results || []);
      }

      // =========================
      // ❗ 以下禁止分享模式寫入
      // =========================
      if (isShareMode) {
        return json({ error: "唯讀模式" }, 403);
      }

      // =========================
      // 💾 儲存戰報
      // ✅ 前提：reports 表 PRIMARY KEY 必須是 (id, owner) 複合主鍵
      //    請先在 D1 執行 migration.sql 再部署此 Worker
      //
      //    UPSERT 行為：
      //    - 同 id + 同 owner（本地同步/重複儲存）→ UPDATE 覆蓋，資料更新
      //    - 同 id + 不同 owner（跨帳號接收）→ 視為全新一筆 INSERT，兩方資料並存
      //    - 發起方資料完全不受影響
      // =========================
      if (url.pathname === "/api/save-history" && request.method === "POST") {
        requireAuth();
        const d = await request.json();
        await env.DB.prepare(`
          INSERT INTO reports (id, date, guild_a, guild_b, raw_json, owner)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id, owner) DO UPDATE SET
            date     = excluded.date,
            guild_a  = excluded.guild_a,
            guild_b  = excluded.guild_b,
            raw_json = excluded.raw_json
        `).bind(d.id, d.fullDateTime, d.nameA, d.nameB, JSON.stringify(d.rawData), user).run();
        return json({ status: "OK" });
      }

      // =========================
      // 🗑️ 刪除戰報
      // =========================
      if (url.pathname === "/api/delete-history" && request.method === "POST") {
        requireAuth();
        const { id } = await request.json();
        await env.DB.prepare(
          "DELETE FROM reports WHERE id = ? AND owner = ?"
        ).bind(id, user).run();
        return json({ status: "OK" });
      }

      // =========================
      // ✏️ 備註更新
      // =========================
      if (url.pathname === "/api/update-note" && request.method === "POST") {
        requireAuth();
        const { id, note } = await request.json();
        await env.DB.prepare(`
          INSERT INTO members (id, last_job, matches, total_dmg, note, owner)
          VALUES (?, '', 0, 0, ?, ?)
          ON CONFLICT(id, owner) DO UPDATE SET note = excluded.note
        `).bind(id, note, user).run();
        return json({ status: "OK" });
      }

      // =========================
      // 🔀 合併成員（改為轉指 alias，不再重寫歷史戰報 raw_json）
      // =========================
      if (url.pathname === "/api/merge-member" && request.method === "POST") {
        requireAuth();
        const { fromId, toId } = await request.json();
        if (!fromId || !toId) return json({ error: "參數錯誤" }, 400);

        await ensureRosterBackfilled(env, user);

        const fromMemberId = await ensureMemberFor(env, user, fromId);
        const toMemberId = await ensureMemberFor(env, user, toId);
        if (fromMemberId === toMemberId) return json({ error: "來源與目標是同一位成員" }, 400);

        const now = Date.now();
        // 把來源成員底下所有名字（含歷史用過的）全部轉指到目標成員
        await env.DB.prepare(
          "UPDATE member_aliases SET member_id = ? WHERE owner = ? AND member_id = ?"
        ).bind(toMemberId, user, fromMemberId).run();
        await env.DB.prepare(
          "UPDATE members_roster SET status='removed', updated_at=?, version=version+1 WHERE member_id=? AND owner=?"
        ).bind(now, fromMemberId, user).run();

        // 合併備註／標籤（若目標沒有備註，沿用來源的備註）
        const fromNote = await env.DB.prepare("SELECT note FROM members WHERE id=? AND owner=?").bind(fromId, user).first();
        const toNote = await env.DB.prepare("SELECT note FROM members WHERE id=? AND owner=?").bind(toId, user).first();
        if (fromNote?.note && !toNote?.note) {
          await env.DB.prepare(`
            INSERT INTO members (id, last_job, matches, total_dmg, note, owner)
            VALUES (?, '', 0, 0, ?, ?)
            ON CONFLICT(id, owner) DO UPDATE SET note = excluded.note
          `).bind(toId, fromNote.note, user).run();
        }
        await env.DB.prepare("DELETE FROM members WHERE id = ? AND owner = ?").bind(fromId, user).run();

        await writeAudit(env, user, user, 'roster', fromMemberId, 'merge', { from: fromId, to: toId, into: toMemberId });

        // updated 保留欄位僅為前端訊息相容用，歷史戰報完全沒被改寫
        return json({ status: "OK", updated: 0 });
      }

      // =========================
      // ✏️ 更名（改為更新 roster + alias，不再重寫歷史戰報 raw_json）
      // =========================
      if (url.pathname === "/api/rename" && request.method === "POST") {
        requireAuth();
        const body = await request.json();
        const oldV = body.oldId || body.oldName || body.id;
        const newV = body.newId || body.newName;
        if (!oldV || !newV) return json({ error: "參數錯誤" }, 400);

        await ensureRosterBackfilled(env, user);

        // 自我修復：就算資料半殘（例如 migration 沒跑完整）也不硬失敗，補建 member 再改名
        const memberId = await ensureMemberFor(env, user, oldV);

        const newAlias = await env.DB.prepare(
          "SELECT member_id FROM member_aliases WHERE owner=? AND alias_name=?"
        ).bind(user, newV).first();
        if (newAlias && newAlias.member_id !== memberId) {
          return json({ error: "新名稱已被其他成員使用，如果這是同一個人請改用「合併」" }, 400);
        }

        const now = Date.now();
        await env.DB.prepare(
          "UPDATE members_roster SET display_name=?, updated_at=?, version=version+1 WHERE member_id=? AND owner=?"
        ).bind(newV, now, memberId, user).run();
        if (!newAlias) {
          await env.DB.prepare(
            "INSERT INTO member_aliases (alias_name, owner, member_id, created_at) VALUES (?, ?, ?, ?)"
          ).bind(newV, user, memberId, now).run();
        }
        await env.DB.prepare(
          "UPDATE members SET id = ? WHERE id = ? AND owner = ?"
        ).bind(newV, oldV, user).run();

        await writeAudit(env, user, user, 'roster', memberId, 'rename', { from: oldV, to: newV });

        return json({ status: "OK", message: "更名完成，歷史戰報資料無需重寫", updated: 0 });
      }

      return json({ error: "API 路徑未定義", path: url.pathname }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "伺服器內部錯誤", detail: e.message }, 500);
    }
  }
};
