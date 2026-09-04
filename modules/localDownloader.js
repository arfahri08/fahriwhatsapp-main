const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { delay } = require("./delay");
const messageCleaner = require("./messageCleaner");
const { sendImageAlbum } = require("./mediaAlbum");

const sessions = new Map();

const CONFIG = {
    ytdlpBin: process.env.YTDLP_BIN || "yt-dlp",
    tempDir: process.env.DOWNLOADER_TEMP_DIR || path.join(os.tmpdir(), "userbot-downloads"),
    maxFiles: Number(process.env.DOWNLOADER_MAX_FILES || 10),
    maxMb: Number(process.env.DOWNLOADER_MAX_MB || 95),
    sessionTtlMs: 2 * 60 * 1000,
    cookiesPath: process.env.YTDLP_COOKIES || path.join(__dirname, "cookies.txt"),
};

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif"]);
const WHATSAPP_VIEWABLE_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
const THREADS_BROWSER_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
];
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "opus", "ogg", "wav"]);
const THREADS_CRAWLER_USER_AGENTS = [
    "facebookexternalhit/1.1",
    "Twitterbot/1.0",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];
const THREADS_PAGE_USER_AGENTS = [...THREADS_BROWSER_USER_AGENTS, ...THREADS_CRAWLER_USER_AGENTS];
const THREADS_VREDEN_ENDPOINT = "https://api.vreden.my.id/api/v1/download/threads?slof=1";

if (!fs.existsSync(CONFIG.tempDir)) fs.mkdirSync(CONFIG.tempDir, { recursive: true });

function extractUrls(text) {
    const matches = String(text || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
    return matches
        .map(url => url.replace(/[)>.,;!?]+$/g, ""))
        .filter(Boolean);
}

function isTikTokHostname(hostname) {
    const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    return host === "tiktok.com" || host.endsWith(".tiktok.com");
}

function decodeNestedUrl(value) {
    let current = String(value || "").trim();

    for (let attempt = 0; attempt < 5 && current; attempt += 1) {
        try {
            const parsed = new URL(current);
            if (/^https?:$/.test(parsed.protocol)) return parsed.toString();
            return null;
        } catch {}

        try {
            const decoded = decodeURIComponent(current);
            if (decoded === current) break;
            current = decoded;
        } catch {
            break;
        }
    }

    return null;
}

function unwrapTikTokRedirectUrl(url) {
    const original = String(url || "").trim();
    let current = original;

    for (let attempt = 0; attempt < 5; attempt += 1) {
        let parsed;
        try {
            parsed = new URL(current);
        } catch {
            return original;
        }

        if (!isTikTokHostname(parsed.hostname) || !/^\/login\/?$/i.test(parsed.pathname)) {
            return parsed.toString();
        }

        const redirectValue = ["redirect_url", "redirect", "target", "url"]
            .map(key => parsed.searchParams.get(key))
            .find(Boolean);
        const decoded = decodeNestedUrl(redirectValue);
        if (!decoded) return original;

        let redirect;
        try {
            redirect = new URL(decoded);
        } catch {
            return original;
        }

        // Jangan membuka redirect ke domain lain dari parameter URL yang dikirim pengguna.
        if (!isTikTokHostname(redirect.hostname)) return original;
        if (redirect.toString() === current) return current;
        current = redirect.toString();
    }

    return current;
}

function getUnsupportedTikTokPageKind(url) {
    try {
        const parsed = new URL(unwrapTikTokRedirectUrl(url));
        if (!isTikTokHostname(parsed.hostname)) return null;
        if (/^\/minis(?:\/|$)/i.test(parsed.pathname)) return "minis";
        if (/^\/login(?:\/|$)/i.test(parsed.pathname)) return "login";
        return null;
    } catch {
        return null;
    }
}

function isLikelyTikTokMediaUrl(url) {
    try {
        const parsed = new URL(unwrapTikTokRedirectUrl(url));
        const host = parsed.hostname.toLowerCase();
        if (host === "vm.tiktok.com" || host === "vt.tiktok.com") return true;
        if (!isTikTokHostname(host)) return false;
        return (
            /^\/@[^/]+\/(?:video|photo)\/\d+/i.test(parsed.pathname) ||
            /^\/(?:t|video|photo)\//i.test(parsed.pathname)
        );
    } catch {
        return false;
    }
}

function extractUrl(text) {
    const urls = extractUrls(text);
    if (urls.length === 0) return null;

    const firstNormalized = unwrapTikTokRedirectUrl(urls[0]);
    if (getUnsupportedTikTokPageKind(firstNormalized)) {
        const mediaUrl = urls
            .map(unwrapTikTokRedirectUrl)
            .find(isLikelyTikTokMediaUrl);
        if (mediaUrl) return mediaUrl;
    }

    return urls[0];
}

function extractQuotedText(message) {
    let current = message || {};
    for (let attempt = 0; attempt < 8 && current; attempt += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
        else break;
    }

    return String(
        current?.conversation ||
        current?.extendedTextMessage?.text ||
        current?.imageMessage?.caption ||
        current?.videoMessage?.caption ||
        current?.documentMessage?.caption ||
        ""
    ).trim();
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
    if (/facebook\.com|fb\.watch|fb\.com/i.test(url)) return "facebook";
    if (/threads\.(net|com)/i.test(url)) return "threads";
    if (/youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(url)) return "youtube";
    return null;
}

function platformLabel(platform) {
    if (platform === "tiktok") return "TikTok";
    if (platform === "threads") return "Threads";
    if (platform === "youtube") return "YouTube";
    if (platform === "facebook") return "Facebook";
    return "Instagram";
}

function normalizeDownloadUrl(url, platform) {
    if (platform === "tiktok") return unwrapTikTokRedirectUrl(url);
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

function fetchThreadsPage(url, headers = {}, redirects = 0) {
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
                fetchThreadsPage(new URL(location, parsed).toString(), headers, redirects + 1).then(resolve).catch(reject);
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
            res.on("end", () => resolve({
                html: Buffer.concat(chunks).toString("utf8"),
                finalUrl: parsed.toString(),
            }));
        });

        req.on("timeout", () => req.destroy(new Error("Timeout saat membuka Threads.")));
        req.on("error", reject);
    });
}

function fetchJson(url, headers = {}, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) {
            reject(new Error("Redirect API Threads terlalu banyak."));
            return;
        }

        const parsed = new URL(url);
        const client = parsed.protocol === "http:" ? http : https;
        const req = client.get(parsed, {
            headers: {
                accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
                "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
                "user-agent": THREADS_BROWSER_USER_AGENTS[0],
                ...headers,
            },
            timeout: 20000,
        }, res => {
            const location = res.headers.location;
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && location) {
                res.resume();
                fetchJson(new URL(location, parsed).toString(), headers, redirects + 1).then(resolve).catch(reject);
                return;
            }

            if (res.statusCode >= 400) {
                res.resume();
                reject(new Error(`API Threads membalas HTTP ${res.statusCode}.`));
                return;
            }

            const chunks = [];
            let total = 0;
            res.on("data", chunk => {
                total += chunk.length;
                if (total > 12 * 1024 * 1024) {
                    req.destroy(new Error("Response API Threads terlalu besar."));
                    return;
                }
                chunks.push(chunk);
            });
            res.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                try {
                    resolve(JSON.parse(body));
                } catch {
                    reject(new Error("API Threads tidak mengembalikan JSON valid."));
                }
            });
        });

        req.on("timeout", () => req.destroy(new Error("Timeout saat membuka API Threads.")));
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
    const cleanUrl = String(url || "").split("?")[0].toLowerCase();
    if (/\.(mp4|mov|m4v|webm)$/.test(cleanUrl)) return "video";
    if (/\.(jpg|jpeg|png|webp|heic|heif)$/.test(cleanUrl)) return "image";
    return null;
}

function normalizeThreadsMediaUrl(url) {
    return decodeHtml(String(url || ""))
        .replace(/\\u0026/gi, "&")
        .replace(/\\u003d/gi, "=")
        .replace(/\\u002f/gi, "/")
        .trim();
}

function uniqueMedia(media) {
    const seen = new Set();
    return media.filter(item => {
        const url = normalizeThreadsMediaUrl(item?.url);
        if (!url) return false;
        const key = `${item.type || "unknown"}:${url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        item.url = url;
        return true;
    });
}

function extractThreadsPostCode(url) {
    try {
        const segments = new URL(url).pathname.split("/").filter(Boolean);
        const postIndex = segments.findIndex(segment => segment.toLowerCase() === "post");
        return postIndex >= 0 && segments[postIndex + 1] ? decodeURIComponent(segments[postIndex + 1]) : null;
    } catch {
        const match = String(url || "").match(/\/post\/([^/?#]+)/i);
        return match ? decodeURIComponent(match[1]) : null;
    }
}

function candidateScore(candidate) {
    const width = Number(candidate?.width || candidate?.original_width || 0);
    const height = Number(candidate?.height || candidate?.original_height || 0);
    const bandwidth = Number(candidate?.bandwidth || candidate?.bitrate || 0);
    return (width * height * 1000) + bandwidth;
}

function chooseBestThreadsImage(media) {
    const candidateGroups = [
        media?.image_versions2?.candidates,
        media?.image_versions?.candidates,
        media?.image_versions2,
    ];
    const candidates = candidateGroups
        .flatMap(group => Array.isArray(group) ? group : [])
        .filter(candidate => candidate && typeof candidate.url === "string")
        .sort((a, b) => candidateScore(b) - candidateScore(a));
    if (candidates.length === 0) return null;
    const best = candidates[0];
    return {
        url: normalizeThreadsMediaUrl(best.url),
        type: "image",
        width: Number(best.width || media?.original_width || 0) || null,
        height: Number(best.height || media?.original_height || 0) || null,
        mediaId: media?.id || media?.pk || null,
        source: "structured",
    };
}

function chooseBestThreadsVideo(media) {
    const candidateGroups = [
        media?.video_versions,
        media?.video_versions2?.candidates,
        media?.video_candidates,
    ];
    const candidates = candidateGroups
        .flatMap(group => Array.isArray(group) ? group : [])
        .filter(candidate => candidate && typeof candidate.url === "string")
        .sort((a, b) => candidateScore(b) - candidateScore(a));
    if (candidates.length === 0) return null;
    const best = candidates[0];
    return {
        url: normalizeThreadsMediaUrl(best.url),
        type: "video",
        width: Number(best.width || media?.original_width || 0) || null,
        height: Number(best.height || media?.original_height || 0) || null,
        mediaId: media?.id || media?.pk || null,
        source: "structured",
    };
}

function extractThreadsMediaItem(media) {
    if (!media || typeof media !== "object") return null;
    const video = chooseBestThreadsVideo(media);
    if (video) return video;
    return chooseBestThreadsImage(media);
}

function extractThreadsMediaSequence(post) {
    if (!post || typeof post !== "object") return [];
    const carousel = Array.isArray(post.carousel_media)
        ? post.carousel_media
        : Array.isArray(post.carouselMedia)
            ? post.carouselMedia
            : Array.isArray(post?.media?.carousel_media)
                ? post.media.carousel_media
                : null;

    if (carousel && carousel.length > 0) {
        return carousel.map(extractThreadsMediaItem).filter(Boolean);
    }

    const single = extractThreadsMediaItem(post);
    return single ? [single] : [];
}

function threadsUrlMatchesPostCode(value, postCode) {
    if (typeof value !== "string" || !postCode) return false;
    try {
        return extractThreadsPostCode(value) === postCode;
    } catch {
        return String(value).includes(`/post/${postCode}`);
    }
}

function objectMatchesThreadsPostCode(object, postCode) {
    if (!object || typeof object !== "object" || !postCode) return false;
    const directCodes = [object.code, object.shortcode, object.media_code, object.post_code]
        .filter(value => typeof value === "string");
    if (directCodes.some(value => value === postCode)) return true;

    // IMPORTANT: share_url and a generic url are NOT identity proof for an original
    // Threads media record. Threads social/share-card wrappers also point to the same
    // /post/<code> URL and were the reason a 1200x628 composite card was selected.
    const strictPermalinks = [object.permalink, object.canonical_url, object.post_url]
        .filter(value => typeof value === "string");
    return strictPermalinks.some(value => threadsUrlMatchesPostCode(value, postCode));
}

function objectReferencesThreadsPostCode(object, postCode) {
    if (!object || typeof object !== "object" || !postCode) return false;
    if (objectMatchesThreadsPostCode(object, postCode)) return true;
    const contextualLinks = [object.share_url, object.url]
        .filter(value => typeof value === "string");
    return contextualLinks.some(value => threadsUrlMatchesPostCode(value, postCode));
}

function hasThreadsMediaPayload(object) {
    if (!object || typeof object !== "object") return false;
    if (Array.isArray(object.carousel_media) && object.carousel_media.length > 0) return true;
    if (Array.isArray(object.carouselMedia) && object.carouselMedia.length > 0) return true;
    if (Array.isArray(object?.media?.carousel_media) && object.media.carousel_media.length > 0) return true;
    if (Array.isArray(object?.image_versions2?.candidates) && object.image_versions2.candidates.length > 0) return true;
    if (Array.isArray(object?.image_versions?.candidates) && object.image_versions.candidates.length > 0) return true;
    if (Array.isArray(object?.video_versions) && object.video_versions.length > 0) return true;
    if (Array.isArray(object?.video_versions2?.candidates) && object.video_versions2.candidates.length > 0) return true;
    return false;
}

function hasStrongThreadsMediaIdentity(object) {
    if (!object || typeof object !== "object") return false;
    return object.media_type != null || object.pk != null || object.media_id != null || object.pk_id != null;
}

function isClassicThreadsShareCard(media) {
    if (!Array.isArray(media) || media.length !== 1 || media[0]?.type !== "image") return false;
    const width = Number(media[0]?.width || 0);
    const height = Number(media[0]?.height || 0);
    return width === 1200 && (height === 628 || height === 630);
}

function isLikelyThreadsShareCardRecord(object, media) {
    if (!object || typeof object !== "object") return false;
    const keys = Object.keys(object);
    const shareishKey = keys.some(key => /(?:^|_)(?:share|social|preview|open_graph|og)(?:_|$)/i.test(key));
    if (isClassicThreadsShareCard(media) && (shareishKey || !hasStrongThreadsMediaIdentity(object))) return true;

    // A wrapper that merely has share_url/url + image_versions2 but no real Threads
    // media identity is metadata, not the user's uploaded media.
    if (shareishKey && !hasStrongThreadsMediaIdentity(object) && !Array.isArray(object.carousel_media)) {
        return true;
    }
    return false;
}

function parseThreadsScriptPayloads(html) {
    const payloads = [];
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];

    for (const script of scripts) {
        const openEnd = script.indexOf(">");
        const closeStart = script.toLowerCase().lastIndexOf("</script>");
        if (openEnd < 0 || closeStart <= openEnd) continue;
        let body = script.slice(openEnd + 1, closeStart).trim();
        if (!body || (!body.includes("image_versions2") && !body.includes("video_versions") && !body.includes("carousel_media"))) continue;
        body = body.replace(/^<!--/, "").replace(/-->$/, "").trim();

        const attempts = [body];
        const firstObject = body.indexOf("{");
        const lastObject = body.lastIndexOf("}");
        if (firstObject >= 0 && lastObject > firstObject) attempts.push(body.slice(firstObject, lastObject + 1));
        const firstArray = body.indexOf("[");
        const lastArray = body.lastIndexOf("]");
        if (firstArray >= 0 && lastArray > firstArray) attempts.push(body.slice(firstArray, lastArray + 1));

        for (const value of attempts) {
            try {
                payloads.push(JSON.parse(value));
                break;
            } catch {}
        }
    }

    return payloads;
}

const THREADS_SKIP_MEDIA_BRANCH_RE = /^(?:user|owner|profile|avatar|profile_pic|quoted_post|reposted_post|repost|share_card|share_preview|social_preview|link_preview|preview|preview_image|open_graph|og_image|recommended|recommendations|related|suggested)$/i;

function collectThreadsOriginalRecordsInsideContext(root, output, depth = 0) {
    if (depth > 24 || root == null || typeof root !== "object") return;

    if (hasThreadsMediaPayload(root) && hasStrongThreadsMediaIdentity(root)) {
        const media = extractThreadsMediaSequence(root);
        if (media.length > 0 && !isLikelyThreadsShareCardRecord(root, media)) {
            output.push({ post: root, media, matchStrength: 60 });
        }
    }

    if (Array.isArray(root)) {
        for (const item of root) collectThreadsOriginalRecordsInsideContext(item, output, depth + 1);
        return;
    }

    for (const [key, value] of Object.entries(root)) {
        if (THREADS_SKIP_MEDIA_BRANCH_RE.test(key)) continue;
        collectThreadsOriginalRecordsInsideContext(value, output, depth + 1);
    }
}

function collectThreadsTargetPosts(root, postCode, output, depth = 0) {
    if (depth > 80 || root == null) return;
    if (typeof root === "string") {
        if (root.length > 128 && root.length < 2 * 1024 * 1024 && root.includes(postCode) && /image_versions2|video_versions|carousel_media/.test(root)) {
            try {
                collectThreadsTargetPosts(JSON.parse(root), postCode, output, depth + 1);
            } catch {}
        }
        return;
    }
    if (typeof root !== "object") return;

    if (objectMatchesThreadsPostCode(root, postCode) && hasThreadsMediaPayload(root)) {
        const media = extractThreadsMediaSequence(root);
        if (media.length > 0 && !isLikelyThreadsShareCardRecord(root, media)) {
            output.push({ post: root, media, matchStrength: 100 });
        }
    } else if (objectReferencesThreadsPostCode(root, postCode)) {
        // share_url/url may identify a TARGET CONTEXT, but never its own image_versions2.
        // Search below that wrapper only for records carrying real Threads media identity.
        collectThreadsOriginalRecordsInsideContext(root, output);
    }

    if (Array.isArray(root)) {
        for (const item of root) collectThreadsTargetPosts(item, postCode, output, depth + 1);
        return;
    }

    for (const [key, value] of Object.entries(root)) {
        if (THREADS_SKIP_MEDIA_BRANCH_RE.test(key)) continue;
        collectThreadsTargetPosts(value, postCode, output, depth + 1);
    }
}

function extractThreadsStructuredMediaFromHtml(html, postCode) {
    if (!postCode) return [];
    const matches = [];
    for (const payload of parseThreadsScriptPayloads(html)) {
        collectThreadsTargetPosts(payload, postCode, matches);
    }
    if (matches.length === 0) return [];

    matches.sort((a, b) => {
        if ((b.matchStrength || 0) !== (a.matchStrength || 0)) {
            return (b.matchStrength || 0) - (a.matchStrength || 0);
        }
        return b.media.length - a.media.length;
    });
    return uniqueMedia(matches[0].media);
}

function extractThreadsVerifiedVideoFallback(html) {
    const videos = extractMetaValues(html, [
        "og:video",
        "og:video:url",
        "og:video:secure_url",
        "twitter:player:stream",
    ])
        .map(normalizeThreadsMediaUrl)
        .filter(url => /^https?:\/\//i.test(url))
        .map(url => ({ url, type: "video", source: "meta-video-fallback" }));
    return uniqueMedia(videos);
}

function extractThreadsMediaFromHtml(html, postCode) {
    const structured = extractThreadsStructuredMediaFromHtml(html, postCode);
    if (structured.length > 0) return structured;

    // Image OG/Twitter cards are intentionally NOT used: Threads frequently renders
    // a composite white share-card there. If structured original media is unavailable,
    // failing is safer than returning the wrong image. Video metadata is retained only
    // when it points directly at an actual video file.
    return extractThreadsVerifiedVideoFallback(html);
}

function buildThreadsVredenUrl(url) {
    const endpoint = new URL(THREADS_VREDEN_ENDPOINT);
    endpoint.searchParams.set("url", url);
    return endpoint.toString();
}

function collectThreadsApiUrlEntries(value, pathParts = [], output = [], depth = 0) {
    if (depth > 40 || value == null) return output;

    if (typeof value === "string") {
        const normalized = normalizeThreadsMediaUrl(value);
        if (/^https?:\/\//i.test(normalized)) {
            output.push({ url: normalized, path: pathParts.join(".").toLowerCase() });
        }
        return output;
    }

    if (Array.isArray(value)) {
        value.forEach((item, index) => collectThreadsApiUrlEntries(item, [...pathParts, String(index)], output, depth + 1));
        return output;
    }

    if (typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            collectThreadsApiUrlEntries(item, [...pathParts, key], output, depth + 1);
        }
    }

    return output;
}

function isProbablyThreadsPageUrl(url) {
    const clean = String(url || "").toLowerCase();
    if (/\.(?:mp4|mov|m4v|webm|jpg|jpeg|png|webp|heic|heif)(?:[/?#.]|$)/i.test(clean)) return false;
    try {
        const parsed = new URL(url);
        return /(^|\.)threads\.(?:net|com)$/i.test(parsed.hostname);
    } catch {
        return false;
    }
}

function isThreadsApiAssetUrl(url, mediaType) {
    const clean = normalizeThreadsMediaUrl(url);
    if (!/^https?:\/\//i.test(clean)) return false;
    if (/static\.cdninstagram\.com\/rsrc\.php/i.test(clean)) return false;
    if (/(?:profile_pic|avatar|t51\.2885-19)/i.test(clean)) return false;

    const guessed = guessMediaTypeFromUrl(clean);
    if (mediaType && guessed && guessed !== mediaType) return false;
    if (guessed) return true;

    try {
        const host = new URL(clean).hostname.toLowerCase();
        return /(?:cdninstagram\.com|fbcdn\.net)$/.test(host) || host.includes("cdninstagram.com") || host.includes("fbcdn.net");
    } catch {
        return false;
    }
}

function threadsApiAssetKey(url) {
    try {
        const parsed = new URL(normalizeThreadsMediaUrl(url));
        return `${parsed.hostname.toLowerCase()}${parsed.pathname}`;
    } catch {
        return normalizeThreadsMediaUrl(url).split("?")[0];
    }
}

function extractThreadsMediaFromApiPayload(payload) {
    const entries = collectThreadsApiUrlEntries(payload);
    const output = [];
    const seen = new Set();
    const rejectedPathRe = /(?:^|\.)(?:avatar|profile|profile_pic|thumbnail|thumb|cover|logo|link_preview|preview_image|share_card|share_preview|social_preview|open_graph|og_image)(?:\.|$)/i;

    for (const entry of entries) {
        const url = normalizeThreadsMediaUrl(entry.url);
        const entryPath = String(entry.path || "").toLowerCase();
        if (!url || isProbablyThreadsPageUrl(url) || rejectedPathRe.test(entryPath)) continue;

        let mediaType = guessMediaTypeFromUrl(url);
        if (!mediaType) {
            if (/(?:^|\.)(?:video|video_versions|play_url|video_url|download_url)(?:\.|$)/i.test(entryPath)) mediaType = "video";
            else if (/(?:^|\.)(?:image|image_versions2|image_versions|photo|picture|media_url|carousel_media)(?:\.|$)/i.test(entryPath)) mediaType = "image";
        }
        if (!mediaType || !isThreadsApiAssetUrl(url, mediaType)) continue;

        const key = `${mediaType}:${threadsApiAssetKey(url)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push({
            url,
            type: mediaType,
            width: null,
            height: null,
            mediaId: null,
            source: "threads-vreden-api",
        });
    }

    return output.slice(0, CONFIG.maxFiles);
}

async function extractThreadsMediaFromApi(url, options = {}) {
    const requestJson = options.requestJson || fetchJson;
    const apiUrl = buildThreadsVredenUrl(url);
    const payload = await requestJson(apiUrl, {
        referer: "https://api.vreden.my.id/",
    });
    const media = extractThreadsMediaFromApiPayload(payload);
    if (media.length === 0) throw new Error("Vreden tidak mengembalikan media original Threads.");
    console.log("[THREADS DL] original media source=Vreden", { count: media.length });
    return media;
}

async function extractThreadsMedia(url, options = {}) {
    const normalizedUrl = normalizeDownloadUrl(url, "threads");
    const errors = [];

    // Sama seperti downloader Telegram project ini: Vreden lebih dulu karena
    // endpoint Threads mengembalikan structured post-media dan menangani /share/ URL.
    // Direct HTML tetap fallback agar downloader tidak bergantung pada satu provider.
    try {
        return await extractThreadsMediaFromApi(normalizedUrl, options);
    } catch (error) {
        errors.push(`api: ${error.message}`);
        console.log("[THREADS DL] Vreden fallback", { error: error.message });
    }

    const fetchPage = options.fetchPage || fetchThreadsPage;
    const initialPostCode = extractThreadsPostCode(normalizedUrl);
    for (const userAgent of THREADS_PAGE_USER_AGENTS) {
        try {
            const page = await fetchPage(normalizedUrl, {
                "user-agent": userAgent,
                referer: "https://www.threads.com/",
            });
            const html = typeof page === "string" ? page : page?.html;
            const finalUrl = typeof page === "string" ? normalizedUrl : (page?.finalUrl || normalizedUrl);
            const effectivePostCode = extractThreadsPostCode(finalUrl) || initialPostCode;
            if (!effectivePostCode) {
                errors.push(`html/${userAgent.slice(0, 18)}: redirect tidak menghasilkan URL /post/`);
                continue;
            }

            const media = extractThreadsMediaFromHtml(html || "", effectivePostCode);
            if (media.length > 0) {
                console.log("[THREADS DL] original media source=direct-html", {
                    count: media.length,
                    postCode: effectivePostCode,
                });
                return media.slice(0, CONFIG.maxFiles);
            }
            errors.push(`html/${userAgent.slice(0, 18)}: media original tidak ditemukan`);
        } catch (error) {
            errors.push(`html/${userAgent.slice(0, 18)}: ${error.message}`);
        }
    }

    throw new Error(
        "Original media Threads tidak ditemukan. Social/share preview card sengaja tidak digunakan. " +
        errors.slice(-5).join(" | ")
    );
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
    if (type.includes("image/heic")) return "heic";
    if (type.includes("image/heif")) return "heif";
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

            const urlExt = path.extname(parsed.pathname).replace(".", "").toLowerCase();
            const contentExt = guessExtFromContentType(res.headers["content-type"], type);
            const ext = ["heic", "heif"].includes(contentExt) ? contentExt : (urlExt || contentExt);
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
    const downloaded = [];
    const audioFiles = [];

    if (mode === "audio" && videoMedia.length === 0) {
        throw new Error("Postingan Threads ini terdeteksi sebagai gambar, jadi tidak ada audio untuk diambil.");
    }

    const selected = (mode === "audio" ? videoMedia : media).slice(0, CONFIG.maxFiles);
    if (selected.length === 0) throw new Error("Media publik Threads tidak ditemukan.");

    try {
        for (let index = 0; index < selected.length; index++) {
            const file = await downloadRemoteFile(selected[index].url, selected[index].type, index + 1);
            file.sourceUrl = selected[index].url;
            file.mediaIndex = index;
            downloaded.push(file);
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
    url = unwrapTikTokRedirectUrl(url);
    const unsupportedPage = getUnsupportedTikTokPageKind(url);
    if (unsupportedPage) {
        throw new Error(unsupportedPage === "minis"
            ? "Link ini membuka TikTok Minis, bukan postingan video/foto TikTok."
            : "Link ini membuka halaman login TikTok, bukan postingan video/foto TikTok.");
    }

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

function mimeTypeForFile(filePath) {
    const ext = path.extname(filePath).replace(".", "").toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "png") return "image/png";
    if (ext === "webp") return "image/webp";
    if (ext === "heic") return "image/heic";
    if (ext === "heif") return "image/heif";
    if (ext === "mp4" || ext === "m4v" || ext === "mov") return "video/mp4";
    if (ext === "webm") return "video/webm";
    return "application/octet-stream";
}

function runFfmpegImageToJpeg(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const child = spawn("ffmpeg", [
            "-y",
            "-i", inputPath,
            "-frames:v", "1",
            "-q:v", "2",
            outputPath,
        ], {
            windowsHide: true,
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", chunk => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", code => {
            if (code !== 0 || !fs.existsSync(outputPath)) {
                reject(new Error((stderr || `ffmpeg keluar dengan kode ${code}`).trim()));
                return;
            }
            resolve(outputPath);
        });
    });
}

async function convertThreadsHeicToJpeg(inputPath, outputPath) {
    try {
        const sharp = require("sharp");
        await sharp(inputPath)
            .rotate()
            .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
            .toFile(outputPath);
        return outputPath;
    } catch (sharpError) {
        try {
            return await runFfmpegImageToJpeg(inputPath, outputPath);
        } catch (ffmpegError) {
            throw new Error(`HEIC preview gagal dikonversi (sharp: ${sharpError.message}; ffmpeg: ${ffmpegError.message})`);
        }
    }
}

async function prepareThreadsImagePreview(file, index, options = {}) {
    const ext = path.extname(file.filePath).replace(".", "").toLowerCase();
    if (WHATSAPP_VIEWABLE_IMAGE_EXTENSIONS.has(ext)) {
        return { filePath: file.filePath, temporary: false };
    }
    if (!new Set(["heic", "heif"]).has(ext)) {
        return { filePath: file.filePath, temporary: false };
    }

    const outputPath = path.join(CONFIG.tempDir, `threads_preview_${Date.now()}_${index + 1}.jpg`);
    const converter = options.convertHeicToJpeg || convertThreadsHeicToJpeg;
    await converter(file.filePath, outputPath);
    return { filePath: outputPath, temporary: true };
}

function buildThreadsSummary(files) {
    const imageCount = files.filter(file => file.type === "image").length;
    const videoCount = files.filter(file => file.type === "video").length;
    const parts = ["✅ Threads berhasil didownload"];
    if (imageCount > 0 && videoCount > 0) parts.push(`🖼️ ${imageCount} gambar • 🎬 ${videoCount} video`);
    else if (imageCount > 0) parts.push(`🖼️ ${imageCount} media`);
    else if (videoCount > 0) parts.push(`🎬 ${videoCount} video`);
    if (imageCount > 0) parts.push("📦 Original files disertakan");
    return parts.join("\n");
}

async function sendThreadsDownloadedFiles(sock, jid, files, mode, options = {}) {
    if (mode === "audio") {
        await sendDownloadedFiles(sock, jid, files, "Threads", mode);
        return;
    }

    const previewTemps = [];
    const imageOriginals = files.filter(file => file.type === "image");
    const summary = buildThreadsSummary(files);
    let summarySent = false;
    let previewFailures = 0;

    try {
        const imageOnly = files.length > 1 && files.every(file => file.type === "image");

        // Threads image carousel: prepare every viewable preview first, then use the
        // project's existing Baileys album sender so WhatsApp groups them as one album.
        if (imageOnly) {
            const previews = [];
            for (let index = 0; index < files.length; index++) {
                try {
                    const preview = await prepareThreadsImagePreview(files[index], index, options);
                    if (preview.temporary) previewTemps.push({ filePath: preview.filePath });
                    previews.push({ file: files[index], preview, index });
                } catch (error) {
                    previewFailures += 1;
                    console.log("[THREADS-DL] Preview image gagal; original document tetap akan dikirim.", {
                        index: index + 1,
                        error: error.message,
                    });
                }
            }

            const summaryWithWarning = previewFailures > 0
                ? `${summary}\n⚠️ ${previewFailures} preview gagal dibuat; original tetap disertakan.`
                : summary;

            if (previews.length >= 2) {
                await sendImageAlbum(
                    sock,
                    jid,
                    previews.map(item => ({ url: item.preview.filePath })),
                    { caption: summaryWithWarning }
                );
                summarySent = true;
            } else if (previews.length === 1) {
                await sock.sendMessage(jid, {
                    image: { url: previews[0].preview.filePath },
                    caption: summaryWithWarning,
                });
                summarySent = true;
            }
        } else {
            // Mixed carousel cannot use the image-only album envelope without changing
            // item ordering, so preserve the exact image/video sequence from Threads.
            for (let index = 0; index < files.length; index++) {
                const file = files[index];
                const caption = summarySent ? undefined : summary;

                if (file.type === "image") {
                    try {
                        const preview = await prepareThreadsImagePreview(file, index, options);
                        if (preview.temporary) previewTemps.push({ filePath: preview.filePath });
                        await sock.sendMessage(jid, {
                            image: { url: preview.filePath },
                            ...(caption ? { caption } : {}),
                        });
                        summarySent = true;
                    } catch (error) {
                        previewFailures += 1;
                        console.log("[THREADS-DL] Preview image gagal; original document tetap akan dikirim.", {
                            index: index + 1,
                            error: error.message,
                        });
                    }
                } else if (file.type === "video") {
                    await sock.sendMessage(jid, {
                        video: { url: file.filePath },
                        mimetype: mimeTypeForFile(file.filePath),
                        ...(caption ? { caption } : {}),
                    });
                    summarySent = true;
                } else {
                    await sock.sendMessage(jid, {
                        document: { url: file.filePath },
                        mimetype: mimeTypeForFile(file.filePath),
                        fileName: path.basename(file.filePath),
                        ...(caption ? { caption } : {}),
                    });
                    summarySent = true;
                }

                if (files.length > 1) await delay(700);
            }
        }

        for (let index = 0; index < imageOriginals.length; index++) {
            const file = imageOriginals[index];
            let caption;
            if (index === 0) {
                caption = summarySent
                    ? `📦 Original files Threads • ${imageOriginals.length} file`
                    : summary;
                if (previewFailures > 0 && !caption.includes("preview gagal")) {
                    caption += `\n⚠️ ${previewFailures} preview gagal dibuat; original tetap disertakan.`;
                }
            }
            await sock.sendMessage(jid, {
                document: { url: file.filePath },
                mimetype: mimeTypeForFile(file.filePath),
                fileName: path.basename(file.filePath),
                ...(caption ? { caption } : {}),
            });
            if (imageOriginals.length > 1) await delay(500);
        }
    } finally {
        cleanupFiles(previewTemps);
    }
}

async function sendDownloadedFiles(sock, jid, files, label, mode) {
    const imageFiles = files.filter(file => file.type === "image");
    if (mode !== "audio" && imageFiles.length === files.length && imageFiles.length > 1) {
        await sendImageAlbum(
            sock,
            jid,
            imageFiles.map(file => ({ url: file.filePath })),
            {
                caption: `✅ ${label} berhasil didownload (${imageFiles.length} gambar)\n\n_Watermark: USERBOT_`,
            }
        );
        return;
    }

    for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const fileName = path.basename(file.filePath);
        const counter = files.length > 1 ? ` (${index + 1}/${files.length})` : "";
        const caption = file.type === "image" && files.length > 1 && index > 0
            ? `✅ ${label} berhasil didownload${counter}`
            : `✅ ${label} berhasil didownload${counter}\n\n_Watermark: USERBOT_`;

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

async function handleLocalDownload(sock, from, text, pushName, inputMessageKey, inputMessage) {
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
            if (session.platform === "threads") {
                await sendThreadsDownloadedFiles(sock, from, files, mode);
            } else {
                await sendDownloadedFiles(sock, from, files, label, mode);
            }
            await react(sock, from, reactionKey, "✅");
            await delay(700);
            await messageCleaner.deleteMany(sock, from, temporaryKeys, "pesan downloader");
            await messageCleaner.safeDelete(sock, from, inputMessageKey, "pesan pilihan download");
        } catch (error) {
            await react(sock, from, reactionKey, "❌");
            await messageCleaner.deleteMany(sock, from, temporaryKeys, "pesan downloader");
            console.log("[LOCAL-DL] Detail kegagalan disembunyikan dari pengguna:", {
                platform: session.platform,
                error: error.message,
            });
            await sock.sendMessage(from, {
                text:
                    `❌ Gagal download ${label}.\n\n` +
                    `Media tidak dapat diambil. Pastikan link postingan bersifat publik dan coba kembali beberapa saat lagi.`,
            });
            await delay(700);
            await messageCleaner.safeDelete(sock, from, inputMessageKey, "pesan pilihan download");
        } finally {
            cleanupFiles(files);
        }

        return true;
    }

    if (!/^\.dl(?:\s|$)/i.test(String(text || "").trim())) return false;

    const commandArgument = String(text || "").replace(/^\.dl\b/i, "").trim();
    const quotedText = extractQuotedText(inputMessage?.message?.extendedTextMessage?.contextInfo?.quotedMessage);
    const downloadText = commandArgument || quotedText;
    const platform = detectPlatform(downloadText);
    const url = extractUrl(downloadText);
    if (!platform || !url) return false;

    const label = platformLabel(platform);
    const normalizedUrl = normalizeDownloadUrl(url, platform);
    const unsupportedTikTokPage = platform === "tiktok"
        ? getUnsupportedTikTokPageKind(normalizedUrl)
        : null;

    if (unsupportedTikTokPage) {
        await sock.sendMessage(from, {
            text:
                `❌ *Itu bukan link video TikTok.*\n\n` +
                `Link yang masuk adalah halaman ${unsupportedTikTokPage === "minis" ? "TikTok Minis" : "login TikTok"}, ` +
                `jadi tidak berisi video/foto publik yang bisa diunduh.\n\n` +
                `Buka postingan videonya → tekan *Bagikan* → *Salin tautan*, lalu kirim link tersebut ke bot. ` +
                `Biasanya link yang benar berbentuk *vt.tiktok.com/...* atau *tiktok.com/@nama/video/...*.`
        });
        return true;
    }

    const menuText =
        `🌐 *Link ${label} terdeteksi!*\n\n` +
        `Pilih format download:\n\n` +
        `*1* — Media utama\n` +
        `*2* — Audio MP3${platform === "threads" ? " (jika video)" : ""}\n` +
        `*3* — Batal` +
        (platform === "threads" ? "" : `\n\n_Watermark: USERBOT_`);

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
    extractUrls,
    normalizeDownloadUrl,
    unwrapTikTokRedirectUrl,
    getUnsupportedTikTokPageKind,
    isLikelyTikTokMediaUrl,
    sendDownloadedFiles,
    extractThreadsMedia,
    extractThreadsMediaFromApi,
    extractThreadsMediaFromApiPayload,
    buildThreadsVredenUrl,
    extractThreadsMediaFromHtml,
    extractThreadsStructuredMediaFromHtml,
    extractThreadsPostCode,
    prepareThreadsImagePreview,
    sendThreadsDownloadedFiles,
    sendDownloadedFiles,
    downloadThreads,
    MEDIA_DIR: CONFIG.tempDir,
    getMediaDirs: () => [CONFIG.tempDir],
};
