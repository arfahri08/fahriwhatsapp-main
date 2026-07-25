"use strict"

const fs = require("fs")
const path = require("path")

const DATA_FILE = path.join(__dirname, "..", "data", "groupRemoteControl.json")
const PRIVATE_ONLY_FEATURES = new Set([
    "antilink",
    "antiLink",
    "autoreply",
    "autoReply",
])
const FEATURE_ALIASES = {
    antikasar: "antiToxic",
    antitoxic: "antiToxic",
    anti_toxic: "antiToxic",
    toxic: "antiToxic",
    privatewarn: "privateWarn",
    privatewarning: "privateWarn",
    warningprivate: "privateWarn",
    editguard: "editGuardian",
    editedmessage: "editGuardian",
    messageedit: "editGuardian",
    antilink: "antiLink",
    detectlink: "antiLink",
    autoreply: "autoReply",
    reply: "autoReply",
    stickersafety: "stickerSafety",
    stickertext: "stickerText",
    stickernsfw: "stickerNsfw",
}
const DEFAULT_FEATURES = Object.freeze({
    antiToxic: true,
    editGuardian: true,
    privateWarn: false,
    antiLink: true,
    downloader: true,
    autoReply: true,
    broadcast: true,
    stickerSafety: true,
    stickerText: true,
    stickerNsfw: true,
    warning: true,
})

let stateCache = null
let groupCodeCache = new Map()
let groupCodeCacheAt = 0

function normalizeJid(value) {
    return String(value || "").trim().toLowerCase()
}

function isGroupJid(value) {
    return normalizeJid(value).endsWith("@g.us")
}

function defaultState() {
    return { version: 1, groups: {} }
}

function loadState() {
    if (stateCache) return stateCache
    try {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
        stateCache = {
            version: Number(parsed?.version || 1),
            groups: parsed?.groups && typeof parsed.groups === "object" ? parsed.groups : {},
        }
    } catch (error) {
        console.log(`[GROUP CONTROL] Gagal membaca config, memakai default: ${error?.message || error}`)
        stateCache = defaultState()
    }
    return stateCache
}

function saveState(nextState = stateCache || defaultState()) {
    const normalized = {
        version: Number(nextState?.version || 1),
        groups: nextState?.groups && typeof nextState.groups === "object" ? nextState.groups : {},
    }
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
    const temp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
    fs.renameSync(temp, DATA_FILE)
    stateCache = normalized
    return normalized
}

function canonicalFeatureName(value) {
    const raw = String(value || "").trim()
    if (!raw) return ""
    const lower = raw.toLowerCase().replace(/[\s_-]+/g, "")
    return FEATURE_ALIASES[lower] || raw
}

function readBoolean(value, fallback) {
    if (value === true || value === false) return value
    if (value === 1 || value === "1" || /^on|yes|true$/i.test(String(value || ""))) return true
    if (value === 0 || value === "0" || /^off|no|false$/i.test(String(value || ""))) return false
    return fallback
}

function getRawGroupConfig(groupJid) {
    const jid = normalizeJid(groupJid)
    return loadState().groups[jid] || null
}

function getEffectiveGroupConfig(groupJid) {
    const jid = normalizeJid(groupJid)
    const raw = getRawGroupConfig(jid) || {}
    const botEnabled = readBoolean(raw.botEnabled, readBoolean(raw.enabled, readBoolean(raw.bot, true)))
    const rawFeatures = raw.features && typeof raw.features === "object" ? raw.features : {}
    const features = { ...DEFAULT_FEATURES, ...rawFeatures }

    for (const key of Object.keys(DEFAULT_FEATURES)) {
        if (raw[key] === true || raw[key] === false) features[key] = raw[key]
    }

    return {
        jid,
        exists: Boolean(getRawGroupConfig(jid)),
        botEnabled,
        enabled: botEnabled,
        bot: botEnabled,
        note: String(raw.note || ""),
        updatedAt: raw.updatedAt || null,
        updatedBy: raw.updatedBy || null,
        features,
        raw,
    }
}

function isGroupBotEnabled(groupJid) {
    if (!isGroupJid(groupJid)) return true
    return getEffectiveGroupConfig(groupJid).botEnabled !== false
}

function isInboundGroupFeatureAllowed(featureName) {
    const feature = canonicalFeatureName(featureName)
    return !PRIVATE_ONLY_FEATURES.has(feature)
}

function isGroupFeatureEnabled(groupJid, featureName) {
    if (!isGroupJid(groupJid)) return true
    if (!isGroupBotEnabled(groupJid)) return false
    const feature = canonicalFeatureName(featureName)
    if (PRIVATE_ONLY_FEATURES.has(feature)) return false

    const effective = getEffectiveGroupConfig(groupJid)
    if (Object.prototype.hasOwnProperty.call(DEFAULT_FEATURES, feature)) {
        return effective.features[feature] !== false
    }

    return false
}

function isGroupAntiToxicPrivateReplyEnabled(groupJid) {
    return isGroupBotEnabled(groupJid) && getEffectiveGroupConfig(groupJid).features.privateWarn === true
}

function getInboundGroupPolicySummary() {
    return {
        mode: "COMMANDS & FEATURES (NO AUTO LINK / AUTO REPLY)",
        groupBotDefault: true,
        groupAntiToxic: true,
        groupDetectLink: false,
        privateDetectLink: true,
        groupDownloader: true,
        groupAutoReply: false,
        groupStickerSafety: true,
        allowedInboundFeatures: Object.keys(DEFAULT_FEATURES).filter(feature => !PRIVATE_ONLY_FEATURES.has(feature)),
    }
}

async function getParticipatingGroups(sock) {
    let records = []
    try {
        if (typeof sock?.groupFetchAllParticipating === "function") {
            const fetched = await sock.groupFetchAllParticipating()
            records = Object.values(fetched || {})
        }
    } catch (error) {
        console.log(`[GROUP CONTROL] Gagal mengambil daftar grup: ${error?.message || error}`)
    }

    if (!records.length) {
        records = Object.keys(loadState().groups).map(id => ({ id, subject: id }))
    }

    const unique = new Map()
    for (const item of records) {
        const jid = normalizeJid(item?.id || item?.jid)
        if (!isGroupJid(jid)) continue
        unique.set(jid, {
            jid,
            subject: String(item?.subject || item?.name || jid),
        })
    }
    return [...unique.values()].sort((a, b) => a.subject.localeCompare(b.subject, "id"))
}

async function buildGroupCodeMap(sock, force = false) {
    const now = Date.now()
    if (!force && groupCodeCache.size && now - groupCodeCacheAt < 60_000) return groupCodeCache
    const groups = await getParticipatingGroups(sock)
    const map = new Map()
    groups.forEach((group, index) => {
        const code = `G${String(index + 1).padStart(3, "0")}`
        map.set(code, { ...group, code })
    })
    groupCodeCache = map
    groupCodeCacheAt = now
    return map
}

async function resolveGroupTarget(input, sock) {
    const value = String(input || "").trim()
    const direct = normalizeJid(value)
    if (isGroupJid(direct)) {
        let subject = direct
        try {
            const metadata = await sock?.groupMetadata?.(direct)
            subject = String(metadata?.subject || metadata?.name || direct)
        } catch {}
        return { ok: true, jid: direct, subject, code: "" }
    }

    const code = value.toUpperCase()
    if (/^G\d{3,4}$/.test(code)) {
        const map = await buildGroupCodeMap(sock)
        const found = map.get(code)
        if (found) return { ok: true, ...found }
    }

    return { ok: false, reason: "not_found" }
}

function updateGroup(groupJid, mutator, updatedBy = "owner") {
    const jid = normalizeJid(groupJid)
    if (!isGroupJid(jid)) return null
    const state = loadState()
    const current = state.groups[jid] && typeof state.groups[jid] === "object" ? state.groups[jid] : {}
    const next = mutator({ ...current }) || current
    state.groups[jid] = {
        ...next,
        updatedAt: new Date().toISOString(),
        updatedBy: String(updatedBy || "owner"),
    }
    saveState(state)
    return getEffectiveGroupConfig(jid)
}

function setBotEnabled(groupJid, enabled, updatedBy) {
    return updateGroup(groupJid, current => ({
        ...current,
        enabled: Boolean(enabled),
        botEnabled: Boolean(enabled),
        bot: Boolean(enabled),
    }), updatedBy)
}

function setFeature(groupJid, featureName, enabled, updatedBy) {
    const feature = canonicalFeatureName(featureName)
    if (!feature) return null
    return updateGroup(groupJid, current => ({
        ...current,
        features: {
            ...(current.features && typeof current.features === "object" ? current.features : {}),
            [feature]: Boolean(enabled),
        },
    }), updatedBy)
}

function resetGroup(groupJid) {
    const jid = normalizeJid(groupJid)
    const state = loadState()
    if (!Object.prototype.hasOwnProperty.call(state.groups, jid)) return false
    delete state.groups[jid]
    saveState(state)
    return true
}

function formatEffectiveStatus(resolved, config) {
    const botEnabled = config.botEnabled !== false
    const featureStatus = feature => botEnabled && config.features[feature] !== false
    const antiToxic = featureStatus("antiToxic")
    const editGuardian = antiToxic && featureStatus("editGuardian")
    return [
        "🎛️ *GROUP CONTROL*",
        "",
        `Group: ${resolved.subject || resolved.jid}`,
        `ID: ${resolved.jid}`,
        resolved.code ? `Kode: ${resolved.code}` : "",
        `Bot: ${botEnabled ? "ON" : "OFF"}`,
        `Group Mode: ${botEnabled ? "COMMANDS & FEATURES" : "DISABLED"}`,
        `Anti Kasar: ${antiToxic ? "ON" : "OFF"}`,
        `Edited Message Guardian: ${editGuardian ? "ON" : "OFF"}`,
        `Downloader Commands: ${featureStatus("downloader") ? "ON" : "OFF"}`,
        `Sticker Safety: ${featureStatus("stickerSafety") ? "ON" : "OFF"}`,
        `Sticker Text: ${featureStatus("stickerText") ? "ON" : "OFF"}`,
        `Sticker NSFW: ${featureStatus("stickerNsfw") ? "ON" : "OFF"}`,
        `Broadcast: ${featureStatus("broadcast") ? "ON" : "OFF"}`,
        "Detect Link Otomatis: PRIVATE ONLY",
        "Auto Reply: PRIVATE ONLY",
        "Group Auto Reply: OFF",
        config.note ? `Catatan: ${config.note}` : "",
    ].filter(Boolean).join("\n")
}

function commandHelp() {
    return [
        "🎛️ *GROUP REMOTE CONTROL*",
        "",
        ".grouplist",
        ".groupctl status <G001|group_jid>",
        ".groupctl on <G001|group_jid>",
        ".groupctl off <G001|group_jid>",
        ".groupctl reset <G001|group_jid>",
        ".groupctl feature <G001|group_jid> antikasar on/off",
        ".groupctl feature <G001|group_jid> editguard on/off",
        ".groupctl feature <G001|group_jid> privatewarn on/off",
        ".groupctl feature <G001|group_jid> downloader on/off",
        ".groupctl feature <G001|group_jid> stickersafety on/off",
        ".groupctl feature <G001|group_jid> stickertext on/off",
        ".groupctl feature <G001|group_jid> stickernsfw on/off",
        ".groupctl note <G001|group_jid> <catatan>",
        "",
        "Saat Bot group ON, command dan fitur group tetap berjalan sesuai permission/config.",
        "Hanya Detect Link otomatis dan Auto Reply yang private-only.",
    ].join("\n")
}

async function handleGroupRemoteControlCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    const lower = text.toLowerCase()
    if (lower !== ".grouplist" && lower !== ".groupctl" && !lower.startsWith(".groupctl ")) return false

    const remoteJid = String(context.from || msg?.key?.remoteJid || "")
    const isGroup = context.isGroup === true || isGroupJid(remoteJid)
    if (isGroup) return true
    if (!(context.canControlOwner || context.isOwner)) {
        await sock.sendMessage(remoteJid, { text: "Akses Ditolak" })
        return true
    }

    if (lower === ".grouplist") {
        const map = await buildGroupCodeMap(sock, true)
        const lines = ["📋 *DAFTAR GROUP*", ""]
        if (!map.size) lines.push("Tidak ada group yang dapat dibaca.")
        for (const [code, item] of map) {
            const config = getEffectiveGroupConfig(item.jid)
            lines.push(`${code} — ${item.subject}`)
            lines.push(`ID: ${item.jid}`)
            lines.push(`Status: ${config.botEnabled ? "aktif" : "custom / OFF"}`)
            lines.push(`Mode: ${config.botEnabled ? "Commands & Features" : "Disabled"}`)
            lines.push("")
        }
        await sock.sendMessage(remoteJid, { text: lines.join("\n").trim() })
        return true
    }

    const parts = text.split(/\s+/)
    const action = String(parts[1] || "help").toLowerCase()
    if (action === "help" || action === "") {
        await sock.sendMessage(remoteJid, { text: commandHelp() })
        return true
    }

    if (action === "listcustom") {
        const entries = Object.entries(loadState().groups)
        const lines = ["🧩 *CUSTOM GROUP CONFIG*", ""]
        if (!entries.length) lines.push("Belum ada custom config.")
        for (const [jid] of entries) {
            const config = getEffectiveGroupConfig(jid)
            lines.push(`${jid} — Bot ${config.botEnabled ? "ON" : "OFF"}, Anti Kasar ${config.features.antiToxic !== false ? "ON" : "OFF"}`)
        }
        await sock.sendMessage(remoteJid, { text: lines.join("\n") })
        return true
    }

    const targetInput = parts[2]
    const resolved = await resolveGroupTarget(targetInput, sock)
    if (!resolved.ok) {
        await sock.sendMessage(remoteJid, { text: "❌ ID/kode grup tidak valid. Gunakan .grouplist untuk melihat daftar grup." })
        return true
    }

    const actor = context.senderJid || context.sender || remoteJid
    if (action === "status") {
        await sock.sendMessage(remoteJid, { text: formatEffectiveStatus(resolved, getEffectiveGroupConfig(resolved.jid)) })
        return true
    }

    if (action === "on" || action === "off") {
        const config = setBotEnabled(resolved.jid, action === "on", actor)
        await sock.sendMessage(remoteJid, { text: formatEffectiveStatus(resolved, config) })
        return true
    }

    if (action === "reset") {
        resetGroup(resolved.jid)
        await sock.sendMessage(remoteJid, { text: `✅ Config ${resolved.subject || resolved.jid} dikembalikan ke default.` })
        return true
    }

    if (action === "note") {
        const note = parts.slice(3).join(" ").trim()
        updateGroup(resolved.jid, current => ({ ...current, note }), actor)
        await sock.sendMessage(remoteJid, { text: `✅ Catatan group diperbarui: ${note || "(dihapus)"}` })
        return true
    }

    if (action === "feature") {
        const rawFeature = String(parts[3] || "")
        const requested = String(parts[4] || "").toLowerCase()
        const feature = canonicalFeatureName(rawFeature)
        if (!feature || !/^(on|off)$/.test(requested)) {
            await sock.sendMessage(remoteJid, { text: "Format: .groupctl feature <group> <fitur> on/off" })
            return true
        }

        if (feature === "autoReply") {
            await sock.sendMessage(remoteJid, { text: "Auto Reply sekarang private-only dan tidak dapat diaktifkan untuk group." })
            return true
        }
        if (feature === "antiLink") {
            await sock.sendMessage(remoteJid, { text: "Detect Link otomatis private-only dan tidak dapat diaktifkan untuk group." })
            return true
        }
        if (!new Set(["antiToxic", "editGuardian", "privateWarn", "broadcast", "downloader", "stickerSafety", "stickerText", "stickerNsfw", "warning"]).has(feature)) {
            await sock.sendMessage(remoteJid, { text: "Fitur group tidak dikenali." })
            return true
        }

        const config = setFeature(resolved.jid, feature, requested === "on", actor)
        await sock.sendMessage(remoteJid, { text: formatEffectiveStatus(resolved, config) })
        return true
    }

    await sock.sendMessage(remoteJid, { text: commandHelp() })
    return true
}

module.exports = {
    DATA_FILE,
    DEFAULT_FEATURES,
    canonicalFeatureName,
    getEffectiveGroupConfig,
    getInboundGroupPolicySummary,
    getRawGroupConfig,
    handleGroupRemoteControlCommand,
    isGroupAntiToxicPrivateReplyEnabled,
    isGroupBotEnabled,
    isGroupFeatureEnabled,
    isInboundGroupFeatureAllowed,
    loadState,
    resolveGroupTarget,
    saveState,
    setBotEnabled,
    setFeature,
}
