require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
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
        const all = await Task.find();
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

// --- TASKS ---
app.get('/api/tasks', async (req, res) => {
    try {
        const tasks = await Task.find().sort({ createdAt: 1 });
        res.json(tasks);
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil data' });
    }
});

app.post('/api/tasks', async (req, res) => {
    const { name, date, detail, priority } = req.body;
    if (!name) return res.status(400).json({ error: 'Nama tugas wajib diisi' });

    try {
        const task = await Task.create({
            name,
            deadline: date || '',
            detail: detail || '',
            status: 'pending',
            priority: priority || 'normal'
        });
        res.status(201).json({ message: 'Tugas ditambahkan', task });
    } catch (error) {
        res.status(500).json({ error: 'Gagal menambah tugas' });
    }
});

app.put('/api/tasks/:id', async (req, res) => {
    const { name, date, detail, priority } = req.body;
    try {
        const tasks = await Task.find().sort({ createdAt: 1 });
        const id = parseInt(req.params.id);
        if (tasks[id]) {
            await Task.findByIdAndUpdate(tasks[id]._id, {
                name,
                deadline: date || '',
                detail: detail !== undefined ? detail : tasks[id].detail,
                priority: priority || tasks[id].priority || 'normal'
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
    const { status } = req.body;
    try {
        const tasks = await Task.find().sort({ createdAt: 1 });
        const id = parseInt(req.params.id);
        if (tasks[id]) {
            const update = { status };
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

// --- SETTINGS ---
app.get('/api/settings', async (req, res) => {
    try {
        const settings = await Setting.find();
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil data grup' });
    }
});

app.delete('/api/settings/:id', async (req, res) => {
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
