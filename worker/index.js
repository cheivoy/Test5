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
// 回傳 { byMember: {member_id: {leave, reserve, leaveByType, reserveByType}}, byWindow: {window_id: {leave:[], reserve:[]}} }
async function computeLeaveStats(env, owner, fromDate, toDate) {
  // 每個場次的類型（幫戰/約戰/其他=領地戰），供請假/後備依類型細分
  // fromDate/toDate（'YYYY-MM-DD'，可選）：只計算場次日期落在範圍內的請假/後備
  const winType = {};
  const winDate = {};
  try {
    const { results: wins } = await env.DB.prepare(
      "SELECT window_id, match_type, event_date FROM leave_windows WHERE owner = ?"
    ).bind(owner).all();
    (wins || []).forEach(w => { winType[w.window_id] = w.match_type || '幫戰'; winDate[w.window_id] = w.event_date || ''; });
  } catch (e) {
    // match_type 欄位尚未建立（migration 004 還沒跑）→ 全部視為幫戰
    const { results: wins } = await env.DB.prepare(
      "SELECT window_id, event_date FROM leave_windows WHERE owner = ?"
    ).bind(owner).all();
    (wins || []).forEach(w => { winType[w.window_id] = '幫戰'; winDate[w.window_id] = w.event_date || ''; });
  }
  const inRange = (wid) => {
    const d = winDate[wid] || '';
    if (fromDate && (!d || d < fromDate)) return false;
    if (toDate && (!d || d > toDate)) return false;
    return true;
  };

  const { results } = await env.DB.prepare(
    "SELECT window_id, member_id, action, created_at FROM leave_actions WHERE owner = ? ORDER BY created_at ASC"
  ).bind(owner).all();
  const leaveState = {};   // key `${window}|${member}` -> bool
  const reserveState = {};
  const lateState = {};    // 臨時請假
  for (const a of results || []) {
    const key = a.window_id + "|" + a.member_id;
    if (a.action === 'leave_request') leaveState[key] = true;
    else if (a.action === 'leave_cancel') leaveState[key] = false;
    else if (a.action === 'reserve_set') reserveState[key] = true;
    else if (a.action === 'reserve_unset') reserveState[key] = false;
    else if (a.action === 'late_set') lateState[key] = true;
    else if (a.action === 'late_unset') lateState[key] = false;
  }
  const byMember = {};
  const byWindow = {};
  const ensureMember = (mid) => {
    if (!byMember[mid]) byMember[mid] = { leave: 0, reserve: 0, late: 0, leaveByType: {}, reserveByType: {}, lateByType: {} };
    return byMember[mid];
  };
  const ensureWin = (wid) => {
    if (!byWindow[wid]) byWindow[wid] = { leave: [], reserve: [], late: [] };
    return byWindow[wid];
  };
  for (const key in leaveState) {
    if (!leaveState[key]) continue;
    const [wid, mid] = key.split("|");
    if (!inRange(wid)) continue;
    const t = winType[wid] || '幫戰';
    const m = ensureMember(mid);
    m.leave++;
    m.leaveByType[t] = (m.leaveByType[t] || 0) + 1;
    ensureWin(wid).leave.push(mid);
  }
  // 長期/預先請假：範圍涵蓋的場次，若本人在該場沒有明確請假/取消動作，也算請假（動態判定）
  let longLeaves = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT member_id, from_date, to_date FROM long_leaves WHERE owner = ?"
    ).bind(owner).all();
    longLeaves = results || [];
  } catch (e) { longLeaves = []; }
  for (const ll of longLeaves) {
    for (const wid in winDate) {
      const d = winDate[wid];
      if (!d || d < ll.from_date || d > ll.to_date) continue;
      if (!inRange(wid)) continue;
      const key = wid + "|" + ll.member_id;
      if (key in leaveState) continue; // 單場明確動作（請假或取消）優先
      const t = winType[wid] || '幫戰';
      const m = ensureMember(ll.member_id);
      m.leave++;
      m.leaveByType[t] = (m.leaveByType[t] || 0) + 1;
      ensureWin(wid).leave.push(ll.member_id);
      leaveState[key] = true; // 標記已計，避免其他迴圈重複
    }
  }
  for (const key in reserveState) {
    if (!reserveState[key]) continue;
    const [wid, mid] = key.split("|");
    if (!inRange(wid)) continue;
    const t = winType[wid] || '幫戰';
    const m = ensureMember(mid);
    m.reserve++;
    m.reserveByType[t] = (m.reserveByType[t] || 0) + 1;
    ensureWin(wid).reserve.push(mid);
  }
  // 臨時請假：併入請假次數（leaveByType），另外單獨累計 lateByType 以便醒目標示
  for (const key in lateState) {
    if (!lateState[key]) continue;
    const [wid, mid] = key.split("|");
    if (!inRange(wid)) continue;
    // 同一場已經算過正式請假就不重複加（避免 leave_request + late 雙算）
    if (leaveState[key]) { const m0 = ensureMember(mid); const t0 = winType[wid] || '幫戰'; m0.late++; m0.lateByType[t0] = (m0.lateByType[t0] || 0) + 1; ensureWin(wid).late.push(mid); continue; }
    const t = winType[wid] || '幫戰';
    const m = ensureMember(mid);
    m.late++;
    m.lateByType[t] = (m.lateByType[t] || 0) + 1;
    m.leave++;
    m.leaveByType[t] = (m.leaveByType[t] || 0) + 1;
    ensureWin(wid).late.push(mid);
  }
  return { byMember, byWindow };
}

// 彙整每個在職成員的：職業（依最新一場）、出席次數、請假次數、後備次數（含人工覆蓋）
// 回傳 map: member_id -> { member_id, display_name, job, attendance, leave, reserve }
async function computeMemberStats(env, owner) {
  const { results: aliases } = await env.DB.prepare(
    "SELECT alias_name, member_id FROM member_aliases WHERE owner = ?"
  ).bind(owner).all();
  const aliasMap = {};
  (aliases || []).forEach(a => { aliasMap[a.alias_name] = a.member_id; });

  let roster;
  try {
    ({ results: roster } = await env.DB.prepare(
      "SELECT member_id, display_name, job, category FROM members_roster WHERE owner = ? AND status = 'active'"
    ).bind(owner).all());
  } catch (e) {
    try {
      ({ results: roster } = await env.DB.prepare(
        "SELECT member_id, display_name, job FROM members_roster WHERE owner = ? AND status = 'active'"
      ).bind(owner).all());
    } catch (e2) {
      // job / category 欄位尚未建立（migration 005/006 還沒跑）
      ({ results: roster } = await env.DB.prepare(
        "SELECT member_id, display_name FROM members_roster WHERE owner = ? AND status = 'active'"
      ).bind(owner).all());
    }
  }
  const members = {};
  (roster || []).forEach(r => {
    // 職業預設用名冊自填值（自助建檔時填的），之後有戰報就以戰報實際職業為準
    members[r.member_id] = { member_id: r.member_id, display_name: r.display_name, job: r.job || '未知', category: r.category || '', attendance: 0, attendanceByType: {}, _latest: '' };
  });

  // 代替上號對照：key = `日期|場次|類型` → { 本人member_id: 代打者member_id }
  const subMap = {};
  try {
    const { results: subs } = await env.DB.prepare(
      "SELECT ls.member_id AS a, ls.substitute_member_id AS b, w.event_date, w.session, w.match_type " +
      "FROM leave_substitutes ls JOIN leave_windows w ON ls.window_id = w.window_id AND ls.owner = w.owner " +
      "WHERE ls.owner = ?"
    ).bind(owner).all();
    (subs || []).forEach(s => {
      const key = `${s.event_date}|${s.session}|${s.match_type || '幫戰'}`;
      (subMap[key] = subMap[key] || {})[s.a] = s.b;
    });
  } catch (e) { /* leave_substitutes 表還沒建立（migration 010 未跑） */ }

  // 出席以「場次(date|session|type)」為單位去重：同一場戰報＋補登不重複算
  const addAtt = (mid, sk, type) => {
    const m = members[mid];
    if (!m) return;
    if (!m._att) m._att = new Set();
    if (!m._att.has(sk)) { m._att.add(sk); m.attendanceByType[type] = (m.attendanceByType[type] || 0) + 1; }
  };

  const { results: reports } = await env.DB.prepare(
    "SELECT date, raw_json FROM reports WHERE owner = ?"
  ).bind(owner).all();
  for (const rep of reports || []) {
    let d; try { d = JSON.parse(rep.raw_json); } catch { continue; }
    const session = d.session || '第一場';
    const type = d.matchType || '幫戰';
    const sortKey = (rep.date || '') + '|' + (session === '第二場' ? '2' : '1');
    const sk = `${rep.date}|${session}|${type}`;
    const subForWin = subMap[`${rep.date}|${session}|${type}`];
    (d.gA || []).forEach(p => {
      const origId = aliasMap[p.name];
      if (!origId) return;
      // 代替上號：出席算給代打者（本人這場不算）
      const subB = subForWin && subForWin[origId];
      const target = subB || origId;
      addAtt(target, sk, type);
      // 職業只以本人的非代打場更新
      if (!subB) {
        const m = members[origId];
        if (m && sortKey >= m._latest) { m._latest = sortKey; if (p.job) m.job = p.job; }
      }
    });
  }

  // 手動補登出席（漏戰報時）：以場次(date|session|type)為單位併入，與戰報去重
  try {
    const { results: winRows } = await env.DB.prepare(
      "SELECT window_id, event_date, session, match_type FROM leave_windows WHERE owner = ?"
    ).bind(owner).all();
    const winInfo = {}; (winRows || []).forEach(w => { winInfo[w.window_id] = w; });
    const { results: attActs } = await env.DB.prepare(
      "SELECT window_id, member_id, action FROM leave_actions WHERE owner = ? AND action IN ('attend_set','attend_unset') ORDER BY created_at ASC"
    ).bind(owner).all();
    const attState = {};
    for (const a of attActs || []) attState[a.window_id + '|' + a.member_id] = (a.action === 'attend_set');
    for (const k in attState) {
      if (!attState[k]) continue;
      const idx = k.lastIndexOf('|');
      const wid = k.slice(0, idx), mid = k.slice(idx + 1);
      const w = winInfo[wid];
      if (!w) continue;
      const type = w.match_type || '幫戰';
      addAtt(mid, `${w.event_date}|${w.session}|${type}`, type);
    }
  } catch (e) { /* 補登出席尚未使用 */ }

  // 出席次數＝去重後的場次數
  Object.values(members).forEach(m => { m.attendance = m._att ? m._att.size : 0; });

  const stats = await computeLeaveStats(env, owner);
  let ovs;
  try {
    ({ results: ovs } = await env.DB.prepare(
      "SELECT member_id, attendance_override, leave_override, reserve_override, overrides_json FROM stat_overrides WHERE owner = ?"
    ).bind(owner).all());
  } catch (e) {
    ({ results: ovs } = await env.DB.prepare(
      "SELECT member_id, attendance_override, leave_override, reserve_override FROM stat_overrides WHERE owner = ?"
    ).bind(owner).all());
  }
  const ovMap = {};
  (ovs || []).forEach(o => { ovMap[o.member_id] = o; });

  const TYPES = ['幫戰', '約戰', '其他'];
  Object.values(members).forEach(m => {
    const sm = stats.byMember[m.member_id];
    const autoAttByType = m.attendanceByType || {};
    const autoLeaveByType = sm?.leaveByType || {};
    const autoReserveByType = sm?.reserveByType || {};

    const o = ovMap[m.member_id];
    let perType = null, hasOverride = false;
    if (o && o.overrides_json) {
      try { perType = JSON.parse(o.overrides_json); } catch (e) { perType = null; }
    }

    const attByType = {}, leaveByType = {}, reserveByType = {};
    TYPES.forEach(t => {
      const ot = (perType && perType[t]) ? perType[t] : {};
      const a = (ot.attendance != null) ? ot.attendance : (autoAttByType[t] || 0);
      const l = (ot.leave != null) ? ot.leave : (autoLeaveByType[t] || 0);
      const r = (ot.reserve != null) ? ot.reserve : (autoReserveByType[t] || 0);
      if (ot.attendance != null || ot.leave != null || ot.reserve != null) hasOverride = true;
      attByType[t] = a; leaveByType[t] = l; reserveByType[t] = r;
    });

    let attendance = TYPES.reduce((s, t) => s + attByType[t], 0);
    let leave = TYPES.reduce((s, t) => s + leaveByType[t], 0);
    let reserve = TYPES.reduce((s, t) => s + reserveByType[t], 0);

    // 舊版整體覆蓋（沒有 overrides_json 時才套用，向後相容）
    if (!perType && o) {
      if (o.attendance_override != null) { attendance = o.attendance_override; hasOverride = true; }
      if (o.leave_override != null) { leave = o.leave_override; hasOverride = true; }
      if (o.reserve_override != null) { reserve = o.reserve_override; hasOverride = true; }
    }

    m.attendance = attendance;
    m.leave = leave;
    m.reserve = reserve;
    m.attendanceByType = attByType;
    m.leaveByType = leaveByType;
    m.reserveByType = reserveByType;
    m.hasOverride = hasOverride;
    delete m._latest;
    delete m._att;
  });
  return members;
}

// 把 IP 雜湊成短字串（只用來粗略辨識/限流，不還原真實 IP）
async function hashIp(ip) {
  try {
    const data = new TextEncoder().encode(ip || "");
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].slice(0, 6).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch (e) { return ""; }
}

// 通知事件種類（前後端一致）
const DISCORD_EVENT_KEYS = ['leave_open', 'leave_submit', 'self_join', 'noshow'];

// 取得 owner 要發送的頻道清單（多頻道；沒設定多頻道時退回舊的單一 webhook＝全部事件）
async function getDiscordTargets(env, owner) {
  let channels = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT name, webhook_url, events, mention_role_id, enabled FROM discord_channels WHERE owner = ?"
    ).bind(owner).all();
    channels = (results || []).filter(c => c.enabled && c.webhook_url);
  } catch (e) { channels = []; }
  if (channels.length === 0) {
    // 向後相容：只設過舊的單一 webhook → 視為接收全部事件的一個頻道
    try {
      const row = await env.DB.prepare(
        "SELECT discord_webhook_url FROM user_settings WHERE owner = ?"
      ).bind(owner).first();
      if (row?.discord_webhook_url) {
        channels = [{ name: '(舊設定)', webhook_url: row.discord_webhook_url, events: null, mention_role_id: null, enabled: 1 }];
      }
    } catch (e) { /* ignore */ }
  }
  return channels;
}

// 發 Discord 通知：依事件 key 分流到有勾選該事件的頻道，套用每頻道的 @身分組
// message: { embed?, content? }
async function notifyDiscord(env, owner, eventKey, message) {
  try {
    const channels = await getDiscordTargets(env, owner);
    for (const c of channels) {
      let events = null;
      try { events = c.events ? JSON.parse(c.events) : null; } catch (e) { events = null; }
      // events 為 null 或空陣列＝全部事件；否則必須包含此事件 key
      if (Array.isArray(events) && events.length > 0 && !events.includes(eventKey)) continue;
      // 身分組 ID 只保留數字，避免使用者貼到名稱或 <@&...> 造成整則通知失敗
      const roleId = (c.mention_role_id || '').replace(/\D/g, '');
      const mention = roleId ? `<@&${roleId}>` : '';
      const content = [mention, message.content || ''].filter(Boolean).join(' ').trim();
      const body = {};
      if (content) body.content = content;
      if (message.embed) body.embeds = [message.embed];
      // 只允許明確指定的身分組被 tag，避免誤 @everyone
      if (roleId) body.allowed_mentions = { roles: [roleId] };
      try {
        const res = await fetch(c.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        // 若帶了 @身分組卻被 Discord 退回（多半是角色 ID 無效）→ 拿掉 @ 重送，至少通知要出去
        if (!res.ok && roleId) {
          const body2 = {};
          if (message.content) body2.content = message.content;
          if (message.embed) body2.embeds = [message.embed];
          await fetch(c.webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body2)
          });
        }
      } catch (e) { console.error("Discord 單頻道發送失敗", e); }
    }
  } catch (e) { console.error("Discord 通知失敗", e); }
}

// 組出該 owner 的公開請假連結（用設定的站台網址，退回請求 Origin）
async function buildLeaveUrl(env, owner, request) {
  try {
    const u = await env.DB.prepare(
      "SELECT share_id FROM users WHERE username = ?"
    ).bind(owner).first();
    if (!u?.share_id) return '';
    let base = '';
    try {
      const s = await env.DB.prepare(
        "SELECT site_base_url FROM user_settings WHERE owner = ?"
      ).bind(owner).first();
      base = s?.site_base_url || '';
    } catch (e) { /* 欄位還沒建立 */ }
    if (!base) base = request.headers.get('Origin') || '';
    if (!base) return '';
    base = base.replace(/\/+$/, '');
    return `${base}/leave.html?share=${encodeURIComponent(u.share_id)}`;
  } catch (e) { return ''; }
}

// 依 guild_id 找出綁定的戰隊帳號（先查多伺服器表，再退回舊的單一欄位）
async function ownerByGuild(env, guildId) {
  if (!guildId) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT owner FROM discord_guilds WHERE guild_id = ?"
    ).bind(guildId).first();
    if (row?.owner) return row.owner;
  } catch (e) { /* discord_guilds 表還沒建立 */ }
  try {
    const row = await env.DB.prepare(
      "SELECT owner FROM user_settings WHERE discord_guild_id = ?"
    ).bind(guildId).first();
    return row?.owner || null;
  } catch (e) { return null; }
}

// 背景處理 slash 指令，算完用 interaction token 編輯先前的 deferred 訊息
async function respondToDiscordCommand(env, interaction) {
  let content = "（無內容）";
  try {
    const res = await handleDiscordCommand(env, interaction);
    content = res?.data?.content || content;
  } catch (e) {
    console.error("指令處理失敗", e);
    content = "查詢時發生錯誤，請稍後再試。";
  }
  try {
    await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
    });
  } catch (e) { console.error("Discord 回覆編輯失敗", e); }
}

// hex 字串 → Uint8Array
function hexToBytes(hex) {
  const clean = (hex || '').trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// 驗證 Discord interactions 的 Ed25519 簽章
async function verifyDiscordSig(publicKeyHex, signatureHex, timestamp, body) {
  if (!publicKeyHex || !signatureHex || !timestamp) return false;
  const msg = new TextEncoder().encode(timestamp + body);
  const keyBytes = hexToBytes(publicKeyHex);
  const sigBytes = hexToBytes(signatureHex);
  for (const alg of [{ name: 'Ed25519' }, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }]) {
    try {
      const key = await crypto.subtle.importKey('raw', keyBytes, alg, false, ['verify']);
      return await crypto.subtle.verify(alg.name === 'Ed25519' ? { name: 'Ed25519' } : { name: 'NODE-ED25519' }, key, sigBytes, msg);
    } catch (e) { /* 換下一個演算法名稱再試 */ }
  }
  return false;
}

// 處理 slash 指令，回傳 Discord interaction response
async function handleDiscordCommand(env, interaction) {
  const reply = (content) => ({ type: 4, data: { content, allowed_mentions: { parse: [] } } });
  const guildId = interaction.guild_id;
  if (!guildId) return reply("請在伺服器頻道內使用這個指令。");
  const owner = await ownerByGuild(env, guildId);
  if (!owner) return reply("這個 Discord 伺服器還沒綁定戰隊帳號。請管理員到後台『Discord 設定』填入此伺服器 ID 並儲存。");

  const cmd = interaction.data?.name || '';
  const opts = interaction.data?.options || [];
  const getOpt = (n) => opts.find(o => o.name === n)?.value;

  const members = Object.values(await computeMemberStats(env, owner));
  if (members.length === 0) return reply("名冊目前沒有成員資料。");

  if (cmd === '查詢') {
    const q = String(getOpt('名字') || '').trim();
    if (!q) return reply("請輸入要查詢的名字。");
    const m = members.find(x => x.display_name === q) || members.find(x => x.display_name.includes(q));
    if (!m) return reply(`找不到「${q}」，請確認名字是否正確。`);
    const total = m.attendance + m.leave + m.reserve;
    const rate = total > 0 ? Math.round(m.attendance / total * 100) : 0;
    return reply(`📊 **${m.display_name}**（${m.job || '未知'}）\n出席 **${m.attendance}**　請假 **${m.leave}**　後備 **${m.reserve}**　出席率約 **${rate}%**${m.hasOverride ? '\n（含管理員手動調整）' : ''}`);
  }

  if (cmd === '出勤榜') {
    const top = [...members].sort((a, b) => b.attendance - a.attendance).slice(0, 10);
    const lines = top.map((m, i) => `${i + 1}. ${m.display_name}　出席 ${m.attendance}／請假 ${m.leave}／後備 ${m.reserve}`);
    return reply("🏆 **出勤榜（前 10）**\n" + lines.join("\n"));
  }

  if (cmd === '請假名單') {
    const dateOpt = String(getOpt('日期') || '').trim();
    // 找開放中的場次（可用日期過濾）
    let wins;
    try {
      ({ results: wins } = await env.DB.prepare(
        "SELECT window_id, event_date, session, title, match_type FROM leave_windows WHERE owner = ? AND status = 'open' ORDER BY event_date DESC, session ASC"
      ).bind(owner).all());
    } catch (e) {
      ({ results: wins } = await env.DB.prepare(
        "SELECT window_id, event_date, session, title FROM leave_windows WHERE owner = ? AND status = 'open' ORDER BY event_date DESC, session ASC"
      ).bind(owner).all());
    }
    wins = (wins || []).filter(w => !dateOpt || w.event_date === dateOpt);
    if (wins.length === 0) return reply(dateOpt ? `${dateOpt} 沒有開放中的場次。` : "目前沒有開放中的場次。");

    const idToName = {};
    members.forEach(m => { idToName[m.member_id] = m.display_name; });
    const stats = await computeLeaveStats(env, owner);
    const blocks = wins.map(w => {
      const wb = stats.byWindow[w.window_id] || { leave: [], reserve: [] };
      const leaveNames = [...new Set(wb.leave)].map(id => idToName[id] || id.slice(0, 6));
      const reserveNames = [...new Set(wb.reserve)].map(id => idToName[id] || id.slice(0, 6));
      const typeLabel = w.match_type === '其他' ? '領地戰' : (w.match_type || '幫戰');
      let s = `📅 **${w.event_date}　${w.session}　[${typeLabel}]**${w.title ? ' · ' + w.title : ''}\n🙋 請假（${leaveNames.length}）：${leaveNames.length ? leaveNames.join('、') : '無'}`;
      if (reserveNames.length) s += `\n🔄 後備（${reserveNames.length}）：${reserveNames.join('、')}`;
      return s;
    });
    let out = blocks.join("\n\n");
    if (out.length > 1900) out = out.slice(0, 1900) + "\n…（名單過長已截斷）";
    return reply(out);
  }

  return reply("未知指令。可用：/查詢 名字、/出勤榜、/請假名單");
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
  async fetch(request, env, ctx) {
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
      // 🤖 Discord Bot：互動端點（Discord 以 Ed25519 簽章驗證，不走 Bearer）
      // =========================
      if (url.pathname === "/api/discord/interactions" && request.method === "POST") {
        const sig = request.headers.get("X-Signature-Ed25519");
        const ts = request.headers.get("X-Signature-Timestamp");
        const rawBody = await request.text();
        const ok = await verifyDiscordSig(env.DISCORD_PUBLIC_KEY, sig, ts, rawBody);
        if (!ok) return new Response("invalid request signature", { status: 401 });
        let interaction;
        try { interaction = JSON.parse(rawBody); } catch (e) { return new Response("bad json", { status: 400 }); }
        if (interaction.type === 1) return json({ type: 1 }); // PING → PONG
        if (interaction.type === 2) {
          // 查詢要掃資料庫，可能超過 Discord 的 3 秒限制 → 先回 deferred（type 5）ACK，
          // 背景把資料算完再用 interaction token 編輯訊息，徹底避免「應用程式未回應」
          if (ctx && ctx.waitUntil) {
            ctx.waitUntil(respondToDiscordCommand(env, interaction));
            return json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
          }
          // 極少數環境沒有 ctx → 退回同步回覆（可能有逾時風險）
          return json(await handleDiscordCommand(env, interaction));
        }
        return json({ type: 4, data: { content: "未支援的互動類型" } });
      }

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
        const loadMembers = async (owr) => {
          try {
            const { results } = await env.DB.prepare(
              "SELECT id, last_job, note, version FROM members WHERE owner = ?"
            ).bind(owr).all();
            return results || [];
          } catch (e) {
            // version 欄位還沒建立（migration 008 未跑）
            const { results } = await env.DB.prepare(
              "SELECT id, last_job, note FROM members WHERE owner = ?"
            ).bind(owr).all();
            return results || [];
          }
        };
        if (isShareMode) {
          const owner = await getShareOwner();
          if (!owner) return json([]);
          return json(await loadMembers(owner));
        }
        requireAuth();
        return json(await loadMembers(user));
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
        const loadAliasRoster = async (owner) => {
          const { results: aliases } = await env.DB.prepare(
            "SELECT alias_name, member_id FROM member_aliases WHERE owner = ?"
          ).bind(owner).all();
          let roster;
          try {
            ({ results: roster } = await env.DB.prepare(
              "SELECT member_id, display_name, job, category FROM members_roster WHERE owner = ? AND status = 'active'"
            ).bind(owner).all());
          } catch (e) {
            ({ results: roster } = await env.DB.prepare(
              "SELECT member_id, display_name FROM members_roster WHERE owner = ? AND status = 'active'"
            ).bind(owner).all());
          }
          return { aliases: aliases || [], roster: roster || [] };
        };
        if (isShareMode) {
          const owner = await getShareOwner();
          if (!owner) return json({ aliases: [], roster: [] });
          return json(await loadAliasRoster(owner));
        }
        requireAuth();
        await ensureRosterBackfilled(env, user);
        return json(await loadAliasRoster(user));
      }

      // =========================
      // 👤 名冊（roster）：列表 / 新增 / 刪除 / 陌生名字確認
      // =========================
      if (url.pathname === "/api/roster" && request.method === "GET") {
        requireAuth();
        await ensureRosterBackfilled(env, user);
        let results;
        try {
          ({ results } = await env.DB.prepare(
            "SELECT member_id, display_name, status, job, category FROM members_roster WHERE owner = ? AND status = 'active' ORDER BY display_name"
          ).bind(user).all());
        } catch (e) {
          ({ results } = await env.DB.prepare(
            "SELECT member_id, display_name, status FROM members_roster WHERE owner = ? AND status = 'active' ORDER BY display_name"
          ).bind(user).all());
        }
        return json(results || []);
      }

      // 設定成員身份類別（主幫/副幫/俱樂部/自訂）
      if (url.pathname === "/api/roster/category" && request.method === "POST") {
        requireAuth();
        const { member_id, category } = await request.json();
        if (!member_id) return json({ error: "參數錯誤" }, 400);
        try {
          await env.DB.prepare(
            "UPDATE members_roster SET category=?, updated_at=? WHERE member_id=? AND owner=?"
          ).bind(category || null, Date.now(), member_id, user).run();
        } catch (e) {
          return json({ error: "category 欄位尚未建立，請先執行 migration 006" }, 500);
        }
        await writeAudit(env, user, user, 'roster', member_id, 'set_category', { category: category || '' });
        return json({ status: "OK" });
      }

      if (url.pathname === "/api/roster/add" && request.method === "POST") {
        requireAuth();
        const { display_name, job } = await request.json();
        if (!display_name) return json({ error: "名稱不能為空" }, 400);
        const exist = await env.DB.prepare(
          "SELECT member_id FROM members_roster WHERE owner = ? AND display_name = ?"
        ).bind(user, display_name).first();
        if (exist) return json({ error: "名稱已存在" }, 400);
        const memberId = crypto.randomUUID();
        const now = Date.now();
        try {
          await env.DB.prepare(
            "INSERT INTO members_roster (member_id, owner, display_name, status, version, created_at, updated_at, job) VALUES (?, ?, ?, 'active', 1, ?, ?, ?)"
          ).bind(memberId, user, display_name, now, now, job || null).run();
        } catch (e) {
          // 舊 DB 無 job 欄位時退回不含 job 的寫法
          await env.DB.prepare(
            "INSERT INTO members_roster (member_id, owner, display_name, status, version, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?)"
          ).bind(memberId, user, display_name, now, now).run();
        }
        await env.DB.prepare(
          "INSERT INTO member_aliases (alias_name, owner, member_id, created_at) VALUES (?, ?, ?, ?)"
        ).bind(display_name, user, memberId, now).run();
        await writeAudit(env, user, user, 'roster', memberId, 'create', { display_name, job: job || '' });
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
        const { member_id, overrides, note, expected_version } = b;
        if (!member_id) return json({ error: "參數錯誤" }, 400);
        const now = Date.now();
        const cur = await env.DB.prepare(
          "SELECT version FROM stat_overrides WHERE member_id = ? AND owner = ?"
        ).bind(member_id, user).first();

        // overrides = { 幫戰:{attendance,leave,reserve}, 約戰:{...}, 其他:{...} }，空值＝用自動
        const norm = (v) => (v === '' || v === null || v === undefined) ? null : Number(v);
        const cleaned = {};
        ['幫戰', '約戰', '其他'].forEach(t => {
          const o = (overrides && overrides[t]) ? overrides[t] : {};
          const a = norm(o.attendance), l = norm(o.leave), r = norm(o.reserve);
          if (a != null || l != null || r != null) cleaned[t] = { attendance: a, leave: l, reserve: r };
        });
        const ovJson = Object.keys(cleaned).length ? JSON.stringify(cleaned) : null;

        if (!cur) {
          try {
            await env.DB.prepare(
              "INSERT INTO stat_overrides (member_id, owner, note, overrides_json, version, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?)"
            ).bind(member_id, user, note || null, ovJson, now, user).run();
          } catch (e) {
            return json({ error: "overrides_json 欄位尚未建立，請先執行 migration 006" }, 500);
          }
          await writeAudit(env, user, user, 'override', member_id, 'create', { overrides: cleaned });
          return json({ status: "OK", version: 1 });
        }
        if (typeof expected_version === 'number' && expected_version !== cur.version) {
          return json({ error: "資料已被其他人更新，請重新整理後再改", current_version: cur.version }, 409);
        }
        const res = await env.DB.prepare(
          "UPDATE stat_overrides SET note=?, overrides_json=?, attendance_override=NULL, leave_override=NULL, reserve_override=NULL, version=version+1, updated_at=?, updated_by=? WHERE member_id=? AND owner=? AND version=?"
        ).bind(note || null, ovJson, now, user, member_id, user, cur.version).run();
        if (!res.meta || res.meta.changes === 0) {
          return json({ error: "資料已被其他人更新，請重新整理後再改", current_version: cur.version }, 409);
        }
        await writeAudit(env, user, user, 'override', member_id, 'update', { overrides: cleaned });
        return json({ status: "OK", version: cur.version + 1 });
      }

      // =========================
      // 🔢 讀取所有人工覆蓋（share 唯讀 / 登入）
      // =========================
      if (url.pathname === "/api/overrides") {
        let owner = user;
        if (isShareMode) owner = await getShareOwner();
        if (!owner) return json([]);
        let results;
        try {
          ({ results } = await env.DB.prepare(
            "SELECT member_id, attendance_override, leave_override, reserve_override, note, version, overrides_json FROM stat_overrides WHERE owner = ?"
          ).bind(owner).all());
        } catch (e) {
          ({ results } = await env.DB.prepare(
            "SELECT member_id, attendance_override, leave_override, reserve_override, note, version FROM stat_overrides WHERE owner = ?"
          ).bind(owner).all());
        }
        return json(results || []);
      }

      // =========================
      // 🗓️ 請假場次：列表（含每場請假/後備人數）
      // =========================
      if (url.pathname === "/api/leave/windows" && request.method === "GET") {
        let owner = user;
        if (isShareMode) owner = await getShareOwner();
        if (!owner) return json([]);
        let results;
        try {
          ({ results } = await env.DB.prepare(
            "SELECT window_id, event_date, session, title, status, version, created_at, match_type FROM leave_windows WHERE owner = ? ORDER BY event_date DESC, session ASC"
          ).bind(owner).all());
        } catch (e) {
          ({ results } = await env.DB.prepare(
            "SELECT window_id, event_date, session, title, status, version, created_at FROM leave_windows WHERE owner = ? ORDER BY event_date DESC, session ASC"
          ).bind(owner).all());
        }
        const stats = await computeLeaveStats(env, owner);
        const list = (results || []).map(w => ({
          ...w,
          match_type: w.match_type || '幫戰',
          leave_count: (stats.byWindow[w.window_id]?.leave || []).length,
          reserve_count: (stats.byWindow[w.window_id]?.reserve || []).length
        }));
        return json(list);
      }

      // 建立請假場次（日期+第幾場，唯一）
      if (url.pathname === "/api/leave/windows/create" && request.method === "POST") {
        requireAuth();
        const { event_date, session, title, match_type } = await request.json();
        if (!event_date || !session) return json({ error: "請選擇日期與場次" }, 400);
        const mtype = match_type || '幫戰';
        // 重複判定＝日期＋場次＋類型（幫戰/約戰/領地戰各自獨立，可同日同場次分別開）
        let dup;
        try {
          dup = await env.DB.prepare(
            "SELECT window_id, status FROM leave_windows WHERE owner = ? AND event_date = ? AND session = ? AND COALESCE(match_type, '幫戰') = ?"
          ).bind(user, event_date, session, mtype).first();
        } catch (e) {
          // match_type 欄位尚未建立（migration 004 未跑）→ 退回舊的日期＋場次判定
          dup = await env.DB.prepare(
            "SELECT window_id, status FROM leave_windows WHERE owner = ? AND event_date = ? AND session = ?"
          ).bind(user, event_date, session).first();
        }
        if (dup) return json({ error: "這個日期＋場次＋類型已經開過請假了", existing_window_id: dup.window_id, existing_status: dup.status }, 409);
        const windowId = crypto.randomUUID();
        const now = Date.now();
        try {
          await env.DB.prepare(
            "INSERT INTO leave_windows (window_id, owner, event_date, session, title, status, version, created_at, updated_at, match_type) VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?, ?)"
          ).bind(windowId, user, event_date, session, title || "", now, now, mtype).run();
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (/no such column/i.test(msg)) {
            // match_type 欄位尚未建立（migration 004 還沒跑）→ 退回不含類型
            await env.DB.prepare(
              "INSERT INTO leave_windows (window_id, owner, event_date, session, title, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?)"
            ).bind(windowId, user, event_date, session, title || "", now, now).run();
          } else if (/UNIQUE|constraint/i.test(msg)) {
            // 舊的唯一索引還鎖在 (owner,date,session)，尚未套用 migration 009
            return json({ error: "這個日期＋場次已經開過請假了。若要同日同場次分開幫戰／約戰／領地戰，請先在資料庫執行 migration 009。", existing_status: 'open' }, 409);
          } else {
            throw e;
          }
        }
        const typeLabel = mtype === '其他' ? '領地戰' : mtype;
        await writeAudit(env, user, user, 'leave_window', windowId, 'create', { event_date, session, title, match_type: mtype });
        const leaveUrl = await buildLeaveUrl(env, user, request);
        const longUrl = leaveUrl ? leaveUrl + '#long' : '';
        let leaveDesc = `**${event_date}　${session}　[${typeLabel}]**${title ? "\n" + title : ""}`;
        if (leaveUrl) {
          leaveDesc += `\n\n① ${event_date} 請假開放，有需要自行申請：\n${leaveUrl}`;
          leaveDesc += `\n\n② 長期/預先請假（如需於非開放時段請假請用此連結）：\n${longUrl}`;
          leaveDesc += `\n\n③ 有問題請找當家/管理處理`;
        } else {
          leaveDesc += `\n請到請假連結登記。`;
        }
        leaveDesc += `\n\n🤖 也可直接用機器人指令查詢：\n\`/查詢 名字\`　\`/出勤榜\`　\`/請假名單\``;
        await notifyDiscord(env, user, 'leave_open', {
          embed: { title: "🗓️ 已開放請假", description: leaveDesc, color: 3447003 }
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
        const allowed = ['leave_request', 'leave_cancel', 'reserve_set', 'reserve_unset',
          'noshow_set', 'noshow_unset', 'late_set', 'late_unset', 'attend_set', 'attend_unset'];
        if (!window_id || !member_id || !allowed.includes(action)) return json({ error: "參數錯誤" }, 400);
        const win = await env.DB.prepare("SELECT window_id FROM leave_windows WHERE window_id = ? AND owner = ?").bind(window_id, user).first();
        if (!win) return json({ error: "找不到場次" }, 404);
        await env.DB.prepare(
          "INSERT INTO leave_actions (action_id, window_id, owner, member_id, action, actor, actor_meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), window_id, user, member_id, action, user, JSON.stringify({ by: 'admin' }), Date.now()).run();
        await writeAudit(env, user, user, 'leave_action', window_id, action, { member_id });

        // 連續 No-show 警示：從最近的場次往前數，連續 No-show ≥ 2 就發 Discord
        if (action === 'noshow_set') {
          const { results: wins } = await env.DB.prepare(
            "SELECT window_id FROM leave_windows WHERE owner = ? ORDER BY event_date DESC, session DESC"
          ).bind(user).all();
          const { results: acts } = await env.DB.prepare(
            "SELECT window_id, action FROM leave_actions WHERE owner = ? AND member_id = ? AND action IN ('noshow_set','noshow_unset') ORDER BY created_at ASC"
          ).bind(user, member_id).all();
          const nsState = {};
          for (const a of acts || []) nsState[a.window_id] = (a.action === 'noshow_set');
          let streak = 0;
          for (const w of wins || []) {
            if (nsState[w.window_id]) streak++; else break;
          }
          if (streak >= 2) {
            const mem = await env.DB.prepare(
              "SELECT display_name FROM members_roster WHERE member_id = ? AND owner = ?"
            ).bind(member_id, user).first();
            await notifyDiscord(env, user, 'noshow', {
              content: "@here",
              embed: {
                title: "⚠️ 連續 No-show 警示",
                description: `**${mem?.display_name || member_id}** 已連續 **${streak}** 場 No-show，請幹部關注。`,
                color: 15158332
              }
            });
          }
        }
        return json({ status: "OK" });
      }

      // 單一場次目前的請假/後備/No-show/臨時請假名單（管理員用）
      if (url.pathname === "/api/leave/window-members" && request.method === "GET") {
        requireAuth();
        const windowId = url.searchParams.get("window_id");
        if (!windowId) return json({ error: "參數錯誤" }, 400);
        const { results } = await env.DB.prepare(
          "SELECT member_id, action, created_at FROM leave_actions WHERE owner = ? AND window_id = ? ORDER BY created_at ASC"
        ).bind(user, windowId).all();
        const st = { leave: {}, reserve: {}, noshow: {}, late: {}, attend: {} };
        for (const a of results || []) {
          if (a.action === 'leave_request') st.leave[a.member_id] = true;
          else if (a.action === 'leave_cancel') st.leave[a.member_id] = false;
          else if (a.action === 'reserve_set') st.reserve[a.member_id] = true;
          else if (a.action === 'reserve_unset') st.reserve[a.member_id] = false;
          else if (a.action === 'noshow_set') st.noshow[a.member_id] = true;
          else if (a.action === 'noshow_unset') st.noshow[a.member_id] = false;
          else if (a.action === 'late_set') st.late[a.member_id] = true;
          else if (a.action === 'late_unset') st.late[a.member_id] = false;
          else if (a.action === 'attend_set') st.attend[a.member_id] = true;
          else if (a.action === 'attend_unset') st.attend[a.member_id] = false;
        }
        // 長期請假涵蓋此場 → 也視為請假（單場明確取消優先）
        const longSet = new Set();
        try {
          const win = await env.DB.prepare("SELECT event_date FROM leave_windows WHERE window_id = ? AND owner = ?").bind(windowId, user).first();
          if (win?.event_date) {
            const { results: lls } = await env.DB.prepare(
              "SELECT member_id FROM long_leaves WHERE owner = ? AND from_date <= ? AND to_date >= ?"
            ).bind(user, win.event_date, win.event_date).all();
            (lls || []).forEach(l => {
              if (st.leave[l.member_id] === false) return; // 該場明確取消過 → 尊重
              st.leave[l.member_id] = true;
              longSet.add(l.member_id);
            });
          }
        } catch (e) { /* long_leaves 表還沒建立 */ }
        const collect = (o) => Object.keys(o).filter(k => o[k]);
        // 代替上號對照（本人 → 代打者）
        let substitutes = {};
        try {
          const { results: subs } = await env.DB.prepare(
            "SELECT member_id, substitute_member_id FROM leave_substitutes WHERE owner = ? AND window_id = ?"
          ).bind(user, windowId).all();
          (subs || []).forEach(s => { substitutes[s.member_id] = s.substitute_member_id; });
        } catch (e) { substitutes = {}; }
        return json({ leave: collect(st.leave), reserve: collect(st.reserve), noshow: collect(st.noshow), late: collect(st.late), attend: collect(st.attend), substitutes, long: [...longSet] });
      }

      // 長期/預先請假：管理員列表
      if (url.pathname === "/api/leave/long" && request.method === "GET") {
        requireAuth();
        let rows = [];
        try {
          ({ results: rows } = await env.DB.prepare(
            "SELECT id, member_id, from_date, to_date, reason, created_at, created_by FROM long_leaves WHERE owner = ? ORDER BY from_date DESC"
          ).bind(user).all());
        } catch (e) { rows = []; }
        // 補上名字
        const nameMap = {};
        try {
          const { results: r } = await env.DB.prepare("SELECT member_id, display_name FROM members_roster WHERE owner = ?").bind(user).all();
          (r || []).forEach(x => { nameMap[x.member_id] = x.display_name; });
        } catch (e) { }
        return json((rows || []).map(x => ({ ...x, display_name: nameMap[x.member_id] || x.member_id })));
      }

      // 長期/預先請假：管理員新增
      if (url.pathname === "/api/leave/long/create" && request.method === "POST") {
        requireAuth();
        const { member_id, from_date, to_date, reason } = await request.json();
        if (!member_id || !from_date || !to_date) return json({ error: "請填成員與起訖日期" }, 400);
        if (from_date > to_date) return json({ error: "起始日不能晚於結束日" }, 400);
        await env.DB.prepare(
          "INSERT INTO long_leaves (id, owner, member_id, from_date, to_date, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), user, member_id, from_date, to_date, reason || '', Date.now(), user).run();
        await writeAudit(env, user, user, 'long_leave', member_id, 'create', { from_date, to_date });
        return json({ status: "OK" });
      }

      // 長期/預先請假：管理員刪除
      if (url.pathname === "/api/leave/long/delete" && request.method === "POST") {
        requireAuth();
        const { id } = await request.json();
        if (!id) return json({ error: "參數錯誤" }, 400);
        await env.DB.prepare("DELETE FROM long_leaves WHERE owner = ? AND id = ?").bind(user, id).run();
        await writeAudit(env, user, user, 'long_leave', id, 'delete', {});
        return json({ status: "OK" });
      }

      // 🌐 公開頁：成員自助送出長期/預先請假
      if (url.pathname === "/api/leave/public/long" && request.method === "POST") {
        if (!shareId) return json({ error: "缺少 share" }, 400);
        const owner = await getShareOwner();
        if (!owner) return json({ error: "連結無效" }, 404);
        const { member_id, from_date, to_date, reason } = await request.json();
        if (!member_id || !from_date || !to_date) return json({ error: "請填名字與起訖日期" }, 400);
        if (from_date > to_date) return json({ error: "起始日不能晚於結束日" }, 400);
        const mem = await env.DB.prepare(
          "SELECT display_name FROM members_roster WHERE member_id = ? AND owner = ? AND status = 'active'"
        ).bind(member_id, owner).first();
        if (!mem) return json({ error: "找不到這個名字，請確認或聯絡管理員" }, 404);
        // 粗略限流
        const since = Date.now() - 5000;
        const recent = await env.DB.prepare(
          "SELECT COUNT(*) c FROM audit_log WHERE owner = ? AND actor = 'public' AND created_at > ?"
        ).bind(owner, since).first();
        if ((recent?.c || 0) > 30) return json({ error: "操作太頻繁，請稍後再試" }, 429);
        await env.DB.prepare(
          "INSERT INTO long_leaves (id, owner, member_id, from_date, to_date, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'public')"
        ).bind(crypto.randomUUID(), owner, member_id, from_date, to_date, reason || '', Date.now()).run();
        await writeAudit(env, owner, 'public', 'long_leave', member_id, 'create', { from_date, to_date });
        await notifyDiscord(env, owner, 'leave_submit', {
          embed: { title: "📅 長期/預先請假", description: `**${mem.display_name}**　${from_date} ~ ${to_date}${reason ? "\n" + reason : ""}`, color: 10181046 }
        });
        return json({ status: "OK" });
      }

      // 🎖️ 出戰班表：列表
      if (url.pathname === "/api/lineups" && request.method === "GET") {
        requireAuth();
        let results = [];
        try {
          ({ results } = await env.DB.prepare(
            "SELECT id, title, window_id, data_json, updated_at FROM lineups WHERE owner = ? ORDER BY updated_at DESC"
          ).bind(user).all());
        } catch (e) { results = []; }
        return json((results || []).map(r => ({
          id: r.id, title: r.title || '', window_id: r.window_id || '', updated_at: r.updated_at,
          groups: (() => { try { return JSON.parse(r.data_json) || []; } catch (e) { return []; } })()
        })));
      }
      // 出戰班表：儲存（新增/更新）
      if (url.pathname === "/api/lineups/save" && request.method === "POST") {
        requireAuth();
        const { id, title, window_id, groups } = await request.json();
        const gjson = JSON.stringify(Array.isArray(groups) ? groups : []);
        const now = Date.now();
        if (id) {
          const r = await env.DB.prepare(
            "UPDATE lineups SET title=?, window_id=?, data_json=?, updated_at=? WHERE id=? AND owner=?"
          ).bind(title || '', window_id || '', gjson, now, id, user).run();
          if (r.meta && r.meta.changes > 0) return json({ status: "OK", id });
        }
        const newId = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO lineups (id, owner, title, window_id, data_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(newId, user, title || '', window_id || '', gjson, now).run();
        return json({ status: "OK", id: newId });
      }
      // 出戰班表：刪除
      if (url.pathname === "/api/lineups/delete" && request.method === "POST") {
        requireAuth();
        const { id } = await request.json();
        if (!id) return json({ error: "參數錯誤" }, 400);
        await env.DB.prepare("DELETE FROM lineups WHERE owner = ? AND id = ?").bind(user, id).run();
        return json({ status: "OK" });
      }

      // 代替上號：設定 / 取消（管理員用）
      if (url.pathname === "/api/leave/substitute" && request.method === "POST") {
        requireAuth();
        const { window_id, member_id, substitute_member_id } = await request.json();
        if (!window_id || !member_id) return json({ error: "參數錯誤" }, 400);
        const win = await env.DB.prepare("SELECT window_id FROM leave_windows WHERE window_id = ? AND owner = ?").bind(window_id, user).first();
        if (!win) return json({ error: "找不到場次" }, 404);
        const now = Date.now();
        if (!substitute_member_id) {
          // 取消代替上號
          await env.DB.prepare("DELETE FROM leave_substitutes WHERE owner = ? AND window_id = ? AND member_id = ?").bind(user, window_id, member_id).run();
          await writeAudit(env, user, user, 'leave_substitute', window_id, 'unset', { member_id });
          return json({ status: "OK" });
        }
        if (substitute_member_id === member_id) return json({ error: "代打者不能是本人" }, 400);
        // 設定代替上號（本人 → 代打者），並確保本人在這場記為「請假」，出席才不會誤算
        await env.DB.prepare(
          "INSERT INTO leave_substitutes (window_id, owner, member_id, substitute_member_id, created_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(window_id, owner, member_id) DO UPDATE SET substitute_member_id = excluded.substitute_member_id, created_at = excluded.created_at"
        ).bind(window_id, user, member_id, substitute_member_id, now).run();
        await env.DB.prepare(
          "INSERT INTO leave_actions (action_id, window_id, owner, member_id, action, actor, actor_meta, created_at) VALUES (?, ?, ?, ?, 'leave_request', ?, ?, ?)"
        ).bind(crypto.randomUUID(), window_id, user, member_id, user, JSON.stringify({ by: 'admin', via: 'substitute' }), now).run();
        await writeAudit(env, user, user, 'leave_substitute', window_id, 'set', { member_id, substitute_member_id });
        return json({ status: "OK" });
      }

      // 手動補登出席清單（含場次日期/場次/類型，供前端出席計算）
      if (url.pathname === "/api/leave/attendance" && request.method === "GET") {
        let owner = user;
        if (isShareMode) owner = await getShareOwner();
        if (!owner) return json([]);
        let out = [];
        try {
          const { results: winRows } = await env.DB.prepare(
            "SELECT window_id, event_date, session, match_type FROM leave_windows WHERE owner = ?"
          ).bind(owner).all();
          const winInfo = {}; (winRows || []).forEach(w => { winInfo[w.window_id] = w; });
          const { results: acts } = await env.DB.prepare(
            "SELECT window_id, member_id, action FROM leave_actions WHERE owner = ? AND action IN ('attend_set','attend_unset') ORDER BY created_at ASC"
          ).bind(owner).all();
          const state = {};
          for (const a of acts || []) state[a.window_id + '|' + a.member_id] = (a.action === 'attend_set');
          for (const k in state) {
            if (!state[k]) continue;
            const idx = k.lastIndexOf('|');
            const w = winInfo[k.slice(0, idx)];
            if (!w) continue;
            out.push({ member_id: k.slice(idx + 1), date: w.event_date, session: w.session, type: w.match_type || '幫戰' });
          }
        } catch (e) { out = []; }
        return json(out);
      }

      // 代替上號清單（含場次日期/場次/類型，供前端出席計算重導）
      if (url.pathname === "/api/leave/substitutes" && request.method === "GET") {
        let owner = user;
        if (isShareMode) owner = await getShareOwner();
        if (!owner) return json([]);
        let out = [];
        try {
          const { results } = await env.DB.prepare(
            "SELECT ls.member_id, ls.substitute_member_id, w.event_date, w.session, w.match_type " +
            "FROM leave_substitutes ls JOIN leave_windows w ON ls.window_id = w.window_id AND ls.owner = w.owner " +
            "WHERE ls.owner = ?"
          ).bind(owner).all();
          out = (results || []).map(r => ({
            member_id: r.member_id, substitute_member_id: r.substitute_member_id,
            date: r.event_date, session: r.session, type: r.match_type || '幫戰'
          }));
        } catch (e) { out = []; }
        return json(out);
      }

      // 某成員的 No-show / 臨時請假 紀錄（含日期，僅管理員；唯讀分享不提供）
      // 某成員完整的 請假／臨時／代打／長期請假 記錄（管理員；成員檔案用）
      if (url.pathname === "/api/leave/member-history" && request.method === "GET") {
        requireAuth();
        const memberId = url.searchParams.get("member_id");
        if (!memberId) return json([]);
        let wins = [];
        try { ({ results: wins } = await env.DB.prepare("SELECT window_id, event_date, session, match_type FROM leave_windows WHERE owner = ?").bind(user).all()); } catch (e) { wins = []; }
        const winMap = {}; (wins || []).forEach(w => { winMap[w.window_id] = w; });
        const nameMap = {};
        try { const { results: r } = await env.DB.prepare("SELECT member_id, display_name FROM members_roster WHERE owner = ?").bind(user).all(); (r || []).forEach(x => { nameMap[x.member_id] = x.display_name; }); } catch (e) { }
        const { results: acts } = await env.DB.prepare(
          "SELECT window_id, action FROM leave_actions WHERE owner = ? AND member_id = ? ORDER BY created_at ASC"
        ).bind(user, memberId).all();
        const leaveSt = {}, lateSt = {};
        for (const a of acts || []) {
          if (a.action === 'leave_request') leaveSt[a.window_id] = true;
          else if (a.action === 'leave_cancel') leaveSt[a.window_id] = false;
          else if (a.action === 'late_set') lateSt[a.window_id] = true;
          else if (a.action === 'late_unset') lateSt[a.window_id] = false;
        }
        const out = [];
        const push = (w, kind, extra) => { if (w) out.push({ kind, date: w.event_date, session: w.session, type: w.match_type || '幫戰', ...(extra || {}) }); };
        for (const wid in leaveSt) if (leaveSt[wid]) push(winMap[wid], 'leave');
        for (const wid in lateSt) if (lateSt[wid]) push(winMap[wid], 'late');
        try {
          const { results: subOut } = await env.DB.prepare("SELECT window_id, substitute_member_id FROM leave_substitutes WHERE owner = ? AND member_id = ?").bind(user, memberId).all();
          (subOut || []).forEach(s => push(winMap[s.window_id], 'covered_by', { other: nameMap[s.substitute_member_id] || '' }));
          const { results: subIn } = await env.DB.prepare("SELECT window_id, member_id FROM leave_substitutes WHERE owner = ? AND substitute_member_id = ?").bind(user, memberId).all();
          (subIn || []).forEach(s => push(winMap[s.window_id], 'covered_for', { other: nameMap[s.member_id] || '' }));
        } catch (e) { }
        try {
          const { results: lls } = await env.DB.prepare("SELECT from_date, to_date, reason FROM long_leaves WHERE owner = ? AND member_id = ?").bind(user, memberId).all();
          (lls || []).forEach(l => out.push({ kind: 'long', from: l.from_date, to: l.to_date, reason: l.reason || '', date: l.from_date }));
        } catch (e) { }
        out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        return json(out);
      }

      if (url.pathname === "/api/leave/member-flags" && request.method === "GET") {
        requireAuth();
        const memberId = url.searchParams.get("member_id");
        if (!memberId) return json([]);
        const { results } = await env.DB.prepare(
          "SELECT window_id, action, created_at FROM leave_actions WHERE owner = ? AND member_id = ? AND action IN ('noshow_set','noshow_unset','late_set','late_unset') ORDER BY created_at ASC"
        ).bind(user, memberId).all();
        const noshow = {}, late = {};
        for (const a of results || []) {
          if (a.action === 'noshow_set') noshow[a.window_id] = true;
          else if (a.action === 'noshow_unset') noshow[a.window_id] = false;
          else if (a.action === 'late_set') late[a.window_id] = true;
          else if (a.action === 'late_unset') late[a.window_id] = false;
        }
        const winIds = [...new Set([...Object.keys(noshow), ...Object.keys(late)])].filter(w => noshow[w] || late[w]);
        if (!winIds.length) return json([]);
        const ph = winIds.map(() => "?").join(",");
        const { results: wins } = await env.DB.prepare(
          `SELECT window_id, event_date, session FROM leave_windows WHERE owner = ? AND window_id IN (${ph})`
        ).bind(user, ...winIds).all();
        const winMap = {};
        (wins || []).forEach(w => { winMap[w.window_id] = w; });
        const out = [];
        winIds.forEach(w => {
          const wi = winMap[w];
          if (!wi) return;
          if (noshow[w]) out.push({ date: wi.event_date, session: wi.session, type: 'noshow' });
          if (late[w]) out.push({ date: wi.event_date, session: wi.session, type: 'late' });
        });
        out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        return json(out);
      }

      // 每個成員的請假/後備次數（share 唯讀 / 登入）
      if (url.pathname === "/api/leave/stats") {
        let owner = user;
        if (isShareMode) owner = await getShareOwner();
        if (!owner) return json({});
        const fromDate = url.searchParams.get("from") || null;
        const toDate = url.searchParams.get("to") || null;
        const stats = await computeLeaveStats(env, owner, fromDate, toDate);
        return json(stats.byMember);
      }

      // =========================
      // 🌐 請假看板（share=公開唯讀只看開放中場次 / 登入=管理員看全部場次）
      //     含每個成員的 職業 + 出席/請假/後備 統計，供依職業分類顯示
      // =========================
      if (url.pathname === "/api/leave/board" || url.pathname === "/api/leave/public/board") {
        let owner = user;
        let openOnly = false;
        if (isShareMode) { owner = await getShareOwner(); openOnly = true; }
        if (!owner) return json({ guild: "", windows: [], members: [], roster: [], leaveByWindow: {}, reserveByWindow: {} });

        const openClause = openOnly ? " AND status = 'open'" : "";
        let windows;
        try {
          ({ results: windows } = await env.DB.prepare(
            "SELECT window_id, event_date, session, title, status, match_type FROM leave_windows WHERE owner = ?" + openClause + " ORDER BY event_date DESC, session ASC"
          ).bind(owner).all());
        } catch (e) {
          ({ results: windows } = await env.DB.prepare(
            "SELECT window_id, event_date, session, title, status FROM leave_windows WHERE owner = ?" + openClause + " ORDER BY event_date DESC, session ASC"
          ).bind(owner).all());
        }
        (windows || []).forEach(w => { if (!w.match_type) w.match_type = '幫戰'; });

        const stats = await computeLeaveStats(env, owner);
        const membersMap = await computeMemberStats(env, owner);
        const members = Object.values(membersMap).sort((a, b) => a.display_name.localeCompare(b.display_name));

        const leaveByWindow = {}, reserveByWindow = {};
        (windows || []).forEach(w => {
          leaveByWindow[w.window_id] = stats.byWindow[w.window_id]?.leave || [];
          reserveByWindow[w.window_id] = stats.byWindow[w.window_id]?.reserve || [];
        });
        const u = await env.DB.prepare("SELECT guild FROM users WHERE username = ?").bind(owner).first();
        // roster 欄位保留給舊版前端相容（只含 member_id + display_name）
        const roster = members.map(m => ({ member_id: m.member_id, display_name: m.display_name }));
        return json({ guild: u?.guild || "", windows: windows || [], members, roster, leaveByWindow, reserveByWindow });
      }

      // =========================
      // 🌐 公開請假頁：自助建檔（找不到名字時，免登入輸入名字＋職業）
      //     建立為「新成員」；若其實是改名，管理員之後可用「合併」歸戶
      // =========================
      if (url.pathname === "/api/leave/public/join" && request.method === "POST") {
        if (!shareId) return json({ error: "缺少 share" }, 400);
        const owner = await getShareOwner();
        if (!owner) return json({ error: "連結無效" }, 404);
        const { name, job } = await request.json();
        const nm = (name || "").trim();
        if (!nm) return json({ error: "請輸入名字" }, 400);
        if (nm.length > 20) return json({ error: "名字太長" }, 400);

        // 粗略限流
        const since = Date.now() - 5000;
        const recent = await env.DB.prepare(
          "SELECT COUNT(*) c FROM audit_log WHERE owner = ? AND actor = 'public' AND created_at > ?"
        ).bind(owner, since).first();
        if ((recent?.c || 0) > 30) return json({ error: "操作太頻繁，請稍後再試" }, 429);

        // 已存在 → 直接回傳，讓他找到自己就好（不重複建）
        const exist = await env.DB.prepare(
          "SELECT member_id FROM members_roster WHERE owner = ? AND display_name = ? AND status = 'active'"
        ).bind(owner, nm).first();
        if (exist) return json({ status: "OK", member_id: exist.member_id, existed: true });

        const memberId = crypto.randomUUID();
        const now = Date.now();
        try {
          await env.DB.prepare(
            "INSERT INTO members_roster (member_id, owner, display_name, status, version, created_at, updated_at, job) VALUES (?, ?, ?, 'active', 1, ?, ?, ?)"
          ).bind(memberId, owner, nm, now, now, job || null).run();
        } catch (e) {
          await env.DB.prepare(
            "INSERT INTO members_roster (member_id, owner, display_name, status, version, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?)"
          ).bind(memberId, owner, nm, now, now).run();
        }
        await env.DB.prepare(
          "INSERT INTO member_aliases (alias_name, owner, member_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(alias_name, owner) DO NOTHING"
        ).bind(nm, owner, memberId, now).run();
        await writeAudit(env, owner, 'public', 'roster', memberId, 'self_join', { display_name: nm, job: job || '' });
        await notifyDiscord(env, owner, 'self_join', {
          embed: { title: "🆕 自助建檔", description: `**${nm}**${job ? " · " + job : ""}`, color: 3066993 }
        });
        return json({ status: "OK", member_id: memberId });
      }

      // 🌐 公開頁：成員自助改名
      if (url.pathname === "/api/leave/public/rename" && request.method === "POST") {
        if (!shareId) return json({ error: "缺少 share" }, 400);
        const owner = await getShareOwner();
        if (!owner) return json({ error: "連結無效" }, 404);
        const { member_id, new_name } = await request.json();
        const nm = (new_name || "").trim();
        if (!member_id || !nm) return json({ error: "請填新名字" }, 400);
        if (nm.length > 20) return json({ error: "名字太長" }, 400);
        // 粗略限流
        const since = Date.now() - 5000;
        const recent = await env.DB.prepare(
          "SELECT COUNT(*) c FROM audit_log WHERE owner = ? AND actor = 'public' AND created_at > ?"
        ).bind(owner, since).first();
        if ((recent?.c || 0) > 30) return json({ error: "操作太頻繁，請稍後再試" }, 429);
        const mem = await env.DB.prepare(
          "SELECT display_name FROM members_roster WHERE member_id = ? AND owner = ? AND status = 'active'"
        ).bind(member_id, owner).first();
        if (!mem) return json({ error: "找不到成員" }, 404);
        if (mem.display_name === nm) return json({ status: "OK" });
        const clash = await env.DB.prepare(
          "SELECT member_id FROM members_roster WHERE owner = ? AND display_name = ? AND member_id <> ?"
        ).bind(owner, nm, member_id).first();
        if (clash) return json({ error: "這個名字已經有人用了" }, 400);
        const now = Date.now();
        await env.DB.prepare(
          "UPDATE members_roster SET display_name = ?, updated_at = ?, version = version + 1 WHERE member_id = ? AND owner = ?"
        ).bind(nm, now, member_id, owner).run();
        // 新名字加入 alias（未來戰報用新名字也能歸戶）；舊名字 alias 保留讓舊戰報仍歸戶
        await env.DB.prepare(
          "INSERT INTO member_aliases (alias_name, owner, member_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(alias_name, owner) DO NOTHING"
        ).bind(nm, owner, member_id, now).run();
        await writeAudit(env, owner, 'public', 'roster', member_id, 'self_rename', { from: mem.display_name, to: nm });
        return json({ status: "OK", member_id });
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
        await notifyDiscord(env, owner, 'leave_submit', {
          embed: {
            title: verb,
            description: `**${mem.display_name}**`,
            color: action === 'leave_request' ? 15158332 : 9807270
          }
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
        let row;
        try {
          row = await env.DB.prepare(
            "SELECT discord_webhook_url, discord_guild_id, site_base_url FROM user_settings WHERE owner = ?"
          ).bind(user).first();
        } catch (e) {
          // site_base_url 欄位還沒建立（migration 007 未跑）
          row = await env.DB.prepare(
            "SELECT discord_webhook_url, discord_guild_id FROM user_settings WHERE owner = ?"
          ).bind(user).first();
        }
        let guild_ids = [];
        try {
          const { results } = await env.DB.prepare(
            "SELECT guild_id FROM discord_guilds WHERE owner = ? ORDER BY created_at ASC"
          ).bind(user).all();
          guild_ids = (results || []).map(r => r.guild_id).filter(Boolean);
        } catch (e) { guild_ids = []; }
        // 舊資料相容：只在單一欄位設過 → 帶進 guild_ids
        if (guild_ids.length === 0 && row?.discord_guild_id) guild_ids = [row.discord_guild_id];
        return json(Object.assign({ discord_webhook_url: "", discord_guild_id: "", site_base_url: "" }, row || {}, { guild_ids }));
      }
      if (url.pathname === "/api/settings/discord" && request.method === "POST") {
        requireAuth();
        const body = await request.json();
        const { webhook_url, site_base_url } = body;
        // 支援多伺服器：guild_ids 陣列；相容舊的單一 guild_id
        let guildIds = Array.isArray(body.guild_ids) ? body.guild_ids : (body.guild_id ? [body.guild_id] : []);
        guildIds = [...new Set(guildIds.map(g => String(g).trim()).filter(Boolean))];
        const primaryGuild = guildIds[0] || '';
        // user_settings：primary guild 供向後相容
        try {
          await env.DB.prepare(
            "INSERT INTO user_settings (owner, discord_webhook_url, discord_guild_id, site_base_url, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner) DO UPDATE SET discord_webhook_url = excluded.discord_webhook_url, discord_guild_id = excluded.discord_guild_id, site_base_url = excluded.site_base_url, updated_at = excluded.updated_at"
          ).bind(user, webhook_url || "", primaryGuild, site_base_url || "", Date.now()).run();
        } catch (e) {
          // 舊 schema 無 site_base_url
          await env.DB.prepare(
            "INSERT INTO user_settings (owner, discord_webhook_url, discord_guild_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner) DO UPDATE SET discord_webhook_url = excluded.discord_webhook_url, discord_guild_id = excluded.discord_guild_id, updated_at = excluded.updated_at"
          ).bind(user, webhook_url || "", primaryGuild, Date.now()).run();
        }
        // discord_guilds：整份覆寫
        try {
          await env.DB.prepare("DELETE FROM discord_guilds WHERE owner = ?").bind(user).run();
          const now = Date.now();
          for (const g of guildIds) {
            await env.DB.prepare(
              "INSERT INTO discord_guilds (owner, guild_id, created_at) VALUES (?, ?, ?) ON CONFLICT(owner, guild_id) DO NOTHING"
            ).bind(user, g, now).run();
          }
        } catch (e) { /* discord_guilds 表還沒建立（migration 008 未跑）→ 僅用單一欄位 */ }
        await writeAudit(env, user, user, 'session', '', 'discord_settings', { guilds: guildIds.length });
        return json({ status: "OK" });
      }

      // 🤖 多頻道：讀取 / 覆寫整份頻道清單
      if (url.pathname === "/api/settings/channels" && request.method === "GET") {
        requireAuth();
        let results = [];
        try {
          ({ results } = await env.DB.prepare(
            "SELECT id, name, webhook_url, events, mention_role_id, enabled FROM discord_channels WHERE owner = ? ORDER BY created_at ASC"
          ).bind(user).all());
        } catch (e) { results = []; }
        const channels = (results || []).map(c => ({
          id: c.id, name: c.name || '', webhook_url: c.webhook_url || '',
          events: (() => { try { return c.events ? JSON.parse(c.events) : []; } catch (e) { return []; } })(),
          mention_role_id: c.mention_role_id || '', enabled: !!c.enabled
        }));
        return json({ channels });
      }
      if (url.pathname === "/api/settings/channels" && request.method === "POST") {
        requireAuth();
        const { channels } = await request.json();
        if (!Array.isArray(channels)) return json({ error: "格式錯誤" }, 400);
        const now = Date.now();
        await env.DB.prepare("DELETE FROM discord_channels WHERE owner = ?").bind(user).run();
        for (const c of channels) {
          const events = Array.isArray(c.events) ? c.events.filter(e => DISCORD_EVENT_KEYS.includes(e)) : [];
          await env.DB.prepare(
            "INSERT INTO discord_channels (id, owner, name, webhook_url, events, mention_role_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(crypto.randomUUID(), user, (c.name || '').slice(0, 40), c.webhook_url || '', JSON.stringify(events), (c.mention_role_id || '').replace(/\D/g, ''), c.enabled ? 1 : 0, now, now).run();
        }
        await writeAudit(env, user, user, 'session', '', 'discord_channels', { count: channels.length });
        return json({ status: "OK" });
      }

      // 🤖 Bot：註冊 slash 指令（綁定的每個 guild 各註冊一次＝即時生效；沒綁定則全域）
      if (url.pathname === "/api/discord/register-commands" && request.method === "POST") {
        requireAuth();
        if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_APP_ID) {
          return json({ error: "後端尚未設定 DISCORD_BOT_TOKEN / DISCORD_APP_ID 環境變數" }, 400);
        }
        let guildIds = [];
        try {
          const { results } = await env.DB.prepare(
            "SELECT guild_id FROM discord_guilds WHERE owner = ?"
          ).bind(user).all();
          guildIds = (results || []).map(r => r.guild_id).filter(Boolean);
        } catch (e) { guildIds = []; }
        if (guildIds.length === 0) {
          const s = await env.DB.prepare("SELECT discord_guild_id FROM user_settings WHERE owner = ?").bind(user).first();
          if (s?.discord_guild_id) guildIds = [s.discord_guild_id];
        }
        const commands = [
          { name: "查詢", description: "查詢某位成員的出席／請假／後備次數", options: [{ name: "名字", description: "成員名字", type: 3, required: true }] },
          { name: "出勤榜", description: "顯示出勤前 10 名" },
          { name: "請假名單", description: "顯示目前開放場次的請假／後備名單", options: [{ name: "日期", description: "只看某天 YYYY-MM-DD（選填）", type: 3, required: false }] }
        ];
        const put = async (endpoint) => {
          const res = await fetch(endpoint, {
            method: "PUT",
            headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(commands)
          });
          const data = await res.json().catch(() => ({}));
          return { ok: res.ok, status: res.status, count: Array.isArray(data) ? data.length : 0, detail: data };
        };
        if (guildIds.length === 0) {
          const r = await put(`https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}/commands`);
          if (!r.ok) return json({ error: "註冊失敗", status: r.status, detail: r.detail }, 500);
          return json({ status: "OK", scope: "global", guilds: 0, registered: r.count });
        }
        let okCount = 0, lastErr = null;
        for (const g of guildIds) {
          const r = await put(`https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}/guilds/${g}/commands`);
          if (r.ok) okCount++; else lastErr = r;
        }
        if (okCount === 0 && lastErr) return json({ error: "註冊失敗", status: lastErr.status, detail: lastErr.detail }, 500);
        return json({ status: "OK", scope: "guild", guilds: okCount, registered: commands.length });
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
        const { id, note, expected_version } = await request.json();
        const legacyUpsert = async () => {
          await env.DB.prepare(`
            INSERT INTO members (id, last_job, matches, total_dmg, note, owner)
            VALUES (?, '', 0, 0, ?, ?)
            ON CONFLICT(id, owner) DO UPDATE SET note = excluded.note
          `).bind(id, note, user).run();
        };
        try {
          const cur = await env.DB.prepare(
            "SELECT version FROM members WHERE id = ? AND owner = ?"
          ).bind(id, user).first();
          if (!cur) {
            // 尚無此列 → 建立（version = 1）
            await env.DB.prepare(`
              INSERT INTO members (id, last_job, matches, total_dmg, note, owner, version)
              VALUES (?, '', 0, 0, ?, ?, 1)
              ON CONFLICT(id, owner) DO UPDATE SET note = excluded.note, version = COALESCE(members.version, 0) + 1
            `).bind(id, note, user).run();
            const nv = await env.DB.prepare("SELECT version FROM members WHERE id = ? AND owner = ?").bind(id, user).first();
            return json({ status: "OK", version: nv?.version ?? 1 });
          }
          // 樂觀鎖：帶了版本又對不上 → 擋下，避免覆蓋別人的修改
          if (typeof expected_version === 'number' && typeof cur.version === 'number' && expected_version !== cur.version) {
            return json({ error: "此成員檔案已被其他人更新，請重新整理後再改", current_version: cur.version }, 409);
          }
          const upd = await env.DB.prepare(
            "UPDATE members SET note = ?, version = COALESCE(version, 0) + 1 WHERE id = ? AND owner = ? AND COALESCE(version, 0) = ?"
          ).bind(note, id, user, cur.version ?? 0).run();
          if (upd.meta && upd.meta.changes === 0) {
            const now2 = await env.DB.prepare("SELECT version FROM members WHERE id = ? AND owner = ?").bind(id, user).first();
            return json({ error: "此成員檔案已被其他人更新，請重新整理後再改", current_version: now2?.version }, 409);
          }
          return json({ status: "OK", version: (cur.version ?? 0) + 1 });
        } catch (e) {
          // version 欄位還沒建立（migration 008 未跑）→ 退回原本行為
          await legacyUpsert();
          return json({ status: "OK" });
        }
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
