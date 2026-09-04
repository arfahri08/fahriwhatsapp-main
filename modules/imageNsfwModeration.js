"use strict"

const fs = require("fs")
const path = require("path")
const { createAtomicJsonStore } = require("./atomicJsonStore")
const groupCommon = require("./groupUtilityCommon")
const groupRuntimePolicy = require("./groupRuntimePolicy")
const stickerSafety = require("./stickerSafetyGuard")

const STATE_FILE = process.env.NSFW_MODERATION_STATE_FILE
    ? path.resolve(process.env.NSFW_MODERATION_STATE_FILE)
    : path.join(__dirname, "..", "data", "nsfwModeration.json")
const FEATURE_NAME = "nsfwModeration"
const DEFAULT_THRESHOLD = 0.80
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_QUEUE = 20
const MAX_DEDUPE = 2000
const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000

const store = createAtomicJsonStore({
    filePath: STATE_FILE,
    label: "IMAGE NSFW MODERATION",
    defaultState: () => ({ version: 1, groups: {} }),
})

const recentMessageIds = new Map()
const queue = []
let activeScans = 0
let peakActiveScans = 0

function normalizeGroupConfig(value = {}) {
    const threshold = Number(value.threshold)
    return {
        ...value,
        enabled: value.enabled === true,
        threshold: Number.isFinite(threshold) && threshold >= 0.5 && threshold <= 0.99 ? threshold : DEFAULT_THRESHOLD,
        action: String(value.action || "WARN").toUpperCase() === "DELETE" ? "DELETE" : "WARN",
    }
}

function normalizeState(value = store.snapshot()) {
    const groups = value.groups && typeof value.groups === "object" ? value.groups : {}
    return { ...value, groups: Object.fromEntries(Object.entries(groups).map(([jid, config]) => [groupRuntimePolicy.normalizeJid(jid), normalizeGroupConfig(config)])) }
}

function snapshot() {
    return normalizeState(store.snapshot())
}

function update(mutator) {
    return normalizeState(store.update(raw => {
        const state = normalizeState(raw)
        return mutator(state) || state
    }))
}

function getGroupConfig(groupJid) {
    return normalizeGroupConfig(snapshot().groups[groupRuntimePolicy.normalizeJid(groupJid)] || {})
}

function setGroupConfig(groupJid, patch, actor = "") {
    const jid = groupRuntimePolicy.normalizeJid(groupJid)
    return update(state => {
        state.groups[jid] = normalizeGroupConfig({ ...state.groups[jid], ...patch, updatedAt: new Date().toISOString(), updatedBy: String(actor || "").slice(0, 120) })
        return state
    }).groups[jid]
}

function cleanupDedupe(now = Date.now()) {
    for (const [id, at] of recentMessageIds) if (at <= now - DEDUPE_TTL_MS) recentMessageIds.delete(id)
    while (recentMessageIds.size > MAX_DEDUPE) recentMessageIds.delete(recentMessageIds.keys().next().value)
}

function claimMessage(id, now = Date.now()) {
    const key = String(id || "").trim().slice(0, 256)
    if (!key) return false
    cleanupDedupe(now)
    if (recentMessageIds.has(key)) return false
    recentMessageIds.set(key, now)
    cleanupDedupe(now)
    return true
}

function enqueue(task) {
    if (activeScans + queue.length >= MAX_QUEUE + 1) return Promise.resolve({ scanned: false, reason: "queue-full" })
    return new Promise(resolve => {
        queue.push({ task, resolve })
        void drainQueue()
    })
}

async function drainQueue() {
    if (activeScans >= 1) return
    const item = queue.shift()
    if (!item) return
    activeScans += 1
    peakActiveScans = Math.max(peakActiveScans, activeScans)
    try { item.resolve(await item.task()) } catch (error) { item.resolve({ scanned: false, reason: String(error?.message || error).slice(0, 180) }) }
    finally { activeScans -= 1; void drainQueue() }
}

function unsafeConfidence(result = {}) {
    const scores = [Number(result.confidence || 0)]
    const collections = [result.predictions, ...(Array.isArray(result.frames) ? result.frames.map(item => item?.predictions) : [])]
    for (const predictions of collections) {
        if (!predictions) continue
        scores.push(Number(predictions.Porn || predictions.porn || 0), Number(predictions.Hentai || predictions.hentai || 0), Number(predictions.Sexy || predictions.sexy || 0))
    }
    return Math.max(0, ...scores.filter(Number.isFinite))
}

async function scanImage(sock, msg, context = {}) {
    if (typeof context.inspectImage === "function") {
        const result = await context.inspectImage(msg)
        return { scanned: true, result, confidence: unsafeConfidence(result) }
    }
    const descriptor = groupCommon.getMediaDescriptor(msg, { preferQuoted: true })
    if (descriptor?.type !== "imageMessage") return { scanned: false, reason: "not-image" }
    const buffer = await groupCommon.downloadMedia(sock, descriptor, context)
    if (!buffer?.length) return { scanned: false, reason: "empty-image" }
    if (buffer.length > MAX_IMAGE_BYTES) return { scanned: false, reason: "image-too-large" }
    let frames
    try {
        frames = await stickerSafety.extractStickerFrames(buffer, { isAnimated: false }, { maxFrames: 1 })
        const result = await stickerSafety.inspectStickerNsfw(frames.frames || [], { isStatic: true, fastMode: true })
        return { scanned: true, result, confidence: unsafeConfidence(result) }
    } finally {
        if (frames?.tempDir) {
            try { fs.rmSync(frames.tempDir, { recursive: true, force: false }) } catch {}
        }
    }
}

function isControlOrExcluded(msg, context = {}) {
    const jid = groupRuntimePolicy.normalizeJid(context.from || msg?.key?.remoteJid)
    if (!groupRuntimePolicy.isGroupJid(jid) || jid === "status@broadcast" || jid.endsWith("@newsletter") || jid.endsWith("@broadcast")) return true
    if (msg?.key?.fromMe || context.isBotGeneratedMessage?.(msg)) return true
    const message = groupCommon.unwrapMessage(msg?.message || {})
    if (message.protocolMessage || message.reactionMessage || message.editedMessage || message.messageContextInfo?.messageSecret) return true
    return !message.imageMessage
}

async function moderateImage(sock, msg, context = {}) {
    if (isControlOrExcluded(msg, context)) return { handled: false, reason: "excluded" }
    const groupJid = groupRuntimePolicy.normalizeJid(context.from || msg?.key?.remoteJid)
    const config = getGroupConfig(groupJid)
    if (!config.enabled) return { handled: false, reason: "disabled" }
    const policy = await groupCommon.resolveFeaturePolicy(sock, groupJid, FEATURE_NAME, context)
    if (!policy.allowed) return { handled: false, reason: policy.reason }
    const sender = groupRuntimePolicy.normalizeJid(context.senderJid || msg?.key?.participantAlt || msg?.key?.participant)
    if (context.isOwner || context.canControlOwner || groupCommon.isSenderAdmin(policy.metadata, msg, sender, context)) return { handled: false, reason: "admin-exempt" }
    if (!claimMessage(msg?.key?.id, context.now || Date.now())) return { handled: false, reason: "duplicate" }
    return enqueue(async () => {
        const scan = await scanImage(sock, msg, context)
        if (!scan.scanned) return { handled: false, reason: scan.reason }
        const violation = scan.confidence >= config.threshold
        if (!violation) return { handled: false, scanned: true, confidence: scan.confidence }
        if (config.action === "DELETE") await sock.sendMessage(groupJid, { delete: msg.key })
        else await sock.sendMessage(groupJid, {
            text: `⚠️ Media berpotensi NSFW (${Math.round(scan.confidence * 100)}%).`,
            mentions: sender ? [sender] : [],
        }, { quoted: msg })
        return { handled: true, action: config.action, confidence: scan.confidence }
    })
}

async function handleNsfwCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    const isScan = /^\.nsfwscan(?:\s|$)/i.test(text)
    const isConfig = /^\.nsfw(?:\s|$)/i.test(text)
    if (!isScan && !isConfig) return false

    let groupJid = ""
    if (context.isGroup) {
        const access = await groupCommon.resolveCommandAccess(sock, msg, FEATURE_NAME, context)
        if (access.hardDenied) return true
        if (!access.allowed) {
            await sock.sendMessage(access.groupJid, { text: "NSFW moderation hanya dapat diatur/dipindai oleh admin grup atau owner." }, { quoted: msg })
            return true
        }
        groupJid = access.groupJid
    } else if (!context.isOwner) {
        await sock.sendMessage(context.from, { text: "NSFW scan private hanya untuk owner." }, { quoted: msg })
        return true
    }

    if (isScan) {
        const scan = await enqueue(() => scanImage(sock, msg, context))
        if (!scan.scanned) await sock.sendMessage(context.from, { text: "Reply sebuah image untuk .nsfwscan" }, { quoted: msg })
        else {
            const result = scan.result || {}
            const predictions = result.predictions || result.frames?.[0]?.predictions || {}
            await sock.sendMessage(context.from, { text: [
                "LOCAL NSFW SCAN",
                `Unsafe confidence: ${(scan.confidence * 100).toFixed(1)}%`,
                `Porn: ${(Number(predictions.Porn || 0) * 100).toFixed(1)}%`,
                `Hentai: ${(Number(predictions.Hentai || 0) * 100).toFixed(1)}%`,
                `Sexy: ${(Number(predictions.Sexy || 0) * 100).toFixed(1)}%`,
                `Category: ${result.category || "-"}`,
                `Model available: ${result.available === false ? "NO" : "YES"}`,
            ].join("\n") }, { quoted: msg })
        }
        return true
    }

    if (!context.isGroup) {
        await sock.sendMessage(context.from, { text: "Konfigurasi .nsfw on/off dijalankan di grup target oleh admin/owner. Gunakan .nsfwscan untuk debug private." }, { quoted: msg })
        return true
    }
    const [, action = "status", rawValue = ""] = /^(?:\.nsfw)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/i.exec(text) || []
    let config = getGroupConfig(groupJid)
    try {
        const command = String(action || "status").toLowerCase()
        if (command === "on" || command === "off") config = setGroupConfig(groupJid, { enabled: command === "on" }, context.senderJid)
        else if (command === "threshold") {
            const threshold = Number(rawValue)
            if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.99) throw new Error("Threshold harus 0.50-0.99")
            config = setGroupConfig(groupJid, { threshold }, context.senderJid)
        } else if (command === "action") {
            const value = String(rawValue || "").toUpperCase()
            if (!new Set(["WARN", "DELETE"]).has(value)) throw new Error("Action hanya warn/delete")
            config = setGroupConfig(groupJid, { action: value }, context.senderJid)
        } else if (command !== "status") throw new Error("Format command tidak valid")
        await sock.sendMessage(groupJid, { text: `Image NSFW: ${config.enabled ? "ON" : "OFF"}\nThreshold: ${config.threshold.toFixed(2)}\nAction: ${config.action}\nDefault aman: OFF; admin/owner/bot/status/control dikecualikan.` }, { quoted: msg })
    } catch (error) {
        await sock.sendMessage(groupJid, { text: `${error.message}\nFormat: .nsfw status/on/off/threshold 0.80/action warn|delete` }, { quoted: msg })
    }
    return true
}

function getQueueHealth() {
    return { active: activeScans, pending: queue.length, peakActive: peakActiveScans, maxPending: MAX_QUEUE, dedupe: recentMessageIds.size }
}

function resetRuntime() {
    recentMessageIds.clear()
    while (queue.length) queue.shift().resolve({ scanned: false, reason: "reset" })
    peakActiveScans = activeScans
}

module.exports = {
    DEFAULT_THRESHOLD,
    FEATURE_NAME,
    MAX_QUEUE,
    STATE_FILE,
    claimMessage,
    enqueue,
    getGroupConfig,
    getQueueHealth,
    handleNsfwCommand,
    isControlOrExcluded,
    moderateImage,
    resetRuntime,
    scanImage,
    setGroupConfig,
    snapshot,
    store,
    unsafeConfidence,
    update,
}
