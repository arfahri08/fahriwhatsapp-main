const blocklist = require("./blocklist");
const messageCleaner = require("./messageCleaner");

const WAIT_TTL_MS = Number(process.env.BOT_BLOCKLIST_WAIT_TTL_MS || 2 * 60 * 1000);
const waitSessions = new Map();

function unique(values) {
    return [...new Set((values || []).filter(Boolean))];
}

function getJidNumber(value) {
    return String(value || "").split("@")[0].split(":")[0].split("_")[0].replace(/[^0-9]/g, "");
}

function normalizeNumber(value) {
    let number = getJidNumber(value);
    if (!number || number.length < 7) return null;
    if (number.startsWith("0")) number = `62${number.slice(1)}`;
    if (number.startsWith("8")) number = `62${number}`;
    return number.length >= 7 ? number : null;
}

function normalizeJid(value) {
    const jid = blocklist.toJid(value);
    return jid || null;
}

function isGroupJid(jid) {
    return String(jid || "").endsWith("@g.us");
}

function isPrivateJid(jid) {
    return String(jid || "").endsWith("@s.whatsapp.net");
}

function isSameUser(a, b) {
    const numberA = normalizeNumber(a);
    const numberB = normalizeNumber(b);
    return Boolean(numberA && numberB && numberA === numberB);
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
    return current;
}

function getContextInfo(msg) {
    const message = unwrapMessage(msg?.message || {});
    return (
        message.extendedTextMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.documentMessage?.contextInfo ||
        message.audioMessage?.contextInfo ||
        message.stickerMessage?.contextInfo ||
        message.contactMessage?.contextInfo ||
        {}
    );
}

function parseCommand(text) {
    const clean = String(text || "").trim();
    const match = clean.match(/^(\.blacklist|\.blocklist|\.unblock|\.block)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;

    const command = match[1].toLowerCase();
    if (command === ".blocklist" || command === ".blacklist") return { action: "list", args: (match[2] || "").trim() };
    if (command === ".unblock") return { action: "unblock", args: (match[2] || "").trim() };
    return { action: "block", args: (match[2] || "").trim() };
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

    const genericNumbers = [...text.matchAll(/(?:\+?62|0|8)[\d\s().-]{7,}/g)]
        .map(match => match[0]);

    return unique([...waids, ...telLines, ...genericNumbers].map(normalizeNumber));
}

function extractContactTargets(msg) {
    const entries = getContactEntries(msg?.message);
    const targets = [];

    for (const entry of entries) {
        const numbers = extractNumbersFromVcard(entry.vcard);
        for (const number of numbers) {
            targets.push({
                number,
                jid: `${number}@s.whatsapp.net`,
                label: entry.displayName || number,
                source: "contact",
            });
        }
    }

    return unique(targets.map(item => item.jid)).map(jid => targets.find(item => item.jid === jid));
}

function extractTextTarget(args) {
    const number = normalizeNumber(args);
    if (!number) return null;
    return {
        number,
        jid: `${number}@s.whatsapp.net`,
        label: number,
        source: "number",
    };
}

function extractQuotedTarget(msg) {
    const contextInfo = getContextInfo(msg);
    const participant = contextInfo.participant;
    if (!participant) return null;

    const number = normalizeNumber(participant);
    if (!number) return null;

    return {
        number,
        jid: `${number}@s.whatsapp.net`,
        label: number,
        source: "reply",
    };
}

function extractPrivateChatTarget(msg, context) {
    const from = context.from || msg?.key?.remoteJid;
    if (!isPrivateJid(from)) return null;

    const ownerJids = context.ownerJids || [];
    if (ownerJids.some(ownerJid => isSameUser(ownerJid, from))) return null;

    const number = normalizeNumber(from);
    if (!number) return null;

    return {
        number,
        jid: `${number}@s.whatsapp.net`,
        label: number,
        source: "private-chat",
    };
}

function getTargetsFromCommand(msg, parsed, context) {
    const contactTargets = extractContactTargets(msg);
    if (contactTargets.length) return contactTargets;

    const textTarget = extractTextTarget(parsed.args);
    if (textTarget) return [textTarget];

    const quotedTarget = extractQuotedTarget(msg);
    if (quotedTarget) return [quotedTarget];

    const privateTarget = extractPrivateChatTarget(msg, context);
    if (privateTarget) return [privateTarget];

    return [];
}

function getSessionKey(msg, context) {
    const from = context.from || msg?.key?.remoteJid || "";
    const sender = isGroupJid(from) ? (msg?.key?.participant || msg?.participant || "") : from;
    return `${from}:${sender}`;
}

function getKey(target, jid) {
    const key = target?.key || target;
    if (!key?.id) return null;
    return {
        ...key,
        remoteJid: key.remoteJid || jid,
    };
}

async function deleteQuietly(sock, jid, keys) {
    for (const item of keys || []) {
        const key = getKey(item, jid);
        if (!key) continue;
        await messageCleaner.safeDelete(sock, jid, key, "pesan blacklist").catch(() => false);
    }
}

function rememberSession(session, target) {
    const key = getKey(target, session.from);
    if (key) session.deleteTargets.push(key);
}

function pruneSessions(now = Date.now()) {
    for (const [key, session] of waitSessions) {
        if (!session.expiresAt || now > session.expiresAt) {
            waitSessions.delete(key);
        }
    }
}

function protectOwnerTargets(targets, context) {
    const ownerJids = context.ownerJids || [];
    return targets.filter(target => !ownerJids.some(ownerJid => isSameUser(ownerJid, target.jid)));
}

function applyBlockTargets(targets) {
    let added = 0;
    let existing = 0;
    for (const target of targets) {
        if (blocklist.block(target.jid)) added += 1;
        else existing += 1;
    }
    return { added, existing };
}

function applyUnblockTargets(targets) {
    let removed = 0;
    let missing = 0;
    for (const target of targets) {
        if (blocklist.unblock(target.jid)) removed += 1;
        else missing += 1;
    }
    return { removed, missing };
}

function formatTargetList(targets) {
    return targets.map(target => target.number).join(", ");
}

async function sendFinal(sock, from, text) {
    return sock.sendMessage(from, { text });
}

async function finishSession(sock, session, currentMsg, finalText) {
    if (currentMsg) rememberSession(session, currentMsg);
    waitSessions.delete(session.key);
    await deleteQuietly(sock, session.from, session.deleteTargets);
    await sendFinal(sock, session.from, finalText);
}

async function startContactWait(sock, msg, context) {
    const from = context.from || msg.key?.remoteJid;
    const key = getSessionKey(msg, context);
    const prompt = await sock.sendMessage(from, {
        text:
            "Mode blacklist bot aktif.\n" +
            "Kirim kontak target yang mau dimasukkan ke blacklist.\n" +
            "Kalau batal, ketik *.batal*.",
    });

    const session = {
        key,
        from,
        action: "block",
        deleteTargets: [],
        expiresAt: Date.now() + WAIT_TTL_MS,
        ownerJids: context.ownerJids || [],
    };

    rememberSession(session, msg);
    rememberSession(session, prompt);
    waitSessions.set(key, session);
    return true;
}

async function handleWaitingInput(sock, msg, context) {
    pruneSessions();

    const key = getSessionKey(msg, context);
    const session = waitSessions.get(key);
    if (!session) return false;

    const text = String(context.text || "").trim().toLowerCase();
    if (text === ".batal" || text === ".cancel") {
        await finishSession(sock, session, msg, "Blacklist bot dibatalkan.");
        return true;
    }

    const targets = protectOwnerTargets(extractContactTargets(msg), {
        ownerJids: session.ownerJids,
    });

    if (!targets.length) {
        await finishSession(
            sock,
            session,
            msg,
            "Gagal: yang dikirim bukan kontak WhatsApp valid. Jalankan *.block* lagi lalu kirim kontak target."
        );
        return true;
    }

    const result = applyBlockTargets(targets);
    await finishSession(
        sock,
        session,
        msg,
        `Berhasil blacklist bot: ${formatTargetList(targets)}\nBaru: ${result.added}, sudah ada: ${result.existing}.`
    );
    return true;
}

async function handleList(sock, from) {
    const list = blocklist.getList();
    if (!list.length) {
        await sendFinal(sock, from, "Blocklist bot kosong.");
        return true;
    }

    await sendFinal(sock, from, `Daftar Blacklist Bot:\n\n${list.map((jid, index) => `${index + 1}. ${getJidNumber(jid)}`).join("\n")}`);
    return true;
}

async function handleBlock(sock, msg, parsed, context) {
    const from = context.from || msg.key?.remoteJid;
    const targets = protectOwnerTargets(getTargetsFromCommand(msg, parsed, context), context);

    if (!targets.length) {
        return startContactWait(sock, msg, context);
    }

    const result = applyBlockTargets(targets);
    await deleteQuietly(sock, from, [msg]);
    await sendFinal(sock, from, `Berhasil blacklist bot: ${formatTargetList(targets)}\nBaru: ${result.added}, sudah ada: ${result.existing}.`);
    return true;
}

async function handleUnblock(sock, msg, parsed, context) {
    const from = context.from || msg.key?.remoteJid;
    const targets = protectOwnerTargets(getTargetsFromCommand(msg, parsed, context), context);

    if (!targets.length) {
        await deleteQuietly(sock, from, [msg]);
        await sendFinal(sock, from, "Gagal: target unblock belum jelas. Pakai *.unblock 628xxxx* atau reply pesan target.");
        return true;
    }

    const result = applyUnblockTargets(targets);
    await deleteQuietly(sock, from, [msg]);
    await sendFinal(sock, from, `Hasil unblock bot: ${formatTargetList(targets)}\nTerhapus: ${result.removed}, tidak ada: ${result.missing}.`);
    return true;
}

async function handleBotBlocklist(sock, msg, context = {}) {
    if (!context.isOwner) return false;

    if (await handleWaitingInput(sock, msg, context)) return true;

    const parsed = parseCommand(context.text);
    if (!parsed) return false;

    const from = context.from || msg.key?.remoteJid;
    if (parsed.action === "list") return handleList(sock, from);
    if (parsed.action === "unblock") return handleUnblock(sock, msg, parsed, context);
    return handleBlock(sock, msg, parsed, context);
}

module.exports = {
    handleBotBlocklist,
    normalizeJid,
    normalizeNumber,
    extractContactTargets,
};
