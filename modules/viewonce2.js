const fs = require("fs");
const path = require("path");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const viewonce = require("./viewonce");
const securityMediaLog = require("./securityMediaLog");

const STORE_PATH = path.join(__dirname, "../data/viewonce2_logs.json");
const MEDIA_DIR = path.join(__dirname, "../data/viewonce2_media");
const STORE_TTL_MS = Number(process.env.VIEWONCE2_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const STORE_LIMIT = Number(process.env.VIEWONCE2_STORE_LIMIT || 2000);
const MEMORY_TTL_MS = Number(process.env.VIEWONCE2_MEMORY_TTL_MS || STORE_TTL_MS);
const MEMORY_LIMIT = Number(process.env.VIEWONCE2_MEMORY_LIMIT || 800);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.VIEWONCE2_DOWNLOAD_TIMEOUT_MS || 45000);
const MEDIA_MAX_BYTES = Number(process.env.VIEWONCE2_MEDIA_MAX_BYTES || 60 * 1024 * 1024);
const PENDING_DELETE_TTL_MS = Number(process.env.VIEWONCE2_PENDING_DELETE_TTL_MS || 10 * 60 * 1000);
const RAW_DEBUG_DIR = path.join(__dirname, "../data/viewonce2_debug");

const PROTOCOL_REVOKE = 0;
const STUB_REVOKE = 1;
const STUB_ADMIN_REVOKE = 132;

const memoryCache = new Map();
const recentDeleteKeys = new Map();
const pendingDeleteCache = new Map();
let storeLoaded = false;
let fileStore = {};

function isEnabled() {
    return !/^(0|false|off|no)$/i.test(String(process.env.VIEWONCE2_ENABLED || "true").trim());
}

function isDebugEnabled() {
    return /^(1|true|on|yes)$/i.test(String(process.env.VIEWONCE2_DEBUG || "").trim());
}

function shouldNotifyOnOpen() {
    return /^(1|true|on|yes)$/i.test(String(process.env.VIEWONCE2_NOTIFY_ON_OPEN || "").trim());
}

function debugLog(message, meta = {}) {
    if (!isDebugEnabled()) return;
    console.log(`[VIEWONCE2 DEBUG] ${message}`, meta);
}

function isRawDebugEnabled() {
    return /^(1|true|on|yes)$/i.test(String(process.env.VIEWONCE2_RAW_DEBUG || "").trim());
}

function unique(items) {
    return [...new Set((items || []).filter(Boolean))];
}

function safeStringify(value, space) {
    return JSON.stringify(value, (key, item) => {
        if (typeof item === "bigint") return item.toString();
        if (Buffer.isBuffer(item)) return { type: "Buffer", length: item.length };
        if (item instanceof Uint8Array) return { type: item.constructor?.name || "Uint8Array", length: item.length };
        if (typeof item === "function") return `[Function ${item.name || "anonymous"}]`;
        return item;
    }, space);
}

function ensureRawDebugDir() {
    if (!fs.existsSync(RAW_DEBUG_DIR)) fs.mkdirSync(RAW_DEBUG_DIR, { recursive: true });
}

function getRawDebugLimit() {
    const limit = Number(process.env.VIEWONCE2_RAW_DEBUG_LIMIT || 200);
    return Number.isFinite(limit) && limit > 0 ? limit : 200;
}

function pruneRawDebugDumps() {
    try {
        ensureRawDebugDir();
        const limit = getRawDebugLimit();
        const files = fs.readdirSync(RAW_DEBUG_DIR)
            .filter(name => name.endsWith(".json"))
            .map(name => {
                const filePath = path.join(RAW_DEBUG_DIR, name);
                const stat = fs.statSync(filePath);
                return { filePath, mtimeMs: stat.mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);

        files.slice(limit).forEach(item => fs.unlinkSync(item.filePath));
    } catch (error) {
        console.log("[VIEWONCE2] Gagal rapikan raw debug dump.", { error: error.message });
    }
}

function getValueType(value) {
    if (value === null) return "null";
    if (Buffer.isBuffer(value)) return "Buffer";
    if (Array.isArray(value)) return "Array";
    if (value instanceof Uint8Array) return value.constructor?.name || "Uint8Array";
    return typeof value;
}

function shouldSkipDebugValue(key, value) {
    if (!value || typeof value !== "object") return false;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return true;
    return /^(jpegThumbnail|thumbnail|mediaKey|fileSha256|fileEncSha256|scansSidecar|firstScanSidecar|midQualityFileSha256|streamingSidecar)$/i.test(key);
}

function collectMessageShape(value, pathParts = [], depth = 0, seen = new Set(), output = []) {
    if (!value || typeof value !== "object" || depth > 16 || seen.has(value)) return output;
    seen.add(value);

    const keys = Object.keys(value);
    output.push({
        path: pathParts.join(".") || "root",
        type: getValueType(value),
        keys: keys.slice(0, 80),
        keyCount: keys.length,
    });

    for (const [key, child] of Object.entries(value)) {
        if (!child || typeof child !== "object" || shouldSkipDebugValue(key, child)) continue;
        if (Array.isArray(child)) {
            child.slice(0, 20).forEach((item, index) => {
                collectMessageShape(item, [...pathParts, `${key}[${index}]`], depth + 1, seen, output);
            });
            continue;
        }
        collectMessageShape(child, [...pathParts, key], depth + 1, seen, output);
    }

    return output;
}

function sanitizeForDebug(value, depth = 0, seen = new Set()) {
    if (value === null || typeof value !== "object") {
        if (typeof value === "bigint") return value.toString();
        if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
        return value;
    }

    if (Buffer.isBuffer(value)) return { type: "Buffer", length: value.length };
    if (value instanceof Uint8Array) return { type: value.constructor?.name || "Uint8Array", length: value.length };
    if (seen.has(value)) return "[Circular]";
    if (depth > 14) return "[DepthLimit]";
    seen.add(value);

    if (Array.isArray(value)) {
        return value.slice(0, 40).map(item => sanitizeForDebug(item, depth + 1, seen));
    }

    const output = {};
    for (const [key, child] of Object.entries(value)) {
        if (shouldSkipDebugValue(key, child)) {
            output[key] = {
                type: getValueType(child),
                length: child?.length || child?.byteLength || undefined,
                skipped: true,
            };
            continue;
        }
        output[key] = sanitizeForDebug(child, depth + 1, seen);
    }

    return output;
}

function summarizeMediaCandidate(candidate) {
    return {
        type: candidate.type,
        streamType: candidate.streamType,
        path: candidate.path,
        source: candidate.source,
        viewOnce: candidate.viewOnce,
        viewOnceLikely: candidate.viewOnceLikely,
        quoted: candidate.quoted,
        hasUrl: Boolean(candidate.media?.url),
        hasDirectPath: Boolean(candidate.media?.directPath),
        hasMediaKey: Boolean(candidate.media?.mediaKey),
        mimetype: candidate.media?.mimetype || candidate.mimetype || "",
        caption: candidate.caption || "",
    };
}

function ensureMediaDir() {
    if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

function ensureStoreLoaded() {
    if (storeLoaded) return;

    try {
        const dir = path.dirname(STORE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(STORE_PATH)) fs.writeFileSync(STORE_PATH, "{}");
        const raw = fs.readFileSync(STORE_PATH, "utf8").replace(/^\uFEFF/, "").trim();
        fileStore = JSON.parse(raw || "{}");
    } catch (error) {
        console.log(`[VIEWONCE2] Gagal baca store: ${error.message}`);
        fileStore = {};
    }

    storeLoaded = true;
}

function writeStore() {
    try {
        fs.writeFileSync(STORE_PATH, safeStringify(fileStore, 2));
    } catch (error) {
        console.log(`[VIEWONCE2] Gagal tulis store: ${error.message}`);
    }
}

function isGroupJid(jid) {
    return String(jid || "").endsWith("@g.us");
}

function isStatusJid(jid) {
    return String(jid || "").trim().toLowerCase() === "status@broadcast";
}

function normalizeUserJid(value) {
    const clean = String(value || "").trim();
    if (!clean || isStatusJid(clean)) return null;

    if (clean.includes("@")) {
        const [rawUser, rawServer] = clean.split("@");
        const server = String(rawServer || "").toLowerCase();
        const user = String(rawUser || "").split(":")[0].split("_")[0].replace(/[^0-9]/g, "");
        if (!user || server !== "s.whatsapp.net") return null;
        return `${user}@s.whatsapp.net`;
    }

    const number = clean.replace(/[^0-9]/g, "");
    return number ? `${number}@s.whatsapp.net` : null;
}

function normalizeMentionJid(value) {
    const clean = String(value || "").trim();
    if (!clean) return null;
    if (clean.toLowerCase().endsWith("@lid")) return clean;
    return normalizeUserJid(clean);
}

function getJidLabel(jid) {
    return String(jid || "").split("@")[0].split(":")[0].split("_")[0] || "-";
}

function getTimestampText(timestamp) {
    const raw = Number(timestamp || 0);
    const ms = raw > 1000000000000 ? raw : raw * 1000;
    if (!Number.isFinite(ms) || ms <= 0) return "-";

    try {
        return new Date(ms).toLocaleString("id-ID", {
            timeZone: process.env.TZ || "Asia/Jakarta",
            hour12: false,
        });
    } catch {
        return new Date(ms).toISOString();
    }
}

function getRecordLocation(record) {
    const remoteJid = record?.key?.remoteJid || "";
    if (isGroupJid(remoteJid)) return `Grup ${getJidLabel(remoteJid)}`;
    return `Chat ${getJidLabel(remoteJid)}`;
}

function getBotJid(sock) {
    const botId = sock?.user?.id || sock?.authState?.creds?.me?.id || "";
    const botNumber = String(botId).split(":")[0].replace(/[^0-9]/g, "");
    return botNumber ? `${botNumber}@s.whatsapp.net` : null;
}

function getBotJidCandidates(sock) {
    const values = [
        sock?.user?.id,
        sock?.authState?.creds?.me?.id,
        sock?.user?.lid,
        sock?.authState?.creds?.me?.lid,
        getBotJid(sock),
    ];

    return unique(values.map(normalizeMentionJid).filter(Boolean));
}

function getOwnerJids(sock, ownerJids = []) {
    const envOwners = [
        process.env.VIEWONCE2_OWNER_JID,
        process.env.OWNER_JID,
        process.env.ACTIVE_NOTIFY_JIDS,
    ]
        .filter(Boolean)
        .join(",")
        .split(",")
        .map(normalizeUserJid)
        .filter(Boolean);

    const configuredOwners = [
        ...ownerJids.map(normalizeUserJid),
        ...envOwners,
    ].filter(Boolean);

    return unique([
        ...configuredOwners,
        ...getBotJidCandidates(sock),
    ]);
}

function getOwnerJid(sock, ownerJids = []) {
    return getOwnerJids(sock, ownerJids)[0] || null;
}

function getSenderJid(msg) {
    const remoteJid = msg?.key?.remoteJid || "";
    if (isGroupJid(remoteJid)) {
        return msg?.key?.participant || msg?.participant || remoteJid;
    }

    return msg?.key?.participant || remoteJid;
}

function makeCacheKeys(key = {}) {
    const id = String(key.id || "").trim();
    if (!id) return [];

    const remoteJids = unique([key.remoteJid, key.remoteJidAlt]);
    const participants = unique([key.participant, key.participantAlt]);
    const keys = new Set([id]);

    for (const remoteJid of remoteJids) {
        keys.add(`${remoteJid}:${id}`);
        for (const participant of participants) {
            keys.add(`${remoteJid}:${participant}:${id}`);
        }
    }

    for (const participant of participants) {
        keys.add(`${participant}:${id}`);
    }

    return [...keys];
}

function getRecordMediaPath(record) {
    return record?.media?.filePath || null;
}

function isMediaPathReferenced(filePath, ignoredKey) {
    if (!filePath) return false;

    return Object.entries(fileStore).some(([key, item]) => (
        key !== ignoredKey && getRecordMediaPath(item) === filePath
    ));
}

function deleteCachedMediaFile(filePath) {
    if (!filePath) return;

    try {
        const resolvedMediaDir = path.resolve(MEDIA_DIR);
        const resolvedFile = path.resolve(filePath);
        if (!resolvedFile.startsWith(resolvedMediaDir)) return;
        if (fs.existsSync(resolvedFile)) fs.unlinkSync(resolvedFile);
    } catch (error) {
        console.log(`[VIEWONCE2] Gagal hapus media cache: ${error.message}`);
    }
}

function removeStoreEntry(key) {
    const item = fileStore[key];
    const filePath = getRecordMediaPath(item);
    delete fileStore[key];
    if (filePath && !isMediaPathReferenced(filePath, key)) deleteCachedMediaFile(filePath);
}

function pruneStore(now = Date.now()) {
    ensureStoreLoaded();

    for (const [key, item] of Object.entries(fileStore)) {
        if (!item?.savedAt || now - item.savedAt > STORE_TTL_MS) {
            removeStoreEntry(key);
        }
    }

    const entries = Object.entries(fileStore);
    if (entries.length <= STORE_LIMIT) return;

    entries
        .sort((a, b) => (a[1]?.savedAt || 0) - (b[1]?.savedAt || 0))
        .slice(0, entries.length - STORE_LIMIT)
        .forEach(([key]) => removeStoreEntry(key));
}

function pruneMemory(now = Date.now()) {
    for (const [key, item] of memoryCache) {
        if (!item?.savedAt || now - item.savedAt > MEMORY_TTL_MS) {
            memoryCache.delete(key);
        }
    }

    while (memoryCache.size > MEMORY_LIMIT) {
        const oldestKey = memoryCache.keys().next().value;
        if (!oldestKey) break;
        memoryCache.delete(oldestKey);
    }
}

function prunePendingDeletes(now = Date.now()) {
    for (const [key, item] of pendingDeleteCache) {
        if (!item?.seenAt || now - item.seenAt > PENDING_DELETE_TTL_MS) {
            pendingDeleteCache.delete(key);
        }
    }
}

function rememberPendingDelete(deleteInfo) {
    const targetKey = deleteInfo?.targetKey || {};
    if (!targetKey.id) return null;

    prunePendingDeletes();
    const pending = {
        targetKey,
        source: deleteInfo.source || "unknown",
        seenAt: Date.now(),
    };

    for (const key of makeCacheKeys(targetKey)) {
        pendingDeleteCache.set(key, pending);
    }

    return pending;
}

function consumePendingDelete(targetKey = {}) {
    if (!targetKey.id) return null;

    prunePendingDeletes();
    for (const key of makeCacheKeys(targetKey)) {
        const pending = pendingDeleteCache.get(key);
        if (!pending) continue;

        for (const removeKey of makeCacheKeys(pending.targetKey || targetKey)) {
            pendingDeleteCache.delete(removeKey);
        }
        return pending;
    }

    return null;
}

function saveRecord(record) {
    if (!record?.key?.id) return record;

    ensureStoreLoaded();
    const now = Date.now();
    if (!record.savedAt) record.savedAt = now;

    for (const key of makeCacheKeys(record.key)) {
        memoryCache.set(key, record);
        fileStore[key] = record;
    }

    pruneMemory(now);
    pruneStore(now);
    writeStore();
    return record;
}

function getStoredRecord(targetKey = {}) {
    if (!targetKey?.id) return null;

    ensureStoreLoaded();
    pruneMemory();
    pruneStore();

    for (const key of makeCacheKeys(targetKey)) {
        const cached = memoryCache.get(key);
        if (cached) return cached;

        const stored = fileStore[key];
        if (stored) {
            memoryCache.set(key, stored);
            return stored;
        }
    }

    return null;
}

function sanitizeFilePart(value, fallback = "viewonce") {
    const clean = String(value || "")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80);

    return clean || fallback;
}

function getMimeExtension(mimetype, mediaType = "media") {
    const clean = String(mimetype || "").split(";")[0].toLowerCase();
    const map = {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "video/mp4": "mp4",
        "video/3gpp": "3gp",
        "audio/ogg": "ogg",
        "audio/opus": "opus",
        "audio/mpeg": "mp3",
        "audio/mp4": "m4a",
        "audio/aac": "aac",
    };

    if (map[clean]) return map[clean];
    const subtype = clean.split("/")[1]?.replace(/[^a-z0-9]+/g, "");
    if (subtype) return subtype.slice(0, 8);
    if (mediaType === "audio") return "ogg";
    return mediaType === "image" ? "jpg" : "mp4";
}

function reviveBuffer(value) {
    if (!value || Buffer.isBuffer(value)) return value;
    if (value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
    if (Array.isArray(value)) return Buffer.from(value);
    return value;
}

function normalizeDownloadableMedia(media) {
    if (!media || typeof media !== "object") return media;

    for (const key of ["mediaKey", "fileSha256", "fileEncSha256", "jpegThumbnail"]) {
        if (media[key]) media[key] = reviveBuffer(media[key]);
    }

    return media;
}

function isViewOncePath(pathParts) {
    return pathParts.some(part => /viewonce/i.test(String(part || "")));
}

function isQuotedPath(pathParts) {
    return pathParts.some(part => /quotedMessage|contextInfo/i.test(String(part || "")));
}

function hasMediaDownloadIdentity(media = {}) {
    return Boolean(media.url || media.directPath || media.mediaKey || media.fileSha256 || media.fileEncSha256);
}

function makeDeepMediaCandidate(type, streamType, media, pathParts, fallback = {}) {
    const pathText = pathParts.join(".") || type;
    const wrapperLooksViewOnce = Boolean(fallback.inViewOnce || isViewOncePath(pathParts));
    const mediaLooksViewOnce = Boolean(media?.viewOnce || media?.viewOnceV2 || media?.isViewOnce);
    const viewOnce = Boolean(wrapperLooksViewOnce || mediaLooksViewOnce);
    const quoted = Boolean(fallback.quoted || isQuotedPath(pathParts));
    return {
        type,
        streamType,
        media,
        path: pathText,
        source: `deep-forensic:${pathText}`,
        content: fallback.content || null,
        caption: String(media?.caption || fallback.caption || "-").trim() || "-",
        mimetype: media?.mimetype || fallback.mimetype || (type === "image" ? "image/jpeg" : "video/mp4"),
        viewOnce,
        viewOnceLikely: Boolean(viewOnce && !quoted),
        quoted,
        hasDownloadIdentity: hasMediaDownloadIdentity(media),
    };
}

function collectMediaCandidatesDeep(value, pathParts = [], inViewOnce = false, depth = 0, seen = new Set(), output = []) {
    if (!value || typeof value !== "object" || depth > 16 || seen.has(value)) return output;
    seen.add(value);

    const currentInViewOnce = Boolean(inViewOnce || value.viewOnce === true || isViewOncePath(pathParts));
    const quoted = isQuotedPath(pathParts);

    if (value.imageMessage) {
        output.push(makeDeepMediaCandidate("image", "image", value.imageMessage, [...pathParts, "imageMessage"], {
            inViewOnce: currentInViewOnce,
            quoted,
            content: value,
            mimetype: "image/jpeg",
        }));
    }

    if (value.videoMessage || value.ptvMessage) {
        const isPtv = Boolean(value.ptvMessage && !value.videoMessage);
        const media = value.videoMessage || value.ptvMessage;
        output.push(makeDeepMediaCandidate("video", "video", media, [...pathParts, isPtv ? "ptvMessage" : "videoMessage"], {
            inViewOnce: currentInViewOnce,
            quoted,
            content: value,
            mimetype: "video/mp4",
        }));
    }

    if (value.audioMessage) {
        output.push(makeDeepMediaCandidate("audio", "audio", value.audioMessage, [...pathParts, "audioMessage"], {
            inViewOnce: currentInViewOnce,
            quoted,
            content: value,
            mimetype: "audio/ogg",
        }));
    }

    if (value.documentMessage) {
        output.push(makeDeepMediaCandidate("document", "document", value.documentMessage, [...pathParts, "documentMessage"], {
            inViewOnce: currentInViewOnce,
            quoted,
            content: value,
            mimetype: "application/octet-stream",
        }));
    }

    if (value.stickerMessage) {
        output.push(makeDeepMediaCandidate("sticker", "sticker", value.stickerMessage, [...pathParts, "stickerMessage"], {
            inViewOnce: currentInViewOnce,
            quoted,
            content: value,
            mimetype: "image/webp",
        }));
    }

    for (const [key, child] of Object.entries(value)) {
        if (!child || typeof child !== "object" || shouldSkipDebugValue(key, child)) continue;
        const childInViewOnce = currentInViewOnce || /viewonce/i.test(key);

        if (Array.isArray(child)) {
            child.forEach((item, index) => {
                collectMediaCandidatesDeep(item, [...pathParts, `${key}[${index}]`], childInViewOnce, depth + 1, seen, output);
            });
            continue;
        }

        collectMediaCandidatesDeep(child, [...pathParts, key], childInViewOnce, depth + 1, seen, output);
    }

    return output;
}

function getFallbackViewOnceMediaInfo(message) {
    const candidates = collectMediaCandidatesDeep(message);
    const selected = candidates.find(item => (
        item.viewOnceLikely &&
        !item.quoted &&
        (item.type === "image" || item.type === "video" || item.type === "audio") &&
        item.hasDownloadIdentity
    )) || candidates.find(item => (
        item.viewOnceLikely &&
        !item.quoted &&
        (item.type === "image" || item.type === "video" || item.type === "audio")
    ));

    if (!selected) return null;

    return {
        content: selected.content,
        media: selected.media,
        type: selected.type,
        streamType: selected.streamType,
        caption: selected.caption,
        source: selected.source,
        forensicCandidate: summarizeMediaCandidate(selected),
    };
}

function messageLooksWorthRawDump(message, candidates = [], shape = []) {
    if (candidates.length > 0) return true;
    const joined = [
        ...Object.keys(message || {}),
        ...shape.flatMap(item => [item.path, ...(item.keys || [])]),
    ].join(" ");
    return /viewonce|imageMessage|videoMessage|ptvMessage|audioMessage|documentMessage|stickerMessage|media|protocolMessage/i.test(joined);
}

function writeRawDebugDump(msg, reason, extra = {}) {
    if (!isRawDebugEnabled()) return null;

    try {
        ensureRawDebugDir();
        const message = msg?.message || {};
        const shape = collectMessageShape(message);
        const candidates = collectMediaCandidatesDeep(message).map(summarizeMediaCandidate);
        if (!messageLooksWorthRawDump(message, candidates, shape)) return null;

        const fileName = [
            new Date().toISOString().replace(/[:.]/g, "-"),
            sanitizeFilePart(msg?.key?.remoteJid || "chat"),
            sanitizeFilePart(msg?.key?.id || "noid"),
            sanitizeFilePart(reason || "dump"),
        ].join("_") + ".json";
        const filePath = path.join(RAW_DEBUG_DIR, fileName);
        const payload = {
            reason,
            savedAt: new Date().toISOString(),
            key: sanitizeForDebug(msg?.key || {}),
            participant: msg?.participant || null,
            pushName: msg?.pushName || "",
            messageTimestamp: msg?.messageTimestamp || null,
            messageTypes: Object.keys(message || {}),
            candidates,
            shape,
            extra: sanitizeForDebug(extra),
            message: sanitizeForDebug(message),
        };

        fs.writeFileSync(filePath, safeStringify(payload, 2));
        pruneRawDebugDumps();
        return filePath;
    } catch (error) {
        console.log("[VIEWONCE2] Gagal tulis raw debug dump.", {
            id: msg?.key?.id,
            reason,
            error: error.message,
        });
        return null;
    }
}

function writeDeleteDebugDump(deleteInfo, reason, extra = {}) {
    if (!isRawDebugEnabled()) return null;

    try {
        ensureRawDebugDir();
        const targetKey = deleteInfo?.targetKey || {};
        const fileName = [
            new Date().toISOString().replace(/[:.]/g, "-"),
            sanitizeFilePart(targetKey.remoteJid || "chat"),
            sanitizeFilePart(targetKey.id || "noid"),
            sanitizeFilePart(reason || "delete"),
        ].join("_") + ".json";
        const filePath = path.join(RAW_DEBUG_DIR, fileName);
        const payload = {
            reason,
            savedAt: new Date().toISOString(),
            deleteInfo: sanitizeForDebug(deleteInfo || {}),
            cacheKeys: makeCacheKeys(targetKey),
            storedRecordExists: Boolean(getStoredRecord(targetKey)),
            extra: sanitizeForDebug(extra),
            note: "Dump ini dibuat dari sinyal delete/protocol. Kalau tidak ada rawMessage/candidates, berarti media asli belum pernah terlihat oleh handler sebelum pesan dihapus.",
        };

        fs.writeFileSync(filePath, safeStringify(payload, 2));
        pruneRawDebugDumps();
        return filePath;
    } catch (error) {
        console.log("[VIEWONCE2] Gagal tulis delete debug dump.", {
            id: deleteInfo?.targetKey?.id,
            reason,
            error: error.message,
        });
        return null;
    }
}

function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
    });

    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function getDownloadStreamTypes(mediaInfo = {}) {
    return unique([
        mediaInfo.streamType,
        mediaInfo.type,
        mediaInfo.mediaType,
        mediaInfo.type === "video" ? "video" : null,
        mediaInfo.type === "image" ? "image" : null,
    ]);
}

async function readDownloadStream(stream) {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (MEDIA_MAX_BYTES > 0 && total > MEDIA_MAX_BYTES) {
            throw new Error(`media lebih besar dari batas ${Math.round(MEDIA_MAX_BYTES / 1024 / 1024)}MB`);
        }
        chunks.push(buffer);
    }

    return Buffer.concat(chunks);
}

async function downloadViewOnceBuffer(mediaInfo, record = null) {
    return withTimeout(
        (async () => {
            const attempts = [];
            let lastError = null;
            const streamTypes = getDownloadStreamTypes(mediaInfo);

            for (const streamType of streamTypes) {
                const startedAt = Date.now();
                try {
                    const media = normalizeDownloadableMedia({ ...(mediaInfo.media || {}) });
                    const stream = await downloadContentFromMessage(media, streamType);
                    const buffer = await readDownloadStream(stream);
                    attempts.push({
                        streamType,
                        ok: true,
                        size: buffer.length,
                        ms: Date.now() - startedAt,
                    });
                    if (record) record.downloadAttempts = attempts;
                    return buffer;
                } catch (error) {
                    lastError = error;
                    attempts.push({
                        streamType,
                        ok: false,
                        error: error.message,
                        ms: Date.now() - startedAt,
                    });
                }
            }

            if (record) record.downloadAttempts = attempts;
            const methods = attempts.map(item => `${item.streamType}:${item.ok ? "ok" : item.error}`).join(" | ");
            throw new Error(`semua metode download gagal (${methods || "tidak ada streamType"})`);
        })(),
        DOWNLOAD_TIMEOUT_MS,
        "ViewOnce2 download"
    );
}

function cleanCaption(value) {
    const clean = String(value || "").trim();
    if (!clean || clean === "-") return "-";
    return clean;
}

function makeRecord(msg, mediaInfo) {
    const senderJid = getSenderJid(msg);
    const fallbackMimetype = mediaInfo.type === "image"
        ? "image/jpeg"
        : mediaInfo.type === "audio"
            ? "audio/ogg"
            : "video/mp4";
    return {
        key: {
            id: msg.key.id,
            remoteJid: msg.key.remoteJid,
            remoteJidAlt: msg.key.remoteJidAlt,
            participant: msg.key.participant || msg.participant || undefined,
            participantAlt: msg.key.participantAlt,
            fromMe: Boolean(msg.key.fromMe),
        },
        senderJid,
        pushName: msg.pushName || "",
        caption: cleanCaption(mediaInfo.caption),
        type: mediaInfo.type,
        mimetype: mediaInfo.media?.mimetype || fallbackMimetype,
        messageTimestamp: Number(msg.messageTimestamp || Math.floor(Date.now() / 1000)),
        savedAt: Date.now(),
    };
}

function getSenderLabel(record) {
    const senderJid = record?.senderJid || "";
    const label = getJidLabel(senderJid);
    const pushName = String(record?.pushName || "").trim();
    if (pushName && pushName !== label) return `@${label} (${pushName})`;
    return `@${label}`;
}

function getMentions(record) {
    return unique([normalizeMentionJid(record?.senderJid)]);
}

function getLatestDeleteLog(record) {
    const logs = Array.isArray(record?.deleteLogs) ? record.deleteLogs : [];
    return logs[logs.length - 1] || null;
}

function buildSimpleReport(record, title) {
    const latestDelete = getLatestDeleteLog(record);
    const lines = [
        title,
        `Dari: ${getSenderLabel(record)}`,
        `Lokasi: ${getRecordLocation(record)}`,
        `Tipe: ${record?.type || "-"}`,
        `Waktu pesan: ${getTimestampText(record?.messageTimestamp)}`,
    ];

    if (latestDelete) {
        lines.push(`Waktu dihapus: ${getTimestampText(latestDelete.at)}`);
        lines.push(`Sumber delete: ${latestDelete.source || "-"}`);
    } else if (record?.deletePendingAt) {
        lines.push(`Waktu dihapus: ${getTimestampText(record.deletePendingAt)}`);
        lines.push(`Sumber delete: ${record.deleteSource || "-"}`);
    }

    lines.push(
        `Caption: ${record?.caption || "-"}`,
    );

    return lines.join("\n");
}

function getCachedMediaPath(media = {}) {
    const filePath = media.filePath;
    if (!media.available || !filePath) return null;

    const resolvedMediaDir = path.resolve(MEDIA_DIR);
    const resolvedFile = path.resolve(filePath);
    if (!resolvedFile.startsWith(resolvedMediaDir)) return null;
    if (!fs.existsSync(resolvedFile)) return null;
    return resolvedFile;
}

function buildMediaOutbound(record, title) {
    const caption = buildSimpleReport(record, title);
    const mentions = getMentions(record);
    const media = record.media || {};
    const filePath = getCachedMediaPath(media);

    if (filePath && record.type === "image") {
        return {
            image: { url: filePath },
            mimetype: media.mimetype || record.mimetype || "image/jpeg",
            caption,
            mentions,
        };
    }

    if (filePath && record.type === "video") {
        return {
            video: { url: filePath },
            mimetype: media.mimetype || record.mimetype || "video/mp4",
            caption,
            mentions,
        };
    }

    if (filePath && record.type === "audio") {
        return {
            document: { url: filePath },
            mimetype: media.mimetype || record.mimetype || "audio/ogg",
            fileName: `viewonce_${sanitizeFilePart(record.key?.id || Date.now())}.${getMimeExtension(media.mimetype || record.mimetype, "audio")}`,
            caption,
            mentions,
        };
    }

    const reason = media.error ? `\nMedia: gagal dibuka (${media.error})` : "\nMedia: tidak tersedia";
    return {
        text: `${caption}${reason}`,
        mentions,
    };
}

function isMediaReady(record) {
    return Boolean(getCachedMediaPath(record?.media || {}));
}

function isDownloadStillRunning(record) {
    return record?.downloadStatus === "downloading";
}

function buildDeleteLogEntry(record, deleteInfo = {}, at = Date.now()) {
    const targetKey = deleteInfo.targetKey || record?.deleteTargetKey || record?.key || {};
    const mediaPath = getCachedMediaPath(record?.media || {});

    return {
        at,
        source: deleteInfo.source || record?.deleteSource || "unknown",
        dedupeKey: getDeleteDedupeKey(targetKey),
        targetKey: {
            id: targetKey.id || record?.key?.id,
            remoteJid: targetKey.remoteJid || record?.key?.remoteJid,
            participant: targetKey.participant || record?.key?.participant,
            fromMe: targetKey.fromMe,
        },
        senderJid: record?.senderJid || "",
        chatJid: record?.key?.remoteJid || "",
        mediaType: record?.type || "",
        mediaReady: Boolean(mediaPath),
        mediaPath: mediaPath || record?.media?.filePath || "",
        mediaError: record?.media?.error || "",
        caption: record?.caption || "-",
        messageTimestamp: record?.messageTimestamp || null,
    };
}

function refreshDeleteMediaLog(record) {
    if (!record) return record;

    const mediaPath = getCachedMediaPath(record.media || {});
    const update = {
        mediaReady: Boolean(mediaPath),
        mediaPath: mediaPath || record.media?.filePath || "",
        mediaError: record.media?.error || "",
        mediaSize: record.media?.size || null,
        mediaMimetype: record.media?.mimetype || record.mimetype || "",
        downloadStatus: record.downloadStatus || "",
    };

    if (Array.isArray(record.deleteLogs) && record.deleteLogs.length > 0) {
        const lastIndex = record.deleteLogs.length - 1;
        record.deleteLogs[lastIndex] = {
            ...record.deleteLogs[lastIndex],
            ...update,
        };
        record.deletedMediaLog = record.deleteLogs[lastIndex];
    } else if (record.deletedMediaLog) {
        record.deletedMediaLog = {
            ...record.deletedMediaLog,
            ...update,
        };
    }

    return record;
}

function markRecordDeletePending(record, deleteInfo = {}) {
    const now = Date.now();
    record.deletePendingAt = record.deletePendingAt || now;
    record.deleteSource = deleteInfo.source || record.deleteSource || "unknown";
    record.deleteTargetKey = deleteInfo.targetKey || record.deleteTargetKey || record.key;
    const entry = buildDeleteLogEntry(record, deleteInfo, now);
    const logs = Array.isArray(record.deleteLogs) ? record.deleteLogs : [];
    const entryKey = `${entry.dedupeKey || entry.targetKey?.id || record.key?.id}:${entry.source}`;
    const exists = logs.some(item => `${item.dedupeKey || item.targetKey?.id || ""}:${item.source || ""}` === entryKey);
    if (!exists) {
        logs.push(entry);
        record.deleteLogs = logs.slice(-20);
    }
    record.deletedMediaLog = entry;
    record.deletedMediaLogSavedAt = now;
    saveRecord(record);
    console.log("[VIEWONCE2] Log media view-once dihapus tersimpan.", {
        id: record.key?.id,
        remoteJid: record.key?.remoteJid,
        senderJid: record.senderJid,
        type: record.type,
        source: entry.source,
        mediaReady: entry.mediaReady,
        mediaPath: entry.mediaPath || null,
    });
    return record;
}

async function sendOwner(sock, ownerJid, outbound) {
    const targets = [securityMediaLog.getViewOnceLogJid()];
    let lastError = null;

    for (const targetJid of targets) {
        try {
            const sent = await sock.sendMessage(targetJid, outbound);
            debugLog("Berhasil kirim ke grup security log.", { targetJid });
            return sent;
        } catch (error) {
            lastError = error;
            const hasMentions = Array.isArray(outbound?.mentions) && outbound.mentions.length > 0;
            if (hasMentions) {
                try {
                    const fallback = { ...outbound };
                    delete fallback.mentions;
                    return await sock.sendMessage(targetJid, fallback);
                } catch (retryError) {
                    lastError = retryError;
                }
            }

            console.log("[VIEWONCE2] Gagal kirim ke grup security log.", {
                targetJid,
                error: lastError.message,
            });
        }
    }

    throw lastError || new Error("target security log tidak tersedia");
}

async function sendSecurityViewOnceReport(sock, record) {
    const filePath = getCachedMediaPath(record?.media || {});
    return securityMediaLog.sendViewOnceLog(sock, {
        sourceJid: record?.key?.remoteJid,
        senderJid: record?.senderJid,
        messageId: record?.key?.id,
        mediaType: record?.type || "other",
        messageTimestamp: record?.messageTimestamp,
        caption: record?.caption === "-" ? "" : record?.caption,
        media: filePath ? {
            filePath,
            mediaType: record?.type,
            mimetype: record?.media?.mimetype || record?.mimetype,
            fileName: `viewonce_${sanitizeFilePart(record?.key?.id || Date.now())}.${getMimeExtension(record?.media?.mimetype || record?.mimetype, record?.type)}`,
        } : null,
        fromMe: Boolean(record?.key?.fromMe),
    });
}

function getManualViewOnceTargetKey(msg) {
    const reactionKey = msg?.message?.reactionMessage?.key;
    if (reactionKey?.id) {
        return {
            ...reactionKey,
            remoteJid: reactionKey.remoteJid || msg?.key?.remoteJid,
            remoteJidAlt: msg?.key?.remoteJidAlt,
        };
    }

    const message = msg?.message || {};
    const contextInfo = (
        message.extendedTextMessage?.contextInfo
        || message.imageMessage?.contextInfo
        || message.videoMessage?.contextInfo
        || message.documentMessage?.contextInfo
        || message.audioMessage?.contextInfo
        || message.stickerMessage?.contextInfo
    );
    if (!contextInfo?.stanzaId) return null;

    return {
        id: contextInfo.stanzaId,
        remoteJid: contextInfo.remoteJid || msg?.key?.remoteJid,
        remoteJidAlt: msg?.key?.remoteJidAlt,
        participant: contextInfo.participant || msg?.key?.participant,
        participantAlt: msg?.key?.participantAlt,
        fromMe: false,
    };
}

async function handleManualViewOnceFallback(sock, msg, options = {}) {
    const targetKey = getManualViewOnceTargetKey(msg);
    if (!targetKey?.id) return false;
    if (!options.isOwner) return false;
    if (securityMediaLog.isSecurityLogChat(msg?.key?.remoteJid) || securityMediaLog.isSecurityLogChat(msg?.key?.remoteJidAlt)) return true;

    const record = getStoredRecord(targetKey);
    if (!record) return false;
    if (record.key?.fromMe) return true;

    const result = await sendSecurityViewOnceReport(sock, record);
    if (result?.sent) {
        record.openedSentAt = record.openedSentAt || Date.now();
        saveRecord(record);
    }

    console.log("[VIEWONCE2] Manual owner fallback diproses dari cache V2.", {
        build: securityMediaLog.SECURITY_LOG_BUILD,
        targetJid: securityMediaLog.getViewOnceLogJid(),
        id: record.key?.id,
        sourceJid: record.key?.remoteJid,
        sent: Boolean(result?.sent),
        reason: result?.reason || "sent",
    });
    return true;
}

async function cacheMediaFile(buffer, record) {
    ensureMediaDir();

    const extension = getMimeExtension(record.mimetype, record.type);
    const baseName = sanitizeFilePart(`${record.key?.remoteJid || "chat"}_${record.key?.id || Date.now()}`);
    const filePath = path.join(MEDIA_DIR, `${Date.now()}_${baseName}.${extension}`);
    fs.writeFileSync(filePath, buffer);

    return {
        available: true,
        filePath,
        mimetype: record.mimetype,
        size: buffer.length,
        savedAt: Date.now(),
    };
}

async function sendDeleteReport(sock, ownerJid, record) {
    refreshDeleteMediaLog(record);
    if (!record.openedSentAt) {
        const result = await sendSecurityViewOnceReport(sock, record);
        if (result?.sent || result?.reason === "duplicate") record.openedSentAt = Date.now();
        if (!record.openedSentAt) return false;
    }
    record.deletedNotifiedAt = Date.now();
    record.deletedMediaLogSentAt = record.deletedNotifiedAt;
    record.downloadStatus = record.downloadStatus || (isMediaReady(record) ? "ready" : "unknown");
    refreshDeleteMediaLog(record);
    saveRecord(record);

    console.log("[VIEWONCE2] Delete view-once diproses tanpa kiriman ganda.", {
        targetJid: securityMediaLog.getViewOnceLogJid(),
        id: record.key?.id,
        senderJid: record.senderJid,
        type: record.type,
        mediaReady: isMediaReady(record),
    });
    return true;
}

async function flushPendingDeleteReport(sock, ownerJid, record) {
    if (!record?.deletePendingAt || record.deletedNotifiedAt) return false;
    if (!isMediaReady(record) && isDownloadStillRunning(record)) return false;

    return sendDeleteReport(sock, ownerJid, record);
}

async function markRead(sock, msg) {
    if (/^(0|false|off|no)$/i.test(String(process.env.VIEWONCE2_MARK_READ || "true").trim())) return;
    if (typeof sock?.readMessages !== "function" || !msg?.key?.id) return;

    try {
        await sock.readMessages([msg.key]);
    } catch (error) {
        console.log("[VIEWONCE2] Gagal mark read view-once.", {
            id: msg.key?.id,
            remoteJid: msg.key?.remoteJid,
            error: error.message,
        });
    }
}

async function handleIncomingViewOnce(sock, msg, options = {}) {
    if (!isEnabled()) return false;
    if (!msg?.message || !msg?.key?.id || msg.key.fromMe || isStatusJid(msg.key.remoteJid)) return false;
    if (securityMediaLog.isSecurityLogChat(msg.key.remoteJid) || securityMediaLog.isSecurityLogChat(msg.key.remoteJidAlt)) return false;
    if (extractDeleteInfoFromMessage(msg)) {
        debugLog("Abaikan delete signal di fast-lane view-once; akan diproses handler delete.", {
            id: msg.key?.id,
            remoteJid: msg.key?.remoteJid,
            messageTypes: Object.keys(msg.message || {}),
        });
        return false;
    }

    debugLog("Cek pesan masuk.", {
        id: msg.key?.id,
        remoteJid: msg.key?.remoteJid,
        participant: msg.key?.participant || msg.participant,
        fromMe: msg.key?.fromMe,
        messageTypes: Object.keys(msg.message || {}),
    });

    let mediaInfo = viewonce.getViewOnceMediaInfo(msg.message);
    if (!mediaInfo) {
        const fallbackInfo = getFallbackViewOnceMediaInfo(msg.message);
        if (fallbackInfo) {
            mediaInfo = fallbackInfo;
            console.log("[VIEWONCE2] View-once terdeteksi lewat scanner forensic fallback.", {
                id: msg.key?.id,
                remoteJid: msg.key?.remoteJid,
                type: mediaInfo.type,
                source: mediaInfo.source,
                candidate: mediaInfo.forensicCandidate,
            });
        }
    }

    if (!mediaInfo) {
        const candidates = collectMediaCandidatesDeep(msg.message).map(summarizeMediaCandidate);
        const rawDebugPath = writeRawDebugDump(msg, "not-detected-as-viewonce", {
            candidates,
            messageTypes: Object.keys(msg.message || {}),
        });
        debugLog("Pesan bukan view-once media.", {
            id: msg.key?.id,
            messageTypes: Object.keys(msg.message || {}),
            mediaCandidates: candidates,
            rawDebugPath,
        });
        if (rawDebugPath || candidates.length > 0) {
            console.log("[VIEWONCE2] Pesan tidak lolos parser view-once; forensic dump/candidate dibuat.", {
                id: msg.key?.id,
                remoteJid: msg.key?.remoteJid,
                messageTypes: Object.keys(msg.message || {}),
                candidateCount: candidates.length,
                rawDebugPath,
            });
        }
        return false;
    }

    debugLog("View-once terdeteksi, mulai proses cepat.", {
        id: msg.key?.id,
        remoteJid: msg.key?.remoteJid,
        type: mediaInfo.type,
        caption: mediaInfo.caption || "-",
        detector: mediaInfo.source || "standard",
    });

    const pendingDelete = consumePendingDelete(msg.key);
    const existing = getStoredRecord(msg.key);
    const record = existing || makeRecord(msg, mediaInfo);
    record.caption = cleanCaption(record.caption || mediaInfo.caption);
    record.type = record.type || mediaInfo.type;
    record.mimetype = record.mimetype || mediaInfo.media?.mimetype || (record.type === "image" ? "image/jpeg" : record.type === "audio" ? "audio/ogg" : "video/mp4");
    record.detector = record.detector || mediaInfo.source || "standard";
    if (mediaInfo.forensicCandidate) record.forensicCandidate = mediaInfo.forensicCandidate;
    if (pendingDelete && !record.deletedNotifiedAt) markRecordDeletePending(record, pendingDelete);
    saveRecord(record);

    const viewOnceLogEnabled = securityMediaLog.isViewOnceEnabled();
    if (record.openedSentAt) {
        await flushPendingDeleteReport(sock, securityMediaLog.getViewOnceLogJid(), record);
        return true;
    }

    if (isMediaReady(record)) {
        if (viewOnceLogEnabled) {
            const result = await sendSecurityViewOnceReport(sock, record);
            if (result?.sent || result?.reason === "duplicate") record.openedSentAt = Date.now();
            saveRecord(record);
        }
        await flushPendingDeleteReport(sock, securityMediaLog.getViewOnceLogJid(), record);
        return true;
    }

    try {
        record.downloadStatus = "downloading";
        saveRecord(record);
        await markRead(sock, msg);

        debugLog("Mulai download media view-once.", {
            id: record.key.id,
            type: mediaInfo.type,
            streamTypes: getDownloadStreamTypes(mediaInfo),
            detector: mediaInfo.source || "standard",
        });
        const buffer = await downloadViewOnceBuffer(mediaInfo, record);
        if (!buffer?.length) throw new Error("buffer kosong");

        record.media = await cacheMediaFile(buffer, record);
        record.downloadStatus = "ready";
        record.downloadAttempts = record.downloadAttempts || [];
        saveRecord(record);

        debugLog("Media view-once selesai dicache untuk security log.", {
            id: record.key.id,
            size: buffer.length,
            filePath: record.media?.filePath,
        });
        if (viewOnceLogEnabled) {
            const result = await sendSecurityViewOnceReport(sock, record);
            if (result?.sent || result?.reason === "duplicate") record.openedSentAt = Date.now();
        } else {
            record.cachedOnlyAt = Date.now();
        }
        saveRecord(record);
        await flushPendingDeleteReport(sock, securityMediaLog.getViewOnceLogJid(), record);

        console.log(viewOnceLogEnabled ? "[VIEWONCE2] View-once diproses ke security log." : "[VIEWONCE2] View-once dicache; security log sedang OFF.", {
            build: securityMediaLog.SECURITY_LOG_BUILD,
            targetJid: securityMediaLog.getViewOnceLogJid(),
            id: record.key.id,
            senderJid: record.senderJid,
            type: record.type,
            viewOnceLogEnabled,
        });
        return true;
    } catch (error) {
        record.media = {
            available: false,
            error: error.message,
            savedAt: Date.now(),
        };
        record.downloadStatus = "failed";
        record.openError = error.message;
        saveRecord(record);

        if (viewOnceLogEnabled) {
            const result = await sendSecurityViewOnceReport(sock, record).catch(() => null);
            if (result?.sent || result?.reason === "duplicate") record.openedSentAt = Date.now();
            saveRecord(record);
        }
        await flushPendingDeleteReport(sock, securityMediaLog.getViewOnceLogJid(), record).catch(() => {});
        console.log("[VIEWONCE2] Gagal buka view-once otomatis.", {
            id: record.key.id,
            remoteJid: record.key.remoteJid,
            error: error.message,
            detector: mediaInfo.source || "standard",
            downloadAttempts: record.downloadAttempts || [],
        });
        return true;
    }
}

function unwrapMessage(message) {
    let current = message || {};

    for (let i = 0; i < 8; i += 1) {
        if (current?.ephemeralMessage?.message) current = current.ephemeralMessage.message;
        else if (current?.viewOnceMessage?.message) current = current.viewOnceMessage.message;
        else if (current?.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
        else if (current?.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message;
        else if (current?.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
        else break;
    }

    return current || {};
}

function extractProtocolMessage(message) {
    return unwrapMessage(message).protocolMessage || null;
}

function normalizeTargetKey(targetKey = {}, fallbackKey = {}) {
    const remoteJid = targetKey.remoteJid || fallbackKey.remoteJid || targetKey.remoteJidAlt || fallbackKey.remoteJidAlt;
    return {
        id: targetKey.id || fallbackKey.id,
        remoteJid,
        remoteJidAlt: targetKey.remoteJidAlt || fallbackKey.remoteJidAlt,
        participant: targetKey.participant || (isGroupJid(remoteJid) ? fallbackKey.participant : undefined),
        participantAlt: targetKey.participantAlt || fallbackKey.participantAlt,
        fromMe: targetKey.fromMe,
    };
}

function extractDeleteInfoFromMessage(msg) {
    const protocolMessage = extractProtocolMessage(msg?.message);
    if (protocolMessage?.type === PROTOCOL_REVOKE && protocolMessage?.key?.id) {
        return {
            targetKey: normalizeTargetKey(protocolMessage.key, msg.key),
            source: "protocol",
        };
    }

    if ((msg?.messageStubType === STUB_REVOKE || msg?.messageStubType === STUB_ADMIN_REVOKE) && msg?.key?.id) {
        return {
            targetKey: normalizeTargetKey(msg.key, msg.key),
            source: msg.messageStubType === STUB_ADMIN_REVOKE ? "admin-stub" : "stub",
        };
    }

    return null;
}

function extractDeleteInfoFromUpdate(item) {
    const update = item?.update || {};
    if (update.messageStubType !== STUB_REVOKE && update.messageStubType !== STUB_ADMIN_REVOKE) return null;

    return {
        targetKey: normalizeTargetKey(item.key, item.key),
        source: update.messageStubType === STUB_ADMIN_REVOKE ? "admin-update" : "update",
    };
}

function getDeleteDedupeKey(targetKey = {}) {
    return getDeleteDedupeKeys(targetKey)[0] || null;
}

function getDeleteDedupeKeys(targetKey = {}) {
    const id = String(targetKey.id || "").trim();
    if (!id) return [];

    const keys = [
        targetKey.remoteJid && targetKey.participant ? `${targetKey.remoteJid}:${targetKey.participant}:${id}` : null,
        targetKey.remoteJid ? `${targetKey.remoteJid}:${id}` : null,
        targetKey.remoteJidAlt && targetKey.participantAlt ? `${targetKey.remoteJidAlt}:${targetKey.participantAlt}:${id}` : null,
        targetKey.remoteJidAlt ? `${targetKey.remoteJidAlt}:${id}` : null,
        targetKey.participant ? `${targetKey.participant}:${id}` : null,
        targetKey.participantAlt ? `${targetKey.participantAlt}:${id}` : null,
        id,
    ];

    return unique(keys);
}

function markDeleteHandled(targetKey) {
    const keys = getDeleteDedupeKeys(targetKey);
    if (!keys.length) return false;

    const now = Date.now();
    for (const [storedKey, seenAt] of recentDeleteKeys) {
        if (now - seenAt > 2 * 60 * 1000) recentDeleteKeys.delete(storedKey);
    }

    if (keys.some(key => recentDeleteKeys.has(key))) return false;
    for (const key of keys) recentDeleteKeys.set(key, now);
    return true;
}

async function recoverDeletedViewOnceFromCache(sock, deleteInfo, options = {}) {
    const getter = options.getMessageContent || options.getMessage;
    if (typeof getter !== "function" || !deleteInfo?.targetKey?.id) return false;

    let cachedMessage = null;
    try {
        cachedMessage = await getter(deleteInfo.targetKey);
    } catch (error) {
        console.log("[VIEWONCE2] Gagal ambil pesan VO dari cache saat delete.", {
            id: deleteInfo.targetKey.id,
            remoteJid: deleteInfo.targetKey.remoteJid,
            error: error.message,
        });
        return false;
    }

    const mediaInfo = viewonce.getViewOnceMediaInfo(cachedMessage) || getFallbackViewOnceMediaInfo(cachedMessage);
    if (!mediaInfo) {
        const fakeMsg = {
            key: deleteInfo.targetKey,
            message: cachedMessage,
            messageTimestamp: Math.floor(Date.now() / 1000),
        };
        const candidates = collectMediaCandidatesDeep(cachedMessage).map(summarizeMediaCandidate);
        const rawDebugPath = writeRawDebugDump(fakeMsg, "delete-cache-message-not-viewonce", {
            source: deleteInfo.source,
            candidates,
        });
        console.log("[VIEWONCE2] Cache pesan ditemukan saat delete, tapi belum dikenali sebagai view-once.", {
            id: deleteInfo.targetKey.id,
            remoteJid: deleteInfo.targetKey.remoteJid,
            source: deleteInfo.source,
            candidateCount: candidates.length,
            rawDebugPath,
        });
        return false;
    }

    rememberPendingDelete(deleteInfo);
    console.log("[VIEWONCE2] Record belum ada, coba recovery VO dari cache pesan.", {
        id: deleteInfo.targetKey.id,
        remoteJid: deleteInfo.targetKey.remoteJid,
        source: deleteInfo.source,
        mediaType: mediaInfo.type,
        detector: mediaInfo.source || "unknown",
    });

    return handleIncomingViewOnce(sock, {
        key: {
            ...deleteInfo.targetKey,
            fromMe: Boolean(deleteInfo.targetKey.fromMe),
        },
        message: cachedMessage,
        messageTimestamp: Math.floor(Date.now() / 1000),
    }, options);
}

async function handleDeleteInfo(sock, deleteInfo, options = {}) {
    if (!isEnabled() || !deleteInfo?.targetKey?.id) return false;
    if (!securityMediaLog.isViewOnceEnabled()) return false;
    if (securityMediaLog.isSecurityLogChat(deleteInfo.targetKey.remoteJid) || securityMediaLog.isSecurityLogChat(deleteInfo.targetKey.remoteJidAlt)) return true;

    const record = getStoredRecord(deleteInfo.targetKey);
    if (!record) {
        const recovered = await recoverDeletedViewOnceFromCache(sock, deleteInfo, options);
        if (recovered) return true;

        const rawDebugPath = writeDeleteDebugDump(deleteInfo, "delete-signal-record-missing", {
            source: deleteInfo.source,
            note: "Recovery dari cache gagal atau cache tidak punya pesan media target.",
        });
        rememberPendingDelete(deleteInfo);
        console.log("[VIEWONCE2] Delete view-once dicatat sebagai pending; record belum masuk.", {
            id: deleteInfo.targetKey.id,
            remoteJid: deleteInfo.targetKey.remoteJid,
            source: deleteInfo.source,
            rawDebugPath,
            note: "Yang masuk baru sinyal delete/protocol. Media VO asli belum pernah tercache, jadi belum ada file media untuk dilaporkan.",
        });
        return false;
    }

    if (record.key?.fromMe) return true;
    if (record.deletedNotifiedAt) return true;
    if (!markDeleteHandled(deleteInfo.targetKey)) return true;
    markRecordDeletePending(record, deleteInfo);

    if (!isMediaReady(record) && isDownloadStillRunning(record)) {
        console.log("[VIEWONCE2] Delete terdeteksi saat download masih berjalan; laporan ditunda sampai media siap.", {
            id: record.key?.id,
            remoteJid: record.key?.remoteJid,
            source: deleteInfo.source,
        });
        return true;
    }

    try {
        await sendDeleteReport(sock, securityMediaLog.getViewOnceLogJid(), record);
    } catch (error) {
        console.log("[VIEWONCE2] Gagal kirim laporan view-once dihapus.", {
            id: record.key?.id,
            remoteJid: record.key?.remoteJid,
            error: error.message,
        });
    }

    return true;
}

async function handleDeleteSignal(sock, msg, options = {}) {
    const deleteInfo = extractDeleteInfoFromMessage(msg);
    if (!deleteInfo) return false;
    return handleDeleteInfo(sock, deleteInfo, options);
}

async function handleMessageUpdate(sock, item, options = {}) {
    const deleteInfo = extractDeleteInfoFromUpdate(item);
    if (!deleteInfo) return false;
    return handleDeleteInfo(sock, deleteInfo, options);
}

module.exports = {
    handleIncomingViewOnce,
    handleManualViewOnceFallback,
    handleDeleteSignal,
    handleMessageUpdate,
    getStoredRecord,
};
