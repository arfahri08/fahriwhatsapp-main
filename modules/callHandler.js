const { isJidGroup, jidNormalizedUser } = require("@whiskeysockets/baileys");
const autoReplyForwarder = require("./autoReplyForwarder");
const blocklist = require("./blocklist");

const handledSockets = new WeakMap();
const callSessions = new Map();
const repliedCallIds = new Map();
const pendingReplyTimers = new Map();
const missedCallSpam = new Map();

const CALL_ID_TTL_MS = 60 * 60 * 1000;
const MAX_TRACKED_CALL_IDS = 1000;
const FINAL_REPLY_DELAY_MS = Number(process.env.CALL_REPLY_DELAY_MS || 2000);
const SPAM_WINDOW_MS = Number(process.env.CALL_SPAM_WINDOW_MS || 5 * 60 * 1000);
const SPAM_THRESHOLD = Number(process.env.CALL_SPAM_THRESHOLD || 3);

function pruneTrackedCalls(map, now = Date.now()) {
    for (const [id, seenAt] of map) {
        if (now - seenAt > CALL_ID_TTL_MS) map.delete(id);
    }

    while (map.size > MAX_TRACKED_CALL_IDS) {
        const oldestId = map.keys().next().value;
        map.delete(oldestId);
    }
}

function pruneCallSessions(now = Date.now()) {
    for (const [id, session] of callSessions) {
        if (now - session.updatedAt > CALL_ID_TTL_MS) {
            clearPendingReply(id);
            callSessions.delete(id);
        }
    }
}

function rememberReply(id) {
    if (!id) return;
    const now = Date.now();
    pruneTrackedCalls(repliedCallIds, now);
    repliedCallIds.set(id, now);
}

function hasReplied(id) {
    if (!id) return false;
    pruneTrackedCalls(repliedCallIds);
    return repliedCallIds.has(id);
}

function clearPendingReply(id) {
    const timer = pendingReplyTimers.get(id);
    if (!timer) return;

    clearTimeout(timer);
    pendingReplyTimers.delete(id);
}

function normalizeUserJid(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";

    try {
        return jidNormalizedUser(raw);
    } catch {
        const number = raw.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
        return number ? `${number}@s.whatsapp.net` : "";
    }
}

function getOwnerJid(sock, ownerJids = []) {
    return normalizeUserJid(
        process.env.CALL_OWNER_JID ||
        process.env.OWNER_JID ||
        ownerJids.find(Boolean) ||
        sock.user?.id ||
        sock.authState?.creds?.me?.id
    );
}

function getMentionNumber(jid) {
    return String(jid || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
}

function getMissedCallReply(sock, ownerJids = []) {
    const ownerJid = getOwnerJid(sock, ownerJids);
    const ownerNumber = getMentionNumber(ownerJid);

    if (!ownerJid || !ownerNumber) {
        return {
            text: "Maaf, owner tidak bisa dihubungi lewat telepon saat ini. Silakan hubungi melalui chat.",
            mentions: [],
        };
    }

    return {
        text: `Maaf, @${ownerNumber} tidak bisa dihubungi lewat telepon saat ini. Silakan hubungi melalui chat😉👌.`,
        mentions: [ownerJid],
    };
}

function getCallKey(call) {
    if (call.id) return call.id;

    const peer = call.from || call.chatId || "unknown";
    const eventTime = call.date instanceof Date ? call.date.getTime() : Number(call.date) || Date.now();
    return `${peer}:${eventTime}`;
}

function getReplyJid(call, session) {
    const rawJid = call.from || call.chatId || session?.from || session?.chatId || "";
    const jid = normalizeUserJid(rawJid);

    if (!jid || isJidGroup(jid)) return "";
    return jid;
}

function parseDurationSeconds(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === "") continue;

        const text = String(value).trim().toLowerCase();
        const parsed = text.endsWith("ms") ? Number(text.slice(0, -2)) / 1000 : Number(text.replace(/s$/, ""));
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }

    return null;
}

function normalizeCallStatus(call) {
    const status = String(call.status || "").toLowerCase();
    const reason = String(call.reason || call.rawReason || "").toLowerCase();
    const signal = `${status} ${reason}`;

    if (/\b(miss|missed|timeout|no[-_ ]?answer)\b/.test(signal)) return "miss";
    if (["accept", "accepted", "answer", "answered"].includes(status)) return "answered";
    if (status === "offer" || status === "offer_notice") return "offer";
    if (status === "ringing" || status === "preaccept") return "ringing";
    if (["reject", "rejected", "terminate", "terminated", "end", "ended"].includes(status)) return "reject";

    return status || "unknown";
}

function getSession(call) {
    const id = getCallKey(call);
    const now = Date.now();
    pruneCallSessions(now);

    const session = callSessions.get(id) || {
        id,
        from: "",
        chatId: "",
        isGroup: false,
        offerSeen: false,
        answered: false,
        durationSeconds: null,
        finalStatus: null,
        finalAt: null,
        replied: false,
        createdAt: now,
        updatedAt: now,
    };

    if (call.from) session.from = call.from;
    if (call.chatId) session.chatId = call.chatId;
    if (call.isGroup || isJidGroup(call.chatId || call.from || "")) session.isGroup = true;
    if (call.durationSeconds !== undefined && call.durationSeconds !== null) {
        session.durationSeconds = call.durationSeconds;
    }

    session.updatedAt = now;
    callSessions.set(id, session);
    return session;
}

function isAnswered(session) {
    return session.answered || (Number.isFinite(session.durationSeconds) && session.durationSeconds > 0);
}

function hasZeroDuration(call, session) {
    return (
        (Number.isFinite(session.durationSeconds) && session.durationSeconds === 0) ||
        (Number.isFinite(call.durationSeconds) && call.durationSeconds === 0)
    );
}

function isFinalStatus(status, call, session) {
    return status === "miss" || status === "reject" || hasZeroDuration(call, session);
}

function isZeroDurationMiss(call, session) {
    if (Number.isFinite(session.durationSeconds)) return session.durationSeconds === 0;
    if (Number.isFinite(call.durationSeconds)) return call.durationSeconds === 0;

    return !isAnswered(session);
}

function registerMissedCallForBotBlocklist(senderJid) {
    const jid = blocklist.toJid(senderJid);
    if (!jid) return { count: 0, blocked: false };

    const now = Date.now();
    const existing = missedCallSpam.get(jid);
    const entry = existing && now - existing.firstAt <= SPAM_WINDOW_MS
        ? existing
        : { count: 0, firstAt: now };

    entry.count += 1;
    entry.updatedAt = now;
    missedCallSpam.set(jid, entry);

    for (const [key, item] of missedCallSpam) {
        if (now - item.firstAt > SPAM_WINDOW_MS) missedCallSpam.delete(key);
    }

    if (entry.count < SPAM_THRESHOLD) {
        return { count: entry.count, blocked: false, jid };
    }

    const added = blocklist.block(jid);
    missedCallSpam.delete(jid);
    return { count: entry.count, blocked: true, added, jid };
}

function shouldSendMissedReply(call, session) {
    const id = session.id;
    const status = normalizeCallStatus(call);

    if (!isFinalStatus(status, call, session)) return false;
    if (session.isGroup || isJidGroup(call.chatId || call.from || "")) return false;
    if (session.replied || hasReplied(id)) return false;
    if (isAnswered(session)) return false;

    if (status === "miss" || hasZeroDuration(call, session)) return true;
    if (status === "reject") return isZeroDurationMiss(call, session);

    return false;
}

async function sendMissedReply(sock, call, session, options) {
    const replyJid = getReplyJid(call, session);
    if (!replyJid) {
        console.log(`[CALL] Target balasan tidak valid untuk callId ${session.id}, auto-reply dibatalkan.`);
        return;
    }

    try {
        await sock.sendMessage(replyJid, getMissedCallReply(sock, options.ownerJids));
        session.replied = true;
        session.updatedAt = Date.now();
        rememberReply(session.id);

        await autoReplyForwarder.sendOwnerNotification(sock, {
            type: "Panggilan Tak Terjawab / Missed Call",
            senderJid: replyJid,
            ownerJids: options.ownerJids,
        });

        const spamResult = registerMissedCallForBotBlocklist(replyJid);
        if (spamResult.blocked) {
            await autoReplyForwarder.sendOwnerNotification(sock, {
                type: spamResult.added ? "Auto Blacklist Bot: Spam Missed Call" : "Spam Missed Call Sudah Ada di Blacklist Bot",
                senderJid: replyJid,
                ownerJids: options.ownerJids,
            });
        }
    } catch (error) {
        console.log(`[CALL] Gagal proses auto-reply missed call ${replyJid}: ${error.message}`);
    }
}

function scheduleMissedReply(sock, call, session, options) {
    const id = session.id;
    if (pendingReplyTimers.has(id)) return;

    const timer = setTimeout(async () => {
        pendingReplyTimers.delete(id);

        if (!shouldSendMissedReply(call, session)) {
            console.log(`[CALL] callId ${id} batal dibalas karena sesi berubah menjadi answered/durasi > 0.`);
            return;
        }

        console.log(`[CALL] Missed call valid dari ${call.from || call.chatId || "-"} | callId: ${id}`);
        await sendMissedReply(sock, call, session, options);
    }, FINAL_REPLY_DELAY_MS);

    pendingReplyTimers.set(id, timer);
}

function processCallUpdate(sock, inputCall, options) {
    const call = {
        ...inputCall,
        status: normalizeCallStatus(inputCall),
    };
    const id = getCallKey(call);
    const session = getSession(call);
    const status = call.status;

    console.log(`[CALL] status=${status} dari=${call.from || call.chatId || "-"} callId=${id}`);

    if (status === "offer" || status === "ringing") {
        if (status === "offer") session.offerSeen = true;
        session.updatedAt = Date.now();
        return;
    }

    if (status === "answered") {
        session.answered = true;
        session.durationSeconds = Number.isFinite(session.durationSeconds) ? session.durationSeconds : 1;
        session.updatedAt = Date.now();
        clearPendingReply(id);
        console.log(`[CALL] callId ${id} diangkat/durasi > 0, auto-reply diabaikan.`);
        return;
    }

    if (!isFinalStatus(status, call, session)) return;

    session.finalStatus = status;
    session.finalAt = Date.now();
    session.updatedAt = session.finalAt;

    if (!shouldSendMissedReply(call, session)) {
        console.log(`[CALL] callId ${id} final=${status}, bukan missed call valid.`);
        return;
    }

    scheduleMissedReply(sock, call, session, options);
}

function buildCallFromBaileysEvent(call) {
    return {
        chatId: call.chatId,
        from: call.from || call.chatId,
        id: call.id,
        date: call.date || new Date(),
        isGroup: call.isGroup,
        isVideo: call.isVideo,
        offline: call.offline,
        status: call.status,
        reason: call.reason,
        durationSeconds: parseDurationSeconds(call.duration, call.durationSeconds),
    };
}

async function handleCall(sock, options = {}) {
    if (handledSockets.has(sock)) return;

    const handlerOptions = {
        ownerJids: options.ownerJids || [],
    };

    const onCall = async (calls) => {
        for (const call of calls || []) {
            processCallUpdate(sock, buildCallFromBaileysEvent(call), handlerOptions);
        }
    };

    sock.ev.on("call", onCall);
    handledSockets.set(sock, { onCall });
}

function disposeCallHandler(sock) {
    const handlers = handledSockets.get(sock);
    if (!handlers) return;

    const { onCall } = handlers;

    if (typeof sock.ev.off === "function") {
        sock.ev.off("call", onCall);
    } else if (typeof sock.ev.removeListener === "function") {
        sock.ev.removeListener("call", onCall);
    }

    handledSockets.delete(sock);

    for (const timer of pendingReplyTimers.values()) clearTimeout(timer);
    pendingReplyTimers.clear();
}

module.exports = {
    handleCall,
    disposeCallHandler,
    get isActive() {
        return false;
    },
};
