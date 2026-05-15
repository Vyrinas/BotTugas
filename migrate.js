require('dotenv').config();
const fs = require('fs');
const { connectDB, Task } = require('./database');
const mongoose = require('mongoose');

async function migrate() {
    await connectDB();
    if (fs.existsSync('./tasks.json')) {
        const tasks = JSON.parse(fs.readFileSync('./tasks.json', 'utf8'));
        if (tasks.length > 0) {
            await Task.deleteMany({});
            await Task.insertMany(tasks);
            console.log('✅ Berhasil migrasi tasks.json ke MongoDB');
        }
    }
    process.exit(0);
}
migrate();
