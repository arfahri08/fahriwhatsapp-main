"use strict";

const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const statusInbox = require("./statusInbox");

const STATUS_BROADCAST_JID = "status@broadcast";
const SESSION_TTL_MS = Number(process.env.TARGET_STATUS_SESSION_TTL_MS || 5 * 60 * 1000);
const MAX_STATUS_BYTES = Math.max(1, Number(process.env.TARGET_STATUS_MAX_MB || 64)) * 1024 * 1024;

const sessions = new Map();

function unique(values) {
    return [...new Set((values || []).filter(value => value !== null && value !== undefined && value !== ""))];
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

function getJidNumber(value) {
    return String(value || "")
        .split("@")[0]
        .split(":")[0]
        .split("_")[0]
        .replace(/[^0-9]/g, "");
}

function normalizeNumber(value) {
    let number = getJidNumber(value);
    if (!number || number.length < 7) return null;
    if (number.startsWith("0")) number = `62${number.slice(1)}`;
    if (number.startsWith("8")) number = `62${number}`;
    return number.length >= 7 && number.length <= 16 ? number : null;
}

function normalizePnJid(value) {
    const number = normalizeNumber(value);
    return number ? `${number}@s.whatsapp.net` : null;
}

function normalizeLidJid(value) {
    const clean = String(value || "").trim();
    if (!/@lid$/i.test(clean)) return null;
    const number = getJidNumber(clean);
    return number ? `${number}@lid` : null;
}

function normalizeAuthorJid(value) {
    const lid = normalizeLidJid(value);
    if (lid) return lid;
    const pn = normalizePnJid(value);
    if (pn) return pn;
    return null;
}

function toTimestampMs(value, fallback = Date.now()) {
    if (!value) return fallback;
    if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
    if (typeof value === "bigint") return Number(value) * 1000;
    if (typeof value?.toNumber === "function") return value.toNumber() * 1000;
    if (typeof value?.low === "number") return value.low * 1000;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? (parsed > 10_000_000_000 ? parsed : parsed * 1000) : fallback;
}

function getContextInfo(message) {
    return (
        message.extendedTextMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.ptvMessage?.contextInfo ||
        message.audioMessage?.contextInfo ||
        {}
    );
}

function getStatusAuthorCandidates(msg) {
    const message = unwrapMessage(msg?.message || {});
    const contextInfo = getContextInfo(message);
    return unique([
        msg?.key?.participant,
        msg?.participant,
        contextInfo.participant,
        contextInfo.remoteJid,
    ]).filter(jid => {
        const clean = String(jid || "").toLowerCase();
        return clean && clean !== STATUS_BROADCAST_JID && !clean.endsWith("@broadcast");
    });
}

function getStatusType(message) {
    const current = unwrapMessage(message || {});
    if (current.imageMessage) return "image";
    if (current.videoMessage || current.ptvMessage) return "video";
    if (current.audioMessage) return "audio";
    if (current.conversation || current.extendedTextMessage?.text) return "text";
    return "unknown";
}

function getStatusMedia(message, type) {
    const current = unwrapMessage(message || {});
    if (type === "image") return current.imageMessage;
    if (type === "video") return current.videoMessage || current.ptvMessage;
    if (type === "audio") return current.audioMessage;
    return null;
}

function getStatusText(message) {
    const current = unwrapMessage(message || {});
    return String(current.conversation || current.extendedTextMessage?.text || "").trim();
}

function getStatusCaption(message, type) {
    const media = getStatusMedia(message, type);
    if (media?.caption) return String(media.caption || "").trim();
    if (type === "text") return getStatusText(message);
    return "";
}

function getStatusMimetype(message, type) {
    const media = getStatusMedia(message, type);
    if (media?.mimetype) return media.mimetype;
    if (type === "image") return "image/jpeg";
    if (type === "video") return "video/mp4";
    if (type === "audio") return "audio/mpeg";
    return "";
}

function getTypeLabel(type) {
    if (type === "image") return "Foto";
    if (type === "video") return "Video";
    if (type === "text") return "Teks";
    if (type === "audio") return "Audio";
    return "Unknown";
}

function formatTime(timestamp) {
    try {
        return new Date(timestamp || Date.now()).toLocaleTimeString("id-ID", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });
    } catch {
        return "--:--";
    }
}

function summarizeCaption(text, max = 40) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return "";
    return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function getCacheKeysForAuthor(jid, lidAliasStore = null) {
    const keys = [];
    const add = value => {
        const clean = String(value || "").trim().toLowerCase();
        if (clean && !keys.includes(clean)) keys.push(clean);
    };

    const pn = normalizePnJid(jid);
    const lid = normalizeLidJid(jid);
    if (pn) {
        add(pn);
        add(getJidNumber(pn));
    }
    if (lid) add(lid);

    if (lidAliasStore) {
        try {
            if (lid && typeof lidAliasStore.getPnForLid === "function") add(lidAliasStore.getPnForLid(lid));
            if (typeof lidAliasStore.resolveBestJid === "function") add(lidAliasStore.resolveBestJid(jid));
            if (typeof lidAliasStore.listAliases === "function") {
                for (const entry of lidAliasStore.listAliases() || []) {
                    const entryPn = normalizePnJid(entry?.pn);
                    const entryLid = normalizeLidJid(entry?.lid);
                    if (pn && entryPn === pn) add(entryLid);
                    if (lid && entryLid === lid) add(entryPn);
                }
            }
        } catch (error) {
            console.log("[TARGET STATUS] Gagal resolve alias LID.", {
                jid,
                errorMessage: error.message,
            });
        }
    }

    return unique(keys);
}

function rememberIncomingStatus(msg, options = {}) {
    return statusInbox.rememberIncomingStatus(null, msg, options);
}

function getStatusesByAuthor(authorJid, options = {}) {
    return statusInbox.getStatusesByAuthor(authorJid, options);
}

function getContactEntries(message) {
    const current = unwrapMessage(message || {});
    if (current.contactMessage) return [current.contactMessage];
    if (current.contactsArrayMessage?.contacts?.length) return current.contactsArrayMessage.contacts;
    return [];
}

function extractNumbersFromVcard(vcard) {
    const text = String(vcard || "");
    const waids = [...text.matchAll(/waid=(\d+)/gi)].map(match => match[1]);
    const telLines = text
        .split(/\r?\n/)
        .filter(line => /^TEL/i.test(line))
        .map(line => line.split(":").slice(1).join(":"));
    const generic = [...text.matchAll(/(?:\+?62|0|8)(?:[\s().-]*\d){7,13}(?!\d)/g)].map(match => match[0]);
    return unique([...waids, ...telLines, ...generic].map(normalizeNumber));
}

function parseContactJid(msg, fallbackText = "") {
    const entries = getContactEntries(msg?.message);
    for (const entry of entries) {
        const number = extractNumbersFromVcard(entry?.vcard).find(Boolean);
        if (number) {
            return {
                jid: `${number}@s.whatsapp.net`,
                number,
                name: entry?.displayName || entry?.verifiedName || number,
                source: "contact",
            };
        }
    }

    const number = normalizeNumber(fallbackText);
    if (number) {
        return {
            jid: `${number}@s.whatsapp.net`,
            number,
            name: number,
            source: "text",
        };
    }

    return null;
}

function parseSelection(text, max) {
    const clean = String(text || "").trim().toLowerCase();
    if (["batal", "cancel", ".batal", ".cancel"].includes(clean)) return { action: "cancel", indexes: [], invalid: [] };
    if (["all", "semua", "*"].includes(clean)) {
        return {
            action: "select",
            indexes: Array.from({ length: max }, (_, index) => index),
            invalid: [],
        };
    }

    const parts = clean.split(/[,\s]+/).filter(Boolean);
    const indexes = [];
    const invalid = [];
    for (const part of parts) {
        const value = Number(part);
        if (!Number.isInteger(value) || value < 1 || value > max) {
            invalid.push(part);
            continue;
        }
        indexes.push(value - 1);
    }

    return {
        action: "select",
        indexes: unique(indexes).sort((a, b) => a - b),
        invalid,
    };
}

function getSessionKey(context = {}, msg = null) {
    const sender = context.sender || context.senderJid || msg?.key?.participant || msg?.participant || msg?.key?.remoteJid || context.from;
    return String(sender || "").trim().toLowerCase();
}

function cleanupExpiredSessions(now = Date.now()) {
    let removed = 0;
    for (const [key, session] of sessions.entries()) {
        if (!session?.expiresAt || session.expiresAt < now) {
            sessions.delete(key);
            removed += 1;
        }
    }
    return removed;
}

function isStatusCommand(text) {
    return /^(\.statusget|\.getstatus|\.statuskontak|\.statuscontact)(?:\s|$)/i.test(String(text || "").trim());
}

function parseStatusCommand(text) {
    const match = String(text || "").trim().match(/^(\.statusget|\.getstatus|\.statuskontak|\.statuscontact)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    return {
        command: match[1].toLowerCase(),
        args: String(match[2] || "").trim(),
    };
}

function isOwnerAllowed(msg, context = {}) {
    if (context.canControlOwner === true || context.isOwner === true || msg?.key?.fromMe) return true;
    if (context.isOwnerControlMessage === true) return true;
    if (typeof context.isOwnerControlMessage === "function") {
        try {
            return Boolean(context.isOwnerControlMessage(msg, context.sender || context.senderJid, context.from));
        } catch {}
    }
    return false;
}

async function reply(sock, msg, text) {
    const to = msg?.key?.remoteJid;
    if (!to || !sock?.sendMessage) return false;
    await sock.sendMessage(to, { text }, { quoted: msg });
    return true;
}

function getHelpText() {
    return [
        "📥 *Targeted Status Downloader*",
        "",
        ".statusget",
        "Mulai mode download status berdasarkan kontak.",
        "",
        ".statusget <nomor>",
        "Cari status dari nomor tertentu.",
        "",
        "Contoh:",
        ".statusget",
        ".statusget 628123456789",
        ".statusget 08123456789",
        "",
        "Setelah status ditemukan, pilih:",
        "1",
        "1,3,5",
        "all",
        "batal",
        "",
        "Catatan:",
        "Bot hanya bisa mengambil status yang terlihat oleh akun bot dan sudah terdeteksi saat bot online.",
        "Gunakan fitur ini hanya untuk konten yang memang boleh disimpan.",
    ].join("\n");
}

function formatStatusList(session) {
    const lines = session.statuses.map((item, index) => {
        const caption = summarizeCaption(item.caption || item.text);
        return `${index + 1}. ${formatTime(item.messageTimestamp || item.cachedAt)} - ${getTypeLabel(item.type)}${caption ? ` - "${caption}"` : ""}`;
    });

    return [
        "📋 *Status Ditemukan*",
        "",
        `Target: ${session.targetName || session.targetJid}`,
        `JID: ${session.targetJid}`,
        `Total: ${session.statuses.length} status`,
        "",
        ...lines,
        "",
        "Ketik nomor yang ingin didownload.",
        "Contoh:",
        "1",
        "1,3,5",
        "all",
        "",
        "Ketik batal untuk membatalkan.",
    ].join("\n");
}

function getNoStatusText() {
    return [
        "❌ Tidak ada status yang ditemukan dari kontak ini.",
        "",
        "Kemungkinan:",
        "1. Bot belum menerima status dari kontak tersebut.",
        "2. Bot tidak masuk daftar orang yang boleh melihat statusnya.",
        "3. Status sudah expired.",
        "4. Kontak memakai privacy status tertentu.",
        "",
        "ℹ️ Beberapa status mungkin memakai LID dan belum bisa dicocokkan dengan nomor target.",
    ].join("\n");
}

async function startContactFlow(sock, msg, context = {}) {
    const key = getSessionKey(context, msg);
    sessions.set(key, {
        step: "awaiting_contact",
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_MS,
    });

    await reply(sock, msg, [
        "📥 *Targeted Status Downloader*",
        "",
        "Kirim kontak WhatsApp target yang ingin dicek statusnya.",
        "",
        "Catatan:",
        "Bot hanya bisa mengambil status yang sudah terlihat oleh akun bot dan sudah terdeteksi saat bot online.",
    ].join("\n"));
    return true;
}

async function showStatusesForTarget(sock, msg, context, target) {
    const statuses = getStatusesByAuthor(target.jid, { lidAliasStore: context.lidAliasStore });
    if (!statuses.length) {
        sessions.delete(getSessionKey(context, msg));
        await reply(sock, msg, getNoStatusText());
        return true;
    }

    const session = {
        step: "awaiting_selection",
        createdAt: Date.now(),
        targetJid: target.jid,
        targetName: target.name || target.number || target.jid,
        statuses,
        expiresAt: Date.now() + SESSION_TTL_MS,
    };
    sessions.set(getSessionKey(context, msg), session);
    await reply(sock, msg, formatStatusList(session));
    return true;
}

async function downloadStatusBuffer(item) {
    const media = getStatusMedia(item.message?.message, item.type);
    if (!media) throw new Error("media kosong");

    const stream = await downloadContentFromMessage(media, item.type);
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        total += chunk.length;
        if (total > MAX_STATUS_BYTES) {
            const error = new Error("too-large");
            error.code = "TOO_LARGE";
            throw error;
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function formatStatusCaption(item, number) {
    const caption = String(item.caption || "").trim();
    return [
        `Status nomor ${number}`,
        `Waktu: ${formatTime(item.messageTimestamp || item.cachedAt)}`,
        caption ? `Caption: ${caption}` : "",
    ].filter(Boolean).join("\n");
}

async function sendStatusItem(sock, from, msg, item, number) {
    if (item.type === "text") {
        await sock.sendMessage(from, {
            text: [
                `Status teks nomor ${number}`,
                `Waktu: ${formatTime(item.messageTimestamp || item.cachedAt)}`,
                "",
                item.text || item.caption || "-",
            ].join("\n"),
        }, { quoted: msg });
        return true;
    }

    const buffer = await downloadStatusBuffer(item);
    if (!buffer.length) throw new Error("buffer kosong");

    if (item.type === "image") {
        await sock.sendMessage(from, {
            image: buffer,
            caption: formatStatusCaption(item, number),
            mimetype: item.mimetype || "image/jpeg",
        }, { quoted: msg });
        return true;
    }

    if (item.type === "video") {
        await sock.sendMessage(from, {
            video: buffer,
            caption: formatStatusCaption(item, number),
            mimetype: item.mimetype || "video/mp4",
        }, { quoted: msg });
        return true;
    }

    if (item.type === "audio") {
        await sock.sendMessage(from, {
            audio: buffer,
            mimetype: item.mimetype || "audio/mpeg",
            ptt: false,
        }, { quoted: msg });
        return true;
    }

    throw new Error("tipe status tidak didukung");
}

async function handleSelection(sock, msg, context, session) {
    const from = context.from || msg?.key?.remoteJid;
    const selection = parseSelection(context.text, session.statuses.length);

    if (selection.action === "cancel") {
        sessions.delete(getSessionKey(context, msg));
        await reply(sock, msg, "✅ Sesi download status dibatalkan.");
        return true;
    }

    if (!selection.indexes.length || selection.invalid.length) {
        await reply(sock, msg, "❌ Pilihan tidak valid.\nKetik nomor status, contoh: 1 atau 1,3,5 atau all.");
        return true;
    }

    sessions.delete(getSessionKey(context, msg));
    await reply(sock, msg, `⏳ Mengirim ${selection.indexes.length} status. Tunggu sebentar...`);

    for (const index of selection.indexes) {
        const item = session.statuses[index];
        if (!item) continue;
        try {
            await sendStatusItem(sock, from, msg, item, index + 1);
        } catch (error) {
            const text = error.code === "TOO_LARGE"
                ? `❌ Status nomor ${index + 1} terlalu besar untuk dikirim.`
                : `❌ Gagal mengambil status nomor ${index + 1}.\nKemungkinan media sudah expired atau tidak tersedia lagi.`;
            await sock.sendMessage(from, { text }, { quoted: msg });
            console.log("[TARGET STATUS] Gagal kirim status.", {
                index: index + 1,
                targetJid: session.targetJid,
                statusId: item.id,
                type: item.type,
                errorMessage: error.message,
            });
        }
    }

    return true;
}

async function handleTargetedStatusCommand(sock, msg, context = {}) {
    statusInbox.cleanupStatusCache();

    const text = String(context.text || "").trim();
    const from = context.from || msg?.key?.remoteJid || "";
    const key = getSessionKey(context, msg);
    const session = sessions.get(key);

    if (session && session.expiresAt < Date.now()) {
        sessions.delete(key);
        await reply(sock, msg, "⌛ Sesi status downloader sudah expired. Jalankan .statusget lagi.");
        return true;
    }

    cleanupExpiredSessions();

    if (session) {
        if (!isOwnerAllowed(msg, context)) {
            sessions.delete(key);
            await reply(sock, msg, "❌ Command ini hanya untuk owner bot.");
            return true;
        }

        if (context.isGroup || String(from).endsWith("@g.us")) {
            sessions.delete(key);
            await reply(sock, msg, "❌ Demi privasi, command ini hanya bisa digunakan lewat PM owner.");
            return true;
        }

        if (session.step === "awaiting_contact") {
            const target = parseContactJid(msg, text);
            if (!target) {
                await reply(sock, msg, "❌ Kontak tidak terbaca.\nKirim kontak WhatsApp target, atau gunakan:\n.statusget 628xxxx");
                return true;
            }
            return showStatusesForTarget(sock, msg, context, target);
        }

        if (session.step === "awaiting_selection") {
            return handleSelection(sock, msg, context, session);
        }
    }

    const command = parseStatusCommand(text);
    if (!command) return false;

    if (!isOwnerAllowed(msg, context)) {
        await reply(sock, msg, "❌ Command ini hanya untuk owner bot.");
        return true;
    }

    if (context.isGroup || String(from).endsWith("@g.us")) {
        await reply(sock, msg, "❌ Demi privasi, command ini hanya bisa digunakan lewat PM owner.");
        return true;
    }

    if (/^help$/i.test(command.args)) {
        await reply(sock, msg, getHelpText());
        return true;
    }

    const target = parseContactJid(msg, command.args);
    if (target) return showStatusesForTarget(sock, msg, context, target);

    return startContactFlow(sock, msg, context);
}

module.exports = {
    handleTargetedStatusCommand,
    rememberIncomingStatus,
    getStatusesByAuthor,
    parseContactJid,
    parseSelection,
    cleanupExpiredSessions,
};
