require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { connectDB, Task, Setting } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(async (req, res, next) => {
    await connectDB();
    next();
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/health', (req, res) => res.status(200).send('OK'));

// --- STATS ---
app.get('/api/stats', async (req, res) => {
    try {
        const all = await Task.find({ status: { $ne: 'deleted' } });
        const completed = all.filter(t => t.status === 'completed').length;
        const pending = all.filter(t => t.status !== 'completed').length;
        const missed = all.filter(t => {
            if (t.status === 'completed' || !t.deadline) return false;
            return new Date(t.deadline) < new Date();
        }).length;
        const critical = all.filter(t => {
            if (t.status === 'completed' || !t.deadline) return false;
            const diff = new Date(t.deadline) - new Date();
            return diff > 0 && diff <= 3 * 3600000;
        }).length;
        res.json({ total: all.length, completed, pending, missed, critical });
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil statistik' });
    }
});

// --- ADMIN AUTH (Hardened) ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'rahasia123';
const TOKEN_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 jam

// Session store: { token: { createdAt, ip } }
const activeSessions = new Map();

// Rate limiter store: { ip: { count, resetAt } }
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 menit

// Bersihkan session & rate limiter yang sudah expired setiap 10 menit
setInterval(() => {
    const now = Date.now();
    for (const [token, session] of activeSessions) {
        if (now - session.createdAt > TOKEN_EXPIRY_MS) activeSessions.delete(token);
    }
    for (const [ip, data] of loginAttempts) {
        if (now > data.resetAt) loginAttempts.delete(ip);
    }
}, 10 * 60 * 1000);

// Timing-safe comparison to prevent timing attacks
function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

app.post('/api/v1/sync', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    const now = Date.now();

    // Rate limit check
    const attempts = loginAttempts.get(ip);
    if (attempts && now < attempts.resetAt && attempts.count >= MAX_ATTEMPTS) {
        return res.status(429).json({ error: 'x' });
    }

    const password = req.body.k || '';
    if (safeCompare(password, ADMIN_PASSWORD)) {
        // Reset rate limiter on success
        loginAttempts.delete(ip);

        // Generate random session token
        const token = crypto.randomBytes(32).toString('hex');
        activeSessions.set(token, { createdAt: now, ip });
        res.json({ t: token });
    } else {
        // Increment rate limiter
        if (!attempts || now > attempts.resetAt) {
            loginAttempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
        } else {
            attempts.count++;
        }
        const remaining = MAX_ATTEMPTS - (loginAttempts.get(ip)?.count || 0);
        res.status(401).json({ error: 'x' });
    }
});

const verifyXs = (req, res, next) => {
    const token = req.headers['x-xs-token'];
    if (!token) return res.status(401).json({ error: 'x' });

    const session = activeSessions.get(token);
    if (!session) return res.status(401).json({ error: 'Token tidak valid atau sudah kedaluwarsa.' });

    // Check expiry
    if (Date.now() - session.createdAt > TOKEN_EXPIRY_MS) {
        activeSessions.delete(token);
        return res.status(401).json({ error: 'x' });
    }

    next();
};

app.get('/api/v1/ext', verifyXs, (req, res) => {
    const extCode = `
        window.cachedGroups = [];
        
        window.fetchGroups = async function() {
            try {
                const res = await fetch(window.SETTINGS_URL || '/api/settings');
                window.cachedGroups = await res.json();
                
                const groupList = document.getElementById('group-list');
                if (groupList) {
                    if (window.cachedGroups.length === 0) {
                        groupList.innerHTML = '<div class="empty-state"><i class="ri-ghost-line"></i><p>Belum ada grup yang terhubung.</p></div>';
                    } else {
                        groupList.innerHTML = window.cachedGroups.map((g, i) => 
                            '<li class="task-item" data-index="'+i+'"><div class="task-info"><span class="task-name">'+
                            (g.groupName ? window.esc(g.groupName) : g.reminderJid)+
                            '</span></div><div class="task-actions"></div></li>'
                        ).join('');
                        if (window.renderTasks) window.renderTasks(); // Trigger injecting delete buttons
                    }
                }
                if (window.renderGroupCheckboxes) {
                    window.renderGroupCheckboxes('add-group-checkboxes', window.cachedGroups.map(g=>g.reminderJid));
                }
            } catch(e) {}
        };

        window.renderGroupCheckboxes = function(containerId, checkedJids) {
            const container = document.getElementById(containerId);
            if (!container) return;
            if (!window.cachedGroups || window.cachedGroups.length === 0) {
                container.innerHTML = '<p style="color:#64748b;font-size:0.8rem;margin:0;">Tidak ada grup yang tersedia.</p>';
                return;
            }
            container.innerHTML = window.cachedGroups.map(g => {
                const isChecked = checkedJids.includes(g.reminderJid) ? 'checked' : '';
                return '<label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;color:#f8fafc;cursor:pointer;"><input type="checkbox" value="'+g.reminderJid+'" '+isChecked+' style="accent-color:#6366f1;"> '+(g.groupName ? window.esc(g.groupName) : g.reminderJid)+'</label>';
            }).join('');
        };

        window.getSelectedGroups = function(containerId) {
            const container = document.getElementById(containerId);
            if (!container) return [];
            return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
        };

        // Un-hide the group tab
        const settingsTabBtn = document.querySelector('.tab-btn[data-target="settings"]');
        if (settingsTabBtn) {
            settingsTabBtn.style.display = 'inline-flex';
        }

        window.extSubmitAdd = async function(e) {
            const name = document.getElementById('task-name').value;
            const date = document.getElementById('task-date').value;
            const detail = document.getElementById('task-detail').value;
            const priority = document.getElementById('task-priority').value;
            const tgs = window.getSelectedGroups ? window.getSelectedGroups('add-group-checkboxes') : [];
            try {
                await fetch(window.API_URL || '/api/tasks', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name, date, detail, priority, targetGroups: tgs, silent: tgs.length===0}) });
                document.getElementById('task-form').reset();
                if (window.fetchTasks) window.fetchTasks();
                if (window.renderGroupCheckboxes && window.cachedGroups) window.renderGroupCheckboxes('add-group-checkboxes', window.cachedGroups.map(g=>g.reminderJid));
            } catch(err){}
        };

        window.extSubmitEdit = async function(e) {
            const id = document.getElementById('edit-id').value;
            const name = document.getElementById('edit-name').value;
            const date = document.getElementById('edit-date').value;
            const detail = document.getElementById('edit-detail').value;
            const priority = document.getElementById('edit-priority').value;
            const tgs = window.getSelectedGroups ? window.getSelectedGroups('edit-group-checkboxes') : [];
            try {
                await fetch((window.API_URL||'/api/tasks')+'/'+id, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name, date, detail, priority, targetGroups: tgs, silent: tgs.length===0}) });
                if (window.closeModal) window.closeModal();
                if (window.fetchTasks) window.fetchTasks();
            } catch(err){}
        };

        const adminModalHTML = \`
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
        \`;
        if (!document.getElementById('admin-action-modal')) {
            document.body.insertAdjacentHTML('beforeend', adminModalHTML);
        }

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
            window.showAdminModal('<i class="ri-delete-bin-line"></i> Hapus Tugas', 'Yakin ingin menghapus tugas ini secara permanen?', 'Ya, Hapus', '#ef4444', async (silent) => {
                try {
                    const res = await fetch((window.API_URL||'/api/tasks')+'/'+index+'?silent='+silent, { method:'DELETE', headers:{'x-xs-token': localStorage.getItem('_xs')||''} });
                    if (res.status === 401) { localStorage.removeItem('_xs'); location.reload(); return; }
                    if (window.fetchTasks) window.fetchTasks();
                } catch(err){}
            });
        };

        window.extDeleteGroup = function(id) {
            window.showAdminModal('<i class="ri-delete-bin-line"></i> Hapus Grup', 'Yakin ingin menghapus grup ini dari daftar notifikasi?', 'Ya, Hapus', '#ef4444', async (silent) => {
                try {
                    const res = await fetch((window.SETTINGS_URL||'/api/settings')+'/'+id, { method:'DELETE', headers:{'x-xs-token': localStorage.getItem('_xs')||''} });
                    if (res.status === 401) { localStorage.removeItem('_xs'); location.reload(); return; }
                    if (window.fetchGroups) window.fetchGroups();
                } catch(err){}
            }, false);
        };

        window.completeTask = function(index) {
            window.showAdminModal('<i class="ri-check-line"></i> Tandai Selesai', 'Tandai tugas ini sebagai selesai?', 'Selesai', '#10b981', async (silent) => {
                try {
                    await fetch((window.API_URL||'/api/tasks')+'/'+index, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({status:'completed', silent}) });
                    if (window.fetchTasks) window.fetchTasks();
                } catch(err){}
            });
        };

        const origRender = window.renderTasks;
        window.renderTasks = function() {
            if (origRender) origRender();
            
            // Inject add form checkboxes
            const addForm = document.getElementById('task-form');
            if (addForm && !document.getElementById('add-group-checkboxes')) {
                const btn = addForm.querySelector('.btn-primary');
                if (btn) {
                    const div = document.createElement('div');
                    div.style.marginTop = '-4px'; div.style.marginBottom = '12px';
                    div.innerHTML = '<p style="color:#94a3b8;font-size:0.85rem;margin-bottom:6px;"><i class="ri-notification-3-line"></i> Kirim notif ke grup:</p><div id="add-group-checkboxes" style="display:flex;flex-direction:column;gap:4px;"></div>';
                    addForm.insertBefore(div, btn);
                    if (window.cachedGroups && window.renderGroupCheckboxes) window.renderGroupCheckboxes('add-group-checkboxes', window.cachedGroups.map(g=>g.reminderJid));
                }
            }

            // Inject edit form checkboxes
            const editForm = document.getElementById('edit-form');
            if (editForm && !document.getElementById('edit-group-checkboxes')) {
                const actions = document.getElementById('edit-modal-actions');
                if (actions) {
                    const div = document.createElement('div');
                    div.style.marginTop = '-4px'; div.style.marginBottom = '12px';
                    div.innerHTML = '<p style="color:#94a3b8;font-size:0.85rem;margin-bottom:6px;"><i class="ri-notification-3-line"></i> Kirim notif ke grup:</p><div id="edit-group-checkboxes" style="display:flex;flex-direction:column;gap:4px;"></div>';
                    editForm.insertBefore(div, actions);
                }
            }

            // Inject task delete buttons
            document.querySelectorAll('#task-list .task-item').forEach(item => {
                const idx = item.getAttribute('data-index');
                const acts = item.querySelector('.task-actions');
                if (acts && !acts.querySelector('.btn-delete')) {
                    const b = document.createElement('button');
                    b.className = 'action-btn btn-delete'; b.title = 'Hapus';
                    b.innerHTML = '<i class="ri-delete-bin-line"></i>';
                    b.onclick = () => window.extDeleteTask(idx);
                    acts.appendChild(b);
                }
            });

            document.querySelectorAll('#completed-list .task-item').forEach(item => {
                const idx = item.getAttribute('data-index');
                const acts = item.querySelector('.task-actions');
                if (acts && !acts.querySelector('.btn-delete')) {
                    const b = document.createElement('button');
                    b.className = 'action-btn btn-delete'; b.title = 'Hapus Permanen';
                    b.innerHTML = '<i class="ri-delete-bin-line"></i>';
                    b.onclick = () => window.extDeleteTask(idx);
                    acts.appendChild(b);
                }
            });

            // Inject group delete buttons
            document.querySelectorAll('#group-list .task-item').forEach((item, i) => {
                if (window.cachedGroups && window.cachedGroups[i]) {
                    const acts = item.querySelector('.task-actions');
                    if (acts && !acts.querySelector('.btn-delete')) {
                        const b = document.createElement('button');
                        b.className = 'action-btn btn-delete'; b.title = 'Hapus Grup';
                        b.innerHTML = '<i class="ri-delete-bin-line"></i>';
                        b.onclick = () => window.extDeleteGroup(window.cachedGroups[i]._id);
                        acts.appendChild(b);
                    }
                }
            });
        };

        const origOpenEdit = window.openEditModal;
        window.openEditModal = function(index) {
            if (origOpenEdit) origOpenEdit(index);
            if (window.tasks && window.tasks[index] && window.renderGroupCheckboxes) {
                const t = window.tasks[index];
                const tgs = (t.targetGroups && t.targetGroups.length > 0) ? t.targetGroups : (window.cachedGroups||[]).map(g=>g.reminderJid);
                window.renderGroupCheckboxes('edit-group-checkboxes', tgs);
            }
        };

        // Initial trigger
        if (window.fetchGroups) window.fetchGroups();
        if (window.renderTasks) window.renderTasks();
    `;
    res.type('application/javascript');
    res.send(extCode);
});


// --- TASKS ---
app.get('/api/tasks', async (req, res) => {
    try {
        const tasks = await Task.find({ status: { $ne: 'deleted' } }).sort({ createdAt: 1 });
        res.json(tasks);
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil data' });
    }
});

app.post('/api/tasks', async (req, res) => {
    const { name, date, detail, priority, silent, targetGroups } = req.body;
    if (!name) return res.status(400).json({ error: 'Nama tugas wajib diisi' });

    try {
        const task = await Task.create({
            name,
            deadline: date || '',
            detail: detail || '',
            status: 'pending',
            priority: priority || 'normal',
            silent: silent || false,
            targetGroups: Array.isArray(targetGroups) ? targetGroups : []
        });
        res.status(201).json({ message: 'Tugas ditambahkan', task });
    } catch (error) {
        res.status(500).json({ error: 'Gagal menambah tugas' });
    }
});

app.put('/api/tasks/:id', async (req, res) => {
    const { name, date, detail, priority, silent, targetGroups } = req.body;
    try {
        const tasks = await Task.find({ status: { $ne: 'deleted' } }).sort({ createdAt: 1 });
        const id = parseInt(req.params.id);
        if (tasks[id]) {
            const updateData = {
                name,
                deadline: date || '',
                detail: detail !== undefined ? detail : tasks[id].detail,
                priority: priority || tasks[id].priority || 'normal',
                silent: silent !== undefined ? silent : tasks[id].silent
            };
            if (Array.isArray(targetGroups)) updateData.targetGroups = targetGroups;
            await Task.findByIdAndUpdate(tasks[id]._id, updateData);
            res.json({ message: 'Tugas diedit' });
        } else {
            res.status(404).json({ error: 'Tidak ditemukan' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Gagal edit tugas' });
    }
});

app.patch('/api/tasks/:id', async (req, res) => {
    const { status, silent } = req.body;
    try {
        const tasks = await Task.find({ status: { $ne: 'deleted' } }).sort({ createdAt: 1 });
        const id = parseInt(req.params.id);
        if (tasks[id]) {
            const update = { status };
            if (silent !== undefined) update.silent = silent;
            if (status === 'completed') update.completedAt = new Date();
            await Task.findByIdAndUpdate(tasks[id]._id, update);
            res.json({ message: 'Status diupdate' });
        } else {
            res.status(404).json({ error: 'Tidak ditemukan' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Gagal update status' });
    }
});

app.delete('/api/tasks/:id', verifyXs, async (req, res) => {
    try {
        const silent = req.query.silent === 'true';
        const tasks = await Task.find({ status: { $ne: 'deleted' } }).sort({ createdAt: 1 });
        const id = parseInt(req.params.id);
        if (tasks[id]) {
            if (silent) {
                await Task.findByIdAndUpdate(tasks[id]._id, { status: 'deleted', silent: true });
            } else {
                await Task.findByIdAndDelete(tasks[id]._id);
            }
            res.json({ message: 'Dihapus' });
        } else {
            res.status(404).json({ error: 'Tidak ditemukan' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Gagal menghapus tugas' });
    }
});

// --- SETTINGS ---
app.get('/api/settings', async (req, res) => {
    try {
        const settings = await Setting.find();
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil data grup' });
    }
});

app.delete('/api/settings/:id', verifyXs, async (req, res) => {
    try {
        await Setting.findByIdAndDelete(req.params.id);
        res.json({ message: 'Grup berhasil dihapus' });
    } catch (error) {
        res.status(500).json({ error: 'Gagal menghapus grup' });
    }
});

if (process.env.NODE_ENV !== 'production' || require.main === module) {
    app.listen(PORT, () => {
        console.log(`🌐 Web Dashboard aktif di port ${PORT}`);
    });
}

module.exports = app;
