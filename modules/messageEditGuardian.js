"use strict"

const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

const DEFAULT_DATA_FILE = path.join(__dirname, "..", "data", "messageEditGuardian.json")
const EDIT_PROTOCOL_TYPE = 14
const originalMessageCache = new Map()
const processedEditCache = new Map()

let stateCache = null
let stateCacheFile = ""
let dedupeHydrated = false

function parseBool(value, fallback) {
    if (value == null || value === "") return fallback
    const clean = String(value).trim().toLowerCase()
    if (["1", "true", "yes", "on", "aktif", "enabled"].includes(clean)) return true
    if (["0", "false", "no", "off", "mati", "disabled"].includes(clean)) return false
    return fallback
}

function parsePositiveInt(value, fallback) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

function getRuntimeConfig() {
    return {
        enabled: parseBool(process.env.EDIT_GUARD_ENABLED, true),
        debug: parseBool(process.env.EDIT_GUARD_DEBUG, false),
        cacheTtlMs: parsePositiveInt(process.env.EDIT_GUARD_CACHE_TTL_MS, 86400000),
        cacheMax: parsePositiveInt(process.env.EDIT_GUARD_CACHE_MAX, 2000),
        dedupeTtlMs: parsePositiveInt(process.env.EDIT_GUARD_DEDUPE_TTL_MS, 86400000),
        dedupeMax: parsePositiveInt(process.env.EDIT_GUARD_DEDUPE_MAX, 1000),
        logMax: parsePositiveInt(process.env.EDIT_GUARD_LOG_MAX, 200),
    }
}

function getDataFile() {
    return path.resolve(process.env.EDIT_GUARD_DATA_FILE || DEFAULT_DATA_FILE)
}

function cloneDefaultStats() {
    return {
        totalEditEvents: 0,
        processedEdits: 0,
        toxicEdits: 0,
        duplicateEdits: 0,
        skippedPrivate: 0,
        skippedBotOff: 0,
        skippedAntiToxicOff: 0,
        lastEventAt: null,
        lastToxicEditAt: null,
    }
}

function cloneDefaultState() {
    return {
        version: 1,
        global: {
            enabled: true,
            debug: false,
        },
        groups: {},
        stats: cloneDefaultStats(),
        recent: [],
        dedupe: [],
    }
}

function normalizeJid(value) {
    return String(value || "").trim().toLowerCase()
}

function isGroupJid(value) {
    return normalizeJid(value).endsWith("@g.us")
}

function isPrivateJid(value) {
    const jid = normalizeJid(value)
    return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")
}

function isChatJid(value) {
    return isGroupJid(value) || isPrivateJid(value)
}

function pickChatJid(...values) {
    const candidates = values
        .flat(Infinity)
        .map(normalizeJid)
        .filter(isChatJid)
    return candidates.find(isGroupJid)
        || candidates.find(jid => jid.endsWith("@s.whatsapp.net"))
        || candidates.find(jid => jid.endsWith("@lid"))
        || ""
}

function normalizeComparisonText(value) {
    return String(value || "")
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase()
}

function hashText(value) {
    return crypto.createHash("sha256").update(normalizeComparisonText(value), "utf8").digest("hex")
}

function sanitizeTimestamp(value, fallback = Date.now()) {
    let number = Number(value)
    if (!Number.isFinite(number) && value && typeof value.toNumber === "function") {
        number = Number(value.toNumber())
    }
    if (!Number.isFinite(number) || number <= 0) return fallback
    return number < 100000000000 ? number * 1000 : number
}

function sanitizeRecentRecord(record = {}) {
    return {
        groupJid: isChatJid(record.groupJid) ? normalizeJid(record.groupJid) : "",
        messageId: String(record.messageId || "").slice(0, 160),
        senderJid: normalizeJid(record.senderJid).slice(0, 160),
        editedTextHash: /^[a-f0-9]{64}$/i.test(String(record.editedTextHash || ""))
            ? String(record.editedTextHash).toLowerCase()
            : "",
        result: String(record.result || "skipped").slice(0, 40),
        matchedWordsMasked: Array.isArray(record.matchedWordsMasked)
            ? record.matchedWordsMasked.map(item => String(item || "").slice(0, 40)).slice(0, 20)
            : [],
        editedAt: sanitizeTimestamp(record.editedAt, Date.now()),
    }
}

function sanitizeDedupeRecord(record = {}) {
    return {
        groupJid: isChatJid(record.groupJid) ? normalizeJid(record.groupJid) : "",
        messageId: String(record.messageId || "").slice(0, 160),
        editedTextHash: /^[a-f0-9]{64}$/i.test(String(record.editedTextHash || ""))
            ? String(record.editedTextHash).toLowerCase()
            : "",
        result: String(record.result || "processing").slice(0, 40),
        processedAt: sanitizeTimestamp(record.processedAt, Date.now()),
        expiresAt: sanitizeTimestamp(record.expiresAt, Date.now()),
    }
}

function normalizeState(raw) {
    const base = cloneDefaultState()
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
    const config = getRuntimeConfig()
    const groups = {}
    for (const [jid, entry] of Object.entries(value.groups || {})) {
        if (!isGroupJid(jid) || !entry || typeof entry !== "object") continue
        groups[normalizeJid(jid)] = {
            enabled: entry.enabled !== false,
            updatedAt: Number(entry.updatedAt || 0),
            updatedBy: normalizeJid(entry.updatedBy),
        }
    }

    const stats = { ...base.stats }
    for (const key of Object.keys(stats)) {
        if (key === "lastEventAt" || key === "lastToxicEditAt") {
            stats[key] = value.stats?.[key] == null ? null : Number(value.stats[key]) || null
        } else {
            stats[key] = Math.max(0, Number(value.stats?.[key] || 0) || 0)
        }
    }

    return {
        version: 1,
        global: {
            enabled: value.global?.enabled !== false,
            debug: value.global?.debug === true,
        },
        groups,
        stats,
        recent: (Array.isArray(value.recent) ? value.recent : [])
            .map(sanitizeRecentRecord)
            .filter(item => item.groupJid && item.messageId && item.editedTextHash)
            .slice(-config.logMax),
        dedupe: (Array.isArray(value.dedupe) ? value.dedupe : [])
            .map(sanitizeDedupeRecord)
            .filter(item => item.groupJid && item.messageId && item.editedTextHash)
            .sort((a, b) => a.processedAt - b.processedAt)
            .slice(-config.dedupeMax),
    }
}

function writeStateAtomic(state, filePath = getDataFile()) {
    const normalized = normalizeState(state)
    const directory = path.dirname(filePath)
    const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
    fs.mkdirSync(directory, { recursive: true })
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
        fs.renameSync(temporary, filePath)
    } finally {
        try {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
        } catch {}
    }
    return normalized
}

function loadState(filePath = getDataFile()) {
    try {
        if (!fs.existsSync(filePath)) {
            return writeStateAtomic(cloneDefaultState(), filePath)
        }
        return normalizeState(JSON.parse(fs.readFileSync(filePath, "utf8")))
    } catch (error) {
        try {
            if (fs.existsSync(filePath)) {
                const corruptPath = path.join(
                    path.dirname(filePath),
                    `messageEditGuardian.corrupt.${Date.now()}.json`
                )
                fs.renameSync(filePath, corruptPath)
            }
        } catch {}
        try {
            return writeStateAtomic(cloneDefaultState(), filePath)
        } catch {
            return cloneDefaultState()
        }
    }
}

function saveState(state, filePath = getDataFile()) {
    const normalized = writeStateAtomic(state, filePath)
    if (filePath === getDataFile()) {
        stateCache = normalized
        stateCacheFile = filePath
    }
    return normalized
}

function getState() {
    const filePath = getDataFile()
    if (!stateCache || stateCacheFile !== filePath) {
        stateCache = loadState(filePath)
        stateCacheFile = filePath
        dedupeHydrated = false
    }
    return stateCache
}

function persistState(state) {
    stateCache = saveState(state, getDataFile())
    stateCacheFile = getDataFile()
    return stateCache
}

function unwrapMessageContent(message) {
    let current = message || {}
    for (let index = 0; index < 10; index += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message
        else break
    }
    return current || {}
}

function extractMessageText(message) {
    const content = unwrapMessageContent(message)
    return String(
        content.conversation
        || content.extendedTextMessage?.text
        || content.imageMessage?.caption
        || content.videoMessage?.caption
        || content.documentMessage?.caption
        || ""
    ).trim()
}

function isEditProtocolType(value) {
    if (Number(value) === EDIT_PROTOCOL_TYPE) return true
    return String(value || "").trim().toUpperCase() === "MESSAGE_EDIT"
}

function unwrapEditedPayload(value) {
    let current = value
    for (let index = 0; index < 10; index += 1) {
        if (!current || typeof current !== "object") return null
        if (current.message && typeof current.message === "object") current = current.message
        else if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message
        else break
    }
    return current && typeof current === "object" ? current : null
}

function findEditedPayload(container, depth = 0) {
    if (!container || typeof container !== "object" || depth > 8) return null

    if (container.protocolMessage) {
        const protocol = container.protocolMessage
        if (!isEditProtocolType(protocol.type) || !protocol.editedMessage) return null
        return unwrapEditedPayload(protocol.editedMessage)
    }

    if (container.editedMessage) {
        return unwrapEditedPayload(container.editedMessage)
    }

    for (const wrapper of [
        container.ephemeralMessage,
        container.viewOnceMessage,
        container.viewOnceMessageV2,
        container.documentWithCaptionMessage,
    ]) {
        const found = findEditedPayload(wrapper?.message, depth + 1)
        if (found) return found
    }

    return null
}

function extractEditedMessage(update, options = {}) {
    const updateBody = update?.update && typeof update.update === "object" ? update.update : update
    const candidates = [
        updateBody?.message,
        updateBody,
        update?.message,
    ]

    for (const candidate of candidates) {
        const found = findEditedPayload(candidate)
        if (found && extractMessageText(found)) return found
    }

    // Baileys v7 mematerialisasi MESSAGE_EDIT menjadi messages.update dengan
    // update.message berisi konten BARU secara langsung (tanpa protocolMessage).
    // Jalur ini hanya boleh dipakai oleh handler messages.update, bukan detector
    // messages.upsert biasa, agar pesan normal tidak dianggap sebagai edit.
    if (options.allowDirectUpdateMessage === true) {
        const direct = unwrapEditedPayload(update?.update?.message)
        if (direct && extractMessageText(direct)) return direct
    }

    return null
}

function findEditProtocol(container, depth = 0) {
    if (!container || typeof container !== "object" || depth > 8) return null
    if (
        container.protocolMessage
        && isEditProtocolType(container.protocolMessage.type)
        && container.protocolMessage.editedMessage
    ) {
        return container.protocolMessage
    }

    for (const wrapper of [
        container.ephemeralMessage,
        container.viewOnceMessage,
        container.viewOnceMessageV2,
        container.documentWithCaptionMessage,
    ]) {
        const found = findEditProtocol(wrapper?.message, depth + 1)
        if (found) return found
    }
    return null
}

function normalizeEditUpsertMessage(msg) {
    if (!msg || typeof msg !== "object") return null
    const editedMessage = extractEditedMessage(msg)
    if (!editedMessage) return null

    const protocol = findEditProtocol(msg.message)
    const outerKey = msg.key && typeof msg.key === "object" ? msg.key : {}
    const protocolKey = protocol?.key && typeof protocol.key === "object" ? protocol.key : {}
    const remoteJid = pickChatJid(
        outerKey.remoteJid,
        outerKey.remoteJidAlt,
        protocolKey.remoteJid,
        protocolKey.remoteJidAlt
    )
    const id = String(protocolKey.id || outerKey.id || "").trim()
    if (!isChatJid(remoteJid) || !id) return null

    const participant = normalizeJid(
        protocolKey.participant
        || protocolKey.participantAlt
        || outerKey.participant
        || outerKey.participantAlt
        || msg.participant
        || msg.participantAlt
    )
    const fromMe = protocolKey.fromMe == null
        ? Boolean(outerKey.fromMe)
        : Boolean(protocolKey.fromMe)

    return {
        key: {
            ...outerKey,
            ...protocolKey,
            remoteJid,
            id,
            fromMe,
            participant,
            participantAlt: normalizeJid(protocolKey.participantAlt || outerKey.participantAlt),
        },
        update: {
            message: msg.message,
            messageTimestamp: protocol?.timestampMs || msg.messageTimestamp,
        },
        messageTimestamp: msg.messageTimestamp,
        __editUpsertEventId: String(outerKey.id || ""),
    }
}

function isMessageEditUpsert(msg) {
    return Boolean(normalizeEditUpsertMessage(msg))
}

function normalizeMessageUpdate(update) {
    if (!update || typeof update !== "object") return null
    const editedMessage = extractEditedMessage(update, { allowDirectUpdateMessage: true })
    if (!editedMessage) return null

    const body = update.update && typeof update.update === "object" ? update.update : update
    const key = update.key || body.key || {}
    const remoteJid = pickChatJid(key.remoteJid, key.remoteJidAlt)
    const id = String(key.id || "").trim()
    const editedText = extractMessageText(editedMessage)

    if (!isChatJid(remoteJid) || !id || !editedText) return null

    return {
        isEdit: true,
        key: {
            ...key,
            remoteJid,
            id,
            fromMe: Boolean(key.fromMe),
            participant: normalizeJid(key.participant || key.participantAlt),
        },
        editedMessage,
        editedText,
        editedAt: sanitizeTimestamp(
            body.messageTimestamp
            || body.protocolMessage?.timestampMs
            || update.messageTimestamp,
            Date.now()
        ),
        rawUpdate: update,
    }
}

function makeOriginalCacheKey(remoteJid, messageId) {
    return `${normalizeJid(remoteJid)}:${String(messageId || "").trim()}`
}

function makeDedupeKey(remoteJid, messageId, editedTextHash) {
    return `${makeOriginalCacheKey(remoteJid, messageId)}:${editedTextHash}`
}

function resolveSenderJid(value, context = {}) {
    const original = normalizeJid(value)
    if (!original) return ""
    if (original.endsWith("@lid") && typeof context.lidAliasStore?.resolveBestJid === "function") {
        const resolved = normalizeJid(context.lidAliasStore.resolveBestJid(original))
        if (resolved) return resolved
    }
    return original
}

function makeLightOriginalMessage(msg, participant) {
    return {
        key: {
            remoteJid: normalizeJid(msg?.key?.remoteJid),
            remoteJidAlt: normalizeJid(msg?.key?.remoteJidAlt),
            id: String(msg?.key?.id || ""),
            fromMe: Boolean(msg?.key?.fromMe),
            participant: normalizeJid(msg?.key?.participant || participant),
            participantAlt: normalizeJid(msg?.key?.participantAlt),
        },
        participant: normalizeJid(msg?.participant || participant),
        participantAlt: normalizeJid(msg?.participantAlt),
        pushName: String(msg?.pushName || "").slice(0, 200),
        messageTimestamp: msg?.messageTimestamp,
    }
}

function cleanupMessageEditCache(now = Date.now()) {
    const config = getRuntimeConfig()
    for (const [key, entry] of originalMessageCache) {
        if (!entry || Number(entry.expiresAt || 0) <= now) originalMessageCache.delete(key)
    }
    while (originalMessageCache.size > config.cacheMax) {
        const oldest = originalMessageCache.keys().next().value
        if (!oldest) break
        originalMessageCache.delete(oldest)
    }

    for (const [key, entry] of processedEditCache) {
        if (!entry || Number(entry.expiresAt || 0) <= now) processedEditCache.delete(key)
    }
    while (processedEditCache.size > config.dedupeMax) {
        const oldest = processedEditCache.keys().next().value
        if (!oldest) break
        processedEditCache.delete(oldest)
    }

    return {
        cacheSize: originalMessageCache.size,
        dedupeSize: processedEditCache.size,
    }
}

function rememberOriginalMessage(msg, context = {}) {
    try {
        const key = msg?.key || {}
        const remoteJid = pickChatJid(key.remoteJid, key.remoteJidAlt)
        const messageId = String(key.id || "").trim()
        if (!isChatJid(remoteJid) || !messageId || context.isBotGenerated) return false

        const originalText = extractMessageText(msg?.message)
        if (!originalText) return false

        const participant = normalizeJid(
            key.participant
            || key.participantAlt
            || msg?.participant
            || msg?.participantAlt
            || context.senderJid
            || (key.fromMe ? context.ownerJid : "")
            || (!isGroupJid(remoteJid) ? remoteJid : "")
        )
        if (!participant) return false

        const now = Number(context.now || Date.now())
        const config = getRuntimeConfig()
        cleanupMessageEditCache(now)
        const cacheKey = makeOriginalCacheKey(remoteJid, messageId)
        originalMessageCache.delete(cacheKey)
        originalMessageCache.set(cacheKey, {
            remoteJid,
            messageId,
            participant,
            senderJid: resolveSenderJid(context.senderJid || participant, context),
            originalText,
            originalTextHash: hashText(originalText),
            messageTimestamp: sanitizeTimestamp(msg?.messageTimestamp, now),
            originalMessage: makeLightOriginalMessage(msg, participant),
            createdAt: now,
            expiresAt: now + config.cacheTtlMs,
        })
        cleanupMessageEditCache(now)
        return true
    } catch (error) {
        logFailure(error)
        return false
    }
}

function hydrateDedupeCache(now = Date.now()) {
    if (dedupeHydrated) return
    const state = getState()
    for (const item of state.dedupe || []) {
        if (Number(item.expiresAt || 0) <= now) continue
        processedEditCache.set(
            makeDedupeKey(item.groupJid, item.messageId, item.editedTextHash),
            {
                expiresAt: item.expiresAt,
                result: item.result,
            }
        )
    }
    dedupeHydrated = true
    cleanupMessageEditCache(now)
}

function getMessageEditGuardianConfig(groupJid = "") {
    const state = getState()
    const runtime = getRuntimeConfig()
    const jid = normalizeJid(groupJid)
    const group = isGroupJid(jid) ? state.groups[jid] || null : null
    return {
        ...runtime,
        enabled: runtime.enabled && state.global.enabled !== false && (!group || group.enabled !== false),
        globalEnabled: runtime.enabled && state.global.enabled !== false,
        debug: runtime.debug || state.global.debug === true,
        groupEnabled: !group || group.enabled !== false,
        group,
    }
}

function isMessageEditGuardianEnabled(groupJid = "") {
    return getMessageEditGuardianConfig(groupJid).enabled
}

function debugLog(normalized, result, extra = {}) {
    const config = getMessageEditGuardianConfig(normalized?.key?.remoteJid || "")
    const traceEnabled = parseBool(process.env.ROUTER_TRACE_ENABLED, false)
    if (!config.debug && !traceEnabled) return
    const parts = [
        "[EDIT GUARD]",
        `group=${String(normalized?.key?.remoteJid || "-").slice(0, 40)}`,
        `message=${String(normalized?.key?.id || "-").slice(0, 16)}`,
        `result=${result}`,
    ]
    if (extra.handled === true) parts.push("handled=true")
    if (extra.reason) parts.push(`reason=${String(extra.reason).slice(0, 80)}`)
    console.log(parts.join(" "))
}

function logFailure(error) {
    console.log(`[EDIT GUARD] Failed to process message edit: ${String(error?.message || error || "unknown").slice(0, 300)}`)
}

function getJidNumber(value) {
    return String(value || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "")
}

function normalizeMentionJid(value) {
    const clean = normalizeJid(value)
    if (/^\d+@s\.whatsapp\.net$/i.test(clean) || /^\d+@lid$/i.test(clean)) return clean
    return ""
}

function sanitizeInlineName(value) {
    return String(value || "")
        .normalize("NFKC")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .replace(/\*/g, "＊")
        .trim()
        .slice(0, 100)
}

function sanitizeLogText(value, fallback = "(tidak tersedia)", limit = 1600) {
    const clean = String(value || "")
        .normalize("NFKC")
        .replace(/\*/g, "＊")
        .trim()
    if (!clean) return fallback
    if (clean.length <= limit) return clean
    return `${clean.slice(0, Math.max(0, limit - 14))}... (dipotong)`
}

async function sendEditedMessageLog(context = {}, details = {}) {
    if (context.skipEditLog === true) {
        return { sent: false, reason: "runtime-bridge-owned" }
    }
    const sock = context.sock
    const securityMediaLog = context.securityMediaLog
    if (!sock || typeof sock.sendMessage !== "function") return { sent: false, reason: "no-sock" }
    if (!securityMediaLog || typeof securityMediaLog.getSecurityLogJid !== "function") {
        return { sent: false, reason: "no-target" }
    }

    const targetJid = securityMediaLog.getSecurityLogJid()
    if (!isGroupJid(targetJid)) return { sent: false, reason: "invalid-target" }

    const mentionJid = normalizeMentionJid(details.senderJid)
    const number = getJidNumber(mentionJid || details.senderJid)
    const mentionText = number ? `@${number}` : String(details.senderJid || "Tidak diketahui")
    const contactName = sanitizeInlineName(
        context.contactNameStore?.resolveContactName?.(details.senderJid, [
            details.contactName,
            details.pushName,
        ])
        || details.contactName
        || details.pushName
    )
    const senderLine = `Pengirim: ${mentionText}${contactName ? ` (${contactName})` : ""}`
    const oldText = sanitizeLogText(details.originalText)
    const newText = sanitizeLogText(details.editedText)
    const text = [
        "> ✏️ *JEJAK EDIT PESAN TERDETEKSI*",
        "",
        senderLine,
        "",
        "Pesan lama:",
        oldText,
        "",
        "Pesan baru:",
        `*${newText}*`,
    ].join("\n")
    const outbound = {
        text,
        ...(mentionJid ? { mentions: [mentionJid] } : {}),
    }

    try {
        const result = await sock.sendMessage(targetJid, outbound)
        console.log(`[EDIT GUARD] Log edit terkirim ke ${targetJid} untuk ${details.chatJid || "chat"}:${details.messageId || "-"}`)
        return { sent: true, targetJid, result, text, mentionJid, contactName }
    } catch (error) {
        if (mentionJid) {
            try {
                const result = await sock.sendMessage(targetJid, { text })
                console.log(`[EDIT GUARD] Log edit terkirim tanpa mention ke ${targetJid} untuk ${details.chatJid || "chat"}:${details.messageId || "-"}`)
                return { sent: true, targetJid, result, text, mentionJid: "", contactName, fallback: true }
            } catch {}
        }
        console.log(`[EDIT GUARD] Gagal kirim log edit: ${String(error?.message || error).slice(0, 240)}`)
        return { sent: false, targetJid, reason: "send-failed" }
    }
}

function applyStatsDelta(state, delta = {}) {
    state.stats = { ...cloneDefaultStats(), ...(state.stats || {}) }
    for (const [key, value] of Object.entries(delta)) {
        if (key === "lastEventAt" || key === "lastToxicEditAt") {
            state.stats[key] = value
        } else if (Object.prototype.hasOwnProperty.call(state.stats, key)) {
            state.stats[key] = Math.max(0, Number(state.stats[key] || 0) + Number(value || 0))
        }
    }
}

function persistRecent(record, statsDelta = {}) {
    const state = getState()
    applyStatsDelta(state, statsDelta)
    if (record) {
        state.recent = [...(state.recent || []), sanitizeRecentRecord(record)]
            .slice(-getRuntimeConfig().logMax)
    }
    persistState(state)
}

function markSimpleResult(normalized, senderJid, result, statsDelta = {}) {
    const editedTextHash = hashText(normalized.editedText)
    persistRecent({
        groupJid: normalized.key.remoteJid,
        messageId: normalized.key.id,
        senderJid,
        editedTextHash,
        result,
        matchedWordsMasked: [],
        editedAt: normalized.editedAt,
    }, statsDelta)
    debugLog(normalized, result)
    return { handled: false, result, editedTextHash }
}

function claimEdit(normalized, editedTextHash, now) {
    hydrateDedupeCache(now)
    const key = makeDedupeKey(normalized.key.remoteJid, normalized.key.id, editedTextHash)
    const existing = processedEditCache.get(key)
    if (existing && Number(existing.expiresAt || 0) > now) return false

    const config = getRuntimeConfig()
    const record = {
        groupJid: normalized.key.remoteJid,
        messageId: normalized.key.id,
        editedTextHash,
        result: "processing",
        processedAt: now,
        expiresAt: now + config.dedupeTtlMs,
    }
    processedEditCache.set(key, { expiresAt: record.expiresAt, result: record.result })
    cleanupMessageEditCache(now)

    const state = getState()
    state.dedupe = [...(state.dedupe || []).filter(item => (
        makeDedupeKey(item.groupJid, item.messageId, item.editedTextHash) !== key
        && Number(item.expiresAt || 0) > now
    )), record].slice(-config.dedupeMax)
    persistState(state)
    return true
}

function finalizeClaim(normalized, editedTextHash, result, now) {
    const key = makeDedupeKey(normalized.key.remoteJid, normalized.key.id, editedTextHash)
    const memory = processedEditCache.get(key)
    if (memory) memory.result = result

    const state = getState()
    state.dedupe = (state.dedupe || []).map(item => (
        makeDedupeKey(item.groupJid, item.messageId, item.editedTextHash) === key
            ? { ...item, result }
            : item
    )).filter(item => Number(item.expiresAt || 0) > now)
    persistState(state)
}

function buildSyntheticEditedMessage(originalMessage, update, editedMessage, editedText) {
    const normalized = update?.isEdit ? update : normalizeMessageUpdate(update)
    if (!normalized || !editedMessage || !editedText) return null
    const original = originalMessage || {}
    const rawParticipant = normalizeJid(
        normalized.key.participant
        || original.key?.participant
        || original.participant
        || original.key?.participantAlt
        || original.participantAlt
    )
    if (!rawParticipant) return null

    return {
        ...original,
        key: {
            ...(original.key || {}),
            ...(normalized.key || {}),
            remoteJid: normalized.key.remoteJid,
            id: normalized.key.id,
            participant: rawParticipant,
            fromMe: false,
        },
        participant: rawParticipant,
        pushName: String(original.pushName || "").slice(0, 200),
        messageTimestamp: original.messageTimestamp || Math.floor(normalized.editedAt / 1000),
        message: editedMessage,
        editGuardianSource: "edited-message",
    }
}

function updateCachedVersion(cacheKey, cacheEntry, syntheticMessage, normalized, senderJid, now) {
    const config = getRuntimeConfig()
    originalMessageCache.delete(cacheKey)
    originalMessageCache.set(cacheKey, {
        ...(cacheEntry || {}),
        remoteJid: normalized.key.remoteJid,
        messageId: normalized.key.id,
        participant: normalizeJid(syntheticMessage?.key?.participant || normalized.key.participant),
        senderJid,
        originalText: normalized.editedText,
        originalTextHash: hashText(normalized.editedText),
        originalMessage: makeLightOriginalMessage(syntheticMessage, syntheticMessage?.key?.participant),
        messageTimestamp: sanitizeTimestamp(syntheticMessage?.messageTimestamp, now),
        createdAt: now,
        expiresAt: now + config.cacheTtlMs,
    })
    cleanupMessageEditCache(now)
}

async function loadOriginalFallback(normalized, context = {}) {
    if (typeof context.getMessage !== "function") return null
    try {
        const message = await context.getMessage(normalized.key)
        if (!message || typeof message !== "object") return null
        return {
            remoteJid: normalized.key.remoteJid,
            messageId: normalized.key.id,
            participant: normalized.key.participant,
            senderJid: resolveSenderJid(normalized.key.participant, context),
            originalText: extractMessageText(message),
            originalTextHash: hashText(extractMessageText(message)),
            originalMessage: {
                key: { ...normalized.key, fromMe: false },
                participant: normalized.key.participant,
                messageTimestamp: Math.floor(normalized.editedAt / 1000),
            },
        }
    } catch {
        return null
    }
}

async function handleMessageEditUpdate(update, context = {}) {
    try {
        const rawEditedMessage = extractEditedMessage(update, { allowDirectUpdateMessage: true })
        if (!rawEditedMessage) return { handled: false, result: "not-edit" }

        const normalized = normalizeMessageUpdate(update)
        if (!normalized) return { handled: false, result: "invalid-edit" }
        const now = Number(context.now || Date.now())
        cleanupMessageEditCache(now)

        const state = getState()
        applyStatsDelta(state, {
            totalEditEvents: 1,
            lastEventAt: now,
        })
        persistState(state)

        const groupJid = normalized.key.remoteJid
        if (
            typeof context.isBotSentMessageId === "function"
            && context.isBotSentMessageId(normalized.key.id)
        ) {
            return markSimpleResult(normalized, normalized.key.participant, "skipped")
        }

        const guardianConfig = getMessageEditGuardianConfig(groupJid)
        if (!guardianConfig.globalEnabled) {
            return markSimpleResult(normalized, normalized.key.participant, "skipped")
        }

        if (typeof context.isSecurityLogChat === "function" && context.isSecurityLogChat(groupJid)) {
            return markSimpleResult(normalized, normalized.key.participant, "skipped")
        }

        const cacheKey = makeOriginalCacheKey(groupJid, normalized.key.id)
        let cached = originalMessageCache.get(cacheKey) || null
        if (!cached) cached = await loadOriginalFallback(normalized, context)

        const ownerValue = typeof context.ownerJid === "function" ? context.ownerJid() : context.ownerJid
        const rawParticipant = normalizeJid(
            normalized.key.participant
            || cached?.participant
            || cached?.originalMessage?.key?.participant
            || (normalized.key.fromMe ? ownerValue : "")
            || (!isGroupJid(groupJid) ? groupJid : "")
        )
        if (!rawParticipant) {
            return markSimpleResult(normalized, "", "skipped")
        }
        const senderJid = resolveSenderJid(
            cached?.senderJid
            || (normalized.key.fromMe ? ownerValue : "")
            || rawParticipant,
            context
        )
        if (!senderJid) {
            return markSimpleResult(normalized, rawParticipant, "skipped")
        }

        const originalText = String(cached?.originalText || "")
        const originalHash = originalText ? hashText(originalText) : ""
        const editedTextHash = hashText(normalized.editedText)
        hydrateDedupeCache(now)
        const existingClaim = processedEditCache.get(
            makeDedupeKey(groupJid, normalized.key.id, editedTextHash)
        )
        if (existingClaim && Number(existingClaim.expiresAt || 0) > now) {
            persistRecent({
                groupJid,
                messageId: normalized.key.id,
                senderJid,
                editedTextHash,
                result: "duplicate",
                matchedWordsMasked: [],
                editedAt: normalized.editedAt,
            }, { duplicateEdits: 1 })
            debugLog(normalized, "duplicate")
            return { handled: false, result: "duplicate", editedTextHash }
        }
        if (!editedTextHash || (originalHash && originalHash === editedTextHash)) {
            return markSimpleResult(normalized, senderJid, "skipped")
        }

        const syntheticMessage = buildSyntheticEditedMessage(
            cached?.originalMessage || {
                key: { ...normalized.key, participant: rawParticipant, fromMe: false },
                participant: rawParticipant,
                pushName: cached?.pushName || "",
            },
            { ...normalized, key: { ...normalized.key, participant: rawParticipant } },
            normalized.editedMessage,
            normalized.editedText
        )
        if (!syntheticMessage) {
            return markSimpleResult(normalized, senderJid, "skipped")
        }
        if (rawParticipant.endsWith("@lid") && senderJid.endsWith("@s.whatsapp.net")) {
            syntheticMessage.key.participantAlt = senderJid
            syntheticMessage.participantAlt = senderJid
        }

        if (!claimEdit(normalized, editedTextHash, now)) {
            persistRecent({
                groupJid,
                messageId: normalized.key.id,
                senderJid,
                editedTextHash,
                result: "duplicate",
                matchedWordsMasked: [],
                editedAt: normalized.editedAt,
            }, { duplicateEdits: 1 })
            debugLog(normalized, "duplicate")
            return { handled: false, result: "duplicate", editedTextHash }
        }

        const logResult = await sendEditedMessageLog(context, {
            chatJid: groupJid,
            messageId: normalized.key.id,
            senderJid,
            pushName: cached?.originalMessage?.pushName || syntheticMessage?.pushName || "",
            originalText,
            editedText: normalized.editedText,
        })

        updateCachedVersion(cacheKey, cached, syntheticMessage, normalized, senderJid, now)

        const finishLoggedSkip = (recentResult, statsDelta = {}) => {
            finalizeClaim(normalized, editedTextHash, recentResult, now)
            persistRecent({
                groupJid,
                messageId: normalized.key.id,
                senderJid,
                editedTextHash,
                result: recentResult,
                matchedWordsMasked: [],
                editedAt: normalized.editedAt,
            }, statsDelta)
            debugLog(normalized, recentResult)
            return {
                handled: false,
                result: "skipped",
                editedTextHash,
                logSent: logResult.sent === true,
                logTargetJid: logResult.targetJid || "",
            }
        }

        if (normalized.key.fromMe) {
            return finishLoggedSkip("logged-owner")
        }

        if (/^\s*\./.test(normalized.editedText)) {
            return finishLoggedSkip("logged-command")
        }

        // PM hanya dicatat ke grup log. Moderasi Anti Kasar tetap khusus grup.
        if (!isGroupJid(groupJid)) {
            return finishLoggedSkip("logged-private", { skippedPrivate: 1 })
        }

        if (
            typeof context.groupRemoteControl?.isGroupBotEnabled === "function"
            && !context.groupRemoteControl.isGroupBotEnabled(groupJid)
        ) {
            return finishLoggedSkip("logged-bot-off", { skippedBotOff: 1 })
        }

        if (
            typeof context.groupRemoteControl?.isGroupFeatureEnabled === "function"
            && !context.groupRemoteControl.isGroupFeatureEnabled(groupJid, "editGuardian")
        ) {
            return finishLoggedSkip("logged-edit-off")
        }

        if (
            typeof context.groupRemoteControl?.isGroupFeatureEnabled === "function"
            && !context.groupRemoteControl.isGroupFeatureEnabled(groupJid, "antiToxic")
        ) {
            return finishLoggedSkip("logged", { skippedAntiToxicOff: 1 })
        }

        if (
            typeof context.antiToxicControl?.shouldRunAntiToxic === "function"
            && !context.antiToxicControl.shouldRunAntiToxic(syntheticMessage)
        ) {
            return finishLoggedSkip("logged", { skippedAntiToxicOff: 1 })
        }

        if (typeof context.antiToxic?.handleToxicCheck !== "function") {
            finalizeClaim(normalized, editedTextHash, "error", now)
            persistRecent({
                groupJid,
                messageId: normalized.key.id,
                senderJid,
                editedTextHash,
                result: "error",
                matchedWordsMasked: [],
                editedAt: normalized.editedAt,
            })
            return { handled: false, result: "error", editedTextHash, logSent: logResult.sent === true }
        }

        let handled = false
        try {
            handled = Boolean(await context.antiToxic.handleToxicCheck(
                syntheticMessage,
                context.sock,
                ownerValue,
                {
                    groupPrivateReply: Boolean(
                        context.groupRemoteControl?.isGroupAntiToxicPrivateReplyEnabled?.(groupJid)
                    ),
                    source: "edited-message",
                }
            ))
        } catch (error) {
            finalizeClaim(normalized, editedTextHash, "error", now)
            persistRecent({
                groupJid,
                messageId: normalized.key.id,
                senderJid,
                editedTextHash,
                result: "error",
                matchedWordsMasked: [],
                editedAt: normalized.editedAt,
            })
            logFailure(error)
            return { handled: false, result: "error", editedTextHash, logSent: logResult.sent === true }
        }

        const result = handled ? "toxic" : "clean"
        finalizeClaim(normalized, editedTextHash, result, now)
        persistRecent({
            groupJid,
            messageId: normalized.key.id,
            senderJid,
            editedTextHash,
            result,
            matchedWordsMasked: [],
            editedAt: normalized.editedAt,
        }, {
            processedEdits: 1,
            toxicEdits: handled ? 1 : 0,
            ...(handled ? { lastToxicEditAt: now } : {}),
        })
        debugLog(normalized, result, { handled })
        return {
            handled,
            result,
            editedTextHash,
            logSent: logResult.sent === true,
            logTargetJid: logResult.targetJid || "",
        }
    } catch (error) {
        logFailure(error)
        return { handled: false, result: "error" }
    }
}

async function handleMessageUpdates(updates, context = {}) {
    const list = Array.isArray(updates) ? updates : [updates].filter(Boolean)
    const results = []
    for (const update of list) {
        try {
            results.push(await handleMessageEditUpdate(update, context))
        } catch (error) {
            logFailure(error)
            results.push({ handled: false, result: "error" })
        }
    }
    return results
}

async function handleMessageEditUpsert(msg, context = {}) {
    const update = normalizeEditUpsertMessage(msg)
    if (!update) return { handled: false, result: "not-edit-upsert" }
    const result = await handleMessageEditUpdate(update, context)
    return {
        ...result,
        editEventId: update.__editUpsertEventId || "",
        originalMessageId: update?.key?.id || "",
    }
}

async function handleMessageEditUpserts(messages, context = {}) {
    const list = Array.isArray(messages) ? messages : [messages].filter(Boolean)
    const results = []
    for (const msg of list) {
        try {
            results.push(await handleMessageEditUpsert(msg, context))
        } catch (error) {
            logFailure(error)
            results.push({ handled: false, result: "error" })
        }
    }
    return results
}

function formatWib(value) {
    if (!value) return "belum ada"
    try {
        return new Intl.DateTimeFormat("id-ID", {
            timeZone: "Asia/Jakarta",
            dateStyle: "medium",
            timeStyle: "medium",
        }).format(new Date(Number(value)))
    } catch {
        return new Date(Number(value)).toISOString()
    }
}

function maskJid(value) {
    const clean = normalizeJid(value)
    const [user, server] = clean.split("@")
    if (!user) return "-"
    const masked = user.length <= 7
        ? `${user.slice(0, 2)}***`
        : `${user.slice(0, 4)}***${user.slice(-3)}`
    return server ? `${masked}@${server}` : masked
}

function getMessageEditGuardianHealth() {
    try {
        cleanupMessageEditCache()
        const state = getState()
        const config = getMessageEditGuardianConfig()
        return {
            enabled: config.globalEnabled,
            scope: "Group + Private Edit Log; Anti Kasar khusus grup",
            cacheSize: originalMessageCache.size,
            cacheMax: config.cacheMax,
            dedupeSize: processedEditCache.size,
            processedEdits: Number(state.stats?.processedEdits || 0),
            toxicEdits: Number(state.stats?.toxicEdits || 0),
            duplicateEdits: Number(state.stats?.duplicateEdits || 0),
            lastEventAt: state.stats?.lastEventAt || null,
            lastToxicEditAt: state.stats?.lastToxicEditAt || null,
        }
    } catch {
        return null
    }
}

function isGuardianCommand(text) {
    return /^\.(editguard|messageedit|editguardian)(?:\s|$)/i.test(String(text || "").trim())
}

async function resolveGroupReference(input, sock, groupRemoteControl) {
    const value = normalizeJid(input)
    if (isGroupJid(value)) return { ok: true, jid: value, subject: value }
    if (typeof groupRemoteControl?.resolveGroupTarget === "function") {
        return groupRemoteControl.resolveGroupTarget(input, sock)
    }
    return { ok: false, reason: "invalid" }
}

async function getGroupSubject(sock, groupJid, fallback = "") {
    try {
        const metadata = await sock?.groupMetadata?.(groupJid)
        return String(metadata?.subject || metadata?.name || fallback || groupJid)
    } catch {
        return fallback || groupJid
    }
}

function getEffectiveGroupStatus(groupJid, context = {}) {
    const botEnabled = context.groupRemoteControl?.isGroupBotEnabled?.(groupJid) !== false
    const antiToxicEnabled = context.groupRemoteControl?.isGroupFeatureEnabled?.(groupJid, "antiToxic") !== false
    const remoteGuardianEnabled = context.groupRemoteControl?.isGroupFeatureEnabled?.(groupJid, "editGuardian") !== false
    const guardianEnabled = isMessageEditGuardianEnabled(groupJid) && remoteGuardianEnabled
    const synthetic = { key: { remoteJid: groupJid, fromMe: false } }
    const antiControlEnabled = context.antiToxicControl?.shouldRunAntiToxic
        ? context.antiToxicControl.shouldRunAntiToxic(synthetic)
        : true
    let effectiveStatus = "ACTIVE — Log + Anti Kasar"
    if (!guardianEnabled) effectiveStatus = "ACTIVE — Log only (group moderation OFF)"
    else if (!botEnabled) effectiveStatus = "ACTIVE — Log only (Bot group OFF)"
    else if (!antiToxicEnabled || !antiControlEnabled) effectiveStatus = "ACTIVE — Log only (Anti Kasar OFF)"
    return {
        botEnabled,
        antiToxicEnabled: antiToxicEnabled && antiControlEnabled,
        guardianEnabled,
        effectiveStatus,
    }
}

function getGuardianHelpText() {
    return [
        "✏️ *EDITED MESSAGE GUARDIAN*",
        "",
        ".editguard status",
        ".editguard test",
        ".editguard on",
        ".editguard off",
        ".editguard set <group_jid> on/off",
        ".editguard status <group_jid>",
        ".editguard log",
        ".editguard clear",
        ".editguard help",
        "",
        "Alias: .messageedit, .editguardian",
        "Command hanya melalui private chat owner.",
    ].join("\n")
}

async function handleMessageEditGuardianCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    if (!isGuardianCommand(text)) return false
    if (context.isGroup || isGroupJid(context.from || msg?.key?.remoteJid)) return true

    const from = normalizeJid(context.from || msg?.key?.remoteJid)
    if (!context.isOwner) {
        await sock.sendMessage(from, { text: "Akses Ditolak" })
        return true
    }

    const parts = text.split(/\s+/)
    const action = String(parts[1] || "help").toLowerCase()
    const state = getState()


    if (action === "test") {
        const ownerValue = normalizeJid(
            typeof context.ownerJid === "function" ? context.ownerJid() : context.ownerJid
        ) || from
        const result = await sendEditedMessageLog({
            sock,
            securityMediaLog: context.securityMediaLog,
            contactNameStore: context.contactNameStore,
        }, {
            chatJid: from,
            messageId: `EDIT-TEST-${Date.now()}`,
            senderJid: ownerValue,
            pushName: "Owner",
            originalText: "Ini contoh pesan sebelum diedit.",
            editedText: "Ini contoh pesan sesudah diedit.",
        })
        await sock.sendMessage(from, {
            text: result?.sent
                ? `✅ Test edit log berhasil dikirim ke ${result.targetJid}.`
                : `❌ Test edit log gagal: ${result?.reason || "unknown"}`,
        })
        return true
    }

    if (action === "on" || action === "off") {
        state.global.enabled = action === "on"
        persistState(state)
        await sock.sendMessage(from, {
            text: `Edited Message Guardian global: ${action === "on" ? "ON" : "OFF"}`,
        })
        return true
    }

    if (action === "set") {
        const resolved = await resolveGroupReference(parts[2], sock, context.groupRemoteControl)
        const enabled = parseBool(parts[3], null)
        if (!resolved?.ok || !isGroupJid(resolved.jid) || enabled === null) {
            await sock.sendMessage(from, { text: "Format: .editguard set <group_jid> on/off" })
            return true
        }
        state.groups[resolved.jid] = {
            enabled,
            updatedAt: Date.now(),
            updatedBy: normalizeJid(context.senderJid || from),
        }
        persistState(state)
        await sock.sendMessage(from, {
            text: `Edited Message Guardian untuk ${resolved.subject || resolved.jid}: ${enabled ? "ON" : "OFF"}`,
        })
        return true
    }

    if (action === "status" && parts[2]) {
        const resolved = await resolveGroupReference(parts[2], sock, context.groupRemoteControl)
        if (!resolved?.ok || !isGroupJid(resolved.jid)) {
            await sock.sendMessage(from, { text: "Group JID tidak valid." })
            return true
        }
        const subject = await getGroupSubject(sock, resolved.jid, resolved.subject)
        const effective = getEffectiveGroupStatus(resolved.jid, context)
        await sock.sendMessage(from, {
            text: [
                "✏️ *EDIT GUARD GROUP STATUS*",
                "",
                `Group: ${subject}`,
                `ID: ${resolved.jid}`,
                "",
                `Bot Group: ${effective.botEnabled ? "ON" : "OFF"}`,
                `Anti Kasar: ${effective.antiToxicEnabled ? "ON" : "OFF"}`,
                `Edited Message Guardian: ${effective.guardianEnabled ? "ON" : "OFF"}`,
                `Effective Status: ${effective.effectiveStatus}`,
            ].join("\n"),
        })
        return true
    }

    if (action === "status") {
        const health = getMessageEditGuardianHealth()
        const tapHealth = context.messageEditRuntimeBridge?.getMessageEditRuntimeBridgeHealth?.() || null
        await sock.sendMessage(from, {
            text: [
                "✏️ *EDITED MESSAGE GUARDIAN*",
                "",
                `Status Global: ${health?.enabled ? "ON" : "OFF"}`,
                `Runtime Tap: ${tapHealth?.installed ? "AKTIF" : "TIDAK AKTIF"}`,
                `Runtime Build: ${tapHealth?.build || "UNKNOWN"}`,
                "Scope Log: Group + Private Chat",
                "Action: Semua edit masuk Security Log",
                "Anti Kasar: diperiksa ulang khusus grup",
                "Group Bot OFF: LOG TETAP AKTIF",
                "Group Anti Kasar OFF: LOG ONLY",
                "",
                `Cache: ${health?.cacheSize ?? "UNKNOWN"} / ${health?.cacheMax ?? "UNKNOWN"}`,
                `Processed Edits: ${health?.processedEdits ?? "UNKNOWN"}`,
                `Toxic Edits: ${health?.toxicEdits ?? "UNKNOWN"}`,
                `Duplicate Edits: ${health?.duplicateEdits ?? "UNKNOWN"}`,
                `Last Event: ${health ? formatWib(health.lastEventAt) : "UNKNOWN"}`,
            ].join("\n"),
        })
        return true
    }

    if (action === "log") {
        const recent = [...(state.recent || [])].slice(-20).reverse()
        const lines = ["✏️ *EDITED MESSAGE GUARDIAN LOG*", ""]
        if (!recent.length) lines.push("Belum ada metadata edit.")
        recent.forEach((item, index) => {
            lines.push(`${index + 1}. ${formatWib(item.editedAt)} — ${item.result}`)
            lines.push(`Chat: ${maskJid(item.groupJid)}`)
            lines.push(`Sender: ${maskJid(item.senderJid)}`)
            lines.push(`Message ID: ${String(item.messageId || "-").slice(0, 12)}`)
            lines.push(`Result: ${item.result === "toxic" ? "Anti Kasar handled" : item.result === "clean" ? "No violation" : item.result}`)
            lines.push("")
        })
        await sock.sendMessage(from, { text: lines.join("\n") })
        return true
    }

    if (action === "clear") {
        const now = Date.now()
        cleanupMessageEditCache(now)
        state.recent = []
        state.dedupe = (state.dedupe || []).filter(item => Number(item.expiresAt || 0) > now)
        persistState(state)
        await sock.sendMessage(from, {
            text: "Recent log dibersihkan. Config on/off dan dedupe yang masih aktif tetap dipertahankan.",
        })
        return true
    }

    await sock.sendMessage(from, { text: getGuardianHelpText() })
    return true
}

function disposeMessageEditGuardian() {
    originalMessageCache.clear()
    processedEditCache.clear()
    stateCache = null
    stateCacheFile = ""
    dedupeHydrated = false
    return true
}

module.exports = {
    rememberOriginalMessage,
    handleMessageUpdates,
    handleMessageEditUpdate,
    handleMessageEditUpsert,
    handleMessageEditUpserts,
    normalizeEditUpsertMessage,
    isMessageEditUpsert,
    handleMessageEditGuardianCommand,
    normalizeMessageUpdate,
    extractEditedMessage,
    extractMessageText,
    buildSyntheticEditedMessage,
    sendEditedMessageLog,
    getMessageEditGuardianConfig,
    isMessageEditGuardianEnabled,
    cleanupMessageEditCache,
    getMessageEditGuardianHealth,
    loadState,
    saveState,
    disposeMessageEditGuardian,
}
