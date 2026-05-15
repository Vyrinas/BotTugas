const mongoose = require('mongoose');

let isConnected = false;

const connectDB = async () => {
    if (isConnected || mongoose.connection.readyState === 1) {
        return;
    }

    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 15000,
            heartbeatFrequencyMS: 10000,
        });
        isConnected = true;
        console.log('✅ Berhasil terhubung ke MongoDB Atlas!');

        mongoose.connection.on('disconnected', () => {
            isConnected = false;
            console.log('⚠️ MongoDB terputus.');
        });
    } catch (error) {
        isConnected = false;
        console.error('❌ Gagal terhubung ke MongoDB:', error);
        process.exit(1);
    }
};

const taskSchema = new mongoose.Schema({
    name: { type: String, required: true },
    detail: { type: String, default: '' },
    deadline: { type: String, default: '' },
    status: { type: String, default: 'pending' },
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
    completedAt: { type: Date, default: null }
}, { timestamps: true });

const settingSchema = new mongoose.Schema({
    reminderJid: { type: String, required: true, unique: true }
});

const Task = mongoose.model('Task', taskSchema);
const Setting = mongoose.model('Setting', settingSchema);

module.exports = { connectDB, Task, Setting };
