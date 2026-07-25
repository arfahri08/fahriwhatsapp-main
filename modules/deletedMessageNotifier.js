const fs = require("fs");
const path = require("path");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const securityMediaLog = require("./securityMediaLog");

const STORE_PATH = path.join(__dirname, "../data/deleted_messages.json");
const MEDIA_DIR = path.join(__dirname, "../data/deleted_media");
const STORE_TTL_MS = Number(process.env.DELETED_MESSAGE_TTL_MS || 3 * 24 * 60 * 60 * 1000);
const STORE_LIMIT = Number(process.env.DELETED_MESSAGE_LIMIT || 1000);
const MEMORY_TTL_MS = Number(process.env.DELETED_MESSAGE_MEMORY_TTL_MS || STORE_TTL_MS);
const MEMORY_LIMIT = Number(process.env.DELETED_MESSAGE_MEMORY_LIMIT || STORE_LIMIT);
const GROUP_METADATA_TIMEOUT_MS = Number(process.env.DELETED_MESSAGE_GROUP_METADATA_TIMEOUT_MS || 5000);
const MEDIA_DOWNLOAD_TIMEOUT_MS = Number(process.env.DELETED_MESSAGE_MEDIA_DOWNLOAD_TIMEOUT_MS || 45000);
const MEDIA_MAX_BYTES = Number(process.env.DELETED_MESSAGE_MEDIA_MAX_BYTES || 60 * 1024 * 1024);

const PROTOCOL_REVOKE = 0;
const STUB_REVOKE = 1;
const STUB_ADMIN_REVOKE = 132;

const memoryCache = new Map();
let storeLoaded = false;
let fileStore = {};

function unique(items) {
    return [...new Set((items || []).filter(Boolean))];
}

function safeStringify(value, space) {
    return JSON.stringify(value, (key, item) => typeof item === "bigint" ? item.toString() : item, space);
}

function ensureMediaDir() {
    try {
        if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
    } catch (error) {
        console.log(`[DELETE NOTIFY] Gagal siapkan folder media: ${error.message}`);
    }
}

function sanitizeFilePart(value, fallback = "media") {
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
        "audio/ogg; codecs=opus": "ogg",
        "audio/mpeg": "mp3",
        "audio/mp4": "m4a",
        "audio/aac": "aac",
        "application/pdf": "pdf",
    };

    if (map[clean]) return map[clean];
    const subtype = clean.split("/")[1]?.replace(/[^a-z0-9]+/g, "");
    if (subtype) return subtype.slice(0, 8);

    if (mediaType === "image") return "jpg";
    if (mediaType === "video") return "mp4";
    if (mediaType === "audio") return "ogg";
    if (mediaType === "sticker") return "webp";
    return "bin";
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

function getMediaInfo(message) {
    const current = unwrapMessage(message);

    if (current.imageMessage) {
        return {
            mediaType: "image",
            streamType: "image",
            media: current.imageMessage,
            mimetype: current.imageMessage.mimetype || "image/jpeg",
            caption: firstText(current.imageMessage.caption),
        };
    }

    if (current.videoMessage) {
        return {
            mediaType: "video",
            streamType: "video",
            media: current.videoMessage,
            mimetype: current.videoMessage.mimetype || "video/mp4",
            caption: firstText(current.videoMessage.caption),
        };
    }

    if (current.audioMessage) {
        return {
            mediaType: "audio",
            streamType: "audio",
            media: current.audioMessage,
            mimetype: current.audioMessage.mimetype || "audio/ogg",
            ptt: Boolean(current.audioMessage.ptt),
        };
    }

    if (current.documentMessage) {
        return {
            mediaType: "document",
            streamType: "document",
            media: current.documentMessage,
            mimetype: current.documentMessage.mimetype || "application/octet-stream",
            fileName: firstText(current.documentMessage.fileName, current.documentMessage.title, "dokumen"),
            caption: firstText(current.documentMessage.caption),
        };
    }

    if (current.stickerMessage) {
        return {
            mediaType: "sticker",
            streamType: "sticker",
            media: current.stickerMessage,
            mimetype: current.stickerMessage.mimetype || "image/webp",
            isAnimated: Boolean(current.stickerMessage.isAnimated),
        };
    }

    return null;
}

async function downloadMediaBuffer(mediaInfo) {
    return withTimeout(
        (async () => {
            const stream = await downloadContentFromMessage(
                normalizeDownloadableMedia(mediaInfo.media),
                mediaInfo.streamType
            );
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
        })(),
        MEDIA_DOWNLOAD_TIMEOUT_MS,
        "Deleted media download"
    );
}

async function cacheMediaFile(msg, record) {
    const mediaInfo = getMediaInfo(msg?.message);
    if (!mediaInfo) return null;

    try {
        ensureMediaDir();

        const buffer = await downloadMediaBuffer(mediaInfo);
        if (!buffer?.length) throw new Error("buffer kosong");

        const extension = getMimeExtension(mediaInfo.mimetype, mediaInfo.mediaType);
        const baseName = sanitizeFilePart(`${record.key?.remoteJid || "chat"}_${record.key?.id || Date.now()}`);
        const filePath = path.join(MEDIA_DIR, `${Date.now()}_${baseName}.${extension}`);

        fs.writeFileSync(filePath, buffer);

        return {
            available: true,
            mediaType: mediaInfo.mediaType,
            mimetype: mediaInfo.mimetype,
            fileName: mediaInfo.fileName || path.basename(filePath),
            caption: mediaInfo.caption || "",
            ptt: Boolean(mediaInfo.ptt),
            isAnimated: Boolean(mediaInfo.isAnimated),
            filePath,
            size: buffer.length,
            savedAt: Date.now(),
        };
    } catch (error) {
        console.log("[DELETE NOTIFY] Gagal cache media pesan masuk.", {
            id: record.key?.id,
            remoteJid: record.key?.remoteJid,
            type: mediaInfo.mediaType,
            error: error.message,
        });

        return {
            available: false,
            mediaType: mediaInfo.mediaType,
            mimetype: mediaInfo.mimetype,
            fileName: mediaInfo.fileName || "",
            caption: mediaInfo.caption || "",
            error: error.message,
            savedAt: Date.now(),
        };
    }
}

function ensureStoreLoaded() {
    if (storeLoaded) return;

    try {
        const dir = path.dirname(STORE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(STORE_PATH)) fs.writeFileSync(STORE_PATH, "{}");
        fileStore = JSON.parse(fs.readFileSync(STORE_PATH, "utf8") || "{}");
    } catch (error) {
        console.log(`[DELETE NOTIFY] Gagal baca brankas pesan: ${error.message}`);
        fileStore = {};
    }

    storeLoaded = true;
}

function writeStore() {
    try {
        fs.writeFileSync(STORE_PATH, safeStringify(fileStore, 2));
    } catch (error) {
        console.log(`[DELETE NOTIFY] Gagal tulis brankas pesan: ${error.message}`);
    }
}

function deleteCachedMediaFile(item) {
    const filePath = item?.media?.filePath;
    if (!filePath) return;

    try {
        const resolvedMediaDir = path.resolve(MEDIA_DIR);
        const resolvedFile = path.resolve(filePath);
        if (!resolvedFile.startsWith(resolvedMediaDir)) return;
        if (fs.existsSync(resolvedFile)) fs.unlinkSync(resolvedFile);
    } catch (error) {
        console.log(`[DELETE NOTIFY] Gagal hapus cache media lama: ${error.message}`);
    }
}

function pruneStore(now = Date.now()) {
    ensureStoreLoaded();

    for (const [key, item] of Object.entries(fileStore)) {
        if (!item?.savedAt || now - item.savedAt > STORE_TTL_MS) {
            deleteCachedMediaFile(item);
            delete fileStore[key];
        }
    }

    const entries = Object.entries(fileStore);
    if (entries.length <= STORE_LIMIT) return;

    entries
        .sort((a, b) => (a[1]?.savedAt || 0) - (b[1]?.savedAt || 0))
        .slice(0, entries.length - STORE_LIMIT)
        .forEach(([key, item]) => {
            deleteCachedMediaFile(item);
            delete fileStore[key];
        });
}

function pruneMemory(now = Date.now()) {
    for (const [key, item] of memoryCache) {
        if (!item?.savedAt || now - item.savedAt > MEMORY_TTL_MS) {
            memoryCache.delete(key);
        }
    }

    if (memoryCache.size <= MEMORY_LIMIT) return;

    const overflow = memoryCache.size - MEMORY_LIMIT;
    [...memoryCache.entries()]
        .sort((a, b) => (a[1]?.savedAt || 0) - (b[1]?.savedAt || 0))
        .slice(0, overflow)
        .forEach(([key]) => memoryCache.delete(key));
}

function makeCacheKeys(key = {}) {
    const id = key.id;
    if (!id) return [];

    const remoteJids = unique([key.remoteJid, key.remoteJidAlt]);
    const participants = unique([key.participant, key.participantAlt]);
    const keys = [];

    for (const remoteJid of remoteJids) {
        for (const participant of participants) {
            keys.push(`${remoteJid}:${participant}:${id}`);
        }
        keys.push(`${remoteJid}:${id}`);
    }

    for (const participant of participants) {
        keys.push(`${participant}:${id}`);
    }

    keys.push(id);
    return unique(keys);
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

function getMessageContentTypes(message) {
    return Object.keys(unwrapMessage(message)).filter(key => ![
        "messageContextInfo",
        "senderKeyDistributionMessage",
        "deviceSentMessage",
    ].includes(key));
}

function isDeleteSignal(msg) {
    return Boolean(extractDeleteInfoFromMessage(msg));
}

function isProtocolMessageOnly(message) {
    const current = unwrapMessage(message);
    return Boolean(current.protocolMessage || current.senderKeyDistributionMessage) &&
        getMessageContentTypes(current).every(type => type === "protocolMessage" || type === "senderKeyDistributionMessage");
}

function shorten(text, limit = 3000) {
    const clean = String(text || "").trim();
    if (clean.length <= limit) return clean;
    return `${clean.slice(0, limit - 20)}... (dipotong)`;
}

function firstText(...values) {
    return values.map(value => String(value || "").trim()).find(Boolean) || "";
}

function summarizeMessage(message) {
    const current = unwrapMessage(message);

    if (current.conversation) return { type: "Teks", text: current.conversation };
    if (current.extendedTextMessage?.text) return { type: "Teks", text: current.extendedTextMessage.text };
    if (current.imageMessage) {
        const caption = firstText(current.imageMessage.caption);
        return { type: current.imageMessage.viewOnce ? "View Once Gambar" : "Gambar", text: caption ? `[Gambar]\nCaption: ${caption}` : "[Gambar]" };
    }
    if (current.videoMessage) {
        const caption = firstText(current.videoMessage.caption);
        return { type: current.videoMessage.viewOnce ? "View Once Video" : "Video", text: caption ? `[Video]\nCaption: ${caption}` : "[Video]" };
    }
    if (current.documentMessage) {
        const fileName = firstText(current.documentMessage.fileName, current.documentMessage.title, "dokumen");
        const caption = firstText(current.documentMessage.caption);
        return { type: "Dokumen", text: caption ? `[Dokumen: ${fileName}]\nCaption: ${caption}` : `[Dokumen: ${fileName}]` };
    }
    if (current.audioMessage) return { type: current.audioMessage.ptt ? "Voice Note" : "Audio", text: current.audioMessage.ptt ? "[Voice Note]" : "[Audio]" };
    if (current.stickerMessage) return { type: "Stiker", text: "[Stiker]" };
    if (current.contactMessage) return { type: "Kontak", text: `[Kontak: ${firstText(current.contactMessage.displayName, current.contactMessage.vcard, "-")}]` };
    if (current.contactsArrayMessage) return { type: "Kontak", text: `[Kontak: ${(current.contactsArrayMessage.contacts || []).length || 1} kontak]` };
    if (current.locationMessage) {
        const name = firstText(current.locationMessage.name, current.locationMessage.address);
        return { type: "Lokasi", text: name ? `[Lokasi: ${name}]` : "[Lokasi]" };
    }
    if (current.liveLocationMessage) return { type: "Live Location", text: "[Live Location]" };
    if (current.pollCreationMessage) return { type: "Polling", text: `[Polling: ${firstText(current.pollCreationMessage.name, "-")}]` };
    if (current.reactionMessage) return { type: "Reaction", text: `[Reaction: ${firstText(current.reactionMessage.text, "hapus reaction")}]` };
    if (current.buttonsResponseMessage) return { type: "Button", text: firstText(current.buttonsResponseMessage.selectedDisplayText, current.buttonsResponseMessage.selectedButtonId, "[Button response]") };
    if (current.listResponseMessage) return { type: "List", text: firstText(current.listResponseMessage.title, current.listResponseMessage.singleSelectReply?.selectedRowId, "[List response]") };
    if (current.templateButtonReplyMessage) return { type: "Button", text: firstText(current.templateButtonReplyMessage.selectedDisplayText, current.templateButtonReplyMessage.selectedId, "[Button response]") };

    const types = getMessageContentTypes(current);
    return { type: types[0] || "Tidak diketahui", text: types.length ? `[${types.join(", ")}]` : "[Pesan kosong/tidak didukung]" };
}

function getSenderJidFromRecord(record) {
    const remoteJid = record?.key?.remoteJid;
    if (String(remoteJid || "").endsWith("@g.us")) {
        return record?.key?.participant || record?.participant || remoteJid;
    }

    return record?.key?.participant || remoteJid;
}

function getJidNumber(jid) {
    return String(jid || "").split("@")[0].split(":")[0].split("_")[0].replace(/[^0-9]/g, "");
}

function getJidLabel(jid) {
    return String(jid || "").split("@")[0].split(":")[0].split("_")[0] || "-";
}

function normalizeUserJid(value) {
    const clean = String(value || "").trim();
    if (!clean || clean === "status@broadcast") return null;

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

function getOwnerJid(sock, ownerJids = []) {
    const envOwner = String(process.env.OWNER_JID || process.env.ACTIVE_NOTIFY_JIDS || "")
        .split(",")
        .map(normalizeUserJid)
        .find(Boolean);

    const botId = sock?.user?.id || sock?.authState?.creds?.me?.id || "";
    const botNumber = String(botId).split(":")[0].replace(/[^0-9]/g, "");
    const botJid = botNumber ? `${botNumber}@s.whatsapp.net` : null;

    return ownerJids.map(normalizeUserJid).find(Boolean) || envOwner || botJid;
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

function isSameUser(a, b) {
    const numberA = getJidNumber(a);
    const numberB = getJidNumber(b);
    return Boolean(numberA && numberB && numberA === numberB);
}

function shouldStoreMessage(msg) {
    if (!msg?.key?.id || !msg?.message) return false;
    if (msg.key.fromMe) return false;
    if (msg.key.remoteJid === "status@broadcast") return false;
    if (securityMediaLog.isSecurityLogChat(msg.key.remoteJid) || securityMediaLog.isSecurityLogChat(msg.key.remoteJidAlt)) return false;
    if (isDeleteSignal(msg)) return false;
    if (isProtocolMessageOnly(msg.message)) return false;

    return getMessageContentTypes(msg.message).length > 0;
}

function makeRecord(msg) {
    const summary = summarizeMessage(msg.message);
    const senderJid = String(msg.key?.remoteJid || "").endsWith("@g.us")
        ? (msg.key?.participant || msg.participant || "")
        : (msg.key?.remoteJid || msg.key?.participant || "");

    return {
        key: {
            id: msg.key.id,
            remoteJid: msg.key.remoteJid,
            remoteJidAlt: msg.key.remoteJidAlt,
            participant: msg.key.participant || msg.participant || undefined,
            participantAlt: msg.key.participantAlt || msg.participantAlt || undefined,
            fromMe: Boolean(msg.key.fromMe),
        },
        participant: msg.participant,
        pushName: msg.pushName || "",
        senderJid,
        messageTimestamp: Number(msg.messageTimestamp || Math.floor(Date.now() / 1000)),
        summary: {
            type: summary.type,
            text: shorten(summary.text),
        },
        savedAt: Date.now(),
    };
}

async function cacheIncomingMessage(msg) {
    if (!shouldStoreMessage(msg)) return false;

    ensureStoreLoaded();
    const record = makeRecord(msg);
    record.media = await cacheMediaFile(msg, record);
    const now = record.savedAt;

    for (const key of makeCacheKeys(record.key)) {
        memoryCache.set(key, record);
        fileStore[key] = record;
    }

    pruneMemory(now);
    pruneStore(now);
    writeStore();

    if (process.env.DELETED_MESSAGE_DEBUG === "true") {
        console.log("[DELETE NOTIFY] Pesan masuk tersimpan.", {
            id: record.key.id,
            remoteJid: record.key.remoteJid,
            participant: record.key.participant,
            type: record.summary.type,
        });
    }

    return true;
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

function extractProtocolMessage(message) {
    return unwrapMessage(message).protocolMessage || null;
}

function normalizeTargetKey(targetKey = {}, fallbackKey = {}) {
    const remoteJid = targetKey.remoteJid || fallbackKey.remoteJid || targetKey.remoteJidAlt || fallbackKey.remoteJidAlt;
    return {
        id: targetKey.id || fallbackKey.id,
        remoteJid,
        remoteJidAlt: targetKey.remoteJidAlt || fallbackKey.remoteJidAlt,
        participant: targetKey.participant || (String(remoteJid || "").endsWith("@g.us") ? fallbackKey.participant : undefined),
        participantAlt: targetKey.participantAlt || fallbackKey.participantAlt,
        fromMe: targetKey.fromMe,
    };
}

function extractDeleteInfoFromMessage(msg) {
    const protocolMessage = extractProtocolMessage(msg?.message);
    if (protocolMessage?.type === PROTOCOL_REVOKE && protocolMessage?.key?.id) {
        return {
            targetKey: normalizeTargetKey(protocolMessage.key, msg.key),
            actorKey: {
                ...(msg.key || {}),
                invokerJid: protocolMessage.invokerJid,
            },
            source: "protocol",
            deletedAt: Number(msg.messageTimestamp || 0) || Date.now(),
        };
    }

    if ((msg?.messageStubType === STUB_REVOKE || msg?.messageStubType === STUB_ADMIN_REVOKE) && msg?.key?.id) {
        return {
            targetKey: normalizeTargetKey(msg.key, msg.key),
            actorKey: msg.key,
            source: msg.messageStubType === STUB_ADMIN_REVOKE ? "admin-stub" : "stub",
            deletedAt: Number(msg.messageTimestamp || 0) || Date.now(),
        };
    }

    return null;
}

function extractDeleteInfoFromUpdate(item) {
    const update = item?.update || {};
    if (update.messageStubType !== STUB_REVOKE && update.messageStubType !== STUB_ADMIN_REVOKE) return null;

    return {
        targetKey: normalizeTargetKey(item.key, item.key),
        actorKey: update.key || item.key,
        source: update.messageStubType === STUB_ADMIN_REVOKE ? "admin-update" : "update",
        deletedAt: Number(update.messageTimestamp || item.messageTimestamp || 0) || Date.now(),
    };
}

function getActorJid(deleteInfo, record) {
    const actorKey = deleteInfo?.actorKey || {};
    const remoteJid = actorKey.remoteJid || record?.key?.remoteJid;

    if (actorKey.invokerJid) return actorKey.invokerJid;
    if (String(remoteJid || "").endsWith("@g.us")) return actorKey.participant || "";
    return actorKey.participant || remoteJid || "";
}

function getRecordLocation(record, groupSubject) {
    const remoteJid = record?.key?.remoteJid || "";
    if (String(remoteJid).endsWith("@g.us")) {
        return groupSubject ? `Grup: ${groupSubject}` : `Grup: ${remoteJid}`;
    }
    return "Private Chat";
}

function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
    });

    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

async function getGroupSubject(sock, remoteJid) {
    if (!String(remoteJid || "").endsWith("@g.us") || typeof sock?.groupMetadata !== "function") return "";

    try {
        const metadata = await withTimeout(
            sock.groupMetadata(remoteJid),
            GROUP_METADATA_TIMEOUT_MS,
            "Deleted message group metadata"
        );
        return metadata?.subject || "";
    } catch (error) {
        console.log("[DELETE NOTIFY] Gagal ambil metadata grup.", {
            remoteJid,
            error: error.message,
        });
        return "";
    }
}

function buildReport(record, deleteInfo, groupSubject) {
    const senderJid = record.senderJid || getSenderJidFromRecord(record);
    const senderLabel = record.pushName || getJidLabel(senderJid);
    const senderMention = normalizeMentionJid(senderJid);
    const actorJid = getActorJid(deleteInfo, record);
    const actorText = actorJid && !isSameUser(actorJid, senderJid)
        ? `\nDihapus oleh: @${getJidLabel(actorJid)}`
        : "";

    const mentions = unique([
        senderMention,
        actorText ? normalizeMentionJid(actorJid) : null,
    ]);

    return {
        text:
            `*PESAN DIHAPUS TERDETEKSI*\n` +
            `==============================\n\n` +
            `Pengirim: @${getJidLabel(senderJid)}${record.pushName ? ` (${senderLabel})` : ""}\n` +
            `Lokasi: ${getRecordLocation(record, groupSubject)}\n` +
            `Tipe: ${record.summary?.type || "-"}\n` +
            `Waktu pesan: ${getTimestampText(record.messageTimestamp)}${actorText}\n\n` +
            `Isi pesan:\n${record.summary?.text || "-"}\n\n` +
            `==============================\n` +
            `Sumber: Brankas pesan terhapus`,
        mentions,
    };
}

async function sendReport(sock, ownerJid, outbound) {
    const targetJid = securityMediaLog.getAntiDeleteLogJid();
    try {
        return await sock.sendMessage(targetJid, outbound);
    } catch (error) {
        const hasMentions = Array.isArray(outbound?.mentions) && outbound.mentions.length > 0;
        if (!hasMentions) throw error;

        console.log("[DELETE NOTIFY] Kirim dengan mention gagal, retry tanpa mentions.", {
            targetJid,
            mentionJids: outbound.mentions,
            error: error.message,
        });

        const fallback = { ...outbound };
        delete fallback.mentions;
        return sock.sendMessage(targetJid, fallback);
    }
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

function buildMediaCaption(record, deleteInfo, groupSubject) {
    const senderJid = record.senderJid || getSenderJidFromRecord(record);
    const actorJid = getActorJid(deleteInfo, record);
    const actorText = actorJid && !isSameUser(actorJid, senderJid)
        ? `Dihapus oleh: @${getJidLabel(actorJid)}`
        : "";
    const caption = firstText(record.media?.caption);
    const lines = [
        "*PESAN DIHAPUS TERDETEKSI*",
        `Pengirim: @${getJidLabel(senderJid)}`,
        `Lokasi: ${getRecordLocation(record, groupSubject)}`,
        `Tipe: ${record.summary?.type || record.media?.mediaType || "-"}`,
        `Waktu pesan: ${getTimestampText(record.messageTimestamp)}`,
    ];

    if (actorText) lines.push(actorText);

    if (caption) {
        lines.push("");
        lines.push(`Caption asli:\n${caption}`);
    }

    lines.push("");
    lines.push("Sumber: Brankas pesan terhapus");

    return lines.join("\n");
}

function buildCachedMediaOutbound(record, deleteInfo, groupSubject) {
    const media = record.media || {};
    const filePath = getCachedMediaPath(media);
    if (!filePath) return null;

    const senderJid = record.senderJid || getSenderJidFromRecord(record);
    const actorJid = getActorJid(deleteInfo, record);
    const mentions = unique([
        normalizeMentionJid(senderJid),
        actorJid && !isSameUser(actorJid, senderJid) ? normalizeMentionJid(actorJid) : null,
    ]);
    const caption = buildMediaCaption(record, deleteInfo, groupSubject);

    if (media.mediaType === "image") {
        return {
            image: { url: filePath },
            caption,
            mimetype: media.mimetype || "image/jpeg",
            mentions,
        };
    }

    if (media.mediaType === "video") {
        return {
            video: { url: filePath },
            caption,
            mimetype: media.mimetype || "video/mp4",
            mentions,
        };
    }

    if (media.mediaType === "audio") {
        return {
            document: { url: filePath },
            mimetype: media.mimetype || "audio/ogg",
            fileName: media.fileName || path.basename(filePath),
            caption,
            mentions,
        };
    }

    if (media.mediaType === "sticker") {
        return {
            document: { url: filePath },
            mimetype: media.mimetype || "image/webp",
            fileName: media.fileName || path.basename(filePath),
            caption,
            mentions,
        };
    }

    if (media.mediaType === "document") {
        return {
            document: { url: filePath },
            mimetype: media.mimetype || "application/octet-stream",
            fileName: media.fileName || path.basename(filePath),
            caption,
            mentions,
        };
    }

    return null;
}

async function sendCachedMediaReport(sock, ownerJid, record, deleteInfo, groupSubject) {
    const outbound = buildCachedMediaOutbound(record, deleteInfo, groupSubject);
    if (!outbound) {
        return false;
    }

    try {
        await sendReport(sock, ownerJid, outbound);
        return true;
    } catch (error) {
        console.log("[DELETE NOTIFY] Gagal kirim media pesan dihapus.", {
            ownerJid,
            id: record.key?.id,
            type: record.media?.mediaType,
            error: error.message,
        });
        if (record.media) record.media.sendError = error.message;
        return false;
    }
}

const recentDeleteKeys = new Map();

function markDeleteHandled(targetKey) {
    const keys = makeCacheKeys(targetKey);
    if (!keys.length) return false;

    const now = Date.now();
    for (const [storedKey, seenAt] of recentDeleteKeys) {
        if (now - seenAt > 2 * 60 * 1000) recentDeleteKeys.delete(storedKey);
    }

    if (keys.some(key => recentDeleteKeys.has(key))) return false;
    for (const key of keys) recentDeleteKeys.set(key, now);
    return true;
}

async function handleDeleteInfo(sock, deleteInfo, options = {}) {
    if (!deleteInfo?.targetKey?.id) return false;
    if (securityMediaLog.isSecurityLogChat(deleteInfo.targetKey.remoteJid) || securityMediaLog.isSecurityLogChat(deleteInfo.targetKey.remoteJidAlt)) return true;
    if (!markDeleteHandled(deleteInfo.targetKey)) return true;

    const record = getStoredRecord(deleteInfo.targetKey);
    if (!record) {
        console.log("[DELETE NOTIFY] Pesan dihapus, tapi tidak ada di brankas.", {
            id: deleteInfo.targetKey.id,
            remoteJid: deleteInfo.targetKey.remoteJid,
            participant: deleteInfo.targetKey.participant,
            source: deleteInfo.source,
        });
        return true;
    }

    if (record.key?.fromMe) return true;

    const groupSubject = await getGroupSubject(sock, record.key?.remoteJid);
    const cachedMediaPath = getCachedMediaPath(record.media || {});
    const media = record.media ? {
        ...record.media,
        filePath: cachedMediaPath,
    } : null;
    const mediaType = String(record.media?.mediaType || record.summary?.type || "other")
        .toLowerCase()
        .replace("teks", "text")
        .replace("gambar", "image")
        .replace("video", "video")
        .replace("voice note", "audio")
        .replace("dokumen", "document")
        .replace("stiker", "sticker");
    const result = await securityMediaLog.sendAntiDeleteLog(sock, {
        sourceJid: record.key?.remoteJid,
        sourceName: groupSubject || undefined,
        senderJid: record.senderJid || getSenderJidFromRecord(record),
        messageId: record.key?.id,
        messageType: mediaType,
        messageTimestamp: record.messageTimestamp,
        deletedAt: deleteInfo.deletedAt || Date.now(),
        text: record.media?.caption || record.summary?.text,
        caption: record.media?.caption,
        media,
        fromMe: Boolean(record.key?.fromMe),
    });

    console.log("[DELETE NOTIFY] Laporan pesan dihapus diproses untuk security log.", {
        build: securityMediaLog.SECURITY_LOG_BUILD,
        targetJid: securityMediaLog.getAntiDeleteLogJid(),
        id: record.key?.id,
        remoteJid: record.key?.remoteJid,
        senderJid: record.senderJid,
        type: record.summary?.type,
        hasMedia: Boolean(record.media?.available),
        sent: Boolean(result?.sent),
        reason: result?.reason || "sent",
    });
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
    cacheIncomingMessage,
    handleDeleteSignal,
    handleMessageUpdate,
    isDeleteSignal,
    summarizeMessage,
};
