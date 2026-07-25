"use strict"

const fs = require("fs")
const path = require("path")

const DATA_FILE = path.join(__dirname, "..", "data", "commandRateLimit.json")
const DEFAULT_STATE = Object.freeze({
    version: 1,
    global: {
        enabled: true,
        ownerBypass: true,
        maxCommandsPerMinute: 5,
        chatMaxCommandsPerMinute: 30,
        warningCooldownMs: 30000,
        cooldowns: {
            command: 5000,
            downloader: 30000,
            media: 20000,
            ocr: 45000,
        },
    },
    groups: {},
    updatedAt: 0,
    updatedBy: "system",
})

const runtime = {
    cooldowns: new Map(),
    userWindows: new Map(),
    chatWindows: new Map(),
    warningAt: new Map(),
    usage: new Map(),
    blocked: 0,
    allowed: 0,
    lastBlockedAt: null,
    lastAllowedAt: null,
}

let cache = null

function clone(value) {
    return JSON.parse(JSON.stringify(value))
}

function normalizeJid(value) {
    return String(value || "").trim().toLowerCase()
}

function isGroupJid(value) {
    return normalizeJid(value).endsWith("@g.us")
}

function asPositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.round(parsed)))
}

function normalizeState(input) {
    const source = input && typeof input === "object" ? input : {}
    const global = source.global && typeof source.global === "object" ? source.global : {}
    const cooldowns = global.cooldowns && typeof global.cooldowns === "object" ? global.cooldowns : {}
    return {
        version: 1,
        global: {
            enabled: global.enabled !== false,
            ownerBypass: global.ownerBypass !== false,
            maxCommandsPerMinute: asPositiveInteger(global.maxCommandsPerMinute, DEFAULT_STATE.global.maxCommandsPerMinute, 1, 1000),
            chatMaxCommandsPerMinute: asPositiveInteger(global.chatMaxCommandsPerMinute, DEFAULT_STATE.global.chatMaxCommandsPerMinute, 1, 5000),
            warningCooldownMs: asPositiveInteger(global.warningCooldownMs, DEFAULT_STATE.global.warningCooldownMs, 1000, 3600000),
            cooldowns: {
                command: asPositiveInteger(cooldowns.command, DEFAULT_STATE.global.cooldowns.command, 0, 3600000),
                downloader: asPositiveInteger(cooldowns.downloader, DEFAULT_STATE.global.cooldowns.downloader, 0, 3600000),
                media: asPositiveInteger(cooldowns.media, DEFAULT_STATE.global.cooldowns.media, 0, 3600000),
                ocr: asPositiveInteger(cooldowns.ocr, DEFAULT_STATE.global.cooldowns.ocr, 0, 3600000),
            },
        },
        groups: source.groups && typeof source.groups === "object" ? source.groups : {},
        updatedAt: source.updatedAt || 0,
        updatedBy: String(source.updatedBy || "system"),
    }
}

function loadState() {
    if (cache) return clone(cache)
    try {
        cache = normalizeState(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")))
    } catch {
        cache = normalizeState(DEFAULT_STATE)
    }
    return clone(cache)
}

function saveState(nextState) {
    const normalized = normalizeState(nextState)
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
    const temp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
    fs.renameSync(temp, DATA_FILE)
    cache = normalized
    return clone(normalized)
}

function parseDuration(value) {
    const clean = String(value || "").trim().toLowerCase()
    const match = clean.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/)
    if (!match) return null
    const amount = Number(match[1])
    const unit = match[2] || "s"
    const multiplier = unit === "ms" ? 1 : unit === "m" ? 60000 : 1000
    const result = Math.round(amount * multiplier)
    return Number.isFinite(result) && result >= 0 && result <= 3600000 ? result : null
}

function formatDuration(ms) {
    const value = Math.max(0, Number(ms) || 0)
    if (value >= 60000 && value % 60000 === 0) return `${value / 60000} menit`
    if (value >= 1000) return `${Math.ceil(value / 1000)} detik`
    return `${value} ms`
}

function getCommandToken(text) {
    const clean = String(text || "").trim().toLowerCase()
    if (!clean.startsWith(".")) return ""
    return clean.split(/\s+/)[0]
}

const DOWNLOADER_COMMANDS = new Set([
    ".spdl", ".spotify", ".dlold", ".olddl", ".status", ".statusdl",
    ".statusget", ".getstatus", ".statuskontak", ".statuscontact",
])
const MEDIA_COMMANDS = new Set([
    ".stiker", ".nampak", ".pdf", ".vn", ".ptt", ".makeqr",
    ".tgstiker", ".tgstikerold", ".tgpack", ".tgsticker2",
])
const OCR_COMMANDS = new Set([
    ".kasarocr", ".antitoxicocr", ".stikerguard", ".stickersafety",
    ".stickerguard", ".stikerword",
])
const CONTROL_COMMANDS = new Set([".ratelimit", ".rlimit"])
const URL_PATTERN = /https?:\/\/[^\s]+/i

function classifyRequest(input = {}) {
    const text = String(input.text || "").trim()
    const command = getCommandToken(text)
    if (command) {
        if (CONTROL_COMMANDS.has(command)) return { limited: false, category: "control", command }
        if (DOWNLOADER_COMMANDS.has(command)) return { limited: true, category: "downloader", command }
        if (MEDIA_COMMANDS.has(command)) return { limited: true, category: "media", command }
        if (OCR_COMMANDS.has(command)) return { limited: true, category: "ocr", command }
        return { limited: true, category: "command", command }
    }
    if (input.isGroup !== true && URL_PATTERN.test(text)) {
        return { limited: true, category: "downloader", command: "auto-link" }
    }
    return { limited: false, category: "none", command: "" }
}

function pruneTimestamps(list, now, windowMs = 60000) {
    const threshold = now - windowMs
    return (Array.isArray(list) ? list : []).filter(value => Number(value) > threshold)
}

function getEffectiveConfig(chatJid, override = null) {
    const state = override ? normalizeState(override) : loadState()
    const jid = normalizeJid(chatJid)
    const groupConfig = isGroupJid(jid) && state.groups[jid] && typeof state.groups[jid] === "object"
        ? state.groups[jid]
        : null
    return {
        ...state.global,
        enabled: state.global.enabled !== false && groupConfig?.enabled !== false,
        groupEnabled: groupConfig?.enabled !== false,
    }
}

function incrementUsage(command) {
    const key = String(command || "unknown")
    runtime.usage.set(key, (runtime.usage.get(key) || 0) + 1)
}

function shouldNotifyBlocked(key, now, cooldownMs) {
    const previous = runtime.warningAt.get(key) || 0
    if (now - previous < cooldownMs) return false
    runtime.warningAt.set(key, now)
    return true
}

function checkRateLimit(input = {}) {
    const now = Number(input.now || Date.now())
    const actorJid = normalizeJid(input.actorJid || input.senderJid)
    const chatJid = normalizeJid(input.chatJid || input.remoteJid)
    const category = ["command", "downloader", "media", "ocr"].includes(input.category)
        ? input.category
        : "command"
    const command = String(input.command || category)
    const config = getEffectiveConfig(chatJid, input.configOverride)

    if (!input.limited || !actorJid || !chatJid || config.enabled === false) {
        return { allowed: true, skipped: true, category, command, reason: config.enabled === false ? "disabled" : "not-limited" }
    }
    if (input.isOwner === true && config.ownerBypass !== false) {
        return { allowed: true, skipped: true, category, command, reason: "owner-bypass" }
    }

    const userWindowKey = `${chatJid}|${actorJid}`
    const chatWindowKey = chatJid
    const cooldownKey = `${chatJid}|${actorJid}|${category}`
    const warningKey = `${chatJid}|${actorJid}`

    const userWindow = pruneTimestamps(runtime.userWindows.get(userWindowKey), now)
    const chatWindow = pruneTimestamps(runtime.chatWindows.get(chatWindowKey), now)
    runtime.userWindows.set(userWindowKey, userWindow)
    runtime.chatWindows.set(chatWindowKey, chatWindow)

    const lastCategoryUse = runtime.cooldowns.get(cooldownKey) || 0
    const categoryCooldownMs = Number(config.cooldowns?.[category] ?? DEFAULT_STATE.global.cooldowns[category])
    const cooldownRemaining = Math.max(0, lastCategoryUse + categoryCooldownMs - now)
    const userWindowRemaining = userWindow.length >= config.maxCommandsPerMinute
        ? Math.max(1000, userWindow[0] + 60000 - now)
        : 0
    const chatWindowRemaining = chatWindow.length >= config.chatMaxCommandsPerMinute
        ? Math.max(1000, chatWindow[0] + 60000 - now)
        : 0
    const retryAfterMs = Math.max(cooldownRemaining, userWindowRemaining, chatWindowRemaining)

    if (retryAfterMs > 0) {
        runtime.blocked += 1
        runtime.lastBlockedAt = new Date(now).toISOString()
        return {
            allowed: false,
            category,
            command,
            retryAfterMs,
            reason: userWindowRemaining > 0
                ? "user-minute-limit"
                : chatWindowRemaining > 0
                    ? "chat-minute-limit"
                    : "category-cooldown",
            notify: shouldNotifyBlocked(warningKey, now, config.warningCooldownMs),
        }
    }

    userWindow.push(now)
    chatWindow.push(now)
    runtime.userWindows.set(userWindowKey, userWindow)
    runtime.chatWindows.set(chatWindowKey, chatWindow)
    runtime.cooldowns.set(cooldownKey, now)
    runtime.allowed += 1
    runtime.lastAllowedAt = new Date(now).toISOString()
    incrementUsage(command)
    return { allowed: true, category, command, reason: "allowed", notify: false }
}

function getTopUsage(limit = 10) {
    return [...runtime.usage.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.max(1, Number(limit) || 10))
        .map(([command, count]) => ({ command, count }))
}

function resetRuntimeState() {
    runtime.cooldowns.clear()
    runtime.userWindows.clear()
    runtime.chatWindows.clear()
    runtime.warningAt.clear()
    runtime.usage.clear()
    runtime.blocked = 0
    runtime.allowed = 0
    runtime.lastBlockedAt = null
    runtime.lastAllowedAt = null
}

function getRateLimitHealth() {
    const state = loadState()
    return {
        enabled: state.global.enabled !== false,
        ownerBypass: state.global.ownerBypass !== false,
        maxCommandsPerMinute: state.global.maxCommandsPerMinute,
        chatMaxCommandsPerMinute: state.global.chatMaxCommandsPerMinute,
        warningCooldownMs: state.global.warningCooldownMs,
        cooldowns: { ...state.global.cooldowns },
        allowed: runtime.allowed,
        blocked: runtime.blocked,
        trackedUsers: runtime.userWindows.size,
        trackedChats: runtime.chatWindows.size,
        lastBlockedAt: runtime.lastBlockedAt,
        lastAllowedAt: runtime.lastAllowedAt,
        topUsage: getTopUsage(5),
    }
}

function statusText() {
    const health = getRateLimitHealth()
    return [
        "🚦 *COMMAND RATE LIMIT*",
        "",
        `Status: ${health.enabled ? "ON" : "OFF"}`,
        `Owner Bypass: ${health.ownerBypass ? "ON" : "OFF"}`,
        `Maksimal per user: ${health.maxCommandsPerMinute} command/menit`,
        `Maksimal per chat: ${health.chatMaxCommandsPerMinute} command/menit`,
        `Command biasa: ${formatDuration(health.cooldowns.command)}`,
        `Downloader: ${formatDuration(health.cooldowns.downloader)}`,
        `Media tools: ${formatDuration(health.cooldowns.media)}`,
        `OCR/AI: ${formatDuration(health.cooldowns.ocr)}`,
        `Warning cooldown: ${formatDuration(health.warningCooldownMs)}`,
        "",
        `Allowed runtime: ${health.allowed}`,
        `Blocked runtime: ${health.blocked}`,
    ].join("\n")
}

async function handleRateLimitCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    const lower = text.toLowerCase()
    if (lower !== ".ratelimit" && !lower.startsWith(".ratelimit ") && lower !== ".rlimit" && !lower.startsWith(".rlimit ")) return false

    const remoteJid = String(context.from || msg?.key?.remoteJid || "")
    if (context.isGroup === true || isGroupJid(remoteJid)) return true
    if (context.isOwner !== true && context.canControlOwner !== true) {
        await sock.sendMessage(remoteJid, { text: "Akses Ditolak" })
        return true
    }

    const parts = text.split(/\s+/)
    const action = String(parts[1] || "status").toLowerCase()
    const actor = context.senderJid || remoteJid
    const state = loadState()

    if (action === "status") {
        await sock.sendMessage(remoteJid, { text: statusText() })
        return true
    }
    if (action === "on" || action === "off") {
        state.global.enabled = action === "on"
        state.updatedAt = new Date().toISOString()
        state.updatedBy = actor
        saveState(state)
        await sock.sendMessage(remoteJid, { text: statusText() })
        return true
    }
    if (action === "reset") {
        resetRuntimeState()
        await sock.sendMessage(remoteJid, { text: "✅ Statistik dan cooldown runtime Rate Limit sudah dibersihkan." })
        return true
    }
    if (action === "top") {
        const top = getTopUsage(10)
        const lines = ["📊 *TOP COMMAND RUNTIME*", ""]
        if (!top.length) lines.push("Belum ada penggunaan command yang tercatat.")
        top.forEach((item, index) => lines.push(`${index + 1}. ${item.command} — ${item.count}`))
        await sock.sendMessage(remoteJid, { text: lines.join("\n") })
        return true
    }
    if (action === "set") {
        const target = String(parts[2] || "").toLowerCase()
        const value = String(parts[3] || "")
        if (["command", "downloader", "media", "ocr"].includes(target)) {
            const duration = parseDuration(value)
            if (duration == null) {
                await sock.sendMessage(remoteJid, { text: "Format durasi: 5s, 30s, 1m, atau 500ms." })
                return true
            }
            state.global.cooldowns[target] = duration
        } else if (target === "max") {
            state.global.maxCommandsPerMinute = asPositiveInteger(value, state.global.maxCommandsPerMinute, 1, 1000)
        } else if (target === "chatmax") {
            state.global.chatMaxCommandsPerMinute = asPositiveInteger(value, state.global.chatMaxCommandsPerMinute, 1, 5000)
        } else {
            await sock.sendMessage(remoteJid, { text: "Format: .ratelimit set <command|downloader|media|ocr|max|chatmax> <nilai>" })
            return true
        }
        state.updatedAt = new Date().toISOString()
        state.updatedBy = actor
        saveState(state)
        await sock.sendMessage(remoteJid, { text: statusText() })
        return true
    }
    if (action === "group") {
        const targetInput = String(parts[2] || "")
        const requested = String(parts[3] || "").toLowerCase()
        if (!/^(on|off)$/.test(requested)) {
            await sock.sendMessage(remoteJid, { text: "Format: .ratelimit group <G001|group_jid> on/off" })
            return true
        }
        const resolved = typeof context.resolveGroupTarget === "function"
            ? await context.resolveGroupTarget(targetInput, sock)
            : { ok: isGroupJid(targetInput), jid: normalizeJid(targetInput), subject: targetInput }
        if (!resolved?.ok || !isGroupJid(resolved.jid)) {
            await sock.sendMessage(remoteJid, { text: "❌ ID/kode grup tidak valid." })
            return true
        }
        state.groups[resolved.jid] = {
            ...(state.groups[resolved.jid] || {}),
            enabled: requested === "on",
            updatedAt: new Date().toISOString(),
            updatedBy: actor,
        }
        state.updatedAt = new Date().toISOString()
        state.updatedBy = actor
        saveState(state)
        await sock.sendMessage(remoteJid, {
            text: `✅ Rate Limit ${requested === "on" ? "diaktifkan" : "dinonaktifkan"} untuk ${resolved.subject || resolved.jid}.`,
        })
        return true
    }

    await sock.sendMessage(remoteJid, {
        text: [
            "🚦 *COMMAND RATE LIMIT*",
            "",
            ".ratelimit status",
            ".ratelimit on/off",
            ".ratelimit set command 5s",
            ".ratelimit set downloader 30s",
            ".ratelimit set media 20s",
            ".ratelimit set ocr 45s",
            ".ratelimit set max 5",
            ".ratelimit set chatmax 30",
            ".ratelimit group <G001|group_jid> on/off",
            ".ratelimit top",
            ".ratelimit reset",
        ].join("\n"),
    })
    return true
}

module.exports = {
    DATA_FILE,
    DEFAULT_STATE,
    checkRateLimit,
    classifyRequest,
    formatDuration,
    getEffectiveConfig,
    getRateLimitHealth,
    getTopUsage,
    handleRateLimitCommand,
    loadState,
    parseDuration,
    resetRuntimeState,
    saveState,
}
