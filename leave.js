// =====================================================
// ===  公開請假頁（免登入）
// =====================================================
const WORKER_URL = "https://d1-template.cherrycywong0907.workers.dev";
const urlParams = new URLSearchParams(window.location.search);
const shareId = urlParams.get('share');

let board = { guild: "", windows: [], roster: [], leaveByWindow: {}, reserveByWindow: {} };
let selectedMemberId = null;

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
        const res = await fetch(`${WORKER_URL}/api/leave/public/board?share=${encodeURIComponent(shareId)}&t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            document.getElementById('sub-line').textContent = "⚠️ " + (err.error || "連結無效或已失效");
            return;
        }
        board = await res.json();
        if (board.guild) {
            document.getElementById('guild-title').textContent = `${board.guild} · 請假登記`;
        }
        if (!board.windows || board.windows.length === 0) {
            document.getElementById('empty-state').style.display = 'block';
        }
        renderNames();
    } catch (e) {
        document.getElementById('sub-line').textContent = "⚠️ 連線失敗，請稍後再試";
    }
}

function renderNames() {
    const q = (document.getElementById('name-search').value || '').toLowerCase().trim();
    const list = document.getElementById('name-list');
    const matched = (board.roster || []).filter(m => !q || m.display_name.toLowerCase().includes(q));
    if (matched.length === 0) {
        list.innerHTML = `<div class="muted">找不到「${q}」，請確認拼字或聯絡管理員。</div>`;
        return;
    }
    // 搜尋為空時，避免一次塞太多名字，提示先搜尋
    const show = q ? matched : matched.slice(0, 40);
    list.innerHTML = show.map(m =>
        `<span class="name-btn ${m.member_id === selectedMemberId ? 'active' : ''}" onclick="selectMember('${m.member_id}')">${m.display_name}</span>`
    ).join('') + (!q && matched.length > 40 ? `<div class="muted">共 ${matched.length} 人，輸入名字可快速找到自己</div>` : '');
}

function selectMember(memberId) {
    selectedMemberId = memberId;
    renderNames();
    renderWindows();
}

function renderWindows() {
    const member = (board.roster || []).find(m => m.member_id === selectedMemberId);
    if (!member) return;
    document.getElementById('selected-name').textContent = member.display_name;
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
                <b>${w.event_date}　${w.session}</b>${onReserve ? '<span class="badge-reserve">後備</span>' : ''}
                <div class="meta">${w.title || ''}${onLeave ? ' · 你已請假' : ''}</div>
            </div>
            <button class="toggle-btn ${onLeave ? 'toggle-cancel' : 'toggle-leave'}"
                onclick="submitLeave('${w.window_id}', '${onLeave ? 'leave_cancel' : 'leave_request'}')">
                ${onLeave ? '取消請假' : '我要請假'}
            </button>
        </div>`;
    }).join('');
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
        // 本地更新狀態，避免整頁重載
        const arr = board.leaveByWindow[windowId] || (board.leaveByWindow[windowId] = []);
        if (action === 'leave_request') {
            if (!arr.includes(selectedMemberId)) arr.push(selectedMemberId);
            toast("✅ 已請假");
        } else {
            board.leaveByWindow[windowId] = arr.filter(x => x !== selectedMemberId);
            toast("↩️ 已取消請假");
        }
        renderWindows();
    } catch (e) {
        toast("⚠️ 連線失敗，請稍後再試");
    }
}

loadBoard();
