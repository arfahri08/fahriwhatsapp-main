const axios = require("axios");
const { sendImageAlbum } = require("./mediaAlbum");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const API_TIMEOUT_MS = 30000;
const SEND_DELAY_MS = 900;
const MAX_IMAGE_SEND = 15;
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const YTDLP_TEMP_DIR = process.env.DOWNLOADER_TEMP_DIR || path.join(os.tmpdir(), "userbot-downloads");
const PINTEREST_HOST = "https://id.pinterest.com";
const PINTEREST_PIN_REGEX = /^(?:https?:\/\/(?:www\.|\w+\.)?pinterest\.[a-z.]+\/pin\/(\d{5,30})\/?|https?:\/\/(?:www\.)?pin\.it\/([a-zA-Z0-9]+)\/?|(\d{5,30}))$/i;
const PINTEREST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    Referer: `${PINTEREST_HOST}/`,
};

const PLATFORM_PATTERNS = [
    {
        id: "pinterest",
        name: "Pinterest",
        test: /(pinterest\.com|pin\.it)/i,
    },
    {
        id: "soundcloud",
        name: "SoundCloud",
        test: /(soundcloud\.com)/i,
    },
];

const API_CANDIDATES = {
    tiktok: [
        url => ({
            method: "GET",
            url: `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`,
        }),
    ],
    pinterest: [
        url => ({
            method: "GET",
            url: `https://api.agatz.xyz/api/pinterest?url=${encodeURIComponent(url)}`,
        }),
        url => ({
            method: "GET",
            url: `https://api.vreden.my.id/api/pindl?url=${encodeURIComponent(url)}`,
        }),
        url => ({
            method: "GET",
            url: `https://api.ryzendesu.vip/api/downloader/pinterest?url=${encodeURIComponent(url)}`,
        }),
    ],
    facebook: [
        url => ({
            method: "GET",
            url: `https://api.priyodown.com/v1/info?url=${encodeURIComponent(url)}`,
        }),
        url => ({
            method: "GET",
            url: `https://api.agatz.xyz/api/facebook?url=${encodeURIComponent(url)}`,
        }),
        url => ({
            method: "GET",
            url: `https://api.vreden.my.id/api/fbdl?url=${encodeURIComponent(url)}`,
        }),
        url => ({
            method: "GET",
            url: `https://api.ryzendesu.vip/api/downloader/fbdown?url=${encodeURIComponent(url)}`,
        }),
    ],
    instagram: [
        url => ({
            method: "GET",
            url: `https://api.vreden.my.id/api/v1/download/instagram?url=${encodeURIComponent(url)}`,
        }),
        url => ({
            method: "GET",
            url: `https://api.agatz.xyz/api/instagram?url=${encodeURIComponent(url)}`,
        }),
        url => ({
            method: "GET",
            url: `https://api.ryzendesu.vip/api/downloader/igdl?url=${encodeURIComponent(url)}`,
        }),
    ],
    soundcloud: [
        url => ({
            method: "GET",
            url: `https://api.agatz.xyz/api/soundcloud?url=${encodeURIComponent(url)}`,
        }),
        url => ({
            method: "GET",
            url: `https://api.vreden.my.id/api/soundcloud?url=${encodeURIComponent(url)}`,
        }),
        url => ({
            method: "GET",
            url: `https://api.ryzendesu.vip/api/downloader/soundcloud?url=${encodeURIComponent(url)}`,
        }),
    ],
};

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function runLocalYtDlp(url) {
    fs.mkdirSync(YTDLP_TEMP_DIR, { recursive: true });
    return new Promise((resolve, reject) => {
        const output = path.join(YTDLP_TEMP_DIR, `extended_%(extractor)s_%(id)s_%(epoch)s.%(ext)s`);
        const child = spawn(YTDLP_BIN, [
            "--no-warnings", "--no-progress", "--no-playlist", "--socket-timeout", "20",
            "--retries", "2", "--fragment-retries", "2", "--max-filesize", "95M",
            "--print", "after_move:filepath", "-o", output, url,
        ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk.toString(); });
        child.stderr.on("data", chunk => { stderr += chunk.toString(); });
        child.on("error", error => reject(error.code === "ENOENT" ? new Error("yt-dlp belum terpasang") : error));
        child.on("close", code => {
            const files = [...new Set(stdout.split(/\r?\n/).map(item => item.trim()).filter(item => item && fs.existsSync(item)))];
            if (code !== 0 || !files.length) {
                reject(new Error((stderr || `yt-dlp keluar dengan kode ${code}`).trim().slice(-500)));
                return;
            }
            resolve(files.slice(0, MAX_IMAGE_SEND).map(filePath => ({
                filePath,
                type: /\.(?:jpg|jpeg|png|webp|heic|heif)$/i.test(filePath) ? "image" : /\.(?:mp4|mov|webm|mkv)$/i.test(filePath) ? "video" : "audio",
            })));
        });
    });
}

function cleanupLocalFiles(files = []) {
    for (const item of files) {
        try { if (item?.filePath && fs.existsSync(item.filePath)) fs.unlinkSync(item.filePath); } catch {}
    }
}

function unwrapMessage(message) {
    let current = message || {};

    for (let i = 0; i < 6; i += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
        else if (current.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message;
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
        else break;
    }

    return current;
}

function getIncomingText(msg) {
    const message = unwrapMessage(msg?.message || {});
    return String(
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        ""
    ).trim();
}

function getSenderJid(msg) {
    if (msg?.key?.remoteJid?.endsWith("@g.us")) return msg.key.participant || msg.key.remoteJid;
    return msg?.key?.remoteJid;
}

function getJidNumber(jid) {
    return String(jid || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
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
    const url = extractFirstUrl(text);
    if (url && isSpotifyUrl(url)) return null;

    return PLATFORM_PATTERNS.find(platform => platform.test.test(text));
}

function extractFirstUrl(text) {
    const match = String(text || "").match(/https?:\/\/[^\s<>"']+/i);
    if (!match) return null;

    return match[0].replace(/[),.?!]+$/g, "");
}

function getTraceId() {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
        .toString(16)
        .padStart(16, "0");
}

function parsePinterestPinUrl(value) {
    const clean = String(value || "").trim().replace(/[),.?!]+$/g, "");
    const match = PINTEREST_PIN_REGEX.exec(clean.split(/[?#]/)[0]);
    if (!match) return null;

    const format = match[1] ? "long" : match[2] ? "short" : "id";
    const id = match[format === "long" ? 1 : format === "short" ? 2 : 3];

    return {
        format,
        id,
        url: format === "id" ? `${PINTEREST_HOST}/pin/${id}/` : clean,
    };
}

function extractPinterestPinId(value) {
    const clean = String(value || "");
    return (
        clean.match(/pinterest\.[^/]+\/pin\/(\d{5,30})/i)?.[1] ||
        clean.match(/^(\d{5,30})$/)?.[1] ||
        null
    );
}

function getFinalResponseUrl(response) {
    return (
        response?.request?.res?.responseUrl ||
        response?.request?._redirectable?._currentUrl ||
        response?.config?.url ||
        null
    );
}

async function resolvePinterestPin(originalUrl) {
    const parsed = parsePinterestPinUrl(originalUrl);
    if (!parsed) throw new Error("URL Pinterest tidak valid.");

    if (parsed.format !== "short") {
        const id = extractPinterestPinId(parsed.url) || parsed.id;
        return { id, url: `${PINTEREST_HOST}/pin/${id}/` };
    }

    const response = await axios.get(parsed.url, {
        headers: PINTEREST_HEADERS,
        timeout: API_TIMEOUT_MS,
        maxRedirects: 8,
        validateStatus: status => status >= 200 && status < 500,
    });

    const finalUrl = getFinalResponseUrl(response);
    const id = extractPinterestPinId(finalUrl) || extractPinterestPinId(response.data);
    if (!id) throw new Error("Gagal resolve shortlink pin.it.");

    return { id, url: `${PINTEREST_HOST}/pin/${id}/` };
}

function normalizeMediaUrl(url) {
    const clean = String(url || "").trim();
    if (!clean) return null;
    if (clean.startsWith("//")) return `https:${clean}`;
    if (clean.startsWith("/")) return `https://www.tikwm.com${clean}`;
    if (/^https?:\/\//i.test(clean)) return clean;
    return null;
}

function isUrl(value) {
    return /^https?:\/\//i.test(String(value || "")) || String(value || "").startsWith("//") || String(value || "").startsWith("/");
}

function collectUrlEntries(value, path = [], output = []) {
    if (value == null) return output;

    if (typeof value === "string") {
        if (isUrl(value)) {
            const normalized = normalizeMediaUrl(value);
            if (normalized) output.push({ url: normalized, path: path.join(".").toLowerCase() });
        }
        return output;
    }

    if (Array.isArray(value)) {
        value.forEach((item, index) => collectUrlEntries(item, [...path, String(index)], output));
        return output;
    }

    if (typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            collectUrlEntries(item, [...path, key], output);
        }
    }

    return output;
}

function uniqueUrls(entries) {
    const seen = new Set();
    return entries.filter(entry => {
        if (!entry.url || seen.has(entry.url)) return false;
        seen.add(entry.url);
        return true;
    });
}

function hasExt(url, extensions) {
    const clean = String(url || "").split("?")[0].toLowerCase();
    return extensions.some(ext => clean.endsWith(ext) || clean.includes(`${ext}/`) || clean.includes(`${ext}.`));
}

function isProbablyPageUrl(url) {
    const clean = String(url || "").toLowerCase();
    if (/\.(mp4|mov|m3u8|jpg|jpeg|png|webp|mp3|m4a|aac|wav|ogg)(?:[/?#.]|$)/i.test(clean)) return false;

    return (
        clean.includes("tiktok.com/@") ||
        clean.includes("vt.tiktok.com") ||
        clean.includes("facebook.com/") ||
        clean.includes("fb.watch") ||
        clean.includes("instagram.com/") ||
        clean.includes("instagr.am/") ||
        clean.includes("pinterest.com/pin") ||
        clean.includes("pin.it/") ||
        clean.includes("soundcloud.com/")
    );
}

function scoreEntry(entry, positiveKeywords = [], negativeKeywords = []) {
    const path = entry.path || "";
    const url = entry.url.toLowerCase();
    let score = 0;

    for (const keyword of positiveKeywords) {
        if (path.includes(keyword) || url.includes(keyword)) score += 3;
    }
    for (const keyword of negativeKeywords) {
        if (path.includes(keyword) || url.includes(keyword)) score -= 4;
    }

    if (url.includes("watermark")) score -= 4;
    if (path.includes("wmplay")) score -= 5;
    if (path.includes("no_watermark") || path.includes("nowm") || path.includes("nwm")) score += 5;
    if (path.includes("hd") || path.includes("high")) score += 4;
    if (path.includes("download")) score += 3;

    return score;
}

function pickBest(entries, type) {
    const typeConfig = {
        video: {
            exts: [".mp4", ".mov", ".m3u8"],
            positive: ["video", "play", "hd", "sd", "download", "nowm", "nwm", "no_watermark", "url"],
            negative: ["cover", "thumbnail", "thumb", "avatar", "image", "music", "audio"],
        },
        image: {
            exts: [".jpg", ".jpeg", ".png", ".webp"],
            positive: ["image", "images", "photo", "picture", "media", "url", "download"],
            negative: ["avatar", "profile", "thumb", "thumbnail", "cover"],
        },
        audio: {
            exts: [".mp3", ".m4a", ".aac", ".wav", ".ogg"],
            positive: ["audio", "music", "mp3", "sound", "download", "play", "url"],
            negative: ["cover", "thumbnail", "thumb", "avatar", "image"],
        },
    }[type];

    let candidates = entries.filter(entry => hasExt(entry.url, typeConfig.exts));
    if (candidates.length === 0) {
        candidates = entries
            .filter(entry => !isProbablyPageUrl(entry.url))
            .filter(entry => scoreEntry(entry, typeConfig.positive, typeConfig.negative) > 1);
    }
    if (candidates.length === 0) return null;

    return candidates
        .sort((a, b) => scoreEntry(b, typeConfig.positive, typeConfig.negative) - scoreEntry(a, typeConfig.positive, typeConfig.negative))[0]?.url || null;
}

function pickImages(entries) {
    const imageEntries = uniqueUrls(entries)
        .filter(entry => hasExt(entry.url, [".jpg", ".jpeg", ".png", ".webp"]))
        .filter(entry => scoreEntry(entry, ["image", "images", "photo", "picture", "media"], ["avatar", "profile", "thumbnail", "thumb"]) >= -2);

    return imageEntries.map(entry => entry.url).slice(0, MAX_IMAGE_SEND);
}

function extractJsonObjectAt(text, startIndex) {
    const objectStart = text.indexOf("{", startIndex);
    if (objectStart < 0) return null;

    let depth = 0;
    let inString = false;
    let quote = "";
    let escaped = false;

    for (let i = objectStart; i < text.length; i += 1) {
        const char = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === quote) {
                inString = false;
                quote = "";
            }
            continue;
        }

        if (char === "\"" || char === "'") {
            inString = true;
            quote = char;
            continue;
        }

        if (char === "{") depth += 1;
        if (char === "}") {
            depth -= 1;
            if (depth === 0) return text.slice(objectStart, i + 1);
        }
    }

    return null;
}

function parseJsonSafe(value) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function extractPinterestRelayPayloads(html) {
    const marker = "window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__(";
    const payloads = [];
    let cursor = 0;

    while (cursor < html.length) {
        const markerIndex = html.indexOf(marker, cursor);
        if (markerIndex < 0) break;

        const jsonText = extractJsonObjectAt(html, markerIndex + marker.length);
        const payload = jsonText ? parseJsonSafe(jsonText) : null;
        if (payload) payloads.push(payload);

        cursor = markerIndex + marker.length;
    }

    return payloads;
}

function extractPinterestInitialProps(html) {
    const match = html.match(/<script[^>]+id=["']__PWS_INITIAL_PROPS__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match) return null;

    return parseJsonSafe(match[1].replace(/&quot;/g, "\"").replace(/&amp;/g, "&"));
}

function addPinterestEntry(entries, url, path) {
    const normalized = normalizeMediaUrl(url);
    if (!normalized) return;
    if (!/\.(?:jpg|jpeg|png|webp|mp4|mov|m3u8)(?:[/?#.]|$)/i.test(normalized)) return;

    entries.push({ url: normalized, path: `pinterest.${path}`.toLowerCase() });
}

function collectPinterestPreferredEntries(value, entries = [], path = []) {
    if (!value || typeof value !== "object") return entries;

    if (value.imageLargeUrl) addPinterestEntry(entries, value.imageLargeUrl, [...path, "imageLargeUrl"].join("."));
    if (value.thumbnail) addPinterestEntry(entries, value.thumbnail, [...path, "thumbnail"].join("."));
    if (value.url) addPinterestEntry(entries, value.url, [...path, "url"].join("."));

    const imageVariants = value.images || value.image || null;
    if (imageVariants && typeof imageVariants === "object") {
        for (const [key, image] of Object.entries(imageVariants)) {
            if (image?.url) addPinterestEntry(entries, image.url, [...path, "images", key, "url"].join("."));
        }
    }

    const videoData = value.storyPinData?.pages?.[0]?.blocks?.[0]?.videoDataV2;
    if (videoData?.videoList720P?.v720P?.url) {
        addPinterestEntry(entries, videoData.videoList720P.v720P.url, [...path, "storyPinData", "videoList720P", "v720P", "url"].join("."));
    }

    const videoList = value.videos?.video_list || value.video?.video_list || value.video_list || null;
    if (videoList && typeof videoList === "object") {
        for (const [key, video] of Object.entries(videoList)) {
            if (video?.url) addPinterestEntry(entries, video.url, [...path, "video_list", key, "url"].join("."));
            if (video?.thumbnail) addPinterestEntry(entries, video.thumbnail, [...path, "video_list", key, "thumbnail"].join("."));
        }
    }

    if (Array.isArray(value)) {
        value.forEach((item, index) => collectPinterestPreferredEntries(item, entries, [...path, String(index)]));
        return entries;
    }

    for (const [key, item] of Object.entries(value)) {
        if (item && typeof item === "object") collectPinterestPreferredEntries(item, entries, [...path, key]);
    }

    return entries;
}

function getPinterestPayloadRoots(payloads) {
    const roots = [];

    for (const payload of payloads) {
        if (payload?.data && typeof payload.data === "object") {
            for (const item of Object.values(payload.data)) {
                roots.push(item?.data || item);
            }
        } else {
            roots.push(payload);
        }
    }

    return roots.filter(Boolean);
}

function scorePinterestEntry(entry, type) {
    const path = entry.path || "";
    const url = entry.url.toLowerCase();
    let score = scoreEntry(
        entry,
        type === "video"
            ? ["video", "videolist720p", "v720p", "storypindata", "url", "download"]
            : ["imagelargeurl", "images.orig", "originals", "image", "images", "url"],
        ["avatar", "avatars", "profile", "pinner", "creator", "thumbnail"]
    );

    if (url.includes("v.pinimg.com/videos")) score += type === "video" ? 12 : -2;
    if (url.includes("i.pinimg.com/originals")) score += type === "image" ? 12 : -2;
    if (url.includes("/736x/")) score += type === "image" ? 7 : -1;
    if (url.includes("/564x/")) score += type === "image" ? 4 : -1;
    if (url.includes("/236x/") || url.includes("/170x/") || url.includes("/75x75/")) score -= 8;
    if (path.includes("imagelargeurl")) score += type === "image" ? 12 : -2;
    if (path.includes("videolist720p") || path.includes("v720p")) score += type === "video" ? 12 : -2;
    if (path.includes("thumbnail")) score -= type === "video" ? 3 : 7;
    if (url.includes(".m3u8")) score -= 8;

    return score;
}

function pickPinterestVideo(entries) {
    const candidates = uniqueUrls(entries)
        .filter(entry => hasExt(entry.url, [".mp4", ".mov"]))
        .filter(entry => scorePinterestEntry(entry, "video") > 0);

    return candidates
        .sort((a, b) => scorePinterestEntry(b, "video") - scorePinterestEntry(a, "video"))[0]?.url || null;
}

function pickPinterestImage(entries) {
    const candidates = uniqueUrls(entries)
        .filter(entry => hasExt(entry.url, [".jpg", ".jpeg", ".png", ".webp"]))
        .filter(entry => scorePinterestEntry(entry, "image") > 0);

    return candidates
        .sort((a, b) => scorePinterestEntry(b, "image") - scorePinterestEntry(a, "image"))[0]?.url || null;
}

function pickPinterestImages(entries) {
    return uniqueUrls(entries)
        .filter(entry => hasExt(entry.url, [".jpg", ".jpeg", ".png", ".webp"]))
        .filter(entry => scorePinterestEntry(entry, "image") > 0)
        .sort((a, b) => scorePinterestEntry(b, "image") - scorePinterestEntry(a, "image"))
        .map(entry => entry.url)
        .slice(0, MAX_IMAGE_SEND);
}

function hasPinterestDownloadableEntries(entries) {
    return Boolean(pickPinterestVideo(entries) || pickPinterestImage(entries));
}

async function scrapePinterestMedia(originalUrl) {
    const pin = await resolvePinterestPin(originalUrl);
    const response = await axios.get(pin.url, {
        headers: {
            ...PINTEREST_HEADERS,
            "x-b3-traceid": getTraceId(),
            "x-b3-spanid": getTraceId(),
            "x-pinterest-source-url": `/pin/${pin.id}/`,
        },
        timeout: API_TIMEOUT_MS,
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 500,
    });

    if (response.status >= 400) throw new Error(`Pinterest HTTP ${response.status}`);

    const html = String(response.data || "");
    const payloads = extractPinterestRelayPayloads(html);
    const initialProps = extractPinterestInitialProps(html);
    const roots = [
        ...getPinterestPayloadRoots(payloads),
        initialProps,
    ].filter(Boolean);

    const preferredEntries = collectPinterestPreferredEntries(roots);
    const broadEntries = uniqueUrls(collectUrlEntries(roots))
        .filter(entry => /\.(?:jpg|jpeg|png|webp|mp4|mov|m3u8)(?:[/?#.]|$)/i.test(entry.url));
    const htmlFallbackEntries = (html.match(/https?:\\?\/\\?\/[^"'\\\s<>]+/g) || [])
        .map(url => normalizeMediaUrl(url.replace(/\\u002F/g, "/").replace(/\\\//g, "/")))
        .filter(url => url && /\.(?:jpg|jpeg|png|webp|mp4|mov|m3u8)(?:[/?#.]|$)/i.test(url))
        .map((url, index) => ({ url, path: `pinterest.html.${index}` }));

    const entries = uniqueUrls([...preferredEntries, ...broadEntries, ...htmlFallbackEntries]);
    if (!hasPinterestDownloadableEntries(entries)) {
        throw new Error(`Media Pinterest tidak ditemukan untuk pin ${pin.id}.`);
    }

    return {
        data: {
            source: "pinterest-local-scraper",
            pinId: pin.id,
            result: entries,
        },
        entries,
    };
}

async function requestApi(candidate, originalUrl) {
    const config = candidate(originalUrl);
    const response = await axios({
        method: config.method || "GET",
        url: config.url,
        data: config.data,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Accept: "application/json,text/plain,*/*",
            ...(config.headers || {}),
        },
        timeout: API_TIMEOUT_MS,
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 500,
    });

    if (response.status >= 400) {
        throw new Error(`API HTTP ${response.status}`);
    }

    return response.data;
}

async function callApiCandidates(platformId, originalUrl) {
    const candidates = API_CANDIDATES[platformId] || [];
    const errors = [];

    if (platformId === "pinterest") {
        try {
            return await scrapePinterestMedia(originalUrl);
        } catch (error) {
            errors.push(`scraper: ${error.message}`);
        }
    }

    for (const candidate of candidates) {
        try {
            const data = await requestApi(candidate, originalUrl);
            const entries = uniqueUrls(collectUrlEntries(data));
            if (platformId === "pinterest" && !hasPinterestDownloadableEntries(entries)) {
                errors.push("response tidak berisi media Pinterest");
                continue;
            }
            if (entries.length > 0) return { data, entries };
            errors.push("response kosong");
        } catch (error) {
            errors.push(error.message);
        }
    }

    throw new Error(errors.join(" | ") || "Semua API gagal.");
}

function normalizeTikTokResult(apiResult) {
    const data = apiResult.data?.data || apiResult.data?.result || apiResult.data || apiResult;
    const entries = apiResult.entries;
    const images = Array.isArray(data?.images)
        ? data.images.map(normalizeMediaUrl).filter(Boolean)
        : pickImages(entries);

    const video =
        normalizeMediaUrl(data?.hdplay) ||
        normalizeMediaUrl(data?.play) ||
        normalizeMediaUrl(data?.video?.noWatermark) ||
        normalizeMediaUrl(data?.video?.no_watermark) ||
        normalizeMediaUrl(data?.nowm) ||
        pickBest(entries, "video");

    const audio =
        normalizeMediaUrl(data?.music) ||
        normalizeMediaUrl(data?.music_info?.play) ||
        normalizeMediaUrl(data?.audio) ||
        pickBest(entries, "audio");

    return { video, images, audio };
}

function normalizeGenericResult(apiResult, platformId) {
    const entries = apiResult.entries;

    if (platformId === "pinterest") {
        return {
            video: pickPinterestVideo(entries),
            image: pickPinterestImage(entries),
            images: pickPinterestImages(entries),
            audio: null,
        };
    }

    if (platformId === "soundcloud") {
        return {
            audio: pickBest(entries, "audio") || pickBest(entries, "video"),
            image: pickBest(entries, "image"),
        };
    }

    return {
        video: pickBest(entries, "video"),
        image: pickBest(entries, "image"),
        images: pickImages(entries),
        audio: pickBest(entries, "audio"),
    };
}

function successCaption(platformName, senderJid) {
    return (
        "📥 *DOWNLOADER SUCCESS*\n\n" +
        `• *Platform:* ${platformName}\n` +
        `• *Requested By:* @${getJidNumber(senderJid)}\n\n` +
        "_Berhasil diunduh tanpa watermark!_"
    );
}

async function react(sock, msg, emoji) {
    try {
        await sock.sendMessage(msg.key.remoteJid, {
            react: { text: emoji, key: msg.key },
        });
    } catch {}
}

async function sendVideo(sock, jid, url, caption, mentions, quoted) {
    await sock.sendMessage(jid, {
        video: { url },
        caption,
        mimetype: "video/mp4",
        mentions,
    }, { quoted });
}

async function sendImage(sock, jid, url, caption, mentions, quoted) {
    await sock.sendMessage(jid, {
        image: { url },
        caption,
        mentions,
    }, { quoted });
}

async function sendAudio(sock, jid, url, quoted, asDocument = false) {
    if (asDocument) {
        await sock.sendMessage(jid, {
            document: { url },
            mimetype: "audio/mpeg",
            fileName: `soundcloud_${Date.now()}.mp3`,
        }, { quoted });
        return;
    }

    await sock.sendMessage(jid, {
        audio: { url },
        mimetype: "audio/mpeg",
        ptt: false,
    }, { quoted });
}

async function sendTikTokResult(sock, msg, result, platform, senderJid) {
    const jid = msg.key.remoteJid;
    const caption = successCaption(platform.name, senderJid);
    const mentions = [senderJid].filter(Boolean);

    if (result.images?.length) {
        if (result.images.length > 1) {
            await sendImageAlbum(sock, jid, result.images, { caption, mentions, quoted: msg });
        } else {
            await sendImage(sock, jid, result.images[0], caption, mentions, msg);
        }

        if (result.audio) {
            await delay(SEND_DELAY_MS);
            await sendAudio(sock, jid, result.audio, msg);
        }
        return true;
    }

    if (result.video) {
        await sendVideo(sock, jid, result.video, caption, mentions, msg);
        return true;
    }

    if (result.audio) {
        await sendAudio(sock, jid, result.audio, msg);
        return true;
    }

    return false;
}

async function sendGenericResult(sock, msg, result, platform, senderJid) {
    const jid = msg.key.remoteJid;
    const caption = successCaption(platform.name, senderJid);
    const mentions = [senderJid].filter(Boolean);

    if (platform.id === "soundcloud") {
        if (result.audio) {
            try {
                await sendAudio(sock, jid, result.audio, msg);
            } catch {
                await sendAudio(sock, jid, result.audio, msg, true);
            }
            return true;
        }
        return false;
    }

    if (result.video) {
        await sendVideo(sock, jid, result.video, caption, mentions, msg);
        return true;
    }

    if (result.image) {
        await sendImage(sock, jid, result.image, caption, mentions, msg);
        return true;
    }

    if (result.images?.length) {
        if (result.images.length > 1) {
            await sendImageAlbum(sock, jid, result.images, { caption, mentions, quoted: msg });
        } else {
            await sendImage(sock, jid, result.images[0], caption, mentions, msg);
        }
        return true;
    }

    return false;
}

async function handleExtendedDownload(msg, sock) {
    const from = msg?.key?.remoteJid;
    if (!from || from === "status@broadcast" || !msg?.message) return false;
    if (String(from).toLowerCase().endsWith("@g.us")) return false;

    const text = getIncomingText(msg);
    if (!text) return false;

    const platform = detectPlatform(text);
    if (!platform) return false;

    const url = extractFirstUrl(text);
    if (!url) return false;

    const senderJid = getSenderJid(msg);

    try {
        await react(sock, msg, "⏳");

        let apiResult;
        let localFiles = [];
        try {
            apiResult = await callApiCandidates(platform.id, url);
        } catch (apiError) {
            if (!["instagram", "facebook"].includes(platform.id)) throw apiError;
            console.log(`[EXTENDED DOWNLOADER] ${platform.name} API fallback ke yt-dlp lokal`, { error: String(apiError.message || apiError).slice(0, 240) });
            localFiles = await runLocalYtDlp(url);
        }
        if (localFiles.length) {
            const localResult = {
                video: localFiles.find(item => item.type === "video")?.filePath || null,
                image: localFiles.filter(item => item.type === "image").length === 1
                    ? localFiles.find(item => item.type === "image")?.filePath || null
                    : null,
                images: localFiles.filter(item => item.type === "image").map(item => item.filePath),
                audio: localFiles.find(item => item.type === "audio")?.filePath || null,
            };
            const sent = await sendGenericResult(sock, msg, localResult, platform, senderJid);
            cleanupLocalFiles(localFiles);
            if (!sent) throw new Error("yt-dlp tidak menemukan media yang dapat dikirim.");
            await react(sock, msg, "✅");
            return true;
        }
        const normalized = platform.id === "tiktok"
            ? normalizeTikTokResult(apiResult)
            : normalizeGenericResult(apiResult, platform.id);

        const sent = platform.id === "tiktok"
            ? await sendTikTokResult(sock, msg, normalized, platform, senderJid)
            : await sendGenericResult(sock, msg, normalized, platform, senderJid);

        if (!sent) throw new Error("Media URL tidak ditemukan dari response API.");

        await react(sock, msg, "✅");
        return true;
    } catch (error) {
        console.log(`[EXTENDED DOWNLOADER] ${platform.name} gagal`, {
            url: url.slice(0, 180),
            error: String(error?.message || error).slice(0, 500),
        });
        await react(sock, msg, "❌");

        try {
            await sock.sendMessage(from, {
                text: `❌ Gagal mengunduh ${platform.name}. Link mungkin privat, sudah dihapus, atau semua sumber downloader sedang gagal. Coba kirim ulang beberapa saat lagi.`,
            }, { quoted: msg });
        } catch (sendError) {
            console.log(`[EXTENDED DOWNLOADER] Gagal kirim error: ${sendError.message}`);
        }

        return true;
    }
}

module.exports = {
    handleExtendedDownload,
};
