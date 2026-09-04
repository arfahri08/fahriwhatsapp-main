const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { spawn } = require("child_process");
const { isJidGroup, jidNormalizedUser } = require("@whiskeysockets/baileys");
const autoReplyForwarder = require("./autoReplyForwarder");
const blocklist = require("./blocklist");

const handledSockets = new WeakMap();
const callSessions = new Map();
const repliedCallIds = new Map();
const pendingReplyTimers = new Map();
const missedCallSpam = new Map();
const answeredCallPeers = new Map();

const CALL_ID_TTL_MS = 60 * 60 * 1000;
const MAX_TRACKED_CALL_IDS = 1000;
const configuredCallLogMatchWindowMs = Number(process.env.CALL_LOG_MATCH_WINDOW_MS || 5 * 60 * 1000);
const configuredAnsweredPeerTtlMs = Number(process.env.ANSWERED_CALL_PEER_TTL_MS || 6 * 60 * 60 * 1000);
const configuredTerminateGraceMs = Number(process.env.CALL_TERMINATE_GRACE_MS || 6000);
const CALL_LOG_MATCH_WINDOW_MS = Number.isFinite(configuredCallLogMatchWindowMs)
    ? Math.max(30 * 1000, configuredCallLogMatchWindowMs)
    : 5 * 60 * 1000;
const ANSWERED_CALL_PEER_TTL_MS = Number.isFinite(configuredAnsweredPeerTtlMs)
    ? Math.max(60 * 1000, configuredAnsweredPeerTtlMs)
    : 6 * 60 * 60 * 1000;
const TERMINATE_GRACE_MS = Number.isFinite(configuredTerminateGraceMs)
    ? Math.max(250, configuredTerminateGraceMs)
    : 6000;
const MAX_GENERATED_VOICE_CACHE = 50;
const TTS_CHUNK_MAX_CHARACTERS = 180;
const TTS_MAX_CHARACTERS = Math.max(200, Math.min(1200, Number(process.env.TTS_MAX_CHARACTERS || 600) || 600));
const TTS_ENDPOINTS = [
    "https://translate.google.com/translate_tts",
    "https://translate.googleapis.com/translate_tts",
    "https://translate.google.co.id/translate_tts",
];
const FINAL_REPLY_DELAY_MS = Number(process.env.CALL_REPLY_DELAY_MS || 2000);
const SPAM_WINDOW_MS = Number(process.env.CALL_SPAM_WINDOW_MS || 5 * 60 * 1000);
const SPAM_THRESHOLD = Number(process.env.CALL_SPAM_THRESHOLD || 3);
const FIRST_VOICE_ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.CALL_FIRST_VOICE_ENABLED || "true").trim());
const FIRST_VOICE_STATE_VERSION = 1;
const configuredFirstVoiceResetMs = Number(process.env.CALL_FIRST_VOICE_RESET_MS || 24 * 60 * 60 * 1000);
const configuredFirstVoiceTtsTimeoutMs = Number(process.env.CALL_FIRST_VOICE_TTS_TIMEOUT_MS || 10000);
const configuredFirstVoiceFfmpegTimeoutMs = Number(process.env.CALL_FIRST_VOICE_FFMPEG_TIMEOUT_MS || 20000);
const FIRST_VOICE_RESET_MS = Number.isFinite(configuredFirstVoiceResetMs) && configuredFirstVoiceResetMs >= 60 * 1000
    ? configuredFirstVoiceResetMs
    : 0;
const FIRST_VOICE_TTS_TIMEOUT_MS = Number.isFinite(configuredFirstVoiceTtsTimeoutMs)
    ? Math.max(2000, configuredFirstVoiceTtsTimeoutMs)
    : 10000;
const FIRST_VOICE_FFMPEG_TIMEOUT_MS = Number.isFinite(configuredFirstVoiceFfmpegTimeoutMs)
    ? Math.max(3000, configuredFirstVoiceFfmpegTimeoutMs)
    : 20000;
const FFMPEG_BIN = String(process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg").trim() || "ffmpeg";
const FIRST_VOICE_TEXT_TEMPLATE = String(
    process.env.CALL_FIRST_VOICE_TEXT
    || "Halo, {{name}}! Panggilanmu belum dapat dijawab. Silakan hubungi kembali beberapa saat lagi atau kirim pesan melalui chat."
).replace(/\s+/g, " ").trim().slice(0, 200);
const FIRST_VOICE_PATH = String(process.env.CALL_FIRST_VOICE_PATH || "").trim();

let firstVoiceStateCache = null;
const generatedVoiceCache = new Map();

function defaultFirstVoiceState() {
    return { version: FIRST_VOICE_STATE_VERSION, callers: {} };
}

function normalizeFirstVoiceState(value) {
    const callers = {};
    for (const [jid, entry] of Object.entries(value?.callers || {})) {
        const normalizedJid = normalizeUserJid(jid);
        const firstVoiceAt = Math.max(0, Number(entry?.firstVoiceAt || 0) || 0);
        if (!normalizedJid || !firstVoiceAt) continue;
        callers[normalizedJid] = {
            firstVoiceAt,
            lastMissedAt: Math.max(firstVoiceAt, Number(entry?.lastMissedAt || firstVoiceAt) || firstVoiceAt),
            missedCount: Math.max(1, Number(entry?.missedCount || 1) || 1),
        };
    }
    return { version: FIRST_VOICE_STATE_VERSION, callers };
}

function loadFirstVoiceState() {
    if (!firstVoiceStateCache) firstVoiceStateCache = defaultFirstVoiceState();
    return firstVoiceStateCache;
}

function saveFirstVoiceState(state = loadFirstVoiceState()) {
    firstVoiceStateCache = normalizeFirstVoiceState(state);
    return firstVoiceStateCache;
}

function getCallerReplyMode(jid, now = Date.now()) {
    if (!FIRST_VOICE_ENABLED) return "warning";
    const normalizedJid = normalizeUserJid(jid);
    const entry = loadFirstVoiceState().callers[normalizedJid];
    if (!entry || (FIRST_VOICE_RESET_MS > 0 && now - entry.firstVoiceAt >= FIRST_VOICE_RESET_MS)) {
        return "first-voice";
    }
    return "warning";
}

function rememberFirstVoice(jid, now = Date.now()) {
    const normalizedJid = normalizeUserJid(jid);
    if (!normalizedJid) return;
    const state = loadFirstVoiceState();
    state.callers[normalizedJid] = {
        firstVoiceAt: now,
        lastMissedAt: now,
        missedCount: 1,
    };
    saveFirstVoiceState(state);
}

function rememberRepeatedMissedCall(jid, now = Date.now()) {
    const normalizedJid = normalizeUserJid(jid);
    if (!normalizedJid) return;
    const state = loadFirstVoiceState();
    const existing = state.callers[normalizedJid];
    if (!existing) return;
    state.callers[normalizedJid] = {
        ...existing,
        lastMissedAt: now,
        missedCount: Math.max(1, Number(existing.missedCount || 1)) + 1,
    };
    saveFirstVoiceState(state);
}

function getAudioMimeType(filePath) {
    const extension = path.extname(String(filePath || "")).toLowerCase();
    if (extension === ".ogg" || extension === ".opus") return "audio/ogg; codecs=opus";
    if (extension === ".wav") return "audio/wav";
    if (extension === ".m4a" || extension === ".aac") return "audio/mp4";
    return "audio/mpeg";
}

function getSavedCallerFirstName(jid, options = {}) {
    const contactStore = options.contactNameStore;
    if (!contactStore || typeof contactStore.resolveSavedContactName !== "function") return "Kak";

    const provided = Array.isArray(options.contactJids) ? options.contactJids : [options.contactJids];
    const candidates = [...new Set([jid, ...provided].map(normalizeUserJid).filter(Boolean))];
    for (const candidate of candidates) {
        try {
            const savedName = String(contactStore.resolveSavedContactName(candidate) || "")
                .normalize("NFKC")
                .replace(/\s+/g, " ")
                .trim();
            if (!savedName) continue;
            for (const token of savedName.split(" ")) {
                const candidateName = token
                    .replace(/[^\p{L}\p{N}._'-]/gu, "")
                    .slice(0, 30);
                // Jangan pernah membacakan nomor, JID, atau ID LID sebagai nama.
                if (!candidateName || !/\p{L}/u.test(candidateName)) continue;
                if (/whatsapp|\.net$|^lid$/i.test(candidateName)) continue;
                return candidateName;
            }
        } catch {}
    }
    return "Kak";
}

function renderFirstVoiceText(jid, options = {}) {
    const name = getSavedCallerFirstName(jid, options);
    const rendered = FIRST_VOICE_TEXT_TEMPLATE.replace(
        /\{\{?\s*(?:name|firstName)\s*\}?\}/gi,
        name
    );
    if (rendered !== FIRST_VOICE_TEXT_TEMPLATE) {
        return rendered.replace(/\s+/g, " ").trim().slice(0, 200);
    }

    const withoutGenericHalo = FIRST_VOICE_TEXT_TEMPLATE.replace(/^halo\s*[!,.:-]?\s*/i, "");
    return `Halo, ${name}! ${withoutGenericHalo}`.replace(/\s+/g, " ").trim().slice(0, 200);
}

function getGeneratedVoiceCache(text) {
    const cached = generatedVoiceCache.get(text);
    if (!cached) return null;
    generatedVoiceCache.delete(text);
    generatedVoiceCache.set(text, cached);
    return { ...cached };
}

function rememberGeneratedVoice(text, content) {
    generatedVoiceCache.delete(text);
    generatedVoiceCache.set(text, content);
    while (generatedVoiceCache.size > MAX_GENERATED_VOICE_CACHE) {
        generatedVoiceCache.delete(generatedVoiceCache.keys().next().value);
    }
}

function normalizeTtsLanguage(value, fallback = "id") {
    const language = String(value || fallback).trim().toLowerCase().replace(/_/g, "-");
    return /^[a-z]{2,3}(?:-[a-z]{2})?$/.test(language) ? language : fallback;
}

function splitTtsText(value, maxCharacters = TTS_CHUNK_MAX_CHARACTERS) {
    const clean = String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!clean) return [];

    const chunks = [];
    let remaining = clean;
    while (remaining.length > maxCharacters) {
        const window = remaining.slice(0, maxCharacters + 1);
        const candidates = [window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "), window.lastIndexOf(", "), window.lastIndexOf(" ")];
        let cutAt = Math.max(...candidates);
        if (cutAt < Math.floor(maxCharacters * 0.45)) cutAt = maxCharacters;
        else cutAt += 1;
        chunks.push(remaining.slice(0, cutAt).trim());
        remaining = remaining.slice(cutAt).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

async function requestGoogleTtsChunk(text, language, options = {}) {
    const configuredEndpoints = Array.isArray(options.ttsEndpoints) && options.ttsEndpoints.length
        ? options.ttsEndpoints
        : TTS_ENDPOINTS;
    let lastError = null;

    for (const endpoint of configuredEndpoints) {
        try {
            const response = await axios.get(endpoint, {
                params: {
                    ie: "UTF-8",
                    client: "tw-ob",
                    tl: language,
                    q: text,
                },
                headers: {
                    "User-Agent": "Mozilla/5.0",
                    Accept: "audio/mpeg,audio/*;q=0.9,*/*;q=0.1",
                },
                responseType: "arraybuffer",
                timeout: FIRST_VOICE_TTS_TIMEOUT_MS,
                validateStatus: status => status >= 200 && status < 500,
            });
            const audio = Buffer.from(response.data || []);
            const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
            if (response.status >= 400) throw new Error(`TTS HTTP ${response.status}`);
            if (audio.length < 100 || (!contentType.startsWith("audio/") && /^\s*</.test(audio.toString("utf8", 0, Math.min(audio.length, 80))))) {
                throw new Error("Respons TTS bukan audio yang valid");
            }
            return audio;
        } catch (error) {
            lastError = error;
            console.log(`[TTS] Provider ${endpoint} gagal: ${String(error.message || error).replace(/\s+/g, " ").slice(0, 160)}`);
        }
    }

    throw lastError || new Error("Semua provider TTS gagal");
}

async function requestGoogleTtsAudio(spokenText, language, options = {}) {
    const chunks = splitTtsText(spokenText);
    if (!chunks.length) throw new Error("Teks TTS kosong");
    const audioParts = [];
    for (const chunk of chunks) {
        audioParts.push(await requestGoogleTtsChunk(chunk, language, options));
    }
    const audio = Buffer.concat(audioParts);
    if (audio.length < 100) throw new Error("Audio TTS kosong");
    return audio;
}

function isOggOpusBuffer(value) {
    if (!Buffer.isBuffer(value) || value.length < 36) return false;
    if (value.subarray(0, 4).toString("ascii") !== "OggS") return false;
    return value.subarray(0, Math.min(value.length, 256)).includes(Buffer.from("OpusHead"));
}

function transcodeToOggOpus(inputBuffer) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let child;
        try {
            child = spawn(FFMPEG_BIN, [
                "-hide_banner",
                "-loglevel", "error",
                "-i", "pipe:0",
                "-vn",
                "-c:a", "libopus",
                "-ac", "1",
                "-ar", "48000",
                "-b:a", "32k",
                "-vbr", "on",
                "-application", "voip",
                "-avoid_negative_ts", "make_zero",
                "-f", "ogg",
                "pipe:1",
            ], {
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
            });
        } catch (error) {
            reject(error);
            return;
        }

        const output = [];
        const errors = [];
        let outputBytes = 0;
        let errorBytes = 0;

        const finish = (error, audio) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(audio);
        };

        const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
            finish(new Error(`FFmpeg timeout setelah ${FIRST_VOICE_FFMPEG_TIMEOUT_MS} ms`));
        }, FIRST_VOICE_FFMPEG_TIMEOUT_MS);

        child.stdout.on("data", chunk => {
            const buffer = Buffer.from(chunk);
            outputBytes += buffer.length;
            if (outputBytes <= 20 * 1024 * 1024) output.push(buffer);
        });
        child.stderr.on("data", chunk => {
            const buffer = Buffer.from(chunk);
            errorBytes += buffer.length;
            if (errorBytes <= 64 * 1024) errors.push(buffer);
        });
        child.on("error", error => finish(error));
        child.on("close", code => {
            const audio = Buffer.concat(output);
            if (code !== 0) {
                const detail = Buffer.concat(errors).toString("utf8").trim();
                finish(new Error(detail || `FFmpeg keluar dengan kode ${code}`));
                return;
            }
            if (!isOggOpusBuffer(audio)) {
                finish(new Error("FFmpeg tidak menghasilkan OGG/Opus yang valid"));
                return;
            }
            finish(null, audio);
        });
        child.stdin.on("error", error => {
            if (error?.code !== "EPIPE") finish(error);
        });
        child.stdin.end(inputBuffer);
    });
}

async function prepareFirstVoiceAudio(content, options = {}) {
    if (!content?.audio || !Buffer.isBuffer(content.audio)) return content;
    if (content.ptt === false && options.requireVoiceNote !== true) return content;
    if (isOggOpusBuffer(content.audio)) {
        return {
            ...content,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
        };
    }

    try {
        const transcoder = typeof options.firstVoiceTranscoder === "function"
            ? options.firstVoiceTranscoder
            : transcodeToOggOpus;
        const audio = await transcoder(content.audio);
        if (!isOggOpusBuffer(audio)) throw new Error("Transcoder tidak menghasilkan OGG/Opus yang valid");
        return {
            ...content,
            audio,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
        };
    } catch (error) {
        const detail = String(error.message || error).replace(/\s+/g, " ").trim().slice(0, 180);
        if (options.requireVoiceNote === true) {
            const voiceError = new Error(`Audio tidak dapat dikonversi menjadi Voice Note: ${detail}`);
            voiceError.code = "TTS_VOICE_NOTE_CONVERSION_FAILED";
            throw voiceError;
        }
        console.log(`[CALL] FFmpeg tidak tersedia/gagal (${detail}); audio dikirim sebagai audio biasa, bukan PTT.`);
        return {
            ...content,
            mimetype: content.mimetype || "audio/mpeg",
            ptt: false,
        };
    }
}

async function getFirstVoiceContent(spokenText, options = {}) {
    const contentProvider = options.ttsContentProvider || options.firstVoiceContentProvider;
    const language = normalizeTtsLanguage(options.language, "id");
    const cacheKey = `${language}:${spokenText}`;
    if (typeof contentProvider === "function") {
        const provided = await contentProvider(spokenText, { language });
        return prepareFirstVoiceAudio(provided, options);
    }
    if (FIRST_VOICE_PATH && options.ignoreConfiguredVoicePath !== true) {
        return prepareFirstVoiceAudio({
            audio: fs.readFileSync(path.resolve(FIRST_VOICE_PATH)),
            mimetype: getAudioMimeType(FIRST_VOICE_PATH),
        }, options);
    }
    const cached = getGeneratedVoiceCache(cacheKey);
    if (cached) return cached;

    const audio = await requestGoogleTtsAudio(spokenText, language, options);
    const preparedAudio = await prepareFirstVoiceAudio({
        audio,
        mimetype: "audio/mpeg",
    }, options);
    // Cache hanya hasil PTT yang valid. Jika FFmpeg baru dipasang tanpa restart,
    // panggilan pertama berikutnya dapat langsung mencoba konversi ulang.
    if (preparedAudio.ptt === true) rememberGeneratedVoice(cacheKey, preparedAudio);
    return { ...preparedAudio };
}

async function createTtsVoiceNoteContent(value, options = {}) {
    const spokenText = String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!spokenText) throw new Error("Teks TTS kosong");
    if (spokenText.length > TTS_MAX_CHARACTERS) {
        const error = new Error(`Teks TTS maksimal ${TTS_MAX_CHARACTERS} karakter`);
        error.code = "TTS_TEXT_TOO_LONG";
        throw error;
    }
    return getFirstVoiceContent(spokenText, {
        ...options,
        ignoreConfiguredVoicePath: true,
        requireVoiceNote: true,
    });
}

async function sendFirstVoiceReply(sock, replyJid, options = {}) {
    const spokenText = renderFirstVoiceText(replyJid, options);
    try {
        const content = await getFirstVoiceContent(spokenText, options);
        if (!content?.audio) throw new Error("Provider voice note tidak menghasilkan audio");
        await sock.sendMessage(replyJid, content);
        return { sent: true, mode: content.ptt === true ? "voice" : "audio" };
    } catch (error) {
        console.log(`[CALL] Audio panggilan pertama gagal dan tidak diganti teks: ${String(error.message || error).slice(0, 180)}`);
        return { sent: false, mode: "audio-failed", error };
    }
}

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

function getCallPeerKeys(call = {}, session = {}) {
    return [...new Set([
        call.callerPn,
        session.callerPn,
        call.from,
        session.from,
        call.chatId,
        session.chatId,
    ].map(normalizeUserJid).filter(Boolean))];
}

function pruneAnsweredCallPeers(now = Date.now()) {
    for (const [jid, marker] of answeredCallPeers) {
        if (!marker || now - Number(marker.answeredAt || 0) > ANSWERED_CALL_PEER_TTL_MS) {
            answeredCallPeers.delete(jid);
        }
    }
}

function rememberAnsweredCall(call, session, source = "answered") {
    const now = Date.now();
    const marker = { callId: session.id, answeredAt: now, source };
    session.answered = true;
    session.connectionEvidence = true;
    session.answeredAt = session.answeredAt || now;
    session.answeredSource = source;
    session.updatedAt = now;
    clearPendingReply(session.id);
    pruneAnsweredCallPeers(now);
    for (const jid of getCallPeerKeys(call, session)) answeredCallPeers.set(jid, marker);
    return marker;
}

function findAnsweredCallMarker(call, session) {
    pruneAnsweredCallPeers();
    for (const jid of getCallPeerKeys(call, session)) {
        const marker = answeredCallPeers.get(jid);
        if (marker) return marker;
    }
    return null;
}

function forgetAnsweredCallMarker(marker) {
    if (!marker) return;
    for (const [jid, candidate] of answeredCallPeers) {
        if (candidate === marker) answeredCallPeers.delete(jid);
    }
}

function inheritAnsweredCallEvidence(call, session) {
    const marker = findAnsweredCallMarker(call, session);
    if (!marker) return null;
    session.answered = true;
    session.connectionEvidence = true;
    session.answeredAt = session.answeredAt || marker.answeredAt;
    session.answeredSource = `peer:${marker.source}`;
    clearPendingReply(session.id);
    clearPendingReply(marker.callId);
    return marker;
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

async function resolveCallIdentity(sock, call, session, options = {}) {
    const rawJid = call.from || call.chatId || session?.from || session?.chatId || "";
    const normalizedRaw = normalizeUserJid(rawJid);
    const callerPn = normalizeUserJid(call.callerPn || session?.callerPn || "");
    const validCallerPn = /@(s\.whatsapp\.net|hosted)$/i.test(callerPn) ? callerPn : "";
    const candidates = new Set([validCallerPn, normalizedRaw].filter(Boolean));
    // callerPn berasal langsung dari node call Baileys dan lebih akurat daripada LID `from`.
    let replyJid = validCallerPn || normalizedRaw;

    const lidMapping = sock?.signalRepository?.lidMapping;
    const rawIsLid = /@(hosted\.)?lid$/i.test(normalizedRaw);
    const rawIsPn = /@(s\.whatsapp\.net|hosted)$/i.test(normalizedRaw);

    if (rawIsLid && !validCallerPn && typeof lidMapping?.getPNForLID === "function") {
        try {
            const mappedPn = normalizeUserJid(await lidMapping.getPNForLID(normalizedRaw));
            if (mappedPn) {
                candidates.add(mappedPn);
                replyJid = mappedPn;
                try {
                    options.lidAliasStore?.rememberAlias?.(normalizedRaw, mappedPn, {
                        source: "call-signal-repository",
                    });
                } catch {}
            }
        } catch (error) {
            console.log(`[CALL] Mapping LID dari Signal Repository gagal: ${String(error.message || error).slice(0, 160)}`);
        }
    }

    if (rawIsPn && typeof lidMapping?.getLIDForPN === "function") {
        try {
            const mappedLid = normalizeUserJid(await lidMapping.getLIDForPN(normalizedRaw));
            if (mappedLid) candidates.add(mappedLid);
        } catch (error) {
            console.log(`[CALL] Mapping PN ke LID dari Signal Repository gagal: ${String(error.message || error).slice(0, 160)}`);
        }
    }

    if ((rawIsLid && !validCallerPn && replyJid === normalizedRaw) && typeof options.lidAliasStore?.resolveBestJid === "function") {
        try {
            const localMapped = normalizeUserJid(options.lidAliasStore.resolveBestJid(normalizedRaw));
            if (localMapped) {
                candidates.add(localMapped);
                replyJid = localMapped;
            }
        } catch {}
    }

    if (!replyJid || isJidGroup(replyJid)) return { replyJid: "", candidates: [...candidates] };
    return { replyJid, candidates: [...candidates] };
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
    if (status === "ringing") return "ringing";
    if (status === "preaccept") return "preaccept";
    if (["reject", "rejected"].includes(status)) return "reject";
    // Baileys memakai `terminate` untuk accepted, rejected, timeout, maupun
    // caller hangup. Status ini ambigu dan tidak boleh dianggap missed langsung.
    if (["terminate", "terminated", "end", "ended"].includes(status)) return "terminate";

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
        callerPn: "",
        isGroup: false,
        offerSeen: false,
        answered: false,
        connectionEvidence: false,
        confirmedMissed: false,
        ambiguousTerminate: false,
        terminateGraceElapsed: false,
        durationSeconds: null,
        finalStatus: null,
        finalAt: null,
        replied: false,
        createdAt: now,
        updatedAt: now,
    };

    if (call.from) session.from = call.from;
    if (call.chatId) session.chatId = call.chatId;
    if (call.callerPn) session.callerPn = call.callerPn;
    if (call.isGroup || isJidGroup(call.chatId || call.from || "")) session.isGroup = true;
    if (call.durationSeconds !== undefined && call.durationSeconds !== null) {
        session.durationSeconds = call.durationSeconds;
    }
    session.lastCall = { ...call };

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
    return status === "miss" || status === "reject" || status === "terminate" || hasZeroDuration(call, session);
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

    if (status === "terminate") return session.confirmedMissed === true;
    if (status === "miss" || hasZeroDuration(call, session)) return true;
    if (status === "reject") return isZeroDurationMiss(call, session);

    return false;
}

function unwrapCallLogContainer(message) {
    let current = message || {};
    for (let index = 0; index < 8; index += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
        else break;
    }
    return current || {};
}

function getCallLogMessage(msg) {
    const message = unwrapCallLogContainer(msg?.message || {});
    return message.callLogMesssage || message.callLogMessage || null;
}

function toFiniteNumber(value) {
    if (value === undefined || value === null || value === "") return null;
    if (value && typeof value.toNumber === "function") {
        try { return Number(value.toNumber()); } catch {}
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCallLogOutcome(value) {
    const numeric = toFiniteNumber(value);
    if (numeric !== null) {
        if ([0, 4, 5].includes(numeric)) return "answered";
        if ([1, 2, 3, 6, 7].includes(numeric)) return "missed";
    }
    const clean = String(value ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
    if (["connected", "acceptedelsewhere", "ongoing"].includes(clean)) return "answered";
    if (["missed", "failed", "rejected", "silencedbydnd", "silencedunknowncaller"].includes(clean)) return "missed";
    return "unknown";
}

function callLogTimestampMs(msg) {
    const numeric = toFiniteNumber(msg?.messageTimestamp);
    if (numeric === null || numeric <= 0) return Date.now();
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
}

function getCallLogPeerKeys(msg, callLog) {
    const primary = [msg?.key?.remoteJid, msg?.key?.remoteJidAlt]
        .map(normalizeUserJid)
        .filter(Boolean);
    const participants = (Array.isArray(callLog?.participants) ? callLog.participants : [])
        .flatMap(item => [item?.jid, item?.userJid])
        .map(normalizeUserJid)
        .filter(Boolean);
    return {
        primary: [...new Set(primary)],
        all: [...new Set([...primary, ...participants])],
    };
}

function findCallSessionForLog(msg, callLog) {
    const eventAt = callLogTimestampMs(msg);
    const peerKeys = getCallLogPeerKeys(msg, callLog);
    const rankMatches = candidates => [...callSessions.values()]
        .filter(session => {
            if (session.isGroup || session.replied || Math.abs(eventAt - Number(session.updatedAt || 0)) > CALL_LOG_MATCH_WINDOW_MS) return false;
            const sessionKeys = new Set(getCallPeerKeys(session.lastCall || {}, session));
            return candidates.some(jid => sessionKeys.has(jid));
        })
        .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0] || null;
    return rankMatches(peerKeys.primary) || rankMatches(peerKeys.all);
}

async function processCallLogUpsert(sock, upsert, options) {
    // `append` dapat berisi histori lama saat reconnect; jangan pernah membalasnya.
    if (upsert?.type && upsert.type !== "notify") return;
    for (const msg of upsert?.messages || []) {
        const callLog = getCallLogMessage(msg);
        if (!callLog) continue;
        const session = findCallSessionForLog(msg, callLog);
        if (!session || session.replied) continue;

        const durationSeconds = toFiniteNumber(callLog.durationSecs);
        const reportedOutcome = normalizeCallLogOutcome(callLog.callOutcome);
        const outcome = durationSeconds !== null && durationSeconds > 0 ? "answered" : reportedOutcome;
        const call = session.lastCall || {
            id: session.id,
            from: session.from,
            chatId: session.chatId,
            callerPn: session.callerPn,
        };

        if (outcome === "answered") {
            if (durationSeconds !== null && durationSeconds > 0) session.durationSeconds = durationSeconds;
            const marker = rememberAnsweredCall(call, session, `call-log:${reportedOutcome}`);
            if (session.finalStatus) forgetAnsweredCallMarker(marker);
            console.log(`[CALL] call-log memastikan callId ${session.id} telah dijawab; auto-reply dibatalkan.`);
            continue;
        }

        if (outcome === "missed") {
            if (isAnswered(session) || findAnsweredCallMarker(call, session)) continue;
            if (session.ambiguousTerminate) clearPendingReply(session.id);
            session.confirmedMissed = true;
            if (durationSeconds !== null) session.durationSeconds = durationSeconds;
            session.updatedAt = Date.now();
            console.log(`[CALL] call-log memastikan callId ${session.id} benar-benar missed/rejected.`);
            if (session.finalStatus && shouldSendMissedReply(call, session)) {
                scheduleMissedReply(sock, call, session, options);
            }
        }
    }
}

async function sendMissedReply(sock, call, session, options) {
    const identity = await resolveCallIdentity(sock, call, session, options);
    const replyJid = identity.replyJid;
    if (!replyJid) {
        console.log(`[CALL] Target balasan tidak valid untuk callId ${session.id}, auto-reply dibatalkan.`);
        return;
    }

    try {
        const replyMode = getCallerReplyMode(replyJid);
        let replyResult;
        if (replyMode === "first-voice") {
            replyResult = await sendFirstVoiceReply(sock, replyJid, {
                ...options,
                contactJids: [
                    replyJid,
                    call.from,
                    call.chatId,
                    session.from,
                    session.chatId,
                    ...identity.candidates,
                    ...(options.contactJids || []),
                ],
            });
            if (!replyResult.sent) throw replyResult.error || new Error("Audio panggilan pertama gagal dikirim");
            rememberFirstVoice(replyJid);
        } else {
            await sock.sendMessage(replyJid, getMissedCallReply(sock, options.ownerJids));
            rememberRepeatedMissedCall(replyJid);
            replyResult = { sent: true, mode: "warning" };
        }
        session.replied = true;
        session.updatedAt = Date.now();
        rememberReply(session.id);

        await autoReplyForwarder.sendOwnerNotification(sock, {
            type: replyMode === "first-voice"
                ? `Panggilan Pertama: Balasan ${replyResult.mode === "voice" ? "Voice Note" : "Audio"}`
                : "Panggilan Berulang: Warning Missed Call",
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

function scheduleAmbiguousTerminateReply(sock, call, session, options) {
    const id = session.id;
    if (pendingReplyTimers.has(id)) return;
    session.ambiguousTerminate = true;

    const timer = setTimeout(async () => {
        pendingReplyTimers.delete(id);
        if (session.finalStatus !== "terminate" || isAnswered(session) || findAnsweredCallMarker(call, session)) {
            console.log(`[CALL] callId ${id} fallback terminate dibatalkan karena ada bukti answered.`);
            return;
        }

        // Beberapa perangkat hanya mengirim offer -> terminate untuk missed call
        // dan tidak mengirim CallLogMessage. Setelah grace period tanpa satu pun
        // bukti koneksi, izinkan auto-reply agar VN pertama tidak hilang.
        session.terminateGraceElapsed = true;
        session.confirmedMissed = true;
        session.updatedAt = Date.now();
        if (!shouldSendMissedReply(call, session)) {
            console.log(`[CALL] callId ${id} fallback terminate tidak lagi memenuhi syarat missed.`);
            return;
        }

        console.log(`[CALL] callId ${id} terminate tanpa bukti answered selama ${TERMINATE_GRACE_MS} ms; diproses sebagai missed call.`);
        await sendMissedReply(sock, call, session, options);
    }, TERMINATE_GRACE_MS);

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
        if (status === "offer") {
            session.offerSeen = true;
            // Offer dengan ID baru berarti panggilan baru. Jangan biarkan marker
            // answered lama dari penelepon yang sama menutupi missed call baru.
            const previousAnswered = findAnsweredCallMarker(call, session);
            if (previousAnswered && previousAnswered.callId !== id) forgetAnsweredCallMarker(previousAnswered);
        }
        session.updatedAt = Date.now();
        return;
    }

    if (status === "answered" || status === "preaccept" || status === "transport") {
        session.durationSeconds = Number.isFinite(session.durationSeconds) ? session.durationSeconds : 1;
        rememberAnsweredCall(call, session, `event:${status}`);
        console.log(`[CALL] callId ${id} terdeteksi diangkat (${status}); auto-reply diabaikan.`);
        return;
    }

    if (!isFinalStatus(status, call, session)) return;

    session.finalStatus = status;
    session.finalAt = Date.now();
    session.updatedAt = session.finalAt;

    const answeredMarker = inheritAnsweredCallEvidence(call, session);
    if (isAnswered(session)) {
        clearPendingReply(id);
        forgetAnsweredCallMarker(answeredMarker || findAnsweredCallMarker(call, session));
        console.log(`[CALL] callId ${id} selesai setelah diangkat/durasi > 0, auto-reply diabaikan.`);
        return;
    }

    if (status === "miss" || status === "reject") session.confirmedMissed = true;

    if (status === "terminate" && session.confirmedMissed !== true) {
        console.log(`[CALL] callId ${id} terminate ambigu; menunggu ${TERMINATE_GRACE_MS} ms untuk bukti answered/call-log.`);
        scheduleAmbiguousTerminateReply(sock, call, session, options);
        return;
    }

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
        callerPn: call.callerPn,
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
        contactNameStore: options.contactNameStore,
        lidAliasStore: options.lidAliasStore,
        contactJids: options.contactJids || [],
        firstVoiceContentProvider: options.firstVoiceContentProvider,
        firstVoiceTranscoder: options.firstVoiceTranscoder,
    };

    const onCall = async (calls) => {
        for (const call of calls || []) {
            processCallUpdate(sock, buildCallFromBaileysEvent(call), handlerOptions);
        }
    };

    const onMessagesUpsert = async upsert => {
        try {
            await processCallLogUpsert(sock, upsert, handlerOptions);
        } catch (error) {
            console.log(`[CALL] Gagal membaca call-log: ${String(error.message || error).slice(0, 180)}`);
        }
    };

    sock.ev.on("call", onCall);
    sock.ev.on("messages.upsert", onMessagesUpsert);
    handledSockets.set(sock, { onCall, onMessagesUpsert });
}

function disposeCallHandler(sock) {
    const handlers = handledSockets.get(sock);
    if (!handlers) return;

    const { onCall, onMessagesUpsert } = handlers;

    if (typeof sock.ev.off === "function") {
        sock.ev.off("call", onCall);
        sock.ev.off("messages.upsert", onMessagesUpsert);
    } else if (typeof sock.ev.removeListener === "function") {
        sock.ev.removeListener("call", onCall);
        sock.ev.removeListener("messages.upsert", onMessagesUpsert);
    }

    handledSockets.delete(sock);

    for (const timer of pendingReplyTimers.values()) clearTimeout(timer);
    pendingReplyTimers.clear();
}

module.exports = {
    handleCall,
    disposeCallHandler,
    getCallAutoReplyHealth: () => ({
        firstVoiceEnabled: FIRST_VOICE_ENABLED,
        firstVoiceResetMs: FIRST_VOICE_RESET_MS,
        firstVoiceTextTemplate: FIRST_VOICE_TEXT_TEMPLATE,
        personalizedFromSavedContact: true,
        stateMode: "memory-per-process",
        resetOnProcessRestart: true,
        customVoicePath: FIRST_VOICE_PATH || null,
        ffmpegBin: FFMPEG_BIN,
        ttsProviderFallbacks: TTS_ENDPOINTS.length,
        textFallbackDisabled: true,
        ambiguousTerminateUsesGrace: true,
        ambiguousTerminateGraceMs: TERMINATE_GRACE_MS,
        trackedCallers: Object.keys(loadFirstVoiceState().callers).length,
        stateFile: null,
    }),
    _getCallerReplyModeForTest: getCallerReplyMode,
    _renderFirstVoiceTextForTest: renderFirstVoiceText,
    _prepareFirstVoiceAudioForTest: prepareFirstVoiceAudio,
    _sendFirstVoiceReplyForTest: sendFirstVoiceReply,
    _processCallLogUpsertForTest: processCallLogUpsert,
    createTtsVoiceNoteContent,
    getTtsMaxCharacters: () => TTS_MAX_CHARACTERS,
    _simulateProcessRestartForTest: () => {
        firstVoiceStateCache = null;
        generatedVoiceCache.clear();
        callSessions.clear();
        repliedCallIds.clear();
        missedCallSpam.clear();
        answeredCallPeers.clear();
        for (const timer of pendingReplyTimers.values()) clearTimeout(timer);
        pendingReplyTimers.clear();
    },
    get isActive() {
        return false;
    },
};
