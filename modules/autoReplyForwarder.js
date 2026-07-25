"use strict"

const autoReplyScope = require("./autoReplyScope")
const botNotificationTarget = require("./botNotificationTarget")

function normalizeJid(value) {
    return String(value || "").trim()
}

function envEnabled(value, fallback = true) {
    const clean = String(value ?? "").trim()
    if (!clean) return fallback
    return /^(1|true|yes|on)$/i.test(clean)
}

function clip(value, max = 700) {
    const text = String(value || "").trim()
    return text.length > max ? `${text.slice(0, max)}…` : text
}

function makeScopeMessage(remoteJid) {
    return { key: { remoteJid, fromMe: false }, message: { conversation: "internal-auto-reply" } }
}

function getFirstName(msg) {
    const pushName = String(msg?.pushName || "").normalize("NFKC").replace(/\s+/g, " ").trim()
    if (!pushName) return "kamu"
    const first = pushName.split(" ")[0].replace(/[^\p{L}\p{N}._'-]/gu, "").slice(0, 30)
    return first || "kamu"
}

function getTimeGreeting(date = new Date()) {
    let hour
    try {
        hour = Number(new Intl.DateTimeFormat("en-US", {
            timeZone: process.env.TZ || process.env.BOT_TIMEZONE || "Asia/Jakarta",
            hour: "2-digit",
            hourCycle: "h23",
        }).format(date))
    } catch {
        hour = date.getHours()
    }
    if (hour < 5) return "Selamat dini hari"
    if (hour < 11) return "Selamat pagi"
    if (hour < 15) return "Selamat siang"
    if (hour < 18) return "Selamat sore"
    return "Selamat malam"
}

function renderPersonalText(value, msg, options = {}) {
    const original = String(value || "")
    if (!original) return original

    const name = getFirstName(msg)
    const greeting = getTimeGreeting()
    let text = original
        .replace(/\{\{?\s*(?:name|firstName)\s*\}?\}/gi, name)
        .replace(/\{\{?\s*greeting\s*\}?\}/gi, greeting)

    const personalNameEnabled = options.personalizeName !== false
        && envEnabled(process.env.AUTO_REPLY_PERSONAL_NAME, true)
    if (!personalNameEnabled || name === "kamu" || text !== original) return text

    if (/^halo\b/i.test(text)) {
        return text.replace(/^halo\s*[,!.-]?\s*/i, `Halo, ${name}! `)
    }

    const greetingPattern = /^(selamat\s+(?:dini\s+hari|pagi|siang|sore|malam))\s*[,!.-]?\s*/i
    const greetingMatch = text.match(greetingPattern)
    if (greetingMatch) {
        return text.replace(greetingPattern, `${greetingMatch[1]}, ${name}. `)
    }

    if (options.prependName === true) return `Hai ${name}, ${text}`
    return text
}

function personalizeContent(content, msg, options = {}) {
    if (!content || typeof content !== "object") return content
    const next = { ...content }
    if (typeof next.text === "string") next.text = renderPersonalText(next.text, msg, options)
    if (typeof next.caption === "string") next.caption = renderPersonalText(next.caption, msg, options)
    return next
}

function canQuoteMessage(msg) {
    return Boolean(msg?.key?.id && msg?.key?.remoteJid && msg?.message)
}

function getAutoReplyPresentationHealth() {
    return {
        quotedBubble: envEnabled(process.env.AUTO_REPLY_QUOTED_BUBBLE, true),
        personalName: envEnabled(process.env.AUTO_REPLY_PERSONAL_NAME, true),
        placeholderSupport: true,
    }
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

    const rawContent = typeof replyMessage === "string" ? { text: replyMessage } : replyMessage
    if (!rawContent || typeof rawContent !== "object") return false
    const content = personalizeContent(rawContent, sourceMessage, options)

    const quotedBubbleEnabled = options.quotedBubble !== false
        && envEnabled(process.env.AUTO_REPLY_QUOTED_BUBBLE, true)
    const sendOptions = quotedBubbleEnabled && canQuoteMessage(sourceMessage)
        ? { quoted: sourceMessage }
        : undefined

    const result = sendOptions
        ? await sock.sendMessage(targetJid, content, sendOptions)
        : await sock.sendMessage(targetJid, content)

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
    getAutoReplyPresentationHealth,
    getFirstName,
    getTimeGreeting,
    personalizeContent,
    renderPersonalText,
    sendAutoReply,
    sendOwnerNotification,
}
