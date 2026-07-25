const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");

// Siapkan folder
const dataDir = path.join(__dirname, '../data');
const mediaDir = path.join(__dirname, '../data/media');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir);

const dbPath = path.join(dataDir, 'reminder.json');
if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify([]));
let lastCctvLogTime = null;

// Siapkan file khusus buat nyimpen Template Header
const headerPath = path.join(dataDir, 'reminder_header.txt');
if (!fs.existsSync(headerPath)) fs.writeFileSync(headerPath, "[REMINDER] *INI ADALAH PESAN OTOMATIS oleh USERBOT FAHRI*\n\n");

// Fungsi buat ganti Header dari WA
function setHeader(text) {
    fs.writeFileSync(headerPath, text + "\n\n");
    return true;
}

// Fungsi nyimpen media
async function saveMedia(msgContent, type, extension) {
    const stream = await downloadContentFromMessage(msgContent, type);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    
    const fileName = `remind_${Date.now()}.${extension}`;
    const filePath = path.join(mediaDir, fileName);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

// Fungsi tambah jadwal
async function addReminder(targetNumber, time, text, quotedMsg, options = {}) {
    try {
        let mediaPath = null;
        let mediaType = null;

        if (quotedMsg) {
            if (quotedMsg.imageMessage) { mediaPath = await saveMedia(quotedMsg.imageMessage, 'image', 'jpg'); mediaType = 'image'; } 
            else if (quotedMsg.videoMessage) { mediaPath = await saveMedia(quotedMsg.videoMessage, 'video', 'mp4'); mediaType = 'video'; } 
            else if (quotedMsg.audioMessage) { mediaPath = await saveMedia(quotedMsg.audioMessage, 'audio', 'mp3'); mediaType = 'audio'; } 
            else if (quotedMsg.documentMessage) {
                const ext = (quotedMsg.documentMessage.fileName || 'file').split('.').pop();
                mediaPath = await saveMedia(quotedMsg.documentMessage, 'document', ext); mediaType = 'document';
            }
        }

        const newReminder = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            target: targetNumber,
            targetLabel: options.targetLabel || "",
            time: time,
            message: text,
            mediaPath: mediaPath,
            mediaType: mediaType,
        };
        const reminders = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
        reminders.push(newReminder);
        fs.writeFileSync(dbPath, JSON.stringify(reminders, null, 2));
        return true;
    } catch (e) { return false; }
}

// Mesin pengecek jadwal (sudah disisipkan Header Otomatis)
async function checkAndSendReminders(sock) {
    try {
        const reminders = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
        const now = new Date();
        const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
        
        if (lastCctvLogTime !== currentTime) {
        
        console.log(`\n[CCTV] Jam: ${currentTime} | Antrean: ${reminders.length}`);
            lastCctvLogTime = currentTime;
        }
        if (reminders.length === 0) return;

        let remainingReminders = [];

        // Tarik template header dari database
        const headerText = fs.readFileSync(headerPath, 'utf-8');

        for (const rem of reminders) {
            if (rem.time === currentTime) {
                console.log(`[Reminder] Mengeksekusi pesan ke ${rem.target.split('@')[0]}...`);
                
                // Gabungkan Header dengan isi pesan
                const finalMessage = headerText + (rem.message || "");

                try {
                    if (rem.mediaPath && fs.existsSync(rem.mediaPath)) {
                        const mediaSource = { url: rem.mediaPath };
                        if (rem.mediaType === 'image') await sock.sendMessage(rem.target, { image: mediaSource, caption: finalMessage });
                        else if (rem.mediaType === 'video') await sock.sendMessage(rem.target, { video: mediaSource, caption: finalMessage });
                        else if (rem.mediaType === 'audio') await sock.sendMessage(rem.target, { audio: mediaSource, mimetype: 'audio/mp4', ptt: false });
                        else if (rem.mediaType === 'document') await sock.sendMessage(rem.target, { document: mediaSource, mimetype: 'application/octet-stream', fileName: path.basename(rem.mediaPath), caption: finalMessage });
                        fs.unlinkSync(rem.mediaPath);
                    } else {
                        await sock.sendMessage(rem.target, { text: finalMessage });
                    }
                    console.log("[Reminder] Terkirim!");
                } catch (e) { console.log("[Reminder] Gagal:", e.message); }
            } else {
                remainingReminders.push(rem);
            }
        }

        if (reminders.length !== remainingReminders.length) fs.writeFileSync(dbPath, JSON.stringify(remainingReminders, null, 2));
    } catch (e) {}
}
// Fungsi buat ngambil list jadwal
function getReminders() {
    try { return JSON.parse(fs.readFileSync(dbPath, 'utf-8')); } catch { return []; }
}

// Fungsi buat hapus jadwal
function delReminder(index) {
    try {
        const reminders = getReminders();
        if (index < 1 || index > reminders.length) return false;
        
        // Hapus file medianya juga kalau ada
        const rem = reminders[index - 1];
        if (rem.mediaPath && fs.existsSync(rem.mediaPath)) fs.unlinkSync(rem.mediaPath);
        
        reminders.splice(index - 1, 1);
        fs.writeFileSync(dbPath, JSON.stringify(reminders, null, 2));
        return true;
    } catch { return false; }
}

module.exports = { addReminder, checkAndSendReminders, setHeader, getReminders, delReminder };
