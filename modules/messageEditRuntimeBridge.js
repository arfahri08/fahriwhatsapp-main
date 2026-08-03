const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const secretEncryptedEdit = require("./secretEncryptedEdit")

const BUILD = "EDIT-SECRET-2026-08-03.2"
const TRACE_PATH = path.resolve(
    process.env.EDIT_TAP_TRACE_PATH
    || path.join(__dirname, "../data/editEventTrace.jsonl")
)
const TRACE_MAX_BYTES = Math.max(128 * 1024, Number(process.env.EDIT_TAP_TRACE_MAX_BYTES || 1024 * 1024))
const DEDUPE_TTL_MS = Math.max(60_000, Number(process.env.EDIT_TAP_DEDUPE_TTL_MS || 10 * 60 * 1000))
const DEDUPE_MAX = Math.max(100, Number(process.env.EDIT_TAP_DEDUPE_MAX || 5000))

let installedSocket = null
let originalEmit = null
let contextFactory = null
let processingQueue = Promise.resolve()
const dedupe = new Map()

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

function isStatusOrBroadcastJid(value) {
    return secretEncryptedEdit.isStatusOrBroadcastJid(value)
}

function rawUpdateUsesStatusTransport(rawUpdate, normalized = null) {
    const keys = [
        rawUpdate?.key,
        rawUpdate?.update?.key,
        normalized?.key,
    ].filter(Boolean)
    return keys.some(key => [key.remoteJid, key.remoteJidAlt].some(isStatusOrBroadcastJid))
}

function getContext() {
    try {
        return typeof contextFactory === "function" ? (contextFactory() || {}) : (contextFactory || {})
    } catch (error) {
        console.log(`[EDIT TAP] context error: ${String(error?.message || error).slice(0, 220)}`)
        return {}
    }
}

function compactError(error) {
    return String(error?.message || error || "unknown")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300)
}

function safeKeys(value) {
    return value && typeof value === "object" ? Object.keys(value).slice(0, 20) : []
}

function sanitizeTraceValue(value, depth = 0) {
    if (depth > 3) return "[depth-limit]"
    if (value == null || typeof value === "boolean" || typeof value === "number") return value
    if (typeof value === "string") return value.slice(0, 500)
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary:${value.length}]`
    if (Array.isArray(value)) return value.slice(0, 10).map(item => sanitizeTraceValue(item, depth + 1))
    if (typeof value === "object") {
        const out = {}
        for (const key of Object.keys(value).slice(0, 25)) {
            if (/mediaKey|messageSecret|encPayload|encIv|fileSha256|fileEncSha256|jpegThumbnail|thumbnail|ciphertext/i.test(key)) {
                out[key] = "[redacted-binary]"
            } else {
                out[key] = sanitizeTraceValue(value[key], depth + 1)
            }
        }
        return out
    }
    return String(value).slice(0, 200)
}

function rotateTraceIfNeeded() {
    try {
        if (!fs.existsSync(TRACE_PATH)) return
        const stat = fs.statSync(TRACE_PATH)
        if (stat.size < TRACE_MAX_BYTES) return
        const rotated = `${TRACE_PATH}.1`
        try { fs.rmSync(rotated, { force: true }) } catch {}
        fs.renameSync(TRACE_PATH, rotated)
    } catch {}
}

function appendTrace(type, data = {}) {
    try {
        rotateTraceIfNeeded()
        fs.mkdirSync(path.dirname(TRACE_PATH), { recursive: true })
        fs.appendFileSync(TRACE_PATH, `${JSON.stringify({
            at: new Date().toISOString(),
            build: BUILD,
            type,
            ...sanitizeTraceValue(data),
        })}\n`, "utf8")
    } catch (error) {
        console.log(`[EDIT TAP] trace write gagal: ${compactError(error)}`)
    }
}

function cleanupDedupe(now = Date.now()) {
    for (const [key, expiresAt] of dedupe) {
        if (Number(expiresAt || 0) <= now) dedupe.delete(key)
    }
    while (dedupe.size > DEDUPE_MAX) {
        const oldest = dedupe.keys().next().value
        if (!oldest) break
        dedupe.delete(oldest)
    }
}

function hashText(value) {
    return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 20)
}

function claimEdit(chatJid, messageId, editedText) {
    const now = Date.now()
    cleanupDedupe(now)
    const key = `${normalizeJid(chatJid)}:${String(messageId || "")}:${hashText(editedText)}`
    if (dedupe.has(key)) return false
    dedupe.set(key, now + DEDUPE_TTL_MS)
    cleanupDedupe(now)
    return true
}

function detectEditShape(update, guardian) {
    try {
        const normalized = guardian?.normalizeMessageUpdate?.(update)
        if (normalized) return { normalized, shape: "guardian-normalized" }
    } catch {}

    const message = update?.update?.message || update?.message || null
    if (!message || typeof message !== "object") return null
    if (message.editedMessage?.message) return { normalized: null, shape: "editedMessage.message" }
    if (message.protocolMessage?.editedMessage) return { normalized: null, shape: "protocolMessage.editedMessage" }
    return null
}

function getSenderJid(normalized, context = {}) {
    if (normalized?.senderJid) return normalizeJid(normalized.senderJid)
    const key = normalized?.key || {}
    const chatJid = normalizeJid(key.remoteJid || key.remoteJidAlt)
    const owner = normalizeJid(typeof context.ownerJid === "function" ? context.ownerJid() : context.ownerJid)
    if (key.fromMe) return owner || normalizeJid(context.sock?.user?.id).split(":")[0]
    if (isGroupJid(chatJid)) {
        return normalizeJid(key.participant || key.participantAlt)
    }
    return chatJid
}

function makeCacheMessage(normalized) {
    const editedMessage = normalized?.editedMessage || { conversation: normalized?.editedText || "" }
    const messageSecret = normalized?.originalMessageSecret
    const message = messageSecret
        ? {
            ...editedMessage,
            messageContextInfo: {
                ...(editedMessage?.messageContextInfo || {}),
                messageSecret: Buffer.from(messageSecret),
            },
        }
        : editedMessage
    return {
        key: {
            ...(normalized?.key || {}),
            remoteJid: normalized?.key?.remoteJid,
            id: normalized?.key?.id,
        },
        message,
        messageTimestamp: Math.floor(Date.now() / 1000),
        participant: normalized?.key?.participant,
        participantAlt: normalized?.key?.participantAlt,
    }
}

async function getOriginalText(normalized, context, guardian) {
    if (String(normalized?.originalText || "").trim()) return String(normalized.originalText).trim()
    try {
        if (typeof context.getMessage !== "function") return ""
        const content = await context.getMessage(normalized.key)
        return guardian?.extractMessageText?.(content) || ""
    } catch {
        return ""
    }
}

async function processNormalizedEdit(normalized, rawUpdate, source) {
    const context = getContext()
    const guardian = context.messageEditGuardian
    if (!guardian || !normalized) return { result: "no-guardian" }

    const chatJid = normalizeJid(normalized.key?.remoteJid || normalized.key?.remoteJidAlt)
    const messageId = String(normalized.key?.id || "").trim()
    if (rawUpdateUsesStatusTransport(rawUpdate, normalized) || isStatusOrBroadcastJid(chatJid)) {
        console.log(`[EDIT TAP] SKIP status/broadcast source=${source} id=${messageId || "-"}`)
        appendTrace("skip-status-broadcast", { source, messageId, key: normalized?.key, rawUpdate })
        return { result: "status-broadcast" }
    }
    const editedText = String(normalized.editedText || "").trim()
    if (!isChatJid(chatJid) || !messageId || !editedText) {
        console.log(`[EDIT TAP] INVALID source=${source} chat=${chatJid || "-"} id=${messageId || "-"}`)
        appendTrace("invalid-edit", { source, chatJid, messageId, editedText, rawUpdate })
        return { result: "invalid" }
    }

    if (typeof context.isSecurityLogChat === "function" && context.isSecurityLogChat(chatJid)) {
        console.log(`[EDIT TAP] SKIP security-log chat=${chatJid} id=${messageId}`)
        return { result: "security-log" }
    }
    if (typeof context.isBotSentMessageId === "function" && context.isBotSentMessageId(messageId)) {
        console.log(`[EDIT TAP] SKIP bot-message chat=${chatJid} id=${messageId}`)
        return { result: "bot-message" }
    }
    if (!claimEdit(chatJid, messageId, editedText)) {
        console.log(`[EDIT TAP] DUPLICATE chat=${chatJid} id=${messageId}`)
        return { result: "duplicate" }
    }

    const senderJid = getSenderJid(normalized, context)
    const originalText = await getOriginalText(normalized, context, guardian)
    console.log(`[EDIT TAP] DETECTED source=${source} chat=${chatJid} id=${messageId} sender=${senderJid || "-"}`)
    appendTrace("edit-detected", {
        source,
        chatJid,
        messageId,
        senderJid,
        fromMe: Boolean(normalized.key?.fromMe),
        participant: normalized.key?.participant,
        originalText,
        editedText,
        rawUpdate,
    })

    const logResult = await guardian.sendEditedMessageLog(context, {
        chatJid,
        messageId,
        senderJid,
        pushName: "",
        originalText: originalText || "(pesan lama tidak tersedia di cache)",
        editedText,
    })

    if (logResult?.sent) {
        console.log(`[EDIT TAP] SENT target=${logResult.targetJid} chat=${chatJid} id=${messageId}`)
    } else {
        console.log(`[EDIT TAP] SEND-FAILED reason=${logResult?.reason || "unknown"} chat=${chatJid} id=${messageId}`)
    }
    appendTrace("edit-log-result", {
        source,
        chatJid,
        messageId,
        sent: Boolean(logResult?.sent),
        targetJid: logResult?.targetJid,
        reason: logResult?.reason,
    })

    try {
        if (typeof context.rememberMessageContent === "function") {
            context.rememberMessageContent(makeCacheMessage(normalized))
        }
    } catch {}

    // Guardian lama tetap dipakai untuk update statistik/cache dan moderasi edit toxic,
    // tetapi pengiriman log dimiliki bridge ini agar tidak bergantung pada listener lain.
    try {
        await guardian.handleMessageEditUpdate(rawUpdate, {
            ...context,
            skipEditLog: true,
        })
    } catch (error) {
        console.log(`[EDIT TAP] guardian follow-up gagal: ${compactError(error)}`)
    }

    return {
        result: logResult?.sent ? "sent" : "send-failed",
        logResult,
    }
}

function enqueue(label, task) {
    processingQueue = processingQueue
        .catch(() => {})
        .then(task)
        .catch(error => {
            console.log(`[EDIT TAP] ${label} gagal: ${compactError(error)}`)
            appendTrace("queue-error", { label, error: compactError(error) })
        })
    return processingQueue
}

function handleMessagesUpdateEvent(updates) {
    const context = getContext()
    const guardian = context.messageEditGuardian
    const list = Array.isArray(updates) ? updates : [updates].filter(Boolean)
    const candidates = []

    for (const update of list) {
        const detected = detectEditShape(update, guardian)
        if (!detected) continue
        const key = update?.key || update?.update?.key || {}
        console.log(`[EDIT TAP] RAW messages.update chat=${key.remoteJid || key.remoteJidAlt || "-"} id=${key.id || "-"} updateKeys=${safeKeys(update?.update).join(",") || "-"} messageKeys=${safeKeys(update?.update?.message).join(",") || "-"}`)
        appendTrace("messages.update", {
            key,
            updateKeys: safeKeys(update?.update),
            messageKeys: safeKeys(update?.update?.message),
            shape: detected.shape,
            update,
        })
        let normalized = detected.normalized
        if (!normalized) {
            try { normalized = guardian?.normalizeMessageUpdate?.(update) || null } catch {}
        }
        candidates.push({ normalized, update })
    }

    if (!candidates.length) return
    enqueue("messages.update", async () => {
        for (const item of candidates) {
            await processNormalizedEdit(item.normalized, item.update, "messages.update")
        }
    })
}

function handleMessagesUpsertEvent(upsert) {
    const context = getContext()
    const guardian = context.messageEditGuardian
    const messages = Array.isArray(upsert?.messages) ? upsert.messages : []
    const editCandidates = []

    for (const msg of messages) {
        if (secretEncryptedEdit.hasStatusOrBroadcastTransport(msg)) {
            appendTrace("skip-status-broadcast", {
                source: "messages.upsert",
                key: msg?.key,
                messageKeys: safeKeys(msg?.message),
            })
            continue
        }
        if (secretEncryptedEdit.isSecretEncryptedEditMessage(msg)) {
            const envelope = secretEncryptedEdit.getSecretEnvelope(msg)
            console.log(`[EDIT SECRET] RAW messages.upsert chat=${msg?.key?.remoteJid || msg?.key?.remoteJidAlt || "-"} shellId=${msg?.key?.id || "-"} targetId=${envelope?.targetMessageKey?.id || "-"}`)
            appendTrace("secret-encrypted-edit-raw", {
                type: upsert?.type,
                key: msg?.key,
                shellMessageId: msg?.key?.id,
                targetMessageKey: envelope?.targetMessageKey,
                secretEncType: envelope?.secretEncType,
                ivBytes: secretEncryptedEdit.toBuffer(envelope?.encIv)?.length || 0,
                payloadBytes: secretEncryptedEdit.toBuffer(envelope?.encPayload)?.length || 0,
            })
            editCandidates.push({ secretMessage: msg })
            continue
        }

        let isEdit = false
        try { isEdit = Boolean(guardian?.isMessageEditUpsert?.(msg)) } catch {}

        if (isEdit) {
            console.log(`[EDIT TAP] RAW messages.upsert edit chat=${msg?.key?.remoteJid || msg?.key?.remoteJidAlt || "-"} shellId=${msg?.key?.id || "-"}`)
            appendTrace("messages.upsert-edit", {
                type: upsert?.type,
                key: msg?.key,
                messageKeys: safeKeys(msg?.message),
                msg,
            })
            try {
                const normalizedUpsert = guardian.normalizeEditUpsertMessage(msg)
                if (normalizedUpsert) {
                    const normalized = guardian.normalizeMessageUpdate(normalizedUpsert)
                    editCandidates.push({ normalized, update: normalizedUpsert })
                }
            } catch (error) {
                console.log(`[EDIT TAP] normalize upsert edit gagal: ${compactError(error)}`)
            }
            continue
        }

        try {
            if (typeof context.rememberMessageContent === "function") {
                context.rememberMessageContent(msg)
            }
            guardian?.rememberOriginalMessage?.(msg, {
                senderJid: typeof context.getMessageSenderJid === "function"
                    ? context.getMessageSenderJid(msg, context.sock)
                    : "",
                ownerJid: typeof context.ownerJid === "function" ? context.ownerJid() : context.ownerJid,
                lidAliasStore: context.lidAliasStore,
                isBotGenerated: typeof context.isBotGeneratedMessage === "function"
                    ? context.isBotGeneratedMessage(msg)
                    : false,
            })
        } catch (error) {
            console.log(`[EDIT TAP] cache original gagal: ${compactError(error)}`)
        }
    }

    if (!editCandidates.length) return
    enqueue("messages.upsert", async () => {
        for (const item of editCandidates) {
            if (item.secretMessage) {
                const liveContext = getContext()
                const decrypted = await secretEncryptedEdit.decryptSecretEncryptedEdit(item.secretMessage, liveContext)
                if (!decrypted?.ok) {
                    const targetId = secretEncryptedEdit.getSecretEnvelope(item.secretMessage)?.targetMessageKey?.id || "-"
                    console.log(`[EDIT SECRET] DECRYPT-FAILED reason=${decrypted?.reason || "unknown"} targetId=${targetId} attempts=${decrypted?.attempts || 0} detail=${decrypted?.lastFailure || "-"}`)
                    appendTrace("secret-encrypted-edit-failed", {
                        reason: decrypted?.reason,
                        targetMessageId: targetId,
                        attempts: decrypted?.attempts,
                        originalSenderCount: decrypted?.originalSenderCount,
                        modificationSenderCount: decrypted?.modificationSenderCount,
                        lastFailure: decrypted?.lastFailure,
                    })
                    continue
                }
                console.log(`[EDIT SECRET] DECRYPTED chat=${decrypted.normalized?.key?.remoteJid || "-"} id=${decrypted.normalized?.key?.id || "-"} sender=${decrypted.normalized?.senderJid || "-"}`)
                appendTrace("secret-encrypted-edit-decrypted", {
                    chatJid: decrypted.normalized?.key?.remoteJid,
                    messageId: decrypted.normalized?.key?.id,
                    senderJid: decrypted.normalized?.senderJid,
                    shellMessageId: decrypted.normalized?.secretMetadata?.shellMessageId,
                    originalText: decrypted.normalized?.originalText,
                    editedText: decrypted.normalized?.editedText,
                })
                const result = await processNormalizedEdit(
                    decrypted.normalized,
                    decrypted.syntheticUpdate,
                    "messages.upsert.secretEncryptedMessage"
                )
                if (result?.result === "sent") {
                    console.log(`[EDIT SECRET] SENT chat=${decrypted.normalized?.key?.remoteJid || "-"} id=${decrypted.normalized?.key?.id || "-"}`)
                }
                continue
            }
            await processNormalizedEdit(item.normalized, item.update, "messages.upsert")
        }
    })
}

function installMessageEditRuntimeBridge(sock, factory) {
    if (!sock?.ev || typeof sock.ev.emit !== "function") {
        console.log(`[EDIT TAP] ${BUILD} gagal aktif: sock.ev.emit tidak tersedia`)
        return false
    }
    if (installedSocket === sock && originalEmit) return true
    disposeMessageEditRuntimeBridge()

    installedSocket = sock
    contextFactory = factory
    originalEmit = sock.ev.emit.bind(sock.ev)

    sock.ev.emit = function editTapEmit(eventName, payload, ...args) {
        try {
            if (eventName === "messages.upsert") handleMessagesUpsertEvent(payload)
            else if (eventName === "messages.update") handleMessagesUpdateEvent(payload)
        } catch (error) {
            console.log(`[EDIT TAP] intercept ${eventName} gagal: ${compactError(error)}`)
            appendTrace("intercept-error", { eventName, error: compactError(error) })
        }
        return originalEmit(eventName, payload, ...args)
    }

    const context = getContext()
    const target = context.securityMediaLog?.getSecurityLogJid?.() || "unknown"
    console.log(`[EDIT TAP] ${BUILD} AKTIF | intercept=sock.ev.emit | target=${target}`)
    appendTrace("bridge-start", { target })
    return true
}

function disposeMessageEditRuntimeBridge() {
    if (installedSocket?.ev && originalEmit) {
        try { installedSocket.ev.emit = originalEmit } catch {}
    }
    installedSocket = null
    originalEmit = null
    contextFactory = null
    processingQueue = Promise.resolve()
    dedupe.clear()
    return true
}

async function flushMessageEditRuntimeBridge() {
    await processingQueue.catch(() => {})
}

function getMessageEditRuntimeBridgeHealth() {
    cleanupDedupe()
    return {
        build: BUILD,
        installed: Boolean(installedSocket && originalEmit),
        dedupeSize: dedupe.size,
        tracePath: TRACE_PATH,
    }
}

module.exports = {
    BUILD,
    installMessageEditRuntimeBridge,
    disposeMessageEditRuntimeBridge,
    flushMessageEditRuntimeBridge,
    getMessageEditRuntimeBridgeHealth,
    handleMessagesUpdateEvent,
    handleMessagesUpsertEvent,
    isSecretEncryptedEditMessage: secretEncryptedEdit.isSecretEncryptedEditMessage,
}
