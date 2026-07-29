"use strict"

const crypto = require("crypto")

const SECRET_ENC_TYPE_MESSAGE_EDIT = 2
const MESSAGE_EDIT_INFO = "Message Edit"
const GCM_TAG_BYTES = 16

function normalizeJid(value) {
    return String(value || "").trim().toLowerCase()
}

function toNonADJid(value) {
    const jid = normalizeJid(value)
    const match = /^([^@]+)@(.+)$/.exec(jid)
    if (!match) return jid
    const user = match[1].split(":")[0]
    return user && match[2] ? `${user}@${match[2]}` : jid
}

function isGroupJid(value) {
    return toNonADJid(value).endsWith("@g.us")
}

function isPrivateJid(value) {
    const jid = toNonADJid(value)
    return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")
}

function isChatJid(value) {
    return isGroupJid(value) || isPrivateJid(value)
}

function toBuffer(value) {
    if (!value) return null
    if (Buffer.isBuffer(value)) return Buffer.from(value)
    if (value instanceof Uint8Array) return Buffer.from(value)
    if (Array.isArray(value)) return Buffer.from(value)
    if (value?.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data)
    if (value?.buffer instanceof ArrayBuffer) {
        return Buffer.from(value.buffer, value.byteOffset || 0, value.byteLength || value.length)
    }
    return null
}

function isMessageEditSecretType(value) {
    if (Number(value) === SECRET_ENC_TYPE_MESSAGE_EDIT) return true
    return String(value || "").trim().toUpperCase() === "MESSAGE_EDIT"
}

function getSecretEnvelope(msg) {
    const envelope = msg?.message?.secretEncryptedMessage
    if (!envelope || typeof envelope !== "object") return null
    if (!isMessageEditSecretType(envelope.secretEncType)) return null
    if (!envelope.targetMessageKey?.id) return null
    if (!toBuffer(envelope.encIv) || !toBuffer(envelope.encPayload)) return null
    return envelope
}

function isSecretEncryptedEditMessage(msg) {
    return Boolean(getSecretEnvelope(msg))
}

function findMessageSecret(value, depth = 0, visited = new Set()) {
    if (!value || typeof value !== "object" || depth > 12 || visited.has(value)) return null
    visited.add(value)

    const directCandidates = [
        value.messageSecret,
        value.messageContextInfo?.messageSecret,
        value.contextInfo?.messageSecret,
    ]
    for (const candidate of directCandidates) {
        const buffer = toBuffer(candidate)
        if (buffer?.length) return buffer
    }

    const preferredKeys = [
        "message",
        "ephemeralMessage",
        "viewOnceMessage",
        "viewOnceMessageV2",
        "viewOnceMessageV2Extension",
        "documentWithCaptionMessage",
        "editedMessage",
    ]
    for (const key of preferredKeys) {
        const found = findMessageSecret(value[key], depth + 1, visited)
        if (found) return found
    }

    for (const [key, child] of Object.entries(value)) {
        if (preferredKeys.includes(key)) continue
        if (!child || typeof child !== "object") continue
        const found = findMessageSecret(child, depth + 1, visited)
        if (found) return found
    }
    return null
}

function pushUniqueJid(list, value) {
    const jid = toNonADJid(value)
    if (!jid || !jid.includes("@") || list.includes(jid)) return
    list.push(jid)
}

function getOwnerCandidates(context = {}) {
    const output = []
    const owner = typeof context.ownerJid === "function" ? context.ownerJid() : context.ownerJid
    pushUniqueJid(output, owner)
    pushUniqueJid(output, context.sock?.user?.id)
    pushUniqueJid(output, context.sock?.user?.lid)
    return output
}

function chooseChatJid(msg, targetKey = {}) {
    const values = [
        targetKey.remoteJid,
        targetKey.remoteJidAlt,
        msg?.key?.remoteJid,
        msg?.key?.remoteJidAlt,
    ].map(toNonADJid).filter(Boolean)
    return values.find(isGroupJid)
        || values.find(value => value.endsWith("@s.whatsapp.net"))
        || values.find(value => value.endsWith("@lid"))
        || values.find(isChatJid)
        || ""
}

function getModificationSenderCandidates(msg, context = {}) {
    const output = []
    let resolved = ""
    try {
        resolved = typeof context.getMessageSenderJid === "function"
            ? context.getMessageSenderJid(msg, context.sock)
            : ""
    } catch {}
    pushUniqueJid(output, resolved)

    const key = msg?.key || {}
    if (key.fromMe) {
        for (const owner of getOwnerCandidates(context)) pushUniqueJid(output, owner)
    }
    pushUniqueJid(output, key.participant)
    pushUniqueJid(output, key.participantAlt)
    pushUniqueJid(output, msg?.participant)
    pushUniqueJid(output, msg?.participantAlt)
    pushUniqueJid(output, key.remoteJidAlt)
    if (!isGroupJid(key.remoteJid)) pushUniqueJid(output, key.remoteJid)
    if (!isGroupJid(key.remoteJidAlt)) pushUniqueJid(output, key.remoteJidAlt)
    return output
}

function getOriginalSenderCandidates(msg, targetKey = {}, context = {}) {
    const output = []
    if (targetKey.fromMe) {
        for (const owner of getOwnerCandidates(context)) pushUniqueJid(output, owner)
    }
    pushUniqueJid(output, targetKey.participant)
    pushUniqueJid(output, targetKey.participantAlt)
    if (!isGroupJid(targetKey.remoteJid)) pushUniqueJid(output, targetKey.remoteJid)
    if (!isGroupJid(targetKey.remoteJidAlt)) pushUniqueJid(output, targetKey.remoteJidAlt)

    const outerKey = msg?.key || {}
    pushUniqueJid(output, outerKey.participant)
    pushUniqueJid(output, outerKey.participantAlt)
    pushUniqueJid(output, msg?.participant)
    pushUniqueJid(output, msg?.participantAlt)
    if (!isGroupJid(outerKey.remoteJid)) pushUniqueJid(output, outerKey.remoteJid)
    if (!isGroupJid(outerKey.remoteJidAlt)) pushUniqueJid(output, outerKey.remoteJidAlt)
    return output
}

function buildLookupKeys(msg, targetKey = {}) {
    const keys = []
    const seen = new Set()
    const add = value => {
        if (!value?.id) return
        const key = {
            ...value,
            id: String(value.id),
            remoteJid: toNonADJid(value.remoteJid),
            remoteJidAlt: toNonADJid(value.remoteJidAlt),
            participant: toNonADJid(value.participant),
            participantAlt: toNonADJid(value.participantAlt),
        }
        const fingerprint = JSON.stringify([
            key.remoteJid,
            key.remoteJidAlt,
            key.participant,
            key.participantAlt,
            key.id,
            Boolean(key.fromMe),
        ])
        if (seen.has(fingerprint)) return
        seen.add(fingerprint)
        keys.push(key)
    }

    add(targetKey)
    add({ ...targetKey, remoteJid: msg?.key?.remoteJid, remoteJidAlt: msg?.key?.remoteJidAlt })
    add({ ...targetKey, remoteJid: msg?.key?.remoteJidAlt, remoteJidAlt: msg?.key?.remoteJid })
    add({ id: targetKey.id })
    return keys
}

async function getOriginalContent(msg, targetKey, context = {}) {
    if (typeof context.getMessage !== "function") return { content: null, key: null }
    for (const key of buildLookupKeys(msg, targetKey)) {
        try {
            const content = await context.getMessage(key)
            if (content && typeof content === "object") return { content, key }
        } catch {}
    }
    return { content: null, key: null }
}

function deriveMessageEditKey(messageSecret, originalMessageId, originalSender, modificationSender) {
    const info = Buffer.from(
        `${String(originalMessageId || "")}${toNonADJid(originalSender)}${toNonADJid(modificationSender)}${MESSAGE_EDIT_INFO}`,
        "utf8"
    )
    return Buffer.from(crypto.hkdfSync(
        "sha256",
        Buffer.from(messageSecret),
        Buffer.alloc(0),
        info,
        32
    ))
}

function decryptAesGcm(payload, iv, key) {
    if (!Buffer.isBuffer(payload) || payload.length <= GCM_TAG_BYTES) {
        throw new Error("encrypted payload terlalu pendek")
    }
    const ciphertext = payload.subarray(0, payload.length - GCM_TAG_BYTES)
    const authTag = payload.subarray(payload.length - GCM_TAG_BYTES)
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function decodeMessage(buffer, context = {}) {
    if (typeof context.decodeMessage === "function") return context.decodeMessage(buffer)
    const decoder = context.proto?.Message?.decode
    if (typeof decoder !== "function") throw new Error("proto.Message.decode tidak tersedia")
    return decoder(buffer)
}

function unwrapDecodedEditedMessage(decoded) {
    let current = decoded
    for (let index = 0; index < 12; index += 1) {
        if (!current || typeof current !== "object") return null
        if (current.protocolMessage?.editedMessage) current = current.protocolMessage.editedMessage
        else if (current.editedMessage?.message) current = current.editedMessage.message
        else if (current.editedMessage) current = current.editedMessage
        else if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message
        else break
    }
    return current && typeof current === "object" ? current : null
}

function compactError(error) {
    return String(error?.message || error || "unknown")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300)
}

async function decryptSecretEncryptedEdit(msg, context = {}) {
    const envelope = getSecretEnvelope(msg)
    if (!envelope) return { ok: false, reason: "not-message-edit-secret" }

    const targetKey = envelope.targetMessageKey || {}
    const targetMessageId = String(targetKey.id || "").trim()
    const iv = toBuffer(envelope.encIv)
    const payload = toBuffer(envelope.encPayload)
    if (!targetMessageId || !iv?.length || !payload?.length) {
        return { ok: false, reason: "invalid-secret-envelope" }
    }

    const original = await getOriginalContent(msg, targetKey, context)
    if (!original.content) {
        return { ok: false, reason: "original-message-not-found", targetMessageId }
    }

    const messageSecret = findMessageSecret(original.content)
    if (!messageSecret?.length) {
        return { ok: false, reason: "original-secret-not-found", targetMessageId }
    }

    const originalSenders = getOriginalSenderCandidates(msg, targetKey, context)
    const modificationSenders = getModificationSenderCandidates(msg, context)
    if (!originalSenders.length || !modificationSenders.length) {
        return {
            ok: false,
            reason: "sender-candidates-empty",
            targetMessageId,
            originalSenderCount: originalSenders.length,
            modificationSenderCount: modificationSenders.length,
        }
    }

    const failures = []
    for (const originalSender of originalSenders) {
        for (const modificationSender of modificationSenders) {
            try {
                const key = deriveMessageEditKey(
                    messageSecret,
                    targetMessageId,
                    originalSender,
                    modificationSender
                )
                const plaintext = decryptAesGcm(payload, iv, key)
                const decoded = decodeMessage(plaintext, context)
                const editedMessage = unwrapDecodedEditedMessage(decoded)
                const editedText = String(context.messageEditGuardian?.extractMessageText?.(editedMessage) || "").trim()
                if (!editedMessage || !editedText) {
                    failures.push(`${originalSender}>${modificationSender}:decoded-empty`)
                    continue
                }

                const chatJid = chooseChatJid(msg, targetKey)
                const resolvedSender = modificationSenders.find(value => value.endsWith("@s.whatsapp.net"))
                    || modificationSender
                const participant = isGroupJid(chatJid)
                    ? (resolvedSender || toNonADJid(targetKey.participant) || modificationSender)
                    : resolvedSender

                const normalized = {
                    isEdit: true,
                    key: {
                        ...targetKey,
                        remoteJid: chatJid,
                        remoteJidAlt: toNonADJid(targetKey.remoteJidAlt || msg?.key?.remoteJidAlt),
                        id: targetMessageId,
                        fromMe: Boolean(targetKey.fromMe),
                        participant,
                        participantAlt: toNonADJid(targetKey.participantAlt || msg?.key?.participantAlt),
                    },
                    senderJid: resolvedSender || modificationSender,
                    originalText: String(context.messageEditGuardian?.extractMessageText?.(original.content) || "").trim(),
                    originalMessageSecret: Buffer.from(messageSecret),
                    editedMessage,
                    editedText,
                    editedAt: Date.now(),
                    secretMetadata: {
                        shellMessageId: String(msg?.key?.id || ""),
                        originalSender,
                        modificationSender,
                    },
                }
                const syntheticUpdate = {
                    key: normalized.key,
                    update: {
                        message: {
                            editedMessage: {
                                message: editedMessage,
                            },
                        },
                        messageTimestamp: msg?.messageTimestamp,
                    },
                    __secretEncryptedEdit: true,
                    __shellMessageId: String(msg?.key?.id || ""),
                }
                return {
                    ok: true,
                    normalized,
                    syntheticUpdate,
                    originalContent: original.content,
                    originalLookupKey: original.key,
                    senderPair: { originalSender, modificationSender },
                }
            } catch (error) {
                failures.push(`${originalSender}>${modificationSender}:${compactError(error)}`)
            }
        }
    }

    return {
        ok: false,
        reason: "decrypt-failed",
        targetMessageId,
        originalSenderCount: originalSenders.length,
        modificationSenderCount: modificationSenders.length,
        attempts: originalSenders.length * modificationSenders.length,
        lastFailure: failures.at(-1) || "unknown",
    }
}

module.exports = {
    SECRET_ENC_TYPE_MESSAGE_EDIT,
    MESSAGE_EDIT_INFO,
    isSecretEncryptedEditMessage,
    getSecretEnvelope,
    findMessageSecret,
    deriveMessageEditKey,
    decryptAesGcm,
    decryptSecretEncryptedEdit,
    toNonADJid,
    toBuffer,
}
