"use strict"

const autoReply = require("./autoReply")

function isPrivate(remoteJid) {
    const jid = String(remoteJid || "")
    return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")
}

function formatReplyStatus() {
    const status = autoReply.getScopeStatus()
    return [
        "🤖 *AUTO REPLY STATUS*",
        "",
        `Global Status: ${status.global}`,
        `Private Chat: ${status.privateChat}`,
        "Group Chat: OFF",
        "Scope: PRIVATE ONLY",
        `Forward to Owner: ${status.forwarder}`,
        `Keyword Reply: ${status.keywordReply}`,
    ].join("\n")
}

async function handleReplyCommand(sock, remoteJid, text, context = {}) {
    const lower = String(text || "").trim().toLowerCase()
    if (lower !== ".reply" && !lower.startsWith(".reply ")) return false
    if (!isPrivate(remoteJid)) return true
    if (!context.isOwner) return true

    if (lower === ".reply on") {
        autoReply.setStatus(true, remoteJid)
        await sock.sendMessage(remoteJid, { text: "✅ Auto-reply private chat diaktifkan dan tersimpan." })
    } else if (lower === ".reply off") {
        autoReply.setStatus(false, remoteJid)
        await sock.sendMessage(remoteJid, { text: "✅ Auto-reply private chat dinonaktifkan dan tersimpan." })
    } else if (lower === ".reply status") {
        await sock.sendMessage(remoteJid, { text: formatReplyStatus() })
    } else {
        await sock.sendMessage(remoteJid, { text: "🤖 *Auto Reply*\n\n.reply on\n.reply off\n.reply status\n\nScope: PRIVATE ONLY" })
    }
    return true
}

module.exports = {
    formatReplyStatus,
    handleReplyCommand,
}
