require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { connectDB, Task } = require('../database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Middleware untuk memastikan koneksi DB
app.use(async (req, res, next) => {
    await connectDB();
    next();
});

app.get('/health', (req, res) => res.status(200).send('OK'));

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
        // Cukup simpan ke DB. Bot akan mendeteksi via Change Stream atau Cron.
        const task = await Task.create({ name, deadline: date || '', detail: detail || '', status: 'pending' });
        res.status(201).json({ message: 'Tugas ditambahkan ke database', task });
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
            await Task.findByIdAndUpdate(tasks[id]._id, { name, deadline: date || '', detail: detail !== undefined ? detail : tasks[id].detail });
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

if (process.env.NODE_ENV !== 'production' || require.main === module) {
    app.listen(PORT, () => {
        console.log(`🌐 Web Dashboard aktif di port ${PORT}`);
    });
}

module.exports = app;
