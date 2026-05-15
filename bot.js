process.env.TZ = 'Asia/Makassar';
require('dotenv').config();
const {
    default: makeWASocket,
    DisconnectReason
} = require('baileys-joss');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const { connectDB, Task, Setting } = require('./database');
const { useMongoDBAuthState } = require('./mongoAuthState');

let globalSock = null;
let activeChangeStream = null; // Mencegah change stream duplikat
let isReconnecting = false;    // Mencegah reconnect bersamaan

// --- Helper: Hitung Mundur ---
function getTimeRemaining(dateStr) {
    if (!dateStr) return { text: 'Belum ditentukan', diffMs: null };
    const now = new Date();
    const deadline = new Date(dateStr);
    if (isNaN(deadline.getTime())) return { text: 'Belum ditentukan', diffMs: null };
    
    const diffMs = deadline - now;
    if (diffMs < 0) {
        const overHours = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60));
        return { text: `Terlewat ${overHours} jam`, diffMs };
    }

    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor(diffMs / (1000 * 60 * 60)) % 24;
    const mins = Math.floor(diffMs / (1000 * 60)) % 60;

    if (days > 0) return { text: `${days} hari ${hours} jam`, diffMs };
    if (hours > 0) return { text: `${hours} jam ${mins} mnt`, diffMs };
    return { text: `${mins} menit lagi!`, diffMs };
}

// --- Logika Broadcast Pengingat ---
// mode: 'all' = semua pengingat (untuk cron pagi & !list)
//       'critical' = hanya deadline <= 3 jam & terlewat (untuk cron setiap jam)
async function broadcastReminder(sock, targetJid, mode = 'all') {
    const tasks = await Task.find({ status: { $ne: 'completed' } }).sort({ createdAt: 1 });
    if (tasks.length === 0 && targetJid) {
        await sock.sendMessage(targetJid, { text: '✨ Tidak ada tugas aktif.' });
        return;
    }

    const messages = [];

    tasks.forEach(task => {
        const timeInfo = getTimeRemaining(task.deadline);
        if (timeInfo.diffMs === null) return;

        const diffMs = timeInfo.diffMs;
        const isH1 = diffMs > (24 * 60 * 60 * 1000) && diffMs <= (48 * 60 * 60 * 1000);
        const isHariH = diffMs > 0 && diffMs <= (24 * 60 * 60 * 1000);
        const isCritical = diffMs > 0 && diffMs <= (3 * 60 * 60 * 1000);
        const isMissed = diffMs < 0;

        // Jika mode 'critical', hanya kirim yang <= 3 jam atau terlewat
        if (mode === 'critical') {
            if (isCritical || isMissed) {
                let label = isMissed ? '🔴 TERLEWAT' : '🚨 DARURAT';
                messages.push(`*${task.name}*\n[${label}] ${timeInfo.text}\n_${task.detail || ''}_`);
            }
        } else {
            // Mode 'all': kirim semua yang relevan (untuk !list dan cron pagi)
            if (targetJid || isH1 || isHariH || isCritical || isMissed) {
                let label = isMissed ? '🔴 TERLEWAT' : (isCritical ? '🚨 DARURAT' : 'PENGINGAT');
                messages.push(`*${task.name}*\n[${label}] ${timeInfo.text}\n_${task.detail || ''}_`);
            }
        }
    });

    if (messages.length > 0) {
        const header = mode === 'critical'
            ? `*[⚠️ PERINGATAN DEADLINE MENDEKAT]*`
            : `*[SISTEM PENGINGAT TUGAS]*`;
        const msgText = `${header}\n─────────────────────\n\n` + messages.join('\n\n') + `\n\n─────────────────────`;
        
        if (targetJid) {
            await sock.sendMessage(targetJid, { text: msgText });
        } else {
            const allSettings = await Setting.find();
            for (const s of allSettings) {
                try {
                    await sock.sendMessage(s.reminderJid, { text: msgText });
                    console.log(`📤 Notifikasi ${mode} terkirim ke ${s.reminderJid}`);
                } catch (e) {
                    console.error('❌ Gagal kirim notifikasi ke', s.reminderJid, e.message);
                }
            }
        }
    } else if (mode === 'critical') {
        console.log('ℹ️ Tidak ada tugas kritis saat ini.');
    }
}

// --- Monitor Database (Change Stream) ---
function setupChangeStream() {
    // Tutup change stream lama sebelum buat yang baru
    if (activeChangeStream) {
        console.log('🔄 Menutup Change Stream lama...');
        activeChangeStream.close().catch(() => {});
        activeChangeStream = null;
    }

    console.log('📡 Memantau perubahan database untuk notifikasi real-time...');
    const changeStream = Task.watch();
    activeChangeStream = changeStream;
    
    changeStream.on('change', async (change) => {
        if (change.operationType === 'insert' && globalSock) {
            const newTask = change.fullDocument;
            const msg = `*[TUGAS BARU DITAMBAHKAN]*\n─────────────────────\n*Nama:* ${newTask.name}\n*Deadline:* ${newTask.deadline || '-'}\n*Detail:* ${newTask.detail || '-'}\n─────────────────────`;
            
            const allSettings = await Setting.find();
            for (const s of allSettings) {
                try {
                    await globalSock.sendMessage(s.reminderJid, { text: msg });
                } catch (e) { console.error('Gagal kirim notifikasi ke', s.reminderJid); }
            }
        }
    });

    changeStream.on('error', (err) => {
        console.error('Change Stream Error:', err.message);
        activeChangeStream = null;
        // Restart change stream setelah delay
        setTimeout(() => {
            if (globalSock) setupChangeStream();
        }, 10000);
    });
}

// --- WhatsApp Bot Logic ---
async function startBot() {
    // Cegah reconnect bersamaan
    if (isReconnecting) {
        console.log('⏳ Sudah dalam proses reconnect, menunggu...');
        return;
    }
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
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`⚠️ Koneksi terputus (status: ${statusCode}). Reconnect: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    // Delay sebelum reconnect untuk menghindari loop cepat
                    isReconnecting = false;
                    const delay = 5000; // 5 detik
                    console.log(`🔄 Reconnect dalam ${delay / 1000} detik...`);
                    setTimeout(() => startBot(), delay);
                } else {
                    console.log('🚫 Bot di-logout. Hapus session dan scan QR ulang.');
                    isReconnecting = false;
                }
            } else if (connection === 'open') {
                console.log('✅ Bot WhatsApp sudah aktif!');
                globalSock = sock;
                isReconnecting = false;
                setupChangeStream();

                // Langsung cek tugas kritis saat pertama kali terhubung
                setTimeout(async () => {
                    console.log('🔍 Cek awal tugas kritis setelah connect...');
                    try {
                        await broadcastReminder(sock, null, 'critical');
                    } catch (e) {
                        console.error('❌ Gagal cek awal:', e.message);
                    }
                }, 3000);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const jid = msg.key.remoteJid;
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

            if (text === '!menu' || text === '!help') {
                await sock.sendMessage(jid, { text: '*PERINTAH BOT*\n!list - Daftar tugas\n!setgrup - Aktifkan pengingat di sini\n!hapusgrup - Matikan pengingat' });
            } else if (text === '!list') {
                await broadcastReminder(sock, jid, 'all');
            } else if (text === '!setgrup') {
                await Setting.findOneAndUpdate({ reminderJid: jid }, { reminderJid: jid }, { upsert: true });
                await sock.sendMessage(jid, { text: '✅ Grup ini akan menerima pengingat otomatis.' });
            }
        });
    } catch (err) {
        console.error('❌ Gagal memulai bot:', err.message);
        isReconnecting = false;
        // Coba lagi setelah 10 detik
        setTimeout(() => startBot(), 10000);
    }
}

// --- Cron Jobs ---

// Pengingat pagi: kirim SEMUA tugas aktif yang punya deadline (jam 8 pagi)
cron.schedule('0 8 * * *', async () => {
    console.log('⏰ Cron pagi: mengirim semua pengingat...');
    if (globalSock) {
        await broadcastReminder(globalSock, null, 'all');
    } else {
        console.log('⚠️ Cron pagi: Bot belum terhubung, skip.');
    }
}, { timezone: "Asia/Makassar" });

// Pengingat setiap 15 MENIT: cek tugas kritis (deadline <= 3 jam atau terlewat)
cron.schedule('*/15 * * * *', async () => {
    const now = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Makassar' });
    console.log(`⏰ [${now}] Cron 15-menit: mengecek tugas kritis (≤3 jam)...`);
    if (globalSock) {
        await broadcastReminder(globalSock, null, 'critical');
    } else {
        console.log('⚠️ Cron 15-menit: Bot belum terhubung, skip.');
    }
}, { timezone: "Asia/Makassar" });

startBot();
