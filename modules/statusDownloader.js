const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");
const { extractContactTargets, normalizeNumber } = require("./botBlocklistManager");

const STATUS_BROADCAST_JID = "status@broadcast";
const CACHE_FILE = process.env.STATUS_DOWNLOADER_CACHE_FILE
    ? path.resolve(process.env.STATUS_DOWNLOADER_CACHE_FILE)
    : path.join(__dirname, "../data/statusDownloaderCache.json");
const SESSION_TTL_MS = Number(process.env.STATUS_DOWNLOADER_SESSION_TTL_MS || 3 * 60 * 1000);
const STATUS_CACHE_TTL_MS = Number(process.env.STATUS_DOWNLOADER_CACHE_TTL_MS || 26 * 60 * 60 * 1000);
const STATUS_DOWNLOAD_TIMEOUT_MS = Number(process.env.STATUS_DOWNLOADER_TIMEOUT_MS || 45 * 1000);
const MAX_STATUS_PER_CONTACT = Number(process.env.STATUS_DOWNLOADER_MAX_PER_CONTACT || 60);
const STATUS_DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.STATUS_DOWNLOADER_DEBUG || "").trim());

const sessions = new Map();
const statusCache = new Map();
let cacheLoaded = false;
let saveTimer = null;

function unique(values) {
    return [...new Set((values || []).filter(value => value !== null && value !== undefined && value !== ""))];
}

function getJidNumber(value) {
    return String(value || "").split("@")[0].split(":")[0].split("_")[0].replace(/[^0-9]/g, "");
}

function normalizeTargetNumber(value) {
    return normalizeNumber(value) || null;
}

function isStatusBroadcastJid(jid) {
    return String(jid || "").trim().toLowerCase() === STATUS_BROADCAST_JID;
}

function isPrivateUserJid(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@s.whatsapp.net");
}

function isLidJid(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@lid");
}

function normalizeLidJid(value) {
    const clean = String(value || "").trim();
    if (!/@lid$/i.test(clean)) return null;

    const number = getJidNumber(clean);
    return number ? `${number}@lid` : null;
}

function normalizeTargetJid(value) {
    const clean = String(value || "").trim();
    if (!clean) return null;

    if (isStatusBroadcastJid(clean)) return null;

    const lidJid = normalizeLidJid(clean);
    if (lidJid) return lidJid;

    if (clean.includes("@")) {
        const number = normalizeTargetNumber(clean);
        return number ? `${number}@s.whatsapp.net` : null;
    }

    const number = normalizeTargetNumber(clean);
    return number ? `${number}@s.whatsapp.net` : null;
}

function getStatusLookupKeys(value) {
    const keys = [];
    const add = item => {
        const clean = String(item || "").trim().toLowerCase();
        if (!clean || clean === STATUS_BROADCAST_JID || clean.endsWith("@broadcast")) return;
        if (!keys.includes(clean)) keys.push(clean);
    };

    const jid = normalizeTargetJid(value);
    const number = normalizeTargetNumber(value);

    if (number) {
        add(number);
        add(`${number}@s.whatsapp.net`);
    }

    if (jid) {
        add(jid);
        const jidNumber = getJidNumber(jid);
        if (isPrivateUserJid(jid) && jidNumber) add(jidNumber);
        if (isLidJid(jid)) add(jid);
    }

    return keys;
}

function getSessionKey(msg, from) {
    const chatJid = from || msg?.key?.remoteJid || "";
    const senderJid = String(chatJid).endsWith("@g.us")
        ? (msg?.key?.participant || msg?.participant || chatJid)
        : chatJid;

    return `${chatJid}:${senderJid}`;
}

function pruneSessions(now = Date.now()) {
    for (const [key, session] of sessions) {
        if (!session?.expiresAt || session.expiresAt < now) {
            sessions.delete(key);
        }
    }
}

function toTimestampMs(value) {
    if (!value) return Date.now();
    if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
    if (typeof value === "bigint") return Number(value) * 1000;
    if (typeof value?.toNumber === "function") return value.toNumber() * 1000;
    if (typeof value?.low === "number") return value.low * 1000;

    const parsed = Number(value);
    return Number.isFinite(parsed) ? (parsed > 10_000_000_000 ? parsed : parsed * 1000) : Date.now();
}

function logStatusDebug(stage, details = {}) {
    if (!STATUS_DEBUG) return;
    console.log("[STATUS DOWNLOADER]", {
        stage,
        remoteJid: details.remoteJid,
        participant: details.participant,
        messageId: details.messageId,
        type: details.type,
        ownerKeys: details.ownerKeys,
        reason: details.reason,
        errorMessage: details.error?.message || details.errorMessage,
    });
}

function ensureCacheFile() {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    if (!fs.existsSync(CACHE_FILE)) {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({
            version: 1,
            updatedAt: new Date().toISOString(),
            cache: {},
        }, null, 2));
    }
}

function serializeStatusCache() {
    const cache = {};
    for (const [key, items] of statusCache) {
        if (Array.isArray(items) && items.length > 0) cache[key] = items;
    }

    return {
        version: 1,
        updatedAt: new Date().toISOString(),
        ttlMs: STATUS_CACHE_TTL_MS,
        cache,
    };
}

function statusCacheJsonReplacer(_key, value) {
    if (typeof value === "bigint") return Number(value);
    return value;
}

function saveStatusCacheNow() {
    try {
        ensureCacheFile();
        fs.writeFileSync(CACHE_FILE, JSON.stringify(serializeStatusCache(), statusCacheJsonReplacer, 2));
    } catch (error) {
        logStatusDebug("save-cache-failed", { error });
    }
}

function scheduleSaveStatusCache() {
    if (saveTimer) return;

    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveStatusCacheNow();
    }, 600);

    if (typeof saveTimer.unref === "function") saveTimer.unref();
}

function loadStatusCache() {
    if (cacheLoaded) return;
    cacheLoaded = true;

    try {
        ensureCacheFile();
        const raw = fs.readFileSync(CACHE_FILE, "utf8");
        const parsed = JSON.parse(raw);
        const cache = parsed && typeof parsed.cache === "object" ? parsed.cache : {};

        statusCache.clear();
        for (const [key, items] of Object.entries(cache)) {
            const cleanKey = String(key || "").trim().toLowerCase();
            if (!cleanKey || !Array.isArray(items)) continue;
            statusCache.set(cleanKey, items.filter(item => item?.id));
        }

        pruneStatusCache();
    } catch (error) {
        logStatusDebug("load-cache-failed", { error });
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
        else if (current?.deviceSentMessage?.message) current = current.deviceSentMessage.message;
        else if (current?.editedMessage?.message) current = current.editedMessage.message;
        else break;
    }

    return current;
}

function getStatusInfo(msg) {
    const message = unwrapMessage(msg?.message || {});
    const image = message.imageMessage;
    const video = message.videoMessage || message.ptvMessage;
    const audio = message.audioMessage;
    const text = String(
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.buttonsResponseMessage?.selectedDisplayText ||
        message.listResponseMessage?.title ||
        ""
    ).trim();

    if (image) {
        return {
            type: "image",
            media: image,
            caption: String(image.caption || "").trim(),
            mimetype: image.mimetype || "image/jpeg",
        };
    }

    if (video) {
        return {
            type: "video",
            media: video,
            caption: String(video.caption || "").trim(),
            mimetype: video.mimetype || "video/mp4",
        };
    }

    if (audio) {
        return {
            type: "audio",
            media: audio,
            caption: "",
            mimetype: audio.mimetype || "audio/mpeg",
        };
    }

    if (text) {
        return {
            type: "text",
            text,
            caption: text,
            mimetype: "",
        };
    }

    return null;
}

function getStatusOwnerCandidates(msg) {
    const message = unwrapMessage(msg?.message || {});
    const contextInfo =
        message.extendedTextMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.ptvMessage?.contextInfo ||
        message.audioMessage?.contextInfo ||
        {};

    return unique([
        msg?.key?.participant,
        msg?.participant,
        contextInfo.participant,
        contextInfo.remoteJid,
        message.senderKeyDistributionMessage?.groupId,
    ]).filter(value => {
        const clean = String(value || "").trim().toLowerCase();
        return clean && clean !== STATUS_BROADCAST_JID && !clean.endsWith("@broadcast");
    });
}

function getStatusOwnerIdentity(msg) {
    const candidates = getStatusOwnerCandidates(msg);
    const keys = unique(candidates.flatMap(getStatusLookupKeys));
    const ownerJid = candidates.map(normalizeTargetJid).find(Boolean) || "";
    const ownerNumber = candidates.map(normalizeTargetNumber).find(Boolean) || getJidNumber(ownerJid);

    if (!keys.length) return null;

    return {
        ownerJid,
        ownerNumber,
        ownerKeys: keys,
    };
}

function getStatusItemDedupeKey(item) {
    return `${item?.ownerJid || item?.ownerNumber || "-"}:${item?.id || "-"}`;
}

function addStatusItemToKey(cacheKey, item, now) {
    const existing = statusCache.get(cacheKey) || [];
    const dedupeKey = getStatusItemDedupeKey(item);
    if (existing.some(existingItem => getStatusItemDedupeKey(existingItem) === dedupeKey)) return false;

    const next = [...existing, item]
        .filter(entry => entry?.createdAt && now - entry.createdAt <= STATUS_CACHE_TTL_MS)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .slice(-Math.max(1, MAX_STATUS_PER_CONTACT));

    statusCache.set(cacheKey, next);
    return true;
}

function pruneStatusCache(now = Date.now()) {
    loadStatusCache();
    let changed = false;

    for (const [number, items] of statusCache) {
        const fresh = (items || []).filter(item => item?.createdAt && now - item.createdAt <= STATUS_CACHE_TTL_MS);
        if (fresh.length > 0) {
            if (fresh.length !== (items || []).length) changed = true;
            statusCache.set(number, fresh);
        } else {
            statusCache.delete(number);
            changed = true;
        }
    }

    if (changed) scheduleSaveStatusCache();
}

function rememberStatus(msg) {
    loadStatusCache();

    if (msg?.key?.remoteJid !== STATUS_BROADCAST_JID || !msg?.message) return false;

    const ownerIdentity = getStatusOwnerIdentity(msg);
    if (!ownerIdentity) {
        logStatusDebug("skip-no-owner", {
            remoteJid: msg?.key?.remoteJid,
            participant: msg?.key?.participant || msg?.participant,
            messageId: msg?.key?.id,
            reason: "participant status kosong/tidak valid",
        });
        return false;
    }

    const statusInfo = getStatusInfo(msg);
    if (!statusInfo) {
        logStatusDebug("skip-unsupported-message", {
            remoteJid: msg?.key?.remoteJid,
            participant: msg?.key?.participant || msg?.participant,
            messageId: msg?.key?.id,
            reason: Object.keys(unwrapMessage(msg?.message || {})).join(",") || "empty",
        });
        return false;
    }

    const id = msg.key.id || `${ownerIdentity.ownerKeys[0]}:${Date.now()}`;
    const now = Date.now();
    pruneStatusCache(now);

    const item = {
        id,
        key: msg.key,
        ownerJid: ownerIdentity.ownerJid,
        ownerNumber: ownerIdentity.ownerNumber,
        ownerKeys: ownerIdentity.ownerKeys,
        pushName: msg.pushName || "",
        createdAt: toTimestampMs(msg.messageTimestamp) || now,
        cachedAt: now,
        ...statusInfo,
    };

    let saved = false;
    for (const key of ownerIdentity.ownerKeys) {
        if (addStatusItemToKey(key, item, now)) saved = true;
    }

    if (saved) {
        saveStatusCacheNow();
        logStatusDebug("saved", {
            remoteJid: msg?.key?.remoteJid,
            participant: msg?.key?.participant || msg?.participant,
            messageId: msg?.key?.id,
            type: statusInfo.type,
            ownerKeys: ownerIdentity.ownerKeys,
        });
    } else {
        logStatusDebug("skip-duplicate", {
            remoteJid: msg?.key?.remoteJid,
            participant: msg?.key?.participant || msg?.participant,
            messageId: msg?.key?.id,
            type: statusInfo.type,
            ownerKeys: ownerIdentity.ownerKeys,
        });
    }

    return saved;
}

function getCachedStatuses(targetJid) {
    loadStatusCache();
    pruneStatusCache();

    const keys = getStatusLookupKeys(targetJid);
    if (!keys.length) return [];

    const seen = new Set();
    const merged = [];
    for (const key of keys) {
        for (const item of statusCache.get(key) || []) {
            const dedupeKey = getStatusItemDedupeKey(item);
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            merged.push(item);
        }
    }

    return merged
        .filter(item => item?.id)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function formatTime(timestamp) {
    try {
        return new Date(timestamp || Date.now()).toLocaleString("id-ID", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return "-";
    }
}

function getTypeLabel(type) {
    if (type === "image") return "Foto";
    if (type === "video") return "Video";
    if (type === "audio") return "Audio";
    if (type === "text") return "Teks";
    return "Media";
}

function summarizeCaption(item) {
    const caption = String(item?.caption || item?.text || "").replace(/\s+/g, " ").trim();
    if (!caption) return "";
    return caption.length > 45 ? `${caption.slice(0, 42)}...` : caption;
}

function formatStatusList(target, statuses) {
    const lines = statuses.map((item, index) => {
        const caption = summarizeCaption(item);
        const captionText = caption ? ` - "${caption}"` : "";
        return `${index + 1}. ${getTypeLabel(item.type)} - ${formatTime(item.createdAt)}${captionText}`;
    });

    return [
        `Status tersimpan untuk ${target.label || target.number || target.jid}:`,
        "",
        ...lines,
        "",
        "Ketik nomor yang mau didownload.",
        "Contoh: 1,2,5",
        "Ketik .batal untuk batal.",
    ].join("\n");
}

function parseCommand(text) {
    const clean = String(text || "").trim();
    if (!clean) return null;

    if (/^\.status$/i.test(clean)) return { command: ".status", args: "" };

    const direct = clean.match(/^\.statusdl(?:\s+([\s\S]+))?$/i);
    if (direct) return { command: ".statusdl", args: (direct[1] || "").trim() };

    const statusWithTarget = clean.match(/^\.status\s+((?:[\d+().\-\s]{7,}|[0-9A-Za-z._:-]+@(?:s\.whatsapp\.net|lid)))$/i);
    if (statusWithTarget) return { command: ".status", args: statusWithTarget[1].trim() };

    return null;
}

function extractTextTarget(text, args = "") {
    const raw = String(args || text || "").trim();
    const jid = normalizeTargetJid(raw);
    const number = normalizeTargetNumber(raw) || (isPrivateUserJid(jid) ? getJidNumber(jid) : "");
    if (!jid && !number) return null;

    return {
        number,
        jid: jid || `${number}@s.whatsapp.net`,
        label: number || jid,
        source: "text",
    };
}

function extractTarget(msg, text, args = "") {
    const contactTargets = extractContactTargets(msg);
    if (contactTargets.length > 0) return contactTargets[0];

    return extractTextTarget(text, args);
}

function parseSelection(text, total) {
    const clean = String(text || "").trim().toLowerCase();
    if (!clean) return { indexes: [], invalid: ["kosong"] };

    if (["all", "semua", "*"].includes(clean)) {
        return {
            indexes: Array.from({ length: total }, (_, index) => index),
            invalid: [],
        };
    }

    const indexes = [];
    const invalid = [];
    const parts = clean.split(/[,\s]+/).filter(Boolean);

    for (const part of parts) {
        const range = part.match(/^(\d+)-(\d+)$/);
        if (range) {
            const start = Number(range[1]);
            const end = Number(range[2]);
            if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > total) {
                invalid.push(part);
                continue;
            }

            for (let value = start; value <= end; value += 1) {
                indexes.push(value - 1);
            }
            continue;
        }

        const value = Number(part);
        if (!Number.isInteger(value) || value < 1 || value > total) {
            invalid.push(part);
            continue;
        }

        indexes.push(value - 1);
    }

    return {
        indexes: unique(indexes),
        invalid,
    };
}

function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout setelah ${timeoutMs}ms`)), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
    });

    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
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

async function downloadBuffer(item) {
    return withTimeout(
        (async () => {
            const stream = await downloadContentFromMessage(normalizeDownloadableMedia(item.media), item.type);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            return Buffer.concat(chunks);
        })(),
        STATUS_DOWNLOAD_TIMEOUT_MS,
        "Download status"
    );
}

function formatDownloadCaption(item, target, listNumber) {
    const caption = String(item.caption || "").trim();
    return [
        `Status ${listNumber} dari ${target.label || target.number || target.jid}`,
        `Tipe: ${getTypeLabel(item.type)}`,
        caption ? `Caption: ${caption}` : "",
    ].filter(Boolean).join("\n");
}

async function sendStatusItem(sock, from, item, target, listNumber, quoted) {
    if (item.type === "text") {
        await sock.sendMessage(from, {
            text: [
                `Status teks ${listNumber} dari ${target.label || target.number || target.jid}:`,
                "",
                item.text || item.caption || "-",
            ].join("\n"),
        }, { quoted });
        return true;
    }

    const buffer = await downloadBuffer(item);
    if (!buffer?.length) throw new Error("buffer kosong");

    if (item.type === "image") {
        await sock.sendMessage(from, {
            image: buffer,
            caption: formatDownloadCaption(item, target, listNumber),
            mimetype: item.mimetype || "image/jpeg",
        }, { quoted });
        return true;
    }

    if (item.type === "video") {
        await sock.sendMessage(from, {
            video: buffer,
            caption: formatDownloadCaption(item, target, listNumber),
            mimetype: item.mimetype || "video/mp4",
        }, { quoted });
        return true;
    }

    if (item.type === "audio") {
        await sock.sendMessage(from, {
            audio: buffer,
            mimetype: item.mimetype || "audio/mpeg",
            ptt: false,
        }, { quoted });
        return true;
    }

    return false;
}

async function startContactWait(sock, msg, context, command) {
    const from = context.from || msg?.key?.remoteJid;
    const key = getSessionKey(msg, from);

    const target = command.args ? extractTarget(msg, context.text, command.args) : null;
    if (target) {
        sessions.set(key, {
            key,
            from,
            step: "awaiting_selection",
            target,
            statuses: getCachedStatuses(target.jid),
            expiresAt: Date.now() + SESSION_TTL_MS,
        });
        return sendStatusOptions(sock, msg, context, key);
    }

    sessions.set(key, {
        key,
        from,
        step: "awaiting_contact",
        expiresAt: Date.now() + SESSION_TTL_MS,
    });

    await sock.sendMessage(from, {
        text:
            "Kirim kontak orang yang statusnya mau didownload.\n" +
            "Bot akan cek status yang sudah tersimpan sejak bot online.\n" +
            "Kalau batal, ketik .batal.",
    }, { quoted: msg });
    return true;
}

async function sendStatusOptions(sock, msg, context, key) {
    const session = sessions.get(key);
    const from = session?.from || context.from || msg?.key?.remoteJid;
    if (!session?.target) return false;

    const statuses = getCachedStatuses(session.target.jid);
    if (!statuses.length) {
        sessions.delete(key);
        await sock.sendMessage(from, {
            text:
                `Belum ada status tersimpan untuk ${session.target.label || session.target.number || session.target.jid}.\n\n` +
                "Catatan: bot cuma bisa download status yang sudah masuk ke bot sejak bot online dan masih bisa diakses.",
        }, { quoted: msg });
        return true;
    }

    session.step = "awaiting_selection";
    session.statuses = statuses;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(key, session);

    await sock.sendMessage(from, { text: formatStatusList(session.target, statuses) }, { quoted: msg });
    return true;
}

async function handleContactInput(sock, msg, context, session, key) {
    const from = session.from || context.from || msg?.key?.remoteJid;
    const target = extractTarget(msg, context.text);

    if (!target) {
        await sock.sendMessage(from, {
            text: "Yang dikirim belum kebaca sebagai kontak WhatsApp valid. Kirim kontak target, nomor target, atau ketik .batal.",
        }, { quoted: msg });
        return true;
    }

    session.target = target;
    session.step = "awaiting_selection";
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(key, session);
    return sendStatusOptions(sock, msg, context, key);
}

async function handleSelectionInput(sock, msg, context, session, key) {
    const from = session.from || context.from || msg?.key?.remoteJid;
    const statuses = session.statuses || [];
    const selection = parseSelection(context.text, statuses.length);

    if (!selection.indexes.length || selection.invalid.length) {
        await sock.sendMessage(from, {
            text:
                `Pilihan belum valid. Pilih angka 1 sampai ${statuses.length}.\n` +
                "Contoh: 1,2,5\n" +
                "Ketik semua untuk download semuanya, atau .batal untuk batal.",
        }, { quoted: msg });
        return true;
    }

    sessions.delete(key);
    await sock.sendMessage(from, {
        text: `Memproses ${selection.indexes.length} status. Tunggu sebentar...`,
    }, { quoted: msg });

    let sent = 0;
    const failed = [];
    for (const index of selection.indexes) {
        const item = statuses[index];
        if (!item) continue;

        try {
            await sendStatusItem(sock, from, item, session.target, index + 1, msg);
            sent += 1;
        } catch (error) {
            failed.push(`${index + 1}: ${error.message}`);
            console.log("[STATUS DOWNLOADER] Gagal kirim status", {
                index: index + 1,
                target: session.target?.jid,
                statusId: item.id,
                type: item.type,
                error: error.message,
            });
        }
    }

    if (failed.length) {
        await sock.sendMessage(from, {
            text:
                `Selesai dengan sebagian gagal.\n` +
                `Berhasil: ${sent}\n` +
                `Gagal: ${failed.join(", ")}\n\n` +
                "Biasanya ini terjadi kalau media status sudah expired atau WhatsApp menolak download ulang.",
        });
    }

    return true;
}

async function handleStatusDownloader(sock, msg, context = {}) {
    if (!context.isOwner) return false;

    pruneSessions();

    const from = context.from || msg?.key?.remoteJid;
    if (!from || from === STATUS_BROADCAST_JID || !msg?.message) return false;

    const key = getSessionKey(msg, from);
    const text = String(context.text || "").trim();
    const lowerText = text.toLowerCase();
    const session = sessions.get(key);

    if (session) {
        if (lowerText === ".batal" || lowerText === ".cancel") {
            sessions.delete(key);
            await sock.sendMessage(from, { text: "Download status dibatalkan." }, { quoted: msg });
            return true;
        }

        if (session.step === "awaiting_contact") {
            return handleContactInput(sock, msg, context, session, key);
        }

        if (session.step === "awaiting_selection") {
            return handleSelectionInput(sock, msg, context, session, key);
        }
    }

    const command = parseCommand(text);
    if (!command) return false;

    return startContactWait(sock, msg, context, command);
}

module.exports = {
    rememberStatus,
    handleStatusDownloader,
    getCachedStatuses,
    parseSelection,
};
