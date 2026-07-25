const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Kita pakai file json langsung
const dbPath = path.join(dataDir, 'brankas_vo.json');
if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify({}));
const MAX_VIEW_ONCE_ITEMS = 500;
const VIEW_ONCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// INI KUNCINYA: Penghancur BigInt biar gak crash pas disimpen
function safeStringify(obj, space) {
    return JSON.stringify(obj, (key, value) => typeof value === 'bigint' ? value.toString() : value, space);
}

function pruneViewOnceCache(dbContent) {
    const now = Date.now();

    for (const [id, item] of Object.entries(dbContent)) {
        if (item?.__savedAt && now - item.__savedAt > VIEW_ONCE_TTL_MS) {
            delete dbContent[id];
        }
    }

    const entries = Object.entries(dbContent);
    if (entries.length <= MAX_VIEW_ONCE_ITEMS) return dbContent;

    entries
        .sort((a, b) => (a[1]?.__savedAt || 0) - (b[1]?.__savedAt || 0))
        .slice(0, entries.length - MAX_VIEW_ONCE_ITEMS)
        .forEach(([id]) => delete dbContent[id]);

    return dbContent;
}

const saveViewOnce = (id, data) => {
    try {
        const dbContent = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
        
        // Simpan datanya
        dbContent[id] = JSON.parse(safeStringify(data));
        dbContent[id].__savedAt = Date.now();
        pruneViewOnceCache(dbContent);
        fs.writeFileSync(dbPath, safeStringify(dbContent, 2));
        
        console.log(`✅ [Database] Berhasil menulis file JSON untuk ID: ${id}`);
    } catch (e) {
        console.log("❌ [Database] Gagal nyimpen:", e.message);
    }
};

const getViewOnce = (id) => {
    try {
        const dbContent = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
        
        // Fuzzy search manual (jaga-jaga kalau ID-nya nyelip)
        for (let savedId in dbContent) {
            if (savedId === id || savedId.includes(id) || id.includes(savedId)) {
                return dbContent[savedId];
            }
        }
        return null;
    } catch (e) {
        return null;
    }
};

module.exports = { saveViewOnce, getViewOnce };
