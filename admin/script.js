let BACKEND_URL = localStorage.getItem('backend_url') || '';
let API_URL = BACKEND_URL ? `${BACKEND_URL}/api/tasks` : '';
let STATS_URL = BACKEND_URL ? `${BACKEND_URL}/api/stats` : '';
let SETTINGS_URL = BACKEND_URL ? `${BACKEND_URL}/api/settings` : '';
let BOT_STATUS_URL = BACKEND_URL ? `${BACKEND_URL}/api/admin/bot-status` : '';
let LOGS_URL = BACKEND_URL ? `${BACKEND_URL}/api/admin/logs` : '';
let ACTION_URL = BACKEND_URL ? `${BACKEND_URL}/api/admin/action` : '';
let CC_URL = BACKEND_URL ? `${BACKEND_URL}/api/admin/custom-commands` : '';

let tasks = [];
let cachedGroups = [];
let customCommands = [];
let pollingIntervals = [];
let lastLogTimestamp = '';

// Helper Escaping HTML
function esc(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Format milliseconds to readable duration
function formatDuration(ms) {
    if (!ms || ms <= 0) return '0 menit';
    const totalMinutes = Math.floor(ms / 60000);
    const totalHours = Math.floor(totalMinutes / 60);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const minutes = totalMinutes % 60;

    let res = [];
    if (days > 0) res.push(`${days} hari`);
    if (hours > 0) res.push(`${hours} jam`);
    if (minutes > 0 || res.length === 0) res.push(`${minutes} menit`);
    return res.join(' ');
}

// Headers with authorization token
function getAuthHeaders() {
    return {
        'Content-Type': 'application/json',
        'x-xs-token': localStorage.getItem('_xs') || ''
    };
}

document.addEventListener('DOMContentLoaded', () => {
    const _xs = localStorage.getItem('_xs');
    const bUrl = localStorage.getItem('backend_url');
    if (bUrl) document.getElementById('admin-backend-url').value = bUrl;
    
    // Live clock topbar
    setInterval(() => {
        const now = new Date();
        const options = { timeZone: 'Asia/Makassar', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
        document.getElementById('real-time-clock').textContent = now.toLocaleString('id-ID', options) + ' WITA';
    }, 1000);

    if (!_xs || !bUrl) {
        document.getElementById('login-modal').classList.add('active');
    } else {
        document.getElementById('login-modal').classList.remove('active');
        initDashboard();
    }

    // Login Form handler
    document.getElementById('login-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const p = document.getElementById('admin-password').value;
        const inputUrl = document.getElementById('admin-backend-url').value.replace(/\/$/, '');
        
        fetch(`${inputUrl}/api/v1/sync`, { 
            method: 'POST', 
            body: JSON.stringify({ k: p }), 
            headers: { 'Content-Type': 'application/json' } 
        })
        .then(r => r.json())
        .then(d => { 
            if (d.t) { 
                localStorage.setItem('_xs', d.t);
                localStorage.setItem('backend_url', inputUrl);
                
                // Update URL endpoints
                BACKEND_URL = inputUrl;
                API_URL = `${BACKEND_URL}/api/tasks`;
                STATS_URL = `${BACKEND_URL}/api/stats`;
                SETTINGS_URL = `${BACKEND_URL}/api/settings`;
                BOT_STATUS_URL = `${BACKEND_URL}/api/admin/bot-status`;
                LOGS_URL = `${BACKEND_URL}/api/admin/logs`;
                ACTION_URL = `${BACKEND_URL}/api/admin/action`;
                CC_URL = `${BACKEND_URL}/api/admin/custom-commands`;
                
                document.getElementById('login-modal').classList.remove('active');
                initDashboard();
            } else { 
                alert('Password atau Backend URL salah!'); 
            } 
        }).catch(err => {
            alert('Gagal terhubung ke server Backend API!');
        });
    });

    // Tab Switching Navigation
    const navItems = document.querySelectorAll('.nav-item');
    const tabPanes = document.querySelectorAll('.tab-pane');
    const viewTitle = document.getElementById('view-title');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(nav => nav.classList.remove('active'));
            tabPanes.forEach(pane => pane.classList.remove('active'));

            item.classList.add('active');
            const targetTab = item.dataset.tab;
            const pane = document.getElementById(`tab-${targetTab}`);
            if (pane) pane.classList.add('active');

            // Update title text
            viewTitle.textContent = item.querySelector('span').textContent;
        });
    });

    // Inner Tasks Tabs (Pending vs Completed)
    const innerTabs = document.querySelectorAll('.inner-tab');
    const innerContents = document.querySelectorAll('.inner-tab-content');

    innerTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            innerTabs.forEach(t => t.classList.remove('active'));
            innerContents.forEach(c => c.classList.remove('active'));

            tab.classList.add('active');
            const targetList = tab.dataset.list;
            document.getElementById(`list-${targetList}`).classList.add('active');
        });
    });
});

// Initialization
function initDashboard() {
    fetchTasks();
    fetchGroups();
    fetchBotStatus();
    fetchLogs();
    fetchCustomCommands();

    // Clear previous pollings
    pollingIntervals.forEach(clearInterval);
    pollingIntervals = [];

    // Polling telemetries
    pollingIntervals.push(setInterval(fetchBotStatus, 3000));
    pollingIntervals.push(setInterval(fetchLogs, 5000));
    pollingIntervals.push(setInterval(fetchTasks, 15000));
    pollingIntervals.push(setInterval(fetchGroups, 20000));
}

window.logout = function() {
    localStorage.removeItem('_xs');
    localStorage.removeItem('backend_url');
    location.reload();
};

// ==========================================
// 1. BOT TELEMETRY & LIVE MONITORING
// ==========================================

let lastQrString = '';
async function fetchBotStatus() {
    try {
        const res = await fetch(BOT_STATUS_URL, { headers: getAuthHeaders() });
        if (res.status === 401) { window.logout(); return; }
        
        const data = await res.json();
        
        // Update connection badges
        const botGlow = document.getElementById('bot-glow');
        const botStatusTxt = document.getElementById('bot-status-txt');
        const serverHealth = document.getElementById('server-connection-health');
        
        botGlow.className = 'pulse-dot';
        serverHealth.className = 'connection-pill';
        serverHealth.querySelector('span').textContent = 'API Connected';

        if (data.online && data.status === 'connected') {
            botGlow.classList.add('online');
            botStatusTxt.textContent = 'WhatsApp Online';
            botStatusTxt.style.color = '#10b981';
        } else if (data.online && data.status === 'connecting') {
            botGlow.classList.add('connecting');
            botStatusTxt.textContent = 'Connecting...';
            botStatusTxt.style.color = '#f59e0b';
        } else {
            botGlow.classList.add('offline');
            botStatusTxt.textContent = 'WhatsApp Offline';
            botStatusTxt.style.color = '#f43f5e';
        }

        // Update profile texts
        document.getElementById('bot-phone').textContent = data.phone ? `+${data.phone}` : 'Belum Terhubung';
        document.getElementById('bot-name').textContent = data.name || 'RemindMe Bot';
        
        // Update Telemetry grid
        document.getElementById('tel-uptime').textContent = formatDuration(data.uptime);
        document.getElementById('bot-uptime').textContent = `Uptime: ${formatDuration(data.uptime)}`;
        document.getElementById('tel-phone').textContent = data.phone ? `+${data.phone}` : '-';
        document.getElementById('tel-name').textContent = data.name || '-';
        document.getElementById('tel-heartbeat').innerHTML = data.online ? '<span style="color:#10b981;">● Aktif (Detak Aman)</span>' : '<span style="color:#f43f5e;">○ Mati (No Process)</span>';

        // QR Code Widget Controller
        const qrWidget = document.getElementById('qr-widget-container');
        if (data.status === 'connecting' && data.qr) {
            qrWidget.style.display = 'block';
            if (lastQrString !== data.qr) {
                lastQrString = data.qr;
                document.getElementById('qr-loading-overlay').classList.add('active');
                
                // Render QR code image using public service
                const qrImg = document.getElementById('whatsapp-qr-image');
                qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=10&data=${encodeURIComponent(data.qr)}`;
                qrImg.onload = () => {
                    document.getElementById('qr-loading-overlay').classList.remove('active');
                };
            }
        } else {
            qrWidget.style.display = 'none';
            lastQrString = '';
        }

    } catch (e) {
        // Handle server crash or backend offline
        document.getElementById('bot-glow').className = 'pulse-dot offline';
        document.getElementById('bot-status-txt').textContent = 'Server Offline';
        document.getElementById('bot-status-txt').style.color = '#f43f5e';
        
        const serverHealth = document.getElementById('server-connection-health');
        serverHealth.className = 'connection-pill disconnected';
        serverHealth.querySelector('span').textContent = 'API Disconnected';
    }
}

// Fetch logs
async function fetchLogs() {
    try {
        const res = await fetch(LOGS_URL, { headers: getAuthHeaders() });
        if (res.status === 401) { window.logout(); return; }
        
        const logs = await res.json();
        renderLogs(logs);
    } catch (e) { }
}

function renderLogs(logs) {
    const feed = document.getElementById('log-terminal-feed');
    if (!feed) return;

    if (logs.length === 0) {
        feed.innerHTML = '<div class="terminal-line system-msg">[SYSTEM] Belum ada log aktivitas terekam.</div>';
        return;
    }

    // Capture logs as text lines
    const logHTML = logs.map(log => {
        const date = new Date(log.timestamp);
        const timeStr = date.toLocaleTimeString('id-ID', { timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        let levelClass = 'log-info';
        if (log.level === 'warn') levelClass = 'log-warn';
        else if (log.level === 'error') levelClass = 'log-error';
        else if (log.level === 'cmd') levelClass = 'log-cmd';
        else if (log.level === 'cron') levelClass = 'log-cron';
        else if (log.level === 'web') levelClass = 'log-web';

        const tag = `[${log.level.toUpperCase()}]`;
        return `<div class="terminal-line"><span class="log-time">${timeStr}</span><span class="${levelClass}">${esc(tag)}</span> ${esc(log.message)}</div>`;
    }).join('');

    // Detect if user has scrolled up to prevent auto-scrolling
    const isAtBottom = feed.scrollHeight - feed.clientHeight <= feed.scrollTop + 40;

    feed.innerHTML = logHTML;

    if (isAtBottom) {
        feed.scrollTop = feed.scrollHeight;
    }
}

window.clearLogsDisplay = function() {
    document.getElementById('log-terminal-feed').innerHTML = '<div class="terminal-line system-msg">[SYSTEM] Tampilan logs dikosongkan secara lokal.</div>';
};

window.copyLogs = function() {
    const feed = document.getElementById('log-terminal-feed');
    const text = feed.innerText;
    navigator.clipboard.writeText(text)
        .then(() => alert('Logs berhasil disalin ke clipboard!'))
        .catch(() => alert('Gagal menyalin logs.'));
};

// Trigger Bot Action (Manually run reminder or force reconnect)
window.triggerBotAction = async function(action) {
    try {
        const res = await fetch(ACTION_URL, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ action })
        });
        const data = await res.json();
        if (res.ok) {
            alert(`Aksi '${action}' berhasil dikirim ke antrean bot!`);
            fetchLogs();
        } else {
            alert(`Gagal mengirim aksi: ${data.error}`);
        }
    } catch (e) {
        alert('Gagal berkomunikasi dengan server.');
    }
};

// ==========================================
// 2. GROUPS & BROADCAST
// ==========================================

async function fetchGroups() {
    try {
        const res = await fetch(SETTINGS_URL, { headers: getAuthHeaders() });
        cachedGroups = await res.json();
        
        renderGroupsList();
        renderGroupsCheckboxes();
    } catch(e) {}
}

function renderGroupsList() {
    const groupList = document.getElementById('group-list');
    if (!groupList) return;

    if (cachedGroups.length === 0) {
        groupList.innerHTML = '<div class="empty-state"><i class="ri-whatsapp-line"></i><p>Belum ada grup yang terhubung.</p></div>';
        return;
    }

    groupList.innerHTML = cachedGroups.map((g) => {
        const name = g.groupName ? esc(g.groupName) : g.reminderJid;
        return `
            <li class="task-item">
                <div class="task-info">
                    <span class="task-name">${name}</span>
                    <span class="badge none" style="font-size:0.7rem;margin-top:4px;">JID: ${g.reminderJid}</span>
                </div>
                <div class="task-actions">
                    <button class="action-btn btn-delete" onclick="window.extDeleteGroup('${g._id}')" title="Hapus Grup"><i class="ri-delete-bin-line"></i></button>
                </div>
            </li>`;
    }).join('');
}

function renderGroupsCheckboxes() {
    const addContainer = document.getElementById('add-group-checkboxes');
    const editContainer = document.getElementById('edit-group-checkboxes');
    const bcastContainer = document.getElementById('broadcast-group-checkboxes');

    const htmlContent = cachedGroups.map(g => {
        const name = g.groupName ? esc(g.groupName) : g.reminderJid;
        return `<label><input type="checkbox" value="${g.reminderJid}"> ${name}</label>`;
    }).join('');

    const emptyHtml = '<p class="no-groups-hint">Tidak ada grup WhatsApp terhubung. Gunakan !setgrup di WhatsApp.</p>';

    if (addContainer) addContainer.innerHTML = htmlContent || emptyHtml;
    if (editContainer) editContainer.innerHTML = htmlContent || emptyHtml;
    if (bcastContainer) bcastContainer.innerHTML = htmlContent || emptyHtml;

    // Populate Custom Command JID Select Option
    const selectJid = document.getElementById('command-target-jid');
    if (selectJid) {
        // Reset and keep global option
        selectJid.innerHTML = '<option value="global">Semua Grup (Global)</option>';
        cachedGroups.forEach(g => {
            const name = g.groupName ? esc(g.groupName) : g.reminderJid;
            selectJid.insertAdjacentHTML('beforeend', `<option value="${g.reminderJid}">${name}</option>`);
        });
    }
}

// Broadcast checkbox toggle helpers
window.selectAllBroadcastGroups = function(select) {
    const bcastContainer = document.getElementById('broadcast-group-checkboxes');
    if (!bcastContainer) return;
    const checkboxes = bcastContainer.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = select);
};

// Send Broadcast message handler
document.getElementById('broadcast-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = document.getElementById('broadcast-message-text').value.trim();
    const bcastContainer = document.getElementById('broadcast-group-checkboxes');
    const checked = Array.from(bcastContainer.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);

    if (!text) return;
    
    try {
        const res = await fetch(ACTION_URL, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                action: 'broadcast',
                params: {
                    text,
                    targetGroups: checked
                }
            })
        });
        
        if (res.ok) {
            alert('Aksi Broadcast pesan berhasil dikirim ke bot!');
            document.getElementById('broadcast-form').reset();
            fetchLogs();
        } else {
            alert('Gagal mengirim broadcast.');
        }
    } catch(err) {
        alert('Gagal menghubungi server.');
    }
});

// Delete target group
window.extDeleteGroup = function(id) {
    window.showAdminModal('<i class="ri-delete-bin-line"></i> Hapus Grup', 'Apakah Anda yakin ingin menghapus grup ini dari daftar notifikasi pengingat?', 'Ya, Hapus', '#ef4444', async () => {
        try {
            const res = await fetch(`${SETTINGS_URL}/${id}`, { 
                method: 'DELETE', 
                headers: getAuthHeaders() 
            });
            if (res.status === 401) { window.logout(); return; }
            fetchGroups();
            fetchLogs();
        } catch(err){}
    }, false);
};

// ==========================================
// 3. CUSTOM COMMANDS CRUD
// ==========================================

async function fetchCustomCommands() {
    try {
        const res = await fetch(CC_URL, { headers: getAuthHeaders() });
        customCommands = await res.json();
        renderCustomCommands();
    } catch(e) {}
}

function renderCustomCommands() {
    const list = document.getElementById('custom-commands-list');
    if (!list) return;

    if (customCommands.length === 0) {
        list.innerHTML = '<div class="empty-state"><i class="ri-terminal-box-line"></i><p>Belum ada custom commands terdaftar.</p></div>';
        return;
    }

    list.innerHTML = customCommands.map((c) => {
        const targetName = c.jid === 'global' ? 'Global (Semua)' : getGroupName(c.jid);
        const badgeClass = c.jid === 'global' ? 'cc-global-tag' : 'cc-group-tag';
        
        return `
            <li class="task-item custom-cmd-card" data-cmd="${esc(c.command)}">
                <div class="task-info">
                    <div class="task-name-row">
                        <span class="task-name" style="font-family:'Fira Code', monospace; color:#38bdf8;">${esc(c.command)}</span>
                        <span class="${badgeClass}">${esc(targetName)}</span>
                    </div>
                    <div class="task-detail" style="margin-top:4px; font-style:italic;">"${esc(c.response)}"</div>
                </div>
                <div class="task-actions">
                    <button class="action-btn btn-edit" onclick="window.editCustomCommand('${c._id}')" title="Edit"><i class="ri-pencil-line"></i></button>
                    <button class="action-btn btn-delete" onclick="window.deleteCustomCommand('${c._id}')" title="Hapus"><i class="ri-delete-bin-line"></i></button>
                </div>
            </li>`;
    }).join('');
}

// Find group name by JID
function getGroupName(jid) {
    const found = cachedGroups.find(g => g.reminderJid === jid);
    return found ? found.groupName || jid : jid;
}

// Search and filter commands
window.filterCustomCommands = function() {
    const search = document.getElementById('search-commands-input').value.toLowerCase().trim();
    const cards = document.querySelectorAll('.custom-cmd-card');
    
    cards.forEach(card => {
        const cmd = card.dataset.cmd.toLowerCase();
        if (cmd.includes(search)) {
            card.style.display = 'flex';
        } else {
            card.style.display = 'none';
        }
    });
};

// Form handler custom command (Add / Edit)
document.getElementById('custom-command-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('command-edit-id').value;
    const jid = document.getElementById('command-target-jid').value;
    const command = document.getElementById('command-trigger').value.trim();
    const response = document.getElementById('command-response').value.trim();

    if (!jid || !command || !response) return;

    const url = id ? `${CC_URL}/${id}` : CC_URL;
    const method = id ? 'PUT' : 'POST';

    try {
        const res = await fetch(url, {
            method,
            headers: getAuthHeaders(),
            body: JSON.stringify({ jid, command, response })
        });
        const data = await res.json();
        
        if (res.ok) {
            alert(id ? 'Custom command berhasil diperbarui!' : 'Custom command berhasil ditambahkan!');
            resetCommandForm();
            fetchCustomCommands();
            fetchLogs();
        } else {
            alert(`Gagal menyimpan: ${data.error}`);
        }
    } catch(err) {
        alert('Gagal menghubungi server.');
    }
});

window.editCustomCommand = function(id) {
    const found = customCommands.find(c => c._id === id);
    if (!found) return;

    document.getElementById('command-edit-id').value = found._id;
    document.getElementById('command-target-jid').value = found.jid;
    document.getElementById('command-trigger').value = found.command;
    document.getElementById('command-response').value = found.response;

    document.getElementById('command-form-title').innerHTML = '<i class="ri-pencil-line"></i> Edit Custom Command';
    
    // Add cancel button if not already exists
    const ccActions = document.getElementById('cc-form-actions');
    if (!document.getElementById('cc-btn-cancel')) {
        ccActions.insertAdjacentHTML('beforeend', `<button type="button" id="cc-btn-cancel" onclick="window.resetCommandForm()" class="btn-secondary">Batal</button>`);
    }
    
    // Scroll form into view
    document.getElementById('custom-command-form').scrollIntoView({ behavior: 'smooth' });
};

window.resetCommandForm = function() {
    document.getElementById('custom-command-form').reset();
    document.getElementById('command-edit-id').value = '';
    document.getElementById('command-form-title').innerHTML = '<i class="ri-terminal-box-line"></i> Buat Custom Command';
    
    const cancelBtn = document.getElementById('cc-btn-cancel');
    if (cancelBtn) cancelBtn.remove();
};

window.deleteCustomCommand = function(id) {
    const found = customCommands.find(c => c._id === id);
    if (!found) return;

    window.showAdminModal(
        '<i class="ri-delete-bin-line"></i> Hapus Command', 
        `Apakah Anda yakin ingin menghapus custom command <b>${esc(found.command)}</b>?`, 
        'Ya, Hapus', 
        '#ef4444', 
        async () => {
            try {
                const res = await fetch(`${CC_URL}/${id}`, { 
                    method: 'DELETE', 
                    headers: getAuthHeaders() 
                });
                if (res.status === 401) { window.logout(); return; }
                fetchCustomCommands();
                fetchLogs();
            } catch(err){}
        }, 
        false
    );
};

// ==========================================
// 4. MAIN TASK MANAGEMENT FUNCTIONS
// ==========================================

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
        renderTasks();
        fetchStats();
    } catch (error) {
        taskList.innerHTML = `<div class="empty-state"><i class="ri-error-warning-line"></i><p>Gagal memuat data.</p></div>`;
    }
}
window.fetchTasks = fetchTasks;

// Helper checklist reader
function getSelectedCheckboxes(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

// Add task submit handler
document.getElementById('task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('task-name').value;
    const date = document.getElementById('task-date').value;
    const detail = document.getElementById('task-detail').value;
    const priority = document.getElementById('task-priority').value;
    const tgs = getSelectedCheckboxes('add-group-checkboxes');
    
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ 
                name, 
                date, 
                detail, 
                priority, 
                targetGroups: tgs, 
                silent: tgs.length === 0 
            })
        });
        if (res.status === 409) {
            const data = await res.json();
            alert(data.error || 'Tugas duplikat sudah ada!');
            return;
        }
        document.getElementById('task-form').reset();
        document.getElementById('task-priority').value = 'normal';
        fetchTasks();
        fetchLogs();
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

function priorityBadge(p) {
    if (p === 'high') return '<span class="badge priority-high">🔥 Tinggi</span>';
    if (p === 'low') return '<span class="badge priority-low">📎 Rendah</span>';
    return '';
}

function renderTasks() {
    const pendingTasks = tasks.filter(t => t.status !== 'completed');
    const compTasks = tasks.filter(t => t.status === 'completed');

    const taskList = document.getElementById('task-list');
    const completedList = document.getElementById('completed-list');

    if (pendingTasks.length === 0) {
        taskList.innerHTML = `<div class="empty-state"><i class="ri-checkbox-circle-line"></i><p>Hebat! Tidak ada tugas pending.</p></div>`;
    } else {
        taskList.innerHTML = pendingTasks.map((task) => {
            const realIndex = tasks.indexOf(task);
            const timeInfo = getTimeRemaining(task.date || task.deadline);
            let dateFmt = 'Tanpa deadline';
            const targetDateStr = task.date || task.deadline;
            if (targetDateStr && targetDateStr.trim() !== '') {
                const dateObj = new Date(targetDateStr + '+08:00');
                if (!isNaN(dateObj.getTime())) {
                    const hasTime = targetDateStr.includes('T') || targetDateStr.includes(':');
                    const opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
                    if (hasTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
                    opts.timeZone = 'Asia/Makassar';
                    dateFmt = dateObj.toLocaleString('id-ID', opts).replace(',', '') + ' WITA';
                }
            }
            const detailHtml = task.detail ? `<div class="task-detail">${esc(task.detail)}</div>` : '';
            
            // Render specific group tags
            const groupsHtml = (task.targetGroups && task.targetGroups.length > 0)
                ? `<div class="task-groups-badge-list">${task.targetGroups.map(g => `<span class="group-badge">${esc(getGroupName(g))}</span>`).join('')}</div>`
                : '<div class="task-groups-badge-list"><span class="group-badge" style="color:#a5b4fc;border-color:rgba(99,102,241,0.15);background:rgba(99,102,241,0.05);"><i class="ri-global-line"></i> Global Broadcast</span></div>';

            return `
                <li class="task-item ${timeInfo.class === 'urgent' ? 'task-urgent' : ''}" data-index="${realIndex}">
                    <div class="task-info">
                        <div class="task-name-row"><span class="task-name">${esc(task.name)}</span>${priorityBadge(task.priority)}</div>
                        ${detailHtml}
                        <div class="task-date"><i class="ri-calendar-2-line"></i> ${dateFmt} <span class="badge ${timeInfo.class}">${timeInfo.text}</span></div>
                        ${groupsHtml}
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
        completedList.innerHTML = `<div class="empty-state"><i class="ri-ghost-line"></i><p>Belum ada tugas diselesaikan.</p></div>`;
    } else {
        completedList.innerHTML = compTasks.map((task) => {
            const realIndex = tasks.findIndex(t => t === task);
            const detailHtml = task.detail ? `<div class="task-detail">${esc(task.detail)}</div>` : '';
            const completedDate = task.completedAt ? new Date(task.completedAt).toLocaleString('id-ID', { timeZone: 'Asia/Makassar', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
            return `
                <li class="task-item completed" data-index="${realIndex}">
                    <div class="task-info">
                        <span class="task-name">${esc(task.name)}</span>
                        ${detailHtml}
                        <div class="task-date"><i class="ri-check-double-line"></i> Selesai${completedDate ? ' \u2014 ' + completedDate : ''}</div>
                    </div>
                    <div class="task-actions">
                        <button class="action-btn btn-delete" onclick="window.extDeleteTask(${realIndex})" title="Hapus Permanen"><i class="ri-delete-bin-line"></i></button>
                    </div>
                </li>`;
        }).join('');
    }
}

// Edit Task Modal Setup
const editModal = document.getElementById('edit-modal');
const editForm = document.getElementById('edit-form');

window.openEditModal = function(index) {
    const task = tasks[index];
    document.getElementById('edit-id').value = index;
    document.getElementById('edit-name').value = task.name;
    document.getElementById('edit-date').value = task.date || task.deadline || '';
    document.getElementById('edit-detail').value = task.detail || '';
    document.getElementById('edit-priority').value = task.priority || 'normal';
    
    // Group checklist populating
    const editContainer = document.getElementById('edit-group-checkboxes');
    if (editContainer) {
        const checkboxes = editContainer.querySelectorAll('input[type="checkbox"]');
        const activeJids = task.targetGroups || [];
        checkboxes.forEach(cb => {
            cb.checked = activeJids.includes(cb.value);
        });
    }
    
    editModal.classList.add('active');
};

function closeModal() { 
    editModal.classList.remove('active'); 
}
window.closeModal = closeModal;

editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-id').value;
    const name = document.getElementById('edit-name').value;
    const date = document.getElementById('edit-date').value;
    const detail = document.getElementById('edit-detail').value;
    const priority = document.getElementById('edit-priority').value;
    const tgs = getSelectedCheckboxes('edit-group-checkboxes');
    
    try {
        await fetch(`${API_URL}/${id}`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({ 
                name, 
                date, 
                detail, 
                priority, 
                targetGroups: tgs, 
                silent: tgs.length === 0 
            })
        });
        closeModal();
        fetchTasks();
        fetchLogs();
    } catch (e) { }
});

// Delete task
window.extDeleteTask = function(index) {
    const task = tasks[index];
    if (!task) return;
    
    window.showAdminModal(
        '<i class="ri-delete-bin-line"></i> Hapus Tugas', 
        `Yakin ingin menghapus tugas "<b>${esc(task.name)}</b>" secara permanen?`, 
        'Ya, Hapus', 
        '#f43f5e', 
        async (silent) => {
            try {
                const res = await fetch(`${API_URL}/${index}?silent=${silent}`, { 
                    method: 'DELETE', 
                    headers: getAuthHeaders() 
                });
                if (res.status === 401) { window.logout(); return; }
                fetchTasks();
                fetchLogs();
            } catch(err){}
        }
    );
};

// Complete task
window.completeTask = async function(index) {
    const task = tasks[index];
    if (!task) return;

    window.showAdminModal(
        '<i class="ri-check-line"></i> Tandai Selesai', 
        `Tandai tugas "<b>${esc(task.name)}</b>" sebagai selesai?`, 
        'Selesai', 
        '#10b981', 
        async (silent) => {
            try {
                await fetch(`${API_URL}/${index}`, { 
                    method: 'PATCH', 
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ status: 'completed', silent }) 
                });
                fetchTasks();
                fetchLogs();
            } catch(err){}
        }
    );
};

// ==========================================
// 5. CONFIRMATION DIALOG MODAL CONTROLLER
// ==========================================

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
