let BACKEND_URL = localStorage.getItem('backend_url') || '';
let API_URL = BACKEND_URL ? `${BACKEND_URL}/api/tasks` : '';
let STATS_URL = BACKEND_URL ? `${BACKEND_URL}/api/stats` : '';
let SETTINGS_URL = BACKEND_URL ? `${BACKEND_URL}/api/settings` : '';

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
    const _xs = localStorage.getItem('_xs');
    const bUrl = localStorage.getItem('backend_url');
    if (bUrl) document.getElementById('admin-backend-url').value = bUrl;
    
    if (!_xs || !bUrl) {
        document.getElementById('login-modal').classList.add('active');
    } else {
        document.getElementById('login-modal').classList.remove('active');
        fetchTasks();
        fetchGroups();
    }

    document.getElementById('login-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const p = document.getElementById('admin-password').value;
        const inputUrl = document.getElementById('admin-backend-url').value.replace(/\/$/, '');
        
        fetch(`${inputUrl}/api/v1/sync`, { method: 'POST', body: JSON.stringify({ k: p }), headers: { 'Content-Type': 'application/json' } })
        .then(r => r.json()).then(d => { 
            if (d.t) { 
                localStorage.setItem('_xs', d.t);
                localStorage.setItem('backend_url', inputUrl);
                BACKEND_URL = inputUrl;
                API_URL = `${BACKEND_URL}/api/tasks`;
                STATS_URL = `${BACKEND_URL}/api/stats`;
                SETTINGS_URL = `${BACKEND_URL}/api/settings`;
                
                document.getElementById('login-modal').classList.remove('active');
                fetchTasks();
                fetchGroups();
            } else { 
                alert('Password atau URL salah!'); 
            } 
        }).catch(err => {
            alert('Gagal terhubung ke Backend URL!');
        });
    });
});

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.dataset.target;
        if(document.getElementById(target)) document.getElementById(target).classList.add('active');
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
    const name = document.getElementById('task-name').value;
    const date = document.getElementById('task-date').value;
    const detail = document.getElementById('task-detail').value;
    const priority = document.getElementById('task-priority').value;
    const tgs = getSelectedGroups('add-group-checkboxes');
    
    try {
        await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-xs-token': localStorage.getItem('_xs') || '' },
            body: JSON.stringify({ name, date, detail, priority, targetGroups: tgs, silent: tgs.length === 0 })
        });
        taskForm.reset();
        document.getElementById('task-priority').value = 'normal';
        fetchTasks();
        renderGroupCheckboxes('add-group-checkboxes', cachedGroups.map(g=>g.reminderJid));
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
                        <button class="action-btn btn-delete" onclick="window.extDeleteTask(${realIndex})" title="Hapus"><i class="ri-delete-bin-line"></i></button>
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
                    </div>
                    <div class="task-actions">
                        <button class="action-btn btn-delete" onclick="window.extDeleteTask(${realIndex})" title="Hapus Permanen"><i class="ri-delete-bin-line"></i></button>
                    </div>
                </li>`;
        }).join('');
    }
};

let cachedGroups = [];

async function fetchGroups() {
    try {
        const res = await fetch(SETTINGS_URL);
        cachedGroups = await res.json();
        
        const groupList = document.getElementById('group-list');
        if (groupList) {
            if (cachedGroups.length === 0) {
                groupList.innerHTML = '<div class="empty-state"><i class="ri-ghost-line"></i><p>Belum ada grup yang terhubung.</p></div>';
            } else {
                groupList.innerHTML = cachedGroups.map((g, i) => 
                    '<li class="task-item" data-index="'+i+'"><div class="task-info"><span class="task-name">'+
                    (g.groupName ? esc(g.groupName) : g.reminderJid)+
                    '</span></div><div class="task-actions"><button class="action-btn btn-delete" onclick="window.extDeleteGroup(\''+g._id+'\')" title="Hapus Grup"><i class="ri-delete-bin-line"></i></button></div></li>'
                ).join('');
            }
        }
        renderGroupCheckboxes('add-group-checkboxes', cachedGroups.map(g=>g.reminderJid));
    } catch(e) {}
}

function renderGroupCheckboxes(containerId, checkedJids) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!cachedGroups || cachedGroups.length === 0) {
        container.innerHTML = '<p style="color:#64748b;font-size:0.8rem;margin:0;">Tidak ada grup yang tersedia.</p>';
        return;
    }
    container.innerHTML = cachedGroups.map(g => {
        const isChecked = checkedJids.includes(g.reminderJid) ? 'checked' : '';
        return '<label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;color:#f8fafc;cursor:pointer;"><input type="checkbox" value="'+g.reminderJid+'" '+isChecked+' style="accent-color:#6366f1;"> '+(g.groupName ? esc(g.groupName) : g.reminderJid)+'</label>';
    }).join('');
}

function getSelectedGroups(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

const adminModalHTML = `
    <div class="modal-overlay" id="admin-action-modal">
        <div class="modal glass-panel">
            <h2 id="admin-action-title"><i class="ri-alert-line"></i> Konfirmasi</h2>
            <p id="admin-action-msg" style="color:#cbd5e1;font-size:0.95rem;margin-bottom:15px;line-height:1.5;">Apakah Anda yakin?</p>
            <div class="input-group" id="admin-action-notify-group" style="display:flex;align-items:center;gap:8px;margin-bottom:20px;">
                <input type="checkbox" id="admin-action-notify" checked style="accent-color:#6366f1;width:18px;height:18px;">
                <label for="admin-action-notify" style="color:#f8fafc;font-size:0.9rem;cursor:pointer;">Kirim notifikasi WhatsApp</label>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-secondary" onclick="document.getElementById('admin-action-modal').classList.remove('active')">Batal</button>
                <button type="button" class="btn-primary" id="admin-action-confirm" style="background:#ef4444;border-color:#ef4444;">Ya</button>
            </div>
        </div>
    </div>
`;
document.body.insertAdjacentHTML('beforeend', adminModalHTML);

window.showAdminModal = function(title, msg, btnText, btnColor, onConfirm, showNotify = true) {
    document.getElementById('admin-action-title').innerHTML = title;
    document.getElementById('admin-action-msg').innerHTML = msg;
    document.getElementById('admin-action-notify-group').style.display = showNotify ? 'flex' : 'none';
    document.getElementById('admin-action-notify').checked = true;
    
    const confirmBtn = document.getElementById('admin-action-confirm');
    confirmBtn.innerHTML = btnText;
    confirmBtn.style.background = btnColor;
    confirmBtn.style.borderColor = btnColor;
    
    confirmBtn.onclick = () => {
        document.getElementById('admin-action-modal').classList.remove('active');
        const silent = !document.getElementById('admin-action-notify').checked;
        onConfirm(silent);
    };
    
    document.getElementById('admin-action-modal').classList.add('active');
};

window.extDeleteTask = function(index) {
    const task = tasks[index];
    if (!task) return;
    window.showAdminModal('<i class="ri-delete-bin-line"></i> Hapus Tugas', 'Yakin ingin menghapus tugas "'+esc(task.name)+'" secara permanen?', 'Ya, Hapus', '#ef4444', async (silent) => {
        try {
            const res = await fetch(API_URL+'/'+index+'?silent='+silent, { method:'DELETE', headers:{'x-xs-token': localStorage.getItem('_xs')||''} });
            if (res.status === 401) { localStorage.removeItem('_xs'); location.reload(); return; }
            fetchTasks();
        } catch(err){}
    });
};

window.extDeleteGroup = function(id) {
    window.showAdminModal('<i class="ri-delete-bin-line"></i> Hapus Grup', 'Yakin ingin menghapus grup ini dari daftar notifikasi?', 'Ya, Hapus', '#ef4444', async (silent) => {
        try {
            const res = await fetch(SETTINGS_URL+'/'+id, { method:'DELETE', headers:{'x-xs-token': localStorage.getItem('_xs')||''} });
            if (res.status === 401) { localStorage.removeItem('_xs'); location.reload(); return; }
            fetchGroups();
        } catch(err){}
    }, false);
};

window.completeTask = async function(index) {
    window.showAdminModal('<i class="ri-check-line"></i> Tandai Selesai', 'Tandai tugas ini sebagai selesai?', 'Selesai', '#10b981', async (silent) => {
        try {
            await fetch(API_URL+'/'+index, { method:'PATCH', headers:{'Content-Type':'application/json', 'x-xs-token': localStorage.getItem('_xs')||''}, body:JSON.stringify({status:'completed', silent}) });
            fetchTasks();
        } catch(err){}
    });
};

window.openEditModal = function(index) {
    const task = tasks[index];
    document.getElementById('edit-id').value = index;
    document.getElementById('edit-name').value = task.name;
    document.getElementById('edit-date').value = task.date || task.deadline || '';
    document.getElementById('edit-detail').value = task.detail || '';
    document.getElementById('edit-priority').value = task.priority || 'normal';
    const tgs = (task.targetGroups && task.targetGroups.length > 0) ? task.targetGroups : cachedGroups.map(g=>g.reminderJid);
    renderGroupCheckboxes('edit-group-checkboxes', tgs);
    editModal.classList.add('active');
};

function closeModal() { editModal.classList.remove('active'); }
window.closeModal = closeModal;

editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-id').value;
    const name = document.getElementById('edit-name').value;
    const date = document.getElementById('edit-date').value;
    const detail = document.getElementById('edit-detail').value;
    const priority = document.getElementById('edit-priority').value;
    const tgs = getSelectedGroups('edit-group-checkboxes');
    
    try {
        await fetch(`${API_URL}/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'x-xs-token': localStorage.getItem('_xs') || '' },
            body: JSON.stringify({ name, date, detail, priority, targetGroups: tgs, silent: tgs.length === 0 })
        });
        closeModal();
        fetchTasks();
    } catch (e) { }
});

setInterval(fetchTasks, 60000);
