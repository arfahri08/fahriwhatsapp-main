"use strict"

const PRIVATE_CHAT_SUFFIXES = ["@s.whatsapp.net", "@lid"]
const DISALLOWED_MESSAGE_KEYS = new Set([
    "protocolMessage",
    "reactionMessage",
    "pollUpdateMessage",
    "pollResultSnapshotMessage",
    "messageHistoryBundle",
    "senderKeyDistributionMessage",
])

function normalizeJid(value) {
    return String(value || "").trim().toLowerCase()
}

function isPrivateChatJid(remoteJid) {
    const jid = normalizeJid(remoteJid)
    if (!jid) return false
    if (jid === "status@broadcast") return false
    if (jid.endsWith("@broadcast") || jid.endsWith("@g.us") || jid.endsWith("@newsletter")) return false
    return PRIVATE_CHAT_SUFFIXES.some(suffix => jid.endsWith(suffix))
}

function getMessageContent(msg) {
    let current = msg?.message || {}
    for (let index = 0; index < 8; index += 1) {
        if (current?.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current?.viewOnceMessage?.message) current = current.viewOnceMessage.message
        else if (current?.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
        else if (current?.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message
        else if (current?.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message
        else break
    }
    return current || {}
}

function hasDisallowedMessageType(msg) {
    const message = getMessageContent(msg)
    return Object.keys(message).some(key => DISALLOWED_MESSAGE_KEYS.has(key))
}

function shouldProcessAutoReplyMessage(msg) {
    const remoteJid = normalizeJid(msg?.key?.remoteJid)
    if (!isPrivateChatJid(remoteJid)) return false
    if (msg?.key?.fromMe) return false
    if (msg?.botGenerated === true || msg?.isBotGenerated === true) return false
    if (msg?.messageStubType != null) return false
    if (hasDisallowedMessageType(msg)) return false
    return true
}

function shouldRouteAutoReplyMessage(msg, options = {}) {
    if (options.alreadyHandled === true) return false
    if (options.botEnabled === false) return false
    if (options.autoReplyEnabled === false) return false
    return shouldProcessAutoReplyMessage(msg)
}

function getAutoReplyScope(remoteJid) {
    const jid = normalizeJid(remoteJid)
    if (jid === "status@broadcast" || jid.endsWith("@broadcast")) return "status"
    if (jid.endsWith("@newsletter")) return "newsletter"
    if (jid.endsWith("@g.us")) return "group"
    return isPrivateChatJid(jid) ? "private" : "unsupported"
}

module.exports = {
    getAutoReplyScope,
    getMessageContent,
    hasDisallowedMessageType,
    isPrivateChatJid,
    shouldProcessAutoReplyMessage,
    shouldRouteAutoReplyMessage,
}
