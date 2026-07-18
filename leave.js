// =====================================================
// ===  公開請假頁（免登入）
// =====================================================
const WORKER_URL = "https://d1-template.cherrycywong0907.workers.dev";
const urlParams = new URLSearchParams(window.location.search);
const shareId = urlParams.get('share');

let board = { guild: "", windows: [], members: [], leaveByWindow: {}, reserveByWindow: {} };
let memberById = {};
let selectedMemberId = null;

const TYPE_ORDER = ['幫戰', '約戰', '其他'];
const JOB_LIST = ['碎夢', '神相', '血河', '九靈', '玄機', '龍吟', '鐵衣', '素問', '潮光'];
function fmtType(t) { return t === '其他' ? '領地戰' : (t || '幫戰'); }
function memberTypeTooltip(m) {
    return TYPE_ORDER.map(t => {
        const a = (m.attendanceByType && m.attendanceByType[t]) || 0;
        const l = (m.leaveByType && m.leaveByType[t]) || 0;
        const r = (m.reserveByType && m.reserveByType[t]) || 0;
        return `${fmtType(t)}：出席 ${a} / 請假 ${l} / 後備 ${r}`;
    }).join('\n');
}

function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1800);
}

async function loadBoard() {
    if (!shareId) {
        document.getElementById('sub-line').textContent = "⚠️ 連結無效（缺少 share 參數）";
        return;
    }
    try {
        // 用 public/board（新舊後端都有這條路徑，避免版本不一致時卡「唯讀模式」）
        const res = await fetch(`${WORKER_URL}/api/leave/public/board?share=${encodeURIComponent(shareId)}&t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            document.getElementById('sub-line').textContent = "⚠️ " + (err.error || "連結無效或已失效");
            return;
        }
        board = await res.json();
        // 相容舊後端：只回傳 roster（沒有 members/統計）時，補成 members 結構
        if ((!board.members || !board.members.length) && Array.isArray(board.roster)) {
            board.members = board.roster.map(r => ({
                member_id: r.member_id, display_name: r.display_name, job: '未知',
                attendance: 0, leave: 0, reserve: 0,
                attendanceByType: {}, leaveByType: {}, reserveByType: {}
            }));
        }
        memberById = {};
        (board.members || []).forEach(m => { memberById[m.member_id] = m; });
        if (board.guild) document.getElementById('guild-title').textContent = `${board.guild} · 請假登記`;
        if (!board.windows || board.windows.length === 0) {
            document.getElementById('empty-state').style.display = 'block';
        }
        // 職業下拉選單
        const jobSel = document.getElementById('join-job');
        if (jobSel && jobSel.options.length <= 1) {
            jobSel.innerHTML = '<option value="">選擇職業（選填）</option>' + JOB_LIST.map(j => `<option value="${j}">${j}</option>`).join('');
        }
        renderNames();
        renderBoard();
        renderOverview();
    } catch (e) {
        document.getElementById('sub-line').textContent = "⚠️ 連線失敗，請稍後再試";
    }
}

// ---- 自助建檔 ----
function toggleJoinForm() {
    const f = document.getElementById('join-form');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
    if (f.style.display === 'block') {
        const s = document.getElementById('name-search').value.trim();
        if (s) document.getElementById('join-name').value = s;
    }
}

async function submitJoin() {
    const name = document.getElementById('join-name').value.trim();
    const job = document.getElementById('join-job').value;
    if (!name) { toast('請輸入名字'); return; }
    try {
        const res = await fetch(`${WORKER_URL}/api/leave/public/join?share=${encodeURIComponent(shareId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, job })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { toast('⚠️ ' + (data.error || '建立失敗')); return; }
        toast(data.existed ? '已找到你的名字' : '✅ 建檔成功');
        document.getElementById('join-form').style.display = 'none';
        // 重新載入看板，並自動選中剛建立的自己
        const newId = data.member_id;
        await loadBoard();
        document.getElementById('name-search').value = '';
        if (newId && memberById[newId]) selectMember(newId);
        else renderNames();
    } catch (e) { toast('⚠️ 連線失敗，請稍後再試'); }
}

// ---- 依職業分組 ----
function groupByJob(memberIds) {
    const groups = {};
    (memberIds || []).forEach(mid => {
        const m = memberById[mid];
        if (!m) return;
        const job = m.job || '未知';
        (groups[job] = groups[job] || []).push(m);
    });
    return groups;
}

function renderJobGroups(memberIds, withStats) {
    const groups = groupByJob(memberIds);
    const jobs = Object.keys(groups).sort();
    if (jobs.length === 0) return '<div class="muted" style="padding:6px;">目前沒有人。</div>';
    return jobs.map(job => `
        <div class="job-group">
            <div class="job-head">${job}（${groups[job].length}）</div>
            ${groups[job].map(m => `<span class="job-chip" title="${memberTypeTooltip(m)}">${m.display_name}${withStats ? ` <span class="stat-num">${m.attendance}/${m.leave}/${m.reserve}</span>` : ''}</span>`).join('')}
        </div>`).join('');
}

// ---- 記住這台裝置用過的名字（不預載全部人）----
function getRecentNames() {
    try { return JSON.parse(localStorage.getItem('nsh_leave_names') || '[]'); } catch (e) { return []; }
}
function addRecentName(m) {
    if (!m) return;
    let list = getRecentNames().filter(x => x.member_id !== m.member_id);
    list.unshift({ member_id: m.member_id, display_name: m.display_name });
    localStorage.setItem('nsh_leave_names', JSON.stringify(list.slice(0, 8)));
}
function removeRecentName(memberId) {
    const list = getRecentNames().filter(x => x.member_id !== memberId);
    localStorage.setItem('nsh_leave_names', JSON.stringify(list));
    renderNames();
}

// ---- 名字搜尋 ----
function renderNames() {
    const q = (document.getElementById('name-search').value || '').toLowerCase().trim();
    const listEl = document.getElementById('name-list');

    if (!q) {
        // 沒搜尋時，只顯示這台裝置用過的名字（對到目前名冊仍存在的）
        const recents = getRecentNames()
            .map(r => memberById[r.member_id] || (board.members || []).find(m => m.display_name === r.display_name))
            .filter(Boolean);
        if (!recents.length) {
            listEl.innerHTML = `<div class="muted">請在上方輸入你的名字搜尋。第一次用之後，這裡會記住你的名字。</div>`;
            return;
        }
        listEl.innerHTML = `<div style="font-size:12px; color:#97a0ad; margin-bottom:6px;">你常用的名字：</div>` +
            recents.map(m => `<span class="name-btn ${m.member_id === selectedMemberId ? 'active' : ''}" onclick="selectMember('${m.member_id}')">${m.display_name} <span onclick="event.stopPropagation(); removeRecentName('${m.member_id}')" style="color:#c9ced6; margin-left:4px;">✕</span></span>`).join('');
        return;
    }

    const matched = (board.members || []).filter(m => m.display_name.toLowerCase().includes(q));
    if (matched.length === 0) {
        listEl.innerHTML = `<div class="muted">找不到「${q}」，請確認拼字，或用下方「自助建檔」。</div>`;
        return;
    }
    listEl.innerHTML = matched.slice(0, 30).map(m =>
        `<span class="name-btn ${m.member_id === selectedMemberId ? 'active' : ''}" onclick="selectMember('${m.member_id}')">${m.display_name}</span>`
    ).join('') + (matched.length > 30 ? `<div class="muted">符合的太多了，再多打幾個字縮小範圍</div>` : '');
}

function selectMember(memberId) {
    selectedMemberId = memberId;
    addRecentName(memberById[memberId]);
    renderNames();
    renderWindows();
}

function renderWindows() {
    const member = memberById[selectedMemberId];
    if (!member) return;
    document.getElementById('selected-name').textContent = member.display_name;
    const statsEl = document.getElementById('selected-stats');
    statsEl.textContent = `出席 ${member.attendance} ｜ 請假 ${member.leave} ｜ 後備 ${member.reserve}（滑鼠移上看各類型）`;
    statsEl.title = memberTypeTooltip(member);
    document.getElementById('window-card').style.display = 'block';

    const wins = board.windows || [];
    if (wins.length === 0) {
        document.getElementById('window-list').innerHTML = `<div class="muted">目前沒有開放中的請假場次。</div>`;
        return;
    }
    document.getElementById('window-list').innerHTML = wins.map(w => {
        const onLeave = (board.leaveByWindow[w.window_id] || []).includes(selectedMemberId);
        const onReserve = (board.reserveByWindow[w.window_id] || []).includes(selectedMemberId);
        return `<div class="win-row">
            <div class="win-info">
                <b>${w.event_date}　${w.session}</b> <span class="job-chip" style="background:#e3ecf7;">${fmtType(w.match_type)}</span>${onReserve ? '<span class="badge-reserve">後備</span>' : ''}
                <div class="meta">${w.title || ''}${onLeave ? ' · 你已請假' : ''}</div>
            </div>
            <button class="toggle-btn ${onLeave ? 'toggle-cancel' : 'toggle-leave'}"
                onclick="submitLeave('${w.window_id}', '${onLeave ? 'leave_cancel' : 'leave_request'}')">
                ${onLeave ? '取消請假' : '我要請假'}
            </button>
        </div>`;
    }).join('');
}

// ---- 各場次請假名單（依職業） ----
function renderBoard() {
    const wins = board.windows || [];
    const card = document.getElementById('board-card');
    if (wins.length === 0) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    document.getElementById('board-list').innerHTML = wins.map(w => {
        const leaveIds = board.leaveByWindow[w.window_id] || [];
        const reserveIds = board.reserveByWindow[w.window_id] || [];
        return `<div class="win-block">
            <div class="win-block-title">${w.event_date}　${w.session}　<span class="job-chip" style="background:#e3ecf7;">${fmtType(w.match_type)}</span>${w.title ? ' · ' + w.title : ''}</div>
            <div style="font-size:12px; color:#e57373; font-weight:bold; margin-top:4px;">🙋 已請假（${leaveIds.length}）</div>
            ${renderJobGroups(leaveIds, false)}
            ${reserveIds.length ? `<div style="font-size:12px; color:#e65100; font-weight:bold; margin-top:6px;">🔶 後備（${reserveIds.length}）</div>${renderJobGroups(reserveIds, false)}` : ''}
        </div>`;
    }).join('');
}

// ---- 全體出席/請假/後備（依職業） ----
function renderOverview() {
    const members = board.members || [];
    if (!members.length) return;
    document.getElementById('roster-overview-card').style.display = 'block';
    document.getElementById('roster-overview').innerHTML =
        `<div style="font-size:11px; color:#97a0ad; margin-bottom:6px;">數字＝出席 / 請假 / 後備</div>` +
        renderJobGroups(members.map(m => m.member_id), true);
}

function toggleOverview() {
    const el = document.getElementById('roster-overview');
    const caret = document.getElementById('overview-caret');
    const open = el.style.display !== 'none';
    el.style.display = open ? 'none' : 'block';
    caret.textContent = open ? '▸' : '▾';
}

async function submitLeave(windowId, action) {
    if (!selectedMemberId) return;
    try {
        const res = await fetch(`${WORKER_URL}/api/leave/public/submit?share=${encodeURIComponent(shareId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ window_id: windowId, member_id: selectedMemberId, action })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { toast("⚠️ " + (data.error || "操作失敗")); return; }
        const arr = board.leaveByWindow[windowId] || (board.leaveByWindow[windowId] = []);
        const m = memberById[selectedMemberId];
        if (action === 'leave_request') {
            if (!arr.includes(selectedMemberId)) arr.push(selectedMemberId);
            if (m) m.leave = (m.leave || 0) + 1;
            toast("✅ 已請假");
        } else {
            board.leaveByWindow[windowId] = arr.filter(x => x !== selectedMemberId);
            if (m && m.leave > 0) m.leave -= 1;
            toast("↩️ 已取消請假");
        }
        renderWindows();
        renderBoard();
        renderOverview();
    } catch (e) {
        toast("⚠️ 連線失敗，請稍後再試");
    }
}

loadBoard();
