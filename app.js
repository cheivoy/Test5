// =====================================================
// ===  全域設定與常數
// =====================================================
const WORKER_URL = "https://d1-template.cherrycywong0907.workers.dev";

const metrics = [
    { l: '人頭汪', k: 'kill' }, { l: '傷害汪', k: 'pDmg' }, { l: '拆家哈士奇', k: 'bDmg' },
    { l: '媽媽', k: 'heal' }, { l: '快樂助攻', k: 'assist' }, { l: '化羽大帝', k: 'spring' },
    { l: '對啦我最會抗', k: 'takeDmg' }, { l: '頂級黑奴', k: 'resource' }, { l: '起來重睡', k: 'death' }
];
const cols = [
    { l: '玩家', k: 'name' }, { l: '職業', k: 'job' }, { l: '擊敗', k: 'kill' }, { l: '助攻', k: 'assist' },
    { l: '資源', k: 'resource' }, { l: '人傷', k: 'pDmg' }, { l: '塔傷', k: 'bDmg' }, { l: '治療', k: 'heal' },
    { l: '承傷', k: 'takeDmg' }, { l: '重傷', k: 'death' }, { l: '化羽/清泉', k: 'spring' }, { l: '焚骨', k: 'bone' }
];

let gA = [], gB = [], full = [], nameA = "", nameB = "", focusPlayer = null;
let chart = null, memberChart = null, currentJobFilter = "all";
let allHistories = [], dbMembersMap = [], dbSort = { key: 'matches', asc: false };
let totalReportsInTimeframe = 0, currentReportId = null;

// ✅ 身分系統：name -> member_id -> 目前顯示名稱（改名不用重寫歷史戰報）
let aliasToMemberId = {}, memberIdToDisplayName = {}, memberIdToJob = {};
let subMapByWin = {}; // 代替上號：`日期|場次|類型` -> { 本人member_id: 代打者member_id }
let memberIdToCategory = {};
const CATEGORY_PRESETS = ['主幫', '副幫', '俱樂部'];
const JOB_LIST = ['碎夢', '神相', '血河', '九靈', '玄機', '龍吟', '鐵衣', '素問', '潮光'];

// 對戰類型顯示：內部值仍用「其他」（相容舊資料），顯示一律為「領地戰」
function fmtType(t) { return t === '其他' ? '領地戰' : (t || '幫戰'); }
const TYPE_ORDER = ['幫戰', '約戰', '其他'];

// =====================================================
// ===  模式管理（本地 / 雲端）
// =====================================================
let storageMode = 'local';
let currentUser = null;

const LOCALSTORAGE_HISTORIES_KEY = 'nsh_local_histories';
const LOCALSTORAGE_MEMBERS_KEY = 'nsh_local_members';
const LOCALSTORAGE_USER_KEY = 'nsh_current_user';

function getLocalHistories() {
    try { return JSON.parse(localStorage.getItem(LOCALSTORAGE_HISTORIES_KEY) || '[]'); } catch (e) { return []; }
}
function saveLocalHistories(arr) {
    localStorage.setItem(LOCALSTORAGE_HISTORIES_KEY, JSON.stringify(arr));
}
function getLocalMembers() {
    try { return JSON.parse(localStorage.getItem(LOCALSTORAGE_MEMBERS_KEY) || '{}'); } catch (e) { return {}; }
}
function saveLocalMembers(obj) {
    localStorage.setItem(LOCALSTORAGE_MEMBERS_KEY, JSON.stringify(obj));
}

function updateModeBanner() {
    const banner = document.getElementById('mode-banner');
    const authBtn = document.getElementById('auth-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const syncBtn = document.getElementById('sync-btn');
    const memberSyncBtn = document.getElementById('member-sync-btn');
    const rosterCheckBtn = document.getElementById('roster-check-btn');
    const addMemberBtn = document.getElementById('add-member-btn');
    const sessionsBtn = document.getElementById('sessions-btn');
    const shareNote = document.getElementById('share-local-note');

    if (storageMode === 'cloud' && currentUser) {
        if (banner) { banner.className = 'cloud'; banner.textContent = `☁️ 雲端模式 — ${currentUser.username}（${currentUser.guild || ''}）`; }
        if (authBtn) authBtn.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = '';
        if (syncBtn && !isViewMode) syncBtn.style.display = '';
        if (memberSyncBtn && !isViewMode) memberSyncBtn.style.display = '';
        if (rosterCheckBtn && !isViewMode) rosterCheckBtn.style.display = '';
        if (addMemberBtn && !isViewMode) addMemberBtn.style.display = '';
        if (sessionsBtn && !isViewMode) sessionsBtn.style.display = '';
        if (shareNote) shareNote.style.display = 'none';
    } else {
        if (banner) { banner.className = 'local'; banner.textContent = '💾 本地模式（未登入）'; }
        if (authBtn) authBtn.style.display = '';
        if (logoutBtn) logoutBtn.style.display = 'none';
        if (syncBtn) syncBtn.style.display = 'none';
        if (memberSyncBtn) memberSyncBtn.style.display = 'none';
        if (rosterCheckBtn) rosterCheckBtn.style.display = 'none';
        if (addMemberBtn) addMemberBtn.style.display = 'none';
        if (sessionsBtn) sessionsBtn.style.display = 'none';
        if (shareNote) shareNote.style.display = '';
    }
}

// =====================================================
// ===  Auth UI
// =====================================================
function openAuthModal() {
    document.getElementById('auth-modal').style.display = 'flex';
    document.getElementById('auth-msg').textContent = '';
    showAuthTab('login');
}

function showAuthTab(tab) {
    document.getElementById('auth-form-login').style.display = tab === 'login' ? '' : 'none';
    document.getElementById('auth-form-register').style.display = tab === 'register' ? '' : 'none';
    document.getElementById('auth-form-change').style.display = tab === 'change' ? '' : 'none';
    document.getElementById('tab-login').className = tab === 'login' ? 'btn btn-primary' : 'btn btn-outline';
    document.getElementById('tab-register').className = tab === 'register' ? 'btn btn-primary' : 'btn btn-outline';
}

async function doRegister() {
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value.trim();
    const guild = document.getElementById('reg-guild').value.trim();
    const msgEl = document.getElementById('auth-msg');
    if (!username || !password) { msgEl.textContent = '帳號和密碼不能為空'; return; }
    try {
        const res = await fetch(WORKER_URL + "/api/auth/register", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, guild }) // ✅ guild 現在正確傳遞
        });
        const data = await res.json();
        if (!res.ok) { msgEl.textContent = data.error || '註冊失敗'; return; }
        msgEl.style.color = 'green';
        msgEl.textContent = '註冊成功！請登入。';
        showAuthTab('login');
    } catch (e) { msgEl.textContent = '連線失敗: ' + e.message; }
}

async function doChangePassword() {
    const username = document.getElementById('change-username').value.trim();
    const guild = document.getElementById('change-guild').value.trim();
    const newPassword = document.getElementById('change-newpassword').value.trim();
    const msgEl = document.getElementById('auth-msg');
    if (!username || !guild || !newPassword) { msgEl.textContent = '所有欄位不能為空'; return; }
    try {
        const res = await fetch(WORKER_URL + "/api/change-password", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, guild, newPassword })
        });
        const data = await res.json();
        if (!res.ok) { msgEl.textContent = data.error; return; }
        msgEl.style.color = 'green';
        msgEl.textContent = '密碼修改成功！請重新登入。';
        showAuthTab('login');
    } catch (e) { msgEl.textContent = '連線失敗: ' + e.message; }
}

async function doLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value.trim();
    const msgEl = document.getElementById('auth-msg');
    if (!username || !password) { msgEl.textContent = '帳號和密碼不能為空'; return; }
    try {
        const res = await fetch(WORKER_URL + "/api/auth/login", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) { msgEl.textContent = data.error || '登入失敗'; return; }
        currentUser = { username: data.username, token: data.token, guild: data.guild, share_id: data.share_id };
        localStorage.setItem(LOCALSTORAGE_USER_KEY, JSON.stringify(currentUser));
        storageMode = 'cloud';
        closeModal('auth-modal');
        updateModeBanner();
        const localHists = getLocalHistories();
        if (localHists.length > 0) {
            if (confirm(`⚠️ 偵測到本地有 ${localHists.length} 場戰報尚未同步！\n是否立即同步到雲端？\n（取消可稍後手動點「☁️ 同步到雲端」）`)) {
                await syncLocalToCloud();
            }
        }
        await fetchAllHistories();
        if (document.getElementById('page-db').style.display !== 'none') loadDbData();
    } catch (e) { msgEl.textContent = '連線失敗: ' + e.message; }
}

async function logoutUser() {
    // 只登出「這台裝置」，其他裝置的登入不受影響
    if (currentUser?.token) {
        try {
            await fetch(WORKER_URL + "/api/auth/logout", {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + currentUser.token }
            });
        } catch (e) { }
    }
    currentUser = null;
    storageMode = 'local';
    localStorage.removeItem(LOCALSTORAGE_USER_KEY);
    updateModeBanner();
    fetchAllHistories();
}

// =====================================================
// ===  登入裝置管理（多重登入）
// =====================================================
async function openSessionsModal() {
    if (!currentUser) return;
    document.getElementById('sessions-modal').style.display = 'flex';
    const listEl = document.getElementById('sessions-list');
    listEl.innerHTML = '<div style="color:#aaa; font-size:13px;">載入中…</div>';
    try {
        const res = await fetch(WORKER_URL + "/api/auth/sessions?t=" + Date.now(), {
            cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        const list = await res.json();
        if (!Array.isArray(list) || list.length === 0) {
            listEl.innerHTML = '<div style="color:#aaa; font-size:13px;">目前沒有其他登入紀錄（可能是舊版登入，重新登入後就會顯示）。</div>';
            return;
        }
        listEl.innerHTML = list.map(s => {
            const when = new Date(s.last_seen_at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
            return `<div class="roster-row">
                <div style="font-size:13px;">
                    ${s.is_current ? '🟢 <b>目前這台</b>' : '💻 其他裝置'}<br>
                    <span style="font-size:11px; color:#97a0ad;">${(s.device_label || '未知裝置').slice(0, 40)} · 最近 ${when}</span>
                </div>
                ${s.is_current ? '' : `<button class="btn btn-outline" style="font-size:12px; padding:4px 10px; color:var(--danger);" onclick="revokeSession('${s.id}')">踢除</button>`}
            </div>`;
        }).join('');
    } catch (e) {
        listEl.innerHTML = '<div style="color:var(--danger); font-size:13px;">載入失敗：' + e.message + '</div>';
    }
}

async function revokeSession(sessionId) {
    if (!confirm('確定要踢除這台裝置的登入？')) return;
    try {
        await fetch(WORKER_URL + "/api/auth/revoke-session", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ session_id: sessionId })
        });
        openSessionsModal();
    } catch (e) { alert('踢除失敗：' + e.message); }
}

// =====================================================
// ===  折疊板塊
// =====================================================
function toggleSection(id) {
    const body = document.getElementById(id);
    const icon = document.getElementById('icon-' + id);
    if (!body) return;
    const isCollapsed = body.classList.contains('collapsed');
    if (isCollapsed) {
        body.style.maxHeight = body.scrollHeight + 'px';
        body.classList.remove('collapsed');
        if (icon) icon.classList.remove('collapsed');
    } else {
        body.style.maxHeight = body.scrollHeight + 'px';
        requestAnimationFrame(() => {
            body.style.maxHeight = body.scrollHeight + 'px';
            requestAnimationFrame(() => {
                body.classList.add('collapsed');
                body.style.maxHeight = '';
                if (icon) icon.classList.add('collapsed');
            });
        });
    }
}

function initSections() {
    ['sec-mvp-a', 'sec-table-a', 'sec-mvp-b', 'sec-table-b'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.maxHeight = 'none';
    });
}

// =====================================================
// ===  URL 參數 / View Mode
// =====================================================
const urlParams = new URLSearchParams(window.location.search);
const isViewMode = urlParams.get('mode') === 'view';
const shareId = urlParams.get('share');

// =====================================================
// ===  初始化
// =====================================================
window.onload = async () => {
    const savedUser = localStorage.getItem(LOCALSTORAGE_USER_KEY);
    if (savedUser) {
        try { currentUser = JSON.parse(savedUser); storageMode = 'cloud'; }
        catch (e) { currentUser = null; storageMode = 'local'; }
    }

    if (isViewMode) {
        document.querySelectorAll('.admin-only').forEach(el => el.remove());
        document.getElementById('m-note').readOnly = true;
        document.getElementById('mm-note').readOnly = true;
        document.getElementById('custom-title').readOnly = true;
        document.getElementById('sys-title').innerText = "NSH 查看模式";
        document.getElementById('mm-job-view').style.display = 'inline-block';
        document.getElementById('mm-tag-view').style.display = 'inline-block';
    }

    const matchDateEl = document.getElementById('match-date');
    if (matchDateEl) matchDateEl.valueAsDate = new Date();

    const thEl = document.getElementById('db-threshold');
    if (thEl) { const saved = localStorage.getItem('nsh_attendance_threshold'); if (saved) thEl.value = saved; }

    initTheme();
    updateModeBanner();
    initSections();
    layoutForViewport();
    switchPage('report'); // 初始化頂欄/分頁/FAB 狀態

    await fetchAllHistories();
    const reportId = urlParams.get('id');
    if (reportId) viewHistory(reportId);

    // ✅ 修復：改用 token 方式接收共享戰報
    const transferToken = urlParams.get('transfer');
    if (transferToken) {
        setTimeout(() => checkIncomingTransfer(transferToken), 800);
    }
};

// =====================================================
// ===  fetchAllHistories
// =====================================================
async function fetchAllHistories() {
    try {
        let apiUrl = WORKER_URL + "/api/histories?t=" + Date.now();

        if (shareId) {
            apiUrl += "&share=" + shareId;
            const res = await fetch(apiUrl, { cache: "no-store" });
            let data = await res.json();
            const idsParam = urlParams.get('ids');
            if (idsParam) {
                const allowed = new Set(idsParam.split(','));
                data = data.filter(h => allowed.has(h.id));
            }
            allHistories = data;
        } else if (storageMode === 'cloud' && currentUser) {
            const res = await fetch(apiUrl, {
                cache: "no-store",
                headers: { 'Authorization': 'Bearer ' + currentUser.token }
            });
            allHistories = await res.json();
        } else {
            allHistories = getLocalHistories();
        }
        renderHistoryList();
    } catch (e) {
        console.error("獲取戰報失敗", e);
        allHistories = getLocalHistories();
        renderHistoryList();
    }
}

// =====================================================
// ===  防呆：重複上傳檢查
// =====================================================
function isDuplicateReport(date, guildA, session) {
    return allHistories.some(h => {
        let rawData = {};
        try { rawData = JSON.parse(h.raw_json || '{}'); } catch (e) { }
        return h.date === date && (h.guild_a || rawData.nameA || '') === guildA && (rawData.session || '第一場') === session;
    });
}

// =====================================================
// ===  saveHistory
// =====================================================
async function saveHistory() {
    // ✅ 修復：用更精確的 ID 避免同秒衝突
    const id = "rep_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    const mr = document.getElementById('match-result');
    const mt = document.getElementById('match-type');
    const ms = document.getElementById('match-session');
    const date = document.getElementById('match-date').value;
    const titleA = document.getElementById('custom-title').value;
    const session = ms ? ms.value : '第一場';

    if (isDuplicateReport(date, titleA, session)) {
        alert(`⚠️ 防呆提醒：\n「${titleA}」在 ${date} 的【${session}】已存在！\n請確認是否重複上傳，或選擇不同場次。`);
        return;
    }

    const payload = {
        id, fullDateTime: date, nameA: titleA, nameB,
        rawData: {
            nameA: titleA, nameB, gA, gB,
            result: mr ? mr.value : "win",
            matchType: mt ? mt.value : "幫戰",
            session
        }
    };

    if (storageMode === 'cloud' && currentUser) {
        const names = [...new Set(gA.map(p => p.name))];
        let unresolved = [];
        try {
            const res = await fetch(WORKER_URL + "/api/roster/check-names", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
                body: JSON.stringify({ names })
            });
            const data = await res.json();
            unresolved = data.unresolved || [];
        } catch (e) { console.error("檢查名冊失敗", e); }

        if (unresolved.length > 0) {
            openRosterResolveModal(unresolved, async () => { await saveHistoryToCloud(payload); });
            return;
        }
        await saveHistoryToCloud(payload);
    } else {
        saveHistoryToLocal(payload);
    }
}

// =====================================================
// ===  陌生名字確認 Modal：既有成員改名 / 全新成員
// =====================================================
async function openRosterResolveModal(names, onDone) {
    const existingModal = document.getElementById('roster-resolve-modal');
    if (existingModal) existingModal.remove();

    let roster = [];
    try {
        const res = await fetch(WORKER_URL + "/api/roster?t=" + Date.now(), {
            cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        roster = await res.json();
    } catch (e) { }

    // 名字→member_id 對照（供搜尋輸入框解析），與共用 datalist
    const nameToId = {};
    roster.forEach(m => { nameToId[m.display_name] = m.member_id; });
    window._rrNameToId = nameToId;
    const datalistOptions = roster.map(m => `<option value="${m.display_name}"></option>`).join('');

    const modal = document.createElement('div');
    modal.id = 'roster-resolve-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);display:flex;justify-content:center;align-items:center;z-index:2200;';
    modal.innerHTML = `
        <div style="background:white;padding:28px;border-radius:16px;width:560px;max-width:95vw;max-height:90vh;overflow-y:auto;display:flex;flex-direction:column;gap:12px;">
            <h3 style="margin:0;">🆕 發現 ${names.length} 個陌生名字</h3>
            <p style="font-size:13px;color:#666;margin:0;">請確認每個名字是既有成員改名，還是全新成員。確認後出席次數才會正確歸戶，歷史戰報資料不會被改寫。</p>
            <datalist id="rr-roster-datalist">${datalistOptions}</datalist>
            <div style="display:flex;gap:8px;">
                <button type="button" class="btn btn-outline" style="font-size:12px;" onclick="document.querySelectorAll('.roster-resolve-row .rr-new').forEach(r=>{r.checked=true; r.dispatchEvent(new Event('change'));})">全部視為新成員</button>
            </div>
            <div id="roster-resolve-list" style="display:flex;flex-direction:column;gap:10px;">
                ${names.map((n, i) => `
                    <div class="roster-resolve-row" data-name="${n}" style="border:1px solid #eee;border-radius:8px;padding:10px;">
                        <div style="font-weight:bold;margin-bottom:6px;">${n}</div>
                        <label style="margin-right:12px;font-size:13px;"><input type="radio" name="rr-choice-${i}" class="rr-new" checked onchange="updateRosterResolveRow(${i})"> 全新成員</label>
                        <label style="font-size:13px;"><input type="radio" name="rr-choice-${i}" class="rr-existing" onchange="updateRosterResolveRow(${i})"> 既有成員改名</label>
                        <div class="rr-existing-box" id="rr-existing-box-${i}" style="display:none;margin-top:8px;">
                            <input type="text" class="search-input rr-member-input" list="rr-roster-datalist" placeholder="🔍 輸入名字搜尋既有成員…" style="width:100%;margin-bottom:6px;box-sizing:border-box;" autocomplete="off">
                            <label style="font-size:12px;"><input type="checkbox" class="rr-set-current" checked> 設為此成員目前顯示名稱</label>
                        </div>
                    </div>
                `).join('')}
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button type="button" class="btn btn-outline" onclick="document.getElementById('roster-resolve-modal').remove();">取消（不儲存這場戰報）</button>
                <button type="button" class="btn btn-primary" onclick="confirmRosterResolve()">✅ 確認並繼續儲存</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    window._rosterResolveOnDone = onDone;
}

function updateRosterResolveRow(i) {
    const row = document.querySelectorAll('.roster-resolve-row')[i];
    const isExisting = row.querySelector('.rr-existing').checked;
    row.querySelector('.rr-existing-box').style.display = isExisting ? 'block' : 'none';
}

async function confirmRosterResolve() {
    const rows = document.querySelectorAll('.roster-resolve-row');
    for (const row of rows) {
        const name = row.dataset.name;
        const isExisting = row.querySelector('.rr-existing').checked;
        if (isExisting) {
            const typed = row.querySelector('.rr-member-input').value.trim();
            const memberId = (window._rrNameToId || {})[typed];
            if (!memberId) { alert(`「${name}」對應的既有成員「${typed || '（空白）'}」找不到，請從清單選一個正確名字，或改選「全新成員」`); return; }
            const setCurrent = row.querySelector('.rr-set-current').checked;
            await fetch(WORKER_URL + "/api/roster/resolve-name", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
                body: JSON.stringify({ alias_name: name, target: 'existing', member_id: memberId, set_as_current_name: setCurrent })
            });
        } else {
            await fetch(WORKER_URL + "/api/roster/resolve-name", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
                body: JSON.stringify({ alias_name: name, target: 'new' })
            });
        }
    }
    document.getElementById('roster-resolve-modal').remove();
    const onDone = window._rosterResolveOnDone;
    window._rosterResolveOnDone = null;
    if (onDone) await onDone();
}

// 名冊頁「待確認名單」：掃全部歷史戰報，補處理任何漏網的陌生名字
async function checkUnresolvedRoster() {
    if (storageMode !== 'cloud' || !currentUser) { alert('請先登入雲端帳號'); return; }
    try {
        const res = await fetch(WORKER_URL + "/api/roster/unresolved?t=" + Date.now(), {
            cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        const data = await res.json();
        const unresolved = data.unresolved || [];
        if (unresolved.length === 0) { alert('✅ 目前沒有待確認的陌生名字。'); return; }
        openRosterResolveModal(unresolved, async () => { await fetchRosterAliasMap(); await loadDbData(); });
    } catch (e) { alert('檢查失敗：' + e.message); }
}

function saveHistoryToLocal(payload) {
    const localHistories = getLocalHistories();
    const record = {
        id: payload.id, date: payload.fullDateTime,
        guild_a: payload.nameA, guild_b: payload.nameB,
        raw_json: JSON.stringify(payload.rawData), _source: 'local'
    };
    localHistories.unshift(record);
    saveLocalHistories(localHistories);

    const membersMap = getLocalMembers();
    payload.rawData.gA.forEach(p => {
        if (!membersMap[p.name]) {
            membersMap[p.name] = { id: p.name, last_job: p.job, matches: 0, total_dmg: 0, note: '' };
        }
        membersMap[p.name].matches++;
        membersMap[p.name].total_dmg = (membersMap[p.name].total_dmg || 0) + p.pDmg;
        membersMap[p.name].last_job = p.job;
    });
    saveLocalMembers(membersMap);

    alert("已保存至本地！若要分享，請登入帳號後同步到雲端。");
    currentReportId = payload.id;
    const shareSec = document.getElementById('share-section');
    if (shareSec) shareSec.style.display = 'block';
    closeModal('import-modal');
    showReportDetail();
    fetchAllHistories();
}

async function saveHistoryToCloud(payload) {
    try {
        const res = await fetch(WORKER_URL + "/api/save-history", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(await res.text());
        alert("已保存成功！");
        currentReportId = payload.id;
        const shareSec = document.getElementById('share-section');
        if (shareSec) shareSec.style.display = 'block';
        closeModal('import-modal');
        showReportDetail();
        await fetchAllHistories();
    } catch (e) { alert("儲存失敗: " + e.message); }
}

// =====================================================
// ===  同步本地到雲端
// =====================================================
async function syncLocalToCloud() {
    if (!currentUser) { alert('請先登入帳號'); return; }
    const localHistories = getLocalHistories();
    if (localHistories.length === 0) { alert('本地沒有可同步的戰報'); return; }

    let cloudHistories = [];
    try {
        const res = await fetch(WORKER_URL + "/api/histories?t=" + Date.now(), {
            cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        cloudHistories = await res.json();
    } catch (e) { }

    const conflicts = [], safe = [];
    localHistories.forEach(lh => {
        let lRaw = {};
        try { lRaw = JSON.parse(lh.raw_json || '{}'); } catch (e) { }
        const lDate = lh.date, lGuild = lh.guild_a || lRaw.nameA || '', lSession = lRaw.session || '第一場';
        const conflict = cloudHistories.some(ch => {
            let cRaw = {};
            try { cRaw = JSON.parse(ch.raw_json || '{}'); } catch (e) { }
            return ch.date === lDate && (ch.guild_a || cRaw.nameA || '') === lGuild && (cRaw.session || '第一場') === lSession;
        });
        if (conflict) conflicts.push(lh); else safe.push(lh);
    });

    const msgEl = document.getElementById('sync-confirm-msg');
    const listEl = document.getElementById('sync-conflict-list');
    let msg = `本地共 <b>${localHistories.length}</b> 場戰報，其中：<br>✅ <b>${safe.length}</b> 場可直接同步<br>`;
    if (conflicts.length > 0) msg += `⚠️ <b>${conflicts.length}</b> 場與雲端存在同幫會+同日期+同場次衝突，請確認是否覆蓋：`;
    msgEl.innerHTML = msg;
    if (conflicts.length > 0) {
        listEl.innerHTML = conflicts.map(h => {
            let r = {};
            try { r = JSON.parse(h.raw_json || '{}'); } catch (e) { }
            return `<div style="padding:4px; border-bottom:1px solid #eee;">${h.date} 【${r.session || '第一場'}】${h.guild_a}</div>`;
        }).join('');
    } else { listEl.innerHTML = ''; }

    window._pendingSyncData = { safe, conflicts, allLocal: localHistories };
    document.getElementById('sync-confirm-modal').style.display = 'flex';
}

async function confirmSync() {
    const { safe, conflicts, allLocal } = window._pendingSyncData || {};
    closeModal('sync-confirm-modal');
    if (!safe && !conflicts) return;
    const toSync = [...(safe || []), ...(conflicts || [])];
    let successCount = 0, failCount = 0;
    for (const lh of toSync) {
        let rawData = {};
        try { rawData = JSON.parse(lh.raw_json || '{}'); } catch (e) { }
        const payload = {
            id: lh.id, fullDateTime: lh.date,
            nameA: lh.guild_a || rawData.nameA, nameB: lh.guild_b || rawData.nameB, rawData
        };
        try {
            const res = await fetch(WORKER_URL + "/api/save-history", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
                body: JSON.stringify(payload)
            });
            if (res.ok) successCount++; else failCount++;
        } catch (e) { failCount++; }
    }
    const remaining = allLocal.filter(lh => !toSync.find(s => s.id === lh.id));
    saveLocalHistories(remaining);
    if (remaining.length === 0) saveLocalMembers({});
    storageMode = 'cloud';
    updateModeBanner();
    await fetchAllHistories();
    alert(`同步完成！成功 ${successCount} 場，失敗 ${failCount} 場。`);
}

// =====================================================
// ===  deleteHist
// =====================================================
async function deleteHist(e, id) {
    e.stopPropagation();
    if (!confirm("確定刪除？")) return;
    if (storageMode === 'cloud' && currentUser) {
        await fetch(WORKER_URL + "/api/delete-history", {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ id })
        });
    } else {
        const histories = getLocalHistories();
        const target = histories.find(h => h.id === id);
        if (target) {
            let rawData = {};
            try { rawData = JSON.parse(target.raw_json || '{}'); } catch (e) { }
            const membersMap = getLocalMembers();
            (rawData.gA || []).forEach(p => {
                if (membersMap[p.name]) {
                    membersMap[p.name].matches = Math.max(0, (membersMap[p.name].matches || 1) - 1);
                    membersMap[p.name].total_dmg = Math.max(0, (membersMap[p.name].total_dmg || 0) - p.pDmg);
                }
            });
            saveLocalMembers(membersMap);
            saveLocalHistories(histories.filter(h => h.id !== id));
        }
    }
    await fetchAllHistories();
    // ✅ 修復：刪除後如果成員頁開著，重新計算
    if (document.getElementById('page-db').style.display !== 'none') {
        await loadDbData();
    }
}

// =====================================================
// ===  CSV 導入
// =====================================================
function handleCSV(file) {
    if (!file) return;
    const fn = document.getElementById('import-filename');
    if (fn) fn.textContent = '📄 ' + file.name;
    const hint = document.getElementById('import-hint');
    if (hint) hint.style.display = 'none';
    const parts = file.name.replace('.csv', '').split('_');
    if (parts.length >= 4) {
        const d = parts[0];
        const matchDateEl = document.getElementById('match-date');
        if (matchDateEl) matchDateEl.value = `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
        nameA = parts[2]; nameB = parts[3];
        document.getElementById('custom-title').value = `${nameA} VS ${nameB}`;
    }
    const reader = new FileReader();
    reader.onload = e => {
        const lines = e.target.result.split('\n');
        let mode = 'A'; gA = []; gB = [];
        for (let i = 2; i < lines.length; i++) {
            const row = lines[i].trim();
            if (!row) { if (lines[i + 1]?.includes(',') || lines[i + 2]?.includes(',')) { mode = 'B'; i += 2; } continue; }
            const c = row.split(',').map(v => v.replace(/"/g, ''));
            if (c.length < 10) continue;
            const p = {
                name: c[0], job: c[1],
                kill: +c[2] || 0, assist: +c[3] || 0, resource: +c[4] || 0,
                pDmg: +c[5] || 0, bDmg: +c[6] || 0, heal: +c[7] || 0,
                takeDmg: +c[8] || 0, death: +c[9] || 0, spring: +c[10] || 0, bone: +c[11] || 0
            };
            if (mode === 'A') gA.push(p); else gB.push(p);
        }
        full = [...gA, ...gB];
        const saveBtn = document.getElementById('save-btn');
        if (saveBtn) saveBtn.style.display = 'block';
        renderFilterButtons(); renderReport();
    };
    reader.readAsText(file);
}

// =====================================================
// ===  歷史記錄日期範圍切換
// =====================================================
function onHistTimeChange() {
    const val = document.getElementById('hist-time').value;
    const rangeDiv = document.getElementById('hist-date-range');
    if (val === 'custom') {
        rangeDiv.classList.add('active');
        rangeDiv.style.display = 'flex';
    } else {
        rangeDiv.classList.remove('active');
        rangeDiv.style.display = 'none';
        renderHistoryList();
    }
}

// =====================================================
// ===  時間篩選工具（支援日期範圍）
// =====================================================
function isWithinFilter(dateStr, timeVal, fromDate, toDate) {
    if (timeVal === 'all') return true;
    const d = new Date(dateStr);
    if (timeVal === 'custom') {
        const from = fromDate ? new Date(fromDate) : null;
        const to = toDate ? new Date(toDate + 'T23:59:59') : null;
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
    }
    const diffTime = Math.abs(new Date() - d);
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) <= parseInt(timeVal);
}

// =====================================================
// ===  渲染歷史列表
// =====================================================
function renderHistoryList() {
    const search = document.getElementById('hist-search').value.toLowerCase();
    const timeFilter = document.getElementById('hist-time').value;
    const fromDate = document.getElementById('hist-date-from')?.value || '';
    const toDate = document.getElementById('hist-date-to')?.value || '';
    const winLoss = document.getElementById('hist-winloss').value;
    const typeFilter = document.getElementById('hist-type').value;

    const filtered = allHistories.filter(h => {
        let matchData = {};
        try { matchData = JSON.parse(h.raw_json); } catch (e) { }
        const matchSearch = h.guild_a.toLowerCase().includes(search) || (h.guild_b && h.guild_b.toLowerCase().includes(search));
        const matchTime = isWithinFilter(h.date, timeFilter, fromDate, toDate);
        const matchWL = (winLoss === 'all' || matchData.result === winLoss);
        const matchType = (typeFilter === 'all' || matchData.matchType === typeFilter);
        return matchSearch && matchTime && matchWL && matchType;
    });

    const sortVal = document.getElementById('hist-sort')?.value || 'date_desc';
    filtered.sort((a, b) => {
        if (sortVal === 'date_asc') return (a.date || '').localeCompare(b.date || '');
        if (sortVal === 'guild') return (a.guild_a || '').localeCompare(b.guild_a || '');
        return (b.date || '').localeCompare(a.date || ''); // date_desc 預設
    });

    document.getElementById('hist-items').innerHTML = filtered.map(h => {
        let resTag = '', typeLabel = '', sessionLabel = '', sourceBadge = '';
        try {
            const d = JSON.parse(h.raw_json);
            if (d.result === 'win') resTag = '<span class="result-tag win">勝</span>';
            if (d.result === 'loss') resTag = '<span class="result-tag loss">敗</span>';
            typeLabel = `<span style="font-size:10px; color:#999;">[${fmtType(d.matchType)}]</span>`;
            sessionLabel = d.session ? `<span style="font-size:10px; color:#666; margin-left:3px;">${d.session}</span>` : '';
        } catch (e) { }
        if (h._source === 'local') sourceBadge = ' <span class="local-badge">本地</span>';
        else if (storageMode === 'cloud') sourceBadge = ' <span class="cloud-badge">雲端</span>';
        return `<div class="hist-card" onclick="viewHistory('${h.id}')">
            ${!isViewMode ? `<button class="del-btn" onclick="deleteHist(event, '${h.id}')">×</button>` : ''}
            <div><b>${h.date}</b> ${typeLabel}${sessionLabel}${sourceBadge}<br>${h.guild_a}</div>
            <div>${resTag}</div>
        </div>`;
    }).join('');
}

// =====================================================
// ===  viewHistory
// =====================================================
async function viewHistory(id) {
    currentReportId = id;
    const h = allHistories.find(x => x.id === id);
    if (h) {
        let d;
        try { d = JSON.parse(h.raw_json); } catch (e) { alert('這筆戰報資料損毀，無法開啟'); return; }
        gA = Array.isArray(d.gA) ? d.gA : [];
        gB = Array.isArray(d.gB) ? d.gB : [];
        full = [...gA, ...gB];
        // 代替上號標示所需：目前戰報的場次鍵 + 對照表
        window._curRep = { date: h.date, session: d.session || '第一場', type: d.matchType || '幫戰' };
        if (!Object.keys(memberIdToDisplayName).length) { try { await fetchRosterAliasMap(); } catch (e) { } }
        if (!Object.keys(subMapByWin).length) { try { await loadSubMap(); } catch (e) { } }
        document.getElementById('display-title').innerText = d.nameA || h.guild_a;
        document.getElementById('name-b-title').innerText = d.nameB || '未知';
        const matchResultEl = document.getElementById('match-result');
        if (matchResultEl && d.result) matchResultEl.value = d.result;
        const customTitleEl = document.getElementById('custom-title');
        if (customTitleEl && d.nameA) customTitleEl.value = d.nameA;
        const matchTypeEl = document.getElementById('match-type');
        if (matchTypeEl && d.matchType) matchTypeEl.value = d.matchType;
        const matchSessionEl = document.getElementById('match-session');
        if (matchSessionEl && d.session) matchSessionEl.value = d.session;
        switchPage('report');
        renderFilterButtons();
        renderReport();
        showShareSection();
        showReportDetail();
    }
}

// =====================================================
// ===  渲染戰報
// =====================================================
function renderReport() {
    document.getElementById('report-view').style.display = 'block';
    initSections();
    renderMVPs('a', gA); renderMVPs('b', gB);
    const avg = full.reduce((a, b) => a + b.pDmg, 0) / (full.length || 1);
    const cr = window._curRep || {};
    const subForCur = subMapByWin[`${cr.date}|${cr.session}|${cr.type}`] || {};
    // 代打標示：我方(gA)某人這場被誰代打
    const subBadge = (p, t) => {
        if (t !== 'a') return '';
        const pid = aliasToMemberId[p.name];
        const bId = pid && subForCur[pid];
        if (!bId) return '';
        const bName = memberIdToDisplayName[bId] || '代打';
        return ` <span class="hash-tag" style="background:#5c6bc0; color:#fff;">🔄${bName}代打</span>`;
    };
    ['a', 'b'].forEach(t => {
        const data = (t === 'a' ? gA : gB).filter(p => currentJobFilter === 'all' || p.job === currentJobFilter);
        document.getElementById('th-' + t).innerHTML = cols.map(c => `<th onclick="sortBy('${t}', '${c.k}')">${c.l} ↕</th>`).join('');
        document.getElementById('tbody-' + t).innerHTML = data.map(p => `
            <tr onclick="openModal('${p.name}')" style="cursor:pointer;">
                <td>${p.name} ${p.pDmg > avg * 2.5 ? '🔥' : ''}${subBadge(p, t)}</td>
                <td><span class="job-tag" style="background:var(--color-${p.job})">${p.job}</span></td>
                ${cols.slice(2).map(c => `<td>${p[c.k] >= 10000 ? (p[c.k] / 10000).toFixed(1) + 'w' : p[c.k]}</td>`).join('')}
            </tr>`).join('');
        // 手機卡片版
        const cardsEl = document.getElementById('cards-' + t);
        if (cardsEl) {
            const fmt = v => v >= 10000 ? (v / 10000).toFixed(1) + 'w' : (v || 0);
            const statCols = cols.slice(2); // 全部數據欄位（擊敗…焚骨）
            cardsEl.innerHTML = data.map(p => `
                <div class="rcard" onclick="openModal('${p.name}')">
                    <div class="rcard-head">
                        <span class="rcard-dot" style="background:var(--color-${p.job})"></span>
                        <span class="rcard-name">${p.name} ${p.pDmg > avg * 2.5 ? '🔥' : ''}${subBadge(p, t)}</span>
                        <span class="job-tag" style="background:var(--color-${p.job})">${p.job}</span>
                    </div>
                    <div class="rcard-stats">
                        ${statCols.map(c => `<div><b>${fmt(p[c.k])}</b><span>${c.l}</span></div>`).join('')}
                    </div>
                </div>`).join('');
        }
    });
}

function renderMVPs(team, players) {
    document.getElementById('mvp-' + team).innerHTML = metrics.map(m => {
        const top = [...players].sort((a, b) => b[m.k] - a[m.k])[0];
        return top ? `<div class="mvp-card"><div class="mvp-label">${m.l}</div><div class="mvp-name">${top.name}</div><div class="mvp-val">${top[m.k] >= 10000 ? (top[m.k] / 10000).toFixed(1) + 'w' : top[m.k]}</div></div>` : '';
    }).join('');
}

function renderFilterButtons() {
    const jobs = ["all", ...new Set(full.map(p => p.job))];
    document.getElementById('job-filters').innerHTML = jobs.map(j => `<button class="filter-btn ${currentJobFilter === j ? 'active' : ''}" onclick="setJobFilter('${j}')">${j === 'all' ? '全部' : j}</button>`).join('');
}
function setJobFilter(j) { currentJobFilter = j; renderFilterButtons(); renderReport(); }
function sortBy(team, key) { (team === 'a' ? gA : gB).sort((a, b) => b[key] - a[key]); renderReport(); }
// 戰報詳情排序：兩隊都依所選數據由高到低（表格與卡片同步）
function applyReportSort() {
    const key = document.getElementById('report-sort')?.value || 'pDmg';
    gA.sort((a, b) => (b[key] || 0) - (a[key] || 0));
    gB.sort((a, b) => (b[key] || 0) - (a[key] || 0));
    renderReport();
}

// =====================================================
// ===  Modal：單場詳細
// =====================================================
async function openModal(n) {
    focusPlayer = full.find(x => x.name === n);
    document.getElementById('modal').style.display = 'flex';
    document.getElementById('m-name').innerText = focusPlayer.name;
    document.getElementById('m-job-box').innerHTML = `<span class="job-tag" style="background:var(--color-${focusPlayer.job})">${focusPlayer.job}</span>`;
    document.getElementById('m-stats-box').innerHTML = `
擊敗：${focusPlayer.kill} ｜ 助攻：${focusPlayer.assist}<br>
輸出：${(focusPlayer.pDmg / 10000).toFixed(1)}w ｜ 塔傷：${(focusPlayer.bDmg / 10000).toFixed(1)}w<br>
承傷：${(focusPlayer.takeDmg / 10000).toFixed(1)}w ｜ 治療：${(focusPlayer.heal / 10000).toFixed(1)}w<br>
資源：${focusPlayer.resource} ｜ 重傷：${focusPlayer.death}<br>
化羽：${focusPlayer.spring} ｜ 焚骨：${focusPlayer.bone}`;

    // ✅ 修復：備註讀取 — 雲端從 members 表讀，本地從 localStorage 讀
    // 統一讀取並解析 note JSON（兼容舊格式純字串）
    let parsedNote = "";
    if (storageMode === 'cloud' && currentUser) {
        try {
            const res = await fetch(`${WORKER_URL}/api/member-note?id=${encodeURIComponent(focusPlayer.name)}&t=${Date.now()}`,
                { cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token } });
            const data = await res.json();
            try { parsedNote = JSON.parse(data.note).text || ""; } catch (e) { parsedNote = data.note || ""; }
        } catch (e) { }
    } else {
        const membersMap = getLocalMembers();
        const m = membersMap[focusPlayer.name];
        if (m) { try { parsedNote = JSON.parse(m.note || '{}').text || m.note || ""; } catch (e) { parsedNote = m.note || ""; } }
    }
    document.getElementById('m-note').value = parsedNote;

    const rCols = getRadarCols(focusPlayer.job);
    const stats = {};
    rCols.forEach(c => {
        const vals = full.filter(x => x.job === focusPlayer.job).map(x => x[c.k]);
        stats[c.k] = { max: Math.max(...vals, 1), min: Math.min(...vals, 0) };
    });

    if (chart) { chart.destroy(); chart = null; }
    const oldCanvas = document.getElementById('radarChart');
    const newCanvas = document.createElement('canvas');
    newCanvas.id = 'radarChart';
    oldCanvas.parentNode.replaceChild(newCanvas, oldCanvas);

    chart = new Chart(newCanvas, {
        type: 'radar',
        data: {
            labels: rCols.map(c => c.l),
            datasets: [{
                label: '單場職業內分佈', data: rCols.map(c => {
                    const max = stats[c.k].max, min = stats[c.k].min, val = focusPlayer[c.k];
                    return c.k === 'death' ? ((max - val) / (max - min || 1)) * 100 : ((val - min) / (max - min || 1)) * 100;
                }), backgroundColor: 'rgba(142,154,175,0.2)', borderColor: '#8e9aaf'
            }]
        },
        options: { animation: false, devicePixelRatio: Math.round(window.devicePixelRatio) || 2, scales: { r: { min: 0, max: 100, ticks: { display: false } } } }
    });
}

// =====================================================
// ===  成員檔案室詳細 Modal
// =====================================================
async function openMemberDetail(id) {
    const m = dbMembersMap.find(x => x.id === id);
    if (!m) return;
    focusPlayer = m;

    document.getElementById('member-modal').style.display = 'flex';
    document.getElementById('mm-name').innerText = m.id;

    const noteEl = document.getElementById('mm-note');
    if (noteEl) noteEl.value = m.note;
    const tagEl = document.getElementById('mm-tag');
    if (tagEl) tagEl.value = m.tag;
    const tagViewEl = document.getElementById('mm-tag-view');
    if (tagViewEl) tagViewEl.innerText = (m.tag !== 'none' ? m.tag : '無標籤');

    // 身份類別
    const catEl = document.getElementById('mm-category');
    if (catEl) {
        const cats = [...new Set([...CATEGORY_PRESETS, ...dbMembersMap.map(x => x.category).filter(Boolean)])];
        catEl.innerHTML = '<option value="">未分類</option>'
            + cats.map(c => `<option value="${c}" ${c === m.category ? 'selected' : ''}>${c}</option>`).join('')
            + '<option value="__new__">➕ 新增類別…</option>';
        catEl.value = m.category || '';
    }
    const catViewEl = document.getElementById('mm-category-view');
    if (catViewEl) catViewEl.innerText = m.category || '未分類';

    // 管理員專屬：no-show / 臨時請假 紀錄（唯讀版不顯示）
    renderMemberFlags(m);
    loadMemberLeaveHistory(m);

    const jobEl = document.getElementById('mm-job');
    if (jobEl) {
        const jobSet = new Set(dbMembersMap.map(x => x.last_job).filter(Boolean));
        jobEl.innerHTML = [...jobSet].map(j => `<option value="${j}" ${j === m.last_job ? 'selected' : ''}>${j}</option>`).join('');
    }
    const jobViewEl = document.getElementById('mm-job-view');
    if (jobViewEl) { jobViewEl.innerText = m.last_job; jobViewEl.style.display = 'inline-block'; }

    // 雷達圖：只抓與現職相同的近5場
    const currentJob = m.last_job;
    const recent = m.histories.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);

    document.getElementById('mm-history-list').innerHTML = recent.map(h => {
        const hJob = h.stats.job || currentJob;
        const snapCols = getRadarCols(hJob);
        const snapHtml = snapCols.map(c => {
            const val = h.stats[c.k] ?? 0;
            const display = (['pDmg', 'bDmg', 'heal', 'takeDmg'].includes(c.k)) ? (val / 10000).toFixed(1) + 'w' : val;
            return `<span style="margin-right:8px;"><b>${c.l}</b>:${display}</span>`;
        }).join('');
        return `<div style="padding:8px 6px; border-bottom:1px solid #eee; ${h.subBy ? 'background:#f3f1fb;' : ''}">
            <div style="margin-bottom:3px;">
                <b>[${h.date}]</b>
                <span style="color:var(--accent); font-size:11px;">[${fmtType(h.type)}]</span>
                ${h.session ? `<span style="font-size:11px;">【${h.session}】</span>` : ''}
                <span style="font-size:11px; color:#999;">${h.title}</span>
                <span class="job-tag" style="background:var(--color-${hJob}); font-size:10px; margin-left:4px;">${hJob}</span>
                ${h.subBy ? `<span class="hash-tag" style="background:#5c6bc0; color:#fff; font-size:10px; margin-left:4px;">🔄${h.subBy}代打（不計出勤）</span>` : ''}
            </div>
            <div style="font-size:12px; color:#555; flex-wrap:wrap; display:flex;">${snapHtml}</div>
        </div>`;
    }).join('');

    const rCols = getRadarCols(currentJob);
    const sameJobHistories = m.histories
        .filter(h => (h.stats.job || '') === currentJob && !h.subBy)
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 5);

    const avgStats = {};
    rCols.forEach(c => {
        if (sameJobHistories.length > 0) {
            avgStats[c.k] = sameJobHistories.reduce((sum, h) => sum + (h.stats[c.k] || 0), 0) / sameJobHistories.length;
        } else {
            avgStats[c.k] = m.aggr[c.k] / m.matches;
        }
    });

    const classPeers = dbMembersMap.filter(x => x.last_job === currentJob && x.matches > 0);
    const globalStats = {};
    rCols.forEach(c => {
        const peerAvgs = classPeers.map(p => p.aggr[c.k] / p.matches);
        globalStats[c.k] = { max: Math.max(...peerAvgs, 1), min: Math.min(...peerAvgs, 0) };
    });

    if (memberChart) { memberChart.destroy(); memberChart = null; }
    const oldMCanvas = document.getElementById('memberRadarChart');
    const newMCanvas = document.createElement('canvas');
    newMCanvas.id = 'memberRadarChart';
    oldMCanvas.parentNode.replaceChild(newMCanvas, oldMCanvas);

    memberChart = new Chart(newMCanvas, {
        type: 'radar',
        data: {
            labels: rCols.map(c => c.l),
            datasets: [{
                label: `${currentJob} 近${sameJobHistories.length}場平均`, data: rCols.map(c => {
                    const max = globalStats[c.k].max, min = globalStats[c.k].min, val = avgStats[c.k];
                    return c.k === 'death' ? ((max - val) / (max - min || 1)) * 100 : ((val - min) / (max - min || 1)) * 100;
                }), backgroundColor: 'rgba(251,192,45,0.2)', borderColor: '#fbc02d'
            }]
        },
        options: {
            animation: false, responsive: true, maintainAspectRatio: true,
            devicePixelRatio: Math.round(window.devicePixelRatio) || 2,
            scales: { r: { min: 0, max: 100, ticks: { display: false } } }
        }
    });
}

// =====================================================
// ===  身分對照表：把歷史戰報裡的名字 resolve 成穩定 member_id
// =====================================================
// 載入代替上號對照表到 subMapByWin
async function loadSubMap() {
    subMapByWin = {};
    try {
        const subUrl = WORKER_URL + "/api/leave/substitutes?t=" + Date.now() + (shareId ? "&share=" + shareId : "");
        const subHeaders = (!shareId && currentUser) ? { 'Authorization': 'Bearer ' + currentUser.token } : {};
        if (shareId || (storageMode === 'cloud' && currentUser)) {
            const subs = await fetch(subUrl, { cache: "no-store", headers: subHeaders }).then(r => r.json()).catch(() => []);
            (Array.isArray(subs) ? subs : []).forEach(s => {
                const k = `${s.date}|${s.session}|${s.type}`;
                (subMapByWin[k] = subMapByWin[k] || {})[s.member_id] = s.substitute_member_id;
            });
        }
    } catch (e) { subMapByWin = {}; }
}

async function fetchRosterAliasMap() {
    aliasToMemberId = {};
    memberIdToDisplayName = {};
    memberIdToCategory = {};
    memberIdToJob = {};
    try {
        let apiUrl = WORKER_URL + "/api/roster/aliases?t=" + Date.now();
        let res;
        if (shareId) {
            res = await fetch(apiUrl + "&share=" + shareId, { cache: "no-store" });
        } else if (storageMode === 'cloud' && currentUser) {
            res = await fetch(apiUrl, { cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token } });
        } else {
            return; // 本地模式沒有雲端名冊可對照
        }
        const data = await res.json();
        (data.roster || []).forEach(r => {
            memberIdToDisplayName[r.member_id] = r.display_name;
            memberIdToCategory[r.member_id] = r.category || '';
            if (r.job) memberIdToJob[r.member_id] = r.job;
        });
        (data.aliases || []).forEach(a => { aliasToMemberId[a.alias_name] = a.member_id; });
    } catch (e) { console.error("載入身分對照表失敗", e); }
}

// =====================================================
// ===  成員檔案室：loadDbData
// =====================================================
// 本地 YYYY-MM-DD（避免 toISOString 的時區偏移）
function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// 依「時間篩選」下拉計算實際日期範圍 {fromDate, toDate}（'YYYY-MM-DD' 或 null）
function getDbTimeRange() {
    const v = document.getElementById('db-time')?.value || 'all';
    const now = new Date();
    if (v === 'all') return { fromDate: null, toDate: null };
    if (v === 'custom') {
        return {
            fromDate: document.getElementById('db-date-from')?.value || null,
            toDate: document.getElementById('db-date-to')?.value || null
        };
    }
    if (v === 'thismonth') {
        return { fromDate: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), toDate: ymd(now) };
    }
    const days = parseInt(v);
    const from = new Date(now);
    from.setDate(from.getDate() - days);
    return { fromDate: ymd(from), toDate: ymd(now) };
}
// 切換時間篩選：自訂範圍時顯示日期輸入，其餘直接載入
function onDbTimeChange() {
    const v = document.getElementById('db-time').value;
    const box = document.getElementById('db-date-range');
    if (box) box.style.display = (v === 'custom') ? 'inline-flex' : 'none';
    if (v === 'custom') {
        const from = document.getElementById('db-date-from'), to = document.getElementById('db-date-to');
        // 首次切到自訂時，預設帶入本月，避免空範圍
        if (from && !from.value) from.value = ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
        if (to && !to.value) to.value = ymd(new Date());
    }
    loadDbData();
}

async function loadDbData() {
    const { fromDate, toDate } = getDbTimeRange();
    const filteredHistories = allHistories.filter(h => {
        if (fromDate && h.date < fromDate) return false;
        if (toDate && h.date > toDate) return false;
        return true;
    });

    // ⚡ 並行抓取所有彼此獨立的資料（名冊/代打/補登出席/成員備註），加速載入。
    //    只改「同時發請求」，API、回傳格式、後續計算完全不變。
    const membersPromise = (async () => {
        try {
            if (shareId) {
                const res = await fetch(WORKER_URL + "/api/members?t=" + Date.now() + "&share=" + shareId, { cache: "no-store" });
                return await res.json();
            } else if (storageMode === 'cloud' && currentUser) {
                const res = await fetch(WORKER_URL + "/api/members?t=" + Date.now(), { cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token } });
                return await res.json();
            }
            return Object.values(getLocalMembers());
        } catch (e) { console.error("載入成員備註失敗", e); return []; }
    })();
    const manualPromise = (async () => {
        try {
            const aUrl = WORKER_URL + "/api/leave/attendance?t=" + Date.now() + (shareId ? "&share=" + shareId : "");
            const aHeaders = (!shareId && currentUser) ? { 'Authorization': 'Bearer ' + currentUser.token } : {};
            if (shareId || (storageMode === 'cloud' && currentUser)) {
                const r = await fetch(aUrl, { cache: "no-store", headers: aHeaders }).then(r => r.json()).catch(() => []);
                return Array.isArray(r) ? r : [];
            }
            return [];
        } catch (e) { return []; }
    })();

    const [, , dbRaw, manualAll] = await Promise.all([
        fetchRosterAliasMap(),   // 設定 aliasToMemberId / memberIdToDisplayName
        loadSubMap(),            // 設定 subMapByWin
        membersPromise,
        manualPromise
    ]);

    const manualAttendance = (Array.isArray(manualAll) ? manualAll : []).filter(a => (!fromDate || a.date >= fromDate) && (!toDate || a.date <= toDate));

    // 出席以「場次(date|session|type)」為單位；分母＝戰報場 ∪ 補登場
    const sessionSet = new Set();
    filteredHistories.forEach(h => { try { const d = JSON.parse(h.raw_json); sessionSet.add(`${h.date}|${d.session || '第一場'}|${d.matchType || '幫戰'}`); } catch (e) { } });
    manualAttendance.forEach(a => sessionSet.add(`${a.date}|${a.session}|${a.type}`));
    totalReportsInTimeframe = sessionSet.size;

    let noteMap = {};
    const jobSet = new Set();
    (Array.isArray(dbRaw) ? dbRaw : []).forEach(m => {
        let noteStr = "", tagStr = "none", storedJob = m.last_job;
        try {
            const p = JSON.parse(m.note);
            noteStr = p.text || "";
            tagStr = p.tag || "none";
            if (p.last_job) storedJob = p.last_job;
        } catch (e) { noteStr = m.note || ""; }
        noteMap[m.id] = { note: noteStr, tag: tagStr, lastJob: storedJob, version: (typeof m.version === 'number' ? m.version : null) };
        if (m.last_job) jobSet.add(m.last_job);
    });

    const jobSelect = document.getElementById('db-job');
    const currJob = jobSelect.value;

    // ✅ 前端計算：從 allHistories 重新計算成員資料
    const map = {};

    // ✅ 名冊優先：先把所有在職成員放進去（即使 0 場次，也要能顯示請假/後備數字）
    Object.keys(memberIdToDisplayName).forEach(mid => {
        map[mid] = { id: memberIdToDisplayName[mid], member_id: mid, matches: 0, histories: [], aggr: {}, counts: { "幫戰": 0, "約戰": 0, "其他": 0 }, latestDate: '', last_job: '' };
    });

    const mkEntry = (id, mid) => ({ id, member_id: mid || null, matches: 0, histories: [], aggr: {}, counts: { "幫戰": 0, "約戰": 0, "其他": 0 }, latestDate: '', last_job: '' });
    // 出席以場次(date|session|type)去重：戰報＋補登不重複算
    const addAtt = (entry, sk, type) => {
        entry._att = entry._att || new Set();
        if (!entry._att.has(sk)) { entry._att.add(sk); entry.counts[type] = (entry.counts[type] || 0) + 1; }
    };

    filteredHistories.forEach(h => {
        try {
            const d = JSON.parse(h.raw_json);
            const aName = d.nameA || h.guild_a;
            const type = d.matchType || "幫戰";
            const session = d.session || "第一場";
            const sk = `${h.date}|${session}|${type}`;
            const subForWin = subMapByWin[`${h.date}|${session}|${type}`];
            d.gA.forEach(p => {
                // ✅ 改名/合併安全：有對照到穩定 member_id 就用它分組，顯示名稱取當下最新名稱
                const origId = aliasToMemberId[p.name];
                if (p.job) jobSet.add(p.job);
                // 已移除的成員（有對應 member_id 但不在現行名冊）→ 不計、不顯示
                if (origId && !memberIdToDisplayName[origId]) return;
                const subB = (subForWin && origId && subForWin[origId]) ? subForWin[origId] : null;
                if (subB) {
                    // 代替上號：出勤算給代打者（本人這場不算）；只加次數不污染其數據
                    const bName = memberIdToDisplayName[subB] || subB;
                    if (!map[subB]) map[subB] = mkEntry(bName, subB);
                    addAtt(map[subB], sk, type);
                    const aName2 = origId ? (memberIdToDisplayName[origId] || p.name) : p.name;
                    (map[subB].subFor = map[subB].subFor || []).push({ date: h.date, session, type, name: aName2 });
                    // 本人（被代打）：不計出勤、不進雷達平均，但保留這場快照（標示代打）
                    const aKey = origId || p.name;
                    if (!map[aKey]) map[aKey] = mkEntry(aName2, origId || null);
                    (map[aKey].subBy = map[aKey].subBy || []).push({ date: h.date, session, type, name: bName });
                    map[aKey].histories.push({ date: h.date, title: aName, stats: p, type, session, subBy: bName });
                    return;
                }
                const key = origId || p.name;
                const displayName = origId ? (memberIdToDisplayName[origId] || p.name) : p.name;
                if (!map[key]) map[key] = mkEntry(displayName, origId || null);
                addAtt(map[key], sk, type);
                map[key].histories.push({ date: h.date, title: aName, stats: p, type, session });
                // ✅ 判定最新職業：比較日期，取最新的
                if (!map[key].latestDate || h.date > map[key].latestDate) {
                    map[key].latestDate = h.date;
                    map[key].last_job = p.job;
                }
                cols.slice(2).forEach(c => {
                    map[key].aggr[c.k] = (map[key].aggr[c.k] || 0) + (p[c.k] || 0);
                });
            });
        } catch (e) { }
    });

    // 併入手動補登出席（與戰報去重），並結算出席場數
    manualAttendance.forEach(a => {
        const key = a.member_id;
        if (!memberIdToDisplayName[key]) return; // 已移除的成員不計
        if (!map[key]) map[key] = mkEntry(memberIdToDisplayName[key] || key, key);
        addAtt(map[key], `${a.date}|${a.session}|${a.type}`, a.type);
    });
    Object.values(map).forEach(m => { m.matches = m._att ? m._att.size : 0; });

    // ✅ 修復：同日期多場時取最後一場（session 排序）
    // 對每個成員的 histories 按日期+場次排序，確保 latestDate 計算正確
    Object.values(map).forEach(m => {
        if (m.histories.length > 1) {
            // 找到 latestDate 的所有記錄，取場次最大的那個的職業（排除代打場，代打不代表本人職業）
            const latestEntries = m.histories.filter(h => h.date === m.latestDate && !h.subBy);
            latestEntries.sort((a, b) => {
                const sessionOrder = { '第一場': 1, '第二場': 2 };
                return (sessionOrder[b.session] || 1) - (sessionOrder[a.session] || 1);
            });
            if (latestEntries.length > 0) {
                m.last_job = latestEntries[0].stats.job;
            }
        }
    });

    jobSelect.innerHTML = '<option value="all">全部職業</option>' + [...jobSet].map(j => `<option value="${j}">${j}</option>`).join('');
    jobSelect.value = currJob || 'all';

    dbMembersMap = Object.values(map).map(m => {
        m.note = noteMap[m.id]?.note || "";
        m.tag = noteMap[m.id]?.tag || "none";
        // last_job 以前端計算（最新一場）為主；無戰報則用名冊登記的職業
        if (!m.last_job) m.last_job = noteMap[m.id]?.lastJob || (m.member_id ? memberIdToJob[m.member_id] : '') || "未知";
        m.category = m.member_id ? (memberIdToCategory[m.member_id] || '') : '';
        m.rate = totalReportsInTimeframe > 0 ? (m.matches / totalReportsInTimeframe * 100) : 0;
        m.noteVersion = noteMap[m.id]?.version ?? null; // 成員檔案版本（防覆寫）
        return m;
    });

    // ✅ 合併請假/後備次數（來自請假系統，依時間範圍）與人工覆蓋
    await mergeLeaveAndOverrides(fromDate, toDate);

    const syncEl = document.getElementById('db-last-sync');
    if (syncEl) syncEl.textContent = `最後計算：${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`;

    renderDbTable();
}

// =====================================================
// ===  合併請假/後備次數 + 人工覆蓋
// =====================================================
async function mergeLeaveAndOverrides(fromDate, toDate) {
    let leaveStats = {}, overrides = [];
    try {
        const base = shareId
            ? `?share=${shareId}&t=${Date.now()}`
            : `?t=${Date.now()}`;
        const rangeQS = (fromDate ? `&from=${fromDate}` : '') + (toDate ? `&to=${toDate}` : '');
        const headers = (!shareId && currentUser) ? { 'Authorization': 'Bearer ' + currentUser.token } : {};
        if (shareId || (storageMode === 'cloud' && currentUser)) {
            const [ls, ov] = await Promise.all([
                fetch(WORKER_URL + "/api/leave/stats" + base + rangeQS, { cache: "no-store", headers }).then(r => r.json()).catch(() => ({})),
                fetch(WORKER_URL + "/api/overrides" + base, { cache: "no-store", headers }).then(r => r.json()).catch(() => ([]))
            ]);
            leaveStats = ls || {};
            overrides = Array.isArray(ov) ? ov : [];
        }
    } catch (e) { console.error("載入請假/覆蓋資料失敗", e); }

    const ovMap = {};
    overrides.forEach(o => { ovMap[o.member_id] = o; });

    dbMembersMap.forEach(m => {
        const mid = m.member_id;
        const s = (mid && leaveStats[mid]) ? leaveStats[mid] : {};
        // 各類型自動值：出席取 m.counts（戰報，受時間篩選），請假/後備取請假系統
        const autoAtt = m.counts || {};
        const autoLeave = s.leaveByType || {};
        const autoReserve = s.reserveByType || {};
        m.autoByType = { attendance: autoAtt, leave: autoLeave, reserve: autoReserve };
        // 臨時請假：已併入 leaveByType，這裡單獨保留次數供醒目標示
        m.lateCount = s.lateByType ? TYPE_ORDER.reduce((x, t) => x + (s.lateByType[t] || 0), 0) : (s.late || 0);
        m.lateByType = s.lateByType || {};
        // 缺席（No-show）：大家可看，不併入請假
        m.noshowByType = s.noshowByType || {};
        m.noshowCount = s.noshowByType ? TYPE_ORDER.reduce((x, t) => x + (s.noshowByType[t] || 0), 0) : (s.noshow || 0);

        const ov = mid ? ovMap[mid] : null;
        m.overrideVersion = ov ? ov.version : null;
        let perType = null;
        if (ov && ov.overrides_json) { try { perType = JSON.parse(ov.overrides_json); } catch (e) { } }
        m.overridesJson = perType;

        const attByType = {}, leaveByType = {}, reserveByType = {};
        let hasOv = false;
        TYPE_ORDER.forEach(t => {
            const otx = (perType && perType[t]) ? perType[t] : {};
            const a = (otx.attendance != null) ? otx.attendance : (autoAtt[t] || 0);
            const l = (otx.leave != null) ? otx.leave : (autoLeave[t] || 0);
            const r = (otx.reserve != null) ? otx.reserve : (autoReserve[t] || 0);
            if (otx.attendance != null || otx.leave != null || otx.reserve != null) hasOv = true;
            attByType[t] = a; leaveByType[t] = l; reserveByType[t] = r;
        });
        let attendance = TYPE_ORDER.reduce((x, t) => x + attByType[t], 0);
        let leave = TYPE_ORDER.reduce((x, t) => x + leaveByType[t], 0);
        let reserve = TYPE_ORDER.reduce((x, t) => x + reserveByType[t], 0);
        // 舊版整體覆蓋相容
        if (!perType && ov) {
            if (ov.attendance_override != null) { attendance = ov.attendance_override; hasOv = true; }
            if (ov.leave_override != null) { leave = ov.leave_override; hasOv = true; }
            if (ov.reserve_override != null) { reserve = ov.reserve_override; hasOv = true; }
        }

        m.attendance = attendance;
        m.leaveCount = leave;
        m.reserveCount = reserve;
        m.attByTypeEff = attByType;
        m.leaveByType = leaveByType;
        m.reserveByType = reserveByType;
        m.hasOverride = hasOv;
    });
}

function renderDbTable() {
    const search = document.getElementById('db-search').value.toLowerCase();
    const jobF = document.getElementById('db-job').value;
    const tagF = document.getElementById('db-tag').value;
    const catF = document.getElementById('db-category')?.value || 'all';

    // 身份類別下拉：預設 + 現有資料裡出現過的
    const catSel = document.getElementById('db-category');
    if (catSel) {
        const cats = [...new Set([...CATEGORY_PRESETS, ...dbMembersMap.map(m => m.category).filter(Boolean)])];
        const cur = catSel.value;
        catSel.innerHTML = '<option value="all">全部身份</option>' + cats.map(c => `<option value="${c}">${c}</option>`).join('') + '<option value="none">未分類</option>';
        catSel.value = cur || 'all';
    }

    const threshold = parseFloat(document.getElementById('db-threshold')?.value);
    const hasThreshold = !isNaN(threshold);
    const onlyLow = document.getElementById('db-only-low')?.checked;

    let data = dbMembersMap.filter(m => {
        const matchS = m.id.toLowerCase().includes(search);
        const matchJ = jobF === 'all' || m.last_job === jobF;
        const matchT = tagF === 'all' || m.tag === tagF;
        const matchC = catF === 'all' || (catF === 'none' ? !m.category : m.category === catF);
        const matchLow = !onlyLow || (hasThreshold && m.rate < threshold);
        return matchS && matchJ && matchT && matchC && matchLow;
    });

    data.sort((a, b) => {
        let va = a[dbSort.key], vb = b[dbSort.key];
        if (typeof va === 'string') return dbSort.asc ? va.localeCompare(vb) : vb.localeCompare(va);
        return dbSort.asc ? va - vb : vb - va;
    });

    document.getElementById('db-table-body').innerHTML = data.map(m => {
        const low = hasThreshold && m.rate < threshold;
        return `
        <tr onclick="openMemberDetail('${m.id}')" style="cursor:pointer; ${low ? 'background:#fff0f0;' : ''}">
            <td><b>${m.id}</b>${low ? ' <span style="color:var(--danger); font-size:11px;">⚠️低出席</span>' : ''}</td>
            <td><span class="job-tag" style="background:var(--color-${m.last_job})">${m.last_job}</span></td>
            <td>${m.category ? `<span class="cat-chip">${m.category}</span>` : '<span style="color:var(--muted);">—</span>'}</td>
            <td>${m.tag !== 'none' ? `<span class="hash-tag">${m.tag}</span>` : ''}</td>
            <td>${m.matches} 場</td>
            <td class="nowrap" style="font-size:11px; color:#666;" title="幫戰/約戰/領地戰 出席次數">⚔️${m.counts['幫戰'] || 0} / 🤝${m.counts['約戰'] || 0} / 🏰${m.counts['其他'] || 0}</td>
            <td class="nowrap">${renderStatBadge(m)}</td>
            <td class="nowrap" style="${low ? 'color:var(--danger); font-weight:bold;' : ''}">${m.rate.toFixed(1)}%</td>
            <td>${m.note || ''}</td>
            <td class="admin-only">
                <button class="btn btn-outline" style="padding:2px 8px;" onclick="event.stopPropagation(); renameP('${m.id}')">更名</button>
                <button class="btn btn-outline" style="padding:2px 8px;" onclick="event.stopPropagation(); mergeP('${m.id}')">合併</button>
                ${m.member_id ? `<button class="btn btn-outline" style="padding:2px 8px; color:var(--danger);" onclick="event.stopPropagation(); deleteRosterMember('${m.member_id}', '${(m.id || '').replace(/'/g, "\\'")}')">移除</button>` : ''}
            </td>
        </tr>`;
    }).join('');

    renderDbCards(data, hasThreshold, threshold);
}

// 手機版：成員以卡片呈現（不用左右滑表格）
function renderDbCards(data, hasThreshold, threshold) {
    const wrap = document.getElementById('db-cards');
    if (!wrap) return;
    const admin = !isViewMode;
    wrap.innerHTML = data.map(m => {
        const low = hasThreshold && m.rate < threshold;
        const jobColor = `var(--color-${m.last_job})`;
        const badge = renderStatBadge(m);
        const actions = admin ? `
            <div class="mcard-actions">
                <button class="btn btn-outline" onclick="event.stopPropagation(); renameP('${m.id}')">更名</button>
                <button class="btn btn-outline" onclick="event.stopPropagation(); mergeP('${m.id}')">合併</button>
                ${m.member_id ? `<button class="btn btn-outline" style="color:var(--danger);" onclick="event.stopPropagation(); deleteRosterMember('${m.member_id}', '${(m.id || '').replace(/'/g, "\\'")}')">移除</button>` : ''}
            </div>` : '';
        return `<div class="mcard ${low ? 'low' : ''}" onclick="openMemberDetail('${m.id}')">
            <div class="mcard-top">
                <span class="mcard-dot" style="background:${jobColor}"></span>
                <div class="mcard-name">
                    <div class="nm">${m.id}${low ? ' <span style="color:var(--danger);font-size:11px;">⚠️</span>' : ''}</div>
                    <div class="sub"><span class="job-tag" style="background:${jobColor}">${m.last_job}</span>${m.category ? ` <span class="cat-chip">${m.category}</span>` : ''}${m.tag !== 'none' ? ` <span class="hash-tag">${m.tag}</span>` : ''}</div>
                </div>
                <div class="mcard-rate ${low ? 'low' : ''}"><b>${m.rate.toFixed(1)}%</b><span>出席率</span></div>
            </div>
            <div class="mcard-bar ${low ? 'low' : ''}"><span style="width:${Math.min(100, m.rate)}%"></span></div>
            <div class="mcard-stat">
                <div><b>${m.matches}</b><span>總場次</span></div>
                <div>${badge}<span>出席/請假/後備/缺席</span></div>
            </div>
            <div class="mcard-break">${TYPE_ORDER.map(t => {
                const a = (m.attByTypeEff && m.attByTypeEff[t]) || 0;
                const l = (m.leaveByType && m.leaveByType[t]) || 0;
                const r = (m.reserveByType && m.reserveByType[t]) || 0;
                const n = (m.noshowByType && m.noshowByType[t]) || 0;
                return `<span>${fmtType(t)} ${a}/${l}/${r}/${n}</span>`;
            }).join('')}</div>
            ${actions}
        </div>`;
    }).join('') || '<div style="color:#aaa; text-align:center; padding:24px;">沒有符合的成員</div>';
}

// 出席率門檻：記在 localStorage
function onThresholdChange() {
    const v = document.getElementById('db-threshold').value;
    localStorage.setItem('nsh_attendance_threshold', v);
    renderDbTable();
}

// 匯出成員名單 CSV（名字/職業/身份/標籤/出席/請假/後備/出席率）
function exportMembersCSV() {
    if (!dbMembersMap.length) { alert('沒有可匯出的資料'); return; }
    const header = ['名字', '職業', '身份', '所屬分類', '總場次', '出席', '請假', '其中臨時', '缺席', '後備', '出席率(%)', '代打記錄'];
    const subText = (m) => {
        const parts = [];
        const seg = (s) => `${s.date} ${fmtType(s.type)}${s.session || ''}`;
        (m.subFor || []).forEach(s => parts.push(`${seg(s)} 代打 ${s.name}`));
        (m.subBy || []).forEach(s => parts.push(`${seg(s)} 由 ${s.name} 代打`));
        return parts.join('；');
    };
    const rows = dbMembersMap.map(m => [
        m.id, m.last_job || '', m.category || '', (m.tag && m.tag !== 'none') ? m.tag : '',
        m.matches, (m.attendance != null ? m.attendance : m.matches), m.leaveCount || 0, m.lateCount || 0, m.noshowCount || 0, m.reserveCount || 0,
        m.rate.toFixed(1), subText(m)
    ]);
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
    // BOM 讓 Excel 正確辨識中文
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const { fromDate, toDate } = getDbTimeRange();
    let scope;
    if (fromDate || toDate) scope = `${fromDate || '最早'}_至_${toDate || '至今'}`;
    else scope = '全部時間';
    a.download = `成員出勤_${scope}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function sortDb(key) {
    if (dbSort.key === key) dbSort.asc = !dbSort.asc;
    else { dbSort.key = key; dbSort.asc = false; }
    renderDbTable();
}

// 出席/請假/後備 徽章（3/3/2），滑鼠移上去顯示各類型明細，點擊可手動覆蓋（僅管理員）
function statBreakdownTooltip(m) {
    const att = m.attByTypeEff || m.counts || {};
    const lines = TYPE_ORDER.map(t => {
        const a = att[t] || 0;
        const l = (m.leaveByType && m.leaveByType[t]) || 0;
        const r = (m.reserveByType && m.reserveByType[t]) || 0;
        const n = (m.noshowByType && m.noshowByType[t]) || 0;
        return `${fmtType(t)}：出席 ${a} / 請假 ${l} / 後備 ${r} / 缺席 ${n}`;
    });
    return lines.join('\n');
}

function renderStatBadge(m) {
    const att = m.attendance != null ? m.attendance : m.matches;
    const lv = m.leaveCount || 0;
    const rs = m.reserveCount || 0;
    const star = m.hasOverride ? '*' : '';
    const ns = m.noshowCount || 0;   // 缺席（No-show）：大家可看，算缺席
    const late = m.lateCount || 0;
    const adminView = !isViewMode && !shareId && storageMode === 'cloud' && currentUser;
    // 臨時請假：其中一部分，僅管理員可看
    const lateTag = (adminView && late > 0) ? ` <span class="late-tag" title="其中臨時請假 ${late} 次（含在請假內，僅管理員可見）">臨時${late}</span>` : '';
    // 缺席 > 0 用紅字強調
    const nsPart = ns > 0 ? `<span style="color:var(--danger);font-weight:700;">${ns}</span>` : `${ns}`;
    const tip = statBreakdownTooltip(m) + `\n順序：出席/請假/後備/缺席` + (adminView && late > 0 ? `\n其中臨時請假：${late} 次` : '') + (m.hasOverride ? '\n（*=有人工覆蓋）' : '');
    const badge = `${att}/${lv}/${rs}/${nsPart}${star}`;
    const clickable = (adminView && m.member_id);
    if (clickable) {
        return `<span class="stat-badge" title="${tip}\n（點擊可手動調整出席/請假/後備）" onclick="event.stopPropagation(); openOverrideModal('${m.member_id}')">${badge}</span>${lateTag}`;
    }
    return `<span class="stat-badge" title="${tip}">${badge}</span>${lateTag}`;
}

// =====================================================
// ===  出席/請假/後備 人工覆蓋 Modal
// =====================================================
function openOverrideModal(memberId) {
    const m = dbMembersMap.find(x => x.member_id === memberId);
    if (!m) return;
    window._overrideTarget = m;
    document.getElementById('ov-name').textContent = m.id;
    document.getElementById('ov-msg').textContent = '';
    const auto = m.autoByType || { attendance: {}, leave: {}, reserve: {} };
    const ov = m.overridesJson || {};
    // 每個類型一列，三個欄位；placeholder=自動值，value=覆蓋值（沒覆蓋留空）
    document.getElementById('ov-grid').innerHTML = TYPE_ORDER.map(t => {
        const ot = ov[t] || {};
        const cell = (field) => {
            const autoVal = (auto[field] && auto[field][t]) || 0;
            const ovVal = (ot[field] != null) ? ot[field] : '';
            return `<td style="padding:4px 6px; text-align:center;"><input type="number" class="ov-cell search-input" data-type="${t}" data-field="${field}" style="width:64px; padding:5px; text-align:center;" placeholder="${autoVal}" value="${ovVal}" oninput="recalcOverrideTotals()"></td>`;
        };
        return `<tr>
            <td style="padding:4px 6px; font-weight:bold;">${fmtType(t)}</td>
            ${cell('attendance')}${cell('leave')}${cell('reserve')}
        </tr>`;
    }).join('');
    recalcOverrideTotals();
    document.getElementById('override-modal').style.display = 'flex';
}

function recalcOverrideTotals() {
    const m = window._overrideTarget;
    if (!m) return;
    const auto = m.autoByType || { attendance: {}, leave: {}, reserve: {} };
    const totals = { attendance: 0, leave: 0, reserve: 0 };
    TYPE_ORDER.forEach(t => {
        ['attendance', 'leave', 'reserve'].forEach(field => {
            const input = document.querySelector(`.ov-cell[data-type="${t}"][data-field="${field}"]`);
            const raw = input && input.value !== '' ? Number(input.value) : ((auto[field] && auto[field][t]) || 0);
            totals[field] += (isNaN(raw) ? 0 : raw);
        });
    });
    document.getElementById('ov-total-att').textContent = totals.attendance;
    document.getElementById('ov-total-leave').textContent = totals.leave;
    document.getElementById('ov-total-reserve').textContent = totals.reserve;
}

async function saveOverride() {
    const m = window._overrideTarget;
    if (!m) return;
    const overrides = {};
    TYPE_ORDER.forEach(t => {
        overrides[t] = {};
        ['attendance', 'leave', 'reserve'].forEach(field => {
            const input = document.querySelector(`.ov-cell[data-type="${t}"][data-field="${field}"]`);
            overrides[t][field] = (input && input.value !== '') ? input.value : '';
        });
    });
    const payload = { member_id: m.member_id, overrides, expected_version: m.overrideVersion };
    try {
        const res = await fetch(WORKER_URL + "/api/roster/override", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.status === 409) {
            document.getElementById('ov-msg').textContent = '⚠️ ' + (data.error || '資料已被其他人更新') + '，正在重新載入…';
            await loadDbData();
            if (dbMembersMap.find(x => x.member_id === m.member_id)) openOverrideModal(m.member_id);
            return;
        }
        if (!res.ok) { document.getElementById('ov-msg').textContent = '⚠️ ' + (data.error || '儲存失敗'); return; }
        closeModal('override-modal');
        await loadDbData();
    } catch (e) { document.getElementById('ov-msg').textContent = '⚠️ 連線失敗：' + e.message; }
}

// =====================================================
// ===  ✅ 成員同步 / 資料清洗
// =====================================================
async function syncMemberData() {
    const modal = document.getElementById('sync-report-modal');
    const loadingDiv = document.getElementById('sync-report-loading');
    const resultDiv = document.getElementById('sync-report-result');
    const statusEl = document.getElementById('sync-report-status');
    const contentEl = document.getElementById('sync-report-content');

    loadingDiv.style.display = 'block';
    resultDiv.style.display = 'none';
    modal.style.display = 'flex';

    const startTime = Date.now();

    statusEl.textContent = '正在載入戰報資料…';
    await new Promise(r => setTimeout(r, 100));

    try {
        if (storageMode === 'cloud' && currentUser) {
            const res = await fetch(WORKER_URL + "/api/histories?t=" + Date.now(), {
                cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
            });
            allHistories = await res.json();
        } else {
            allHistories = getLocalHistories();
        }
    } catch (e) { }

    statusEl.textContent = '正在掃描成員資料…';
    await new Promise(r => setTimeout(r, 100));

    const prevJobMap = {};
    dbMembersMap.forEach(m => { prevJobMap[m.id] = m.last_job; });

    await loadDbData();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalReports = allHistories.length;
    const totalMembers = dbMembersMap.length;

    const jobChanges = [];
    dbMembersMap.forEach(m => {
        if (prevJobMap[m.id] && prevJobMap[m.id] !== m.last_job) {
            jobChanges.push({ id: m.id, from: prevJobMap[m.id], to: m.last_job });
        }
    });

    // ✅ 修復：同步後也要刷新 historyList（保持一致）
    renderHistoryList();

    loadingDiv.style.display = 'none';
    resultDiv.style.display = 'block';

    let jobChangeHtml = '';
    if (jobChanges.length > 0) {
        jobChangeHtml = '<br>' + jobChanges.map(j =>
            `&nbsp;&nbsp;↳ <b>${j.id}</b>：${j.from} → ${j.to}`
        ).join('<br>');
    }

    contentEl.innerHTML = `
        📁 處理戰報：<b>${totalReports}</b> 場<br>
        👤 更新成員：<b>${totalMembers}</b> 位<br>
        🔄 檢測到轉職：<b>${jobChanges.length}</b> 位${jobChangeHtml}<br>
        ⏱️ 耗時：<b>${elapsed}s</b>
    `;
}

// =====================================================
// ===  saveMemberProfile
// =====================================================
// 管理員專屬：顯示成員的 No-show / 臨時請假 紀錄（唯讀分享/查看模式不顯示）
async function renderMemberFlags(m) {
    const box = document.getElementById('mm-flags');
    if (!box) return; // view 模式下 admin-only 已被移除
    if (isViewMode || shareId || storageMode !== 'cloud' || !currentUser || !m.member_id) {
        const wrap = document.getElementById('mm-flags-box');
        if (wrap) wrap.style.display = 'none';
        return;
    }
    box.innerHTML = '<span style="color:#aaa;">載入中…</span>';
    try {
        const res = await fetch(WORKER_URL + "/api/leave/member-flags?member_id=" + encodeURIComponent(m.member_id) + "&t=" + Date.now(), {
            cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        const list = await res.json();
        if (!Array.isArray(list) || !list.length) {
            box.innerHTML = '<span style="color:#aaa;">目前沒有紀錄。</span>';
            return;
        }
        box.innerHTML = list.map(f => {
            const label = f.type === 'noshow'
                ? '<span class="status-pill status-closed">No-show</span>'
                : '<span class="badge-reserve" style="display:inline-block;">臨時請假</span>';
            return `<div style="padding:4px 0; border-bottom:1px solid #f5f5f5;"><b>${f.date}</b> ${f.session || ''} ${label}</div>`;
        }).join('');
    } catch (e) { box.innerHTML = '<span style="color:var(--danger);">載入失敗</span>'; }
}

// 成員檔案：請假/代打/臨時/長期 記錄（預設5筆＋搜尋/範圍）
let _mmLeaveHistory = [];
async function loadMemberLeaveHistory(m) {
    const wrap = document.getElementById('mm-leave-box');
    if (!wrap) return;
    if (isViewMode || shareId || storageMode !== 'cloud' || !currentUser || !m.member_id) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    const box = document.getElementById('mm-leave-history');
    box.innerHTML = '<span style="color:#aaa;">載入中…</span>';
    // 重設篩選
    const rangeSel = document.getElementById('mm-lh-range'); if (rangeSel) rangeSel.value = '5';
    const dr = document.getElementById('mm-lh-daterange'); if (dr) dr.style.display = 'none';
    const sr = document.getElementById('mm-lh-search'); if (sr) sr.value = '';
    try {
        const res = await fetch(WORKER_URL + "/api/leave/member-history?member_id=" + encodeURIComponent(m.member_id) + "&t=" + Date.now(), {
            cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        _mmLeaveHistory = await res.json();
        if (!Array.isArray(_mmLeaveHistory)) _mmLeaveHistory = [];
        renderMemberLeaveHistory();
    } catch (e) { box.innerHTML = '<span style="color:var(--danger);">載入失敗</span>'; }
}

function onMmLhRangeChange() {
    const v = document.getElementById('mm-lh-range').value;
    const dr = document.getElementById('mm-lh-daterange');
    if (dr) dr.style.display = (v === 'custom') ? 'inline-flex' : 'none';
    renderMemberLeaveHistory();
}

function renderMemberLeaveHistory() {
    const box = document.getElementById('mm-leave-history');
    if (!box) return;
    const kindLabel = {
        leave: '<span class="status-pill status-closed">請假</span>',
        late: '<span class="badge-reserve" style="display:inline-block;">臨時請假</span>',
        noshow: '<span class="noshow-tag">⛔ 缺席(No-show)</span>',
        covered_by: '<span class="badge-reserve" style="display:inline-block; background:#5c6bc0;">被代打</span>',
        covered_for: '<span class="badge-reserve" style="display:inline-block; background:#5c6bc0;">代打他人</span>',
        long: '<span class="badge-reserve" style="display:inline-block; background:#7e57c2;">長期請假</span>'
    };
    const q = (document.getElementById('mm-lh-search')?.value || '').toLowerCase().trim();
    const range = document.getElementById('mm-lh-range')?.value || '5';
    let list = _mmLeaveHistory.slice();
    // 範圍過濾
    if (range === '30') {
        const from = ymd(new Date(Date.now() - 30 * 86400000));
        list = list.filter(r => (r.date || r.from || '') >= from);
    } else if (range === 'custom') {
        const f = document.getElementById('mm-lh-from')?.value || '';
        const t = document.getElementById('mm-lh-to')?.value || '';
        list = list.filter(r => { const d = r.date || r.from || ''; return (!f || d >= f) && (!t || d <= t); });
    }
    // 搜尋
    if (q) list = list.filter(r => `${r.date || ''}${r.from || ''}${r.to || ''}${r.session || ''}${fmtType(r.type) || ''}${r.other || ''}`.toLowerCase().includes(q));
    if (!list.length) { box.innerHTML = '<span style="color:#aaa;">沒有符合的記錄。</span>'; return; }
    const limited = range === '5' ? list.slice(0, 5) : list;
    const rows = limited.map(r => {
        if (r.kind === 'long') {
            return `<div style="padding:4px 0; border-bottom:1px solid #f5f5f5;"><b>${r.from} ~ ${r.to}</b> ${kindLabel.long}${r.reason ? ' · ' + r.reason : ''}</div>`;
        }
        return `<div style="padding:4px 0; border-bottom:1px solid #f5f5f5;"><b>${r.date}</b> ${r.session || ''} <span class="hash-tag">${fmtType(r.type)}</span> ${kindLabel[r.kind] || ''}${r.other ? ' · ' + r.other : ''}</div>`;
    }).join('');
    const more = (range === '5' && list.length > 5) ? `<div style="font-size:11px; color:var(--muted); padding-top:4px;">還有 ${list.length - 5} 筆，切換上方範圍看全部</div>` : '';
    box.innerHTML = rows + more;
}

function onCategorySelectChange(sel) {
    if (sel.value === '__new__') {
        const name = (prompt('輸入新的身份類別名稱：') || '').trim();
        if (name) {
            // 插入為選項並選中
            const opt = document.createElement('option');
            opt.value = name; opt.textContent = name;
            sel.insertBefore(opt, sel.querySelector('option[value="__new__"]'));
            sel.value = name;
        } else {
            sel.value = focusPlayer?.category || '';
        }
    }
}

async function saveMemberProfile() {
    const newNote = document.getElementById('mm-note').value;
    const newTag = document.getElementById('mm-tag').value;
    const newJob = document.getElementById('mm-job')?.value || focusPlayer.last_job;
    const catEl = document.getElementById('mm-category');
    const newCategory = (catEl && catEl.value !== '__new__') ? catEl.value : (focusPlayer.category || '');

    if (storageMode === 'cloud' && currentUser) {
        const payload = {
            id: focusPlayer.id,
            note: JSON.stringify({ text: newNote, tag: newTag, last_job: newJob }),
            expected_version: (typeof focusPlayer.noteVersion === 'number' ? focusPlayer.noteVersion : undefined)
        };
        const res = await fetch(WORKER_URL + "/api/update-note", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify(payload)
        });
        if (res.status === 409) {
            const d = await res.json().catch(() => ({}));
            alert('⚠️ ' + (d.error || '此成員檔案已被其他人更新') + '\n將重新載入最新資料，請再改一次。');
            closeModal('member-modal');
            await loadDbData();
            return;
        }
        if (res.ok) {
            const d = await res.json().catch(() => ({}));
            // 更新前端持有的版本，讓同一頁可連續存檔不誤判衝突
            if (typeof d.version === 'number') {
                focusPlayer.noteVersion = d.version;
                const t2 = dbMembersMap.find(x => x.id === focusPlayer.id);
                if (t2) t2.noteVersion = d.version;
            }
        }
        // 身份類別存到 members_roster（穩定身分）
        if (focusPlayer.member_id) {
            await fetch(WORKER_URL + "/api/roster/category", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
                body: JSON.stringify({ member_id: focusPlayer.member_id, category: newCategory })
            });
            memberIdToCategory[focusPlayer.member_id] = newCategory;
        }
        // ✅ 修復：同步更新前端 dbMembersMap，不需要重新拉取
        const target = dbMembersMap.find(x => x.id === focusPlayer.id);
        if (target) {
            target.last_job = newJob;
            target.note = newNote;
            target.tag = newTag;
            target.category = newCategory;
        }
    } else {
        const membersMap = getLocalMembers();
        if (!membersMap[focusPlayer.id]) membersMap[focusPlayer.id] = { id: focusPlayer.id, last_job: newJob, matches: 0, total_dmg: 0, note: '' };
        membersMap[focusPlayer.id].note = JSON.stringify({ text: newNote, tag: newTag, last_job: newJob });
        membersMap[focusPlayer.id].last_job = newJob;
        saveLocalMembers(membersMap);
    }
    alert("檔案已更新！");
    closeModal('member-modal');
    // ✅ 修復：重新渲染表格（用已更新的 dbMembersMap，不重新請求 API）
    renderDbTable();
}

async function saveNoteOnly() {
    const note = document.getElementById('m-note').value;
    if (storageMode === 'cloud' && currentUser) {
        const res = await fetch(`${WORKER_URL}/api/member-note?id=${encodeURIComponent(focusPlayer.name)}&t=${Date.now()}`,
            { headers: { 'Authorization': 'Bearer ' + currentUser.token } });
        const data = await res.json();
        let oldTag = "none";
        try { oldTag = JSON.parse(data.note).tag || "none"; } catch (e) { }
        await fetch(WORKER_URL + "/api/update-note", {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ id: focusPlayer.name, note: JSON.stringify({ text: note, tag: oldTag }) })
        });
        // ✅ 更新前端 dbMembersMap 的 note（如果成員在列表中）
        const target = dbMembersMap.find(x => x.id === focusPlayer.name);
        if (target) target.note = note;
    } else {
        const membersMap = getLocalMembers();
        if (!membersMap[focusPlayer.name]) membersMap[focusPlayer.name] = { id: focusPlayer.name, last_job: focusPlayer.job, matches: 0, total_dmg: 0, note: '' };
        let oldTag = "none";
        try { oldTag = JSON.parse(membersMap[focusPlayer.name].note || '{}').tag || "none"; } catch (e) { }
        membersMap[focusPlayer.name].note = JSON.stringify({ text: note, tag: oldTag });
        saveLocalMembers(membersMap);
    }
    alert("評語已儲存");
}

// =====================================================
// ===  更名
// =====================================================
async function renameP(old) {
    const n = prompt("請輸入新名稱:", old);
    if (!n || n === old) return;

    if (storageMode === 'local') {
        let db = getLocalMembers();
        if (db[n]) return alert("錯誤：新名稱已存在");
        db[n] = { ...db[old], id: n }; delete db[old];
        saveLocalMembers(db);
        let hists = getLocalHistories();
        hists.forEach(h => {
            let rawData = {};
            try { rawData = JSON.parse(h.raw_json || '{}'); } catch (e) { }
            let changed = false;
            const replaceName = (arr) => {
                if (!Array.isArray(arr)) return arr;
                return arr.map(p => { if (p.name === old) { p.name = n; changed = true; } return p; });
            };
            if (rawData.gA) rawData.gA = replaceName(rawData.gA);
            if (rawData.gB) rawData.gB = replaceName(rawData.gB);
            if (changed) h.raw_json = JSON.stringify(rawData);
        });
        saveLocalHistories(hists);
        alert("本地更名成功！");
        await fetchAllHistories();
        loadDbData();
    } else {
        try {
            const res = await fetch(`${WORKER_URL}/api/rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
                body: JSON.stringify({ oldId: old, newId: n })
            });
            const data = await res.json();
            if (!res.ok) { alert("更名失敗：" + (data.error || res.status)); return; }
            alert(`更名成功！歷史戰報資料已自動歸戶到新名字，無需重寫。`);
            await fetchAllHistories();
            loadDbData();
        } catch (e) { alert("更名失敗，請稍後再試：" + e.message); }
    }
}

// =====================================================
// ===  合併成員
// =====================================================
async function mergeP(fromId) {
    const toId = prompt(`將「${fromId}」的所有記錄合併到哪個成員 ID？\n（輸入目標成員的現有 ID）`);
    if (!toId || toId === fromId) return;

    const fromMember = dbMembersMap.find(m => m.id === fromId);
    const toMember = dbMembersMap.find(m => m.id === toId);

    if (!toMember) { alert(`找不到目標成員「${toId}」，請確認 ID 是否正確。`); return; }

    if (!confirm(`確認將「${fromId}」（${fromMember?.matches || 0}場）合併到「${toId}」（${toMember?.matches || 0}場）？\n合併後「${fromId}」將被刪除，無法還原！`)) return;

    try {
        if (storageMode === 'cloud' && currentUser) {
            const res = await fetch(`${WORKER_URL}/api/merge-member`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
                body: JSON.stringify({ fromId, toId })
            });
            const data = await res.json();
            if (!res.ok) { alert("合併失敗：" + (data.error || res.status)); return; }

            // ✅ 合併後重新拉取並計算
            await fetchAllHistories();
            await loadDbData();

            // ✅ 更新合併目標的 note（last_job 已由 loadDbData 重算）
            const merged = dbMembersMap.find(m => m.id === toId);
            if (merged) {
                const notePayload = { id: toId, note: JSON.stringify({ text: merged.note || '', tag: merged.tag || 'none', last_job: merged.last_job }) };
                await fetch(WORKER_URL + "/api/update-note", {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + currentUser.token },
                    body: JSON.stringify(notePayload)
                });
            }

            alert(`合併成功！歷史戰報資料已自動歸戶，職業已按最新一場自動判定。`);
        } else {
            let db = getLocalMembers();
            if (!db[toId]) db[toId] = { id: toId, last_job: '', matches: 0, total_dmg: 0, note: '' };
            if (db[fromId]) {
                db[toId].matches = (db[toId].matches || 0) + (db[fromId].matches || 0);
                db[toId].total_dmg = (db[toId].total_dmg || 0) + (db[fromId].total_dmg || 0);
                delete db[fromId];
            }
            let hists = getLocalHistories();
            hists.forEach(h => {
                let rawData = {};
                try { rawData = JSON.parse(h.raw_json || '{}'); } catch (e) { }
                let changed = false;
                const replaceName = (arr) => {
                    if (!Array.isArray(arr)) return arr;
                    return arr.map(p => { if (p.name === fromId) { p.name = toId; changed = true; } return p; });
                };
                if (rawData.gA) rawData.gA = replaceName(rawData.gA);
                if (rawData.gB) rawData.gB = replaceName(rawData.gB);
                if (changed) h.raw_json = JSON.stringify(rawData);
            });
            saveLocalMembers(db);
            saveLocalHistories(hists);
            await fetchAllHistories();
            await loadDbData();
            alert(`本地合併成功！職業已按最新一場自動判定。`);
        }
    } catch (e) { alert("合併失敗：" + e.message); }
}

// =====================================================
// ===  雷達圖欄位定義
// =====================================================
function getRadarCols(job) {
    if (job === '素問') return [{ l: '助攻', k: 'assist' }, { l: '資源', k: 'resource' }, { l: '治療', k: 'heal' }, { l: '承傷', k: 'takeDmg' }, { l: '存活', k: 'death' }, { l: '化羽/清泉', k: 'spring' }];
    if (job === '潮光') return [{ l: '擊敗', k: 'kill' }, { l: '助攻', k: 'assist' }, { l: '資源', k: 'resource' }, { l: '人傷', k: 'pDmg' }, { l: '塔傷', k: 'bDmg' }, { l: '承傷', k: 'takeDmg' }, { l: '存活', k: 'death' }, { l: '化羽/清泉', k: 'spring' }];
    if (job === '九靈') return [{ l: '擊敗', k: 'kill' }, { l: '助攻', k: 'assist' }, { l: '資源', k: 'resource' }, { l: '人傷', k: 'pDmg' }, { l: '塔傷', k: 'bDmg' }, { l: '承傷', k: 'takeDmg' }, { l: '存活', k: 'death' }, { l: '焚骨', k: 'bone' }];
    return [{ l: '擊敗', k: 'kill' }, { l: '助攻', k: 'assist' }, { l: '資源', k: 'resource' }, { l: '人傷', k: 'pDmg' }, { l: '塔傷', k: 'bDmg' }, { l: '承傷', k: 'takeDmg' }, { l: '存活', k: 'death' }];
}

// =====================================================
// ===  分享功能
// =====================================================
function showShareSection() { const s = document.getElementById('share-section'); if (s) s.style.display = 'block'; }

// 分享選單（頂欄🔗按鈕）：彈窗自選 幫眾版 / 管理版 / 共享給其他帳號
function openShareMenu() {
    const admin = !isViewMode && storageMode === 'cloud' && currentUser;
    const existing = document.getElementById('share-menu-modal');
    if (existing) existing.remove();

    const opt = (icon, title, desc, fn) => `
        <button class="share-opt" onclick="document.getElementById('share-menu-modal').remove(); ${fn}">
            <span class="share-opt-ic">${icon}</span>
            <span class="share-opt-txt"><b>${title}</b><small>${desc}</small></span>
        </button>`;

    const modal = document.createElement('div');
    modal.id = 'share-menu-modal';
    modal.className = 'share-menu-overlay';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div class="share-menu-card">
            <div class="share-menu-head">
                <h3 style="margin:0;">🔗 分享戰報</h3>
                <button class="share-menu-x" onclick="document.getElementById('share-menu-modal').remove()" aria-label="關閉">✕</button>
            </div>
            ${opt('📋', '複製幫眾版', '唯讀鏈結，可自選要分享哪幾場', "copyShareLink('view')")}
            ${admin ? opt('📋', '複製管理版', '可編輯鏈結，僅供管理員使用', "copyShareLink('admin')") : ''}
            ${admin ? opt('🔀', '共享給其他帳號', '把戰報分享到另一個登入帳號', 'openShareTransfer()') : ''}
        </div>`;
    document.body.appendChild(modal);
}

function openSharePicker() {
    if (storageMode === 'local') {
        if (!confirm('⚠️ 目前為本地模式，分享鏈結需先同步至雲端。\n是否仍要繼續？')) return;
    }
    const existingModal = document.getElementById('share-picker-modal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.id = 'share-picker-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);display:flex;justify-content:center;align-items:center;z-index:2100;';
    modal.innerHTML = `
        <div style="background:white;padding:28px;border-radius:16px;width:520px;max-width:95vw;max-height:90vh;display:flex;flex-direction:column;gap:10px;">
            <h3 style="margin:0;">📤 選擇要分享的戰報（唯讀版）</h3>
            <div style="display:flex;gap:8px;flex-wrap:wrap;padding:10px;background:#f8f9fa;border-radius:8px;">
                <input type="text" id="share-search-input" placeholder="🔍 搜尋幫會 / 日期..."
                    style="padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:12px;flex:1;min-width:120px;"
                    oninput="filterShareList()">
                <select id="share-time-filter" style="padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px;" onchange="onShareTimeChange()">
                    <option value="all">全部時間</option>
                    <option value="7">最近一周</option>
                    <option value="30">最近一個月</option>
                    <option value="90">最近三個月</option>
                    <option value="365">最近一年</option>
                    <option value="custom">自訂範圍...</option>
                </select>
                <select id="share-type-filter" style="padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px;" onchange="filterShareList()">
                    <option value="all">全部類型</option>
                    <option value="幫戰">幫戰</option>
                    <option value="約戰">約戰</option>
                    <option value="其他">其他</option>
                </select>
                <select id="share-wl-filter" style="padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px;" onchange="filterShareList()">
                    <option value="all">全部勝負</option>
                    <option value="win">勝利</option>
                    <option value="loss">失敗</option>
                </select>
            </div>
            <div id="share-date-range" style="display:none;gap:8px;align-items:center;flex-wrap:wrap;">
                <input type="date" id="share-date-from" style="padding:5px;border:1px solid #ddd;border-radius:6px;font-size:12px;flex:1;" oninput="filterShareList()">
                <span style="color:#aaa;font-size:12px;">至</span>
                <input type="date" id="share-date-to" style="padding:5px;border:1px solid #ddd;border-radius:6px;font-size:12px;flex:1;" oninput="filterShareList()">
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
                <button class="btn btn-outline" style="font-size:12px;padding:4px 10px;" onclick="toggleAllShare(true)">全選</button>
                <button class="btn btn-outline" style="font-size:12px;padding:4px 10px;" onclick="toggleAllShare(false)">取消全選</button>
                <span id="share-count-label" style="font-size:12px;color:#888;"></span>
            </div>
            <div id="share-list" style="flex:1;overflow-y:auto;border:1px solid #eee;border-radius:8px;max-height:320px;">
                ${buildShareListHTML()}
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button class="btn btn-outline" onclick="document.getElementById('share-picker-modal').remove()">取消</button>
                <button class="btn btn-primary" onclick="confirmShareLink()">📋 產生唯讀分享鏈結</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    updateShareCount();
}

function buildShareListHTML() {
    const sorted = [...allHistories].sort((a, b) => new Date(b.date) - new Date(a.date));
    return sorted.map(h => {
        let resTag = '', matchType = '', rawResult = '', rawType = '';
        try {
            const d = JSON.parse(h.raw_json);
            rawResult = d.result || '';
            rawType = d.matchType || '幫戰';
            resTag = rawResult === 'win'
                ? '<span style="background:#4caf50;color:white;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:bold;">勝</span>'
                : '<span style="background:#e57373;color:white;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:bold;">敗</span>';
            matchType = `[${fmtType(rawType)}]${d.session ? '【' + d.session + '】' : ''}`;
        } catch (e) { }
        return `<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #f5f5f5;cursor:pointer;" onmouseover="this.style.background='#f8f9fa'" onmouseout="this.style.background=''" class="share-item-row" data-date="${h.date}" data-type="${rawType}" data-result="${rawResult}" data-guild="${h.guild_a.toLowerCase()}">
            <input type="checkbox" class="share-check" value="${h.id}" checked style="width:16px;height:16px;cursor:pointer;" onchange="updateShareCount()">
            <div style="flex:1;font-size:13px;">
                <b>${h.date}</b> <span style="color:#999;font-size:11px;">${matchType}</span> ${resTag}<br>
                <span style="color:#555;">${h.guild_a}</span>
            </div>
        </label>`;
    }).join('');
}

function onShareTimeChange() {
    const val = document.getElementById('share-time-filter').value;
    const rangeDiv = document.getElementById('share-date-range');
    if (val === 'custom') {
        rangeDiv.style.display = 'flex';
    } else {
        rangeDiv.style.display = 'none';
        filterShareList();
    }
}

function filterShareList() {
    const q = (document.getElementById('share-search-input')?.value || '').toLowerCase();
    const timeVal = document.getElementById('share-time-filter')?.value || 'all';
    const typeVal = document.getElementById('share-type-filter')?.value || 'all';
    const wlVal = document.getElementById('share-wl-filter')?.value || 'all';
    const fromDate = document.getElementById('share-date-from')?.value || '';
    const toDate = document.getElementById('share-date-to')?.value || '';

    document.querySelectorAll('.share-item-row').forEach(row => {
        const date = row.dataset.date || '';
        const type = row.dataset.type || '';
        const result = row.dataset.result || '';
        const guild = row.dataset.guild || '';

        let show = true;
        if (q && !guild.includes(q) && !date.includes(q)) show = false;
        if (typeVal !== 'all' && type !== typeVal) show = false;
        if (wlVal !== 'all' && result !== wlVal) show = false;
        if (!isWithinFilter(date, timeVal, fromDate, toDate)) show = false;

        row.style.display = show ? '' : 'none';
    });
    updateShareCount();
}

function toggleAllShare(checked) {
    document.querySelectorAll('.share-check').forEach(cb => {
        if (cb.closest('.share-item-row').style.display !== 'none') cb.checked = checked;
    });
    updateShareCount();
}

function updateShareCount() {
    const total = document.querySelectorAll('.share-check').length;
    const checked = document.querySelectorAll('.share-check:checked').length;
    const label = document.getElementById('share-count-label');
    if (label) label.textContent = `已選 ${checked} / ${total} 場`;
}

function confirmShareLink() {
    const selected = [...document.querySelectorAll('.share-check:checked')].map(cb => cb.value);
    if (selected.length === 0) { alert('請至少勾選一場！'); return; }
    const url = new URL(window.location.href.split('?')[0]);
    if (currentUser?.share_id) url.searchParams.set('share', currentUser.share_id);
    url.searchParams.set('mode', 'view');
    if (selected.length < allHistories.length) url.searchParams.set('ids', selected.join(','));
    navigator.clipboard.writeText(url.toString()).then(() => {
        alert(`✅ 唯讀鏈結已複製！\n包含 ${selected.length} 場戰報。`);
    }).catch(() => { prompt('請手動複製以下鏈結：', url.toString()); });
    document.getElementById('share-picker-modal').remove();
}

function copyShareLink(mode) {
    if (mode === 'view') {
        openSharePicker();
    } else {
        if (storageMode === 'local') {
            if (!confirm('⚠️ 目前為本地模式，分享鏈結需先同步至雲端。\n是否仍要複製鏈結？')) return;
        }
        const url = new URL(window.location.href.split('?')[0]);
        if (currentUser?.share_id) url.searchParams.set('share', currentUser.share_id);
        navigator.clipboard.writeText(url.toString());
        alert("管理版鏈結已複製！");
    }
}

// =====================================================
// ===  ✅ 共享戰報（改用後端 Token，避免 URL 過長）
// =====================================================
function openShareTransfer() {
    if (storageMode !== 'cloud' || !currentUser) {
        alert('請先登入雲端帳號才能使用共享功能。');
        return;
    }

    const existingModal = document.getElementById('share-transfer-modal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.id = 'share-transfer-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);display:flex;justify-content:center;align-items:center;z-index:2100;';
    modal.innerHTML = `
        <div style="background:white;padding:28px;border-radius:16px;width:520px;max-width:95vw;max-height:90vh;display:flex;flex-direction:column;gap:10px;">
            <h3 style="margin:0;">🔀 共享戰報給其他帳號</h3>
            <p style="font-size:13px;color:#666;margin:0;">對方接收後可選擇同步到自己的帳號或本地。共享鏈結 7 天內有效。</p>

            <div style="display:flex;gap:8px;flex-wrap:wrap;padding:10px;background:#f8f9fa;border-radius:8px;">
                <input type="text" id="transfer-search" placeholder="🔍 搜尋..."
                    style="padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:12px;flex:1;" oninput="filterTransferList()">
                <select id="transfer-time" style="padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px;" onchange="filterTransferList()">
                    <option value="all">全部時間</option>
                    <option value="7">最近一周</option>
                    <option value="30">最近一個月</option>
                    <option value="90">最近三個月</option>
                    <option value="365">最近一年</option>
                </select>
                <select id="transfer-type" style="padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px;" onchange="filterTransferList()">
                    <option value="all">全部類型</option>
                    <option value="幫戰">幫戰</option>
                    <option value="約戰">約戰</option>
                    <option value="其他">其他</option>
                </select>
                <select id="transfer-wl" style="padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px;" onchange="filterTransferList()">
                    <option value="all">全部勝負</option>
                    <option value="win">勝利</option>
                    <option value="loss">失敗</option>
                </select>
            </div>

            <div style="display:flex;gap:8px;align-items:center;">
                <button class="btn btn-outline" style="font-size:12px;padding:4px 10px;" onclick="toggleAllTransfer(true)">全選</button>
                <button class="btn btn-outline" style="font-size:12px;padding:4px 10px;" onclick="toggleAllTransfer(false)">取消全選</button>
                <span id="transfer-count-label" style="font-size:12px;color:#888;"></span>
            </div>

            <div id="transfer-list" style="flex:1;overflow-y:auto;border:1px solid #eee;border-radius:8px;max-height:280px;">
                ${buildTransferListHTML()}
            </div>

            <div style="padding:10px;background:#fff8e1;border-radius:8px;font-size:12px;color:#f57c00;">
                💡 系統會產生一個短鏈結（Token），對方開啟後可選擇同步到自己帳號或本地儲存。
            </div>

            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button class="btn btn-outline" onclick="document.getElementById('share-transfer-modal').remove()">取消</button>
                <button class="btn btn-primary" style="background:#f57c00;" id="confirm-transfer-btn" onclick="confirmTransferLink()">🔗 產生共享鏈結</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    updateTransferCount();
}

function buildTransferListHTML() {
    const sorted = [...allHistories].sort((a, b) => new Date(b.date) - new Date(a.date));
    return sorted.map(h => {
        let resTag = '', matchType = '', rawResult = '', rawType = '';
        try {
            const d = JSON.parse(h.raw_json);
            rawResult = d.result || '';
            rawType = d.matchType || '幫戰';
            resTag = rawResult === 'win'
                ? '<span style="background:#4caf50;color:white;border-radius:4px;padding:1px 5px;font-size:11px;">勝</span>'
                : '<span style="background:#e57373;color:white;border-radius:4px;padding:1px 5px;font-size:11px;">敗</span>';
            matchType = `[${fmtType(rawType)}]${d.session ? '【' + d.session + '】' : ''}`;
        } catch (e) { }
        return `<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #f5f5f5;cursor:pointer;" class="transfer-item-row" data-date="${h.date}" data-type="${rawType}" data-result="${rawResult}" data-guild="${h.guild_a.toLowerCase()}">
            <input type="checkbox" class="transfer-check" value="${h.id}" style="width:16px;height:16px;cursor:pointer;" onchange="updateTransferCount()">
            <div style="flex:1;font-size:13px;">
                <b>${h.date}</b> <span style="color:#999;font-size:11px;">${matchType}</span> ${resTag}<br>
                <span style="color:#555;">${h.guild_a}</span>
            </div>
        </label>`;
    }).join('');
}

function filterTransferList() {
    const q = (document.getElementById('transfer-search')?.value || '').toLowerCase();
    const timeVal = document.getElementById('transfer-time')?.value || 'all';
    const typeVal = document.getElementById('transfer-type')?.value || 'all';
    const wlVal = document.getElementById('transfer-wl')?.value || 'all';
    document.querySelectorAll('.transfer-item-row').forEach(row => {
        const date = row.dataset.date || '', type = row.dataset.type || '', result = row.dataset.result || '', guild = row.dataset.guild || '';
        let show = true;
        if (q && !guild.includes(q) && !date.includes(q)) show = false;
        if (typeVal !== 'all' && type !== typeVal) show = false;
        if (wlVal !== 'all' && result !== wlVal) show = false;
        if (!isWithinFilter(date, timeVal, '', '')) show = false;
        row.style.display = show ? '' : 'none';
    });
    updateTransferCount();
}

function toggleAllTransfer(checked) {
    document.querySelectorAll('.transfer-check').forEach(cb => {
        if (cb.closest('.transfer-item-row').style.display !== 'none') cb.checked = checked;
    });
    updateTransferCount();
}

function updateTransferCount() {
    const total = document.querySelectorAll('.transfer-check').length;
    const checked = document.querySelectorAll('.transfer-check:checked').length;
    const label = document.getElementById('transfer-count-label');
    if (label) label.textContent = `已選 ${checked} / ${total} 場`;
}

// ✅ 修復：改用後端 Token 方式，不再把資料塞進 URL
async function confirmTransferLink() {
    const selected = [...document.querySelectorAll('.transfer-check:checked')].map(cb => cb.value);
    if (selected.length === 0) { alert('請至少勾選一場！'); return; }

    const btn = document.getElementById('confirm-transfer-btn');
    if (btn) { btn.disabled = true; btn.textContent = '產生中…'; }

    try {
        const res = await fetch(WORKER_URL + "/api/transfer/create", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ ids: selected })
        });

        if (!res.ok) {
            const err = await res.json();
            alert('產生失敗：' + (err.error || res.status));
            return;
        }

        const { token } = await res.json();

        const url = new URL(window.location.href.split('?')[0]);
        url.searchParams.set('transfer', token);

        navigator.clipboard.writeText(url.toString()).then(() => {
            alert(`✅ 共享鏈結已複製！\n包含 ${selected.length} 場戰報，7 天內有效。\n\n對方開啟鏈結後，可選擇同步到自己的帳號或本地。`);
        }).catch(() => { prompt('請手動複製以下鏈結：', url.toString()); });

    } catch (e) {
        alert('產生失敗：' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔗 產生共享鏈結'; }
    }

    document.getElementById('share-transfer-modal')?.remove();
}

// ✅ 修復：改用 Token 從後端拉取共享戰報（不再從 URL decode）
async function checkIncomingTransfer(token) {
    try {
        const res = await fetch(`${WORKER_URL}/api/transfer/fetch?token=${encodeURIComponent(token)}`, {
            cache: "no-store"
        });

        if (!res.ok) {
            const err = await res.json();
            alert('⚠️ 無法讀取共享鏈結：' + (err.error || '鏈結可能已過期或不存在'));
            // 清除 URL 參數
            const cleanUrl = new URL(window.location.href);
            cleanUrl.searchParams.delete('transfer');
            window.history.replaceState({}, '', cleanUrl.toString());
            return;
        }

        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) {
            alert('共享鏈結內沒有可接收的戰報。');
            return;
        }

        window._incomingTransferData = data;
        document.getElementById('receive-transfer-list').innerHTML = data.map(h => {
            let resTag = '', matchType = '';
            try {
                const d = JSON.parse(h.raw_json);
                resTag = d.result === 'win'
                    ? '<span style="background:#4caf50;color:white;border-radius:4px;padding:1px 5px;font-size:11px;">勝</span>'
                    : '<span style="background:#e57373;color:white;border-radius:4px;padding:1px 5px;font-size:11px;">敗</span>';
                matchType = `[${fmtType(d.matchType)}]${d.session ? '【' + d.session + '】' : ''}`;
            } catch (e) { }
            return `<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #f5f5f5;cursor:pointer;">
                <input type="checkbox" class="receive-check" value="${h.id}" checked style="width:16px;height:16px;">
                <div style="flex:1;font-size:13px;"><b>${h.date}</b> <span style="color:#999;font-size:11px;">${matchType}</span> ${resTag}<br><span style="color:#555;">${h.guild_a}</span></div>
            </label>`;
        }).join('');
        document.getElementById('receive-transfer-modal').style.display = 'flex';

        // 清除 URL 裡的 transfer 參數，避免重複觸發
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('transfer');
        window.history.replaceState({}, '', cleanUrl.toString());

    } catch (e) {
        console.error('讀取共享資料失敗', e);
        alert('讀取共享鏈結失敗，請稍後再試。');
    }
}

function toggleAllReceive(checked) {
    document.querySelectorAll('.receive-check').forEach(cb => cb.checked = checked);
}

async function confirmReceiveTransfer() {
    const selected = [...document.querySelectorAll('.receive-check:checked')].map(cb => cb.value);
    if (selected.length === 0) { alert('請至少勾選一場！'); return; }

    const data = window._incomingTransferData || [];
    const toImport = data.filter(h => selected.includes(h.id));

    if (storageMode === 'cloud' && currentUser) {
        let success = 0, fail = 0, skipped = 0;
        for (const h of toImport) {
            let rawData = {};
            try { rawData = JSON.parse(h.raw_json || '{}'); } catch (e) { }
            const payload = { id: h.id, fullDateTime: h.date, nameA: h.guild_a, nameB: h.guild_b || '', rawData };
            try {
                const res = await fetch(WORKER_URL + "/api/save-history", {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    const resData = await res.json();
                    if (resData.inserted === 0) skipped++;
                    else success++;
                } else { fail++; }
            } catch (e) { fail++; }
        }
        closeModal('receive-transfer-modal');
        await fetchAllHistories();
        alert(`✅ 已同步到雲端帳號！成功 ${success} 場${skipped > 0 ? `，重複略過 ${skipped} 場` : ''}${fail > 0 ? `，失敗 ${fail} 場` : ''}。`);
    } else {
        const localHistories = getLocalHistories();
        let added = 0;
        toImport.forEach(h => {
            if (!localHistories.find(lh => lh.id === h.id)) {
                localHistories.unshift({ ...h, _source: 'local' });
                added++;
            }
        });
        saveLocalHistories(localHistories);
        closeModal('receive-transfer-modal');
        await fetchAllHistories();
        alert(`✅ 已儲存到本地！新增 ${added} 場（重複已略過）。\n若要分享，請登入後同步到雲端。`);
    }
}

// =====================================================
// ===  請假管理頁（管理員）
// =====================================================
let leaveWindowsCache = [], rosterCache = [];

async function loadLeavePage() {
    if (storageMode !== 'cloud' || !currentUser) {
        alert('請先登入雲端帳號才能使用請假管理。');
        switchPage('report');
        return;
    }
    leaveBack(); // 進入請假管理先顯示選單
}

// 請假管理：選單 ↔ 單一功能子頁
function leaveGoto(name) {
    document.getElementById('leave-menu').style.display = 'none';
    document.getElementById('leave-sub').style.display = 'block';
    ['windows', 'board', 'long', 'lineup', 'roster', 'discord', 'audit'].forEach(n => {
        const el = document.getElementById('lsub-' + n);
        if (el) el.style.display = (n === name) ? 'block' : 'none';
    });
    if (name === 'windows') loadLeaveWindows();
    else if (name === 'board') loadLeaveBoard();
    else if (name === 'long') loadLongLeaves();
    else if (name === 'lineup') loadLineups();
    else if (name === 'roster') loadRoster();
    else if (name === 'discord') loadDiscordSettings();
    else if (name === 'audit') loadAuditLog();
    window.scrollTo(0, 0);
}
function leaveBack() {
    const menu = document.getElementById('leave-menu');
    const sub = document.getElementById('leave-sub');
    if (menu) menu.style.display = 'block';
    if (sub) sub.style.display = 'none';
    window.scrollTo(0, 0);
}

// ---- 各場次請假名單（依職業） ----
let leaveBoardCache = { members: [], windows: [], leaveByWindow: {}, reserveByWindow: {} };
let boardMemberById = {};

async function loadLeaveBoard() {
    try {
        const res = await fetch(WORKER_URL + "/api/leave/board?t=" + Date.now(), {
            cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        leaveBoardCache = await res.json();
    } catch (e) { leaveBoardCache = { members: [], windows: [], leaveByWindow: {}, reserveByWindow: {} }; }
    boardMemberById = {};
    (leaveBoardCache.members || []).forEach(m => { boardMemberById[m.member_id] = m; });
    renderLeaveBoardList();
}

function adminGroupByJob(memberIds, withStats) {
    const groups = {};
    (memberIds || []).forEach(mid => {
        const m = boardMemberById[mid];
        if (!m) return;
        const job = m.job || '未知';
        (groups[job] = groups[job] || []).push(m);
    });
    const jobs = Object.keys(groups).sort();
    if (!jobs.length) return '<div style="color:var(--muted); font-size:12px; padding:4px;">目前沒有人。</div>';
    return jobs.map(job => `
        <div style="margin:8px 0;">
            <div style="font-size:12px; font-weight:bold; color:var(--muted); margin-bottom:4px;">
                <span class="job-tag" style="background:var(--color-${job})">${job}</span>　${groups[job].length} 人
            </div>
            ${groups[job].map(m => `
                <div class="lb-row">
                    <span class="lb-name">${m.display_name}</span>
                    <span class="lb-rec">出席 <b>${m.attendance}</b>　請假 <b>${m.leave}</b>　後備 <b>${m.reserve}</b></span>
                </div>`).join('')}
        </div>`).join('');
}

function renderLeaveBoardList() {
    const el = document.getElementById('leave-board-list');
    if (!el) return;
    const wins = leaveBoardCache.windows || [];
    const openWins = wins.filter(w => w.status === 'open');
    if (!openWins.length) {
        el.innerHTML = '<div style="color:#aaa; font-size:13px; padding:6px;">目前沒有開放中的場次。開放場次後，這裡會顯示每場的請假名單。</div>';
        return;
    }
    el.innerHTML = openWins.map(w => {
        const leaveIds = leaveBoardCache.leaveByWindow[w.window_id] || [];
        const reserveIds = leaveBoardCache.reserveByWindow[w.window_id] || [];
        return `<div class="lw-card" style="flex-direction:column; align-items:stretch;">
            <div style="font-weight:bold;">${w.event_date}　${w.session}　<span class="hash-tag">${fmtType(w.match_type)}</span>${w.title ? ' · ' + w.title : ''}</div>
            <div style="font-size:12px; color:#e57373; font-weight:bold; margin-top:6px;">🙋 已請假（${leaveIds.length}）</div>
            ${adminGroupByJob(leaveIds, false)}
            <div style="font-size:12px; color:#e65100; font-weight:bold; margin-top:6px;">🔶 後備（${reserveIds.length}）</div>
            ${adminGroupByJob(reserveIds, false)}
        </div>`;
    }).join('');
}

// ---- 長期／預先請假（管理員） ----
async function loadLongLeaves() {
    // 成員 datalist（沿用名冊）
    if (!rosterCache.length) { try { await loadRoster(); } catch (e) { } }
    const dl = document.getElementById('ll-member-list');
    if (dl) dl.innerHTML = rosterCache.map(m => `<option value="${(m.display_name || '').replace(/"/g, '&quot;')}"></option>`).join('');
    let rows = [];
    try {
        const res = await fetch(WORKER_URL + "/api/leave/long?t=" + Date.now(), {
            cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        rows = await res.json();
    } catch (e) { rows = []; }
    const el = document.getElementById('long-leave-list');
    if (!el) return;
    if (!Array.isArray(rows) || !rows.length) {
        el.innerHTML = '<div style="color:var(--muted); font-size:13px; padding:6px;">目前沒有長期／預先請假。</div>';
        return;
    }
    const today = ymd(new Date());
    el.innerHTML = rows.map(r => {
        const active = r.from_date <= today && today <= r.to_date;
        const upcoming = r.from_date > today;
        const tag = active ? '<span class="status-pill" style="background:#e8f5e9;color:#2e7d32;">生效中</span>'
            : upcoming ? '<span class="status-pill" style="background:#fff3e0;color:#e65100;">未開始</span>'
                : '<span class="status-pill status-closed">已過期</span>';
        return `<div class="lw-card" style="align-items:center; justify-content:space-between;">
            <div>
                <div style="font-weight:bold;">${r.display_name} ${tag}</div>
                <div style="font-size:12px; color:var(--muted); margin-top:2px;">${r.from_date} ~ ${r.to_date}${r.reason ? '　·　' + r.reason : ''}${r.created_by === 'public' ? '　·　本人申請' : ''}</div>
            </div>
            <button class="btn btn-outline" style="font-size:12px; color:var(--danger);" onclick="deleteLongLeave('${r.id}')">刪除</button>
        </div>`;
    }).join('');
}

async function addLongLeave() {
    const typed = (document.getElementById('ll-member')?.value || '').trim();
    const from_date = document.getElementById('ll-from')?.value || '';
    const to_date = document.getElementById('ll-to')?.value || '';
    const reason = document.getElementById('ll-reason')?.value || '';
    const m = rosterCache.find(x => x.display_name === typed);
    if (!m) { alert('請從名冊選一個正確的成員名字'); return; }
    if (!from_date || !to_date) { alert('請選起訖日期'); return; }
    if (from_date > to_date) { alert('起始日不能晚於結束日'); return; }
    try {
        const res = await fetch(WORKER_URL + "/api/leave/long/create", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ member_id: m.member_id, from_date, to_date, reason })
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); alert('新增失敗：' + (d.error || res.status)); return; }
        document.getElementById('ll-member').value = '';
        document.getElementById('ll-reason').value = '';
        await loadLongLeaves();
    } catch (e) { alert('新增失敗：' + e.message); }
}

async function deleteLongLeave(id) {
    if (!confirm('確定刪除這筆長期請假？（範圍內尚未表態的場次會恢復成未請假）')) return;
    try {
        const res = await fetch(WORKER_URL + "/api/leave/long/delete", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ id })
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); alert('刪除失敗：' + (d.error || res.status)); return; }
        await loadLongLeaves();
    } catch (e) { alert('刪除失敗：' + e.message); }
}

// ---- 出戰班表（綁場次、依職業排、請假灰掉、不重複；純規劃不影響出席）----
let lineupsCache = [];
let editingLineup = null;      // { id, title, window_id, groups:[{name, members:[mid]}] }
let lineupWindows = [];
let lineupUnavail = new Set();  // 這場請假/臨時/長期 → 不可上陣
let lineupActiveGroup = 0;

async function loadLineups() {
    if (!rosterCache.length) { try { await loadRoster(); } catch (e) { } }
    try {
        const w = await fetch(WORKER_URL + "/api/leave/windows?t=" + Date.now(), { cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token } });
        lineupWindows = await w.json();
        if (!Array.isArray(lineupWindows)) lineupWindows = [];
    } catch (e) { lineupWindows = []; }
    try {
        const res = await fetch(WORKER_URL + "/api/lineups?t=" + Date.now(), { cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token } });
        lineupsCache = await res.json();
        if (!Array.isArray(lineupsCache)) lineupsCache = [];
    } catch (e) { lineupsCache = []; }
    editingLineup = null;
    renderLineupHome();
}
function lineupMemberName(mid) { const m = rosterCache.find(x => x.member_id === mid); return m ? m.display_name : (memberIdToDisplayName[mid] || String(mid).slice(0, 6)); }
function lineupMemberJob(mid) { const m = rosterCache.find(x => x.member_id === mid); return (m && m.job) || (boardMemberById[mid] && boardMemberById[mid].job) || '未知'; }
function lineupWinLabel(wid) { const w = lineupWindows.find(x => x.window_id === wid); return w ? `${w.event_date} ${w.session} ${fmtType(w.match_type)}` : ''; }
function lineupAssignedSet() { const s = new Set(); editingLineup.groups.forEach(g => g.members.forEach(m => s.add(m))); return s; }

function renderLineupHome() {
    const el = document.getElementById('lineup-mount');
    if (!el) return;
    const cards = lineupsCache.map(l => {
        const total = (l.groups || []).reduce((s, g) => s + (g.members ? g.members.length : 0), 0);
        const win = l.window_id ? lineupWinLabel(l.window_id) : '未綁場次';
        return `<div class="lw-card" style="align-items:center;justify-content:space-between;">
            <div><div style="font-weight:bold;">${l.title || '(未命名班表)'}</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px;">${win} · ${(l.groups || []).length} 組 · ${total} 人</div></div>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-outline" style="font-size:12px;" onclick="lineupEdit('${l.id}')">編輯</button>
              <button class="btn btn-outline" style="font-size:12px;color:var(--danger);" onclick="lineupDelete('${l.id}')">刪除</button>
            </div></div>`;
    }).join('');
    el.innerHTML = `<p style="font-size:12px;color:var(--muted);margin:0 0 12px;">選一個場次來排陣，請假的人會變灰不能排。班表只是規劃，最終出席仍以戰報為準。</p>
        <button class="btn btn-primary" style="margin-bottom:12px;" onclick="lineupNew()">➕ 新增班表</button>
        ${cards || '<div style="color:var(--muted);font-size:13px;padding:6px;">還沒有班表，點上面新增。</div>'}`;
}
function lineupNew() {
    editingLineup = { id: null, title: '', window_id: '', groups: [{ name: '進攻團', members: [] }, { name: '防守團', members: [] }, { name: '機動團', members: [] }] };
    lineupActiveGroup = 0; lineupUnavail = new Set();
    renderLineupEditor();
}
function lineupEdit(id) {
    const l = lineupsCache.find(x => x.id === id); if (!l) return;
    editingLineup = { id: l.id, title: l.title || '', window_id: l.window_id || '', groups: JSON.parse(JSON.stringify(l.groups || [])) };
    lineupActiveGroup = 0;
    lineupLoadWindowLeave();
}
async function lineupSetWindow(wid) { editingLineup.window_id = wid; await lineupLoadWindowLeave(); }
async function lineupLoadWindowLeave() {
    lineupUnavail = new Set();
    if (editingLineup.window_id) {
        try {
            const res = await fetch(WORKER_URL + "/api/leave/window-members?window_id=" + encodeURIComponent(editingLineup.window_id) + "&t=" + Date.now(), { cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token } });
            const d = await res.json();
            (d.leave || []).forEach(id => lineupUnavail.add(id));
            (d.late || []).forEach(id => lineupUnavail.add(id));
        } catch (e) { }
    }
    renderLineupEditor();
}
function lineupSetActiveGroup(i) { lineupActiveGroup = i; renderLineupEditor(); }

function renderLineupEditor() {
    const el = document.getElementById('lineup-mount');
    if (!el || !editingLineup) return;
    if (lineupActiveGroup >= editingLineup.groups.length) lineupActiveGroup = 0;

    // 場次下拉
    const winOpts = '<option value="">— 選場次（看請假）—</option>' + lineupWindows.map(w =>
        `<option value="${w.window_id}" ${w.window_id === editingLineup.window_id ? 'selected' : ''}>${w.event_date} ${w.session} ${fmtType(w.match_type)}${w.status === 'open' ? '' : '（關閉）'}</option>`).join('');
    // 複製來源（其他班表）
    const copyOpts = '<option value="">— 複製其他班表的陣容 —</option>' + lineupsCache.filter(l => l.id !== editingLineup.id).map(l =>
        `<option value="${l.id}">${l.title || '未命名'}${l.window_id ? '（' + lineupWinLabel(l.window_id) + '）' : ''}</option>`).join('');

    // 分組（可點來設為「作用中」，點職業池的人會加進作用中的組）
    const groupsHtml = editingLineup.groups.map((g, i) => {
        const active = i === lineupActiveGroup;
        const chips = g.members.map(mid => {
            const bad = lineupUnavail.has(mid);
            return `<span class="hash-tag" style="display:inline-flex;gap:5px;align-items:center;${bad ? 'background:#ffe0e0;color:#b0413e;text-decoration:line-through;' : ''}">
                <span class="job-tag" style="background:var(--color-${lineupMemberJob(mid)});font-size:9px;">${lineupMemberJob(mid)}</span>${lineupMemberName(mid)}${bad ? ' ⚠請假' : ''}
                <span style="cursor:pointer;text-decoration:none;" onclick="lineupRemoveMember(${i},'${mid}')">✕</span></span>`;
        }).join('') || '<span style="font-size:12px;color:var(--muted);">點右邊職業池的人加進來</span>';
        return `<div style="border:2px solid ${active ? 'var(--accent)' : 'var(--border)'};border-radius:12px;padding:12px;margin-bottom:10px;background:var(--surface-2);cursor:pointer;" onclick="lineupSetActiveGroup(${i})">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
              ${active ? '<span class="status-pill" style="background:var(--accent-soft);color:var(--accent-strong);">作用中</span>' : ''}
              <input type="text" class="search-input" value="${(g.name || '').replace(/"/g, '&quot;')}" oninput="editingLineup.groups[${i}].name=this.value" onclick="event.stopPropagation()" style="font-weight:bold;width:140px;">
              <span style="font-size:12px;color:var(--muted);">${g.members.length} 人</span>
              <button class="btn btn-outline" style="font-size:11px;padding:3px 8px;color:var(--danger);margin-left:auto;" onclick="event.stopPropagation();lineupRemoveGroup(${i})">刪組</button>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">${chips}</div>
        </div>`;
    }).join('');

    // 可用成員池（依職業分組；已上陣的不出現；請假的變灰不可點）
    const assigned = lineupAssignedSet();
    const pool = rosterCache.filter(m => !assigned.has(m.member_id));
    const byJob = {};
    pool.forEach(m => { (byJob[m.job || '未知'] = byJob[m.job || '未知'] || []).push(m); });
    const jobs = Object.keys(byJob).sort();
    const poolHtml = jobs.length ? jobs.map(j => `
        <div style="margin-bottom:8px;">
          <div style="font-size:12px;font-weight:bold;color:var(--muted);margin-bottom:4px;">
            <span class="job-tag" style="background:var(--color-${j})">${j}</span> ${byJob[j].length}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${byJob[j].map(m => {
                const bad = lineupUnavail.has(m.member_id);
                return `<span class="hash-tag" style="cursor:${bad ? 'not-allowed' : 'pointer'};${bad ? 'opacity:.4;text-decoration:line-through;' : ''}"
                    onclick="${bad ? `alert('${m.display_name} 這場已請假，不能上陣')` : `lineupAssign('${m.member_id}')`}">${m.display_name}${bad ? ' ⚠' : ''}</span>`;
            }).join('')}
          </div>
        </div>`).join('') : '<div style="font-size:12px;color:var(--muted);">全部都排上了。</div>';

    el.innerHTML = `
      <button class="btn btn-outline" style="margin-bottom:12px;" onclick="loadLineups()">← 返回班表列表</button>
      <input type="text" class="search-input" value="${(editingLineup.title || '').replace(/"/g, '&quot;')}" oninput="editingLineup.title=this.value" placeholder="班表名稱（例：7/20 幫戰陣容）" style="margin-bottom:10px;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
        <select class="select-input" style="flex:1;min-width:180px;" onchange="lineupSetWindow(this.value)">${winOpts}</select>
        <select class="select-input" style="flex:1;min-width:180px;" onchange="if(this.value){lineupApplyCopy(this.value);this.value='';}">${copyOpts}</select>
      </div>
      <div style="display:grid;grid-template-columns:1fr;gap:16px;">
        <div>
          <div style="font-size:13px;font-weight:bold;margin-bottom:6px;">分組（點一組設為作用中，再從下方職業池點人加入）</div>
          ${groupsHtml}
          <button class="btn btn-outline" style="font-size:12px;" onclick="lineupAddGroup()">➕ 新增分組</button>
        </div>
        <div>
          <div style="font-size:13px;font-weight:bold;margin-bottom:6px;">可用成員（依職業）· 灰＝已請假</div>
          <div style="border:1px solid var(--border);border-radius:12px;padding:12px;max-height:340px;overflow-y:auto;">${poolHtml}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;">
        <button class="btn btn-primary" onclick="lineupSave()">💾 暫存 / 發佈</button>
        <button class="btn btn-outline" onclick="lineupCopy()">📋 複製成文字</button>
        ${editingLineup.id ? `<button class="btn btn-outline" style="color:var(--danger);" onclick="lineupDelete('${editingLineup.id}')">刪除</button>` : ''}
      </div>`;
}
function lineupAssign(mid) {
    if (lineupUnavail.has(mid)) { alert('他這場已請假，不能上陣'); return; }
    if (lineupAssignedSet().has(mid)) { alert('已經排上了，不能重複'); return; }
    if (!editingLineup.groups.length) { alert('請先新增一個分組'); return; }
    editingLineup.groups[lineupActiveGroup].members.push(mid);
    renderLineupEditor();
}
function lineupAddGroup() { editingLineup.groups.push({ name: '新分組', members: [] }); lineupActiveGroup = editingLineup.groups.length - 1; renderLineupEditor(); }
function lineupRemoveGroup(i) { editingLineup.groups.splice(i, 1); if (lineupActiveGroup >= editingLineup.groups.length) lineupActiveGroup = Math.max(0, editingLineup.groups.length - 1); renderLineupEditor(); }
function lineupRemoveMember(i, mid) { editingLineup.groups[i].members = editingLineup.groups[i].members.filter(x => x !== mid); renderLineupEditor(); }
function lineupApplyCopy(fromId) {
    const src = lineupsCache.find(l => l.id === fromId); if (!src) return;
    const assigned = lineupAssignedSet();
    (src.groups || []).forEach(sg => {
        let tg = editingLineup.groups.find(g => g.name === sg.name);
        if (!tg) { tg = { name: sg.name, members: [] }; editingLineup.groups.push(tg); }
        (sg.members || []).forEach(mid => { if (!assigned.has(mid)) { tg.members.push(mid); assigned.add(mid); } });
    });
    renderLineupEditor();
    const bad = [...lineupAssignedSet()].filter(id => lineupUnavail.has(id));
    if (bad.length) alert('已複製。這些人這場請假了（紅色劃線），請更換：' + bad.map(lineupMemberName).join('、'));
}
async function lineupSave() {
    const bad = [...lineupAssignedSet()].filter(id => lineupUnavail.has(id));
    if (bad.length) { alert('這些人這場已請假，請先更換上陣人員再存：\n' + bad.map(lineupMemberName).join('、')); return; }
    try {
        const res = await fetch(WORKER_URL + "/api/lineups/save", { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token }, body: JSON.stringify({ id: editingLineup.id, title: editingLineup.title, window_id: editingLineup.window_id, groups: editingLineup.groups }) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { alert('儲存失敗：' + (d.error || res.status)); return; }
        editingLineup.id = d.id || editingLineup.id;
        alert('✅ 已儲存');
        await loadLineups();
    } catch (e) { alert('儲存失敗：' + e.message); }
}
function lineupCopy() {
    const lines = [editingLineup.title || '出戰班表'];
    if (editingLineup.window_id) lines.push(lineupWinLabel(editingLineup.window_id));
    editingLineup.groups.forEach(g => {
        lines.push('');
        lines.push(`【${g.name}】(${g.members.length})`);
        const byJob = {};
        g.members.forEach(mid => { const j = lineupMemberJob(mid); (byJob[j] = byJob[j] || []).push(lineupMemberName(mid)); });
        const jobs = Object.keys(byJob);
        if (!jobs.length) lines.push('（無）');
        else jobs.forEach(j => lines.push(`${j}：${byJob[j].join('、')}`));
    });
    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(() => alert('✅ 班表已複製')).catch(() => prompt('請手動複製：', text));
}
async function lineupDelete(id) {
    if (!confirm('確定刪除這個班表？')) return;
    try {
        const res = await fetch(WORKER_URL + "/api/lineups/delete", { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token }, body: JSON.stringify({ id }) });
        if (!res.ok) { const d = await res.json().catch(() => ({})); alert('刪除失敗：' + (d.error || res.status)); return; }
        await loadLineups();
    } catch (e) { alert('刪除失敗：' + e.message); }
}

function buildLeaveLink() {
    const base = window.location.href.split('?')[0].replace(/index\.html$/, '').replace(/[^/]*$/, '');
    const origin = base.endsWith('/') ? base : base + '/';
    const share = currentUser?.share_id || '';
    return origin + 'leave.html?share=' + encodeURIComponent(share);
}

function updateLeaveLinkPreview() {
    const el = document.getElementById('leave-link-preview');
    if (el) el.textContent = buildLeaveLink();
}

function copyLeaveLink() {
    const link = buildLeaveLink();
    navigator.clipboard.writeText(link).then(() => {
        alert('✅ 請假連結已複製！\n把它貼給幫眾即可，無需登入就能請假。');
    }).catch(() => { prompt('請手動複製以下連結：', link); });
}

// ---- 請假場次（已併入各場次名單）----
async function loadLeaveWindows() {
    try {
        const res = await fetch(WORKER_URL + "/api/leave/windows?t=" + Date.now(), {
            cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        leaveWindowsCache = await res.json();
    } catch (e) { leaveWindowsCache = []; }
    await loadLeaveBoard(); // 取得每場的請假/後備名單（依職業）
    renderLeaveWindows();
}

function clearLeaveWindowFilter() {
    document.getElementById('lw-filter-status').value = 'all';
    document.getElementById('lw-filter-from').value = '';
    document.getElementById('lw-filter-to').value = '';
    renderLeaveWindows();
}

function renderLeaveWindows() {
    const el = document.getElementById('leave-windows-list');
    const hint = document.getElementById('lw-filter-hint');
    if (!el) return;
    if (!leaveWindowsCache.length) {
        el.innerHTML = '<div style="color:#aaa; font-size:13px; padding:10px;">尚未開放任何請假場次。</div>';
        if (hint) hint.textContent = '';
        return;
    }
    const statusF = document.getElementById('lw-filter-status')?.value || 'all';
    const fromF = document.getElementById('lw-filter-from')?.value || '';
    const toF = document.getElementById('lw-filter-to')?.value || '';
    const hasFilter = statusF !== 'all' || fromF || toF;

    let list = leaveWindowsCache.filter(w => {
        if (statusF !== 'all' && w.status !== statusF) return false;
        if (fromF && w.event_date < fromF) return false;
        if (toF && w.event_date > toF) return false;
        return true;
    });
    // 沒有任何篩選時，只顯示最近 5 場，避免場次多了難管理
    let truncated = false;
    if (!hasFilter && list.length > 5) { list = list.slice(0, 5); truncated = true; }
    if (hint) {
        hint.textContent = hasFilter
            ? `符合 ${list.length} 場`
            : (truncated ? `顯示最近 5 場（共 ${leaveWindowsCache.length} 場，用上方日期搜尋更早的）` : '');
    }
    if (!list.length) {
        el.innerHTML = '<div style="color:#aaa; font-size:13px; padding:10px;">沒有符合條件的場次。</div>';
        return;
    }
    el.innerHTML = list.map(w => {
        const leaveIds = (leaveBoardCache.leaveByWindow && leaveBoardCache.leaveByWindow[w.window_id]) || [];
        const reserveIds = (leaveBoardCache.reserveByWindow && leaveBoardCache.reserveByWindow[w.window_id]) || [];
        return `
        <div class="lw-card" style="flex-direction:column; align-items:stretch; gap:8px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; flex-wrap:wrap;">
                <div>
                    <b>${w.event_date}　${w.session}</b>
                    <span class="hash-tag" style="margin-left:4px;">${fmtType(w.match_type)}</span>
                    <span class="status-pill ${w.status === 'open' ? 'status-open' : 'status-closed'}">${w.status === 'open' ? '開放中' : '已關閉'}</span>
                    <div style="font-size:12px; color:#97a0ad; margin-top:2px;">
                        ${w.title || ''} · 🙋 請假 ${w.leave_count} 人 · 🔶 後備 ${w.reserve_count} 人
                    </div>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button class="btn btn-outline" style="font-size:12px; padding:4px 10px;" onclick="openWindowDetail('${w.window_id}')">管理名單</button>
                    <button class="btn btn-outline" style="font-size:12px; padding:4px 10px;" onclick="toggleLeaveWindow('${w.window_id}', '${w.status === 'open' ? 'closed' : 'open'}', ${w.version})">${w.status === 'open' ? '關閉' : '開放'}</button>
                    <button class="btn btn-outline" style="font-size:12px; padding:4px 10px; color:var(--danger);" onclick="deleteLeaveWindow('${w.window_id}')">刪除</button>
                </div>
            </div>
            <div style="border-top:1px dashed var(--border); padding-top:6px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                <button class="btn btn-outline" style="font-size:12px; padding:3px 10px;" onclick="toggleWinList('${w.window_id}', this)">▸ 名單</button>
                <button class="btn btn-outline" style="font-size:12px; padding:3px 10px;" onclick="copyWinList('${w.window_id}')">📋 複製名單</button>
            </div>
            <div id="winlist-${w.window_id}" style="display:none;">${buildWinListHTML(leaveIds, reserveIds)}</div>
        </div>`;
    }).join('');
}

// 依職業精簡排列（名字用、分隔，不佔高度）
function buildWinListHTML(leaveIds, reserveIds) {
    const byJob = (ids) => {
        const groups = {};
        (ids || []).forEach(mid => {
            const m = boardMemberById[mid];
            if (!m) return;
            (groups[m.job || '未知'] = groups[m.job || '未知'] || []).push(m.display_name);
        });
        const jobs = Object.keys(groups).sort();
        if (!jobs.length) return '<span style="color:var(--muted);">無</span>';
        return jobs.map(j => `<div style="margin:2px 0;"><span class="job-tag" style="background:var(--color-${j})">${j}</span> ${groups[j].join('、')}</div>`).join('');
    };
    return `
        <div style="font-size:12px; color:#e57373; font-weight:bold; margin-top:4px;">🙋 已請假（${leaveIds.length}）</div>
        <div style="font-size:13px;">${byJob(leaveIds)}</div>
        <div style="font-size:12px; color:#e65100; font-weight:bold; margin-top:6px;">🔶 後備（${reserveIds.length}）</div>
        <div style="font-size:13px;">${byJob(reserveIds)}</div>`;
}

function toggleWinList(windowId, btn) {
    const el = document.getElementById('winlist-' + windowId);
    if (!el) return;
    const open = el.style.display !== 'none';
    el.style.display = open ? 'none' : 'block';
    if (btn) btn.textContent = open ? '▸ 名單' : '▾ 名單';
}

// 複製這場的請假/後備名單（純文字，依職業）
function copyWinList(windowId) {
    const w = (leaveWindowsCache || []).find(x => x.window_id === windowId);
    const leaveIds = (leaveBoardCache.leaveByWindow && leaveBoardCache.leaveByWindow[windowId]) || [];
    const reserveIds = (leaveBoardCache.reserveByWindow && leaveBoardCache.reserveByWindow[windowId]) || [];
    const byJobText = (ids) => {
        const groups = {};
        (ids || []).forEach(mid => { const m = boardMemberById[mid]; if (m) (groups[m.job || '未知'] = groups[m.job || '未知'] || []).push(m.display_name); });
        const jobs = Object.keys(groups).sort();
        if (!jobs.length) return '　無';
        return jobs.map(j => `　${j}：${groups[j].join('、')}`).join('\n');
    };
    const head = w ? `${w.event_date} ${w.session} [${fmtType(w.match_type)}]${w.title ? ' · ' + w.title : ''}` : '';
    const text = `${head}\n🙋 請假（${leaveIds.length}）：\n${byJobText(leaveIds)}\n🔶 後備（${reserveIds.length}）：\n${byJobText(reserveIds)}`;
    navigator.clipboard.writeText(text).then(() => alert('✅ 名單已複製')).catch(() => prompt('請手動複製：', text));
}

async function createLeaveWindow() {
    const event_date = document.getElementById('lw-date').value;
    const session = document.getElementById('lw-session').value;
    const match_type = document.getElementById('lw-type').value;
    const title = document.getElementById('lw-title').value;
    if (!event_date) { alert('請選擇日期'); return; }
    try {
        const res = await fetch(WORKER_URL + "/api/leave/windows/create", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ event_date, session, title, match_type })
        });
        const data = await res.json();
        if (res.status === 409 && data.existing_window_id) {
            // 同日期+場次已存在（可能是先前沒刪乾淨）→ 讓使用者選擇刪掉舊的重建
            if (confirm(`「${event_date} ${session}」已經有一個場次了。\n是否刪除舊的、重新建立？\n（舊場次的請假/後備紀錄會一併清除）`)) {
                await fetch(WORKER_URL + "/api/leave/windows/delete", {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
                    body: JSON.stringify({ window_id: data.existing_window_id })
                });
                return createLeaveWindow(); // 重試
            }
            await Promise.all([loadLeaveWindows(), loadLeaveBoard()]); // 刷新讓使用者看到那個舊場次
            return;
        }
        if (!res.ok) { alert('開放失敗：' + (data.error || res.status)); return; }
        document.getElementById('lw-title').value = '';
        await Promise.all([loadLeaveWindows(), loadLeaveBoard()]);
    } catch (e) { alert('開放失敗：' + e.message); }
}

async function toggleLeaveWindow(windowId, status, version) {
    try {
        const res = await fetch(WORKER_URL + "/api/leave/windows/toggle", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ window_id: windowId, status, expected_version: version })
        });
        const data = await res.json();
        if (res.status === 409) { alert('⚠️ ' + (data.error || '場次已被更新') + '，將重新載入'); await loadLeaveWindows(); return; }
        if (!res.ok) { alert('操作失敗：' + (data.error || res.status)); return; }
        await loadLeaveWindows();
    } catch (e) { alert('操作失敗：' + e.message); }
}

async function deleteLeaveWindow(windowId) {
    if (!confirm('確定刪除這個場次？該場所有請假/後備紀錄也會一併刪除。')) return;
    try {
        const res = await fetch(WORKER_URL + "/api/leave/windows/delete", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ window_id: windowId })
        });
        if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            alert('刪除失敗：' + (d.error || res.status) + '\n（若你的後端還是舊版，請先更新 Worker 再試）');
            return;
        }
        await Promise.all([loadLeaveWindows(), loadLeaveBoard()]);
    } catch (e) { alert('刪除失敗：' + e.message); }
}

// ---- 場次名單管理 Modal ----
async function openWindowDetail(windowId) {
    const w = leaveWindowsCache.find(x => x.window_id === windowId);
    if (!w) return;
    window._wdWindow = w;
    document.getElementById('wd-title').textContent = `${w.event_date} ${w.session} · 名單管理`;
    document.getElementById('wd-search').value = '';
    // 職業篩選選單（用名冊職業）
    const jobFilter = document.getElementById('wd-job-filter');
    if (jobFilter) {
        // 職業來源：戰報算出的職業（boardMemberById）最準，補上名冊職業與 9 大職業預設
        const jobs = [...new Set([
            ...JOB_LIST,
            ...rosterCache.map(m => m.job).filter(Boolean),
            ...Object.values(boardMemberById).map(b => b.job).filter(Boolean)
        ])];
        jobFilter.innerHTML = '<option value="all">全部職業</option>' + jobs.map(j => `<option value="${j}">${j}</option>`).join('');
        jobFilter.value = 'all';
    }
    const stF = document.getElementById('wd-status-filter'); if (stF) stF.value = 'all';
    document.getElementById('window-detail-modal').style.display = 'flex';
    document.getElementById('wd-list').innerHTML = '<div style="color:#aaa;">載入中…</div>';
    try {
        if (!rosterCache.length) await loadRoster();
        if (!Object.keys(boardMemberById).length) await loadLeaveBoard();
        const res = await fetch(WORKER_URL + "/api/leave/window-members?window_id=" + encodeURIComponent(windowId) + "&t=" + Date.now(), {
            cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        const data = await res.json();
        window._wdLeave = new Set(data.leave || []);
        window._wdReserve = new Set(data.reserve || []);
        window._wdNoshow = new Set(data.noshow || []);
        window._wdLate = new Set(data.late || []);
        window._wdSub = data.substitutes || {}; // 本人 -> 代打者
        window._wdAttend = new Set(data.attend || []); // 手動補登出席
        renderWindowDetail();
    } catch (e) {
        document.getElementById('wd-list').innerHTML = '<div style="color:var(--danger);">載入失敗：' + e.message + '</div>';
    }
}

function renderWindowDetail() {
    const q = (document.getElementById('wd-search').value || '').toLowerCase().trim();
    const leaveSet = window._wdLeave || new Set();
    const reserveSet = window._wdReserve || new Set();
    const jobF = document.getElementById('wd-job-filter')?.value || 'all';
    const statusF = document.getElementById('wd-status-filter')?.value || 'all';
    const list = rosterCache.filter(m => {
        if (q && !m.display_name.toLowerCase().includes(q)) return false;
        const bm = boardMemberById[m.member_id];
        const job = m.job || (bm && bm.job) || '未知';
        if (jobF !== 'all' && job !== jobF) return false;
        if (statusF === 'leave' && !leaveSet.has(m.member_id)) return false;
        if (statusF === 'reserve' && !reserveSet.has(m.member_id)) return false;
        if (statusF === 'none' && (leaveSet.has(m.member_id) || reserveSet.has(m.member_id))) return false;
        return true;
    });
    // 依職業分組（優先用名冊自身的 job，退而用看板資料）
    const groups = {};
    list.forEach(m => {
        const bm = boardMemberById[m.member_id];
        const job = m.job || (bm && bm.job) || '未知';
        (groups[job] = groups[job] || []).push(m);
    });
    const jobs = Object.keys(groups).sort();
    if (!jobs.length) { document.getElementById('wd-list').innerHTML = '<div style="color:#aaa; padding:8px;">沒有符合的成員。</div>'; return; }
    document.getElementById('wd-list').innerHTML = jobs.map(job => `
        <div style="margin-bottom:10px;">
            <div style="font-size:12px; font-weight:bold; color:#6b7684; border-bottom:1px solid #f0f0f0; padding-bottom:3px; margin-bottom:4px;">
                <span class="job-tag" style="background:var(--color-${job})">${job}</span>（${groups[job].length}）
            </div>
            ${groups[job].map(m => {
                const onLeave = leaveSet.has(m.member_id);
                const onReserve = reserveSet.has(m.member_id);
                const onNoshow = (window._wdNoshow || new Set()).has(m.member_id);
                const onLate = (window._wdLate || new Set()).has(m.member_id);
                const onAttend = (window._wdAttend || new Set()).has(m.member_id);
                const subId = (window._wdSub || {})[m.member_id];
                const subName = subId ? (memberIdToDisplayName[subId] || rosterCache.find(x => x.member_id === subId)?.display_name || subId.slice(0, 6)) : '';
                const bm = boardMemberById[m.member_id];
                const statNum = bm ? `<span style="color:#97a0ad; font-size:11px; margin-left:4px;">${bm.attendance}/${bm.leave}/${bm.reserve}</span>` : '';
                return `<div class="roster-row" style="flex-wrap:wrap; gap:4px;">
                    <div style="font-size:13px;">${m.display_name}${statNum}
                        ${onLeave ? '<span class="status-pill status-closed">請假</span>' : ''}
                        ${onReserve ? '<span class="badge-reserve" style="display:inline-block;">後備</span>' : ''}
                        ${onNoshow ? '<span class="status-pill status-closed">No-show</span>' : ''}
                        ${onLate ? '<span class="badge-reserve" style="display:inline-block;">臨時</span>' : ''}
                        ${onAttend ? '<span class="status-pill" style="background:#e8f5e9; color:#2e7d32;">補登出席</span>' : ''}
                        ${subId ? `<span class="badge-reserve" style="display:inline-block; background:#5c6bc0;">代打：${subName} <span style="cursor:pointer;" onclick="wdUnsetSub('${m.member_id}')">✕</span></span>` : ''}
                    </div>
                    <div style="display:flex; gap:4px; flex-wrap:wrap; margin-left:auto;">
                        <button class="btn btn-outline" style="font-size:11px; padding:3px 7px; color:#2e7d32;" onclick="wdAction('${m.member_id}', '${onAttend ? 'attend_unset' : 'attend_set'}')">${onAttend ? '取消出席' : '補登出席'}</button>
                        <button class="btn btn-outline" style="font-size:11px; padding:3px 7px;" onclick="wdAction('${m.member_id}', '${onLeave ? 'leave_cancel' : 'leave_request'}')">${onLeave ? '取消請假' : '請假'}</button>
                        <button class="btn btn-outline" style="font-size:11px; padding:3px 7px; color:#e65100;" onclick="wdAction('${m.member_id}', '${onReserve ? 'reserve_unset' : 'reserve_set'}')">${onReserve ? '取消後備' : '後備'}</button>
                        <button class="btn btn-outline" style="font-size:11px; padding:3px 7px; color:var(--danger);" onclick="wdAction('${m.member_id}', '${onNoshow ? 'noshow_unset' : 'noshow_set'}')">${onNoshow ? '取消No-show' : 'No-show'}</button>
                        <button class="btn btn-outline" style="font-size:11px; padding:3px 7px; color:#8e6b00;" onclick="wdAction('${m.member_id}', '${onLate ? 'late_unset' : 'late_set'}')">${onLate ? '取消臨時' : '臨時請假'}</button>
                        <button class="btn btn-outline" style="font-size:11px; padding:3px 7px; color:#5c6bc0;" onclick="wdSetSub('${m.member_id}')">代替上號</button>
                    </div>
                </div>`;
            }).join('')}
        </div>`).join('');
}

async function wdAction(memberId, action) {
    const w = window._wdWindow;
    if (!w) return;
    try {
        const res = await fetch(WORKER_URL + "/api/leave/actions", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ window_id: w.window_id, member_id: memberId, action })
        });
        if (!res.ok) { const d = await res.json(); alert('操作失敗：' + (d.error || res.status)); return; }
        // 本地更新狀態
        if (action === 'leave_request') window._wdLeave.add(memberId);
        else if (action === 'leave_cancel') window._wdLeave.delete(memberId);
        else if (action === 'reserve_set') window._wdReserve.add(memberId);
        else if (action === 'reserve_unset') window._wdReserve.delete(memberId);
        else if (action === 'noshow_set') window._wdNoshow.add(memberId);
        else if (action === 'noshow_unset') window._wdNoshow.delete(memberId);
        else if (action === 'late_set') window._wdLate.add(memberId);
        else if (action === 'late_unset') window._wdLate.delete(memberId);
        else if (action === 'attend_set') (window._wdAttend = window._wdAttend || new Set()).add(memberId);
        else if (action === 'attend_unset') window._wdAttend && window._wdAttend.delete(memberId);
        renderWindowDetail();
        loadLeaveWindows();
    } catch (e) { alert('操作失敗：' + e.message); }
}

// 代替上號：本人請假、他人代打，出席算到代打者身上
function wdSetSub(memberId) {
    const w = window._wdWindow;
    if (!w) return;
    const self = rosterCache.find(x => x.member_id === memberId);
    const existing = document.getElementById('wd-sub-modal');
    if (existing) existing.remove();
    const datalist = rosterCache
        .filter(x => x.member_id !== memberId)
        .map(x => `<option value="${(x.display_name || '').replace(/"/g, '&quot;')}"></option>`).join('');
    const modal = document.createElement('div');
    modal.id = 'wd-sub-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;justify-content:center;align-items:center;z-index:2400;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div style="background:var(--surface);color:var(--ink);border:1px solid var(--border);padding:22px;border-radius:14px;width:360px;max-width:92vw;display:flex;flex-direction:column;gap:12px;">
            <h3 style="margin:0;">代替上號</h3>
            <p style="font-size:13px;color:var(--muted);margin:0;"><b>${self?.display_name || memberId}</b> 本人請假，這場由誰幫他開號打？出席會算到代打者身上，本人記為請假。</p>
            <input type="text" id="wd-sub-input" class="search-input" list="wd-sub-list" placeholder="🔍 輸入代打者名字…" autocomplete="off" style="width:100%;box-sizing:border-box;">
            <datalist id="wd-sub-list">${datalist}</datalist>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button class="btn btn-outline" onclick="document.getElementById('wd-sub-modal').remove()">取消</button>
                <button class="btn btn-primary" onclick="wdConfirmSub('${memberId}')">確認</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    setTimeout(() => document.getElementById('wd-sub-input')?.focus(), 50);
}

async function wdConfirmSub(memberId) {
    const w = window._wdWindow;
    const typed = (document.getElementById('wd-sub-input')?.value || '').trim();
    const sub = rosterCache.find(x => x.display_name === typed);
    if (!sub) { alert('找不到「' + (typed || '（空白）') + '」，請從清單選一個名字'); return; }
    if (sub.member_id === memberId) { alert('代打者不能是本人'); return; }
    try {
        const res = await fetch(WORKER_URL + "/api/leave/substitute", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ window_id: w.window_id, member_id: memberId, substitute_member_id: sub.member_id })
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); alert('設定失敗：' + (d.error || res.status)); return; }
        (window._wdSub = window._wdSub || {})[memberId] = sub.member_id;
        window._wdLeave.add(memberId); // 後端會把本人記為請假
        document.getElementById('wd-sub-modal')?.remove();
        renderWindowDetail();
    } catch (e) { alert('設定失敗：' + e.message); }
}

async function wdUnsetSub(memberId) {
    const w = window._wdWindow;
    if (!w) return;
    try {
        const res = await fetch(WORKER_URL + "/api/leave/substitute", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ window_id: w.window_id, member_id: memberId, substitute_member_id: '' })
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); alert('取消失敗：' + (d.error || res.status)); return; }
        if (window._wdSub) delete window._wdSub[memberId];
        renderWindowDetail();
    } catch (e) { alert('取消失敗：' + e.message); }
}

// 批量後備：貼上一串名字，比對名冊後整批設為後備
function openBulkReserve() {
    const w = window._wdWindow;
    if (!w) return;
    const existing = document.getElementById('bulk-reserve-modal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'bulk-reserve-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;justify-content:center;align-items:center;z-index:2400;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div style="background:var(--surface);color:var(--ink);border:1px solid var(--border);padding:22px;border-radius:14px;width:420px;max-width:92vw;display:flex;flex-direction:column;gap:12px;">
            <h3 style="margin:0;">📋 批量設為後備</h3>
            <p style="font-size:12px;color:var(--muted);margin:0;">貼上名字（每行一個，或用逗號/空白分隔）。系統會比對名冊，整批設為這場（${w.event_date} ${w.session}）的後備。</p>
            <textarea id="bulk-reserve-input" class="search-input" rows="8" placeholder="小明&#10;阿華&#10;老王" style="width:100%;box-sizing:border-box;resize:vertical;font-family:inherit;"></textarea>
            <div id="bulk-reserve-msg" style="font-size:12px;color:var(--muted);"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button class="btn btn-outline" onclick="document.getElementById('bulk-reserve-modal').remove()">取消</button>
                <button class="btn btn-primary" id="bulk-reserve-go" onclick="runBulkReserve()">設為後備</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    setTimeout(() => document.getElementById('bulk-reserve-input')?.focus(), 50);
}

async function runBulkReserve() {
    const w = window._wdWindow;
    const raw = document.getElementById('bulk-reserve-input')?.value || '';
    const names = [...new Set(raw.split(/[\n,、，\s]+/).map(s => s.trim()).filter(Boolean))];
    const msg = document.getElementById('bulk-reserve-msg');
    if (!names.length) { if (msg) msg.textContent = '請先貼上名字'; return; }
    // 比對名冊
    const nameToId = {};
    rosterCache.forEach(m => { nameToId[m.display_name] = m.member_id; });
    const matched = [], unmatched = [];
    names.forEach(n => { const id = nameToId[n]; if (id) matched.push({ n, id }); else unmatched.push(n); });
    if (!matched.length) { if (msg) msg.textContent = '名冊裡都找不到：' + unmatched.join('、'); return; }
    const btn = document.getElementById('bulk-reserve-go');
    if (btn) { btn.disabled = true; btn.textContent = '處理中…'; }
    let ok = 0, fail = 0;
    for (const { id } of matched) {
        try {
            const res = await fetch(WORKER_URL + "/api/leave/actions", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
                body: JSON.stringify({ window_id: w.window_id, member_id: id, action: 'reserve_set' })
            });
            if (res.ok) { ok++; window._wdReserve.add(id); } else fail++;
        } catch (e) { fail++; }
    }
    if (btn) { btn.disabled = false; btn.textContent = '設為後備'; }
    renderWindowDetail();
    loadLeaveWindows();
    let summary = `✅ 已設為後備 ${ok} 人`;
    if (fail) summary += `，失敗 ${fail} 人`;
    if (unmatched.length) summary += `\n⚠️ 名冊找不到（未處理）：${unmatched.join('、')}`;
    alert(summary);
    if (!unmatched.length && !fail) document.getElementById('bulk-reserve-modal')?.remove();
    else if (msg) msg.textContent = summary;
}

// 補登出席：漏戰報時貼上出席名單，整批標記為出席
function openBulkAttend() {
    const w = window._wdWindow;
    if (!w) return;
    const existing = document.getElementById('bulk-attend-modal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'bulk-attend-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;justify-content:center;align-items:center;z-index:2400;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div style="background:var(--surface);color:var(--ink);border:1px solid var(--border);padding:22px;border-radius:14px;width:420px;max-width:92vw;display:flex;flex-direction:column;gap:12px;">
            <h3 style="margin:0;">✅ 補登出席</h3>
            <p style="font-size:12px;color:var(--muted);margin:0;">漏生成戰報時用這個。貼上實際出席的名字（每行一個，或逗號/空白分隔），系統比對名冊後整批標記為這場（${w.event_date} ${w.session}）出席。出席率會把這場也算進分母。</p>
            <textarea id="bulk-attend-input" class="search-input" rows="8" placeholder="小明&#10;阿華&#10;老王" style="width:100%;box-sizing:border-box;resize:vertical;font-family:inherit;"></textarea>
            <div id="bulk-attend-msg" style="font-size:12px;color:var(--muted);"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button class="btn btn-outline" onclick="document.getElementById('bulk-attend-modal').remove()">取消</button>
                <button class="btn btn-primary" id="bulk-attend-go" onclick="runBulkAttend()">標記為出席</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    setTimeout(() => document.getElementById('bulk-attend-input')?.focus(), 50);
}

async function runBulkAttend() {
    const w = window._wdWindow;
    const raw = document.getElementById('bulk-attend-input')?.value || '';
    const names = [...new Set(raw.split(/[\n,、，\s]+/).map(s => s.trim()).filter(Boolean))];
    const msg = document.getElementById('bulk-attend-msg');
    if (!names.length) { if (msg) msg.textContent = '請先貼上名字'; return; }
    const nameToId = {};
    rosterCache.forEach(m => { nameToId[m.display_name] = m.member_id; });
    const matched = [], unmatched = [];
    names.forEach(n => { const id = nameToId[n]; if (id) matched.push(id); else unmatched.push(n); });
    if (!matched.length) { if (msg) msg.textContent = '名冊裡都找不到：' + unmatched.join('、'); return; }
    const btn = document.getElementById('bulk-attend-go');
    if (btn) { btn.disabled = true; btn.textContent = '處理中…'; }
    let ok = 0, fail = 0;
    for (const id of matched) {
        try {
            const res = await fetch(WORKER_URL + "/api/leave/actions", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
                body: JSON.stringify({ window_id: w.window_id, member_id: id, action: 'attend_set' })
            });
            if (res.ok) { ok++; (window._wdAttend = window._wdAttend || new Set()).add(id); } else fail++;
        } catch (e) { fail++; }
    }
    if (btn) { btn.disabled = false; btn.textContent = '標記為出席'; }
    renderWindowDetail();
    let summary = `✅ 已補登出席 ${ok} 人`;
    if (fail) summary += `，失敗 ${fail} 人`;
    if (unmatched.length) summary += `\n⚠️ 名冊找不到（未處理）：${unmatched.join('、')}`;
    alert(summary);
    if (!unmatched.length && !fail) document.getElementById('bulk-attend-modal')?.remove();
    else if (msg) msg.textContent = summary;
}

// ---- 名單管理 ----
async function loadRoster() {
    try {
        const res = await fetch(WORKER_URL + "/api/roster?t=" + Date.now(), {
            cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        rosterCache = await res.json();
    } catch (e) { rosterCache = []; }
    renderRosterList();
}

function renderRosterList() {
    const el = document.getElementById('roster-list');
    if (!el) return;
    const q = (document.getElementById('roster-search')?.value || '').toLowerCase().trim();
    const list = rosterCache.filter(m => !q || m.display_name.toLowerCase().includes(q));
    if (!list.length) {
        el.innerHTML = '<div style="color:#aaa; font-size:13px; padding:12px;">名單是空的，用上方批次匯入加入成員。</div>';
        return;
    }
    el.innerHTML = `<div style="padding:8px 12px; font-size:12px; color:#97a0ad;">共 ${rosterCache.length} 人</div>` + list.map(m => `
        <div class="roster-row">
            <span style="font-size:14px;">${m.display_name}</span>
            <div style="display:flex; gap:6px;">
                <button class="btn btn-outline" style="font-size:12px; padding:3px 10px;" onclick="renameRosterMember('${m.member_id}', '${(m.display_name || '').replace(/'/g, "\\'")}')">更名</button>
                <button class="btn btn-outline" style="font-size:12px; padding:3px 10px; color:var(--danger);" onclick="deleteRosterMember('${m.member_id}', '${(m.display_name || '').replace(/'/g, "\\'")}')">移除</button>
            </div>
        </div>`).join('');
}

async function importRoster() {
    const text = document.getElementById('roster-import-text').value || '';
    const names = text.split('\n').map(s => s.trim()).filter(Boolean);
    if (!names.length) { alert('請先貼上名字（一行一個）'); return; }
    try {
        const res = await fetch(WORKER_URL + "/api/roster/import", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ names })
        });
        const data = await res.json();
        if (!res.ok) { alert('匯入失敗：' + (data.error || res.status)); return; }
        document.getElementById('roster-import-text').value = '';
        alert(`✅ 匯入完成：新增 ${data.added} 人，略過重複 ${data.skipped} 人。`);
        await loadRoster();
    } catch (e) { alert('匯入失敗：' + e.message); }
}

async function renameRosterMember(memberId, oldName) {
    const n = prompt('請輸入新名稱：', oldName);
    if (!n || n === oldName) return;
    try {
        const res = await fetch(WORKER_URL + "/api/rename", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ oldId: oldName, newId: n })
        });
        const data = await res.json();
        if (!res.ok) { alert('更名失敗：' + (data.error || res.status)); return; }
        await loadRoster();
    } catch (e) { alert('更名失敗：' + e.message); }
}

async function deleteRosterMember(memberId, name) {
    if (!confirm(`確定把「${name}」從名單移除？\n（歷史戰報與出席紀錄會保留，只是不再出現在請假名單）`)) return;
    try {
        await fetch(WORKER_URL + "/api/roster/delete", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ member_id: memberId })
        });
        // 依目前所在頁面刷新
        const leaveVisible = document.getElementById('page-leave')?.style.display !== 'none';
        const dbVisible = document.getElementById('page-db')?.style.display !== 'none';
        if (leaveVisible) await loadRoster();
        if (dbVisible) await loadDbData();
    } catch (e) { alert('移除失敗：' + e.message); }
}

// ---- Discord 設定 ----
const DISCORD_EVENTS = [
    { key: 'leave_open', label: '🗓️ 開放請假' },
    { key: 'leave_submit', label: '🙋 請假/取消' },
    { key: 'self_join', label: '🆕 自助建檔' },
    { key: 'noshow', label: '⚠️ No-show 警示' },
];

async function loadDiscordSettings() {
    // 站台網址 / 伺服器 ID
    try {
        const res = await fetch(WORKER_URL + "/api/settings/discord?t=" + Date.now(), {
            cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        const data = await res.json();
        const siteEl = document.getElementById('discord-site-url');
        if (siteEl) siteEl.value = data.site_base_url || '';
        const guildEl = document.getElementById('discord-guild-id');
        if (guildEl) {
            const ids = Array.isArray(data.guild_ids) && data.guild_ids.length ? data.guild_ids : (data.discord_guild_id ? [data.discord_guild_id] : []);
            guildEl.value = ids.join('\n');
        }
        window._legacyWebhook = data.discord_webhook_url || '';
    } catch (e) { }
    // 多頻道清單
    let channels = [];
    try {
        const res = await fetch(WORKER_URL + "/api/settings/channels?t=" + Date.now(), {
            cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        const data = await res.json();
        channels = data.channels || [];
    } catch (e) { }
    // 舊的單一 webhook 尚未搬過來 → 幫忙帶入成第一個頻道（全部事件）
    if (channels.length === 0 && window._legacyWebhook) {
        channels = [{ name: '主頻道', webhook_url: window._legacyWebhook, events: [], mention_role_id: '', enabled: true }];
    }
    renderDiscordChannels(channels);
}

function renderDiscordChannels(channels) {
    const wrap = document.getElementById('discord-channels-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    (channels || []).forEach(c => wrap.appendChild(buildDiscordChannelRow(c)));
    if (!channels || channels.length === 0) {
        wrap.innerHTML = '<p style="font-size:12px;color:var(--muted);">尚未新增任何頻道，點「➕ 新增頻道」開始。</p>';
    }
}

function buildDiscordChannelRow(c) {
    c = c || {};
    const row = document.createElement('div');
    row.className = 'dc-channel';
    row.style.cssText = 'border:1px solid var(--border);border-radius:12px;padding:12px;background:var(--surface-2);display:flex;flex-direction:column;gap:8px;';
    const evChecks = DISCORD_EVENTS.map(e => {
        const checked = (Array.isArray(c.events) && c.events.length > 0) ? c.events.includes(e.key) : true;
        return `<label style="font-size:12px;display:inline-flex;align-items:center;gap:4px;margin-right:6px;">
            <input type="checkbox" class="dc-event" data-key="${e.key}" ${checked ? 'checked' : ''}> ${e.label}</label>`;
    }).join('');
    row.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input type="text" class="search-input dc-name" placeholder="頻道名稱（自訂）" value="${(c.name || '').replace(/"/g, '&quot;')}" style="width:160px;">
            <label style="font-size:12px;display:inline-flex;align-items:center;gap:4px;"><input type="checkbox" class="dc-enabled" ${c.enabled === false ? '' : 'checked'}> 啟用</label>
            <button class="btn btn-outline dc-remove" style="font-size:12px;padding:4px 10px;margin-left:auto;" onclick="this.closest('.dc-channel').remove()">🗑️ 移除</button>
        </div>
        <input type="text" class="search-input dc-webhook" placeholder="https://discord.com/api/webhooks/..." value="${(c.webhook_url || '').replace(/"/g, '&quot;')}" style="width:100%;box-sizing:border-box;">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:2px;">${evChecks}</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <span style="font-size:12px;color:var(--muted);">@身分組 ID（選填）：</span>
            <input type="text" class="search-input dc-role" placeholder="只填數字 ID，留空＝不 @" value="${(c.mention_role_id || '').replace(/"/g, '&quot;')}" style="width:200px;" inputmode="numeric">
            <span style="font-size:11px;color:var(--muted);">開開發者模式→伺服器設定→身分組→右鍵複製 ID</span>
        </div>`;
    return row;
}

function addDiscordChannel() {
    const wrap = document.getElementById('discord-channels-list');
    if (!wrap) return;
    // 若目前是「尚未新增」提示，先清掉
    if (wrap.querySelector('p')) wrap.innerHTML = '';
    wrap.appendChild(buildDiscordChannelRow({ name: '', webhook_url: '', events: [], mention_role_id: '', enabled: true }));
}

function collectDiscordChannels() {
    return [...document.querySelectorAll('#discord-channels-list .dc-channel')].map(row => {
        const events = [...row.querySelectorAll('.dc-event')].filter(cb => cb.checked).map(cb => cb.dataset.key);
        return {
            name: row.querySelector('.dc-name').value.trim(),
            webhook_url: row.querySelector('.dc-webhook').value.trim(),
            events,
            mention_role_id: row.querySelector('.dc-role').value.replace(/\D/g, ''),
            enabled: row.querySelector('.dc-enabled').checked
        };
    }).filter(c => c.webhook_url);
}

async function saveDiscordChannels() {
    const channels = collectDiscordChannels();
    try {
        const res = await fetch(WORKER_URL + "/api/settings/channels", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ channels })
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); alert('儲存失敗：' + (d.error || res.status)); return; }
        alert(`✅ 已儲存 ${channels.length} 個通知頻道`);
    } catch (e) { alert('儲存失敗：' + e.message); }
}

async function saveDiscordSettings() {
    const site_base_url = document.getElementById('discord-site-url')?.value.trim() || '';
    const raw = document.getElementById('discord-guild-id')?.value || '';
    const guild_ids = [...new Set(raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean))];
    try {
        const res = await fetch(WORKER_URL + "/api/settings/discord", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ webhook_url: window._legacyWebhook || '', guild_ids, site_base_url })
        });
        if (!res.ok) { const d = await res.json(); alert('儲存失敗：' + (d.error || res.status)); return; }
        alert(`✅ 站台與伺服器設定已儲存（綁定 ${guild_ids.length} 個伺服器）`);
    } catch (e) { alert('儲存失敗：' + e.message); }
}

async function registerDiscordCommands() {
    const msg = document.getElementById('discord-bot-msg');
    if (msg) msg.textContent = '註冊中…';
    try {
        const res = await fetch(WORKER_URL + "/api/discord/register-commands", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token }
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (msg) msg.textContent = '❌ ' + (d.error || res.status) + (d.detail ? '（' + JSON.stringify(d.detail).slice(0, 160) + '）' : '');
            return;
        }
        if (msg) msg.textContent = `✅ 已註冊 ${d.registered} 個指令（${d.scope === 'guild' ? `${d.guilds} 個伺服器即時生效` : '全域，最多等 1 小時'}）`;
    } catch (e) { if (msg) msg.textContent = '❌ ' + e.message; }
}

// ---- 操作紀錄 ----
const AUDIT_LABELS = {
    'roster/create': '新增成員', 'roster/delete': '移除成員', 'roster/rename': '成員更名',
    'roster/merge': '合併成員', 'roster/alias_link': '連結名字', 'roster/import': '批次匯入名單',
    'leave_window/create': '開放請假場次', 'leave_window/toggle': '開關場次', 'leave_window/delete': '刪除場次',
    'roster/self_join': '自助建檔', 'roster/set_category': '設定身份類別',
    'leave_action/leave_request': '登記請假', 'leave_action/leave_cancel': '取消請假',
    'leave_action/reserve_set': '設為後備', 'leave_action/reserve_unset': '取消後備',
    'leave_action/noshow_set': '標記No-show', 'leave_action/noshow_unset': '取消No-show',
    'leave_action/late_set': '標記臨時請假', 'leave_action/late_unset': '取消臨時請假',
    'override/create': '調整次數', 'override/update': '調整次數', 'session/discord_settings': '更新Discord設定'
};

async function loadAuditLog() {
    const el = document.getElementById('audit-log-list');
    if (el) el.innerHTML = '<div style="color:#aaa; font-size:13px; padding:12px;">載入中…</div>';
    try {
        const res = await fetch(WORKER_URL + "/api/audit?limit=200&t=" + Date.now(), {
            cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        const list = await res.json();
        if (!Array.isArray(list) || !list.length) {
            el.innerHTML = '<div style="color:#aaa; font-size:13px; padding:12px;">尚無操作紀錄。</div>';
            return;
        }
        el.innerHTML = list.map(a => {
            const when = new Date(a.created_at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
            const label = AUDIT_LABELS[a.entity_type + '/' + a.action] || (a.entity_type + '/' + a.action);
            let detail = '';
            try {
                const d = JSON.parse(a.detail || '{}');
                if (d.member_id) {
                    const nm = memberIdToDisplayName[d.member_id] || d.member_id.slice(0, 8);
                    detail = ' · ' + nm;
                } else if (d.from && d.to) detail = ` · ${d.from} → ${d.to}`;
                else if (d.display_name) detail = ' · ' + d.display_name;
                else if (d.added != null) detail = ` · +${d.added}`;
                else if (d.event_date) detail = ` · ${d.event_date} ${d.session || ''}`;
            } catch (e) { }
            const who = a.actor === 'public' ? '👥 幫眾' : '🛡️ ' + a.actor;
            return `<div class="audit-row">
                <span class="audit-time">${when}</span> · <b>${label}</b>${detail}
                <span style="color:#97a0ad;"> — ${who}</span>
            </div>`;
        }).join('');
    } catch (e) {
        if (el) el.innerHTML = '<div style="color:var(--danger); font-size:13px; padding:12px;">載入失敗：' + e.message + '</div>';
    }
}

// =====================================================
// ===  UI 工具函數
// =====================================================
let currentPageId = 'report';
const PAGE_TITLES = { report: '戰報解析', db: '成員檔案室', leave: '請假管理', me: '我的' };

function switchPage(p) {
    currentPageId = p;
    ['report', 'db', 'leave', 'me'].forEach(x => {
        const el = document.getElementById('page-' + x);
        if (el) el.style.display = (x === p) ? 'block' : 'none';
    });
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const nav = document.getElementById('nav-' + p);
    if (nav) nav.classList.add('active');
    document.querySelectorAll('.mtab').forEach(el => el.classList.toggle('active', el.dataset.page === p));
    document.querySelectorAll('.tnav').forEach(el => el.classList.toggle('active', el.dataset.page === p));
    const tt = document.getElementById('topbar-title');
    if (tt) tt.textContent = PAGE_TITLES[p] || '';
    updateTopbarContext(p);
    updateFab(p);
    window.scrollTo(0, 0);
    if (p === 'db') loadDbData();
    if (p === 'leave') loadLeavePage();
}

// 側欄已移除：把「歷史列表」搬到戰報頁、「帳號區」搬到我的頁（只需做一次）
function layoutForViewport() {
    const histBlock = document.getElementById('hist-block');
    const acct = document.getElementById('account-block');
    const banner = document.getElementById('mode-banner');
    const reportMount = document.getElementById('report-hist-mount');
    const meMount = document.getElementById('me-account-mount');
    if (histBlock && reportMount && histBlock.parentElement !== reportMount) reportMount.appendChild(histBlock);
    if (banner && meMount && banner.parentElement !== meMount) meMount.appendChild(banner);
    if (acct && meMount && acct.parentElement !== meMount) meMount.appendChild(acct);
}

// 頂欄情境按鈕（桌機）：把常用功能放到頂欄，捲動時也能操作
function updateTopbarContext(p) {
    const el = document.getElementById('topbar-context');
    if (!el) return;
    const admin = !isViewMode && storageMode === 'cloud' && currentUser;
    const b = (icon, text, fn) => `<button class="btn btn-outline ctx-btn" onclick="${fn}"><span class="ci">${icon}</span><span class="ct">${text}</span></button>`;
    let html = '';
    if (p === 'report' && !isViewMode) {
        html = b('📁', '導入', 'openImportModal()') + b('🔗', '分享', 'openShareMenu()');
    } else if (p === 'db' && admin) {
        html = b('➕', '新增', 'openAddMemberModal()') + b('🔄', '同步', 'syncMemberData()')
            + b('🆕', '待確認', 'checkUnresolvedRoster()') + b('📤', '匯出', 'exportMembersCSV()');
    } else if (p === 'leave' && admin) {
        html = b('➕', '場次', 'openWindowModal()');
    }
    el.innerHTML = html;
}

// FAB（手機）：戰報→導入CSV、請假→開場次
function updateFab(p) {
    const fab = document.getElementById('fab');
    if (!fab) return;
    const isMobile = window.innerWidth <= 768;
    let action = null;
    if (p === 'report') action = 'csv';
    else if (p === 'leave') action = 'window';
    window._fabAction = action;
    fab.style.display = (isMobile && action) ? 'grid' : 'none';
}
function fabAction() {
    if (window._fabAction === 'csv') openImportModal();
    else if (window._fabAction === 'window') openWindowModal();
}

// 戰報：歷史列表 ↔ 戰報詳情 切換
function showReportBrowse() {
    const b = document.getElementById('report-browse'), d = document.getElementById('report-detail');
    if (b) b.style.display = 'block';
    if (d) d.style.display = 'none';
    window.scrollTo(0, 0);
}
function showReportDetail() {
    const b = document.getElementById('report-browse'), d = document.getElementById('report-detail');
    if (b) b.style.display = 'none';
    if (d) d.style.display = 'block';
    const rv = document.getElementById('report-view'); if (rv) rv.style.display = 'block';
    window.scrollTo(0, 0);
}
function openImportModal() {
    const m = document.getElementById('import-modal'); if (!m) return;
    const dt = document.getElementById('match-date'); if (dt && !dt.value) dt.valueAsDate = new Date();
    const fn = document.getElementById('import-filename'); if (fn) fn.textContent = '';
    m.style.display = 'flex';
}
function openWindowModal() {
    if (storageMode !== 'cloud' || !currentUser) { alert('請先登入雲端帳號'); return; }
    const m = document.getElementById('window-modal'); if (!m) return;
    const d = document.getElementById('lw-date'); if (d && !d.value) d.valueAsDate = new Date();
    m.style.display = 'flex';
}
function openAddMemberModal() {
    if (storageMode !== 'cloud' || !currentUser) { alert('請先登入雲端帳號才能新增成員'); return; }
    const m = document.getElementById('add-member-modal'); if (!m) return;
    document.getElementById('add-member-name').value = '';
    document.getElementById('add-member-msg').textContent = '';
    const sel = document.getElementById('add-member-category');
    const cats = [...new Set([...CATEGORY_PRESETS, ...dbMembersMap.map(x => x.category).filter(Boolean)])];
    sel.innerHTML = '<option value="">未分類</option>' + cats.map(c => `<option value="${c}">${c}</option>`).join('');
    const jobSel = document.getElementById('add-member-job');
    if (jobSel) {
        const jobs = [...new Set([...JOB_LIST, ...dbMembersMap.map(x => x.last_job).filter(Boolean)])];
        jobSel.innerHTML = '<option value="">未指定</option>' + jobs.map(j => `<option value="${j}">${j}</option>`).join('');
    }
    m.style.display = 'flex';
}
async function submitAddMember() {
    const name = document.getElementById('add-member-name').value.trim();
    const category = document.getElementById('add-member-category').value;
    const job = document.getElementById('add-member-job')?.value || '';
    const msg = document.getElementById('add-member-msg');
    if (!name) { msg.textContent = '請輸入名字'; return; }
    try {
        const res = await fetch(WORKER_URL + "/api/roster/add", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ display_name: name, job })
        });
        const data = await res.json();
        if (!res.ok) { msg.textContent = data.error || '新增失敗'; return; }
        if (category && data.member_id) {
            await fetch(WORKER_URL + "/api/roster/category", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
                body: JSON.stringify({ member_id: data.member_id, category })
            });
        }
        closeModal('add-member-modal');
        await loadDbData();
        const leaveVisible = document.getElementById('page-leave')?.style.display !== 'none';
        if (leaveVisible) loadRoster();
    } catch (e) { msg.textContent = '連線失敗：' + e.message; }
}
// 深色 / 淺色 切換（記憶於 localStorage）
function toggleTheme() {
    const root = document.documentElement;
    const dark = root.getAttribute('data-theme') === 'dark';
    const next = dark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem('nsh_theme', next);
}
function initTheme() {
    const saved = localStorage.getItem('nsh_theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
}

// 可收合篩選：手機點「篩選」展開/收起額外下拉
function toggleFilter(id, btn) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('open');
    if (btn) btn.textContent = el.classList.contains('open') ? '⚙ 收起' : '⚙ 篩選';
}

// 頂欄搜尋鈕：聚焦目前頁面的搜尋欄
function focusPageSearch() {
    const map = { report: 'hist-search', db: 'db-search', leave: 'roster-search' };
    const el = document.getElementById(map[currentPageId]);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => el.focus(), 200); }
}

let _resizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => updateFab(currentPageId), 150);
});

function closeModal(id) { document.getElementById(id).style.display = 'none'; }

function toggleMobileMenu() {
    const sidebar = document.querySelector('.sidebar');
    const btn = document.getElementById('menu-toggle');
    sidebar.classList.toggle('active');
    if (sidebar.classList.contains('active')) {
        btn.innerText = '✕';
        document.body.style.overflow = 'hidden';
    } else {
        btn.innerText = '☰';
        document.body.style.overflow = 'auto';
    }
}

const _origSwitchPage = switchPage;
switchPage = function (p) {
    _origSwitchPage(p);
    if (window.innerWidth <= 768) {
        const sidebar = document.querySelector('.sidebar');
        if (sidebar.classList.contains('active')) toggleMobileMenu();
    }
};
