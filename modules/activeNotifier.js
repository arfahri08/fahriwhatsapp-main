"use strict"

// ACTIVE_NOTIFICATION_TARGET_BUILD: V1.3.3
const botNotificationTarget = require("./botNotificationTarget")

const DEFAULT_COOLDOWN_MS = 60 * 1000
let lastSentAt = 0

function isActiveNotificationEnabled() {
    return !/^(0|false|off)$/i.test(String(process.env.ACTIVE_NOTIFY || ""))
}

function normalizeJid(value) {
    return String(value || "").trim()
}

function getConfiguredNotificationGroupJid() {
    const target = normalizeJid(botNotificationTarget.getBotNotificationGroupJid?.())
    return botNotificationTarget.validateBotNotificationGroupJid?.(target) ? target : ""
}

function getTargets() {
    if (!isActiveNotificationEnabled()) return []
    const configuredGroup = getConfiguredNotificationGroupJid()
    return configuredGroup ? [configuredGroup] : []
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
        `✅ *USERBOT AKTIF*\n\n` +
        `Bot sudah tersambung ke WhatsApp.\n` +
        `Waktu: ${formatJakartaTime(date)}\n\n` +
        `_Notifikasi otomatis setelah startup / restart / reconnect._`
    )
}

async function notifyActive(sock, _legacyFallbackTargets = [], options = {}) {
    if (!isActiveNotificationEnabled()) return []

    const cooldownMs = Number(process.env.ACTIVE_NOTIFY_COOLDOWN_MS || DEFAULT_COOLDOWN_MS)
    const now = Date.now()
    if (!options.force && cooldownMs > 0 && now - lastSentAt < cooldownMs) return []

    const targets = getTargets()
    if (!targets.length) {
        console.log("[ACTIVE] Target log aktif tidak tersedia.")
        return []
    }

    lastSentAt = now
    const results = []
    const content = { text: getActiveText() }

    for (const jid of targets) {
        try {
            const sent = await botNotificationTarget.sendBotNotification(sock, content, {
                type: options.reason || "active-startup-reconnect",
            })
            if (!sent) continue
            results.push({ jid, key: sent?.key || null })
            console.log("[ACTIVE] Log aktif terkirim", {
                jid,
                type: options.reason || "active-startup-reconnect",
                target: "configured-group",
            })
        } catch (error) {
            console.log("[ACTIVE] Gagal mengirim log aktif", {
                jid,
                error: String(error?.message || error).slice(0, 240),
            })
        }
    }

    return results
}

module.exports = {
    notifyActive,
    getTargets,
    getConfiguredNotificationGroupJid,
    getActiveText,
}
