const axios = require("axios");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { delay } = require("./delay");

const menuSessions = new Map();

// ============================================================
//  KONFIGURASI — ISI SEBELUM DIPAKAI
// ============================================================
const CONFIG = {
    // [WAJIB] Path cookies Instagram yang diekspor dari browser
    // Cara export: pakai ekstensi "Get cookies.txt LOCALLY" di Chrome/Firefox
    // lalu simpan file-nya, isi path-nya di sini.
    IG_COOKIES_PATH: path.join(__dirname, "ig_cookies.txt"),

    // [OPSIONAL] Akun IG cadangan jika cookies tidak ada
    IG_USERNAME: "koid.an",
    IG_PASSWORD: "akuntumb4l",

    // [OPSIONAL] RapidAPI key untuk fallback berbayar (gratis 100 req/bln)
    // Daftar di: https://rapidapi.com/mrBarbwire/api/instagram-downloader3
    RAPIDAPI_KEY: "93d13f4a3emshb898bc2fdb42656p1e6799jsne80e0fd003cc",

    // Folder temp untuk file yang didownload yt-dlp
    TEMP_DIR: path.join(process.env.HOME || os.homedir() || process.cwd(), "wa_bot_dl"),
};

// Buat temp dir kalau belum ada
if (!fs.existsSync(CONFIG.TEMP_DIR)) fs.mkdirSync(CONFIG.TEMP_DIR, { recursive: true });


// ============================================================
//  HELPER: Resolve Share/Enkripsi URL Instagram
//  instagram.com/share/... atau link pendek -> URL asli
// ============================================================
async function resolveIGUrl(url) {
    try {
        // Follow redirect tanpa body, ambil Location header
        const r = await axios.get(url, {
            maxRedirects: 5,
            validateStatus: () => true,
            headers: {
                "User-Agent": "Mozilla/5.0 (Linux; Android 12; SM-A325F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
            },
            timeout: 8000,
        });
        // Ambil URL final setelah redirect
        const finalUrl = r.request?.res?.responseUrl || r.config?.url || url;
        console.log(`[URL-RESOLVE] ${url} -> ${finalUrl}`);
        return finalUrl;
    } catch (e) {
        console.log(`[URL-RESOLVE] Gagal resolve, pakai URL asli: ${e.message}`);
        return url;
    }
}


// ============================================================
//  JALUR 1: yt-dlp (PALING STABIL — DIREKOMENDASIKAN)
//  Install di Termux: pip install yt-dlp
//  Update rutin: pip install -U yt-dlp
// ============================================================
function runYtDlp(url) {
    return new Promise((resolve, reject) => {
        const outputTemplate = path.join(CONFIG.TEMP_DIR, "%(id)s.%(ext)s");

        // Bangun argumen yt-dlp
        const args = [
            `"${url}"`,
            `-o "${outputTemplate}"`,
            "--no-playlist",
            "--no-warnings",
            "--print after_move:filepath",  // Print path file hasil download
            "--merge-output-format mp4",
        ];

        // Pakai cookies kalau file tersedia
        if (fs.existsSync(CONFIG.IG_COOKIES_PATH)) {
            args.push(`--cookies "${CONFIG.IG_COOKIES_PATH}"`);
        } else if (CONFIG.IG_USERNAME && CONFIG.IG_PASSWORD) {
            args.push(`--username "${CONFIG.IG_USERNAME}" --password "${CONFIG.IG_PASSWORD}"`);
        }

        const cmd = `yt-dlp ${args.join(" ")}`;
        console.log(`[YT-DLP] Menjalankan: ${cmd}`);

        exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
            if (err) {
                return reject(new Error(`yt-dlp error: ${stderr || err.message}`));
            }
            // stdout berisi path file yang didownload (dari --print)
            const filePath = stdout.trim().split("\n").pop();
            if (!filePath || !fs.existsSync(filePath)) {
                return reject(new Error("yt-dlp: File hasil tidak ditemukan"));
            }
            resolve({ filePath, type: "video" });
        });
    });
}


// ============================================================
//  JALUR 2: RapidAPI Instagram Downloader (FALLBACK BERBAYAR)
//  Free tier: 100 req/bulan — cukup untuk bot skala kecil
//  Daftar di: https://rapidapi.com/mrBarbwire/api/instagram-downloader3
// ============================================================
async function downloadViaRapidAPI(url) {
    if (!CONFIG.RAPIDAPI_KEY) throw new Error("RapidAPI key belum diisi di CONFIG");

    const r = await axios.get("https://instagram-downloader3.p.rapidapi.com/v1/download", {
        params: { url },
        headers: {
            "X-RapidAPI-Key": CONFIG.RAPIDAPI_KEY,
            "X-RapidAPI-Host": "instagram-downloader3.p.rapidapi.com",
        },
        timeout: 15000,
    });

    const data = r.data;
    // Format response: { url, type } atau { medias: [{url, type}] }
    if (data?.medias?.length) {
        const items = data.medias;
        if (items.length > 1) {
            // Carousel/slideshow
            return {
                type: "carousel",
                items: items.map(m => ({ url: m.url, type: m.type || (m.url.includes(".mp4") ? "video" : "image") })),
            };
        }
        return { url: items[0].url, type: items[0].type || "video" };
    }
    if (data?.url) {
        return { url: data.url, type: data.type || "video" };
    }
    throw new Error("RapidAPI: Respon tidak valid");
}


// ============================================================
//  MAIN: downloadIG — Orchestrator dengan fallback chain
// ============================================================
async function downloadIG(rawUrl) {
    // Step 1: Resolve URL share/enkripsi dulu
    const url = await resolveIGUrl(rawUrl);

    const errors = [];

    // === JALUR 1: yt-dlp (lokal, paling stabil) ===
    try {
        console.log("[IG] Mencoba Jalur 1: yt-dlp...");
        const result = await runYtDlp(url);
        console.log("✅ [IG] Jalur 1 (yt-dlp) BERHASIL");
        return result;
    } catch (e) {
        console.log(`❌ [IG] Jalur 1 GAGAL: ${e.message}`);
        errors.push(`yt-dlp: ${e.message}`);
    }

    // === JALUR 2: RapidAPI (berbayar, bukan URL lokal) ===
    try {
        console.log("[IG] Mencoba Jalur 2: RapidAPI...");
        const result = await downloadViaRapidAPI(url);
        console.log("✅ [IG] Jalur 2 (RapidAPI) BERHASIL");
        return result;
    } catch (e) {
        console.log(`❌ [IG] Jalur 2 GAGAL: ${e.message}`);
        errors.push(`RapidAPI: ${e.message}`);
    }

    throw new Error(
        `Semua jalur IG gagal:\n${errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n")}`
    );
}


// ============================================================
//  YOUTUBE — menggunakan yt-dlp
// ============================================================
async function downloadYT(url) {
    const errors = [];

    // === JALUR 1: yt-dlp (lokal, paling stabil) ===
    try {
        console.log("[YT] Mencoba yt-dlp...");
        const result = await runYtDlp(url);
        console.log("✅ [YT] yt-dlp BERHASIL");
        return result;
    } catch (e) {
        console.log(`❌ [YT] yt-dlp GAGAL: ${e.message}`);
        errors.push(`yt-dlp: ${e.message}`);
    }

    // === FALLBACK: API eksternal ===
    try {
        console.log("[YT] Mencoba API fallback...");
        const r = await axios.get(
            `https://api.ryzendesu.vip/api/downloader/yt?url=${encodeURIComponent(url)}`,
            { timeout: 20000 }
        );
        const d = r.data?.data;
        if (!d) throw new Error("API: Empty data");
        return { type: "video", url: d.url || d.video, title: d.title || "YouTube Video" };
    } catch (e) {
        console.log(`❌ [YT] Fallback API GAGAL: ${e.message}`);
        errors.push(`Fallback API: ${e.message}`);
    }

    throw new Error(
        `Semua jalur YouTube gagal:\n${errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n")}`
    );
}

// ============================================================
//  TIKTOK — Tidak berubah, masih stabil
// ============================================================
async function downloadTikTok(url) {
    const apis = [
        async () => {
            const r = await axios.post("https://www.tikwm.com/api/", { url }, { timeout: 12000 });
            const d = r.data?.data;
            if (!d) throw new Error("Tikwm: Empty data");
            if (d.images) return { type: "photos", images: d.images, title: d.title };
            return { type: "video", url: d.play, title: d.title };
        },
        async () => {
            const r = await axios.get(
                `https://api.ryzendesu.vip/api/downloader/ttdl?url=${encodeURIComponent(url)}`,
                { timeout: 12000 }
            );
            const d = r.data?.data;
            if (!d) throw new Error("Ryzendesu: Empty data");
            return { type: "video", url: d.play || d.video?.[0], title: d.title };
        },
    ];

    for (let i = 0; i < apis.length; i++) {
        try {
            return await apis[i]();
        } catch (e) {
            console.log(`❌ [TT] API ${i + 1} GAGAL: ${e.message}`);
        }
    }
    throw new Error("Semua API TikTok gagal.");
}


// ============================================================
//  UTILS
// ============================================================
function detectLinkType(text) {
    if (/tiktok\.com|vm\.tiktok\.com/i.test(text)) return "tt";
    if (/instagram\.com|instagr\.am/i.test(text)) return "ig";
    if (/threads\.net/i.test(text)) return "ig"; // Threads pakai IG downloader
    if (/youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(text)) return "yt";
    return null;
}

function extractUrl(text) {
    const match = text.match(/https?:\/\/[^\s]+/);
    return match ? match[0] : null;
}

// Hapus file temp setelah dikirim
function cleanupFile(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
        console.log(`[CLEANUP] Gagal hapus file: ${e.message}`);
    }
}


// ============================================================
//  HANDLER UTAMA
// ============================================================
async function handleInteractiveDownload(sock, from, text, pushName) {
    if (String(from || "").toLowerCase().endsWith("@g.us")) return false;

    const session = menuSessions.get(from);
    const name = pushName || "Kak";

    // --- Proses pilihan menu ---
    if (session && session.step === "awaiting_choice") {
        const choice = text.trim();
        if (!["1", "2", "3"].includes(choice)) return false;
        
        // Hapus pesan menu
        if (session.menuMessageKey) {
            try {
                await sock.chatModify({ delete: session.menuMessageKey }, from);
            } catch (err) {
                // Silent fail - menu akan tetap ada jika delete gagal
            }
        }
        menuSessions.delete(from);

        if (choice === "3") {
            await sock.sendMessage(from, { text: "❌ Download dibatalkan." });
            return true;
        }

        await sock.sendPresenceUpdate("composing", from);
        const statusMsg = await sock.sendMessage(from, { text: `⏳ Sedang memproses, tunggu ya ${name}..` });

        try {
            if (session.type === "tt") {
                // --- TikTok ---
                const result = await downloadTikTok(session.url);
                if (result.type === "photos") {
                    await sock.sendMessage(from, { text: `📸 *TikTok Slideshow*\n📝 ${result.title}` });
                    for (const img of result.images) {
                        await sock.sendMessage(from, { image: { url: img } });
                        await delay(1500);
                    }
                } else {
                    await sock.sendMessage(from, {
                        video: { url: result.url },
                        caption: `✅ *TikTok Video*\n📝 ${result.title}`,
                    });
                }
            } else if (session.type === "yt") {
                // --- YouTube ---
                const result = await downloadYT(session.url);
                if (result.filePath) {
                    await sock.sendMessage(from, {
                        video: { url: result.filePath },
                        caption: `✅ *YouTube Video*\n📝 ${result.title || "Video"}`,
                        mimetype: "video/mp4",
                    });
                    cleanupFile(result.filePath);
                } else {
                    await sock.sendMessage(from, {
                        video: { url: result.url },
                        caption: `✅ *YouTube Video*\n📝 ${result.title || "Video"}`,
                    });
                }
            } else {
                // --- Instagram / Threads ---
                const result = await downloadIG(session.url);

                if (result.filePath) {
                    // Hasil yt-dlp: file lokal
                    await sock.sendMessage(from, {
                        video: { url: result.filePath },
    caption: "✅ Berhasil download",
                        mimetype: "video/mp4",
                    });
                    cleanupFile(result.filePath);
                } else if (result.type === "carousel") {
                    // Carousel dari RapidAPI
                    await sock.sendMessage(from, { text: `📸 *Carousel (${result.items.length} media)*` });
                    for (const item of result.items) {
                        await sock.sendMessage(from, {
                            [item.type]: { url: item.url },
                            caption: "✅ Berhasil download",
                        });
                        await delay(1500);
                    }
                } else {
                    // Single media dari RapidAPI
                    await sock.sendMessage(from, {
                        [result.type]: { url: result.url },
                        caption: "✅ Berhasil download",
                    });
                }
            }
        } catch (error) {
            console.error("[ERROR]", error);
            await sock.sendMessage(from, {
                text: `❌ Gagal memproses:\n${error.message}\n\nCoba lagi atau pastikan link bukan private/archived.`,
            });
        } finally {
            // Hapus pesan status
            if (statusMsg) {
                try {
                    await sock.chatModify({ delete: statusMsg.key }, from);
                } catch (err) {
                    // Silent fail - status akan tetap ada jika delete gagal
                }
            }
        }
        return true;
    }

    // --- Deteksi link baru ---
    const linkType = detectLinkType(text);
    const url = extractUrl(text);
    if (linkType && url) {
        await sock.sendPresenceUpdate("composing", from);
        await delay(800);
        let platformName = "";
        if (linkType === "tt") platformName = "TikTok";
        else if (linkType === "yt") platformName = "YouTube";
        else platformName = "Instagram/Threads";
        
        const menuText =
            `🌐 *Link ${platformName} Terdeteksi!*\n\n` +
            `Pilih opsi download:\n\n` +
            `*1* — Download Media Utama 🎬\n` +
            `*2* — Download Audio (Jika tersedia) 🎵\n` +
            `*3* — Batal ❌\n\n` +
            `Balas dengan angka *1*, *2*, atau *3*`;

        const menuMsg = await sock.sendMessage(from, { text: menuText });
        menuSessions.set(from, { step: "awaiting_choice", url, type: linkType, menuMessageKey: menuMsg.key });
        setTimeout(() => menuSessions.delete(from), 120000);
        return true;
    }

    return false;
}

module.exports = { handleInteractiveDownload, detectLinkType, extractUrl };
