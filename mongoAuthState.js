const mongoose = require('mongoose');
const { initAuthCreds, BufferJSON, proto } = require('baileys-joss');

const authSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    data: { type: Object, required: true }
});

const Auth = mongoose.model('AuthSession', authSchema);

const useMongoDBAuthState = async () => {
    const writeData = async (data, id) => {
        const informationToStore = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await Auth.updateOne({ _id: id }, { $set: { data: informationToStore } }, { upsert: true });
    };

    const readData = async (id) => {
        try {
            const doc = await Auth.findById(id);
            if (doc) {
                return JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver);
            }
        } catch (error) {
            console.error('Error reading auth state:', error);
        }
        return null;
    };

    const removeData = async (id) => {
        try {
            await Auth.deleteOne({ _id: id });
        } catch (error) {
            console.error('Error removing auth state:', error);
        }
    };

    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, 'creds');
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async id => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        }
    };
};

module.exports = { useMongoDBAuthState };
