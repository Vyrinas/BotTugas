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

app.post('/api/login', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    const now = Date.now();

    // Rate limit check
    const attempts = loginAttempts.get(ip);
    if (attempts && now < attempts.resetAt && attempts.count >= MAX_ATTEMPTS) {
        const waitSec = Math.ceil((attempts.resetAt - now) / 1000);
        return res.status(429).json({ error: `Terlalu banyak percobaan. Coba lagi dalam ${waitSec} detik.` });
    }

    const password = req.body.password || '';
    if (safeCompare(password, ADMIN_PASSWORD)) {
        // Reset rate limiter on success
        loginAttempts.delete(ip);

        // Generate random session token
        const token = crypto.randomBytes(32).toString('hex');
        activeSessions.set(token, { createdAt: now, ip });
        res.json({ token });
    } else {
        // Increment rate limiter
        if (!attempts || now > attempts.resetAt) {
            loginAttempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
        } else {
            attempts.count++;
        }
        const remaining = MAX_ATTEMPTS - (loginAttempts.get(ip)?.count || 0);
        res.status(401).json({ error: `Password salah. Sisa percobaan: ${remaining}` });
    }
});

const requireAdmin = (req, res, next) => {
    const token = req.headers['x-admin-token'];
    if (!token) return res.status(401).json({ error: 'Akses ditolak.' });

    const session = activeSessions.get(token);
    if (!session) return res.status(401).json({ error: 'Token tidak valid atau sudah kedaluwarsa.' });

    // Check expiry
    if (Date.now() - session.createdAt > TOKEN_EXPIRY_MS) {
        activeSessions.delete(token);
        return res.status(401).json({ error: 'Sesi sudah kedaluwarsa. Silakan login ulang.' });
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
    const { name, date, detail, priority, silent } = req.body;
    if (!name) return res.status(400).json({ error: 'Nama tugas wajib diisi' });

    try {
        const task = await Task.create({
            name,
            deadline: date || '',
            detail: detail || '',
            status: 'pending',
            priority: priority || 'normal',
            silent: silent || false
        });
        res.status(201).json({ message: 'Tugas ditambahkan', task });
    } catch (error) {
        res.status(500).json({ error: 'Gagal menambah tugas' });
    }
});

app.put('/api/tasks/:id', async (req, res) => {
    const { name, date, detail, priority, silent } = req.body;
    try {
        const tasks = await Task.find({ status: { $ne: 'deleted' } }).sort({ createdAt: 1 });
        const id = parseInt(req.params.id);
        if (tasks[id]) {
            await Task.findByIdAndUpdate(tasks[id]._id, {
                name,
                deadline: date || '',
                detail: detail !== undefined ? detail : tasks[id].detail,
                priority: priority || tasks[id].priority || 'normal',
                silent: silent !== undefined ? silent : tasks[id].silent
            });
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

app.delete('/api/tasks/:id', requireAdmin, async (req, res) => {
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

app.delete('/api/settings/:id', requireAdmin, async (req, res) => {
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
