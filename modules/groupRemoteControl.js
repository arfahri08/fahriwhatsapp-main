"use strict"

const fs = require("fs")
const path = require("path")
const groupRuntimePolicy = require("./groupRuntimePolicy")

const DATA_FILE = process.env.GROUP_REMOTE_CONTROL_DATA_FILE
    ? path.resolve(process.env.GROUP_REMOTE_CONTROL_DATA_FILE)
    : path.join(__dirname, "..", "data", "groupRemoteControl.json")
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
    welcome: "welcome",
    groupwelcome: "welcome",
    menugrup: "groupMenu",
    groupmenu: "groupMenu",
    interactivemenu: "groupMenu",
    goodbye: "goodbye",
    groupgoodbye: "goodbye",
    kicksticker: "kickSticker",
    stickerkick: "kickSticker",
    grouputilities: "groupUtilities",
    grouputility: "groupUtilities",
    utilitygroup: "groupUtilities",
    groupschedule: "groupSchedule",
    jadwalgroup: "groupSchedule",
    groupmoderation: "groupModeration",
    moderation: "groupModeration",
    groupattendance: "groupAttendance",
    absensi: "groupAttendance",
    slowmode: "slowmode",
    antispam: "antiSpam",
    flood: "antiSpam",
    store: "store",
    shop: "store",
    nsfw: "nsfwModeration",
    nsfwmoderation: "nsfwModeration",
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
    welcome: true,
    goodbye: true,
    groupMenu: true,
    kickSticker: true,
    warning: true,
    groupUtilities: true,
    groupSchedule: true,
    groupModeration: true,
    groupAttendance: true,
    slowmode: true,
    antiSpam: true,
    store: true,
    nsfwModeration: true,
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

function getEffectiveGroupConfig(groupJid, runtime = {}) {
    const jid = normalizeJid(groupJid)
    const stored = getRawGroupConfig(jid)
    const raw = stored || {}
    const explicitBotEnabled = readBoolean(raw.botEnabled, readBoolean(raw.enabled, readBoolean(raw.bot, null)))
    // Fail closed: grup yang belum pernah diaktifkan owner selalu OFF.
    const configuredBotEnabled = explicitBotEnabled === true
    const rawFeatures = raw.features && typeof raw.features === "object" ? raw.features : {}
    const features = { ...DEFAULT_FEATURES, ...rawFeatures }

    for (const key of Object.keys(DEFAULT_FEATURES)) {
        if (raw[key] === true || raw[key] === false) features[key] = raw[key]
    }

    const botAdmin = typeof runtime.botAdmin === "boolean" ? runtime.botAdmin : null
    const metadataAvailable = typeof runtime.metadataAvailable === "boolean"
        ? runtime.metadataAvailable
        : botAdmin !== null
    const effectiveBotEnabled = configuredBotEnabled
    const effectiveManagementEnabled = Boolean(configuredBotEnabled && metadataAvailable && botAdmin)
    const effectiveFeatures = Object.fromEntries(Object.keys(DEFAULT_FEATURES).map(feature => [
        feature,
        Boolean(
            effectiveBotEnabled
            && features[feature] !== false
            && (
                !groupRuntimePolicy.isAdminRequiredFeature(feature)
                || effectiveManagementEnabled
            )
        ),
    ]))

    return {
        jid,
        exists: Boolean(stored),
        botConfig: explicitBotEnabled === null ? "DEFAULT" : (explicitBotEnabled ? "ON" : "OFF"),
        explicitBotEnabled,
        configuredBotEnabled,
        botEnabled: configuredBotEnabled,
        enabled: configuredBotEnabled,
        bot: configuredBotEnabled,
        botAdmin,
        metadataAvailable,
        effectiveBotEnabled,
        effectiveManagementEnabled,
        effectiveFeatures,
        note: String(raw.note || ""),
        updatedAt: raw.updatedAt || null,
        updatedBy: raw.updatedBy || null,
        features,
        raw,
    }
}

function isGroupBotEnabled(groupJid, runtime = {}) {
    if (!isGroupJid(groupJid)) return true
    if (typeof runtime.effectiveBotEnabled === "boolean") return runtime.effectiveBotEnabled
    return getEffectiveGroupConfig(groupJid).configuredBotEnabled === true
}

function isInboundGroupFeatureAllowed(featureName) {
    const feature = canonicalFeatureName(featureName)
    return !PRIVATE_ONLY_FEATURES.has(feature)
}

function isGroupFeatureEnabled(groupJid, featureName, runtime = {}) {
    if (!isGroupJid(groupJid)) return true
    if (!isGroupBotEnabled(groupJid, runtime)) return false
    const feature = canonicalFeatureName(featureName)
    if (PRIVATE_ONLY_FEATURES.has(feature)) return false

    const effective = getEffectiveGroupConfig(groupJid, runtime)
    if (Object.prototype.hasOwnProperty.call(DEFAULT_FEATURES, feature)) {
        if (effective.features[feature] === false) return false
        if (groupRuntimePolicy.isAdminRequiredFeature(feature)) {
            return effective.effectiveManagementEnabled === true
        }
        return true
    }

    return false
}

function isGroupAntiToxicPrivateReplyEnabled(groupJid) {
    return isGroupBotEnabled(groupJid) && getEffectiveGroupConfig(groupJid).features.privateWarn === true
}

function getInboundGroupPolicySummary() {
    return {
        mode: "DEFAULT OFF; ORDINARY FEATURES AFTER .BOT ON; MANAGEMENT ADMIN-GATED",
        groupBotDefault: "OFF",
        hardAdminGate: true,
        managementAdminGate: true,
        groupAntiToxic: true,
        groupDetectLink: false,
        privateDetectLink: true,
        groupDownloader: true,
        groupAutoReply: false,
        groupStickerSafety: true,
        allowedInboundFeatures: Object.keys(DEFAULT_FEATURES).filter(feature => !PRIVATE_ONLY_FEATURES.has(feature)),
        adminRequiredFeatures: [...groupRuntimePolicy.ADMIN_REQUIRED_FEATURES],
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

function formatEffectiveStatus(resolved, policy) {
    const config = policy?.config || policy || getEffectiveGroupConfig(resolved.jid)
    const effectiveBotEnabled = policy?.effectiveBotEnabled === true
    const managementAllowed = policy?.managementAllowed === true
    const featureStatus = feature => Boolean(
        effectiveBotEnabled
        && config.features[feature] !== false
        && (!groupRuntimePolicy.isAdminRequiredFeature(feature) || managementAllowed)
    )
    const antiToxic = featureStatus("antiToxic")
    const editGuardian = antiToxic && featureStatus("editGuardian")
    return [
        "🎛️ *GROUP CONTROL*",
        "",
        `Group: ${resolved.subject || resolved.jid}`,
        `ID: ${resolved.jid}`,
        resolved.code ? `Kode: ${resolved.code}` : "",
        `Bot Admin: ${policy?.metadataAvailable ? (policy.botAdmin ? "YA" : "TIDAK") : "TIDAK DIKETAHUI"}`,
        `Group Bot Config: ${config.botConfig === "DEFAULT" ? "DEFAULT (OFF)" : (config.botConfig || "DEFAULT (OFF)")}`,
        `Effective Group Bot: ${effectiveBotEnabled ? "ON" : "OFF"}`,
        `Bot Management Access: ${managementAllowed ? "ON (BOT ADMIN)" : "OFF"}`,
        `Reason: ${effectiveBotEnabled ? (managementAllowed ? "OWNER ENABLED + BOT ADMIN" : "OWNER ENABLED; MANAGEMENT ADMIN-GATED") : String(policy?.reason || "runtime-policy-unavailable").toUpperCase()}`,
        `Group Mode: ${effectiveBotEnabled ? (managementAllowed ? "ORDINARY + MANAGEMENT FEATURES" : "ORDINARY FEATURES ONLY") : "SILENT"}`,
        `Anti Kasar: ${antiToxic ? "ON" : "OFF"}`,
        `Edited Message Guardian: ${editGuardian ? "ON" : "OFF"}`,
        `Downloader Commands: ${featureStatus("downloader") ? "ON" : "OFF"}`,
        `Sticker Safety: ${featureStatus("stickerSafety") ? "ON" : "OFF"}`,
        `Sticker Text: ${featureStatus("stickerText") ? "ON" : "OFF"}`,
        `Sticker NSFW: ${featureStatus("stickerNsfw") ? "ON" : "OFF"}`,
        `Welcome Admin-only: ${featureStatus("welcome") ? "ON" : "OFF"}`,
        `Goodbye Message: ${featureStatus("goodbye") ? "ON" : "OFF"}`,
        `Menu Interaktif: ${featureStatus("groupMenu") ? "ON" : "OFF"}`,
        `Kick Sticker: ${featureStatus("kickSticker") ? "ON" : "OFF"}`,
        `Broadcast: ${featureStatus("broadcast") ? "ON" : "OFF"}`,
        `Group Utilities: ${featureStatus("groupUtilities") ? "ON" : "OFF"}`,
        `Group Schedule: ${featureStatus("groupSchedule") ? "ON" : "OFF"}`,
        `Group Moderation: ${featureStatus("groupModeration") ? "ON" : "OFF"}`,
        `Group Attendance: ${featureStatus("groupAttendance") ? "ON" : "OFF"}`,
        `Slowmode Feature: ${featureStatus("slowmode") ? "ON" : "OFF"}`,
        `Anti-Spam Feature: ${featureStatus("antiSpam") ? "ON" : "OFF"}`,
        `Store: ${featureStatus("store") ? "ON" : "OFF"}`,
        `NSFW Image Moderation: ${featureStatus("nsfwModeration") ? "ON" : "OFF"}`,
        "Detect Link Otomatis: PRIVATE ONLY",
        "Auto Reply: PRIVATE ONLY",
        "Group Auto Reply: OFF",
        config.note ? `Catatan: ${config.note}` : "",
    ].filter(Boolean).join("\n")
}

function isInGroupBotControlCommand(text) {
    return /^\.bot(?:\s|$)/i.test(String(text || "").trim())
}

async function handleInGroupBotControlCommand(sock, msg, context = {}) {
    const groupJid = normalizeJid(context.from || msg?.key?.remoteJid)
    const text = String(context.text || "").trim()
    if (!isGroupJid(groupJid) || !isInGroupBotControlCommand(text)) return false

    // Command ini sengaja tersedia sebelum gate Group Bot agar grup default-OFF
    // tetap dapat diaktifkan. Selain owner, command dikonsumsi tanpa balasan.
    if (!(context.canControlOwner || context.isOwner || msg?.key?.fromMe)) return true

    const requestedAction = String(text.replace(/^\.bot\b/i, "").trim() || "status").toLowerCase()
    const action = /^(on|off|status)$/.test(requestedAction) ? requestedAction : "help"
    const actor = context.senderJid || context.sender || msg?.key?.participant || "owner"
    if (action === "on") setBotEnabled(groupJid, true, actor)
    if (action === "off") setBotEnabled(groupJid, false, actor)

    if (action === "help") {
        await sock.sendMessage(groupJid, {
            text: "Di grup, gunakan .bot on, .bot off, atau .bot status. Pengaturan Custom Auto Reply tetap khusus private chat owner.",
        }, {
            quoted: msg,
            __allowGroupControlOutput: true,
        })
        return true
    }

    const policy = await resolveGroupRuntimePolicy(sock, groupJid)
    const config = policy.config || getEffectiveGroupConfig(groupJid)
    const botOn = policy.effectiveBotEnabled === true
    const managementOn = policy.managementAllowed === true
    const lines = [
        "BOT GRUP",
        "",
        `Status: ${botOn ? "ON" : "OFF"}`,
        `Config: ${config.botConfig === "DEFAULT" ? "DEFAULT (OFF)" : config.botConfig}`,
        `Bot admin: ${policy.metadataAvailable ? (policy.botAdmin ? "YA" : "TIDAK") : "TIDAK DIKETAHUI"}`,
        `Fitur biasa: ${botOn ? "ON" : "OFF"}`,
        `Fitur pengelolaan grup: ${managementOn ? "ON" : "OFF"}`,
        `Welcome & goodbye: ${managementOn && config.features.welcome !== false && config.features.goodbye !== false ? "ON" : "OFF"}`,
    ]
    if (botOn && !managementOn) {
        lines.push("Catatan: bot bukan admin atau metadata admin belum valid; hanya fitur biasa yang dijalankan.")
    } else if (managementOn) {
        lines.push("Bot terverifikasi sebagai admin; fitur pengelolaan yang dikonfigurasi ON dapat berjalan.")
    } else {
        lines.push("Ketik .bot on di grup ini untuk mengaktifkan bot.")
    }

    await sock.sendMessage(groupJid, { text: lines.join("\n") }, {
        quoted: msg,
        __allowGroupControlOutput: true,
    })
    return true
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
        ".groupctl feature <G001|group_jid> welcome on/off",
        ".groupctl feature <G001|group_jid> goodbye on/off",
        ".groupctl feature <G001|group_jid> groupmenu on/off",
        ".groupctl feature <G001|group_jid> kicksticker on/off",
        ".groupctl feature <G001|group_jid> grouputilities on/off",
        ".groupctl feature <G001|group_jid> groupschedule on/off",
        ".groupctl feature <G001|group_jid> groupmoderation on/off",
        ".groupctl feature <G001|group_jid> groupattendance on/off",
        ".groupctl feature <G001|group_jid> slowmode on/off",
        ".groupctl feature <G001|group_jid> antispam on/off",
        ".groupctl feature <G001|group_jid> store on/off",
        ".groupctl feature <G001|group_jid> nsfw on/off",
        ".groupctl note <G001|group_jid> <catatan>",
        "",
        "Grup baru default OFF. Aktifkan dari dalam grup dengan .bot on atau lewat .groupctl on.",
        "Saat Bot group ON, fitur biasa berjalan; fitur pengelolaan tetap memerlukan bot admin.",
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
            lines.push(`Config: ${config.botConfig}`)
            lines.push("Effective: gunakan .groupctl status untuk cek admin runtime")
            lines.push("")
        }
        await sock.sendMessage(remoteJid, { text: lines.join("\n").trim() })
        if (map.size) {
            await sock.sendMessage(remoteJid, {
                text: "📎 *ID SIAP DISALIN*\nSetiap pesan di bawah berisi kode + nama grup + ID. Tekan lama pesan grup yang dipilih lalu pilih *Salin*.",
            })
            for (const [code, item] of map) {
                await sock.sendMessage(remoteJid, {
                    text: `${code} — ${item.subject}\nID: ${item.jid}`,
                })
            }
        }
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
            lines.push(`${jid} — Config ${config.botConfig}, Anti Kasar ${config.features.antiToxic !== false ? "ON" : "OFF"}`)
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
        const policy = await resolveGroupRuntimePolicy(sock, resolved.jid)
        await sock.sendMessage(remoteJid, { text: formatEffectiveStatus(resolved, policy) })
        return true
    }

    if (action === "on" || action === "off") {
        setBotEnabled(resolved.jid, action === "on", actor)
        const policy = await resolveGroupRuntimePolicy(sock, resolved.jid)
        await sock.sendMessage(remoteJid, { text: formatEffectiveStatus(resolved, policy) })
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
        if (!new Set(["antiToxic", "editGuardian", "privateWarn", "broadcast", "downloader", "stickerSafety", "stickerText", "stickerNsfw", "welcome", "goodbye", "groupMenu", "kickSticker", "warning", "groupUtilities", "groupSchedule", "groupModeration", "groupAttendance", "slowmode", "antiSpam", "store", "nsfwModeration"]).has(feature)) {
            await sock.sendMessage(remoteJid, { text: "Fitur group tidak dikenali." })
            return true
        }

        setFeature(resolved.jid, feature, requested === "on", actor)
        const policy = await resolveGroupRuntimePolicy(sock, resolved.jid)
        await sock.sendMessage(remoteJid, { text: formatEffectiveStatus(resolved, policy) })
        return true
    }

    await sock.sendMessage(remoteJid, { text: commandHelp() })
    return true
}

async function resolveGroupRuntimePolicy(sock, groupJid, options = {}) {
    return groupRuntimePolicy.resolveGroupRuntimePolicy(sock, groupJid, {
        ...options,
        groupRemoteControl: module.exports,
    })
}

module.exports = {
    DATA_FILE,
    DEFAULT_FEATURES,
    canonicalFeatureName,
    getEffectiveGroupConfig,
    getInboundGroupPolicySummary,
    getRawGroupConfig,
    handleInGroupBotControlCommand,
    handleGroupRemoteControlCommand,
    isInGroupBotControlCommand,
    isGroupAntiToxicPrivateReplyEnabled,
    isGroupBotEnabled,
    isGroupFeatureEnabled,
    isInboundGroupFeatureAllowed,
    loadState,
    resolveGroupTarget,
    resolveGroupRuntimePolicy,
    saveState,
    setBotEnabled,
    setFeature,
}
