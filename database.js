const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 15000, // Tunggu 15 detik sebelum timeout
            heartbeatFrequencyMS: 10000,     // Cek detak jantung koneksi setiap 10 detik
        });
        console.log('✅ Berhasil terhubung ke MongoDB Atlas!');
    } catch (error) {
        console.error('❌ Gagal terhubung ke MongoDB:', error);
        process.exit(1);
    }
};

const taskSchema = new mongoose.Schema({
    name: { type: String, required: true },
    detail: { type: String, default: '' },
    deadline: { type: String, default: '' },
    status: { type: String, default: 'pending' }
}, { timestamps: true });

const settingSchema = new mongoose.Schema({
    reminderJid: { type: String, required: true, unique: true }
});

const Task = mongoose.model('Task', taskSchema);
const Setting = mongoose.model('Setting', settingSchema);

module.exports = { connectDB, Task, Setting };
