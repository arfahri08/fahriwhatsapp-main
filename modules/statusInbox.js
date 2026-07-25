"use strict";

const fs = require("fs");
const path = require("path");

const STATUS_BROADCAST_JID = "status@broadcast";
const DATA_FILE = process.env.STATUS_INBOX_DATA_FILE
    ? path.resolve(process.env.STATUS_INBOX_DATA_FILE)
    : path.join(__dirname, "../data/statusInbox.json");
const STATUS_CACHE_TTL_MS = Number(process.env.TARGET_STATUS_CACHE_TTL_HOURS || 24) * 60 * 60 * 1000;
const MAX_PER_CONTACT = Math.max(1, Number(process.env.TARGET_STATUS_MAX_PER_CONTACT || 50));
const MAX_STATUS_LOGS = Math.max(1, Number(process.env.STATUS_INBOX_MAX_LOGS || 500));
const SESSION_TTL_MS = Number(process.env.STATUSID_SESSION_TTL_MS || 5 * 60 * 1000);

const statusIdSessions = new Map();
const statusCache = new Map();
const sentLogIds = new Set();

function unique(values) {
    return [...new Set((values || []).filter(value => value !== null && value !== undefined && value !== ""))];
}

function defaultState() {
    return {
        version: 1,
        settings: {
            enabled: false,
            inboxGroupJid: "",
            sendTextLog: true,
            sendMediaPreview: false,
            debug: false,
        },
        statusLogs: [],
    };
}

function normalizeState(input = {}) {
    const base = defaultState();
    const settings = input && typeof input.settings === "object" && !Array.isArray(input.settings)
        ? input.settings
        : {};

    return {
        version: Number(input.version || base.version) || base.version,
        settings: {
            ...base.settings,
            ...settings,
            inboxGroupJid: normalizeGroupJid(settings.inboxGroupJid) || "",
            enabled: Boolean(settings.enabled && normalizeGroupJid(settings.inboxGroupJid)),
            sendTextLog: settings.sendTextLog !== false,
            sendMediaPreview: false,
            debug: settings.debug === true,
        },
        statusLogs: Array.isArray(input.statusLogs)
            ? input.statusLogs.slice(-MAX_STATUS_LOGS)
            : [],
    };
}

function ensureDataFile() {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, `${JSON.stringify(defaultState(), null, 2)}\n`);
    }
}

function loadState() {
    ensureDataFile();
    try {
        return normalizeState(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
    } catch (error) {
        try {
            const backupFile = `${DATA_FILE}.corrupt-${Date.now()}`;
            fs.copyFileSync(DATA_FILE, backupFile);
            console.log("[STATUS INBOX] File data corrupt, dibuat backup.", {
                file: DATA_FILE,
                backupFile,
                errorMessage: error.message,
            });
        } catch {}
        const state = defaultState();
        saveState(state);
        return state;
    }
}

function saveState(state) {
    ensureDataFile();
    const normalized = normalizeState(state);
    const tmpFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmpFile, `${JSON.stringify(normalized, null, 2)}\n`);
    fs.renameSync(tmpFile, DATA_FILE);
    return normalized;
}

function normalizeGroupJid(value) {
    const clean = String(value || "").trim().toLowerCase();
    if (!clean || clean === STATUS_BROADCAST_JID) return null;
    if (/@s\.whatsapp\.net$/i.test(clean)) return null;
    if (!/^\d+@g\.us$/i.test(clean)) return null;
    return clean;
}

function unwrapMessage(message) {
    let current = message || {};
    for (let i = 0; i < 5; i += 1) {
        if (current?.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
            continue;
        }
        if (current?.viewOnceMessage?.message) {
            current = current.viewOnceMessage.message;
            continue;
        }
        if (current?.viewOnceMessageV2?.message) {
            current = current.viewOnceMessageV2.message;
            continue;
        }
        if (current?.viewOnceMessageV2Extension?.message) {
            current = current.viewOnceMessageV2Extension.message;
            continue;
        }
        if (current?.documentWithCaptionMessage?.message) {
            current = current.documentWithCaptionMessage.message;
            continue;
        }
        if (current?.deviceSentMessage?.message) {
            current = current.deviceSentMessage.message;
            continue;
        }
        if (current?.editedMessage?.message) {
            current = current.editedMessage.message;
            continue;
        }
        break;
    }
    return current;
}

function getStatusType(unwrappedMessage) {
    const current = unwrapMessage(unwrappedMessage || {});
    if (current.imageMessage) return "image";
    if (current.videoMessage || current.ptvMessage) return "video";
    if (current.audioMessage) return "audio";
    if (current.extendedTextMessage?.text || current.conversation) return "text";
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
    if (type === "audio") return "Audio";
    if (type === "text") return "Teks";
    return "Unknown";
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
    if (/@lid$/i.test(String(value || "").trim())) return null;
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
        msg?.key?.participantAlt,
        msg?.participant,
        msg?.participantAlt,
        contextInfo.participant,
        contextInfo.remoteJid,
    ]).filter(jid => {
        const clean = String(jid || "").toLowerCase();
        return clean && clean !== STATUS_BROADCAST_JID && !clean.endsWith("@broadcast");
    });
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
            console.log("[STATUS INBOX] Gagal resolve alias LID.", {
                jid,
                errorMessage: error.message,
            });
        }
    }

    return unique(keys);
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

function summarizeCaption(text, max = 80) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return "";
    return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function addStatusToCacheKey(key, record) {
    const cleanKey = String(key || "").trim().toLowerCase();
    if (!cleanKey) return false;

    const existing = statusCache.get(cleanKey) || [];
    if (existing.some(item => item.id === record.id && item.authorJid === record.authorJid)) return false;

    const now = Date.now();
    const next = [...existing, record]
        .filter(item => item?.cachedAt && now - item.cachedAt <= STATUS_CACHE_TTL_MS)
        .sort((a, b) => (a.messageTimestamp || a.cachedAt || 0) - (b.messageTimestamp || b.cachedAt || 0))
        .slice(-MAX_PER_CONTACT);

    statusCache.set(cleanKey, next);
    return true;
}

function cleanupStatusCache(now = Date.now()) {
    for (const [key, records] of statusCache.entries()) {
        const fresh = (records || []).filter(item => item?.cachedAt && now - item.cachedAt <= STATUS_CACHE_TTL_MS);
        if (fresh.length) statusCache.set(key, fresh);
        else statusCache.delete(key);
    }
}

function resolveAuthorDisplay(authors, lidAliasStore = null) {
    for (const author of authors || []) {
        try {
            const best = lidAliasStore?.resolveBestJid ? lidAliasStore.resolveBestJid(author) : author;
            const pn = normalizePnJid(best);
            if (pn) return getJidNumber(pn);
        } catch {}
    }

    for (const author of authors || []) {
        const pn = normalizePnJid(author);
        if (pn) return getJidNumber(pn);
    }

    return "unknown / LID";
}

function buildStatusLogText(record) {
    const lines = [
        "📥 Status Masuk",
        "",
        `Dari: ${record.authorDisplay || "unknown / LID"}`,
        `Tipe: ${getTypeLabel(record.type)}`,
        `Jam: ${formatTime(record.messageTimestamp || record.cachedAt)}`,
    ];

    const caption = summarizeCaption(record.caption || record.text, 80);
    if (caption) lines.push(`Caption: ${caption}`);

    lines.push(
        "",
        "Media belum didownload.",
    );

    if (record.authorDisplay && record.authorDisplay !== "unknown / LID") {
        lines.push(`Gunakan .statusget ${record.authorDisplay} dari PM owner untuk memilih status.`);
    } else {
        lines.push("Gunakan .statusget dari PM owner untuk memilih status.");
    }

    return lines.join("\n");
}

function appendStatusLog(record, state = loadState()) {
    const logKey = `${record.authorJid || "unknown"}:${record.id}`;
    if ((state.statusLogs || []).some(item => item.logKey === logKey)) {
        return { state, added: false };
    }

    state.statusLogs = [
        ...(state.statusLogs || []),
        {
            logKey,
            id: record.id,
            authorJid: record.authorJid || "",
            authorAliases: record.authorAliases || [],
            authorDisplay: record.authorDisplay || "unknown / LID",
            type: record.type,
            caption: summarizeCaption(record.caption, 160),
            text: summarizeCaption(record.text, 160),
            messageTimestamp: record.messageTimestamp,
            cachedAt: record.cachedAt,
            pushName: record.pushName || "",
        },
    ].slice(-MAX_STATUS_LOGS);

    return { state, added: true };
}

async function sendStatusLogIfNeeded(sock, record, state) {
    const settings = state?.settings || {};
    const groupJid = normalizeGroupJid(settings.inboxGroupJid);
    if (!settings.enabled || !settings.sendTextLog || !groupJid || !sock?.sendMessage) return false;

    const sendKey = `${groupJid}:${record.authorJid || "unknown"}:${record.id}`;
    if (sentLogIds.has(sendKey)) return false;

    try {
        await sock.sendMessage(groupJid, { text: buildStatusLogText(record) });
        sentLogIds.add(sendKey);
        if (sentLogIds.size > MAX_STATUS_LOGS * 4) sentLogIds.clear();
        return true;
    } catch (error) {
        console.log("[STATUS INBOX] Gagal kirim log status ke grup.", {
            groupJid,
            statusId: record.id,
            authorJid: record.authorJid,
            errorMessage: error.message,
        });
        return false;
    }
}

async function rememberIncomingStatus(sock, msg, options = {}) {
    if (msg?.key?.remoteJid !== STATUS_BROADCAST_JID || !msg?.message) return false;

    cleanupStatusCache();

    const lidAliasStore = options.lidAliasStore || null;
    const authors = unique(getStatusAuthorCandidates(msg).map(normalizeAuthorJid).filter(Boolean));
    const type = getStatusType(msg.message);
    const cachedAt = Date.now();
    const messageTimestamp = toTimestampMs(msg.messageTimestamp, cachedAt);
    const record = {
        id: msg.key?.id || `${authors[0] || "unknown"}:${cachedAt}`,
        authorJid: authors[0] || "",
        authorAliases: authors,
        authorDisplay: resolveAuthorDisplay(authors, lidAliasStore),
        remoteJid: STATUS_BROADCAST_JID,
        messageTimestamp,
        cachedAt,
        message: msg,
        key: msg.key,
        type,
        caption: getStatusCaption(msg.message, type),
        text: getStatusText(msg.message),
        mimetype: getStatusMimetype(msg.message, type),
        pushName: msg.pushName || "",
    };

    const keys = unique(authors.flatMap(author => getCacheKeysForAuthor(author, lidAliasStore)));
    let savedToCache = false;
    for (const key of keys) {
        if (addStatusToCacheKey(key, record)) savedToCache = true;
    }

    const { state, added } = appendStatusLog(record);
    if (added) saveState(state);
    if (added) await sendStatusLogIfNeeded(sock, record, state);

    if (state.settings?.debug) {
        console.log("[STATUS INBOX] incoming status", {
            id: record.id,
            authorJid: record.authorJid,
            authorDisplay: record.authorDisplay,
            type: record.type,
            cached: savedToCache,
            logged: added,
        });
    }

    return savedToCache || added;
}

function getStatusesByAuthor(authorJid, options = {}) {
    cleanupStatusCache();
    const keys = getCacheKeysForAuthor(authorJid, options.lidAliasStore);
    const seen = new Set();
    const results = [];

    for (const key of keys) {
        for (const item of statusCache.get(key) || []) {
            const dedupeKey = `${item.authorJid}:${item.id}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            results.push(item);
        }
    }

    return results
        .sort((a, b) => (a.messageTimestamp || a.cachedAt || 0) - (b.messageTimestamp || b.cachedAt || 0))
        .slice(-MAX_PER_CONTACT)
        .sort((a, b) => (a.messageTimestamp || a.cachedAt || 0) - (b.messageTimestamp || b.cachedAt || 0));
}

function getSessionKey(context = {}, msg = null) {
    const sender = context.sender || context.senderJid || msg?.key?.participant || msg?.participant || msg?.key?.remoteJid || context.from;
    return String(sender || "").trim().toLowerCase();
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

function parseStatusIdCommand(text) {
    const match = String(text || "").trim().match(/^\.statusid(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    return String(match[1] || "").trim().toLowerCase();
}

function getStatusIdPrompt() {
    return [
        "📥 Kirim ID grup tujuan Status Downloader.",
        "",
        "Contoh:",
        "120363xxxx@g.us",
        "",
        "Setelah ID disimpan, bot akan mengirim log ringan status yang masuk ke grup tersebut.",
        "",
        "Catatan:",
        "Media status tidak akan otomatis didownload.",
        "Download tetap manual lewat .statusget.",
        "",
        "Ketik batal untuk membatalkan.",
    ].join("\n");
}

function getInvalidGroupText() {
    return [
        "❌ ID grup tidak valid.",
        "",
        "Format harus seperti:",
        "120363xxxx@g.us",
        "",
        "Coba kirim ulang atau ketik batal.",
    ].join("\n");
}

function getPrivacyText() {
    return "❌ Demi privasi, command .statusid hanya digunakan lewat private chat owner dengan bot.";
}

function getTestText() {
    return [
        "✅ Status Downloader Group aktif.",
        "",
        "Grup ini akan menerima log ringan status WhatsApp yang masuk ke bot.",
        "Media tidak akan otomatis didownload.",
        "Download tetap manual lewat .statusget.",
    ].join("\n");
}

function getSavedText(groupJid) {
    return [
        "✅ ID grup Status Downloader berhasil disimpan.",
        "",
        `ID: ${groupJid}`,
        "Status Inbox: ON",
        "",
        "Bot sudah mengirim pesan test ke grup tersebut.",
    ].join("\n");
}

function getSavedButTestFailedText(groupJid) {
    return [
        "⚠️ ID grup berhasil disimpan, tapi bot gagal mengirim pesan test.",
        "",
        "Kemungkinan:",
        "1. Bot belum masuk grup itu.",
        "2. ID grup salah.",
        "3. Bot tidak punya akses kirim pesan.",
        "4. Koneksi sedang bermasalah.",
        "",
        "ID tersimpan:",
        groupJid,
    ].join("\n");
}

function getStatusConfigText() {
    const state = loadState();
    const settings = state.settings || {};
    const groupJid = normalizeGroupJid(settings.inboxGroupJid);

    if (!groupJid) {
        return [
            "📥 Status Downloader Group",
            "",
            "Status: OFF",
            "Group ID: belum disetel",
            "",
            "Gunakan .statusid untuk memasukkan ID grup.",
        ].join("\n");
    }

    return [
        "📥 Status Downloader Group",
        "",
        `Status: ${settings.enabled ? "ON" : "OFF"}`,
        `Group ID: ${groupJid}`,
        `Send Log: ${settings.sendTextLog ? "ON" : "OFF"}`,
        "Auto Download Media: OFF",
        "",
        "Catatan:",
        "Bot hanya mengirim log ringan.",
        "Media tetap dipilih manual lewat .statusget.",
    ].join("\n");
}

async function sendTestMessage(sock, groupJid, text = getTestText()) {
    if (!sock?.sendMessage) throw new Error("sock.sendMessage tidak tersedia");
    await sock.sendMessage(groupJid, { text });
    return true;
}

function cleanupExpiredSessions(now = Date.now()) {
    for (const [key, session] of statusIdSessions.entries()) {
        if (!session?.expiresAt || session.expiresAt < now) statusIdSessions.delete(key);
    }
}

async function handleAwaitingGroupId(sock, msg, context, session, key, text) {
    if (session.expiresAt < Date.now()) {
        statusIdSessions.delete(key);
        await reply(sock, msg, "⌛ Sesi pengaturan Status Downloader sudah expired. Jalankan .statusid lagi.");
        return true;
    }

    if (!isOwnerAllowed(msg, context)) {
        statusIdSessions.delete(key);
        await reply(sock, msg, "❌ Command ini hanya untuk owner bot.");
        return true;
    }

    if (context.isGroup || String(context.from || msg?.key?.remoteJid || "").endsWith("@g.us")) {
        await reply(sock, msg, getPrivacyText());
        return true;
    }

    const clean = String(text || "").trim();
    if (["batal", "cancel", ".batal", ".cancel"].includes(clean.toLowerCase())) {
        statusIdSessions.delete(key);
        await reply(sock, msg, "✅ Pengaturan Status Downloader dibatalkan.");
        return true;
    }

    const groupJid = normalizeGroupJid(clean);
    if (!groupJid) {
        await reply(sock, msg, getInvalidGroupText());
        return true;
    }

    const state = loadState();
    state.settings.inboxGroupJid = groupJid;
    state.settings.enabled = true;
    state.settings.sendTextLog = true;
    state.settings.sendMediaPreview = false;
    saveState(state);
    statusIdSessions.delete(key);

    try {
        await sendTestMessage(sock, groupJid);
        await reply(sock, msg, getSavedText(groupJid));
    } catch (error) {
        console.log("[STATUS INBOX] Test send gagal setelah simpan ID grup.", {
            groupJid,
            errorMessage: error.message,
        });
        await reply(sock, msg, getSavedButTestFailedText(groupJid));
    }

    return true;
}

async function handleStatusIdCommand(sock, msg, context = {}) {
    cleanupExpiredSessions();

    const text = String(context.text || "").trim();
    const from = context.from || msg?.key?.remoteJid || "";
    const key = getSessionKey(context, msg);
    const session = statusIdSessions.get(key);

    if (session && session.from === from && session.step === "awaiting_group_id") {
        return handleAwaitingGroupId(sock, msg, context, session, key, text);
    }

    const args = parseStatusIdCommand(text);
    if (args === null) return false;

    if (context.isGroup || String(from).endsWith("@g.us")) {
        await reply(sock, msg, getPrivacyText());
        return true;
    }

    if (!isOwnerAllowed(msg, context)) {
        await reply(sock, msg, "❌ Command ini hanya untuk owner bot.");
        return true;
    }

    if (!args) {
        statusIdSessions.set(key, {
            step: "awaiting_group_id",
            from,
            createdAt: Date.now(),
            expiresAt: Date.now() + SESSION_TTL_MS,
        });
        await reply(sock, msg, getStatusIdPrompt());
        return true;
    }

    if (args === "status") {
        await reply(sock, msg, getStatusConfigText());
        return true;
    }

    if (args === "off") {
        const state = loadState();
        state.settings.enabled = false;
        saveState(state);
        await reply(sock, msg, "✅ Status Downloader Group dimatikan.\nBot tidak akan mengirim log status ke grup.");
        return true;
    }

    if (args === "on") {
        const state = loadState();
        if (!normalizeGroupJid(state.settings.inboxGroupJid)) {
            await reply(sock, msg, "❌ Belum ada ID grup.\nGunakan .statusid untuk memasukkan ID grup dulu.");
            return true;
        }
        state.settings.enabled = true;
        state.settings.sendTextLog = true;
        state.settings.sendMediaPreview = false;
        saveState(state);
        await reply(sock, msg, "✅ Status Downloader Group diaktifkan.");
        return true;
    }

    if (args === "clear") {
        const state = loadState();
        state.settings.inboxGroupJid = "";
        state.settings.enabled = false;
        state.settings.sendMediaPreview = false;
        saveState(state);
        await reply(sock, msg, "♻️ ID grup Status Downloader dihapus.");
        return true;
    }

    if (args === "test") {
        const state = loadState();
        const groupJid = normalizeGroupJid(state.settings.inboxGroupJid);
        if (!groupJid) {
            await reply(sock, msg, "❌ Belum ada ID grup.\nGunakan .statusid untuk memasukkan ID grup dulu.");
            return true;
        }

        try {
            await sendTestMessage(sock, groupJid, "✅ Test Status Downloader Group.\nJika pesan ini masuk, berarti ID grup valid dan bot bisa mengirim pesan ke grup ini.");
            await reply(sock, msg, "✅ Test Status Downloader Group berhasil dikirim.");
        } catch (error) {
            console.log("[STATUS INBOX] Test send gagal.", {
                groupJid,
                errorMessage: error.message,
            });
            await reply(sock, msg, getSavedButTestFailedText(groupJid));
        }
        return true;
    }

    await reply(sock, msg, [
        "📥 Status Downloader",
        "",
        ".statusid",
        ".statusid status",
        ".statusid on",
        ".statusid off",
        ".statusid clear",
        ".statusid test",
    ].join("\n"));
    return true;
}

ensureDataFile();

module.exports = {
    DATA_FILE,
    handleStatusIdCommand,
    rememberIncomingStatus,
    getStatusesByAuthor,
    cleanupStatusCache,
    loadState,
    saveState,
    normalizeGroupJid,
    unwrapMessage,
    getStatusType,
    getStatusAuthorCandidates,
    getCacheKeysForAuthor,
    normalizePnJid,
    normalizeLidJid,
};
