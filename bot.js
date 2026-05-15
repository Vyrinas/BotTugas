process.env.TZ = 'Asia/Makassar';
require('dotenv').config();
const { default: makeWASocket, DisconnectReason } = require('baileys-joss');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const { connectDB, Task, Setting } = require('./database');
const { useMongoDBAuthState } = require('./mongoAuthState');

let globalSock = null;
let activeChangeStream = null;
let isReconnecting = false;
const botStartTime = new Date();

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
    const msg = `╔══════════════════════════╗
     📋 *REMINDME BOT*
╚══════════════════════════╝

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
_!tambah PR Matematika | 2026-05-20T08:00 | Hal 45-50_
_!selesai 1_`;
    await sock.sendMessage(jid, { text: msg });
}

async function cmdList(sock, jid) {
    const tasks = await Task.find({ status: { $ne: 'completed' } }).sort({ createdAt: 1 });
    if (tasks.length === 0) {
        await sock.sendMessage(jid, { text: '╔══════════════════════════╗\n     📋 *DAFTAR TUGAS*\n╚══════════════════════════╝\n\n✨ Tidak ada tugas aktif!\nGunakan *!tambah* untuk menambah tugas.' });
        return;
    }

    const allTasks = await Task.find().sort({ createdAt: 1 });
    const completed = allTasks.filter(t => t.status === 'completed').length;

    let lines = [];
    tasks.forEach((task, i) => {
        const time = getTimeRemaining(task.deadline);
        const pIcon = priorityIcon(task.priority);
        let line = `${i + 1}️⃣ *${task.name}*\n   ${time.label} ${time.text}`;
        if (task.deadline) line += `\n   📅 ${formatDeadline(task.deadline)}`;
        if (task.detail) line += `\n   📝 _${task.detail}_`;
        line += `\n   ${pIcon} ${(task.priority || 'normal').charAt(0).toUpperCase() + (task.priority || 'normal').slice(1)}`;
        lines.push(line);
    });

    const bar = progressBar(completed, allTasks.length);
    const msg = `╔══════════════════════════╗
     📋 *DAFTAR TUGAS AKTIF*
╚══════════════════════════╝

${lines.join('\n\n')}

──────────────────
📊 Total: ${allTasks.length} | ✅ ${completed} | ⏳ ${tasks.length}
[${bar}]`;
    await sock.sendMessage(jid, { text: msg });
}

async function cmdDetail(sock, jid, args) {
    const num = parseInt(args);
    if (!num || num < 1) {
        await sock.sendMessage(jid, { text: '❌ Format: *!detail <nomor>*\nContoh: _!detail 1_' });
        return;
    }
    const tasks = await Task.find({ status: { $ne: 'completed' } }).sort({ createdAt: 1 });
    const task = tasks[num - 1];
    if (!task) {
        await sock.sendMessage(jid, { text: `❌ Tugas #${num} tidak ditemukan. Ketik *!list* untuk melihat daftar.` });
        return;
    }
    const time = getTimeRemaining(task.deadline);
    const msg = `╔══════════════════════════╗
     📄 *DETAIL TUGAS #${num}*
╚══════════════════════════╝

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
    const task = await Task.create({ name, deadline, detail, status: 'pending', priority: 'normal' });
    const time = getTimeRemaining(deadline);
    const msg = `✅ *Tugas berhasil ditambahkan!*\n──────────────────\n*Nama:* ${name}\n*Deadline:* ${formatDeadline(deadline)}\n*Sisa:* ${time.label} ${time.text}\n*Detail:* ${detail || '-'}`;
    await sock.sendMessage(jid, { text: msg });
}

async function cmdSelesai(sock, jid, args) {
    const num = parseInt(args);
    if (!num || num < 1) {
        await sock.sendMessage(jid, { text: '❌ Format: *!selesai <nomor>*\nContoh: _!selesai 1_\n\nKetik *!list* untuk melihat nomor tugas.' });
        return;
    }
    const tasks = await Task.find({ status: { $ne: 'completed' } }).sort({ createdAt: 1 });
    const task = tasks[num - 1];
    if (!task) {
        await sock.sendMessage(jid, { text: `❌ Tugas #${num} tidak ditemukan.` });
        return;
    }
    await Task.findByIdAndUpdate(task._id, { status: 'completed', completedAt: new Date() });
    const remaining = tasks.length - 1;
    await sock.sendMessage(jid, { text: `🎉 *${task.name}* telah diselesaikan!\n\n⏳ Sisa tugas aktif: ${remaining}` });
}

async function cmdHapus(sock, jid, args) {
    const num = parseInt(args);
    if (!num || num < 1) {
        await sock.sendMessage(jid, { text: '❌ Format: *!hapus <nomor>*\nContoh: _!hapus 1_' });
        return;
    }
    const tasks = await Task.find({ status: { $ne: 'completed' } }).sort({ createdAt: 1 });
    const task = tasks[num - 1];
    if (!task) {
        await sock.sendMessage(jid, { text: `❌ Tugas #${num} tidak ditemukan.` });
        return;
    }
    await Task.findByIdAndDelete(task._id);
    await sock.sendMessage(jid, { text: `🗑️ *${task.name}* telah dihapus.` });
}

async function cmdStats(sock, jid) {
    const all = await Task.find();
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

    const msg = `╔══════════════════════════╗
     📊 *STATISTIK TUGAS*
╚══════════════════════════╝

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
    const msg = `╔══════════════════════════╗
     🤖 *INFO REMINDME BOT*
╚══════════════════════════╝

📡 Status: ${globalSock ? '🟢 Online' : '🔴 Offline'}
⏱️ Uptime: ${h} jam ${m} menit
🌐 Timezone: Asia/Makassar (WITA)
📢 Grup terhubung: ${groups.length}
🔔 Cron aktif:
   • 08:00 — Pengingat pagi
   • */15 mnt — Cek tugas kritis
   • 21:00 — Preview besok

📦 Versi: 2.0.0`;
    await sock.sendMessage(jid, { text: msg });
}

// ═══════════════════════════════════════
// BROADCAST REMINDER
// ═══════════════════════════════════════

async function broadcastReminder(sock, targetJid, mode = 'all') {
    const tasks = await Task.find({ status: { $ne: 'completed' } }).sort({ createdAt: 1 });
    if (tasks.length === 0 && targetJid) {
        await sock.sendMessage(targetJid, { text: '✨ Tidak ada tugas aktif.' });
        return;
    }

    const messages = [];
    tasks.forEach((task, i) => {
        const time = getTimeRemaining(task.deadline);

        if (mode === 'critical') {
            if (time.level === 'critical' || time.level === 'missed') {
                messages.push(`${i + 1}️⃣ *${task.name}*\n   ${time.label} ${time.text}${task.deadline ? '\n   📅 ' + formatDeadline(task.deadline) : ''}`);
            }
        } else if (mode === 'evening') {
            // Tugas yang deadline-nya besok (dalam 24 jam ke depan)
            if (time.diffMs !== null && time.diffMs > 0 && time.diffMs <= 86400000) {
                messages.push(`${i + 1}️⃣ *${task.name}*\n   ${time.label} ${time.text}\n   📅 ${formatDeadline(task.deadline)}`);
            }
        } else {
            // Mode 'all': semua tugas aktif
            if (targetJid) {
                // Manual !list — tampilkan semua termasuk tanpa deadline
                messages.push(`${i + 1}️⃣ *${task.name}*\n   ${time.label} ${time.text}${task.deadline ? '\n   📅 ' + formatDeadline(task.deadline) : ''}${task.detail ? '\n   📝 _' + task.detail + '_' : ''}`);
            } else {
                // Auto broadcast — hanya yang punya deadline dan relevan
                const isH1 = time.diffMs !== null && time.diffMs > 86400000 && time.diffMs <= 172800000;
                const isHariH = time.diffMs !== null && time.diffMs > 0 && time.diffMs <= 86400000;
                const isCritical = time.level === 'critical';
                const isMissed = time.level === 'missed';
                if (isH1 || isHariH || isCritical || isMissed) {
                    messages.push(`${i + 1}️⃣ *${task.name}*\n   ${time.label} ${time.text}\n   📅 ${formatDeadline(task.deadline)}`);
                }
            }
        }
    });

    if (messages.length > 0) {
        let header;
        if (mode === 'critical') header = '⚠️ *DEADLINE MENDEKAT!*';
        else if (mode === 'evening') header = '🌙 *PREVIEW TUGAS BESOK*';
        else header = '📋 *PENGINGAT TUGAS*';

        const msgText = `╔══════════════════════════╗\n     ${header}\n╚══════════════════════════╝\n\n${messages.join('\n\n')}\n\n──────────────────`;

        if (targetJid) {
            await sock.sendMessage(targetJid, { text: msgText });
        } else {
            const allSettings = await Setting.find();
            for (const s of allSettings) {
                try {
                    await sock.sendMessage(s.reminderJid, { text: msgText });
                    console.log(`📤 [${mode}] terkirim ke ${s.reminderJid}`);
                } catch (e) {
                    console.error('❌ Gagal kirim ke', s.reminderJid, e.message);
                }
            }
        }
    } else if (mode === 'critical') {
        console.log('ℹ️ Tidak ada tugas kritis saat ini.');
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

    console.log('📡 Memantau perubahan database...');
    const changeStream = Task.watch([], { fullDocument: 'updateLookup' });
    activeChangeStream = changeStream;

    changeStream.on('change', async (change) => {
        if (!globalSock) return;
        const allSettings = await Setting.find();
        if (allSettings.length === 0) return;

        let msg = null;

        if (change.operationType === 'insert') {
            const t = change.fullDocument;
            const time = getTimeRemaining(t.deadline);
            msg = `📥 *Tugas Baru Ditambahkan*\n──────────────────\n*Nama:* ${t.name}\n*Deadline:* ${formatDeadline(t.deadline)}\n*Sisa:* ${time.label} ${time.text}\n*Detail:* ${t.detail || '-'}\n*Prioritas:* ${priorityIcon(t.priority)} ${(t.priority || 'normal')}`;
        } else if (change.operationType === 'update' && change.fullDocument) {
            const t = change.fullDocument;
            if (t.status === 'completed') {
                msg = `✅ *Tugas Diselesaikan*\n──────────────────\n*${t.name}* telah ditandai selesai! 🎉`;
            }
        } else if (change.operationType === 'delete') {
            msg = `🗑️ *Tugas Dihapus*\n──────────────────\nSatu tugas telah dihapus dari daftar.`;
        }

        if (msg) {
            for (const s of allSettings) {
                try { await globalSock.sendMessage(s.reminderJid, { text: msg }); }
                catch (e) { console.error('❌ Notif gagal:', s.reminderJid); }
            }
        }
    });

    changeStream.on('error', (err) => {
        console.error('Change Stream Error:', err.message);
        activeChangeStream = null;
        setTimeout(() => { if (globalSock) setupChangeStream(); }, 10000);
    });
}

// ═══════════════════════════════════════
// WHATSAPP BOT
// ═══════════════════════════════════════

async function startBot() {
    if (isReconnecting) return;
    isReconnecting = true;

    try {
        await connectDB();
        const { state, saveCreds } = await useMongoDBAuthState();

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' })
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) qrcode.generate(qr, { small: true });

            if (connection === 'close') {
                globalSock = null;
                const code = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = code !== DisconnectReason.loggedOut;
                console.log(`⚠️ Koneksi terputus (${code}). Reconnect: ${shouldReconnect}`);
                isReconnecting = false;
                if (shouldReconnect) {
                    console.log('🔄 Reconnect dalam 5 detik...');
                    setTimeout(() => startBot(), 5000);
                }
            } else if (connection === 'open') {
                console.log('✅ Bot WhatsApp sudah aktif!');
                globalSock = sock;
                isReconnecting = false;
                setupChangeStream();

                setTimeout(async () => {
                    try { await broadcastReminder(sock, null, 'critical'); }
                    catch (e) { console.error('❌ Cek awal gagal:', e.message); }
                }, 3000);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const jid = msg.key.remoteJid;
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

            if (!text.startsWith('!')) return;

            const [cmd, ...rest] = text.split(' ');
            const args = rest.join(' ').trim();

            try {
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
                        await Setting.findOneAndUpdate({ reminderJid: jid }, { reminderJid: jid }, { upsert: true });
                        await sock.sendMessage(jid, { text: '✅ Grup ini akan menerima pengingat otomatis.' });
                        break;
                    case '!hapusgrup':
                        await Setting.findOneAndDelete({ reminderJid: jid });
                        await sock.sendMessage(jid, { text: '🔕 Pengingat otomatis dimatikan untuk grup ini.' });
                        break;
                    default:
                        await sock.sendMessage(jid, { text: '❓ Perintah tidak dikenali. Ketik *!menu* untuk bantuan.' });
                }
            } catch (err) {
                console.error('❌ Command error:', err);
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

// Cek tugas kritis setiap 15 menit
cron.schedule('*/15 * * * *', async () => {
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
