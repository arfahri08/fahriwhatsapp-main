const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { delay } = require("./delay");
const messageCleaner = require("./messageCleaner");

const sessions = new Map();

const CONFIG = {
    ytdlpBin: process.env.YTDLP_BIN || "yt-dlp",
    tempDir: process.env.DOWNLOADER_TEMP_DIR || path.join(os.tmpdir(), "userbot-fahri-downloads"),
    maxFiles: Number(process.env.DOWNLOADER_MAX_FILES || 10),
    maxMb: Number(process.env.DOWNLOADER_MAX_MB || 95),
    sessionTtlMs: 2 * 60 * 1000,
    cookiesPath: process.env.YTDLP_COOKIES || path.join(__dirname, "cookies.txt"),
};

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "opus", "ogg", "wav"]);
const THREADS_CRAWLER_USER_AGENTS = [
    "facebookexternalhit/1.1",
    "Twitterbot/1.0",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];

if (!fs.existsSync(CONFIG.tempDir)) fs.mkdirSync(CONFIG.tempDir, { recursive: true });

function extractUrl(text) {
    const match = text.match(/https?:\/\/[^\s]+/i);
    return match ? match[0].replace(/[)>.,]+$/g, "") : null;
}

function isSpotifyUrl(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return (
            hostname === "spotify.com" ||
            hostname.endsWith(".spotify.com") ||
            hostname === "spotify.link" ||
            hostname.endsWith(".spotify.link")
        );
    } catch {
        return false;
    }
}

function detectPlatform(text) {
    const url = extractUrl(text);
    if (!url) return null;
    if (isSpotifyUrl(url)) return null;
    if (/tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i.test(url)) return "tiktok";
    if (/instagram\.com|instagr\.am/i.test(url)) return "instagram";
    if (/threads\.(net|com)/i.test(url)) return "threads";
    if (/youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(url)) return "youtube";
    return null;
}

function platformLabel(platform) {
    if (platform === "tiktok") return "TikTok";
    if (platform === "threads") return "Threads";
    if (platform === "youtube") return "YouTube";
    return "Instagram";
}

function normalizeDownloadUrl(url, platform) {
    if (platform !== "threads") return url;

    try {
        const parsed = new URL(url);
        parsed.protocol = "https:";
        parsed.hostname = "www.threads.com";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
    } catch {
        return url.replace(/https?:\/\/(www\.)?threads\.(net|com)/i, "https://www.threads.com").split("?")[0];
    }
}

function makeSessionKey(jid) {
    return jid;
}

function clearSession(jid) {
    const key = makeSessionKey(jid);
    const session = sessions.get(key);
    if (session?.timer) clearTimeout(session.timer);
    sessions.delete(key);
}

function rememberSession(jid, session) {
    clearSession(jid);
    const key = makeSessionKey(jid);
    const timer = setTimeout(() => sessions.delete(key), CONFIG.sessionTtlMs);
    sessions.set(key, { ...session, timer });
}

function getCookieArgs() {
    if (!CONFIG.cookiesPath || !fs.existsSync(CONFIG.cookiesPath)) return [];
    return ["--cookies", CONFIG.cookiesPath];
}

function buildYtDlpArgs(url, mode) {
    const outputTemplate = "%(extractor)s_%(id)s_%(epoch)s.%(ext)s";
    const args = [
        "--no-warnings",
        "--no-progress",
        "--no-mtime",
        "--restrict-filenames",
        "--trim-filenames",
        "90",
        "--socket-timeout",
        "20",
        "--retries",
        "2",
        "--fragment-retries",
        "2",
        "--playlist-end",
        String(CONFIG.maxFiles),
        "--max-filesize",
        `${CONFIG.maxMb}M`,
        "--merge-output-format",
        "mp4",
        "--print",
        "after_move:filepath",
        "-P",
        CONFIG.tempDir,
        "-o",
        outputTemplate,
        ...getCookieArgs(),
    ];

    if (mode === "audio") {
        args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    }

    args.push(url);
    return args;
}

function runYtDlp(url, mode) {
    return new Promise((resolve, reject) => {
        const args = buildYtDlpArgs(url, mode);
        const child = spawn(CONFIG.ytdlpBin, args, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", chunk => {
            stdout += chunk.toString();
        });

        child.stderr.on("data", chunk => {
            stderr += chunk.toString();
        });

        child.on("error", error => {
            if (error.code === "ENOENT") {
                reject(new Error("yt-dlp belum terpasang. Install dulu: pkg install python ffmpeg && pip install -U yt-dlp"));
                return;
            }
            reject(error);
        });

        child.on("close", code => {
            const files = stdout
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)
                .filter(filePath => fs.existsSync(filePath));

            if (code !== 0) {
                reject(new Error((stderr || `yt-dlp keluar dengan kode ${code}`).trim()));
                return;
            }

            if (files.length === 0) {
                reject(new Error("yt-dlp selesai, tapi file hasil download tidak ditemukan."));
                return;
            }

            resolve([...new Set(files)].slice(0, CONFIG.maxFiles).map(filePath => ({
                filePath,
                type: detectFileType(filePath),
            })));
        });
    });
}

function fetchText(url, headers = {}, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) {
            reject(new Error("Redirect terlalu banyak saat membuka Threads."));
            return;
        }

        const parsed = new URL(url);
        const client = parsed.protocol === "http:" ? http : https;
        const req = client.get(parsed, {
            headers: {
                accept: "text/html,application/xhtml+xml",
                "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
                ...headers,
            },
            timeout: 20000,
        }, res => {
            const location = res.headers.location;
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && location) {
                res.resume();
                fetchText(new URL(location, parsed).toString(), headers, redirects + 1).then(resolve).catch(reject);
                return;
            }

            if (res.statusCode >= 400) {
                res.resume();
                reject(new Error(`Threads membalas HTTP ${res.statusCode}.`));
                return;
            }

            const chunks = [];
            let total = 0;
            res.on("data", chunk => {
                total += chunk.length;
                if (total > 3 * 1024 * 1024) {
                    req.destroy(new Error("HTML Threads terlalu besar untuk diproses."));
                    return;
                }
                chunks.push(chunk);
            });
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });

        req.on("timeout", () => req.destroy(new Error("Timeout saat membuka Threads.")));
        req.on("error", reject);
    });
}

function decodeHtml(value) {
    if (!value) return "";
    return value
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(parseInt(number, 10)));
}

function getHtmlAttribute(tag, attribute) {
    const match = tag.match(new RegExp(`${attribute}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    if (!match) return null;
    return decodeHtml(match[2] || match[3] || match[4] || "");
}

function extractMetaValues(html, names) {
    const values = [];
    const wanted = new Set(names.map(name => name.toLowerCase()));
    const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

    for (const tag of metaTags) {
        const name = (getHtmlAttribute(tag, "property") || getHtmlAttribute(tag, "name") || "").toLowerCase();
        if (!wanted.has(name)) continue;
        const content = getHtmlAttribute(tag, "content");
        if (content) values.push(content);
    }

    return values;
}

function guessMediaTypeFromUrl(url) {
    const cleanUrl = url.split("?")[0].toLowerCase();
    if (/\.(mp4|mov|m4v|webm)$/.test(cleanUrl)) return "video";
    if (/\.(jpg|jpeg|png|webp)$/.test(cleanUrl)) return "image";
    return null;
}

function uniqueMedia(media) {
    const seen = new Set();
    return media.filter(item => {
        const key = item.url.split("?")[0];
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function extractThreadsMediaFromHtml(html) {
    const videos = extractMetaValues(html, [
        "og:video",
        "og:video:url",
        "og:video:secure_url",
        "twitter:player:stream",
    ]).map(url => ({ url, type: "video" }));

    const images = extractMetaValues(html, [
        "og:image",
        "og:image:url",
        "og:image:secure_url",
        "twitter:image",
    ])
        .filter(url => !/static\.cdninstagram\.com\/rsrc\.php/i.test(url))
        .map(url => ({ url, type: "image" }));

    const directMatches = html.match(/https?:\\?\/\\?\/[^"'<>\s]+?\.(?:mp4|jpg|jpeg|png|webp)(?:\?[^"'<>\s]*)?/gi) || [];
    const directMedia = directMatches
        .map(url => decodeHtml(url))
        .map(url => ({ url, type: guessMediaTypeFromUrl(url) }))
        .filter(item => item.type === "video" && !/static\.cdninstagram\.com\/rsrc\.php/i.test(item.url));

    return uniqueMedia([...videos, ...images, ...directMedia]);
}

async function extractThreadsMedia(url) {
    const attempts = THREADS_CRAWLER_USER_AGENTS.map(userAgent => ({
        url,
        headers: {
            "user-agent": userAgent,
            referer: "https://www.threads.com/",
        },
    }));

    let lastError = null;
    for (const attempt of attempts) {
        try {
            const html = await fetchText(attempt.url, attempt.headers);
            const media = extractThreadsMediaFromHtml(html);
            if (media.length > 0) return media;
        } catch (error) {
            lastError = error;
        }
    }

    throw new Error(lastError?.message || "Media publik Threads tidak ditemukan di metadata halaman.");
}

function guessExtFromContentType(contentType, fallbackType) {
    const type = String(contentType || "").toLowerCase();
    if (type.includes("video/mp4")) return "mp4";
    if (type.includes("video/webm")) return "webm";
    if (type.includes("audio/mpeg") || type.includes("audio/mp3")) return "mp3";
    if (type.includes("audio/mp4") || type.includes("audio/m4a")) return "m4a";
    if (type.includes("audio/ogg") || type.includes("audio/opus")) return "ogg";
    if (type.includes("image/png")) return "png";
    if (type.includes("image/webp")) return "webp";
    if (type.includes("image/jpeg") || type.includes("image/jpg")) return "jpg";
    if (fallbackType === "video") return "mp4";
    if (fallbackType === "audio") return "mp3";
    return "jpg";
}

function getUrlExtension(url) {
    try {
        return path.extname(new URL(url).pathname).replace(".", "").toLowerCase();
    } catch {
        return path.extname(String(url || "").split("?")[0]).replace(".", "").toLowerCase();
    }
}

function isContentTypeCompatible(contentType, expectedType, url) {
    const type = String(contentType || "").split(";")[0].trim().toLowerCase();
    const ext = getUrlExtension(url);
    const expectedExtensions =
        expectedType === "image" ? IMAGE_EXTENSIONS :
            expectedType === "video" ? VIDEO_EXTENSIONS :
                expectedType === "audio" ? AUDIO_EXTENSIONS :
                    new Set();

    if (!type || type === "application/octet-stream" || type === "binary/octet-stream") {
        if (ext) return expectedExtensions.has(ext);
        return expectedType !== "image";
    }

    const majorType = type.split("/")[0];
    if (["image", "video", "audio"].includes(majorType)) {
        return majorType === expectedType;
    }

    return ext ? expectedExtensions.has(ext) : expectedType !== "image";
}

function downloadRemoteFile(url, type, index, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) {
            reject(new Error("Redirect file Threads terlalu banyak."));
            return;
        }

        const parsed = new URL(url);
        const client = parsed.protocol === "http:" ? http : https;
        const req = client.get(parsed, {
            headers: {
                accept: type === "video" ? "video/*,*/*" : "image/*,*/*",
                referer: "https://www.threads.com/",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            },
            timeout: 30000,
        }, res => {
            const location = res.headers.location;
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && location) {
                res.resume();
                downloadRemoteFile(new URL(location, parsed).toString(), type, index, redirects + 1).then(resolve).catch(reject);
                return;
            }

            if (res.statusCode >= 400) {
                res.resume();
                reject(new Error(`CDN Threads membalas HTTP ${res.statusCode}.`));
                return;
            }

            const ext = path.extname(parsed.pathname).replace(".", "").toLowerCase() || guessExtFromContentType(res.headers["content-type"], type);
            const filePath = path.join(CONFIG.tempDir, `threads_${Date.now()}_${index}.${ext}`);
            const stream = fs.createWriteStream(filePath);
            let total = 0;
            let settled = false;

            function fail(error) {
                if (settled) return;
                settled = true;
                stream.destroy();
                try {
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                } catch {}
                reject(error);
            }

            res.on("data", chunk => {
                total += chunk.length;
                if (total > CONFIG.maxMb * 1024 * 1024) {
                    fail(new Error(`File Threads lebih dari batas ${CONFIG.maxMb} MB.`));
                    req.destroy();
                }
            });

            stream.on("error", fail);
            stream.on("finish", () => {
                if (settled) return;
                settled = true;
                resolve({ filePath, type: detectFileType(filePath) });
            });

            res.pipe(stream);
        });

        req.on("timeout", () => req.destroy(new Error("Timeout saat download file Threads.")));
        req.on("error", reject);
    });
}

function runFfmpegToMp3(filePath) {
    return new Promise((resolve, reject) => {
        const outputPath = path.join(CONFIG.tempDir, `threads_audio_${Date.now()}.mp3`);
        const child = spawn("ffmpeg", [
            "-y",
            "-i",
            filePath,
            "-vn",
            "-codec:a",
            "libmp3lame",
            "-q:a",
            "2",
            outputPath,
        ], {
            windowsHide: true,
            stdio: ["ignore", "ignore", "pipe"],
        });

        let stderr = "";
        child.stderr.on("data", chunk => {
            stderr += chunk.toString();
        });

        child.on("error", error => {
            if (error.code === "ENOENT") {
                reject(new Error("ffmpeg belum terpasang, jadi audio Threads belum bisa diekstrak. Install: pkg install ffmpeg"));
                return;
            }
            reject(error);
        });

        child.on("close", code => {
            if (code !== 0 || !fs.existsSync(outputPath)) {
                reject(new Error((stderr || `ffmpeg keluar dengan kode ${code}`).trim()));
                return;
            }
            resolve({ filePath: outputPath, type: "audio" });
        });
    });
}

async function downloadThreads(url, mode) {
    const media = await extractThreadsMedia(url);
    const videoMedia = media.filter(item => item.type === "video");
    const imageMedia = media.filter(item => item.type === "image");
    const downloaded = [];
    const audioFiles = [];

    if (mode === "audio" && videoMedia.length === 0) {
        throw new Error("Postingan Threads ini terdeteksi sebagai gambar, jadi tidak ada audio untuk diambil.");
    }

    const selected = (mode === "audio" ? videoMedia : (videoMedia.length > 0 ? videoMedia : imageMedia)).slice(0, CONFIG.maxFiles);
    if (selected.length === 0) throw new Error("Media publik Threads tidak ditemukan.");

    try {
        for (let index = 0; index < selected.length; index++) {
            downloaded.push(await downloadRemoteFile(selected[index].url, selected[index].type, index + 1));
        }

        if (mode !== "audio") return downloaded;

        for (const file of downloaded) {
            audioFiles.push(await runFfmpegToMp3(file.filePath));
        }
        cleanupFiles(downloaded);
        return audioFiles;
    } catch (error) {
        cleanupFiles(downloaded);
        cleanupFiles(audioFiles);
        throw error;
    }
}

function fetchJson(url, label = "API") {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const client = parsed.protocol === "http:" ? http : https;
        const req = client.get(parsed, {
            headers: {
                accept: "application/json,text/plain,*/*",
                "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            },
            timeout: 25000,
        }, res => {
            if (res.statusCode >= 400) {
                res.resume();
                reject(new Error(`${label} membalas HTTP ${res.statusCode}.`));
                return;
            }

            const chunks = [];
            let total = 0;
            res.on("data", chunk => {
                total += chunk.length;
                if (total > 5 * 1024 * 1024) {
                    req.destroy(new Error(`${label} terlalu besar untuk diproses.`));
                    return;
                }
                chunks.push(chunk);
            });
            res.on("end", () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                } catch (error) {
                    reject(new Error(`${label} tidak mengirim JSON valid.`));
                }
            });
        });

        req.on("timeout", () => req.destroy(new Error(`Timeout saat membuka ${label}.`)));
        req.on("error", reject);
    });
}

function normalizeTikTokMediaUrl(url) {
    const clean = String(url || "").trim();
    if (!clean) return null;
    if (clean.startsWith("//")) return `https:${clean}`;
    if (clean.startsWith("/")) return `https://www.tikwm.com${clean}`;
    if (/^https?:\/\//i.test(clean)) return clean;
    return null;
}

async function fetchTikTokApi(url) {
    const endpoints = [
        `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`,
        `https://tikwmapi.com/api/?url=${encodeURIComponent(url)}`,
    ];

    let lastError = null;
    for (const endpoint of endpoints) {
        try {
            const response = await fetchJson(endpoint, "TikTok API");
            const data = response?.data || response?.result || response;
            if (data && typeof data === "object") return data;
        } catch (error) {
            lastError = error;
        }
    }

    throw new Error(lastError?.message || "TikTok API tidak mengirim data media.");
}

function extractTikTokApiMedia(data) {
    const images = Array.isArray(data?.images)
        ? data.images.map(normalizeTikTokMediaUrl).filter(Boolean)
        : [];

    const video =
        normalizeTikTokMediaUrl(data?.hdplay) ||
        normalizeTikTokMediaUrl(data?.play) ||
        normalizeTikTokMediaUrl(data?.video?.noWatermark) ||
        normalizeTikTokMediaUrl(data?.video?.no_watermark) ||
        normalizeTikTokMediaUrl(data?.nowm);

    const audio =
        normalizeTikTokMediaUrl(data?.music) ||
        normalizeTikTokMediaUrl(data?.music_info?.play) ||
        normalizeTikTokMediaUrl(data?.audio);

    return { images, video, audio };
}

function downloadTikTokRemoteFile(url, type, index, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) {
            reject(new Error("Redirect file TikTok terlalu banyak."));
            return;
        }

        const parsed = new URL(url);
        const client = parsed.protocol === "http:" ? http : https;
        const req = client.get(parsed, {
            headers: {
                accept: type === "video" ? "video/*,*/*" : type === "audio" ? "audio/*,*/*" : "image/*,*/*",
                referer: "https://www.tiktok.com/",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            },
            timeout: 30000,
        }, res => {
            const location = res.headers.location;
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && location) {
                res.resume();
                downloadTikTokRemoteFile(new URL(location, parsed).toString(), type, index, redirects + 1).then(resolve).catch(reject);
                return;
            }

            if (res.statusCode >= 400) {
                res.resume();
                reject(new Error(`CDN TikTok membalas HTTP ${res.statusCode}.`));
                return;
            }

            const contentType = res.headers["content-type"];
            if (!isContentTypeCompatible(contentType, type, url)) {
                console.log("[LOCAL-DL TIKTOK]", {
                    stage: "content-type-mismatch",
                    expectedType: type,
                    contentType,
                    url,
                });
                res.resume();
                reject(new Error(type === "image"
                    ? "URL TikTok yang diharapkan gambar ternyata bukan image."
                    : `URL TikTok yang diharapkan ${type} ternyata tidak cocok.`));
                return;
            }

            const ext = path.extname(parsed.pathname).replace(".", "").toLowerCase() || guessExtFromContentType(res.headers["content-type"], type);
            const filePath = path.join(CONFIG.tempDir, `tiktok_${Date.now()}_${index}.${ext}`);
            const stream = fs.createWriteStream(filePath);
            let total = 0;
            let settled = false;

            function fail(error) {
                if (settled) return;
                settled = true;
                stream.destroy();
                try {
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                } catch {}
                reject(error);
            }

            res.on("data", chunk => {
                total += chunk.length;
                if (total > CONFIG.maxMb * 1024 * 1024) {
                    fail(new Error(`File TikTok lebih dari batas ${CONFIG.maxMb} MB.`));
                    req.destroy();
                }
            });

            stream.on("error", fail);
            stream.on("finish", () => {
                if (settled) return;
                settled = true;
                resolve({ filePath, type: detectFileType(filePath) });
            });

            res.pipe(stream);
        });

        req.on("timeout", () => req.destroy(new Error("Timeout saat download file TikTok.")));
        req.on("error", reject);
    });
}

async function downloadTikTokViaApiData(data, mode) {
    const media = extractTikTokApiMedia(data);
    const downloaded = [];

    try {
        if (mode === "audio") {
            if (!media.audio) throw new Error("Audio TikTok tidak ditemukan.");
            downloaded.push(await downloadTikTokRemoteFile(media.audio, "audio", 1));
            return downloaded;
        }

        if (media.images.length > 0) {
            console.log("[LOCAL-DL TIKTOK]", {
                stage: "photo-slideshow-detected",
                images: media.images.length,
                hasAudio: Boolean(media.audio),
                hasVideo: Boolean(media.video),
            });

            const selectedImages = media.images.slice(0, CONFIG.maxFiles);
            for (let index = 0; index < selectedImages.length; index++) {
                downloaded.push(await downloadTikTokRemoteFile(selectedImages[index], "image", index + 1));
            }

            if (downloaded.length === 0) throw new Error("Foto TikTok tidak ditemukan.");
            return downloaded;
        }

        if (media.video) {
            downloaded.push(await downloadTikTokRemoteFile(media.video, "video", 1));
            return downloaded;
        }

        throw new Error("Media TikTok tidak ditemukan.");
    } catch (error) {
        cleanupFiles(downloaded);
        throw error;
    }
}

async function downloadTikTokViaApi(url, mode) {
    return downloadTikTokViaApiData(await fetchTikTokApi(url), mode);
}

async function downloadTikTok(url, mode) {
    let ytFiles = [];
    let ytError = null;
    let apiData = null;
    let apiProbeError = null;

    if (mode !== "audio") {
        try {
            apiData = await fetchTikTokApi(url);
            const apiMedia = extractTikTokApiMedia(apiData);
            if (apiMedia.images.length > 0) {
                return downloadTikTokViaApiData(apiData, mode);
            }

            console.log("[LOCAL-DL TIKTOK]", {
                stage: "fallback-to-ytdlp-video",
                reason: "api-images-empty",
            });
        } catch (error) {
            apiProbeError = error;
            console.log("[LOCAL-DL TIKTOK]", {
                stage: "fallback-to-ytdlp-video",
                reason: error.message,
            });
        }
    }

    try {
        ytFiles = await runYtDlp(url, mode);
        const hasVideo = ytFiles.some(file => file.type === "video");
        const hasImage = ytFiles.some(file => file.type === "image");
        const hasAudio = ytFiles.some(file => file.type === "audio");

        if (mode === "audio" && hasAudio) return ytFiles;
        if (mode !== "audio" && hasVideo) return ytFiles;

        if (mode !== "audio" && hasImage) {
            return ytFiles.filter(file => file.type !== "audio");
        }
    } catch (error) {
        ytError = error;
    }

    try {
        const apiFiles = apiData
            ? await downloadTikTokViaApiData(apiData, mode)
            : await downloadTikTokViaApi(url, mode);
        cleanupFiles(ytFiles);
        return apiFiles;
    } catch (apiError) {
        const usableYtFiles = mode === "audio"
            ? ytFiles.filter(file => file.type === "audio")
            : ytFiles.filter(file => file.type === "video" || file.type === "image");

        if (usableYtFiles.length > 0) return usableYtFiles;

        const fallbackError = apiProbeError?.message && !apiData
            ? `${apiProbeError.message}; ${apiError.message}`
            : apiError.message;
        throw new Error(`${ytError?.message || "yt-dlp gagal"}\nFallback TikTok API: ${fallbackError}`);
    }
}

function downloadByPlatform(url, mode, platform) {
    if (platform === "threads") return downloadThreads(url, mode);
    if (platform === "tiktok") return downloadTikTok(url, mode);
    return runYtDlp(url, mode);
}

function detectFileType(filePath) {
    const ext = path.extname(filePath).replace(".", "").toLowerCase();
    if (VIDEO_EXTENSIONS.has(ext)) return "video";
    if (IMAGE_EXTENSIONS.has(ext)) return "image";
    if (AUDIO_EXTENSIONS.has(ext)) return "audio";
    return "document";
}

function cleanupFiles(files) {
    for (const file of files) {
        try {
            if (file.filePath && fs.existsSync(file.filePath)) fs.unlinkSync(file.filePath);
        } catch (error) {
            console.log(`[LOCAL-DL] Gagal hapus file temp: ${error.message}`);
        }
    }
}

async function react(sock, jid, key, emoji) {
    try {
        if (!jid || !key) return;
        await sock.sendMessage(jid, {
            react: { text: emoji, key },
        });
    } catch (error) {
        console.log(`[LOCAL-DL] Gagal kirim reaction ${emoji}: ${error.message}`);
    }
}

async function sendDownloadedFiles(sock, jid, files, label, mode) {
    for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const fileName = path.basename(file.filePath);
        const counter = files.length > 1 ? ` (${index + 1}/${files.length})` : "";
        const caption = file.type === "image" && files.length > 1 && index > 0
            ? `✅ ${label} berhasil didownload${counter}`
            : `✅ ${label} berhasil didownload${counter}\n\n_Watermark: USERBOT FAHRI_`;

        if (mode === "audio" || file.type === "audio") {
            await sock.sendMessage(jid, {
                audio: { url: file.filePath },
                mimetype: "audio/mpeg",
                fileName,
            });
        } else if (file.type === "image") {
            await sock.sendMessage(jid, {
                image: { url: file.filePath },
                caption,
            });
        } else if (file.type === "video") {
            await sock.sendMessage(jid, {
                video: { url: file.filePath },
                caption,
                mimetype: "video/mp4",
            });
        } else {
            await sock.sendMessage(jid, {
                document: { url: file.filePath },
                mimetype: "application/octet-stream",
                fileName,
                caption,
            });
        }

        if (files.length > 1) await delay(1200);
    }
}

async function handleLocalDownload(sock, from, text, pushName, inputMessageKey) {
    if (String(from || "").toLowerCase().endsWith("@g.us")) return false;

    const sessionKey = makeSessionKey(from);
    const session = sessions.get(sessionKey);

    if (session) {
        const choice = text.trim();
        if (!["1", "2", "3"].includes(choice)) {
            await sock.sendMessage(from, { text: "Balas dengan *1* untuk media, *2* untuk audio, atau *3* untuk batal." });
            return true;
        }

        clearSession(from);
        const temporaryKeys = [];
        messageCleaner.rememberKey(temporaryKeys, session.menuMessageKey, from);
        const reactionKey = session.triggerMessageKey || inputMessageKey;

        if (choice === "3") {
            await react(sock, from, reactionKey, "🛑");
            await sock.sendMessage(from, { text: "Download dibatalkan." });
            await delay(700);
            await messageCleaner.deleteMany(sock, from, temporaryKeys, "pesan downloader");
            await messageCleaner.safeDelete(sock, from, inputMessageKey, "pesan pilihan download");
            return true;
        }

        const mode = choice === "2" ? "audio" : "media";
        const label = platformLabel(session.platform);
        let files = [];

        try {
            await react(sock, from, reactionKey, "⏳");
            files = await downloadByPlatform(session.url, mode, session.platform);
            await sendDownloadedFiles(sock, from, files, label, mode);
            await react(sock, from, reactionKey, "✅");
            await delay(700);
            await messageCleaner.deleteMany(sock, from, temporaryKeys, "pesan downloader");
            await messageCleaner.safeDelete(sock, from, inputMessageKey, "pesan pilihan download");
        } catch (error) {
            await react(sock, from, reactionKey, "❌");
            await messageCleaner.deleteMany(sock, from, temporaryKeys, "pesan downloader");
            const hint = session.platform === "threads"
                ? "Pastikan link Threads publik. Kalau hanya preview yang tersedia, bot akan ambil media dari metadata publik Threads."
                : session.platform === "tiktok"
                    ? "Video TikTok diproses dengan yt-dlp lama. Untuk foto/slideshow, bot memakai fallback TikTok API. Pastikan link publik dan yt-dlp terbaru."
                    : `Pastikan link publik, yt-dlp terbaru, dan untuk Instagram private gunakan file cookies di:\n${CONFIG.cookiesPath}`;
            await sock.sendMessage(from, {
                text:
                    `❌ Gagal download ${label}.\n\n` +
                    `${error.message}\n\n` +
                    hint,
            });
            await delay(700);
            await messageCleaner.safeDelete(sock, from, inputMessageKey, "pesan pilihan download");
        } finally {
            cleanupFiles(files);
        }

        return true;
    }

    const platform = detectPlatform(text);
    const url = extractUrl(text);
    if (!platform || !url) return false;

    const label = platformLabel(platform);
    const normalizedUrl = normalizeDownloadUrl(url, platform);
    const menuText =
        `🌐 *Link ${label} terdeteksi!*\n\n` +
        `Pilih format download:\n\n` +
        `*1* — Media utama\n` +
        `*2* — Audio MP3${platform === "threads" ? " (jika video)" : ""}\n` +
        `*3* — Batal\n\n` +
        `_${platform === "threads" ? "Diproses dari metadata publik Threads" : "Diproses lokal dengan yt-dlp"}. Watermark: USERBOT FAHRI_`;

    const menuMsg = await sock.sendMessage(from, { text: menuText });
    if (!menuMsg?.key?.id) {
        console.log("[LOCAL DOWNLOADER] Menu terkirim, tapi Baileys tidak mengembalikan key pesan.", {
            from,
            platform,
        });
        return true;
    }

    rememberSession(from, { url: normalizedUrl, platform, menuMessageKey: menuMsg.key, triggerMessageKey: inputMessageKey });
    return true;
}

module.exports = {
    handleLocalDownload,
    detectPlatform,
    extractUrl,
    normalizeDownloadUrl,
    extractThreadsMedia,
    downloadThreads,
    MEDIA_DIR: CONFIG.tempDir,
    getMediaDirs: () => [CONFIG.tempDir],
};
