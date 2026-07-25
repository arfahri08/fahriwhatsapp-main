const { downloadMediaMessage } = require("@whiskeysockets/baileys")
const fs = require("fs")
const path = require("path")
const { exec } = require("child_process")

const STICKER_DIR = path.join(__dirname, "../data/stickers")

// Pastikan folder stiker ada
if (!fs.existsSync(STICKER_DIR)) {
    fs.mkdirSync(STICKER_DIR, { recursive: true })
}

// Convert buffer gambar → buffer webp menggunakan mesin FFmpeg
async function imageToWebp(buffer) {
    return new Promise((resolve, reject) => {
        const tempInput = path.join(STICKER_DIR, `temp_${Date.now()}.jpg`)
        const tempOutput = path.join(STICKER_DIR, `temp_${Date.now()}.webp`)

        fs.writeFileSync(tempInput, buffer)

        const command = `ffmpeg -i "${tempInput}" -vf "scale=512:512:flags=lanczos:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0" -c:v libwebp -preset default -loop 0 -vsync 0 "${tempOutput}"`

        exec(command, (err) => {
            if (!err && fs.existsSync(tempOutput)) {
                const webpBuffer = fs.readFileSync(tempOutput)
                fs.unlinkSync(tempInput)
                fs.unlinkSync(tempOutput)
                resolve(webpBuffer)
            } else {
                if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput)
                if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput)
                reject(err || new Error("Gagal convert gambar ke stiker"))
            }
        })
    })
}

// Download gambar dari pesan WA
async function downloadImage(msg) {
    return await downloadMediaMessage(msg, "buffer", {})
}

// Simpan stiker ke koleksi
function saveSticker(name, buffer) {
    fs.mkdirSync(STICKER_DIR, { recursive: true })
    fs.writeFileSync(path.join(STICKER_DIR, `${name}.webp`), buffer)
}

// Ambil stiker dari koleksi
function getSticker(name) {
    const file = path.join(STICKER_DIR, `${name}.webp`)
    if (!fs.existsSync(file)) return null
    return fs.readFileSync(file)
}

// Hapus stiker dari koleksi
function deleteSticker(name) {
    const file = path.join(STICKER_DIR, `${name}.webp`)
    if (!fs.existsSync(file)) return false
    fs.unlinkSync(file)
    return true
}

// Daftar semua stiker tersimpan
function listStickers() {
    if (!fs.existsSync(STICKER_DIR)) return []
    return fs.readdirSync(STICKER_DIR)
        .filter(f => f.endsWith(".webp"))
        .map(f => f.replace(".webp", ""))
}

// ===== HANDLER UTAMA STIKER =====
async function handleSticker(sock, from, msg, text, pushName) {
    let targetSticker = null;
    const name = pushName || "Kak"; // Nama dinamis agar sopan ke publik

    // 1. Cek: Kirim gambar baru + caption .stiker
    if (msg.message?.imageMessage && (msg.message.imageMessage.caption || "").trim().toLowerCase() === ".stiker") {
        targetSticker = msg;
    } 
    // 2. Cek: Reply gambar lama dengan teks .stiker
    else if (text.toLowerCase() === ".stiker" && msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
        targetSticker = { 
            message: msg.message.extendedTextMessage.contextInfo.quotedMessage 
        };
    }

    if (targetSticker) {
        await sock.sendPresenceUpdate("composing", from);
        await sock.sendMessage(from, { text: `⏳ Sedang membuat stiker, tunggu ya ${name}...` });

        try {
            const buffer = await downloadImage(targetSticker);
            const webp = await imageToWebp(buffer);
            await sock.sendMessage(from, { sticker: webp });
            return true;
        } catch (e) {
            console.log("Sticker Error:", e.message);
            await sock.sendMessage(from, { text: `❌ Gagal buat stiker, ${name}. Pastikan format gambarnya benar.` });
            return true;
        }
    }
    return false;
}

module.exports = { 
    imageToWebp, 
    downloadImage, 
    saveSticker, 
    getSticker, 
    deleteSticker, 
    listStickers,
    handleSticker 
}
