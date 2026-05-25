process.env.TZ = 'Asia/Makassar';
require('dotenv').config();
const { default: makeWASocket, DisconnectReason } = require('baileys-joss');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const { connectDB, Task, Setting, CustomCommand, BotStatus, BotLog, BotAction } = require('./database');
const { useMongoDBAuthState } = require('./mongoAuthState');

let globalSock = null;
let activeChangeStream = null;
let isReconnecting = false;
const botStartTime = new Date();

// Helper untuk log ke MongoDB Atlas
async function logBotEvent(level, message) {
    const timeStr = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Makassar' });
    console.log(`[${timeStr}] [${level.toUpperCase()}] ${message}`);
    try {
        await BotLog.create({ level, message });
    } catch (e) {
        console.error('⚠️ Gagal menyimpan log ke DB:', e.message);
    }
}

// Helper untuk memperbarui status bot di MongoDB
async function updateBotStatus(data) {
    try {
        await BotStatus.findOneAndUpdate(
            {},
            { ...data, lastActive: new Date() },
            { upsert: true, new: true }
        );
    } catch (e) {
        console.error('⚠️ Gagal memperbarui status bot:', e.message);
    }
}


// Lazy-loaded interactive message utilities
let _interactiveUtils = null;
async function getInteractive() {
    if (!_interactiveUtils) {
        const mod = await import('baileys-joss');
        _interactiveUtils = mod;
    }
    return _interactiveUtils;
}

async function sendButtons(sock, jid, body, buttons, footer) {
    try {
        const { generateQuickReplyButtons, generateWAMessageFromContent, generateMessageIDV2 } = await getInteractive();
        const content = generateQuickReplyButtons(body, buttons, { footer });
        // Wrap in viewOnceMessage to make interactive buttons work
        const msgContent = { viewOnceMessage: { message: content } };
        const msg = generateWAMessageFromContent(jid, msgContent, {
            userJid: sock.user.id,
            messageId: generateMessageIDV2()
        });
        await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    } catch (e) {
        console.error('⚠️ Button gagal, fallback ke teks:', e.message);
        await sock.sendMessage(jid, { text: body + (footer ? '\n\n' + footer : '') });
    }
}

async function sendList(sock, jid, content) {
    try {
        const { generateInteractiveListMessage, generateWAMessageFromContent, generateMessageIDV2 } = await getInteractive();
        const listContent = generateInteractiveListMessage(content);
        const msgContent = { viewOnceMessage: { message: listContent } };
        const msg = generateWAMessageFromContent(jid, msgContent, {
            userJid: sock.user.id,
            messageId: generateMessageIDV2()
        });
        await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    } catch (e) {
        console.error('⚠️ List gagal, fallback ke teks:', e.message);
        await sock.sendMessage(jid, { text: content.title });
    }
}

// ═══════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════

function getTimeRemaining(dateStr) {
    if (!dateStr) return { text: 'Belum ditentukan', diffMs: null, label: '⚪', level: 'none' };
    const now = new Date();
    const deadline = new Date(dateStr);
    if (isNaN(deadline.getTime())) return { text: 'Belum ditentukan', diffMs: null, label: '⚪', level: 'none' };

    const diffMs = deadline - now;
    if (diffMs < 0) {
        const h = Math.floor(Math.abs(diffMs) / 3600000);
        const d = Math.floor(h / 24);
        return { text: d > 0 ? `Terlewat ${d} hari ${h % 24} jam` : `Terlewat ${h} jam`, diffMs, label: '⚫', level: 'missed' };
    }
    const d = Math.floor(diffMs / 86400000);
    const h = Math.floor(diffMs / 3600000) % 24;
    const m = Math.floor(diffMs / 60000) % 60;

    if (d > 2) return { text: `${d} hari ${h} jam`, diffMs, label: '🟢', level: 'safe' };
    if (d > 0) return { text: `${d} hari ${h} jam`, diffMs, label: '🟡', level: 'warning' };
    if (h > 3) return { text: `${h} jam ${m} mnt`, diffMs, label: '🟡', level: 'warning' };
    if (h > 0) return { text: `${h} jam ${m} mnt`, diffMs, label: '🔴', level: 'critical' };
    return { text: `${m} menit lagi!`, diffMs, label: '🔴', level: 'critical' };
}

function formatDeadline(dateStr) {
    if (!dateStr) return 'Belum ditentukan';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'Belum ditentukan';
    const opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
    return d.toLocaleDateString('id-ID', opts) + ' WITA';
}

function priorityIcon(p) {
    return p === 'high' ? '🔥' : p === 'low' ? '📎' : '📌';
}

function progressBar(done, total, len = 12) {
    if (total === 0) return '░'.repeat(len) + ' 0%';
    const pct = Math.round((done / total) * 100);
    const filled = Math.round((done / total) * len);
    return '█'.repeat(filled) + '░'.repeat(len - filled) + ` ${pct}%`;
}

// ═══════════════════════════════════════
// COMMAND HANDLERS
// ═══════════════════════════════════════

async function cmdMenu(sock, jid) {
    const body = `╔═══════════════════╗
   📋 *REMINDME BOT*
╚═══════════════════╝

📝 *Manajemen Tugas*
├ !list — Daftar semua tugas
├ !detail <no> — Detail tugas
├ !tambah <nama> | <deadline> | <detail>
├ !selesai <no> — Tandai selesai
├ !hapus <no> — Hapus tugas
└ !stats — Statistik tugas

⚙️ *Pengaturan*
├ !setgrup — Aktifkan pengingat
├ !hapusgrup — Matikan pengingat
└ !info — Info bot

💡 *Contoh:*
_!tambah PR Matematika | 2026-05-20T08:00 | Hal 45-50_`;

    await sendButtons(sock, jid, body, [
        { id: 'btn_list', displayText: '📋 Daftar Tugas' },
        { id: 'btn_stats', displayText: '📊 Statistik' },
        { id: 'btn_info', displayText: '🤖 Info Bot' }
    ], '⬆️ Pilih menu di atas');
}

async function cmdList(sock, jid) {
    const q = { status: { $ne: 'completed' }, $or: [{targetGroups: jid}, {targetGroups: {$size: 0}}, {targetGroups: {$exists: false}}] };
    const tasks = await Task.find(q).sort({ createdAt: 1 });
    if (tasks.length === 0) {
        await sendButtons(sock, jid,
            '╔═══════════════════╗\n   📋 *DAFTAR TUGAS*\n╚═══════════════════╝\n\n✨ Tidak ada tugas aktif!',
            [{ id: 'btn_menu', displayText: '📋 Menu Utama' }],
            'Gunakan *!tambah* untuk menambah tugas.'
        );
        return;
    }

    const allQ = { $or: [{targetGroups: jid}, {targetGroups: {$size: 0}}, {targetGroups: {$exists: false}}] };
    const allTasks = await Task.find(allQ).sort({ createdAt: 1 });
    const completed = allTasks.filter(t => t.status === 'completed').length;

    let lines = [];
    tasks.forEach((task, i) => {
        const time = getTimeRemaining(task.deadline);
        const pIcon = priorityIcon(task.priority);
        let line = `${i + 1}. *${task.name}*\n   ${time.label} ${time.text}`;
        if (task.deadline) line += `\n   📅 ${formatDeadline(task.deadline)}`;
        if (task.detail) line += `\n   📝 _${task.detail}_`;
        line += `\n   ${pIcon} ${(task.priority || 'normal').charAt(0).toUpperCase() + (task.priority || 'normal').slice(1)}`;
        lines.push(line);
    });

    const bar = progressBar(completed, allTasks.length);
    const body = `╔═══════════════════╗\n   📋 *DAFTAR TUGAS AKTIF*\n╚═══════════════════╝\n\n${lines.join('\n\n')}\n\n──────────────────\n📊 Total: ${allTasks.length} | ✅ ${completed} | ⏳ ${tasks.length}\n[${bar}]`;

    // Build action buttons based on task count
    const btns = [];
    if (tasks.length >= 1) btns.push({ id: 'btn_detail_1', displayText: '📄 Detail #1' });
    if (tasks.length >= 2) btns.push({ id: 'btn_detail_2', displayText: '📄 Detail #2' });
    btns.push({ id: 'btn_menu', displayText: '📋 Menu Utama' });

    // Ensure we don't exceed max 3 buttons for WhatsApp
    const finalBtns = btns.slice(0, 3);
    
    if (finalBtns.length > 0) {
        await sendButtons(sock, jid, body, finalBtns, '⬆️ Pilih aksi cepat | Ketik !detail <no> untuk tugas lain');
    } else {
        await sock.sendMessage(jid, { text: body });
    }
}

async function cmdDetail(sock, jid, args) {
    const num = parseInt(args);
    if (!num || num < 1) {
        await sock.sendMessage(jid, { text: '❌ Format: *!detail <nomor>*\nContoh: _!detail 1_' });
        return;
    }
    const q = { status: { $ne: 'completed' }, $or: [{targetGroups: jid}, {targetGroups: {$size: 0}}, {targetGroups: {$exists: false}}] };
    const tasks = await Task.find(q).sort({ createdAt: 1 });
    const task = tasks[num - 1];
    if (!task) {
        await sock.sendMessage(jid, { text: `❌ Tugas #${num} tidak ditemukan. Ketik *!list* untuk melihat daftar.` });
        return;
    }
    const time = getTimeRemaining(task.deadline);
    const msg = `╔═══════════════════╗
   📄 *DETAIL TUGAS #${num}*
╚═══════════════════╝

*Nama:* ${task.name}
*Deadline:* ${formatDeadline(task.deadline)}
*Sisa Waktu:* ${time.label} ${time.text}
*Detail:* ${task.detail || '-'}
*Prioritas:* ${priorityIcon(task.priority)} ${(task.priority || 'normal').charAt(0).toUpperCase() + (task.priority || 'normal').slice(1)}
*Status:* ⏳ Pending
*Dibuat:* ${formatDeadline(task.createdAt)}`;
    await sock.sendMessage(jid, { text: msg });
}

async function cmdTambah(sock, jid, args) {
    if (!args) {
        await sock.sendMessage(jid, { text: '❌ Format: *!tambah <nama> | <deadline> | <detail>*\n\n💡 Contoh:\n_!tambah PR Matematika | 2026-05-20T08:00 | Hal 45-50_\n_!tambah Presentasi_\n_!tambah Essay | 2026-05-18_' });
        return;
    }
    const parts = args.split('|').map(s => s.trim());
    const name = parts[0];
    const deadline = parts[1] || '';
    const detail = parts[2] || '';

    if (deadline && isNaN(new Date(deadline).getTime())) {
        await sock.sendMessage(jid, { text: '❌ Format deadline salah!\nGunakan: *YYYY-MM-DDTHH:mm*\nContoh: _2026-05-20T08:00_' });
        return;
    }
    const task = await Task.create({ name, deadline, detail, status: 'pending', priority: 'normal', targetGroups: [jid] });
    const time = getTimeRemaining(deadline);
    const body = `✅ *Tugas berhasil ditambahkan!*\n──────────────────\n*Nama:* ${name}\n*Deadline:* ${formatDeadline(deadline)}\n*Sisa:* ${time.label} ${time.text}\n*Detail:* ${detail || '-'}`;
    await sendButtons(sock, jid, body, [
        { id: 'btn_list', displayText: '📋 Lihat Daftar' },
        { id: 'btn_stats', displayText: '📊 Statistik' }
    ], 'RemindMe Bot');
}

async function cmdSelesai(sock, jid, args) {
    const num = parseInt(args);
    if (!num || num < 1) {
        await sock.sendMessage(jid, { text: '❌ Format: *!selesai <nomor>*\nContoh: _!selesai 1_\n\nKetik *!list* untuk melihat nomor tugas.' });
        return;
    }
    const q = { status: { $ne: 'completed' }, $or: [{targetGroups: jid}, {targetGroups: {$size: 0}}, {targetGroups: {$exists: false}}] };
    const tasks = await Task.find(q).sort({ createdAt: 1 });
    const task = tasks[num - 1];
    if (!task) {
        await sock.sendMessage(jid, { text: `❌ Tugas #${num} tidak ditemukan.` });
        return;
    }
    await Task.findByIdAndUpdate(task._id, { status: 'completed', completedAt: new Date() });
    const remaining = tasks.length - 1;
    await sendButtons(sock, jid,
        `🎉 *${task.name}* telah diselesaikan!\n\n⏳ Sisa tugas aktif: ${remaining}`,
        [
            { id: 'btn_list', displayText: '📋 Lihat Daftar' },
            { id: 'btn_stats', displayText: '📊 Statistik' },
            { id: 'btn_menu', displayText: '📋 Menu' }
        ],
        'RemindMe Bot'
    );
}

async function cmdHapus(sock, jid, args) {
    const num = parseInt(args);
    if (!num || num < 1) {
        await sock.sendMessage(jid, { text: '❌ Format: *!hapus <nomor>*\nContoh: _!hapus 1_' });
        return;
    }
    const q = { status: { $ne: 'completed' }, $or: [{targetGroups: jid}, {targetGroups: {$size: 0}}, {targetGroups: {$exists: false}}] };
    const tasks = await Task.find(q).sort({ createdAt: 1 });
    const task = tasks[num - 1];
    if (!task) {
        await sock.sendMessage(jid, { text: `❌ Tugas #${num} tidak ditemukan.` });
        return;
    }
    await Task.findByIdAndDelete(task._id);
    await sendButtons(sock, jid,
        `🗑️ *${task.name}* telah dihapus.`,
        [
            { id: 'btn_list', displayText: '📋 Lihat Daftar' },
            { id: 'btn_menu', displayText: '📋 Menu' }
        ],
        'RemindMe Bot'
    );
}

async function cmdStats(sock, jid) {
    const q = { $or: [{targetGroups: jid}, {targetGroups: {$size: 0}}, {targetGroups: {$exists: false}}] };
    const all = await Task.find(q);
    const completed = all.filter(t => t.status === 'completed');
    const pending = all.filter(t => t.status !== 'completed');
    const missed = pending.filter(t => {
        if (!t.deadline) return false;
        return new Date(t.deadline) < new Date();
    });
    const critical = pending.filter(t => {
        if (!t.deadline) return false;
        const diff = new Date(t.deadline) - new Date();
        return diff > 0 && diff <= 3 * 3600000;
    });

    const bar = progressBar(completed.length, all.length);
    let mood = '😐 Biasa saja';
    const pct = all.length > 0 ? (completed.length / all.length) * 100 : 0;
    if (pct >= 80) mood = '🏆 Luar biasa!';
    else if (pct >= 60) mood = '💪 Bagus!';
    else if (pct >= 40) mood = '👍 Lumayan';
    else if (pct > 0) mood = '📈 Ayo semangat!';

    const msg = `╔═══════════════════╗
   📊 *STATISTIK TUGAS*
╚═══════════════════╝

📌 Total Tugas    : ${all.length}
✅ Selesai        : ${completed.length}
⏳ Pending        : ${pending.length}
🔴 Terlewat       : ${missed.length}
🚨 Kritis (≤3jam) : ${critical.length}

[${bar}]

${mood}`;
    await sock.sendMessage(jid, { text: msg });
}

async function cmdInfo(sock, jid) {
    const uptime = Math.floor((Date.now() - botStartTime.getTime()) / 60000);
    const h = Math.floor(uptime / 60);
    const m = uptime % 60;
    const groups = await Setting.find();
    const msg = `╔═══════════════════╗
   🤖 *INFO REMINDME BOT*
╚═══════════════════╝

📡 Status: ${globalSock ? '🟢 Online' : '🔴 Offline'}
⏱️ Uptime: ${h} jam ${m} menit
🌐 Timezone: Asia/Makassar (WITA)
📢 Grup terhubung: ${groups.length}
🔔 Cron aktif:
   • 08:00 — Pengingat pagi
   • Setiap jam — Cek tugas kritis
   • 21:00 — Preview besok

📦 Versi: 2.0.0`;
    await sock.sendMessage(jid, { text: msg });
}

// ═══════════════════════════════════════
// BROADCAST REMINDER
// ═══════════════════════════════════════

async function broadcastReminder(sock, targetJid, mode = 'all') {
    let targetGroups = [];
    if (targetJid) {
        targetGroups.push({ reminderJid: targetJid });
    } else {
        targetGroups = await Setting.find();
    }

    for (const group of targetGroups) {
        const jid = group.reminderJid;
        const q = { status: { $nin: ['completed', 'deleted'] }, $or: [{targetGroups: jid}, {targetGroups: {$size: 0}}, {targetGroups: {$exists: false}}] };
        const tasks = await Task.find(q).sort({ createdAt: 1 });

        if (tasks.length === 0 && targetJid) {
            await sock.sendMessage(targetJid, { text: '✨ Tidak ada tugas aktif.' });
            continue;
        }

        const messages = [];
        tasks.forEach((task, i) => {
            const time = getTimeRemaining(task.deadline);

            if (mode === 'critical') {
                if (time.level === 'critical' || time.level === 'missed') {
                    messages.push(`${i + 1}. *${task.name}*\n   ${time.label} ${time.text}${task.deadline ? '\n   📅 ' + formatDeadline(task.deadline) : ''}`);
                }
            } else if (mode === 'evening') {
                if (time.diffMs !== null && time.diffMs > 0 && time.diffMs <= 86400000) {
                    messages.push(`${i + 1}. *${task.name}*\n   ${time.label} ${time.text}\n   📅 ${formatDeadline(task.deadline)}`);
                }
            } else {
                if (targetJid) {
                    messages.push(`${i + 1}. *${task.name}*\n   ${time.label} ${time.text}${task.deadline ? '\n   📅 ' + formatDeadline(task.deadline) : ''}${task.detail ? '\n   📝 _' + task.detail + '_' : ''}`);
                } else {
                    const isH3 = time.diffMs !== null && time.diffMs > 86400000 && time.diffMs <= 259200000;
                    const isHariH = time.diffMs !== null && time.diffMs > 0 && time.diffMs <= 86400000;
                    const isCritical = time.level === 'critical';
                    const isMissed = time.level === 'missed';
                    if (isH3 || isHariH || isCritical || isMissed) {
                        messages.push(`${i + 1}. *${task.name}*\n   ${time.label} ${time.text}\n   📅 ${formatDeadline(task.deadline)}`);
                    }
                }
            }
        });

        if (messages.length > 0) {
            let header;
            if (mode === 'critical') header = '⚠️ *DEADLINE MENDEKAT!*';
            else if (mode === 'evening') header = '🌙 *PREVIEW TUGAS BESOK*';
            else header = '📋 *PENGINGAT TUGAS*';

            const msgText = `╔═══════════════════╗\n   ${header}\n╚═══════════════════╝\n\n${messages.join('\n\n')}\n\n──────────────────`;

            try {
                await sock.sendMessage(jid, { text: msgText });
                if (!targetJid) {
                    await logBotEvent('cron', `Pengingat [${mode}] otomatis terkirim ke grup ${group.groupName || jid}`);
                } else {
                    await logBotEvent('info', `Pengingat manual [${mode}] dikirim ke ${jid}`);
                }
            } catch (e) {
                await logBotEvent('error', `Gagal mengirim pengingat ke ${jid}: ${e.message}`);
            }
        }
    }
}

// ═══════════════════════════════════════
// CHANGE STREAM (Real-time DB monitor)
// ═══════════════════════════════════════

function setupChangeStream() {
    if (activeChangeStream) {
        activeChangeStream.close().catch(() => {});
        activeChangeStream = null;
    }

    logBotEvent('info', 'Memantau perubahan database tugas secara real-time...');
    const changeStream = Task.watch([], { fullDocument: 'updateLookup' });
    activeChangeStream = changeStream;

    changeStream.on('change', async (change) => {
        if (!globalSock) return;
        const allSettings = await Setting.find();
        if (allSettings.length === 0) return;

        let msg = null;
        let taskTargetGroups = null; // null = send to all groups

        if (change.operationType === 'insert') {
            const t = change.fullDocument;
            if (!t.silent) {
                const time = getTimeRemaining(t.deadline);
                msg = `📥 *Tugas Baru Ditambahkan*\n──────────────────\n*Nama:* ${t.name}\n*Deadline:* ${formatDeadline(t.deadline)}\n*Sisa:* ${time.label} ${time.text}\n*Detail:* ${t.detail || '-'}\n*Prioritas:* ${priorityIcon(t.priority)} ${(t.priority || 'normal')}`;
                if (t.targetGroups && t.targetGroups.length > 0) taskTargetGroups = t.targetGroups;
            }
        } else if (change.operationType === 'update' && change.fullDocument) {
            const t = change.fullDocument;
            const updatedFields = change.updateDescription?.updatedFields || {};

            if (updatedFields.status === 'completed' && !t.silent) {
                msg = `✅ *Tugas Diselesaikan*\n──────────────────\n*${t.name}* telah ditandai selesai! 🎉`;
                if (t.targetGroups && t.targetGroups.length > 0) taskTargetGroups = t.targetGroups;
            } else if (updatedFields.status === 'deleted') {
                return; // Silent soft delete, ignore in stream
            } else if (!updatedFields.status && Object.keys(updatedFields).length > 0 && !t.silent) {
                const time = getTimeRemaining(t.deadline);
                msg = `✏️ *Tugas Diedit*\n──────────────────\n*Nama:* ${t.name}\n*Deadline:* ${formatDeadline(t.deadline)}\n*Sisa:* ${time.label} ${time.text}\n*Detail:* ${t.detail || '-'}\n*Prioritas:* ${priorityIcon(t.priority)} ${(t.priority || 'normal').charAt(0).toUpperCase() + (t.priority || 'normal').slice(1)}`;
                if (t.targetGroups && t.targetGroups.length > 0) taskTargetGroups = t.targetGroups;
            }
        } else if (change.operationType === 'delete') {
            msg = `🗑️ *Tugas Dihapus*\n──────────────────\nSatu tugas telah dihapus dari daftar.`;
        }

        if (msg) {
            let sentCount = 0;
            for (const s of allSettings) {
                // If task has specific targetGroups, only send to those
                if (taskTargetGroups && !taskTargetGroups.includes(s.reminderJid)) continue;
                try { 
                    await globalSock.sendMessage(s.reminderJid, { text: msg }); 
                    sentCount++;
                }
                catch (e) { await logBotEvent('error', `Gagal mengirim notif perubahan tugas ke ${s.reminderJid}: ${e.message}`); }
            }
            if (sentCount > 0) {
                await logBotEvent('info', `Notifikasi perubahan tugas disiarkan ke ${sentCount} grup WhatsApp.`);
            }
        }
    });

    changeStream.on('error', async (err) => {
        await logBotEvent('error', `Change Stream Pemantauan Tugas Error: ${err.message}`);
        activeChangeStream = null;
        setTimeout(() => { if (globalSock) setupChangeStream(); }, 10000);
    });
}

// ═══════════════════════════════════════
// BUTTON ID → COMMAND MAPPING
// ═══════════════════════════════════════

function mapButtonToCommand(btnId) {
    const map = {
        'btn_menu': '!menu',
        'btn_list': '!list',
        'btn_stats': '!stats',
        'btn_info': '!info',
        'btn_setgrup': '!setgrup',
    };
    if (map[btnId]) return map[btnId];

    // Dynamic buttons: btn_detail_1 → !detail 1, btn_selesai_2 → !selesai 2
    const match = btnId.match(/^btn_(detail|selesai|hapus)_(\d+)$/);
    if (match) return `!${match[1]} ${match[2]}`;

    return '';
}

// ═══════════════════════════════════════
// BOT ACTION STREAM (Real-time Web Controls)
// ═══════════════════════════════════════

let activeActionStream = null;
function setupBotActionStream() {
    if (activeActionStream) {
        activeActionStream.close().catch(() => {});
        activeActionStream = null;
    }

    logBotEvent('info', 'Memantau instruksi kendali (BotAction) dari Web secara real-time...');
    const actionStream = BotAction.watch();
    activeActionStream = actionStream;

    actionStream.on('change', async (change) => {
        if (change.operationType === 'insert') {
            const actionDoc = change.fullDocument;
            if (actionDoc.status !== 'pending') return;

            await logBotEvent('info', `Menerima perintah aksi dari Web: ${actionDoc.action}`);

            try {
                if (actionDoc.action === 'morning_reminder') {
                    if (globalSock) {
                        await broadcastReminder(globalSock, null, 'all');
                        await logBotEvent('cron', 'Pengingat pagi manual berhasil dipicu dan dikirim.');
                    } else {
                        throw new Error('Bot sedang offline / tidak terhubung ke WhatsApp');
                    }
                } else if (actionDoc.action === 'evening_reminder') {
                    if (globalSock) {
                        await broadcastReminder(globalSock, null, 'evening');
                        await logBotEvent('cron', 'Pengingat malam manual berhasil dipicu dan dikirim.');
                    } else {
                        throw new Error('Bot sedang offline / tidak terhubung ke WhatsApp');
                    }
                } else if (actionDoc.action === 'critical_reminder') {
                    if (globalSock) {
                        await broadcastReminder(globalSock, null, 'critical');
                        await logBotEvent('cron', 'Pengingat kritis manual berhasil dipicu dan dikirim.');
                    } else {
                        throw new Error('Bot sedang offline / tidak terhubung ke WhatsApp');
                    }
                } else if (actionDoc.action === 'reconnect') {
                    await logBotEvent('warn', 'Mengeksekusi instruksi Paksa Reconnect...');
                    if (globalSock) {
                        globalSock.end(new Error('Manual reconnect request'));
                    } else {
                        startBot();
                    }
                } else if (actionDoc.action === 'broadcast') {
                    if (globalSock) {
                        const { text, targetGroups } = actionDoc.params;
                        if (!text) throw new Error('Isi teks broadcast tidak boleh kosong');
                        
                        let groups = [];
                        if (targetGroups && targetGroups.length > 0) {
                            groups = targetGroups.map(jid => ({ reminderJid: jid }));
                        } else {
                            groups = await Setting.find();
                        }

                        for (const g of groups) {
                            await globalSock.sendMessage(g.reminderJid, { text });
                            await logBotEvent('info', `Pesan broadcast terkirim ke grup: ${g.reminderJid}`);
                        }
                    } else {
                        throw new Error('Bot sedang offline / tidak terhubung ke WhatsApp');
                    }
                }

                await BotAction.findByIdAndUpdate(actionDoc._id, { status: 'processed' });
            } catch (err) {
                await logBotEvent('error', `Gagal menjalankan instruksi ${actionDoc.action}: ${err.message}`);
                await BotAction.findByIdAndUpdate(actionDoc._id, { status: 'failed' });
            }
        }
    });

    actionStream.on('error', async (err) => {
        await logBotEvent('error', `BotAction Stream Error: ${err.message}`);
        activeActionStream = null;
        setTimeout(() => { setupBotActionStream(); }, 10000);
    });
}

// ═══════════════════════════════════════
// WHATSAPP BOT
// ═══════════════════════════════════════

let heartbeatInterval = null;

async function startBot() {
    if (isReconnecting) return;
    isReconnecting = true;

    try {
        await connectDB();
        
        // Aktifkan pemantau aksi instan dari Web
        setupBotActionStream();

        // Aktifkan status detak jantung berkala setiap 30 detik
        if (!heartbeatInterval) {
            heartbeatInterval = setInterval(async () => {
                if (globalSock) {
                    const uptimeMs = Date.now() - botStartTime.getTime();
                    await updateBotStatus({
                        status: 'connected',
                        uptime: uptimeMs,
                        phone: globalSock.user?.id ? globalSock.user.id.split(':')[0] : '',
                        name: globalSock.user?.name || 'RemindMe Bot',
                        qr: ''
                    });
                } else {
                    await updateBotStatus({ lastActive: new Date() });
                }
            }, 30000);
        }

        const { state, saveCreds } = await useMongoDBAuthState();

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' })
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrcode.generate(qr, { small: true });
                await updateBotStatus({ status: 'connecting', qr });
                await logBotEvent('warn', 'QR Code baru terbit. Silakan scan dari terminal server atau web admin.');
            }

            if (connection === 'close') {
                globalSock = null;
                const code = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = code !== DisconnectReason.loggedOut;
                await logBotEvent('error', `Koneksi WhatsApp terputus (${code}). Melakukan sambung ulang: ${shouldReconnect}`);
                
                let dbStatus = 'disconnected';
                if (code === DisconnectReason.loggedOut) {
                    dbStatus = 'disconnected';
                    try {
                        const mongoose = require('mongoose');
                        await mongoose.connection.db.collection('authsessions').deleteMany({});
                        await logBotEvent('warn', 'Sesi keluar terdeteksi, membersihkan credentials di database.');
                    } catch (e) {
                        console.error('Gagal menghapus auth state:', e.message);
                    }
                } else {
                    dbStatus = 'connecting';
                }
                
                await updateBotStatus({ status: dbStatus, qr: '' });
                isReconnecting = false;
                if (shouldReconnect) {
                    setTimeout(() => startBot(), 5000);
                }
            } else if (connection === 'open') {
                globalSock = sock;
                isReconnecting = false;
                const phone = sock.user.id.split(':')[0];
                const name = sock.user.name || 'RemindMe Bot';
                await updateBotStatus({
                    status: 'connected',
                    qr: '',
                    phone,
                    name,
                    uptime: Date.now() - botStartTime.getTime()
                });
                await logBotEvent('info', `Koneksi WhatsApp berhasil tersambung! No: ${phone} (${name})`);
                setupChangeStream();
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const jid = msg.key.remoteJid;

            // Unwrap viewOnceMessage / ephemeralMessage to get inner content
            let innerMsg = msg.message;
            if (innerMsg?.viewOnceMessage?.message) innerMsg = innerMsg.viewOnceMessage.message;
            if (innerMsg?.ephemeralMessage?.message) innerMsg = innerMsg.ephemeralMessage.message;
            if (innerMsg?.viewOnceMessageV2?.message) innerMsg = innerMsg.viewOnceMessageV2.message;

            // Handle interactive button responses
            const btnResponseId = innerMsg?.buttonsResponseMessage?.selectedButtonId;
            const nativeFlowJson = innerMsg?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
            const listResponseId = innerMsg?.listResponseMessage?.singleSelectReply?.selectedRowId;
            const templateBtnId = innerMsg?.templateButtonReplyMessage?.selectedId;

            let text = '';
            if (btnResponseId) {
                text = mapButtonToCommand(btnResponseId);
            } else if (nativeFlowJson) {
                let btnId = '';
                try { btnId = JSON.parse(nativeFlowJson).id || ''; } catch (_) {}
                text = mapButtonToCommand(btnId);
            } else if (listResponseId) {
                text = mapButtonToCommand(listResponseId);
            } else if (templateBtnId) {
                text = mapButtonToCommand(templateBtnId);
            } else {
                text = (innerMsg?.conversation || innerMsg?.extendedTextMessage?.text || '').trim();
            }

            if (!text.startsWith('!')) return;

            const [cmd, ...rest] = text.split(' ');
            const args = rest.join(' ').trim();

            const sender = msg.key.participant || msg.key.remoteJid;
            const isGroup = jid.endsWith('@g.us');
            const sourceName = isGroup ? `Grup: ${jid}` : `Pribadi: ${jid}`;

            try {
                await logBotEvent('cmd', `Menjalankan perintah '${cmd}' dari ${sender.split('@')[0]} di ${sourceName}`);

                switch (cmd.toLowerCase()) {
                    case '!menu': case '!help':
                        await cmdMenu(sock, jid); break;
                    case '!list':
                        await cmdList(sock, jid); break;
                    case '!detail':
                        await cmdDetail(sock, jid, args); break;
                    case '!tambah':
                        await cmdTambah(sock, jid, args); break;
                    case '!selesai':
                        await cmdSelesai(sock, jid, args); break;
                    case '!hapus':
                        await cmdHapus(sock, jid, args); break;
                    case '!stats':
                        await cmdStats(sock, jid); break;
                    case '!info':
                        await cmdInfo(sock, jid); break;
                    case '!setgrup':
                        let gName = jid;
                        if (jid.endsWith('@g.us')) {
                            try {
                                const metadata = await sock.groupMetadata(jid);
                                gName = metadata.subject || jid;
                            } catch (e) { console.error('Gagal ambil nama grup', e); }
                        }
                        await Setting.findOneAndUpdate(
                            { reminderJid: jid },
                            { reminderJid: jid, groupName: gName },
                            { upsert: true }
                        );
                        await sock.sendMessage(jid, { text: '✅ Grup ini akan menerima pengingat otomatis.' });
                        await logBotEvent('info', `Grup ${gName} diaktifkan untuk pengingat otomatis.`);
                        break;
                    case '!hapusgrup':
                        await Setting.findOneAndDelete({ reminderJid: jid });
                        await sock.sendMessage(jid, { text: '🔕 Pengingat otomatis dimatikan untuk grup ini.' });
                        await logBotEvent('info', `Grup ${jid} dihapus dari daftar pengingat otomatis.`);
                        break;
                    case '!addcmd':
                        if (!args.includes('|')) {
                            await sock.sendMessage(jid, { text: '❌ Format: *!addcmd <perintah> | <balasan>*\nContoh: _!addcmd !jadwal | Jadwal MTK hari rabu_' });
                        } else {
                            const p = args.split('|');
                            const newCmd = p[0].trim().toLowerCase();
                            const newResp = p.slice(1).join('|').trim();
                            if (!newCmd.startsWith('!')) {
                                await sock.sendMessage(jid, { text: '❌ Perintah harus diawali dengan tanda seru (!). Contoh: _!jadwal_' });
                            } else {
                                await CustomCommand.findOneAndUpdate(
                                    { jid, command: newCmd },
                                    { jid, command: newCmd, response: newResp },
                                    { upsert: true }
                                );
                                await sock.sendMessage(jid, { text: '✅ Custom command *'+newCmd+'* berhasil disimpan untuk grup ini.' });
                                await logBotEvent('info', `Custom command '${newCmd}' ditambahkan/diperbarui untuk grup ${jid}`);
                            }
                        }
                        break;
                    case '!delcmd':
                        const delCmd = args.trim().toLowerCase();
                        if (!delCmd) {
                            await sock.sendMessage(jid, { text: '❌ Format: *!delcmd <perintah>*\nContoh: _!delcmd !jadwal_' });
                        } else {
                            const res = await CustomCommand.findOneAndDelete({ jid, command: delCmd });
                            if (res) {
                                await sock.sendMessage(jid, { text: '✅ Custom command *'+delCmd+'* dihapus.' });
                                await logBotEvent('info', `Custom command '${delCmd}' dihapus dari grup ${jid}`);
                            }
                            else await sock.sendMessage(jid, { text: '❌ Command *'+delCmd+'* tidak ditemukan di grup ini.' });
                        }
                        break;
                    case '!listcmd':
                        const cmds = await CustomCommand.find({ jid });
                        if (cmds.length === 0) {
                            await sock.sendMessage(jid, { text: '✨ Belum ada custom command di grup ini.' });
                        } else {
                            const listStr = cmds.map(c => '• ' + c.command).join('\n');
                            await sock.sendMessage(jid, { text: '╔═══════════════════╗\n   🛠️ *CUSTOM COMMANDS*\n╚═══════════════════╝\n\n' + listStr });
                        }
                        break;
                    default:
                        const custom = await CustomCommand.findOne({
                            $or: [
                                { jid, command: cmd.toLowerCase() },
                                { jid: 'global', command: cmd.toLowerCase() }
                            ]
                        });
                        if (custom) {
                            await sock.sendMessage(jid, { text: custom.response });
                            await logBotEvent('cmd', `Custom Command '${cmd}' dipicu oleh ${sender.split('@')[0]} di ${jid}`);
                        } else {
                            await sock.sendMessage(jid, { text: '❓ Perintah tidak dikenali. Ketik *!menu* untuk bantuan.' });
                        }
                }
            } catch (err) {
                await logBotEvent('error', `Gagal mengeksekusi perintah '${cmd}': ${err.message}`);
                await sock.sendMessage(jid, { text: '❌ Terjadi kesalahan. Coba lagi nanti.' });
            }
        });
    } catch (err) {
        console.error('❌ Gagal memulai bot:', err.message);
        isReconnecting = false;
        setTimeout(() => startBot(), 10000);
    }
}

// ═══════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════

// Pengingat pagi jam 8
cron.schedule('0 8 * * *', async () => {
    console.log('⏰ Cron pagi: semua pengingat');
    if (globalSock) await broadcastReminder(globalSock, null, 'all');
}, { timezone: "Asia/Makassar" });

// Cek tugas kritis setiap jam
cron.schedule('0 * * * *', async () => {
    const now = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Makassar' });
    console.log(`⏰ [${now}] Cek tugas kritis`);
    if (globalSock) await broadcastReminder(globalSock, null, 'critical');
}, { timezone: "Asia/Makassar" });

// Preview besok jam 21
cron.schedule('0 21 * * *', async () => {
    console.log('⏰ Cron malam: preview besok');
    if (globalSock) await broadcastReminder(globalSock, null, 'evening');
}, { timezone: "Asia/Makassar" });

startBot();
