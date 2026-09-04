"use strict"

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
const DEFAULT_MAX_SIZE = 5000
const SENSITIVE_KEYS = /^(?:messageSecret|encPayload|encIv|mediaKey|jpegThumbnail|thumbnail|ciphertext)$/i
const MESSAGE_ID_KEYS = /^(?:id|messageId|targetMessageId|originalMessageId|stanzaId|shellMessageId)$/i

const provenanceByMessageId = new Map()

function normalizeJid(value) {
    return String(value || "").trim().toLowerCase()
}

function isStatusOrBroadcastJid(value) {
    const jid = normalizeJid(value)
    return jid === "status@broadcast"
        || jid.endsWith("@broadcast")
        || jid.endsWith("@newsletter")
}

function getOriginType(jid) {
    const normalized = normalizeJid(jid)
    if (normalized.endsWith("@newsletter")) return "newsletter"
    if (normalized === "status@broadcast") return "status"
    if (normalized.endsWith("@broadcast")) return "broadcast"
    return "unknown"
}

function getTtlMs() {
    const value = Number(process.env.EDIT_STATUS_PROVENANCE_TTL_MS || DEFAULT_TTL_MS)
    return Number.isFinite(value) && value >= 60_000 ? value : DEFAULT_TTL_MS
}

function getMaxSize() {
    const value = Number(process.env.EDIT_STATUS_PROVENANCE_MAX_SIZE || DEFAULT_MAX_SIZE)
    return Number.isFinite(value) && value >= 100 ? Math.floor(value) : DEFAULT_MAX_SIZE
}

function safeMessageId(value) {
    const id = String(value || "").trim()
    if (!id || id.length > 256 || /[\r\n\0]/.test(id)) return ""
    return id
}

function inspectEventStructure(value, options = {}) {
    const messageIds = new Set()
    const transportJids = new Set()
    const keyShapes = []
    const visited = new Set()

    const visit = (node, depth = 0, path = "root") => {
        if (!node || typeof node !== "object" || depth > 10 || visited.has(node)) return
        if (Buffer.isBuffer(node) || node instanceof Uint8Array) return
        visited.add(node)

        if (!Array.isArray(node)) {
            const remoteJid = normalizeJid(node.remoteJid)
            const remoteJidAlt = normalizeJid(node.remoteJidAlt)
            const looksLikeMessageKey = Boolean(
                safeMessageId(node.id)
                || remoteJid
                || remoteJidAlt
                || node.participant
                || node.participantAlt
                || Object.prototype.hasOwnProperty.call(node, "fromMe")
            )
            if (looksLikeMessageKey) {
                const id = safeMessageId(node.id)
                if (id) messageIds.add(id)
                if (remoteJid) transportJids.add(remoteJid)
                if (remoteJidAlt) transportJids.add(remoteJidAlt)
                if (keyShapes.length < 20) {
                    keyShapes.push({
                        path,
                        id: id || "",
                        remoteJid,
                        remoteJidAlt,
                        fromMe: node.fromMe === true,
                    })
                }
                for (const [key, child] of Object.entries(node)) {
                    if (MESSAGE_ID_KEYS.test(key)) {
                        const nestedId = safeMessageId(child)
                        if (nestedId) messageIds.add(nestedId)
                    }
                }
            }
        }

        const entries = Array.isArray(node) ? node.entries() : Object.entries(node)
        for (const [key, child] of entries) {
            if (!child || typeof child !== "object") continue
            if (SENSITIVE_KEYS.test(String(key))) continue
            visit(child, depth + 1, `${path}.${String(key)}`)
        }
    }

    visit(value)
    return {
        messageIds: [...messageIds],
        transportJids: [...transportJids],
        keyShapes: options.includeShapes === false ? [] : keyShapes,
    }
}

function cleanupStatusProvenance(now = Date.now()) {
    for (const [messageId, entry] of provenanceByMessageId) {
        if (!entry?.expiresAt || entry.expiresAt <= now) provenanceByMessageId.delete(messageId)
    }
    const maxSize = getMaxSize()
    while (provenanceByMessageId.size > maxSize) {
        const oldest = provenanceByMessageId.keys().next().value
        if (!oldest) break
        provenanceByMessageId.delete(oldest)
    }
    return provenanceByMessageId.size
}

function rememberStatusOrigin(value, options = {}) {
    const now = Number(options.now || Date.now())
    cleanupStatusProvenance(now)
    const inspected = inspectEventStructure(value)
    const originJid = inspected.transportJids.find(isStatusOrBroadcastJid)
    if (!originJid) {
        for (const messageId of inspected.messageIds) {
            const entry = provenanceByMessageId.get(messageId)
            if (entry) {
                return {
                    remembered: false,
                    count: 0,
                    matched: true,
                    match: "provenance",
                    messageId,
                    originJid: entry.originJid,
                    originType: entry.originType,
                    entry: { ...entry },
                    ...inspected,
                }
            }
        }
        return { remembered: false, count: 0, matched: false, match: "none", ...inspected }
    }

    const originType = getOriginType(originJid)
    const expiresAt = now + getTtlMs()
    let count = 0
    for (const messageId of inspected.messageIds) {
        provenanceByMessageId.delete(messageId)
        provenanceByMessageId.set(messageId, {
            messageId,
            originJid,
            originType,
            source: String(options.source || "messages.upsert").slice(0, 80),
            seenAt: now,
            expiresAt,
        })
        count += 1
    }
    cleanupStatusProvenance(now)
    return {
        remembered: count > 0,
        count,
        matched: true,
        match: "transport",
        messageId: inspected.messageIds[0] || "",
        originJid,
        originType,
        ...inspected,
    }
}

function findStatusProvenance(...values) {
    cleanupStatusProvenance()
    for (const value of values) {
        const inspected = inspectEventStructure(value)
        const directJid = inspected.transportJids.find(isStatusOrBroadcastJid)
        if (directJid) {
            return {
                matched: true,
                match: "transport",
                originJid: directJid,
                originType: getOriginType(directJid),
                messageId: inspected.messageIds[0] || "",
                inspected,
            }
        }
        for (const messageId of inspected.messageIds) {
            const entry = provenanceByMessageId.get(messageId)
            if (entry) {
                return {
                    matched: true,
                    match: "provenance",
                    messageId,
                    originJid: entry.originJid,
                    originType: entry.originType,
                    entry: { ...entry },
                    inspected,
                }
            }
        }
    }
    return { matched: false, match: "none", messageId: "", originJid: "", originType: "" }
}

function getStatusProvenanceHealth() {
    cleanupStatusProvenance()
    return {
        size: provenanceByMessageId.size,
        ttlMs: getTtlMs(),
        maxSize: getMaxSize(),
    }
}

function resetStatusProvenance() {
    provenanceByMessageId.clear()
}

module.exports = {
    cleanupStatusProvenance,
    findStatusProvenance,
    getStatusProvenanceHealth,
    inspectEventStructure,
    isStatusOrBroadcastJid,
    rememberStatusOrigin,
    resetStatusProvenance,
}
