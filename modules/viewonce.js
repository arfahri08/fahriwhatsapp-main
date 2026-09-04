const { downloadContentFromMessage, jidNormalizedUser } = require("@whiskeysockets/baileys");
const db = require("./database");
const securityMediaLog = require("./securityMediaLog");

const DOWNLOAD_TIMEOUT_MS = Number(process.env.VIEWONCE_DOWNLOAD_TIMEOUT_MS || 45000);
const GROUP_METADATA_TIMEOUT_MS = Number(process.env.VIEWONCE_GROUP_METADATA_TIMEOUT_MS || 6000);
const MEMORY_CACHE_TTL_MS = Number(process.env.VIEWONCE_MEMORY_TTL_MS || 6 * 60 * 60 * 1000);
const MEMORY_CACHE_LIMIT = Number(process.env.VIEWONCE_MEMORY_LIMIT || 300);

const viewOnceMemoryCache = new Map();

const HELP_CONFIG = {
    name: "👁️ View Once Downloader",
    desc: "🔐 Simpan view-once ke brankas. Owner bisa reply/react untuk membongkar view-once image/video.",
};

function unique(items) {
    return [...new Set((items || []).filter(Boolean))];
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

function unwrapViewOnce(message) {
    if (!message || typeof message !== "object") return { isViewOnce: false, content: null };

    let current = message;
    for (let i = 0; i < 8; i += 1) {
        if (current?.ephemeralMessage?.message) current = current.ephemeralMessage.message;
        else if (current?.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
        else break;
    }

    const wrapped =
        current.viewOnceMessage?.message ||
        current.viewOnceMessageV2?.message ||
        current.viewOnceMessageV2Extension?.message;

    if (wrapped) return { isViewOnce: true, content: wrapped };

    const directViewOnce =
        current.imageMessage?.viewOnce === true ||
        current.videoMessage?.viewOnce === true;

    return {
        isViewOnce: directViewOnce,
        content: current,
    };
}

function getViewOnceMediaInfo(message) {
    const unwrapped = unwrapViewOnce(message);
    const deepMatch = unwrapped.isViewOnce ? null : findViewOnceMediaDeep(message);
    if (!unwrapped.isViewOnce && !deepMatch) return null;

    const content = deepMatch?.content || unwrapped.content;
    const image = content?.imageMessage;
    const video = content?.videoMessage || content?.ptvMessage;
    if (!image && !video) return null;

    return {
        content,
        media: image || video,
        type: image ? "image" : "video",
        caption: image?.caption || video?.caption || "-",
        source: deepMatch?.source || "standard",
    };
}

function findViewOnceMediaDeep(value, path = [], inViewOnceWrapper = false, depth = 0, seen = new Set()) {
    if (!value || typeof value !== "object" || depth > 12 || seen.has(value)) return null;
    seen.add(value);

    const image = value.imageMessage;
    const video = value.videoMessage || value.ptvMessage;
    const media = image || video;
    const currentIsViewOnce = inViewOnceWrapper ||
        value.viewOnce === true ||
        image?.viewOnce === true ||
        video?.viewOnce === true;

    if (media && currentIsViewOnce) {
        return {
            content: value,
            source: `deep:${path.join(".") || "root"}`,
        };
    }

    for (const [key, child] of Object.entries(value)) {
        if (!child || typeof child !== "object") continue;
        // quotedMessage hanyalah referensi ke pesan asli. Jangan menganggap media
        // view-once di dalam reply sebagai view-once baru milik pengirim reply.
        // Saat owner membuka reply, resolveReplyTarget tetap mengambil pesan asli
        // dari brankas dan memprosesnya sebagai root message terpisah.
        if (/^(?:contextInfo|quotedMessage)$/i.test(key)) continue;
        const childInViewOnce = currentIsViewOnce || /viewonce/i.test(key);

        if (Array.isArray(child)) {
            for (let index = 0; index < child.length; index += 1) {
                const found = findViewOnceMediaDeep(child[index], [...path, `${key}[${index}]`], childInViewOnce, depth + 1, seen);
                if (found) return found;
            }
            continue;
        }

        const found = findViewOnceMediaDeep(child, [...path, key], childInViewOnce, depth + 1, seen);
        if (found) return found;
    }

    return null;
}

function hasViewOnceMedia(message) {
    return Boolean(getViewOnceMediaInfo(message));
}

function makeCacheKeys(msg) {
    const id = msg?.key?.id;
    const remoteJid = msg?.key?.remoteJid;
    const participant = msg?.key?.participant || msg?.participant;
    if (!id) return [];

    return unique([
        id,
        remoteJid ? `${remoteJid}:${id}` : null,
        participant ? `${participant}:${id}` : null,
        remoteJid && participant ? `${remoteJid}:${participant}:${id}` : null,
    ]);
}

function pruneMemoryCache(now = Date.now()) {
    for (const [key, item] of viewOnceMemoryCache) {
        if (!item?.savedAt || now - item.savedAt > MEMORY_CACHE_TTL_MS) {
            viewOnceMemoryCache.delete(key);
        }
    }

    if (viewOnceMemoryCache.size <= MEMORY_CACHE_LIMIT) return;

    const overflow = viewOnceMemoryCache.size - MEMORY_CACHE_LIMIT;
    [...viewOnceMemoryCache.entries()]
        .sort((a, b) => (a[1]?.savedAt || 0) - (b[1]?.savedAt || 0))
        .slice(0, overflow)
        .forEach(([key]) => viewOnceMemoryCache.delete(key));
}

function cacheIncomingViewOnce(msg) {
    if (!msg?.key?.id || !hasViewOnceMedia(msg.message)) return false;

    const item = { msg, savedAt: Date.now() };
    for (const key of makeCacheKeys(msg)) {
        viewOnceMemoryCache.set(key, item);
    }
    pruneMemoryCache(item.savedAt);
    return true;
}

function getCachedViewOnce(id, remoteJid, participant) {
    if (!id) return null;
    pruneMemoryCache();

    const keys = unique([
        remoteJid && participant ? `${remoteJid}:${participant}:${id}` : null,
        remoteJid ? `${remoteJid}:${id}` : null,
        participant ? `${participant}:${id}` : null,
        id,
    ]);

    for (const key of keys) {
        const cached = viewOnceMemoryCache.get(key);
        if (cached?.msg) return cached.msg;
    }

    return null;
}

async function getStoredViewOnce(id, remoteJid, participant) {
    const cached = getCachedViewOnce(id, remoteJid, participant);
    if (cached) return cached;

    if (typeof db?.getViewOnce !== "function") return null;

    const keys = unique([
        remoteJid && participant ? `${remoteJid}:${participant}:${id}` : null,
        remoteJid ? `${remoteJid}:${id}` : null,
        participant ? `${participant}:${id}` : null,
        id,
    ]);

    for (const key of keys) {
        const stored = await db.getViewOnce(key);
        if (stored?.message) {
            cacheIncomingViewOnce(stored);
            return stored;
        }
    }

    return null;
}

async function getExternalCachedMessage(options, key) {
    const getter = options?.getMessageContent || options?.getMessage;
    if (typeof getter !== "function") return null;

    try {
        return await getter(key);
    } catch (error) {
        console.log("⚠️ [ViewOnce] Gagal ambil target dari cache pesan.", {
            id: key?.id,
            remoteJid: key?.remoteJid,
            participant: key?.participant,
            error: error.message,
        });
        return null;
    }
}

function saveIncomingViewOnce(msg) {
    if (!msg?.key?.id || msg.key.remoteJid === "status@broadcast") {
        return false;
    }

    if (!hasViewOnceMedia(msg.message)) return false;

    cacheIncomingViewOnce(msg);
    for (const key of makeCacheKeys(msg)) {
        db.saveViewOnce(key, msg);
    }

    console.log("🔐 [ViewOnce] View-once berhasil tersimpan ke brankas.", {
        id: msg.key.id,
        remoteJid: msg.key.remoteJid,
        participant: msg.key.participant || msg.participant,
    });
    return true;
}

function getQuotedContext(msg) {
    const message = msg?.message || {};
    return (
        message.extendedTextMessage?.contextInfo ||
        message.stickerMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.documentMessage?.contextInfo ||
        message.audioMessage?.contextInfo
    );
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

function isLidJid(value) {
    return String(value || "").trim().toLowerCase().endsWith("@lid");
}

function normalizeLidJid(value) {
    const clean = String(value || "").trim();
    if (!isLidJid(clean)) return null;

    const number = clean.split("@")[0].split(":")[0].split("_")[0].replace(/[^0-9]/g, "");
    return number ? `${number}@lid` : null;
}

function normalizeMentionJid(value) {
    return normalizeUserJid(value) || normalizeLidJid(value);
}

function getJidLabel(jid) {
    return String(jid || "").split("@")[0].split(":")[0].split("_")[0] || "-";
}

function getJidNumber(jid) {
    return String(jid || "").split("@")[0].split(":")[0].split("_")[0].replace(/[^0-9]/g, "");
}

function getSenderJidFromTargetKey(targetKey) {
    const remoteJid = targetKey?.remoteJid || "";
    if (remoteJid.endsWith("@g.us")) return targetKey?.participant || remoteJid;
    return remoteJid;
}

function normalizeContactJid(jid) {
    if (!jid) return null;

    try {
        return jidNormalizedUser(jid);
    } catch {
        const user = String(jid).split("@")[0].split(":")[0];
        return user ? `${user}@s.whatsapp.net` : null;
    }
}

function isPrivateSenderJid(jid) {
    const value = String(jid || "").trim().toLowerCase();
    return value.endsWith("@s.whatsapp.net") || value.endsWith("@lid");
}

function getTriggerSenderCandidates(msg) {
    const isGroup = String(msg?.key?.remoteJid || "").endsWith("@g.us");

    return unique([
        msg?.key?.participant,
        msg?.participant,
        isGroup ? null : msg?.key?.remoteJid,
    ]).filter(isPrivateSenderJid);
}

function hasOwnerNumber(jids, ownerNumbers) {
    const numbers = unique((jids || []).map(getJidNumber)).filter(Boolean);
    return numbers.some(number => ownerNumbers.includes(number));
}

async function isOwnerTrigger(sock, msg, ownerJids = []) {
    if (msg?.key?.fromMe) return true;

    const ownerNumbers = unique(ownerJids.map(getJidNumber)).filter(Boolean);
    if (!ownerNumbers.length) return false;

    const senderCandidates = getTriggerSenderCandidates(msg);
    if (hasOwnerNumber(senderCandidates, ownerNumbers)) return true;

    const remoteJid = msg?.key?.remoteJid || "";
    if (!remoteJid.endsWith("@g.us") || typeof sock?.groupMetadata !== "function") return false;

    try {
        const metadata = await withTimeout(
            sock.groupMetadata(remoteJid),
            GROUP_METADATA_TIMEOUT_MS,
            "ViewOnce owner group metadata"
        );
        const senderPn = findParticipantPnFromMetadata(metadata, senderCandidates);
        return hasOwnerNumber([senderPn], ownerNumbers);
    } catch (error) {
        console.log("⚠️ [ViewOnce] Gagal cek owner dari metadata grup.", {
            remoteJid,
            senderCandidates,
            error: error.message,
        });
        return false;
    }
}

function sanitizeMentionLabel(value) {
    const clean = String(value || "")
        .trim()
        .replace(/^@+/, "")
        .replace(/\s+/g, "_")
        .replace(/[^\w.\-]/g, "");

    return clean || null;
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

function getTargetFromStoredMessage(storedMsg, extra = {}) {
    const targetMsg =
        storedMsg?.message?.viewOnceMessage?.message ||
        storedMsg?.message?.viewOnceMessageV2?.message ||
        storedMsg?.message?.viewOnceMessageV2Extension?.message ||
        storedMsg?.message?.ephemeralMessage?.message ||
        storedMsg?.message;

    return {
        targetMsg,
        targetKey: {
            ...(storedMsg?.key || {}),
            contextParticipant: extra.contextParticipant || undefined,
        },
        targetPushName: storedMsg?.pushName || extra.pushName || "",
    };
}

async function resolveReactionTarget(msg) {
    const reactionKey = msg.message?.reactionMessage?.key;
    const targetId = reactionKey?.id;
    if (!targetId) return null;

    console.log("[ViewOnce] React/emoji terdeteksi.", {
        targetId,
        targetRemoteJid: reactionKey.remoteJid,
        targetParticipant: reactionKey.participant,
    });

    const cachedMsg = await getStoredViewOnce(
        targetId,
        reactionKey.remoteJid || msg.key?.remoteJid,
        reactionKey.participant || msg.key?.participant
    );

    if (!cachedMsg?.message) {
        console.log("📭 [ViewOnce] Target react tidak ada di brankas.", { targetId });
        return null;
    }

    console.log("✅ [ViewOnce] Target react ditemukan di brankas.");
    return getTargetFromStoredMessage(cachedMsg, {
        contextParticipant: reactionKey.participant,
    });
}

async function resolveReplyTarget(msg, options = {}) {
    const contextInfo = getQuotedContext(msg);
    if (!contextInfo?.quotedMessage && !contextInfo?.stanzaId) return null;

    console.log("[ViewOnce] Reply/quoted terdeteksi.", {
        stanzaId: contextInfo.stanzaId,
        remoteJid: contextInfo.remoteJid,
        participant: contextInfo.participant,
        hasQuotedMessage: Boolean(contextInfo.quotedMessage),
    });

    const remoteCandidates = unique([
        contextInfo.remoteJid,
        msg.key?.remoteJid,
    ]);
    if (!remoteCandidates.length) remoteCandidates.push(undefined);

    const participantCandidates = [
        ...unique([
            contextInfo.participant,
            msg.key?.participant,
            msg.participant,
        ]),
        undefined,
    ];

    if (contextInfo.stanzaId) {
        for (const remoteJid of remoteCandidates) {
            for (const participant of participantCandidates) {
                const cachedMsg = await getStoredViewOnce(
                    contextInfo.stanzaId,
                    remoteJid,
                    participant
                );

                if (cachedMsg?.message) {
                    console.log("✅ [ViewOnce] Target reply ditemukan di brankas.");
                    return getTargetFromStoredMessage(cachedMsg, {
                        contextParticipant: contextInfo.participant || participant,
                    });
                }
            }
        }

        for (const remoteJid of remoteCandidates) {
            for (const participant of participantCandidates) {
                const cachedMessage = await getExternalCachedMessage(options, {
                    remoteJid,
                    participant,
                    id: contextInfo.stanzaId,
                });

                if (hasViewOnceMedia(cachedMessage)) {
                    const storedLikeMsg = {
                        key: {
                            remoteJid,
                            participant,
                            id: contextInfo.stanzaId,
                        },
                        message: cachedMessage,
                    };

                    cacheIncomingViewOnce(storedLikeMsg);
                    console.log("✅ [ViewOnce] Target reply ditemukan di cache pesan.");
                    return getTargetFromStoredMessage(storedLikeMsg, {
                        contextParticipant: contextInfo.participant || participant,
                    });
                }
            }
        }
    }

    const fallbackRemoteJid = remoteCandidates[0] || msg.key?.remoteJid;
    const fallbackParticipant = contextInfo.participant || msg.key?.participant || msg.participant || fallbackRemoteJid;

    return {
        targetMsg: contextInfo.quotedMessage,
        targetKey: {
            remoteJid: fallbackRemoteJid,
            participant: fallbackParticipant,
            contextParticipant: contextInfo.participant || fallbackParticipant,
            id: contextInfo.stanzaId,
        },
        targetPushName: "",
    };
}

function getSenderCandidateJids(resolved, msg, targetRemoteJid, isGroup) {
    const contextInfo = getQuotedContext(msg);
    const reactionKey = msg?.message?.reactionMessage?.key;
    const targetSenderJid = isGroup ? getSenderJidFromTargetKey(resolved?.targetKey) : null;

    return unique([
        targetSenderJid,
        resolved?.targetKey?.contextParticipant,
        reactionKey?.participant,
        contextInfo?.participant,
        resolved?.targetKey?.participant,
        isGroup ? null : targetRemoteJid,
    ]).filter(Boolean);
}

function findParticipantPnFromMetadata(metadata, candidates) {
    const candidateSet = new Set(candidates.map(value => String(value || "").toLowerCase()).filter(Boolean));
    const candidateLids = new Set(candidates.map(normalizeLidJid).filter(Boolean).map(value => value.toLowerCase()));
    const candidatePns = new Set(candidates.map(normalizeUserJid).filter(Boolean).map(value => value.toLowerCase()));

    for (const participant of metadata?.participants || []) {
        const fields = [
            participant.id,
            participant.jid,
            participant.lid,
            participant.phoneNumber,
            participant.phoneNumberJid,
            participant.pn,
            participant.pnJid,
        ].filter(Boolean);

        const normalizedFields = fields.map(value => String(value).toLowerCase());
        const normalizedFieldLids = fields.map(normalizeLidJid).filter(Boolean).map(value => value.toLowerCase());
        const normalizedFieldPns = fields.map(normalizeUserJid).filter(Boolean).map(value => value.toLowerCase());
        const hasCandidate =
            normalizedFields.some(value => candidateSet.has(value)) ||
            normalizedFieldLids.some(value => candidateLids.has(value)) ||
            normalizedFieldPns.some(value => candidatePns.has(value));
        if (!hasCandidate) continue;

        const pn = fields.map(normalizeUserJid).find(Boolean);
        if (pn) return pn;
    }

    return null;
}

async function resolveSenderForMention(sock, resolved, msg, targetRemoteJid, isGroup) {
    const candidates = getSenderCandidateJids(resolved, msg, targetRemoteJid, isGroup);

    const directCandidates = isGroup ? candidates.map(normalizeContactJid) : candidates;
    const directPn = directCandidates.map(normalizeUserJid).find(Boolean);
    if (directPn) {
        return {
            mentionJid: directPn,
            label: getJidLabel(directPn),
            rawJid: directPn,
            source: "pn-candidate",
        };
    }

    if (isGroup && typeof sock?.groupMetadata === "function") {
        try {
            const metadata = await withTimeout(
                sock.groupMetadata(targetRemoteJid),
                GROUP_METADATA_TIMEOUT_MS,
                "ViewOnce group metadata"
            );
            const metadataPn = findParticipantPnFromMetadata(metadata, candidates);
            if (metadataPn) {
                return {
                    mentionJid: metadataPn,
                    label: getJidLabel(metadataPn),
                    rawJid: metadataPn,
                    source: "group-metadata",
                };
            }
        } catch (error) {
            console.log("⚠️ [ViewOnce] Gagal resolve participant dari metadata grup.", {
                remoteJid: targetRemoteJid,
                candidates,
                error: error.message,
            });
        }
    }

    const lidJid = candidates.map(normalizeLidJid).find(Boolean);
    const fallbackJid = lidJid || normalizeMentionJid(targetRemoteJid);
    const fallbackName = sanitizeMentionLabel(resolved?.targetPushName);
    const fallbackLabel = fallbackName || getJidLabel(fallbackJid);

    return {
        mentionJid: fallbackJid,
        label: fallbackLabel,
        rawJid: fallbackJid || candidates[0] || targetRemoteJid,
        source: lidJid ? "lid-fallback" : "fallback",
    };
}

async function downloadViewOnceBuffer(media, type) {
    return withTimeout(
        (async () => {
            const stream = await downloadContentFromMessage(normalizeDownloadableMedia(media), type);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            return Buffer.concat(chunks);
        })(),
        DOWNLOAD_TIMEOUT_MS,
        "Download view-once"
    );
}

async function sendViewOnceResult(sock, ownerJid, outbound, meta = {}) {
    const targetJid = securityMediaLog.getViewOnceLogJid();
    try {
        return await sock.sendMessage(targetJid, outbound);
    } catch (error) {
        const hasMentions = Array.isArray(outbound?.mentions) && outbound.mentions.length > 0;
        if (!hasMentions) throw error;

        console.log("⚠️ [ViewOnce] Kirim dengan mention gagal, retry tanpa mentions.", {
            targetJid,
            mentionJids: outbound.mentions,
            mentionSource: meta.mentionSource,
            error: error.message,
        });

        const fallback = { ...outbound };
        delete fallback.mentions;
        return sock.sendMessage(targetJid, fallback);
    }
}

async function handleAntiViewOnce(sock, msg, options = {}) {
    try {
        if (!msg?.message) return false;
        if (securityMediaLog.isSecurityLogChat(msg.key?.remoteJid) || securityMediaLog.isSecurityLogChat(msg.key?.remoteJidAlt)) return false;

        const hasManualTrigger = Boolean(msg.message?.reactionMessage || getQuotedContext(msg));
        if (!hasManualTrigger) return false;

        const optionOwnerJids = options.ownerJids || [];
        if (msg.key?.remoteJid === "status@broadcast") {
            console.log("🚫 [ViewOnce] Trigger diabaikan: status@broadcast.");
            return false;
        }

        const ownerJid = getOwnerJid(sock, optionOwnerJids);
        if (!ownerJid) {
            console.log("⚠️ [ViewOnce] Owner JID tidak ditemukan.");
            return false;
        }

        const resolved = msg.message?.reactionMessage
            ? await resolveReactionTarget(msg)
            : await resolveReplyTarget(msg, options);

        if (!resolved?.targetMsg) return false;

        const targetRemoteJid = resolved.targetKey?.remoteJid || msg.key?.remoteJid;
        if (targetRemoteJid === "status@broadcast") {
            console.log("🚫 [ViewOnce] Target diabaikan: status@broadcast.");
            return false;
        }

        console.log("🔎 [ViewOnce] Validasi target sebelum download.");
        const mediaInfo = getViewOnceMediaInfo(resolved.targetMsg);
        if (!mediaInfo) {
            console.log("ℹ️ [ViewOnce] Target bukan view-once image/video. Media biasa tidak didownload.");
            return false;
        }

        const isGroup = String(targetRemoteJid || "").endsWith("@g.us");
        const triggerIsOwner = await isOwnerTrigger(sock, msg, optionOwnerJids);
        if (!triggerIsOwner) {
            console.log("[ViewOnce] Trigger manual diabaikan: bukan dari owner/fromMe.");
            return false;
        }

        const senderInfo = await resolveSenderForMention(sock, resolved, msg, targetRemoteJid, isGroup);
        const senderMentionLabel = senderInfo.label || getJidLabel(senderInfo.rawJid);
        const mentionJids = senderInfo.mentionJid ? [senderInfo.mentionJid] : [];
        const caption = mediaInfo.caption || "-";
        const mediaEmoji = mediaInfo.type === "image" ? "🖼️" : "🎬";
        const mediaLabel = mediaInfo.type === "image" ? "Gambar" : "Video";

        console.log("🚀 [ViewOnce] Target valid view-once. Mulai download.", {
            method: msg.message?.reactionMessage ? "react" : "reply",
            type: mediaInfo.type,
            from: senderInfo.rawJid,
            mentionJid: senderInfo.mentionJid,
            mentionSource: senderInfo.source,
            remoteJid: targetRemoteJid,
        });

        const buffer = await downloadViewOnceBuffer(mediaInfo.media, mediaInfo.type);
        if (!buffer?.length) throw new Error("Media buffer kosong.");

        await securityMediaLog.sendViewOnceLog(sock, {
            sourceJid: targetRemoteJid,
            senderJid: senderInfo.mentionJid || senderInfo.rawJid,
            senderName: resolved.targetPushName,
            messageId: resolved.targetKey?.id,
            mediaType: mediaInfo.type,
            messageTimestamp: msg.messageTimestamp,
            caption: mediaInfo.caption,
            media: {
                buffer,
                mediaType: mediaInfo.type,
                mimetype: mediaInfo.media?.mimetype,
            },
            fromMe: Boolean(resolved.targetKey?.fromMe),
        });
        return true;

        const outbound = {
            [mediaInfo.type]: buffer,
            caption:
                `🔓 *VIEW-ONCE BERHASIL DIBONGKAR*\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `👤 *Pengirim:* @${senderMentionLabel}\n` +
                `📍 *Lokasi:* ${isGroup ? "Grup 👥" : "Private Chat 💬"}\n` +
                `${mediaEmoji} *Tipe Media:* ${mediaLabel}\n` +
                `📝 *Caption:* ${caption}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🔐 *Sumber:* Brankas permanen view-once`,
            mentions: mentionJids,
        };

        console.log("📤 [ViewOnce] Kirim hasil bongkar ke owner.", {
            ownerJid,
            mentionJids,
            mentionSource: senderInfo.source,
        });
        await sendViewOnceResult(sock, ownerJid, outbound, {
            mentionSource: senderInfo.source,
        });

        console.log("🎉 [ViewOnce] VIEW ONCE SUCCESSFULLY EXTRACTED", {
            method: msg.message?.reactionMessage ? "react" : "reply",
            type: mediaInfo.type,
            from: senderInfo.rawJid,
            mentionJid: senderInfo.mentionJid,
            sentTo: ownerJid,
        });
        return true;
    } catch (error) {
        console.log("❌ [ViewOnce] VIEW ONCE EXTRACTION FAILED", {
            error: error.message,
        });
        return false;
    }
}

async function handleViewOnce(msg, sock, ownerJid) {
    return handleAntiViewOnce(sock, msg, {
        ownerJids: [ownerJid].filter(Boolean),
    });
}

module.exports = {
    handleViewOnce,
    handleAntiViewOnce,
    HELP_CONFIG,
    hasViewOnceMedia,
    saveIncomingViewOnce,
    getViewOnceMediaInfo,
};
