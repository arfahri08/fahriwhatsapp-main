"use strict"

const fs = require("fs")
const path = require("path")

const DATA_FILE = path.join(__dirname, "..", "data", "antiToxicControl.json")
const VALID_MODES = new Set(["normal", "silent", "off"])
const DEFAULT_STATE = {
    version: 1,
    groups: {},
    temporaryRules: {},
}

function cloneDefaultState() {
    return {
        version: DEFAULT_STATE.version,
        groups: {},
        temporaryRules: {},
    }
}

function normalizeJid(value) {
    return String(value || "").trim().toLowerCase()
}

function isGroupJid(jid) {
    return normalizeJid(jid).endsWith("@g.us")
}

function getMessageGroupJid(msg) {
    const jid = normalizeJid(msg?.key?.remoteJid)
    return isGroupJid(jid) ? jid : ""
}

function ensureDataFile() {
    try {
        fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
        if (!fs.existsSync(DATA_FILE)) {
            saveAntiToxicControlState(cloneDefaultState())
        }
    } catch (error) {
        console.log(`[ANTI-TOXIC CONTROL] Gagal memastikan file data: ${error.message}`)
    }
}

function normalizeState(raw) {
    const state = raw && typeof raw === "object" ? raw : cloneDefaultState()
    return {
        version: 1,
        groups: state.groups && typeof state.groups === "object" ? state.groups : {},
        temporaryRules: state.temporaryRules && typeof state.temporaryRules === "object" ? state.temporaryRules : {},
    }
}

function loadAntiToxicControlState() {
    ensureDataFile()

    try {
        if (!fs.existsSync(DATA_FILE)) return cloneDefaultState()
        return normalizeState(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")))
    } catch (error) {
        try {
            const backupPath = path.join(
                path.dirname(DATA_FILE),
                `antiToxicControl.corrupt.${Date.now()}.json`
            )
            if (fs.existsSync(DATA_FILE)) fs.renameSync(DATA_FILE, backupPath)
            console.log(`[ANTI-TOXIC CONTROL] File JSON rusak, dibackup ke ${path.basename(backupPath)}.`)
        } catch (backupError) {
            console.log(`[ANTI-TOXIC CONTROL] Gagal backup JSON rusak: ${backupError.message}`)
        }

        const fresh = cloneDefaultState()
        saveAntiToxicControlState(fresh)
        return fresh
    }
}

function saveAntiToxicControlState(state) {
    try {
        fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
        fs.writeFileSync(DATA_FILE, `${JSON.stringify(normalizeState(state), null, 2)}\n`)
        return true
    } catch (error) {
        console.log(`[ANTI-TOXIC CONTROL] Gagal menyimpan state: ${error.message}`)
        return false
    }
}

function cleanupExpiredAntiToxicRules() {
    const state = loadAntiToxicControlState()
    const now = Date.now()
    let changed = false

    for (const [jid, rule] of Object.entries(state.temporaryRules || {})) {
        if (!rule || Number(rule.until || 0) <= now) {
            delete state.temporaryRules[jid]
            changed = true
        }
    }

    if (changed) saveAntiToxicControlState(state)
    return state
}

function getGroupConfig(state, groupJid) {
    const config = state.groups?.[groupJid] || {}
    const mode = VALID_MODES.has(config.mode) ? config.mode : (config.enabled === false ? "off" : "normal")

    return {
        enabled: config.enabled !== false && mode !== "off",
        mode,
        updatedAt: Number(config.updatedAt || 0),
        updatedBy: normalizeJid(config.updatedBy),
        reason: String(config.reason || "default"),
    }
}

function getEffectiveRuleForGroup(groupJid) {
    if (!groupJid) return { enabled: true, mode: "normal", temporaryRule: null, groupConfig: null }

    const state = cleanupExpiredAntiToxicRules()
    const groupConfig = getGroupConfig(state, groupJid)
    const temporaryRule = state.temporaryRules?.[groupJid] || null

    if (
        temporaryRule
        && Number(temporaryRule.until || 0) > Date.now()
        && VALID_MODES.has(temporaryRule.mode)
    ) {
        return {
            enabled: temporaryRule.mode !== "off",
            mode: temporaryRule.mode,
            temporaryRule,
            groupConfig,
        }
    }

    return {
        enabled: groupConfig.enabled,
        mode: groupConfig.mode,
        temporaryRule: null,
        groupConfig,
    }
}

function isAntiToxicEnabledForMessage(msg) {
    const groupJid = getMessageGroupJid(msg)
    if (!groupJid) return true
    return getEffectiveRuleForGroup(groupJid).enabled
}

function getAntiToxicModeForMessage(msg) {
    const groupJid = getMessageGroupJid(msg)
    if (!groupJid) return "normal"
    return getEffectiveRuleForGroup(groupJid).mode
}

function shouldRunAntiToxic(msg) {
    const groupJid = getMessageGroupJid(msg)
    if (!groupJid) return true

    const { mode } = getEffectiveRuleForGroup(groupJid)
    if (mode === "off") return false
    if (mode === "silent") return false
    return true
}

function parseCommand(text) {
    const raw = String(text || "").trim()
    const lower = raw.toLowerCase()
    const roots = [".antikasar", ".anti kasar", ".toxic"]

    for (const root of roots) {
        if (lower === root) return { matched: true, root, args: "" }
        if (lower.startsWith(`${root} `)) {
            return {
                matched: true,
                root,
                args: raw.slice(root.length).trim(),
            }
        }
    }

    return { matched: false, root: "", args: "" }
}

function parseDuration(value) {
    const match = String(value || "").trim().toLowerCase().match(/^(\d+)([mhd])$/)
    if (!match) return null

    const amount = Number(match[1])
    if (!Number.isFinite(amount) || amount <= 0) return null

    const unit = match[2]
    const multiplier = unit === "m"
        ? 60 * 1000
        : unit === "h"
            ? 60 * 60 * 1000
            : 24 * 60 * 60 * 1000

    return {
        amount,
        unit,
        ms: amount * multiplier,
    }
}

function formatDuration(duration) {
    if (!duration) return "-"
    const label = duration.unit === "m" ? "menit" : duration.unit === "h" ? "jam" : "hari"
    return `${duration.amount} ${label}`
}

function formatDateTime(timestamp) {
    if (!timestamp) return "-"
    try {
        return new Intl.DateTimeFormat("id-ID", {
            timeZone: "Asia/Jakarta",
            dateStyle: "medium",
            timeStyle: "short",
        }).format(new Date(timestamp))
    } catch {
        return new Date(timestamp).toISOString()
    }
}

function getSenderCandidates(msg, context = {}) {
    return [
        context.sender,
        context.senderJid,
        msg?.key?.participant,
        msg?.participant,
        msg?.key?.participantAlt,
        msg?.key?.senderPn,
        msg?.key?.senderLid,
    ].map(normalizeJid).filter(Boolean)
}

async function isGroupAdmin(sock, groupJid, msg, context = {}) {
    const candidates = new Set(getSenderCandidates(msg, context))
    if (!groupJid || candidates.size === 0) return false

    try {
        const metadata = typeof context.getGroupMetadata === "function"
            ? await context.getGroupMetadata(groupJid)
            : await sock.groupMetadata(groupJid)

        for (const participant of metadata?.participants || []) {
            const participantIds = [
                participant.id,
                participant.jid,
                participant.lid,
                participant.phoneNumber,
            ].map(normalizeJid).filter(Boolean)

            const isSameSender = participantIds.some(id => candidates.has(id))
            const isAdmin = Boolean(participant.admin || participant.isAdmin || participant.isSuperAdmin)
            if (isSameSender && isAdmin) return true
        }
    } catch (error) {
        console.log(`[ANTI-TOXIC CONTROL] Gagal cek admin grup: ${error.message}`)
    }

    return false
}

function getHelpText() {
    return [
        "🛡️ *Anti Kasar Control*",
        "",
        ".antikasar on",
        ".antikasar off",
        ".antikasar normal",
        ".antikasar silent",
        ".antikasar pause 30m",
        ".antikasar pause 2h",
        ".antikasar resume",
        ".antikasar status",
    ].join("\n")
}

function getStatusText(groupJid) {
    const state = cleanupExpiredAntiToxicRules()
    const groupConfig = getGroupConfig(state, groupJid)
    const temporaryRule = state.temporaryRules?.[groupJid] || null
    const effective = getEffectiveRuleForGroup(groupJid)
    const temporaryText = temporaryRule
        ? `${temporaryRule.mode} sampai ${formatDateTime(temporaryRule.until)}`
        : "tidak ada"

    return [
        "🛡️ *Status Anti Kasar*",
        "",
        `Grup: ${effective.enabled ? "aktif" : "mati"}`,
        `Mode: ${effective.mode}`,
        `Temporary: ${temporaryText}`,
        "Default: aktif",
        "",
        "Command:",
        ".antikasar on",
        ".antikasar off",
        ".antikasar silent",
        ".antikasar normal",
        ".antikasar pause 30m",
        ".antikasar pause 2h",
        ".antikasar resume",
    ].join("\n")
}

function setGroupMode(groupJid, mode, senderJid, reason = "manual") {
    const state = cleanupExpiredAntiToxicRules()
    state.groups[groupJid] = {
        enabled: mode !== "off",
        mode,
        updatedAt: Date.now(),
        updatedBy: normalizeJid(senderJid),
        reason,
    }
    delete state.temporaryRules[groupJid]
    saveAntiToxicControlState(state)
}

function setTemporaryRule(groupJid, duration, senderJid, reason = "pause") {
    const state = cleanupExpiredAntiToxicRules()
    state.temporaryRules[groupJid] = {
        mode: "off",
        until: Date.now() + duration.ms,
        createdAt: Date.now(),
        createdBy: normalizeJid(senderJid),
        reason,
    }
    saveAntiToxicControlState(state)
}

function clearTemporaryRule(groupJid) {
    const state = cleanupExpiredAntiToxicRules()
    delete state.temporaryRules[groupJid]
    saveAntiToxicControlState(state)
}

async function handleAntiToxicControlCommand(sock, msg, context = {}) {
    const parsed = parseCommand(context.text)
    if (!parsed.matched) return false

    const groupJid = normalizeJid(context.from || msg?.key?.remoteJid)
    if (!isGroupJid(groupJid)) {
        await sock.sendMessage(groupJid || msg?.key?.remoteJid, { text: "❌ Command ini hanya untuk grup." })
        return true
    }

    const senderJid = normalizeJid(context.sender || context.senderJid || msg?.key?.participant)
    const allowedByOwner = Boolean(context.canControlOwner || context.isOwner)
    const allowedByAdmin = allowedByOwner ? true : await isGroupAdmin(sock, groupJid, msg, context)

    if (!allowedByOwner && !allowedByAdmin) {
        await sock.sendMessage(groupJid, { text: "❌ Fitur ini hanya bisa diatur oleh owner bot atau admin grup." })
        return true
    }

    cleanupExpiredAntiToxicRules()

    const args = parsed.args.trim()
    if (!args) {
        await sock.sendMessage(groupJid, { text: getHelpText() })
        return true
    }

    const [actionRaw, durationRaw, ...reasonParts] = args.split(/\s+/)
    const action = String(actionRaw || "").toLowerCase()
    const reason = reasonParts.join(" ").trim() || "manual"

    if (action === "on") {
        setGroupMode(groupJid, "normal", senderJid, "on")
        await sock.sendMessage(groupJid, { text: "✅ Anti kasar aktif di grup ini." })
        return true
    }

    if (action === "off") {
        setGroupMode(groupJid, "off", senderJid, "off")
        await sock.sendMessage(groupJid, { text: "🚫 Anti kasar dimatikan di grup ini." })
        return true
    }

    if (action === "silent") {
        setGroupMode(groupJid, "silent", senderJid, "silent")
        await sock.sendMessage(groupJid, { text: "🔕 Anti kasar masuk mode silent di grup ini." })
        return true
    }

    if (action === "normal") {
        setGroupMode(groupJid, "normal", senderJid, "normal")
        await sock.sendMessage(groupJid, { text: "✅ Anti kasar kembali ke mode normal." })
        return true
    }

    if (action === "status") {
        await sock.sendMessage(groupJid, { text: getStatusText(groupJid) })
        return true
    }

    if (action === "pause") {
        const duration = parseDuration(durationRaw)
        if (!duration) {
            await sock.sendMessage(groupJid, { text: "❌ Format durasi salah. Contoh: .antikasar pause 30m / 2h / 1d" })
            return true
        }

        setTemporaryRule(groupJid, duration, senderJid, reason)
        await sock.sendMessage(groupJid, {
            text: `⏸️ Anti kasar dimatikan sementara selama ${formatDuration(duration)}. Akan aktif lagi otomatis setelah waktunya habis.`,
        })
        return true
    }

    if (action === "resume") {
        clearTemporaryRule(groupJid)
        await sock.sendMessage(groupJid, { text: "▶️ Anti kasar dilanjutkan kembali di grup ini." })
        return true
    }

    await sock.sendMessage(groupJid, { text: getHelpText() })
    return true
}

module.exports = {
    DATA_FILE,
    VALID_MODES,
    cleanupExpiredAntiToxicRules,
    getAntiToxicModeForMessage,
    handleAntiToxicControlCommand,
    isAntiToxicEnabledForMessage,
    loadAntiToxicControlState,
    saveAntiToxicControlState,
    shouldRunAntiToxic,
}
