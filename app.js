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
    const shareNote = document.getElementById('share-local-note');

    if (storageMode === 'cloud' && currentUser) {
        if (banner) { banner.className = 'cloud'; banner.textContent = `☁️ 雲端模式 — ${currentUser.username}（${currentUser.guild || ''}）`; }
        if (authBtn) authBtn.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = '';
        if (syncBtn && !isViewMode) syncBtn.style.display = '';
        if (shareNote) shareNote.style.display = 'none';
    } else {
        if (banner) { banner.className = 'local'; banner.textContent = '💾 本地模式（未登入）'; }
        if (authBtn) authBtn.style.display = '';
        if (logoutBtn) logoutBtn.style.display = 'none';
        if (syncBtn) syncBtn.style.display = 'none';
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
            body: JSON.stringify({ username, password, guild })
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
        currentUser = {
            username: data.username,
            token: data.token,
            guild: data.guild,
            share_id: data.share_id
        };
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

function logoutUser() {
    currentUser = null;
    storageMode = 'local';
    localStorage.removeItem(LOCALSTORAGE_USER_KEY);
    updateModeBanner();
    fetchAllHistories();
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
        try {
            currentUser = JSON.parse(savedUser);
            storageMode = 'cloud';
        } catch (e) { currentUser = null; storageMode = 'local'; }
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

    updateModeBanner();
    initSections();

    await fetchAllHistories();
    const reportId = urlParams.get('id');
    if (reportId) viewHistory(reportId);
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

            // 功能1：如果 URL 有 ids 參數，只顯示指定場次
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
        const hDate = h.date || '';
        const hGuildA = h.guild_a || rawData.nameA || '';
        const hSession = rawData.session || '第一場';
        return hDate === date && hGuildA === guildA && hSession === session;
    });
}

// =====================================================
// ===  saveHistory
// =====================================================
async function saveHistory() {
    const id = "rep_" + Date.now();
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
        id,
        fullDateTime: date,
        nameA: titleA,
        nameB: nameB,
        rawData: {
            nameA: titleA,
            nameB, gA, gB,
            result: mr ? mr.value : "win",
            matchType: mt ? mt.value : "幫戰",
            session: session
        }
    };

    if (storageMode === 'cloud' && currentUser) {
        await saveHistoryToCloud(payload);
    } else {
        saveHistoryToLocal(payload);
    }
}

function saveHistoryToLocal(payload) {
    const localHistories = getLocalHistories();
    const record = {
        id: payload.id,
        date: payload.fullDateTime,
        guild_a: payload.nameA,
        guild_b: payload.nameB,
        raw_json: JSON.stringify(payload.rawData),
        _source: 'local'
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
    if (shareSec) { shareSec.style.display = 'block'; }
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
        alert("已保存成功！成員檔案已同步更新。");
        currentReportId = payload.id;
        const shareSec = document.getElementById('share-section');
        if (shareSec) { shareSec.style.display = 'block'; }
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
            cache: "no-store",
            headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        cloudHistories = await res.json();
    } catch (e) { }

    const conflicts = [];
    const safe = [];

    localHistories.forEach(lh => {
        let lRaw = {};
        try { lRaw = JSON.parse(lh.raw_json || '{}'); } catch (e) { }
        const lDate = lh.date;
        const lGuild = lh.guild_a || lRaw.nameA || '';
        const lSession = lRaw.session || '第一場';

        const conflict = cloudHistories.some(ch => {
            let cRaw = {};
            try { cRaw = JSON.parse(ch.raw_json || '{}'); } catch (e) { }
            return ch.date === lDate && (ch.guild_a || cRaw.nameA || '') === lGuild && (cRaw.session || '第一場') === lSession;
        });

        if (conflict) conflicts.push(lh);
        else safe.push(lh);
    });

    const msgEl = document.getElementById('sync-confirm-msg');
    const listEl = document.getElementById('sync-conflict-list');

    let msg = `本地共 <b>${localHistories.length}</b> 場戰報，其中：<br>`;
    msg += `✅ <b>${safe.length}</b> 場可直接同步<br>`;
    if (conflicts.length > 0) {
        msg += `⚠️ <b>${conflicts.length}</b> 場與雲端存在同幫會+同日期+同場次衝突，請確認是否覆蓋：`;
    }
    msgEl.innerHTML = msg;

    if (conflicts.length > 0) {
        listEl.innerHTML = conflicts.map(h => {
            let r = {};
            try { r = JSON.parse(h.raw_json || '{}'); } catch (e) { }
            return `<div style="padding:4px; border-bottom:1px solid #eee;">${h.date} 【${r.session || '第一場'}】${h.guild_a}</div>`;
        }).join('');
    } else {
        listEl.innerHTML = '';
    }

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
            id: lh.id,
            fullDateTime: lh.date,
            nameA: lh.guild_a || rawData.nameA,
            nameB: lh.guild_b || rawData.nameB,
            rawData
        };
        try {
            const res = await fetch(WORKER_URL + "/api/save-history", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
                body: JSON.stringify(payload)
            });
            if (res.ok) successCount++;
            else failCount++;
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
    if (!confirm("確定刪除？這會同步扣除成員的累計場次！")) return;

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
}

// =====================================================
// ===  CSV 導入
// =====================================================
function handleCSV(file) {
    if (!file) return;
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
// ===  渲染歷史列表
// =====================================================
function isWithinDays(dateStr, days) {
    if (days === 'all') return true;
    const diffTime = Math.abs(new Date() - new Date(dateStr));
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) <= parseInt(days);
}

function renderHistoryList() {
    const search = document.getElementById('hist-search').value.toLowerCase();
    const timeFilter = document.getElementById('hist-time').value;
    const winLoss = document.getElementById('hist-winloss').value;
    const typeFilter = document.getElementById('hist-type').value;

    const filtered = allHistories.filter(h => {
        let matchData = {};
        try { matchData = JSON.parse(h.raw_json); } catch (e) { }

        const matchSearch = h.guild_a.toLowerCase().includes(search) || (h.guild_b && h.guild_b.toLowerCase().includes(search));
        const matchTime = isWithinDays(h.date, timeFilter);
        const matchWL = (winLoss === 'all' || matchData.result === winLoss);
        const matchType = (typeFilter === 'all' || matchData.matchType === typeFilter);

        return matchSearch && matchTime && matchWL && matchType;
    });

    document.getElementById('hist-items').innerHTML = filtered.map(h => {
        let resTag = '', typeLabel = '', sessionLabel = '', sourceBadge = '';
        try {
            const d = JSON.parse(h.raw_json);
            if (d.result === 'win') resTag = '<span class="result-tag win">勝</span>';
            if (d.result === 'loss') resTag = '<span class="result-tag loss">敗</span>';
            typeLabel = `<span style="font-size:10px; color:#999;">[${d.matchType || '幫戰'}]</span>`;
            sessionLabel = d.session ? `<span style="font-size:10px; color:#666; margin-left:3px;">${d.session}</span>` : '';
        } catch (e) { }

        if (h._source === 'local') {
            sourceBadge = ' <span class="local-badge">本地</span>';
        } else if (storageMode === 'cloud') {
            sourceBadge = ' <span class="cloud-badge">雲端</span>';
        }

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
function viewHistory(id) {
    currentReportId = id;
    const h = allHistories.find(x => x.id === id);
    if (h) {
        const d = JSON.parse(h.raw_json);
        gA = d.gA; gB = d.gB; full = [...gA, ...gB];

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
    ['a', 'b'].forEach(t => {
        const data = (t === 'a' ? gA : gB).filter(p => currentJobFilter === 'all' || p.job === currentJobFilter);
        document.getElementById('th-' + t).innerHTML = cols.map(c => `<th onclick="sortBy('${t}', '${c.k}')">${c.l} ↕</th>`).join('');
        document.getElementById('tbody-' + t).innerHTML = data.map(p => `
            <tr onclick="openModal('${p.name}')" style="cursor:pointer;">
                <td>${p.name} ${p.pDmg > avg * 2.5 ? '🔥' : ''}</td>
                <td><span class="job-tag" style="background:var(--color-${p.job})">${p.job}</span></td>
                ${cols.slice(2).map(c => `<td>${p[c.k] >= 10000 ? (p[c.k] / 10000).toFixed(1) + 'w' : p[c.k]}</td>`).join('')}
            </tr>`).join('');
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
化羽：${focusPlayer.spring} ｜ 焚骨：${focusPlayer.bone}
`;

    let parsedNote = "";
    if (storageMode === 'cloud' && currentUser) {
        try {
            const res = await fetch(
                `${WORKER_URL}/api/member-note?id=${encodeURIComponent(focusPlayer.name)}&t=${Date.now()}`,
                { cache: "no-store", headers: { 'Authorization': 'Bearer ' + currentUser.token } }
            );
            const data = await res.json();
            try { const p = JSON.parse(data.note); parsedNote = p.text || ""; } catch (e) { parsedNote = data.note || ""; }
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
                label: '單場職業內分佈',
                data: rCols.map(c => {
                    const max = stats[c.k].max;
                    const min = stats[c.k].min;
                    const val = focusPlayer[c.k];
                    if (c.k === 'death') return ((max - val) / (max - min || 1)) * 100;
                    return ((val - min) / (max - min || 1)) * 100;
                }),
                backgroundColor: 'rgba(142,154,175,0.2)',
                borderColor: '#8e9aaf'
            }]
        },
        options: {
            animation: false,
            devicePixelRatio: Math.round(window.devicePixelRatio) || 2,
            scales: { r: { min: 0, max: 100, ticks: { display: false } } }
        }
    });
}

// =====================================================
// ===  Modal：成員檔案室詳細
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

    const jobEl = document.getElementById('mm-job');
    if (jobEl) {
        const jobSet = new Set(dbMembersMap.map(x => x.last_job));
        jobEl.innerHTML = [...jobSet].map(j => `<option value="${j}" ${j === m.last_job ? 'selected' : ''}>${j}</option>`).join('');
    }

    const jobViewEl = document.getElementById('mm-job-view');
    if (jobViewEl) {
        jobViewEl.innerText = m.last_job;
        jobViewEl.style.display = 'inline-block';
    }

    const recent = m.histories
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 5);

    document.getElementById('mm-history-list').innerHTML = recent.map(h => {
        // 按該場的職業決定顯示哪些欄位
        const hJob = h.stats.job || m.last_job;
        const snapCols = getRadarCols(hJob);
        const snapHtml = snapCols.map(c => {
            const val = h.stats[c.k] ?? 0;
            // 承傷/治療/輸出/塔傷以萬為單位
            const display = (c.k === 'pDmg' || c.k === 'bDmg' || c.k === 'heal' || c.k === 'takeDmg')
                ? (val / 10000).toFixed(1) + 'w'
                : val;
            return `<span style="margin-right:8px;"><b>${c.l}</b>:${display}</span>`;
        }).join('');
        return `<div style="padding:8px 6px; border-bottom:1px solid #eee;">
            <div style="margin-bottom:3px;">
                <b>[${h.date}]</b>
                <span style="color:var(--accent); font-size:11px;">[${h.type || '幫戰'}]</span>
                ${h.session ? `<span style="font-size:11px;">【${h.session}】</span>` : ''}
                <span style="font-size:11px; color:#999;">${h.title}</span>
                <span class="job-tag" style="background:var(--color-${hJob}); font-size:10px; margin-left:4px;">${hJob}</span>
            </div>
            <div style="font-size:12px; color:#555; flex-wrap:wrap; display:flex;">${snapHtml}</div>
        </div>`;
    }).join('');

    const rCols = getRadarCols(m.last_job);
    const avgStats = {};
    rCols.forEach(c => { avgStats[c.k] = m.aggr[c.k] / m.matches; });

    const classPeers = dbMembersMap.filter(x => x.last_job === m.last_job && x.matches > 0);
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
                label: '綜合能力分佈',
                data: rCols.map(c => {
                    const max = globalStats[c.k].max;
                    const min = globalStats[c.k].min;
                    const val = avgStats[c.k];
                    if (c.k === 'death') return ((max - val) / (max - min || 1)) * 100;
                    return ((val - min) / (max - min || 1)) * 100;
                }),
                backgroundColor: 'rgba(251,192,45,0.2)',
                borderColor: '#fbc02d'
            }]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: true,
            devicePixelRatio: Math.round(window.devicePixelRatio) || 2,
            scales: { r: { min: 0, max: 100, ticks: { display: false } } }
        }
    });
}

// =====================================================
// ===  成員檔案室
// =====================================================
async function loadDbData() {
    const timeFilter = document.getElementById('db-time').value;
    const filteredHistories = allHistories.filter(h => isWithinDays(h.date, timeFilter));
    totalReportsInTimeframe = filteredHistories.length;

    let noteMap = {};
    const jobSet = new Set();

    try {
        let dbRaw = [];

        if (shareId) {
            const res = await fetch(WORKER_URL + "/api/members?t=" + Date.now() + "&share=" + shareId, { cache: "no-store" });
            dbRaw = await res.json();
        } else if (storageMode === 'cloud' && currentUser) {
            const res = await fetch(WORKER_URL + "/api/members?t=" + Date.now(), {
                cache: "no-store",
                headers: { 'Authorization': 'Bearer ' + currentUser.token }
            });
            dbRaw = await res.json();
        } else {
            const membersMap = getLocalMembers();
            dbRaw = Object.values(membersMap);
        }

        dbRaw.forEach(m => {
            let noteStr = "", tagStr = "none";
            try { const p = JSON.parse(m.note); noteStr = p.text || ""; tagStr = p.tag || "none"; }
            catch (e) { noteStr = m.note || ""; }
            // 改職業功能：優先讀取 note JSON 裡的 last_job（由 changeJobP/saveMemberProfile 寫入）
            let storedJob = m.last_job;
            try { const pj = JSON.parse(m.note); if (pj.last_job) storedJob = pj.last_job; } catch(e) {}
            noteMap[m.id] = { note: noteStr, tag: tagStr, lastJob: storedJob };
            if (m.last_job) jobSet.add(m.last_job);
        });
    } catch (e) {
        console.error("載入成員備註失敗", e);
    }

    const jobSelect = document.getElementById('db-job');
    const currJob = jobSelect.value;

    const map = {};
    filteredHistories.forEach(h => {
        try {
            const d = JSON.parse(h.raw_json);
            const aName = d.nameA || h.guild_a;
            const type = d.matchType || "幫戰";
            const session = d.session || "第一場";

            d.gA.forEach(p => {
                if (!map[p.name]) {
                    map[p.name] = {
                        id: p.name,
                        matches: 0,
                        histories: [],
                        aggr: {},
                        counts: { "幫戰": 0, "約戰": 0, "其他": 0 }
                    };
                }
                map[p.name].matches++;
                map[p.name].counts[type] = (map[p.name].counts[type] || 0) + 1;
                map[p.name].histories.push({ date: h.date, title: aName, stats: p, type: type, session: session });
                map[p.name].last_job = p.job;
                jobSet.add(p.job);

                cols.slice(2).forEach(c => {
                    map[p.name].aggr[c.k] = (map[p.name].aggr[c.k] || 0) + (p[c.k] || 0);
                });
            });
        } catch (e) { }
    });

    jobSelect.innerHTML = '<option value="all">全部職業</option>' + [...jobSet].map(j => `<option value="${j}">${j}</option>`).join('');
    jobSelect.value = currJob || 'all';

    dbMembersMap = Object.values(map).map(m => {
        m.note = noteMap[m.id]?.note || "";
        m.tag = noteMap[m.id]?.tag || "none";
        m.last_job = m.last_job || noteMap[m.id]?.lastJob || "未知";
        m.rate = totalReportsInTimeframe > 0 ? (m.matches / totalReportsInTimeframe * 100) : 0;
        return m;
    });

    renderDbTable();
}

function renderDbTable() {
    const search = document.getElementById('db-search').value.toLowerCase();
    const jobF = document.getElementById('db-job').value;
    const tagF = document.getElementById('db-tag').value;

    let data = dbMembersMap.filter(m => {
        const matchS = m.id.toLowerCase().includes(search);
        const matchJ = jobF === 'all' || m.last_job === jobF;
        const matchT = tagF === 'all' || m.tag === tagF;
        return matchS && matchJ && matchT;
    });

    data.sort((a, b) => {
        let va = a[dbSort.key], vb = b[dbSort.key];
        if (typeof va === 'string') return dbSort.asc ? va.localeCompare(vb) : vb.localeCompare(va);
        return dbSort.asc ? va - vb : vb - va;
    });

    document.getElementById('db-table-body').innerHTML = data.map(m => `
        <tr onclick="openMemberDetail('${m.id}')" style="cursor:pointer">
            <td><b>${m.id}</b></td>
            <td><span class="job-tag" style="background:var(--color-${m.last_job})">${m.last_job}</span></td>
            <td>${m.tag !== 'none' ? `<span class="hash-tag">${m.tag}</span>` : ''}</td>
            <td>${m.matches} 場</td>
            <td style="font-size:11px; color:#666;">
                ⚔️${m.counts['幫戰'] || 0} / 🤝${m.counts['約戰'] || 0} / 📝${m.counts['其他'] || 0}
            </td>
            <td>${m.rate.toFixed(1)}%</td>
            <td>${m.note || ''}</td>
            <td class="admin-only">
                <button class="btn btn-outline" style="padding:2px 8px;" onclick="event.stopPropagation(); renameP('${m.id}')">更名</button>
                <button class="btn btn-outline" style="padding:2px 8px;" onclick="event.stopPropagation(); mergeP('${m.id}')">合併</button>
                <button class="btn btn-outline" style="padding:2px 8px;" onclick="event.stopPropagation(); changeJobP('${m.id}')">改職業</button>
            </td>
        </tr>
    `).join('');
}

function sortDb(key) {
    if (dbSort.key === key) dbSort.asc = !dbSort.asc;
    else { dbSort.key = key; dbSort.asc = false; }
    renderDbTable();
}

async function saveMemberProfile() {
    const newNote = document.getElementById('mm-note').value;
    const newTag = document.getElementById('mm-tag').value;
    const newJob = document.getElementById('mm-job')?.value || focusPlayer.last_job;

    if (storageMode === 'cloud' && currentUser) {
        // 把職業也存進 note JSON，讓後端下次讀取時可以回傳
        const payload = { id: focusPlayer.id, note: JSON.stringify({ text: newNote, tag: newTag, last_job: newJob }) };
        await fetch(WORKER_URL + "/api/update-note", {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify(payload)
        });
        // 立即更新前端快取，不等重新整理
        const target = dbMembersMap.find(x => x.id === focusPlayer.id);
        if (target) target.last_job = newJob;
    } else {
        const membersMap = getLocalMembers();
        if (!membersMap[focusPlayer.id]) membersMap[focusPlayer.id] = { id: focusPlayer.id, last_job: newJob, matches: 0, total_dmg: 0, note: '' };
        membersMap[focusPlayer.id].note = JSON.stringify({ text: newNote, tag: newTag, last_job: newJob });
        membersMap[focusPlayer.id].last_job = newJob;
        saveLocalMembers(membersMap);
    }

    alert("檔案已更新！");
    closeModal('member-modal');
    await loadDbData();
}

async function saveNoteOnly() {
    const note = document.getElementById('m-note').value;
    if (storageMode === 'cloud' && currentUser) {
        const res = await fetch(`${WORKER_URL}/api/member-note?id=${encodeURIComponent(focusPlayer.name)}&t=${Date.now()}`, {
            headers: { 'Authorization': 'Bearer ' + currentUser.token }
        });
        const data = await res.json();
        let oldTag = "none";
        try { oldTag = JSON.parse(data.note).tag || "none"; } catch (e) { }
        const payload = { id: focusPlayer.name, note: JSON.stringify({ text: note, tag: oldTag }) };
        await fetch(WORKER_URL + "/api/update-note", {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify(payload)
        });
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

        db[n] = { ...db[old], id: n };
        delete db[old];
        saveLocalMembers(db);

        let hists = getLocalHistories();
        hists.forEach(h => {
            let rawData = {};
            try { rawData = JSON.parse(h.raw_json || '{}'); } catch (e) { }
            let changed = false;
            const replaceName = (arr) => {
                if (!Array.isArray(arr)) return arr;
                return arr.map(p => {
                    if (p.name === old) { p.name = n; changed = true; }
                    return p;
                });
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
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + currentUser.token
                },
                body: JSON.stringify({ oldId: old, newId: n })
            });

            const data = await res.json();

            if (!res.ok) {
                alert("更名失敗：" + (data.error || res.status));
                return;
            }

            alert(`更名成功！已同步更新 ${data.updated || 0} 場戰報。`);
            await fetchAllHistories();
            loadDbData();

        } catch (e) {
            alert("更名失敗，請稍後再試：" + e.message);
        }
    }
}

async function mergeP(fromId) {
    const toId = prompt(`將「${fromId}」的所有記錄合併到哪個成員 ID？\n（輸入目標成員的現有 ID）`);
    if (!toId || toId === fromId) return;

    if (!confirm(`確認將「${fromId}」（${dbMembersMap.find(m => m.id === fromId)?.matches || 0}場）合併到「${toId}」？\n合併後「${fromId}」將被刪除，無法還原！`)) return;

    try {
        const res = await fetch(`${WORKER_URL}/api/merge-member`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + currentUser.token
            },
            body: JSON.stringify({ fromId, toId })
        });
        const data = await res.json();
        if (!res.ok) { alert("合併失敗：" + (data.error || res.status)); return; }
        alert(`合併成功！已同步更新 ${data.updated} 場戰報。`);
        await fetchAllHistories();
        loadDbData();
    } catch (e) {
        alert("合併失敗：" + e.message);
    }
}

// =====================================================
// ===  功能2：改職業（獨立函數，與合併/更名不衝突）
// =====================================================
async function changeJobP(memberId) {
    const member = dbMembersMap.find(m => m.id === memberId);
    if (!member) return;

    const allJobs = [...new Set(dbMembersMap.map(m => m.last_job).filter(Boolean))];
    const knownJobs = ['碎夢', '神相', '血河', '九靈', '玄機', '龍吟', '鐵衣', '素問', '潮光'];
    const jobOptions = [...new Set([...knownJobs, ...allJobs])];

    const existing = document.getElementById('change-job-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'change-job-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);display:flex;justify-content:center;align-items:center;z-index:2200;';
    modal.innerHTML = `
        <div style="background:white;padding:24px;border-radius:14px;width:320px;max-width:95vw;">
            <h3 style="margin:0 0 16px;">✏️ 更改職業</h3>
            <p style="font-size:13px;color:#666;margin:0 0 12px;">成員：<b>${memberId}</b><br>目前職業：<b>${member.last_job || '未知'}</b></p>
            <select id="new-job-select" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:14px;margin-bottom:16px;">
                ${jobOptions.map(j => `<option value="${j}" ${j === member.last_job ? 'selected' : ''}>${j}</option>`).join('')}
            </select>
            <div style="display:flex;gap:8px;">
                <button class="btn btn-outline" style="flex:1;" onclick="document.getElementById('change-job-modal').remove()">取消</button>
                <button class="btn btn-primary" style="flex:1;" onclick="confirmChangeJob('${memberId}')">✅ 確認</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

async function confirmChangeJob(memberId) {
    const newJob = document.getElementById('new-job-select').value;
    if (!newJob) return;
    const member = dbMembersMap.find(m => m.id === memberId);
    if (!member) return;

    const noteText = member.note || '';
    const noteTag = member.tag || 'none';

    if (storageMode === 'cloud' && currentUser) {
        const res = await fetch(WORKER_URL + "/api/update-note", {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + currentUser.token },
            body: JSON.stringify({ id: memberId, note: JSON.stringify({ text: noteText, tag: noteTag, last_job: newJob }) })
        });
        if (!res.ok) { alert('更新失敗'); return; }
    } else {
        const membersMap = getLocalMembers();
        if (!membersMap[memberId]) membersMap[memberId] = { id: memberId, last_job: newJob, matches: 0, total_dmg: 0, note: '' };
        membersMap[memberId].last_job = newJob;
        membersMap[memberId].note = JSON.stringify({ text: noteText, tag: noteTag, last_job: newJob });
        saveLocalMembers(membersMap);
    }

    document.getElementById('change-job-modal').remove();
    alert(`✅ 已將「${memberId}」的職業更改為「${newJob}」`);
    member.last_job = newJob;
    renderDbTable();
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
// ===  UI 工具函數
// =====================================================
function switchPage(p) {
    document.getElementById('page-report').style.display = p === 'report' ? 'block' : 'none';
    document.getElementById('page-db').style.display = p === 'db' ? 'block' : 'none';
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('nav-' + p).classList.add('active');
    if (p === 'db') loadDbData();
}

function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function showShareSection() { document.getElementById('share-section').style.display = 'block'; }

// =====================================================
// ===  功能1：勾選分享戰報
// =====================================================
function openSharePicker() {
    if (storageMode === 'local') {
        if (!confirm('⚠️ 目前為本地模式，分享鏈結需先同步至雲端。\n是否仍要繼續？')) return;
    }

    const existingModal = document.getElementById('share-picker-modal');
    if (existingModal) existingModal.remove();

    const sorted = [...allHistories].sort((a, b) => new Date(b.date) - new Date(a.date));

    const modal = document.createElement('div');
    modal.id = 'share-picker-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);display:flex;justify-content:center;align-items:center;z-index:2100;';
    modal.innerHTML = `
        <div style="background:white;padding:28px;border-radius:16px;width:500px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column;gap:12px;">
            <h3 style="margin:0;">📤 選擇要分享的戰報（唯讀版）</h3>

            <input type="text" id="share-search-input" placeholder="🔍 搜尋幫會名稱 / 日期..."
                style="padding:7px 10px;border:1px solid #ddd;border-radius:8px;font-size:13px;"
                oninput="filterShareList()">

            <div style="display:flex;gap:8px;align-items:center;">
                <button class="btn btn-outline" style="font-size:12px;padding:4px 10px;" onclick="toggleAllShare(true)">全選</button>
                <button class="btn btn-outline" style="font-size:12px;padding:4px 10px;" onclick="toggleAllShare(false)">取消全選</button>
                <span id="share-count-label" style="font-size:12px;color:#888;"></span>
            </div>

            <div id="share-list" style="flex:1;overflow-y:auto;border:1px solid #eee;border-radius:8px;max-height:380px;">
                ${sorted.map(h => {
                    let resTag = '', matchType = '';
                    try {
                        const d = JSON.parse(h.raw_json);
                        resTag = d.result === 'win'
                            ? '<span style="background:#4caf50;color:white;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:bold;">勝</span>'
                            : '<span style="background:#e57373;color:white;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:bold;">敗</span>';
                        matchType = `[${d.matchType || '幫戰'}]${d.session ? '【' + d.session + '】' : ''}`;
                    } catch(e) {}
                    return `<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #f5f5f5;cursor:pointer;transition:background 0.15s;" onmouseover="this.style.background='#f8f9fa'" onmouseout="this.style.background=''" class="share-item-row">
                        <input type="checkbox" class="share-check" value="${h.id}" checked style="width:16px;height:16px;cursor:pointer;" onchange="updateShareCount()">
                        <div style="flex:1;font-size:13px;">
                            <b>${h.date}</b> <span style="color:#999;font-size:11px;">${matchType}</span> ${resTag}<br>
                            <span style="color:#555;">${h.guild_a}</span>
                        </div>
                    </label>`;
                }).join('')}
            </div>

            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button class="btn btn-outline" onclick="document.getElementById('share-picker-modal').remove()">取消</button>
                <button class="btn btn-primary" onclick="confirmShareLink()">📋 產生唯讀分享鏈結</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    updateShareCount();
}

function filterShareList() {
    const q = document.getElementById('share-search-input').value.toLowerCase();
    document.querySelectorAll('.share-item-row').forEach(row => {
        row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
}

function toggleAllShare(checked) {
    document.querySelectorAll('.share-check').forEach(cb => {
        // 只勾選當前顯示的
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
    // 唯讀版固定加 mode=view
    url.searchParams.set('mode', 'view');

    // 如果不是全選，加上 ids 參數讓接收方只看到指定場次
    if (selected.length < allHistories.length) {
        url.searchParams.set('ids', selected.join(','));
    }

    navigator.clipboard.writeText(url.toString()).then(() => {
        alert(`✅ 唯讀鏈結已複製！\n包含 ${selected.length} 場戰報。`);
    }).catch(() => {
        // 部分瀏覽器 clipboard 需要用戶互動，fallback
        prompt('請手動複製以下鏈結：', url.toString());
    });
    document.getElementById('share-picker-modal').remove();
}

function copyShareLink(mode) {
    if (mode === 'view') {
        // 唯讀版：開彈窗讓用戶勾選戰報
        openSharePicker();
    } else {
        // 可編輯版：維持原本直接複製
        if (storageMode === 'local') {
            if (!confirm('⚠️ 目前為本地模式，分享鏈結需先同步至雲端。\n是否仍要複製鏈結（他人可能無法開啟）？')) return;
        }
        const url = new URL(window.location.href.split('?')[0]);
        if (currentUser?.share_id) url.searchParams.set('share', currentUser.share_id);
        navigator.clipboard.writeText(url.toString());
        alert("管理版鏈結已複製！");
    }
}

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

// 手機版自動關閉側邊欄
const _origSwitchPage = switchPage;
switchPage = function (p) {
    _origSwitchPage(p);
    if (window.innerWidth <= 768) {
        const sidebar = document.querySelector('.sidebar');
        if (sidebar.classList.contains('active')) toggleMobileMenu();
    }
};
