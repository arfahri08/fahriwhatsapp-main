const { downloadContentFromMessage } = require("@whiskeysockets/baileys");

const DOWNLOAD_TIMEOUT_MS = Number(process.env.MEDIA_INTAKE_DOWNLOAD_TIMEOUT_MS || 45000);
const MEDIA_MAX_BYTES = Number(process.env.MEDIA_INTAKE_MAX_BYTES || 60 * 1024 * 1024);
const DEDUPE_TTL_MS = Number(process.env.MEDIA_INTAKE_DEDUPE_TTL_MS || 10 * 60 * 1000);
const DEDUPE_LIMIT = Number(process.env.MEDIA_INTAKE_DEDUPE_LIMIT || 2000);

const seenMessageIds = new Map();

function isEnabled() {
    const configured = process.env.INCOMING_MEDIA_LOGGER_ENABLED ?? process.env.MEDIA_INTAKE_LOG_ENABLED ?? "false";
    return /^(1|true|on|yes)$/i.test(String(configured).trim());
}

function shouldLogAllMedia() {
    return /^(1|true|on|yes)$/i.test(String(process.env.MEDIA_INTAKE_LOG_ALL_MEDIA || "false").trim());
}

function isStatusJid(jid) {
    return String(jid || "").trim().toLowerCase() === "status@broadcast";
}

function isGroupJid(jid) {
    return String(jid || "").endsWith("@g.us");
}

function unique(items) {
    return [...new Set((items || []).filter(Boolean))];
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

function getJidLabel(jid) {
    return String(jid || "").split("@")[0].split(":")[0].split("_")[0] || "-";
}

function getSenderJid(msg) {
    const remoteJid = msg?.key?.remoteJid || "";
    if (isGroupJid(remoteJid)) return msg?.key?.participant || msg?.participant || remoteJid;
    return msg?.key?.participant || remoteJid;
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

function getOwnerJids(sock, ownerJids = []) {
    const envOwners = [
        process.env.MEDIA_INTAKE_OWNER_JID,
        process.env.VIEWONCE2_OWNER_JID,
        process.env.OWNER_JID,
        process.env.ACTIVE_NOTIFY_JIDS,
    ]
        .filter(Boolean)
        .join(",")
        .split(",")
        .map(item => String(item || "").trim())
        .filter(Boolean);

    const botId = sock?.user?.id || sock?.authState?.creds?.me?.id || "";
    const botNumber = String(botId).split(":")[0].replace(/[^0-9]/g, "");
    const botJid = botNumber ? `${botNumber}@s.whatsapp.net` : null;

    return unique([
        ...ownerJids,
        ...envOwners,
        botJid,
    ].map(normalizeOwnerJid).filter(Boolean));
}

function normalizeOwnerJid(value) {
    const clean = String(value || "").trim();
    if (!clean) return null;
    if (clean.endsWith("@s.whatsapp.net")) return clean;

    const number = clean.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
    return number ? `${number}@s.whatsapp.net` : null;
}

function getMessageDedupeKey(msg, mediaInfo) {
    const key = msg?.key || {};
    if (!key.id) return null;
    return [
        key.remoteJid || "",
        key.participant || msg?.participant || "",
        key.id,
        mediaInfo?.path || mediaInfo?.type || "",
    ].join(":");
}

function markSeen(key) {
    if (!key) return true;

    const now = Date.now();
    for (const [storedKey, seenAt] of seenMessageIds) {
        if (now - seenAt > DEDUPE_TTL_MS) seenMessageIds.delete(storedKey);
    }

    if (seenMessageIds.has(key)) return false;
    seenMessageIds.set(key, now);

    while (seenMessageIds.size > DEDUPE_LIMIT) {
        const oldestKey = seenMessageIds.keys().next().value;
        if (!oldestKey) break;
        seenMessageIds.delete(oldestKey);
    }

    return true;
}

function isViewOncePath(pathParts) {
    return pathParts.some(part => /viewonce/i.test(String(part || "")));
}

function isSkippableTraversalKey(key) {
    return /^(contextInfo|quotedMessage|jpegThumbnail|thumbnail|scansSidecar|mediaKey|fileSha256|fileEncSha256)$/i.test(key);
}

function makeMediaInfo(type, streamType, media, pathParts, fallback = {}) {
    const mimetype = media?.mimetype || fallback.mimetype || "application/octet-stream";
    return {
        type,
        streamType,
        media,
        path: pathParts.join(".") || type,
        viewOnce: Boolean(media?.viewOnce || fallback.viewOnce || isViewOncePath(pathParts)),
        caption: String(media?.caption || fallback.caption || "").trim(),
        mimetype,
        fileName: media?.fileName || media?.title || fallback.fileName || "",
        ptt: Boolean(media?.ptt),
        isAnimated: Boolean(media?.isAnimated),
    };
}

function findIncomingMedia(message, pathParts = [], inViewOnce = false, depth = 0, seen = new Set()) {
    if (!message || typeof message !== "object" || depth > 14 || seen.has(message)) return null;
    seen.add(message);

    if (message.imageMessage) {
        return makeMediaInfo("image", "image", message.imageMessage, [...pathParts, "imageMessage"], {
            viewOnce: inViewOnce,
            mimetype: "image/jpeg",
        });
    }

    if (message.videoMessage || message.ptvMessage) {
        const media = message.videoMessage || message.ptvMessage;
        return makeMediaInfo("video", "video", media, [...pathParts, message.videoMessage ? "videoMessage" : "ptvMessage"], {
            viewOnce: inViewOnce,
            mimetype: "video/mp4",
        });
    }

    if (message.audioMessage) {
        return makeMediaInfo("audio", "audio", message.audioMessage, [...pathParts, "audioMessage"], {
            viewOnce: inViewOnce,
            mimetype: "audio/ogg",
        });
    }

    if (message.documentMessage) {
        return makeMediaInfo("document", "document", message.documentMessage, [...pathParts, "documentMessage"], {
            viewOnce: inViewOnce,
            mimetype: "application/octet-stream",
        });
    }

    if (message.stickerMessage) {
        return makeMediaInfo("sticker", "sticker", message.stickerMessage, [...pathParts, "stickerMessage"], {
            viewOnce: inViewOnce,
            mimetype: "image/webp",
        });
    }

    for (const [key, child] of Object.entries(message)) {
        if (!child || typeof child !== "object" || isSkippableTraversalKey(key)) continue;

        const childInViewOnce = inViewOnce || /viewonce/i.test(key) || message.viewOnce === true;
        if (Array.isArray(child)) {
            for (let index = 0; index < child.length; index += 1) {
                const found = findIncomingMedia(child[index], [...pathParts, `${key}[${index}]`], childInViewOnce, depth + 1, seen);
                if (found) return found;
            }
            continue;
        }

        const found = findIncomingMedia(child, [...pathParts, key], childInViewOnce, depth + 1, seen);
        if (found) return found;
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
        DOWNLOAD_TIMEOUT_MS,
        "Incoming media logger download"
    );
}

function buildCaption(msg, mediaInfo, bufferSize) {
    const senderJid = getSenderJid(msg);
    const remoteJid = msg?.key?.remoteJid || "";
    const lines = [
        mediaInfo.viewOnce ? "*MEDIA VIEW-ONCE MASUK*" : "*MEDIA MASUK*",
        `Pengirim: @${getJidLabel(senderJid)}`,
        `Lokasi: ${isGroupJid(remoteJid) ? `Grup ${getJidLabel(remoteJid)}` : `Chat ${getJidLabel(remoteJid)}`}`,
        `Tipe: ${mediaInfo.type}${mediaInfo.viewOnce ? " (view-once)" : ""}`,
        `Path detector: ${mediaInfo.path}`,
        `Waktu: ${getTimestampText(msg?.messageTimestamp || Math.floor(Date.now() / 1000))}`,
        `Ukuran: ${Math.round((bufferSize || 0) / 1024)}KB`,
    ];

    if (mediaInfo.caption) {
        lines.push("");
        lines.push(`Caption asli:\n${mediaInfo.caption}`);
    }

    return lines.join("\n");
}

function buildOutbound(buffer, mediaInfo, caption) {
    if (mediaInfo.type === "image") {
        return {
            image: buffer,
            mimetype: mediaInfo.mimetype || "image/jpeg",
            caption,
        };
    }

    if (mediaInfo.type === "video") {
        return {
            video: buffer,
            mimetype: mediaInfo.mimetype || "video/mp4",
            caption,
        };
    }

    return {
        document: buffer,
        mimetype: mediaInfo.mimetype || "application/octet-stream",
        fileName: mediaInfo.fileName || `media-${Date.now()}.${mediaInfo.type === "sticker" ? "webp" : "bin"}`,
        caption,
    };
}

async function sendOwner(sock, ownerJids, outbound) {
    const targets = getOwnerJids(sock, ownerJids);
    if (targets.length === 0) throw new Error("owner JID tidak ditemukan");

    let lastError = null;
    for (const targetJid of targets) {
        try {
            return await sock.sendMessage(targetJid, outbound);
        } catch (error) {
            lastError = error;
            console.log("[MEDIA INTAKE] Gagal kirim log media ke owner, coba target lain.", {
                targetJid,
                error: error.message,
            });
        }
    }

    throw lastError || new Error("gagal kirim ke semua owner");
}

async function handleIncomingMedia(sock, msg, options = {}) {
    if (!isEnabled()) return false;
    if (!msg?.message || !msg?.key?.id || msg.key.fromMe || isStatusJid(msg.key.remoteJid)) return false;

    const mediaInfo = findIncomingMedia(msg.message);
    if (!mediaInfo) return false;
    if (mediaInfo.viewOnce) {
        console.log("[MEDIA INTAKE] View Once dilewati; delivery dimiliki viewonce2/security log.", {
            id: msg.key.id,
            remoteJid: msg.key.remoteJid,
            detectorPath: mediaInfo.path,
        });
        return false;
    }
    if (!mediaInfo.viewOnce && !shouldLogAllMedia()) return false;

    const dedupeKey = getMessageDedupeKey(msg, mediaInfo);
    if (!markSeen(dedupeKey)) return true;

    try {
        const buffer = await downloadMediaBuffer(mediaInfo);
        if (!buffer?.length) throw new Error("buffer kosong");

        const caption = buildCaption(msg, mediaInfo, buffer.length);
        await sendOwner(sock, options.ownerJids || [], buildOutbound(buffer, mediaInfo, caption));

        console.log("[MEDIA INTAKE] Media masuk berhasil dikirim ke owner.", {
            id: msg.key.id,
            remoteJid: msg.key.remoteJid,
            type: mediaInfo.type,
            viewOnce: mediaInfo.viewOnce,
            detectorPath: mediaInfo.path,
            size: buffer.length,
        });
        return true;
    } catch (error) {
        console.log("[MEDIA INTAKE] Gagal proses media masuk.", {
            id: msg.key.id,
            remoteJid: msg.key.remoteJid,
            type: mediaInfo.type,
            viewOnce: mediaInfo.viewOnce,
            detectorPath: mediaInfo.path,
            error: error.message,
        });
        return false;
    }
}

module.exports = {
    handleIncomingMedia,
    findIncomingMedia,
};
