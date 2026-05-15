const API_URL = (window.location.port === '5500' || window.location.port === '5501') ? 'http://localhost:3000/api/tasks' : '/api/tasks';

// State
let tasks = [];

// DOM Elements
const taskForm = document.getElementById('task-form');
const taskList = document.getElementById('task-list');
const completedList = document.getElementById('completed-list');
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const groupList = document.getElementById('group-list');

// Modal Elements
const editModal = document.getElementById('edit-modal');
const editForm = document.getElementById('edit-form');

// Initialize
document.addEventListener('DOMContentLoaded', fetchTasks);

// Tab Switching
tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        
        btn.classList.add('active');
        const target = btn.dataset.target;
        document.getElementById(target).classList.add('active');
        
        if (target === 'settings') {
            fetchGroups();
        }
    });
});

// Fetch Tasks
async function fetchTasks() {
    try {
        const response = await fetch(API_URL);
        tasks = await response.json();
        renderTasks();
    } catch (error) {
        console.error('Error fetching tasks:', error);
        taskList.innerHTML = `<div class="empty-state"><i class="ri-error-warning-line"></i><p>Gagal memuat data.</p></div>`;
    }
}

// Add Task
taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('task-name').value;
    const date = document.getElementById('task-date').value;
    const detail = document.getElementById('task-detail').value;

    try {
        await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, date, detail })
        });
        taskForm.reset();
        fetchTasks();
    } catch (error) {
        console.error('Error adding task:', error);
    }
});

// Calculate Time Remaining
function getTimeRemaining(dateStr) {
    if (!dateStr) return { class: 'warning', text: 'Belum ditentukan', raw: null };
    const now = new Date();
    const deadline = new Date(dateStr + '+08:00');
    const diffMs = deadline - now;
    
    if (diffMs < 0) {
        const overDays = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60 * 24));
        const overHours = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60)) % 24;
        let txt = overDays > 0 ? `Terlewat ${overDays} hari` : `Terlewat ${overHours} jam`;
        return { class: 'urgent', text: txt, raw: diffMs };
    }

    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor(diffMs / (1000 * 60 * 60)) % 24;
    const mins = Math.floor(diffMs / (1000 * 60)) % 60;

    if (days > 2) return { class: 'safe', text: `${days} hari lagi`, raw: diffMs };
    if (days > 0) return { class: 'warning', text: `${days} hari ${hours} jam`, raw: diffMs };
    if (hours > 0) return { class: 'urgent', text: `${hours} jam ${mins} mnt lagi`, raw: diffMs };
    return { class: 'urgent', text: `${mins} menit lagi!`, raw: diffMs };
}

// Render Tasks
function renderTasks() {
    const pendingTasks = tasks.filter(t => t.status !== 'completed');
    const compTasks = tasks.filter(t => t.status === 'completed');

    // Render Pending
    if (pendingTasks.length === 0) {
        taskList.innerHTML = `<div class="empty-state"><i class="ri-check-double-line"></i><p>Hore! Tidak ada tugas yang belum selesai.</p></div>`;
    } else {
        taskList.innerHTML = pendingTasks.map((task, index) => {
            const timeInfo = getTimeRemaining(task.date || task.deadline);
            let badgeClass = timeInfo.class;
            let badgeText = timeInfo.text;

            // Format date nicely
            let dateFmt = 'Belum ada batas waktu';
            const targetDateStr = task.date || task.deadline;
            if (targetDateStr && targetDateStr.trim() !== '') {
                const dateObj = new Date(targetDateStr + '+08:00');
                if (!isNaN(dateObj.getTime())) {
                    const hasTime = targetDateStr.includes('T') || targetDateStr.includes(':');
                    const opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
                    if (hasTime) {
                        opts.hour = '2-digit';
                        opts.minute = '2-digit';
                    }
                    dateFmt = dateObj.toLocaleDateString('id-ID', opts).replace(',', '') + ' WITA';
                }
            }
            
            const detailHtml = task.detail ? `<div class="task-detail">${task.detail}</div>` : '';

            return `
                <li class="task-item">
                    <div class="task-info">
                        <span class="task-name">${task.name}</span>
                        ${detailHtml}
                        <div class="task-date">
                            <i class="ri-calendar-2-line"></i> ${dateFmt}
                            <span class="badge ${badgeClass}">${badgeText}</span>
                        </div>
                    </div>
                    <div class="task-actions">
                        <button class="action-btn btn-complete" onclick="completeTask(${index})" title="Tandai Selesai">
                            <i class="ri-check-line"></i>
                        </button>
                        <button class="action-btn btn-edit" onclick="openEditModal(${index})" title="Edit">
                            <i class="ri-pencil-line"></i>
                        </button>
                        <button class="action-btn btn-delete" onclick="deleteTask(${index})" title="Hapus">
                            <i class="ri-delete-bin-line"></i>
                        </button>
                    </div>
                </li>
            `;
        }).join('');
    }

    // Render Completed
    if (compTasks.length === 0) {
        completedList.innerHTML = `<div class="empty-state"><i class="ri-ghost-line"></i><p>Belum ada tugas yang diselesaikan.</p></div>`;
    } else {
        completedList.innerHTML = compTasks.map((task, index) => {
            // Find its real index in the original array
            const realIndex = tasks.findIndex(t => t === task);
            const detailHtml = task.detail ? `<div class="task-detail">${task.detail}</div>` : '';
            return `
                <li class="task-item completed">
                    <div class="task-info">
                        <span class="task-name">${task.name}</span>
                        ${detailHtml}
                        <div class="task-date">
                            <i class="ri-check-double-line"></i> Selesai
                        </div>
                    </div>
                    <div class="task-actions">
                        <button class="action-btn btn-delete" onclick="deleteTask(${realIndex})" title="Hapus Permanen">
                            <i class="ri-delete-bin-line"></i>
                        </button>
                    </div>
                </li>
            `;
        }).join('');
    }
}

// Complete Task
async function completeTask(index) {
    try {
        await fetch(`${API_URL}/${index}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'completed' })
        });
        fetchTasks();
    } catch (error) {
        console.error('Error:', error);
    }
}

// Delete Task
async function deleteTask(index) {
    if (confirm('Yakin ingin menghapus tugas ini secara permanen?')) {
        try {
            await fetch(`${API_URL}/${index}`, { method: 'DELETE' });
            fetchTasks();
        } catch (error) {
            console.error('Error:', error);
        }
    }
}

// Modal functions
function openEditModal(index) {
    const task = tasks[index];
    document.getElementById('edit-id').value = index;
    document.getElementById('edit-name').value = task.name;
    document.getElementById('edit-date').value = task.date || task.deadline || '';
    document.getElementById('edit-detail').value = task.detail || '';
    editModal.classList.add('active');
}

function closeModal() {
    editModal.classList.remove('active');
}

editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-id').value;
    const name = document.getElementById('edit-name').value;
    const date = document.getElementById('edit-date').value;
    const detail = document.getElementById('edit-detail').value;

    try {
        await fetch(`${API_URL}/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, date, detail })
        });
        closeModal();
        fetchTasks();
    } catch (error) {
        console.error('Error:', error);
    }
});

// --- GROUP MANAGEMENT ---
async function fetchGroups() {
    try {
        const response = await fetch('/api/settings');
        const groups = await response.json();
        renderGroups(groups);
    } catch (error) {
        console.error('Error fetching groups:', error);
        groupList.innerHTML = `<div class="empty-state"><i class="ri-error-warning-line"></i><p>Gagal memuat daftar grup.</p></div>`;
    }
}

function renderGroups(groups) {
    if (groups.length === 0) {
        groupList.innerHTML = `<div class="empty-state"><i class="ri-chat-delete-line"></i><p>Belum ada grup yang terhubung. Gunakan perintah <b>!setgrup</b> di WhatsApp.</p></div>`;
        return;
    }

    groupList.innerHTML = groups.map(group => {
        return `
            <li class="task-item">
                <div class="task-info">
                    <span class="task-name">${group.reminderJid}</span>
                    <div class="task-date">
                        <i class="ri-checkbox-circle-line"></i> Status: Aktif
                    </div>
                </div>
                <div class="task-actions">
                    <button class="action-btn btn-delete" onclick="deleteGroup('${group._id}')" title="Hapus Grup">
                        <i class="ri-delete-bin-line"></i>
                    </button>
                </div>
            </li>
        `;
    }).join('');
}

async function deleteGroup(id) {
    if (confirm('Yakin ingin menghapus grup ini dari daftar pengingat? Grup ini tidak akan lagi menerima notifikasi otomatis.')) {
        try {
            await fetch(`/api/settings/${id}`, { method: 'DELETE' });
            fetchGroups();
        } catch (error) {
            console.error('Error deleting group:', error);
        }
    }
}
