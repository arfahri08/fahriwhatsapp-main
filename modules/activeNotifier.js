"use strict"

const botNotificationTarget = require("./botNotificationTarget")

const DEFAULT_COOLDOWN_MS = 60 * 1000
let lastSentAt = 0

function isActiveNotificationEnabled() {
    return !/^(0|false|off)$/i.test(String(process.env.ACTIVE_NOTIFY || ""))
}

function getTargets() {
    return isActiveNotificationEnabled()
        ? [botNotificationTarget.getBotNotificationGroupJid()]
        : []
}

function formatJakartaTime(date = new Date()) {
    return new Intl.DateTimeFormat("id-ID", {
        timeZone: process.env.TZ || process.env.BOT_TIMEZONE || "Asia/Jakarta",
        dateStyle: "medium",
        timeStyle: "medium",
    }).format(date)
}

function getActiveText(date = new Date()) {
    return (
        `✅ *USERBOT FAHRI AKTIF*\n\n` +
        `Bot sudah tersambung ke WhatsApp.\n` +
        `Waktu: ${formatJakartaTime(date)}\n\n` +
        `_Notifikasi otomatis setelah startup / restart / reconnect._`
    )
}

async function notifyActive(sock, _legacyFallbackTargets, options = {}) {
    if (!isActiveNotificationEnabled()) return []

    const cooldownMs = Number(process.env.ACTIVE_NOTIFY_COOLDOWN_MS || DEFAULT_COOLDOWN_MS)
    const now = Date.now()
    if (!options.force && cooldownMs > 0 && now - lastSentAt < cooldownMs) return []

    lastSentAt = now
    const jid = botNotificationTarget.getBotNotificationGroupJid()
    const sent = await botNotificationTarget.sendBotNotification(sock, { text: getActiveText() }, {
        type: options.reason || "active-startup-reconnect",
    })

    if (!sent) return []
    return [{ jid, key: sent?.key || null }]
}

module.exports = {
    notifyActive,
    getTargets,
    getActiveText,
}
