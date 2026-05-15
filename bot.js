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
async function broadcastReminder(sock, targetJid) {
    const tasks = await Task.find({ status: { $ne: 'completed' } }).sort({ createdAt: 1 });
    if (tasks.length === 0 && targetJid) {
        await sock.sendMessage(targetJid, { text: '✨ Tidak ada tugas aktif.' });
        return;
    }

    const now = new Date();
    const messages = [];

    tasks.forEach(task => {
        const timeInfo = getTimeRemaining(task.deadline);
        if (timeInfo.diffMs === null) return;

        const diffMs = timeInfo.diffMs;
        const isH1 = diffMs > (24 * 60 * 60 * 1000) && diffMs <= (48 * 60 * 60 * 1000);
        const isHariH = diffMs > 0 && diffMs <= (24 * 60 * 60 * 1000);
        const isCritical = diffMs > 0 && diffMs <= (3 * 60 * 60 * 1000);
        const isMissed = diffMs < 0;

        if (targetJid || isH1 || isHariH || isCritical || isMissed) {
            let label = isMissed ? 'TERLEWAT' : (isCritical ? 'DARURAT' : 'PENGINGAT');
            messages.push(`*${task.name}*\n[${label}] ${timeInfo.text}\n_${task.detail || ''}_`);
        }
    });

    if (messages.length > 0) {
        const msgText = `*[SISTEM PENGINGAT TUGAS]*\n─────────────────────\n\n` + messages.join('\n\n') + `\n\n─────────────────────`;
        if (targetJid) {
            await sock.sendMessage(targetJid, { text: msgText });
        } else {
            const allSettings = await Setting.find();
            for (const s of allSettings) {
                await sock.sendMessage(s.reminderJid, { text: msgText });
            }
        }
    }
}

// --- WhatsApp Bot Logic ---
async function startBot() {
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
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot WhatsApp sudah aktif!');
            globalSock = sock;
            setupChangeStream(); // Mulai memantau database
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
            await broadcastReminder(sock, jid);
        } else if (text === '!setgrup') {
            await Setting.findOneAndUpdate({ reminderJid: jid }, { reminderJid: jid }, { upsert: true });
            await sock.sendMessage(jid, { text: '✅ Grup ini akan menerima pengingat otomatis.' });
        }
    });
}

// --- Monitor Database (Change Stream) ---
function setupChangeStream() {
    console.log('📡 Memantau perubahan database untuk notifikasi real-time...');
    const changeStream = Task.watch();
    
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
        console.error('Change Stream Error:', err);
        setTimeout(setupChangeStream, 5000); // Restart jika error
    });
}

// --- Cron Jobs ---
cron.schedule('0 8 * * *', async () => {
    if (globalSock) await broadcastReminder(globalSock);
}, { timezone: "Asia/Makassar" });

cron.schedule('0 * * * *', async () => {
    if (globalSock) await broadcastReminder(globalSock); // Cek setiap jam untuk yang kritis
}, { timezone: "Asia/Makassar" });

startBot();
