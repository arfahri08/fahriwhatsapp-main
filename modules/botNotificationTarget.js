"use strict"

const DEFAULT_BOT_NOTIFICATION_GROUP_JID = "120363424006225997@g.us"
const DEFAULT_RETRY_ATTEMPTS = 2
const DEFAULT_RETRY_DELAY_MS = 800

let warnedInvalidTarget = false
let lastNotificationAt = null
let lastNotificationResult = "UNKNOWN"
let lastNotificationType = null
let lastNotificationError = null

function clip(value, max = 300) {
    const text = String(value || "").trim()
    return text.length > max ? `${text.slice(0, max)}…` : text
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
}

function validateBotNotificationGroupJid(value) {
    const jid = String(value || "").trim()
    if (!jid) return false
    if (jid === "status@broadcast") return false
    if (jid.endsWith("@newsletter") || jid.endsWith("@lid")) return false
    return jid.endsWith("@g.us")
}

function getBotNotificationGroupJid() {
    const configured = String(process.env.BOT_NOTIFICATION_GROUP_JID || "").trim()
    if (!configured) return DEFAULT_BOT_NOTIFICATION_GROUP_JID
    if (validateBotNotificationGroupJid(configured)) return configured

    if (!warnedInvalidTarget) {
        warnedInvalidTarget = true
        console.log(`[BOT NOTIFICATION] BOT_NOTIFICATION_GROUP_JID tidak valid, memakai default ${DEFAULT_BOT_NOTIFICATION_GROUP_JID}`)
    }
    return DEFAULT_BOT_NOTIFICATION_GROUP_JID
}

function isBotNotificationGroup(jid) {
    return String(jid || "").trim() === getBotNotificationGroupJid()
}

async function sendBotNotification(sock, content, options = {}) {
    if (!sock || typeof sock.sendMessage !== "function") return false
    if (!content || typeof content !== "object") return false

    const targetJid = getBotNotificationGroupJid()
    const attempts = Math.max(1, Math.min(3, Number(options.attempts || DEFAULT_RETRY_ATTEMPTS)))
    const retryDelayMs = Math.max(0, Number(options.retryDelayMs || DEFAULT_RETRY_DELAY_MS))
    const type = clip(options.type || "notification", 80)

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const sent = await sock.sendMessage(targetJid, content)
            lastNotificationAt = Date.now()
            lastNotificationResult = "SUCCESS"
            lastNotificationType = type
            lastNotificationError = null
            return sent || true
        } catch (error) {
            lastNotificationAt = Date.now()
            lastNotificationResult = "FAILED"
            lastNotificationType = type
            lastNotificationError = clip(error?.message || error)
            console.log(`[BOT NOTIFICATION] Gagal kirim ${type} attempt ${attempt}/${attempts}: ${lastNotificationError}`)
            if (attempt < attempts) await wait(retryDelayMs)
        }
    }

    return false
}

function getBotNotificationHealth() {
    return {
        enabled: true,
        targetJid: getBotNotificationGroupJid(),
        activeNotification: "GROUP ONLY",
        restartNotification: "GROUP ONLY",
        reconnectNotification: "GROUP ONLY",
        autoReplyForwarder: "GROUP ONLY",
        privateOwnerNotification: "OFF",
        pmFallback: "OFF",
        lastNotificationAt,
        lastNotificationResult,
        lastNotificationType,
        lastNotificationError,
    }
}

function formatJakartaTime(date = new Date()) {
    try {
        return new Intl.DateTimeFormat("id-ID", {
            timeZone: process.env.TZ || process.env.BOT_TIMEZONE || "Asia/Jakarta",
            dateStyle: "medium",
            timeStyle: "medium",
        }).format(date)
    } catch {
        return date.toISOString()
    }
}

async function handleBotNotificationCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    if (!/^\.(?:notifytarget|botnotify)(?:\s|$)/i.test(text)) return false

    const from = String(context.from || msg?.key?.remoteJid || "")
    if (context.isGroup === true || from.endsWith("@g.us")) return true
    if (!context.isOwner) {
        await sock.sendMessage(from, { text: "Akses Ditolak" })
        return true
    }

    const argument = text.replace(/^\.(?:notifytarget|botnotify)\s*/i, "").trim().toLowerCase()
    const health = getBotNotificationHealth()

    if (!argument || argument === "status") {
        await sock.sendMessage(from, {
            text: [
                "🔔 *BOT NOTIFICATION TARGET*",
                "",
                `Target: ${health.targetJid}`,
                "Active/Startup: GROUP ONLY",
                "Restart/Reconnect: GROUP ONLY",
                "Auto Reply Forwarder: GROUP ONLY",
                "Private Owner Notification: OFF",
                "PM Fallback: OFF",
                `Last Result: ${health.lastNotificationResult}`,
                `Last Notification: ${health.lastNotificationAt ? formatJakartaTime(new Date(health.lastNotificationAt)) : "belum ada"}`,
            ].join("\n"),
        })
        return true
    }

    let testContent = null
    let type = "manual-test"
    if (argument === "test") {
        testContent = {
            text: [
                "🧪 *BOT NOTIFICATION TEST*",
                "",
                "Status: Berhasil",
                "Target: Group Notification",
                `Waktu: ${formatJakartaTime()}`,
            ].join("\n"),
        }
    } else if (argument === "active test") {
        type = "active-test"
        testContent = {
            text: [
                "✅ *USERBOT FAHRI AKTIF*",
                "",
                "Bot sudah tersambung ke WhatsApp.",
                `Waktu: ${formatJakartaTime()}`,
                "",
                "_Simulasi notifikasi aktif dari owner._",
            ].join("\n"),
        }
    } else if (argument === "autoreply test") {
        type = "auto-reply-test"
        testContent = {
            text: [
                "📩 *AUTO-REPLY FORWARDER TEST*",
                "",
                "Jenis: Data dummy",
                "Pengirim: 628xxxxxxxxxx",
                "Pesan: Ini contoh notifikasi Auto Reply private.",
                "Balasan bot: Ini contoh balasan otomatis.",
            ].join("\n"),
        }
    }

    if (testContent) {
        const sent = await sendBotNotification(sock, testContent, { type })
        await sock.sendMessage(from, {
            text: sent
                ? "✅ Test notification berhasil dikirim ke grup."
                : "❌ Test notification gagal. Periksa log PM2.",
        })
        return true
    }

    await sock.sendMessage(from, {
        text: [
            "🔔 *BOT NOTIFICATION*",
            "",
            ".notifytarget status",
            ".notifytarget test",
            ".notifytarget active test",
            ".notifytarget autoreply test",
        ].join("\n"),
    })
    return true
}

module.exports = {
    DEFAULT_BOT_NOTIFICATION_GROUP_JID,
    validateBotNotificationGroupJid,
    getBotNotificationGroupJid,
    isBotNotificationGroup,
    sendBotNotification,
    getBotNotificationHealth,
    handleBotNotificationCommand,
}
