require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { connectDB, Task, Setting, CustomCommand, BotStatus, BotLog, BotAction } = require('./database');

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

// --- HELPER UNTUK LOG WEB ---
async function logWebEvent(message) {
    try {
        await BotLog.create({ level: 'web', message });
    } catch (e) {
        console.error('⚠️ Gagal menyimpan log web:', e.message);
    }
}

// --- ADMIN TELEMETRY & CONTROLS ---

app.get('/api/admin/bot-status', verifyXs, async (req, res) => {
    try {
        const statusDoc = await BotStatus.findOne();
        if (!statusDoc) {
            return res.json({ status: 'disconnected', uptime: 0, qr: '', phone: '', name: '', online: false });
        }
        
        // Cek apakah detak jantung (heartbeat) aktif dalam 60 detik terakhir
        const now = new Date();
        const diffSeconds = Math.abs(now - new Date(statusDoc.lastActive)) / 1000;
        const isOnline = diffSeconds <= 60;
        
        res.json({
            status: isOnline ? statusDoc.status : 'disconnected',
            uptime: statusDoc.uptime || 0,
            qr: statusDoc.qr || '',
            phone: statusDoc.phone || '',
            name: statusDoc.name || '',
            online: isOnline
        });
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil status bot' });
    }
});

app.get('/api/admin/logs', verifyXs, async (req, res) => {
    try {
        const logs = await BotLog.find().sort({ timestamp: -1 }).limit(50);
        // Balikkan urutan agar log paling lama di atas dan paling baru di bawah (gaya terminal)
        res.json(logs.reverse());
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil logs' });
    }
});

app.post('/api/admin/action', verifyXs, async (req, res) => {
    const { action, params } = req.body;
    if (!action) return res.status(400).json({ error: 'Aksi wajib diisi' });
    
    try {
        const botAction = await BotAction.create({ action, params, status: 'pending' });
        await logWebEvent(`Mengirim perintah kendali '${action}' ke WhatsApp bot via Web Dashboard`);
        res.status(201).json({ message: 'Aksi dikirim', botAction });
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengirim aksi' });
    }
});

// --- ADMIN CUSTOM COMMANDS MANAGEMENT ---

app.get('/api/admin/custom-commands', verifyXs, async (req, res) => {
    try {
        const cmds = await CustomCommand.find().sort({ command: 1 });
        res.json(cmds);
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil custom commands' });
    }
});

app.post('/api/admin/custom-commands', verifyXs, async (req, res) => {
    const { jid, command, response } = req.body;
    if (!jid || !command || !response) {
        return res.status(400).json({ error: 'JID, perintah, dan balasan wajib diisi' });
    }
    
    const cleanCmd = command.trim().toLowerCase();
    if (!cleanCmd.startsWith('!')) {
        return res.status(400).json({ error: 'Perintah harus diawali dengan tanda seru (!)' });
    }
    
    try {
        const exists = await CustomCommand.findOne({ jid, command: cleanCmd });
        if (exists) {
            return res.status(400).json({ error: `Perintah '${cleanCmd}' sudah ada untuk target ini.` });
        }
        
        const cc = await CustomCommand.create({ jid, command: cleanCmd, response });
        await logWebEvent(`Menambahkan Custom Command '${cleanCmd}' untuk target '${jid}' via Web`);
        res.status(201).json({ message: 'Custom command berhasil ditambahkan', customCommand: cc });
    } catch (error) {
        res.status(500).json({ error: 'Gagal menambah custom command' });
    }
});

app.put('/api/admin/custom-commands/:id', verifyXs, async (req, res) => {
    const { jid, command, response } = req.body;
    try {
        const cleanCmd = command ? command.trim().toLowerCase() : undefined;
        if (cleanCmd && !cleanCmd.startsWith('!')) {
            return res.status(400).json({ error: 'Perintah harus diawali dengan tanda seru (!)' });
        }
        
        const updated = await CustomCommand.findByIdAndUpdate(
            req.params.id,
            { jid, command: cleanCmd, response },
            { new: true }
        );
        await logWebEvent(`Mengedit Custom Command '${cleanCmd || req.params.id}' via Web`);
        res.json({ message: 'Custom command berhasil diedit', customCommand: updated });
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengupdate custom command' });
    }
});

app.delete('/api/admin/custom-commands/:id', verifyXs, async (req, res) => {
    try {
        const deleted = await CustomCommand.findByIdAndDelete(req.params.id);
        if (deleted) {
            await logWebEvent(`Menghapus Custom Command '${deleted.command}' via Web`);
            res.json({ message: 'Custom command berhasil dihapus' });
        } else {
            res.status(404).json({ error: 'Custom command tidak ditemukan' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Gagal menghapus custom command' });
    }
});

if (process.env.NODE_ENV !== 'production' || require.main === module) {
    app.listen(PORT, () => {
        console.log(`🌐 Web Dashboard aktif di port ${PORT}`);
    });
}

module.exports = app;
