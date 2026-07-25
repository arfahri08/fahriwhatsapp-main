"use strict"

const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

function envEnabled(value, fallback = false) {
    const clean = String(value ?? "").trim()
    if (!clean) return fallback
    return /^(1|true|yes|on)$/i.test(clean)
}

function safeCall(fn, fallback = null) {
    try {
        return typeof fn === "function" ? fn() : fallback
    } catch {
        return fallback
    }
}

function yesNo(value, unknown = "UNKNOWN") {
    if (value === true) return "ON"
    if (value === false) return "OFF"
    return unknown
}

function formatTime(value) {
    if (!value) return "belum ada"
    try {
        return new Intl.DateTimeFormat("id-ID", {
            timeZone: process.env.TZ || process.env.BOT_TIMEZONE || "Asia/Jakarta",
            dateStyle: "medium",
            timeStyle: "medium",
        }).format(new Date(value))
    } catch {
        return String(value)
    }
}

function binaryStatus(binary, args = ["--version"]) {
    const command = String(binary || "").trim()
    if (!command) return "NOT FOUND"
    try {
        const result = spawnSync(command, args, { encoding: "utf8", timeout: 2500, windowsHide: true })
        if (!result.error && result.status === 0) return "READY"
        return "NOT FOUND"
    } catch {
        return "NOT FOUND"
    }
}

function getAutoReplyHealth(service) {
    let enabled = null
    try {
        if (service && typeof service.getStatus === "function") enabled = service.getStatus() === true
    } catch {
        enabled = null
    }
    return {
        global: yesNo(enabled),
        privateChat: enabled == null ? "UNKNOWN" : (enabled ? "ON" : "OFF"),
        groupChat: "OFF",
        scope: "PRIVATE ONLY",
        forwarder: enabled === false ? "OFF" : "PRIVATE ONLY",
        keyword: enabled === false ? "OFF" : "PRIVATE ONLY",
    }
}

function getMemoryText() {
    const usage = process.memoryUsage()
    const mb = value => `${Math.round(value / 1024 / 1024)} MB`
    return `RSS ${mb(usage.rss)} | Heap ${mb(usage.heapUsed)}/${mb(usage.heapTotal)}`
}

async function buildHealthText(services = {}) {
    const auto = getAutoReplyHealth(services.autoReply)
    const botActive = safeCall(() => services.botStatus?.getStatus?.(), null)
    const policy = safeCall(() => services.groupRemoteControl?.getInboundGroupPolicySummary?.(), null)
    const edit = safeCall(() => services.messageEditGuardian?.getMessageEditGuardianHealth?.(), null)
    const security = safeCall(() => services.securityMediaLog?.getSecurityMediaLogHealth?.(), null)
    const ocr = safeCall(() => services.antiToxicStickerOcr?.getAntiToxicStickerOcrHealth?.(), null)
    const sticker = safeCall(() => services.stickerSafetyGuard?.getStickerSafetyHealth?.(), null)
    const scheduler = safeCall(() => services.broadcastSchedulerStatus?.(), null)
    const schedules = safeCall(() => services.bcscheduler?.getStatus?.(), null)
    const notification = safeCall(() => services.botNotificationTarget?.getBotNotificationHealth?.(), null)

    const ytDlp = process.env.YTDLP_BIN || "yt-dlp"
    const ffmpeg = process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg"
    const lines = [
        "🩺 *BOT HEALTH CHECK*",
        "",
        `Node.js: ${process.version}`,
        `Platform: ${process.platform} ${process.arch}`,
        `Uptime: ${Math.floor(process.uptime())} detik`,
        `Memory: ${getMemoryText()}`,
        `Bot Global: ${yesNo(botActive)}`,
        "",
        `Auto Reply Global: ${auto.global}`,
        `Auto Reply Scope: ${auto.scope}`,
        `Private Auto Reply: ${auto.privateChat}`,
        `Group Auto Reply: ${auto.groupChat}`,
        `Auto Reply Forwarder: ${auto.forwarder}`,
        `Keyword Auto Reply: ${auto.keyword}`,
        "",
        `Bot Notification Target: ${notification?.targetJid || "120363424006225997@g.us"}`,
        `Active Notification: ${notification?.activeNotification || "GROUP ONLY"}`,
        `Restart Notification: ${notification?.restartNotification || "GROUP ONLY"}`,
        `Reconnect Notification: ${notification?.reconnectNotification || "GROUP ONLY"}`,
        `Auto Reply Forwarder Target: ${notification?.autoReplyForwarder || "GROUP ONLY"}`,
        `Private Owner Notification: ${notification?.privateOwnerNotification || "OFF"}`,
        `PM Fallback: ${notification?.pmFallback || "OFF"}`,
        `Last Notification: ${formatTime(notification?.lastNotificationAt)}`,
        `Last Notification Result: ${notification?.lastNotificationResult || "UNKNOWN"}`,
        "",
        `Group Inbound Policy: ${policy?.mode || "ANTI TOXIC ONLY"}`,
        "Group Detect Link: OFF",
        "Private Detect Link: ON",
        "Group Downloader: OFF",
        "Group Sticker Safety: OFF",
        "",
        `yt-dlp: ${binaryStatus(ytDlp)}`,
        `ffmpeg: ${binaryStatus(ffmpeg, ["-version"])}`,
    ]

    if (edit) {
        lines.push(
            "",
            `Edited Message Guardian: ${yesNo(edit.enabled)}`,
            `Edited Message Scope: ${edit.scope || "Group Anti Kasar"}`,
            `Edit Cache: ${edit.cacheSize ?? 0}/${edit.cacheMax ?? "-"}`,
            `Toxic Edits: ${edit.toxicEdits ?? 0}`,
            `Last Edit Event: ${formatTime(edit.lastEventAt)}`
        )
    }

    if (ocr) {
        lines.push(
            "",
            `Anti Toxic Sticker OCR: ${yesNo(ocr.enabled ?? ocr.status === "ON")}`,
            `OCR Engine: ${ocr.engine || ocr.status || "UNKNOWN"}`,
            `Last OCR Scan: ${formatTime(ocr.lastScanAt || ocr.lastScan?.at)}`
        )
    }

    if (sticker) {
        lines.push("", `Sticker Safety: ${yesNo(sticker.enabled)}`)
    }

    if (security) {
        lines.push(
            "",
            `Security Media Log: ${yesNo(security.enabled ?? true)}`,
            `Anti-Delete Log: ${yesNo(security.antiDeleteEnabled)}`,
            `View Once Log: ${yesNo(security.viewOnceEnabled)}`
        )
    }

    if (scheduler || schedules) {
        lines.push(
            "",
            `Broadcast Scheduler: ${yesNo(scheduler?.enabled ?? scheduler?.running ?? true)}`,
            `Broadcast Pending: ${scheduler?.pending ?? schedules?.pending ?? "-"}`,
            `Broadcast Failed: ${scheduler?.failed ?? schedules?.failed ?? "-"}`
        )
    }

    const runtimeLock = path.join(__dirname, "..", "data", "runtime.lock")
    lines.push("", `Runtime Lock: ${fs.existsSync(runtimeLock) ? "PRESENT" : "NOT FOUND"}`)
    return lines.join("\n")
}

async function handleHealthCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim().toLowerCase()
    if (text !== ".health") return false
    const from = String(context.from || msg?.key?.remoteJid || "")
    if (context.isGroup === true || from.endsWith("@g.us")) return true
    if (!context.isOwner) {
        await sock.sendMessage(from, { text: "Akses Ditolak" })
        return true
    }
    const health = await buildHealthText(context)
    await sock.sendMessage(from, { text: health })
    return true
}

module.exports = {
    binaryStatus,
    buildHealthText,
    handleHealthCommand,
}
