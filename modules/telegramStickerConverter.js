const axios = require("axios")
const fs = require("fs")
const path = require("path")
const { exec } = require("child_process")
const messageCleaner = require("./messageCleaner")

const STICKER_DIR = path.join(__dirname, "../data/stickers")

// Pastikan folder stiker ada
if (!fs.existsSync(STICKER_DIR)) {
    fs.mkdirSync(STICKER_DIR, { recursive: true })
}

// Helper delay function
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// Convert buffer gambar → buffer webp menggunakan FFmpeg
async function imageToWebp(buffer) {
    return new Promise((resolve, reject) => {
        const tempInput = path.join(STICKER_DIR, `temp_${Date.now()}.png`)
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

// Download dari URL
async function downloadFromUrl(url) {
    try {
        const response = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        })
        return Buffer.from(response.data)
    } catch (error) {
        throw new Error(`Gagal download: ${error.message}`)
    }
}

const TELEGRAM_BOT_TOKEN = "7953527244:AAEG7wHtWXlvXc4fC3UFSs9HbmWR_p1HwkM";

// Fetch stiker dari API Telegram dengan Pagination
async function fetchStickerSetFromApi(setName, startFrom = 0) {
    try {
        console.log(`[TG Sticker] Fetching stiker set: ${setName} mulai index ${startFrom}`);
        
        const setUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getStickerSet?name=${setName}`;
        const setResponse = await axios.get(setUrl, { timeout: 10000 });
        
        if (!setResponse.data.ok || !setResponse.data.result.stickers) {
            return { urls: [], total: 0, amount: 0 };
        }

        const stickers = setResponse.data.result.stickers;
        
        const fileUrls = [];
        // Ambil maksimal 5 stiker, dimulai dari urutan yang diminta user
        const limit = Math.min(startFrom + 10, stickers.length);

        for (let i = startFrom; i < limit; i++) {
            const fileId = stickers[i].file_id;
            const fileUrlReq = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`;
            const fileResponse = await axios.get(fileUrlReq);
            
            if (fileResponse.data.ok) {
                const filePath = fileResponse.data.result.file_path;
                const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
                fileUrls.push(downloadUrl);
            }
        }

        return { urls: fileUrls, total: stickers.length, amount: limit - startFrom };

    } catch (error) {
        console.log(`[TG Sticker] Fetch error: ${error.message}`);
        return { urls: [], total: 0, amount: 0 };
    }
}

// Handler utama untuk konversi stiker Telegram
async function handleTelegramStickerCommand(sock, from, text, pushName) {
    const name = pushName || "Kak"

    console.log(`[TG Sticker] Command received from ${from}: ${text}`)

    // Parse command dengan memecah spasi
    const args = text.trim().split(/\s+/);
    
    if (args.length < 2) {
        await sock.sendMessage(from, {
            text: `❌ Format salah! Gunakan:\n\n*.tgstiker <URL> [Urutan_Mulai]*\n\nContoh dari awal:\n*.tgstiker https://t.me/addstickers/NamaSet*\n\nContoh lanjut ke stiker 6:\n*.tgstiker https://t.me/addstickers/NamaSet 6*`
        })
        return true
    }

    const input = args[1]
    
    // Tangkap angka urutan (jika ada), default mulai dari 1
    let startNumber = 1;
    if (args[2] && !isNaN(args[2])) {
        startNumber = parseInt(args[2]);
    }
    const startIndex = Math.max(0, startNumber - 1); // Konversi ke index array (mulai dari 0)

    if (!input.startsWith("http")) {
        await sock.sendMessage(from, { text: `❌ URL tidak valid!` })
        return true
    }

    await sock.sendPresenceUpdate("composing", from)
    const statusMsg = await sock.sendMessage(from, {
        text: `⏳ Mencari data stiker Telegram, tunggu sebentar...`
    })

    try {
        // Format 1: Link set stiker Telegram
        if (input.includes("t.me/addstickers/") || input.includes("t.me/addemoji/")) {
            const setName = input.split("/").pop().split("?")[0]
            
            // Panggil API dengan parameter startIndex
            const resultData = await fetchStickerSetFromApi(setName, startIndex)
            const stickerUrls = resultData.urls
            const totalStickers = resultData.total

            if (stickerUrls.length === 0) {
                await messageCleaner.deleteMessageObject(sock, from, statusMsg, "status Telegram sticker")
                await sock.sendMessage(from, {
                    text: `❌ Tidak bisa akses set stiker atau urutan terlalu jauh.\nTotal stiker di set ini hanya: ${totalStickers}`
                })
                return true
            }

            await messageCleaner.deleteMessageObject(sock, from, statusMsg, "status Telegram sticker")

            await sock.sendMessage(from, {
                text: `📦 Total ada ${totalStickers} stiker di set ini.\n⏳ Sedang memproses urutan ${startNumber} sampai ${startNumber + resultData.amount - 1}...`
            })

            let successCount = 0

            for (let i = 0; i < stickerUrls.length; i++) {
                try {
                    const buffer = await downloadFromUrl(stickerUrls[i])
                    const webpBuffer = await imageToWebp(buffer)

                    await sock.sendMessage(from, { sticker: webpBuffer })
                    successCount++
                    await delay(1000) // Delay 1 detik per stiker biar WA aman
                } catch (e) {
                    console.log(`[TG Sticker] Failed: ${e.message}`)
                }
            }

            // Pesan jika masih ada sisa vs jika sudah selesai semua
            if (startNumber + resultData.amount - 1 < totalStickers) {
                await sock.sendMessage(from, {
                    text: `✅ Berhasil mengirim ${successCount} stiker!\n\nUntuk lanjut ke stiker berikutnya, ketik:\n*.tgstiker ${input} ${startNumber + 10}*`
                })
            } else {
                await sock.sendMessage(from, {
                    text: `✅ Selesai! Semua ${totalStickers} stiker dari set ini sudah berhasil dikirim.`
                })
            }

            return true
        }

        // Format 2: URL CDN langsung
        if (input.includes("cdn.") || input.includes("webp") || input.includes("png") || input.includes("jpg")) {
            console.log(`[TG Sticker] Processing CDN URL directly`)
            
            const buffer = await downloadFromUrl(input)
            const webpBuffer = await imageToWebp(buffer)

            await messageCleaner.deleteMessageObject(sock, from, statusMsg, "status Telegram sticker")

            await sock.sendMessage(from, { sticker: webpBuffer })
            return true
        }

        // Jika URL bukan dari t.me atau CDN
        throw new Error("Format URL tidak dikenali. Gunakan: t.me/addstickers/nama atau URL CDN langsung")

    } catch (error) {
        console.log(`[TG Sticker] Error: ${error.message}`)

        await messageCleaner.deleteMessageObject(sock, from, statusMsg, "status Telegram sticker")

        await sock.sendMessage(from, {
            text: `❌ Gagal!\n\n📌 Alasan: ${error.message}`
        })
        return true
    }
}

module.exports = {
    handleTelegramStickerCommand
}
