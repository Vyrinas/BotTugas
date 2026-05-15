process.env.TZ = 'Asia/Makassar';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const {
    default: makeWASocket,
    DisconnectReason,
    generateInteractiveListMessage,
    generateQuickReplyButtons
} = require('baileys-joss');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const { connectDB, Task, Setting } = require('./database');
const { useMongoDBAuthState } = require('./mongoAuthState');

const PORT = process.env.PORT || 3000;

// --- Pengaturan Bot (Multi-Group) ---
async function saveSettings(reminderJid) {
    // Simpan JID jika belum ada
    await Setting.findOneAndUpdate(
        { reminderJid },
        { reminderJid },
        { upsert: true }
    );
}

// --- Express Web Server Setup ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Endpoint khusus untuk mereset memori login WA
app.get('/reset-login', async (req, res) => {
    try {
        const mongoose = require('mongoose');
        await mongoose.connection.collection('authsessions').drop();
        res.send('<h1>✅ Berhasil Mereset Memori Login!</h1><p>Memori lama sudah dihapus bersih. Silakan <b>Restart</b> mesin Hugging Face Anda sekarang, lalu buka menu Logs. QR Code baru akan segera muncul!</p>');
    } catch (err) {
        res.send('<h1>⚠️ Info</h1><p>Memori sudah dalam keadaan kosong atau terjadi kesalahan: ' + err.message + '</p><p>Silakan Restart mesin Hugging Face Anda.</p>');
    }
});

// Endpoint khusus untuk UptimeRobot mengecek apakah server masih hidup
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/api/tasks', async (req, res) => {
    try {
        const tasks = await Task.find().sort({ createdAt: 1 });
        res.json(tasks);
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil data' });
    }
});

app.post('/api/tasks', async (req, res) => {
    const { name, date, detail } = req.body;
    if (!name) return res.status(400).json({ error: 'Nama tugas wajib diisi' });

    try {
        await Task.create({ name, deadline: date || '', detail: detail || '', status: 'pending' });
        
        // Notifikasi ke WhatsApp jika globalSock sudah siap dan terhubung
        if (globalSock && globalSock.user) {
            const allSettings = await Setting.find();
            let msgText = `*[INFO] TUGAS BARU DITAMBAHKAN*\n─────────────────────\n*Judul:* ${name}`;
            if (date) msgText += `\n*Batas Waktu:* ${date}`;
            if (detail) msgText += `\n*Detail:* _${detail}_`;
            msgText += `\n─────────────────────\n_Ditambahkan melalui Web Dashboard_`;

            for (const setting of allSettings) {
                if (setting.reminderJid) {
                    try {
                        await globalSock.sendMessage(setting.reminderJid, { text: msgText });
                    } catch (e) {
                        console.error('Gagal kirim notifikasi web ke', setting.reminderJid);
                    }
                }
            }
        }

        res.status(201).json({ message: 'Tugas ditambahkan' });
    } catch (error) {
        res.status(500).json({ error: 'Gagal menambah tugas' });
    }
});

app.put('/api/tasks/:id', async (req, res) => {
    const { name, date, detail } = req.body;
    try {
        const tasks = await Task.find().sort({ createdAt: 1 });
        const id = parseInt(req.params.id);
        if (tasks[id]) {
            const dbId = tasks[id]._id;
            await Task.findByIdAndUpdate(dbId, { name, deadline: date || '', detail: detail !== undefined ? detail : tasks[id].detail });
            res.json({ message: 'Tugas diedit' });
        } else {
            res.status(404).json({ error: 'Tidak ditemukan' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Gagal edit tugas' });
    }
});

app.patch('/api/tasks/:id', async (req, res) => {
    const { status } = req.body;
    try {
        const tasks = await Task.find().sort({ createdAt: 1 });
        const id = parseInt(req.params.id);
        if (tasks[id]) {
            await Task.findByIdAndUpdate(tasks[id]._id, { status });
            res.json({ message: 'Status diupdate' });
        } else {
            res.status(404).json({ error: 'Tidak ditemukan' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Gagal update status' });
    }
});

app.delete('/api/tasks/:id', async (req, res) => {
    try {
        const tasks = await Task.find().sort({ createdAt: 1 });
        const id = parseInt(req.params.id);
        if (tasks[id]) {
            await Task.findByIdAndDelete(tasks[id]._id);
            res.json({ message: 'Dihapus' });
        } else {
            res.status(404).json({ error: 'Tidak ditemukan' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Gagal menghapus tugas' });
    }
});

// --- Fungsi Helper ---
function getTimeRemaining(dateStr) {
    if (!dateStr) return { class: 'warning', text: 'Belum ditentukan', raw: null, diffMs: null };
    const now = new Date();
    const deadline = new Date(dateStr);
    if (isNaN(deadline.getTime())) return { class: 'warning', text: 'Belum ditentukan', raw: null, diffMs: null };
    
    const diffMs = deadline - now;
    
    if (diffMs < 0) {
        const overDays = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60 * 24));
        const overHours = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60)) % 24;
        let txt = overDays > 0 ? `Terlewat ${overDays} hari` : `Terlewat ${overHours} jam`;
        return { class: 'urgent', text: txt, raw: diffMs, diffMs };
    }

    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor(diffMs / (1000 * 60 * 60)) % 24;
    const mins = Math.floor(diffMs / (1000 * 60)) % 60;

    if (days > 2) return { class: 'safe', text: `${days} hari lagi`, raw: diffMs, diffMs };
    if (days > 0) return { class: 'warning', text: `${days} hari ${hours} jam`, raw: diffMs, diffMs };
    if (hours > 0) return { class: 'urgent', text: `${hours} jam ${mins} mnt lagi`, raw: diffMs, diffMs };
    return { class: 'urgent', text: `${mins} menit lagi!`, raw: diffMs, diffMs };
}

// --- WhatsApp Bot Setup ---
async function startBot() {
    const { state, saveCreds } = await useMongoDBAuthState();

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }) // Menyembunyikan log bising
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (connection === 'connecting') {
            console.log('⏳ Sedang menghubungkan ke WhatsApp...');
        }

        if (qr) {
            console.log('\n======================================================');
            console.log('QR CODE TERMINAL HANCUR? BUKA LINK INI DI BROWSER ANDA:');
            console.log('https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(qr));
            console.log('======================================================\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            globalSock = null; // Reset saat diskonek
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log(`⚠️ Koneksi terputus (${lastDisconnect?.error?.message || 'Unknown'}). Mencoba lagi dalam 5 detik...`);
                setTimeout(() => {
                    startBot();
                }, 5000);
            } else {
                console.log('❌ Sesi logout. Buka MongoDB, bersihkan AuthSession dan scan ulang.');
            }
        } else if (connection === 'open') {
            console.log('✅ Bot WhatsApp V2.0 (MongoDB) sudah siap!');
            globalSock = sock; // Set saat sudah sukses konek

            // Langsung cek tugas saat pertama kali nyala agar tidak ada yang terlewat
            console.log('🔄 Menjalankan pengecekan tugas awal...');
            Setting.find().then(allSettings => {
                allSettings.forEach(setting => {
                    if (setting.reminderJid) broadcastReminder(sock, setting.reminderJid);
                });
            });
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return; // Hapus filter fromMe agar bisa testing sendiri
        
        let commandText = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            '';

        console.log(`📩 Pesan masuk dari ${msg.key.remoteJid}: "${commandText}" (fromMe: ${msg.key.fromMe})`);

        let buttonId = msg.message.buttonsResponseMessage?.selectedButtonId ||
            msg.message.templateButtonReplyMessage?.selectedId ||
            msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.name ||
            '';

        // Jika dari interactive list
        if (msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
            try {
                const params = JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
                if (params.id) buttonId = params.id;
            } catch (e) { }
        }

        const jid = msg.key.remoteJid;

        // Pemetaan tombol ke perintah text
        let cmd = commandText.trim();
        if (buttonId === 'btn-daftar') cmd = '!list';
        if (buttonId === 'btn-selesai') cmd = '!riwayat';

        const replyOpts = { quoted: msg }; // Meng-quote pesan user

        // 1. Tambah Tugas
        if (cmd.startsWith('!tambah')) {
            const parts = cmd.substring(8).split('|').map(s => s.trim());
            if (parts.length < 1 || parts[0] === '') {
                await sock.sendMessage(jid, { text: '[ERROR] Format salah!\nGunakan: !tambah Nama Tugas | YYYY-MM-DD (Opsional) | Detail (Opsional)\nContoh: !tambah Makalah | 2026-05-20 | Bab 1-3' }, replyOpts);
                return;
            }

            const name = parts[0];
            let deadline = parts[1] || '';
            const detail = parts[2] || '';

            if (deadline !== '' && isNaN(new Date(deadline).getTime())) {
                deadline = '';
            }

            await Task.create({ name, deadline, detail, status: 'pending' });
            await sock.sendMessage(jid, { text: `[SUCCESS] Tugas '${name}' berhasil ditambahkan.` }, replyOpts);
        }
        // 2. Daftar Tugas Pending
        else if (cmd === '!list') {
            const tasks = await Task.find().sort({ createdAt: 1 });
            const pendingTasks = tasks.filter(t => t.status !== 'completed');

            if (pendingTasks.length === 0) {
                await sock.sendMessage(jid, { text: '[INFO] Tidak ada tugas yang belum selesai saat ini.' }, replyOpts);
                return;
            }

            let reply = '*DAFTAR TUGAS AKTIF*\n─────────────────────\n\n';
    const messages = [];

    pendingTasks.forEach(task => {
                const index = tasks.findIndex(t => t.id === task.id);
                const timeInfo = getTimeRemaining(task.deadline);
                let statusText = `(${timeInfo.text})`;
                
                let deadlineText = task.deadline || '-';
                if (task.deadline && task.deadline.includes('T')) {
                    deadlineText = task.deadline.replace('T', ' ');
                }
                const detailText = task.detail ? `\nDetail: _${task.detail}_` : '';
                
                reply += `*${index + 1}. ${task.name}*\nBatas Waktu: ${deadlineText} ${statusText}${detailText}\n─────────────────────\n`;
            });

            reply += '_Gunakan !selesai [nomor] untuk menandai selesai_\n_Gunakan !edit [nomor] | [Nama] | [Tanggal] untuk merevisi_';
            await sock.sendMessage(jid, { text: reply }, replyOpts);
        }
        // 3. Daftar Tugas Selesai
        else if (cmd === '!riwayat') {
            const tasks = await Task.find().sort({ createdAt: 1 });
            const compTasks = tasks.filter(t => t.status === 'completed');

            if (compTasks.length === 0) {
                await sock.sendMessage(jid, { text: '[INFO] Belum ada tugas yang diselesaikan.' }, replyOpts);
                return;
            }

            let reply = '*RIWAYAT TUGAS SELESAI*\n─────────────────────\n\n';
            compTasks.forEach(task => {
                const index = tasks.findIndex(t => t.id === task.id);
                reply += `~${index + 1}. ${task.name}~\n`;
            });

            reply += '\n─────────────────────';
            await sock.sendMessage(jid, { text: reply }, replyOpts);
        }
        // 4. Tandai Selesai
        else if (cmd.startsWith('!selesai')) {
            const numStr = cmd.split(' ')[1];
            const num = parseInt(numStr, 10);

            const tasks = await Task.find().sort({ createdAt: 1 });
            if (isNaN(num) || num < 1 || num > tasks.length) {
                await sock.sendMessage(jid, { text: '[ERROR] Nomor tugas tidak ditemukan.' }, replyOpts);
                return;
            }

            const targetTask = tasks[num - 1];
            if (targetTask.status === 'completed') {
                await sock.sendMessage(jid, { text: '[INFO] Tugas ini sudah ditandai selesai.' }, replyOpts);
                return;
            }

            await Task.findByIdAndUpdate(targetTask._id, { status: 'completed' });
            await sock.sendMessage(jid, { text: `[SUCCESS] Tugas '${targetTask.name}' telah ditandai selesai.` }, replyOpts);
        }
        // 5. Edit Tugas
        else if (cmd.startsWith('!edit')) {
            const parts = cmd.substring(6).split('|').map(s => s.trim());
            if (parts.length < 2) {
                await sock.sendMessage(jid, { text: '[ERROR] Format salah!\nGunakan: !edit [nomor] | [Nama Baru] | [Tanggal Baru YYYY-MM-DD] | [Detail]' }, replyOpts);
                return;
            }

            const numStr = parts[0];
            const name = parts[1];
            let deadline = parts[2] || '';
            const detail = parts[3] || '';
            const num = parseInt(numStr, 10);

            const tasks = await Task.find().sort({ createdAt: 1 });
            if (isNaN(num) || num < 1 || num > tasks.length) {
                await sock.sendMessage(jid, { text: '[ERROR] Nomor tugas tidak valid.' }, replyOpts);
                return;
            }
            if (deadline !== '' && isNaN(new Date(deadline).getTime())) {
                deadline = '';
            }

            const updateData = { name, deadline };
            if (detail) updateData.detail = detail;

            await Task.findByIdAndUpdate(tasks[num - 1]._id, updateData);
            await sock.sendMessage(jid, { text: `[SUCCESS] Tugas nomor ${num} berhasil diperbarui.` }, replyOpts);
        }
        // 6. Hapus Tugas Permanen
        else if (cmd.startsWith('!hapus ')) {
            const numStr = cmd.split(' ')[1];
            const num = parseInt(numStr, 10);

            const tasks = await Task.find().sort({ createdAt: 1 });
            if (isNaN(num) || num < 1 || num > tasks.length) {
                await sock.sendMessage(jid, { text: '[ERROR] Nomor tugas tidak ditemukan.' }, replyOpts);
                return;
            }

            const targetTask = tasks[num - 1];
            await Task.findByIdAndDelete(targetTask._id);
            await sock.sendMessage(jid, { text: `[SUCCESS] Tugas '${targetTask.name}' telah dihapus permanen.` }, replyOpts);
        }
        // 7. Menu Utama (Tombol Interaktif Modern)
        else if (cmd === '!menu') {
            const menuMessage = generateQuickReplyButtons(
                '*MENU UTAMA PENGINGAT*\n\nSistem manajemen tugas otomatis. Silakan pilih opsi di bawah ini.',
                [
                    { id: 'btn-daftar', displayText: 'Tugas Aktif' },
                    { id: 'btn-selesai', displayText: 'Riwayat Selesai' }
                ],
                { footer: 'Gunakan !help untuk daftar perintah lengkap.' }
            );

            await sock.relayMessage(jid, { viewOnceMessage: { message: menuMessage } }, {});
        }
        // 8. Set Chat ini sebagai Target Pengingat Otomatis
        else if (cmd === '!setgrup') {
            await saveSettings(jid);
            await sock.sendMessage(jid, { text: '[SUCCESS] Grup/Chat ini diset sebagai penerima notifikasi pengingat otomatis.' }, replyOpts);
        }
        // 9. Hapus Grup ini dari Daftar Pengingat
        else if (cmd === '!hapusgrup') {
            await Setting.findOneAndDelete({ reminderJid: jid });
            await sock.sendMessage(jid, { text: '[SUCCESS] Grup/Chat ini dihapus dari daftar pengingat otomatis.' }, replyOpts);
        }
        // 10. Manual Trigger Pengingat (Untuk Testing)
        else if (cmd === '!ingatkan') {
            await broadcastReminder(sock, jid);
        }
        // 11. Bantuan (Daftar Semua Perintah)
        else if (cmd === '!help') {
            const helpText = `*DAFTAR PERINTAH SISTEM*
─────────────────────
*MANAJEMEN TUGAS*
• *!tambah* [Nama] | [Tgl] | [Detail]
• *!list* (Melihat tugas aktif)
• *!riwayat* (Melihat tugas selesai)
• *!selesai* [Nomor]
• *!edit* [Nomor] | [Nama] | [Tgl]
• *!hapus* [Nomor]

─────────────────────
*PENGATURAN SISTEM*
• *!setgrup* (Aktivasi notifikasi grup)
• *!hapusgrup* (Matikan notifikasi)
• *!ingatkan* (Cek paksa tugas mepet)
• *!menu* (Buka menu interaktif)

─────────────────────
_Info: Rekap tugas otomatis jam 08:00 & Peringatan darurat 3 jam sebelum._`;
            
            await sock.sendMessage(jid, { text: helpText }, replyOpts);
        }
    });

    return sock;
}

// Fungsi Broadcast Pengingat
async function broadcastReminder(sock, targetJid) {
    const tasks = await Task.find().sort({ createdAt: 1 });
    const pendingTasks = tasks.filter(t => t.status !== 'completed');
    
    if (pendingTasks.length === 0) {
        if (targetJid) await sock.sendMessage(targetJid, { text: '✨ Tidak ada tugas mendesak hari ini!' });
        return;
    }

    const now = new Date();
    const currentHour = now.getHours();
    const isMorningCheck = currentHour === 8; // Jam 8 pagi untuk rekap rutin

    let headerText = '*[REMINDER] TUGAS MENDESAK*';

    if (isMorningCheck && !targetJid) {
        headerText = '*[INFO] REKAP TUGAS HARI INI & BESOK*';
    }

    const messages = [];

    pendingTasks.forEach(task => {
        const timeInfo = getTimeRemaining(task.deadline);
        if (timeInfo.raw === null) return;

        const diffMs = timeInfo.diffMs;
        const detailInfo = task.detail ? `\n   _Detail: ${task.detail}_` : '';
        
        // Cek Kondisi Peringatan
        const isH1 = diffMs > (24 * 60 * 60 * 1000) && diffMs <= (48 * 60 * 60 * 1000);
        const isHariH = diffMs > 0 && diffMs <= (24 * 60 * 60 * 1000);
        const isCritical = diffMs > (1 * 60 * 60 * 1000) && diffMs <= (3 * 60 * 60 * 1000); // Sisa 1-3 jam
        const isMissed = diffMs < 0;

        let shouldSend = false;
        let label = '';

        if (targetJid) {
            if (isH1 || isHariH || isCritical || isMissed) {
                shouldSend = true;
                label = isMissed ? 'TERLEWAT' : 'INFO';
            }
        } else {
            if (isMorningCheck && (isH1 || isHariH || isMissed)) {
                shouldSend = true;
                label = isH1 ? 'BESOK' : (isHariH ? 'HARI INI' : 'TERLEWAT');
            } else if (isCritical) {
                shouldSend = true;
                label = 'FINAL CALL (3 JAM)';
            }
        }

        if (shouldSend) {
            messages.push(`*${task.name}*\n[${label}] ${timeInfo.text}${detailInfo}`);
        }
    });

    if (messages.length > 0) {
        let msgText = headerText + '\n─────────────────────\n\n' + messages.join('\n\n─────────────────────\n\n') + '\n\n─────────────────────';

        const buttons = generateQuickReplyButtons(
            msgText,
            [
                { id: 'btn-daftar', displayText: 'Tugas Aktif' }
            ],
            { footer: 'Sistem Pengingat Otomatis' }
        );

        try {
            const destination = targetJid;
            if (destination) {
                await sock.relayMessage(destination, { viewOnceMessage: { message: buttons } }, {});
            } else {
                console.log('Tidak ada target JID untuk pengingat.');
            }
        } catch (e) {
            console.log('Gagal mengirim pengingat:', e);
        }
    } else if (targetJid) {
        await sock.sendMessage(targetJid, { text: '✨ Semua tugas masih aman (belum H-1 atau Hari H).' });
    }
}

let cronTask = null;
let globalSock = null;

async function run() {
    await connectDB();
    
    app.listen(PORT, () => {
        console.log(`🌐 Web Dashboard berjalan di http://localhost:${PORT}`);
    });

    const sock = await startBot();

    if (!cronTask) {
        cronTask = cron.schedule('0 * * * *', async () => {
            if (!globalSock) return;
            const allSettings = await Setting.find();
            for (const setting of allSettings) {
                if (setting.reminderJid) {
                    await broadcastReminder(globalSock, setting.reminderJid);
                }
            }
        }, {
            scheduled: true,
            timezone: "Asia/Makassar"
        });
    }
}

run();
