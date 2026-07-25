const axios = require("axios")
const fs = require("fs")
const path = require("path")
const { exec } = require("child_process")

const STICKER_DIR = path.join(__dirname, "../data/stickers")
const TG_STICKER_TEMP = path.join(__dirname, "../data/tg_sticker_temp")

// Pastikan folder ada
;[STICKER_DIR, TG_STICKER_TEMP].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
})

// Convert image ke WebP
async function imageToWebp(buffer) {
    return new Promise((resolve, reject) => {
        const tempInput = path.join(TG_STICKER_TEMP, `temp_${Date.now()}.png`)
        const tempOutput = path.join(TG_STICKER_TEMP, `temp_${Date.now()}.webp`)

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
                reject(err || new Error("Gagal convert ke WebP"))
            }
        })
    })
}

// Extract nama stiker set dari URL Telegram
function extractStickerSetName(url) {
    // Format: https://t.me/addstickers/[sticker_set_name]
    const match = url.match(/t\.me\/addstickers\/([a-zA-Z0-9_]+)/i)
    return match ? match[1] : null
}

// Download stiker dari URL langsung
async function downloadStickerFromUrl(url) {
    try {
        const response = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 30000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        })
        return Buffer.from(response.data)
    } catch (err) {
        throw new Error(`Gagal download stiker: ${err.message}`)
    }
}

// Fetch stiker pack dari Telegram API via web crawler
async function fetchTelegramStickerPack(stickerSetName) {
    try {
        // Menggunakan endpoint CDN Telegram untuk fetch stiker
        const tgUrl = `https://t.me/addstickers/${stickerSetName}`
        
        const response = await axios.get(tgUrl, {
            timeout: 15000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        })

        // Parse HTML untuk cari link download stiker
        const html = response.data
        
        // Ekstrak info dari halaman
        const titleMatch = html.match(/<title>(.*?)<\/title>/)
        const title = titleMatch ? titleMatch[1] : "Stiker Telegram"

        // Return info paket stiker
        return {
            name: stickerSetName,
            title: title,
            url: tgUrl
        }
    } catch (err) {
        throw new Error(`Gagal akses paket stiker: ${err.message}`)
    }
}

// Handle stiker dari URL Telegram
async function handleTelegramStickerUrl(sock, from, url, pushName) {
    const name = pushName || "Kak"

    try {
        await sock.sendPresenceUpdate("composing", from)
        await sock.sendMessage(from, { 
            text: `⏳ Sedang memproses paket stiker Telegram, tunggu ${name}...` 
        })

        // Ekstrak nama paket stiker
        const stickerSetName = extractStickerSetName(url)
        if (!stickerSetName) {
            await sock.sendMessage(from, {
                text: `❌ URL tidak valid. Format yang benar:\n\n*.tgstiker https://t.me/addstickers/[nama_paket]*\n\nContoh: *.tgstiker https://t.me/addstickers/LINE*`
            })
            return true
        }

        // Fetch info paket
        const packInfo = await fetchTelegramStickerPack(stickerSetName)

        // Kirim pesan info dan menu pilihan
        const infoText = `
🎨 *Paket Stiker Telegram Ditemukan*

📌 Nama: ${packInfo.name}
📄 Info: ${packInfo.title}

📝 *Cara Download:*
1. Buka link Telegram paket ini
2. Klik tombol "Add Stickers" untuk add ke Telegram Anda
3. Atau screenshot stiker untuk dikirim ke bot ini

⚠️ *Catatan:*
Bot ini akan mengonvert stiker yang Anda kirim menjadi format WhatsApp stiker. Stiker animasi akan dikonvert ke format statis.

💡 *Tips:* Screenshot stiker dari Telegram, lalu kirim ke bot dengan caption *.stiker*
        `.trim()

        await sock.sendMessage(from, { text: infoText })

        return true
    } catch (err) {
        console.error("TG Sticker Error:", err)
        await sock.sendMessage(from, {
            text: `❌ Gagal memproses paket stiker, ${name}.\n\nError: ${err.message}`
        })
        return true
    }
}

// Handle pesan dengan URL stiker Telegram
async function handleTgStickerMessage(sock, from, text, msg, pushName) {
    // Deteksi format: .tgstiker [URL]
    if (!text.toLowerCase().startsWith(".tgstiker ")) return false

    const url = text.replace(/\.tgstiker\s+/i, "").trim()
    
    if (!url || !url.startsWith("https://t.me/")) {
        await sock.sendMessage(from, {
            text: `❌ Format salah!\n\n*Penggunaan:*\n.tgstiker https://t.me/addstickers/[nama_paket]\n\nContoh:\n.tgstiker https://t.me/addstickers/LINE`
        })
        return true
    }

    return await handleTelegramStickerUrl(sock, from, url, pushName)
}

// Cleanup temp files secara berkala
function cleanupTempFiles() {
    try {
        if (fs.existsSync(TG_STICKER_TEMP)) {
            const files = fs.readdirSync(TG_STICKER_TEMP)
            const now = Date.now()
            
            files.forEach(file => {
                const filePath = path.join(TG_STICKER_TEMP, file)
                const stat = fs.statSync(filePath)
                // Hapus file lebih dari 1 jam
                if (now - stat.mtimeMs > 3600000) {
                    fs.unlinkSync(filePath)
                }
            })
        }
    } catch (err) {
        console.error("Cleanup error:", err)
    }
}

// Run cleanup setiap 30 menit
setInterval(cleanupTempFiles, 1800000)

module.exports = {
    extractStickerSetName,
    downloadStickerFromUrl,
    fetchTelegramStickerPack,
    handleTelegramStickerUrl,
    handleTgStickerMessage,
    imageToWebp,
    cleanupTempFiles
}
