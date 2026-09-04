"use strict"

const common = require("./groupUtilityCommon")
const defaultStore = require("./groupUtilityStore")

const SLOWMODE_FEATURE = "slowmode"
const ANTISPAM_FEATURE = "antiSpam"
const COMMAND_PATTERN = /^(?:\.slowmode|\.antispam)(?:\s|$)/i
const SLOWMODE_MIN_SECONDS = 5
const SLOWMODE_MAX_SECONDS = 600
const ANTISPAM_DELAY_MIN = 500
const ANTISPAM_DELAY_MAX = 10_000
const ANTISPAM_THRESHOLD_MIN = 3
const ANTISPAM_THRESHOLD_MAX = 20
const TRACKER_TTL_MS = 30 * 60 * 1000
const TRACKER_MAX = 5000
const NOTICE_COOLDOWN_MS = 45_000

const slowmodeTracker = new Map()
const slowmodeNotices = new Map()
const antiSpamTracker = new Map()
const antiSpamNotices = new Map()
const handledActionEvents = new Map()

function isFloodCommand(text) {
    return COMMAND_PATTERN.test(String(text || "").trim())
}

function normalizeSlowmode(value = {}) {
    const seconds = Number(value.seconds)
    return {
        ...value,
        enabled: value.enabled === true,
        mode: String(value.mode || "ALL").toUpperCase() === "ONLYCOMMAND" ? "ONLYCOMMAND" : "ALL",
        seconds: Number.isInteger(seconds) && seconds >= SLOWMODE_MIN_SECONDS && seconds <= SLOWMODE_MAX_SECONDS ? seconds : 30,
    }
}

function normalizeAntiSpam(value = {}) {
    const delayMs = Number(value.delayMs)
    const threshold = Number(value.threshold)
    const action = String(value.action || "warn").toLowerCase()
    return {
        ...value,
        enabled: value.enabled === true,
        delayMs: Number.isInteger(delayMs) && delayMs >= ANTISPAM_DELAY_MIN && delayMs <= ANTISPAM_DELAY_MAX ? delayMs : 2000,
        threshold: Number.isInteger(threshold) && threshold >= ANTISPAM_THRESHOLD_MIN && threshold <= ANTISPAM_THRESHOLD_MAX ? threshold : 5,
        action: ["warn", "delete", "kick"].includes(action) ? action : "warn",
    }
}

function updateConfig(store, groupJid, key, normalizer, mutator) {
    return store.updateGroup(groupJid, group => {
        const current = normalizer(group[key])
        const next = mutator(current) || current
        return { ...group, [key]: next }
    })
}

function pruneMap(map, now = Date.now()) {
    for (const [key, value] of map) {
        const at = Number(value?.at || value?.lastAllowedAt || value?.lastSeenAt || value || 0)
        if (!at || now - at > TRACKER_TTL_MS) map.delete(key)
    }
    while (map.size > TRACKER_MAX) {
        const oldest = map.keys().next().value
        if (!oldest) break
        map.delete(oldest)
    }
}

function cleanupRuntimeTrackers(now = Date.now()) {
    for (const map of [slowmodeTracker, slowmodeNotices, antiSpamTracker, antiSpamNotices, handledActionEvents]) pruneMap(map, now)
    return {
        slowmode: slowmodeTracker.size,
        antiSpam: antiSpamTracker.size,
        actions: handledActionEvents.size,
    }
}

function resetRuntimeTrackers() {
    for (const map of [slowmodeTracker, slowmodeNotices, antiSpamTracker, antiSpamNotices, handledActionEvents]) map.clear()
}

function messageEventKey(msg) {
    const id = String(msg?.key?.id || "").trim()
    return id ? `${String(msg?.key?.remoteJid || "").toLowerCase()}:${id}` : ""
}

function isEligibleIncomingMessage(msg, context = {}) {
    const jid = String(context.from || msg?.key?.remoteJid || "").toLowerCase()
    if (!jid.endsWith("@g.us") || msg?.key?.fromMe) return false
    if (jid === "status@broadcast" || jid.endsWith("@broadcast")) return false
    if (typeof context.isBotGeneratedMessage === "function" && context.isBotGeneratedMessage(msg)) return false
    const message = common.unwrapMessage(msg?.message || {})
    const ignored = [
        "protocolMessage",
        "reactionMessage",
        "pollUpdateMessage",
        "senderKeyDistributionMessage",
        "secretEncryptedMessage",
        "editedMessage",
    ]
    if (ignored.some(type => message[type])) return false
    return Object.keys(message).some(type => type !== "messageContextInfo")
}

function resolveSender(policy, msg, context = {}) {
    const senderCandidates = common.getSenderCandidates(msg, context.senderJid || context.sender)
    const participant = common.findParticipant(policy.metadata, senderCandidates, context)
    const key = participant
        ? common.participantIdentityKey(participant, context, senderCandidates)
        : common.identityKey(senderCandidates, context)
    return { participant, key, senderCandidates }
}

function isExempt(policy, msg, context = {}, sender = null) {
    if (context.canControlOwner || context.isOwner) return true
    const resolved = sender || resolveSender(policy, msg, context)
    return common.isSenderAdmin(policy.metadata, msg, context.senderJid || context.sender, context)
        || common.isProtectedParticipant(resolved.participant, context.sock, context)
}

function shouldNotify(map, key, now) {
    const previous = Number(map.get(key)?.at || 0)
    if (previous && now - previous < NOTICE_COOLDOWN_MS) return false
    map.set(key, { at: now })
    return true
}

async function handleSlowmodeCommand(sock, msg, access, argument, context, store) {
    const parts = String(argument || "status").trim().toLowerCase().split(/\s+/).filter(Boolean)
    const action = parts[0] || "status"
    const current = normalizeSlowmode(store.getGroup(access.groupJid)?.slowmode)
    if (action === "status") {
        await sock.sendMessage(access.groupJid, {
            text: `Slowmode: ${current.enabled ? "ON" : "OFF"}\nMode: ${current.mode}\nCooldown: ${current.seconds} detik`,
        }, { quoted: msg })
        return true
    }
    if (action === "off") {
        updateConfig(store, access.groupJid, "slowmode", normalizeSlowmode, config => ({ ...config, enabled: false }))
        await sock.sendMessage(access.groupJid, { text: "Slowmode: OFF." }, { quoted: msg })
        return true
    }
    if (!["on", "onlycommand"].includes(action)) {
        await sock.sendMessage(access.groupJid, { text: "Format: .slowmode status | on <detik> | onlycommand <detik> | off" }, { quoted: msg })
        return true
    }
    const seconds = Number(parts[1] || 30)
    if (!Number.isInteger(seconds) || seconds < SLOWMODE_MIN_SECONDS || seconds > SLOWMODE_MAX_SECONDS) {
        await sock.sendMessage(access.groupJid, { text: `Cooldown harus ${SLOWMODE_MIN_SECONDS}-${SLOWMODE_MAX_SECONDS} detik. Preset: 10/30/60/120.` }, { quoted: msg })
        return true
    }
    const mode = action === "onlycommand" ? "ONLYCOMMAND" : "ALL"
    updateConfig(store, access.groupJid, "slowmode", normalizeSlowmode, config => ({ ...config, enabled: true, mode, seconds }))
    await sock.sendMessage(access.groupJid, { text: `Slowmode ON (${mode}, ${seconds} detik).` }, { quoted: msg })
    return true
}

async function handleAntiSpamCommand(sock, msg, access, argument, context, store) {
    const parts = String(argument || "status").trim().toLowerCase().split(/\s+/).filter(Boolean)
    const action = parts[0] || "status"
    const current = normalizeAntiSpam(store.getGroup(access.groupJid)?.antiSpam)
    if (action === "status") {
        await sock.sendMessage(access.groupJid, {
            text: `Anti-spam flood: ${current.enabled ? "ON" : "OFF"}\nDelay: ${current.delayMs} ms\nThreshold: ${current.threshold}\nAction: ${current.action.toUpperCase()}`,
        }, { quoted: msg })
        return true
    }
    if (/^(on|off)$/.test(action)) {
        updateConfig(store, access.groupJid, "antiSpam", normalizeAntiSpam, config => ({ ...config, enabled: action === "on" }))
        await sock.sendMessage(access.groupJid, { text: `Anti-spam flood: ${action.toUpperCase()}.` }, { quoted: msg })
        return true
    }
    if (action === "delay") {
        const delayMs = Number(parts[1])
        if (!Number.isInteger(delayMs) || delayMs < ANTISPAM_DELAY_MIN || delayMs > ANTISPAM_DELAY_MAX) {
            await sock.sendMessage(access.groupJid, { text: `Delay harus ${ANTISPAM_DELAY_MIN}-${ANTISPAM_DELAY_MAX} ms.` }, { quoted: msg })
            return true
        }
        updateConfig(store, access.groupJid, "antiSpam", normalizeAntiSpam, config => ({ ...config, delayMs }))
        await sock.sendMessage(access.groupJid, { text: `Delay anti-spam: ${delayMs} ms.` }, { quoted: msg })
        return true
    }
    if (action === "threshold") {
        const threshold = Number(parts[1])
        if (!Number.isInteger(threshold) || threshold < ANTISPAM_THRESHOLD_MIN || threshold > ANTISPAM_THRESHOLD_MAX) {
            await sock.sendMessage(access.groupJid, { text: `Threshold harus ${ANTISPAM_THRESHOLD_MIN}-${ANTISPAM_THRESHOLD_MAX}.` }, { quoted: msg })
            return true
        }
        updateConfig(store, access.groupJid, "antiSpam", normalizeAntiSpam, config => ({ ...config, threshold }))
        await sock.sendMessage(access.groupJid, { text: `Threshold anti-spam: ${threshold}.` }, { quoted: msg })
        return true
    }
    if (action === "action" && ["warn", "delete", "kick"].includes(parts[1])) {
        updateConfig(store, access.groupJid, "antiSpam", normalizeAntiSpam, config => ({ ...config, action: parts[1] }))
        await sock.sendMessage(access.groupJid, { text: `Aksi anti-spam: ${parts[1].toUpperCase()}.` }, { quoted: msg })
        return true
    }
    await sock.sendMessage(access.groupJid, {
        text: "Format: .antispam status/on/off/delay <ms>/threshold <jumlah>/action warn|delete|kick",
    }, { quoted: msg })
    return true
}

async function handleGroupFloodCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    if (!isFloodCommand(text)) return false
    const command = text.split(/\s+/)[0].toLowerCase()
    const argument = text.slice(command.length).trim()
    const feature = command === ".slowmode" ? SLOWMODE_FEATURE : ANTISPAM_FEATURE
    const access = await common.resolveCommandAccess(sock, msg, feature, context)
    if (access.hardDenied) return true
    if (!access.allowed) {
        await sock.sendMessage(access.groupJid, { text: "Pengaturan ini hanya untuk admin grup atau owner bot." }, { quoted: msg })
        return true
    }
    const store = context.store || defaultStore
    if (command === ".slowmode") return handleSlowmodeCommand(sock, msg, access, argument, context, store)
    return handleAntiSpamCommand(sock, msg, access, argument, context, store)
}

async function freshFeaturePolicy(sock, groupJid, feature, context = {}) {
    return common.resolveFeaturePolicy(sock, groupJid, feature, context, {
        getGroupMetadata: async jid => {
            if (typeof sock?.__resolveGroupMetadataForRuntimePolicy === "function") {
                return sock.__resolveGroupMetadataForRuntimePolicy(jid, { forceRefresh: true })
            }
            return sock?.groupMetadata?.(jid)
        },
    })
}

async function applyAntiSpamAction(sock, msg, policy, sender, config, context, now) {
    const eventId = messageEventKey(msg)
    if (eventId && handledActionEvents.has(eventId)) return { blocked: true, action: "duplicate" }
    if (eventId) handledActionEvents.set(eventId, { at: now })
    const trackerKey = `${policy.groupJid}:${sender.key}`

    if (config.action === "warn") {
        if (shouldNotify(antiSpamNotices, trackerKey, now)) {
            const jid = common.getPreferredJid(sender.participant, context)
            await sock.sendMessage(policy.groupJid, {
                text: `${jid ? `@${jid.split("@")[0]} ` : ""}terdeteksi mengirim pesan terlalu cepat.`,
                mentions: jid ? [jid] : [],
            }, { quoted: msg })
        }
        return { blocked: true, action: "warn" }
    }

    if (config.action === "delete") {
        await sock.sendMessage(policy.groupJid, { delete: msg.key })
        return { blocked: true, action: "delete" }
    }

    const currentPolicy = await freshFeaturePolicy(sock, policy.groupJid, ANTISPAM_FEATURE, context)
    const currentParticipant = common.findParticipant(currentPolicy.metadata, sender.senderCandidates, context)
    if (currentPolicy.allowed && currentParticipant && !common.isProtectedParticipant(currentParticipant, sock, context)) {
        const jid = common.getPreferredJid(currentParticipant, context, { forMutation: true })
        try {
            await sock.groupParticipantsUpdate(policy.groupJid, [jid], "remove")
            return { blocked: true, action: "kick" }
        } catch (error) {
            console.log(`[GROUP ANTISPAM] Kick gagal ${policy.groupJid}: ${String(error?.message || error).slice(0, 180)}`)
        }
    }
    return { blocked: true, action: "kick-skipped" }
}

async function evaluateAntiSpam(sock, msg, context = {}, now = Date.now()) {
    const groupJid = String(context.from || msg?.key?.remoteJid || "").toLowerCase()
    const store = context.store || defaultStore
    const config = normalizeAntiSpam(store.getGroup(groupJid)?.antiSpam)
    if (!config.enabled || !isEligibleIncomingMessage(msg, context)) return { blocked: false, reason: "disabled-or-ignored" }
    const policy = await common.resolveFeaturePolicy(sock, groupJid, ANTISPAM_FEATURE, context, {
        ...(context.runtimePolicy?.metadata ? { metadata: context.runtimePolicy.metadata } : {}),
    })
    if (!policy.allowed) return { blocked: false, reason: policy.reason }
    const sender = resolveSender(policy, msg, context)
    if (!sender.key || isExempt(policy, msg, { ...context, sock }, sender)) return { blocked: false, reason: "exempt" }

    cleanupRuntimeTrackers(now)
    const key = `${groupJid}:${sender.key}`
    const previous = antiSpamTracker.get(key)
    const times = (previous?.times || []).filter(at => now - at <= config.delayMs)
    times.push(now)
    antiSpamTracker.set(key, { times, lastSeenAt: now })
    if (times.length < config.threshold) return { blocked: false, reason: "below-threshold", count: times.length }
    antiSpamTracker.set(key, { times: [], lastSeenAt: now })
    return applyAntiSpamAction(sock, msg, policy, sender, config, { ...context, sock }, now)
}

async function evaluateSlowmode(sock, msg, context = {}, now = Date.now()) {
    const groupJid = String(context.from || msg?.key?.remoteJid || "").toLowerCase()
    const store = context.store || defaultStore
    const config = normalizeSlowmode(store.getGroup(groupJid)?.slowmode)
    if (!config.enabled || !isEligibleIncomingMessage(msg, context)) return { blocked: false, reason: "disabled-or-ignored" }
    const isCommand = String(context.text || "").trim().startsWith(".")
    if (config.mode === "ONLYCOMMAND" && !isCommand) return { blocked: false, reason: "normal-message" }
    const policy = await common.resolveFeaturePolicy(sock, groupJid, SLOWMODE_FEATURE, context, {
        ...(context.runtimePolicy?.metadata ? { metadata: context.runtimePolicy.metadata } : {}),
    })
    if (!policy.allowed) return { blocked: false, reason: policy.reason }
    const sender = resolveSender(policy, msg, context)
    if (!sender.key || isExempt(policy, msg, { ...context, sock }, sender)) return { blocked: false, reason: "exempt" }

    cleanupRuntimeTrackers(now)
    const key = `${groupJid}:${sender.key}`
    const previous = slowmodeTracker.get(key)
    const cooldownMs = config.seconds * 1000
    if (!previous || now - Number(previous.lastAllowedAt || 0) >= cooldownMs) {
        slowmodeTracker.set(key, { lastAllowedAt: now })
        return { blocked: false, reason: "first-allowed" }
    }

    if (config.mode === "ALL") await sock.sendMessage(groupJid, { delete: msg.key })
    if (context.slowmodeWarnings !== false && shouldNotify(slowmodeNotices, key, now)) {
        const jid = common.getPreferredJid(sender.participant, context)
        const remaining = Math.max(1, Math.ceil((cooldownMs - (now - previous.lastAllowedAt)) / 1000))
        await sock.sendMessage(groupJid, {
            text: `${jid ? `@${jid.split("@")[0]} ` : ""}tunggu ${remaining} detik sebelum ${config.mode === "ONLYCOMMAND" ? "menjalankan command" : "mengirim pesan lagi"}.`,
            mentions: jid ? [jid] : [],
        }, { quoted: msg })
    }
    return { blocked: true, action: config.mode === "ALL" ? "delete" : "command-blocked" }
}

async function handleIncomingGroupMessage(sock, msg, context = {}) {
    if (!isEligibleIncomingMessage(msg, context)) return false
    const antiSpam = await evaluateAntiSpam(sock, msg, context)
    if (antiSpam.blocked) return true
    const slowmode = await evaluateSlowmode(sock, msg, context)
    return Boolean(slowmode.blocked)
}

module.exports = {
    ANTISPAM_DELAY_MAX,
    ANTISPAM_DELAY_MIN,
    ANTISPAM_FEATURE,
    ANTISPAM_THRESHOLD_MAX,
    ANTISPAM_THRESHOLD_MIN,
    NOTICE_COOLDOWN_MS,
    SLOWMODE_FEATURE,
    SLOWMODE_MAX_SECONDS,
    SLOWMODE_MIN_SECONDS,
    cleanupRuntimeTrackers,
    evaluateAntiSpam,
    evaluateSlowmode,
    handleGroupFloodCommand,
    handleIncomingGroupMessage,
    isEligibleIncomingMessage,
    isFloodCommand,
    normalizeAntiSpam,
    normalizeSlowmode,
    resetRuntimeTrackers,
}
