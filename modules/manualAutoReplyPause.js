"use strict"

function isPauseCommand(text) {
    return /^(\.pause|\.resume|\.reply\s+(pause|resume))(?:\s|$)/i.test(String(text || "").trim())
}

async function handleCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    if (!isPauseCommand(text)) return { handled: false }
    const remoteJid = String(context.from || msg?.key?.remoteJid || "")
    const isGroup = context.isGroup === true || remoteJid.endsWith("@g.us")
    if (isGroup) return { handled: true, action: "silent-private-only" }
    if (!context.isOwner) return { handled: true, action: "unauthorized" }
    await sock.sendMessage(remoteJid, {
        text: "ℹ️ Manual pause Auto Reply sudah dinonaktifkan. Gunakan .reply on, .reply off, atau .reply status melalui private chat owner.",
    })
    return { handled: true, action: "disabled" }
}

function isPaused() {
    return false
}

module.exports = {
    handleCommand,
    isPaused,
}
