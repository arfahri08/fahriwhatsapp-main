"use strict"

const autoReplyScope = require("./autoReplyScope")
const botNotificationTarget = require("./botNotificationTarget")

function normalizeJid(value) {
    return String(value || "").trim()
}

function clip(value, max = 700) {
    const text = String(value || "").trim()
    return text.length > max ? `${text.slice(0, max)}…` : text
}

function makeScopeMessage(remoteJid) {
    return { key: { remoteJid, fromMe: false }, message: { conversation: "internal-auto-reply" } }
}

async function sendOwnerNotification(sock, options = {}) {
    if (!sock || typeof sock.sendMessage !== "function") return false
    const senderJid = normalizeJid(options.senderJid)
    if (!autoReplyScope.isPrivateChatJid(senderJid)) return false

    const senderNumber = senderJid.split("@")[0] || "-"
    const lines = [
        "📩 *AUTO-REPLY FORWARDER*",
        "",
        `Jenis: ${clip(options.type || "Pesan masuk")}`,
        `Pengirim: ${senderNumber}`,
    ]
    if (options.originalText) lines.push(`Pesan: ${clip(options.originalText)}`)
    if (options.replyText) lines.push(`Balasan bot: ${clip(options.replyText)}`)

    return botNotificationTarget.sendBotNotification(sock, { text: lines.join("\n") }, {
        type: "auto-reply-forwarder",
    })
}

async function sendAutoReply(sock, remoteJid, replyMessage, options = {}) {
    if (!sock || typeof sock.sendMessage !== "function") return false
    const targetJid = normalizeJid(remoteJid || options.remoteJid)
    const sourceMessage = options.msg || makeScopeMessage(targetJid)
    if (options.isMessageUpdate === true) return false
    if (!autoReplyScope.shouldProcessAutoReplyMessage(sourceMessage)) return false
    if (!autoReplyScope.isPrivateChatJid(targetJid)) return false

    const content = typeof replyMessage === "string" ? { text: replyMessage } : replyMessage
    if (!content || typeof content !== "object") return false

    const result = await sock.sendMessage(targetJid, content)
    const replyText = content.text || content.caption || "[media/non-text reply]"
    await sendOwnerNotification(sock, {
        type: "Auto Reply Private Chat",
        senderJid: targetJid,
        originalText: options.originalText,
        replyText,
    })
    return result || true
}

module.exports = {
    sendAutoReply,
    sendOwnerNotification,
}
