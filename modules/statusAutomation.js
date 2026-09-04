"use strict"

const path = require("path")
const { createAtomicJsonStore } = require("./atomicJsonStore")
const identity = require("./canonicalIdentity")
const mediaCommon = require("./groupUtilityCommon")
const statusProvenance = require("./statusBroadcastProvenance")

const STATE_FILE = process.env.STATUS_AUTOMATION_STATE_FILE
    ? path.resolve(process.env.STATUS_AUTOMATION_STATE_FILE)
    : path.join(__dirname, "..", "data", "statusAutomation.json")
const DEFAULT_EMOJIS = ["❤️"]
const MAX_PROCESSED = 5000
const PROCESSED_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_QUEUE = 100
const MIN_REACTION_INTERVAL_MS = 1200
const MAX_STATUS_MEDIA_BYTES = 16 * 1024 * 1024

const store = createAtomicJsonStore({
    filePath: STATE_FILE,
    label: "STATUS AUTOMATION",
    defaultState: () => ({
        version: 1,
        autoreact: { enabled: false, emojis: DEFAULT_EMOJIS, allow: [], block: [], processed: [] },
    }),
})

let reactionQueue = []
let reactionActive = false
let lastReactionAt = 0

function uniqueStrings(values, max = 1000) {
    return [...new Set((Array.isArray(values) ? values : [values]).map(value => String(value || "").trim()).filter(Boolean))].slice(0, max)
}

function normalizeState(value = store.snapshot(), now = Date.now()) {
    const autoreact = value.autoreact && typeof value.autoreact === "object" ? value.autoreact : {}
    const processed = (Array.isArray(autoreact.processed) ? autoreact.processed : [])
        .filter(item => item?.id && Number(item.at || 0) > now - PROCESSED_TTL_MS)
        .slice(-MAX_PROCESSED)
    return {
        ...value,
        autoreact: {
            ...autoreact,
            enabled: autoreact.enabled === true,
            emojis: uniqueStrings(autoreact.emojis?.length ? autoreact.emojis : DEFAULT_EMOJIS, 20),
            allow: uniqueStrings(autoreact.allow, 1000),
            block: uniqueStrings(autoreact.block, 1000),
            processed,
        },
    }
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

function statusSender(msg, context = {}) {
    return identity.canonicalIdentity([
        context.senderJid,
        msg?.key?.participantAlt,
        msg?.key?.participant,
        msg?.participantAlt,
        msg?.participant,
    ], context)
}

function isStatusMessage(msg) {
    return String(msg?.key?.remoteJid || "").toLowerCase() === "status@broadcast"
}

function claimStatus(messageId, now = Date.now()) {
    const id = String(messageId || "").trim().slice(0, 256)
    if (!id) return false
    let claimed = false
    update(state => {
        if (state.autoreact.processed.some(item => item.id === id)) return state
        state.autoreact.processed.push({ id, at: now })
        state.autoreact.processed = state.autoreact.processed.slice(-MAX_PROCESSED)
        claimed = true
        return state
    })
    return claimed
}

function pickEmoji(values, random = Math.random) {
    const emojis = uniqueStrings(values, 20)
    if (!emojis.length) return ""
    if (emojis.length === 1) return emojis[0]
    return emojis[Math.min(emojis.length - 1, Math.floor(Math.max(0, Number(random())) * emojis.length))]
}

function enqueueReaction(task) {
    if (reactionQueue.length >= MAX_QUEUE) return Promise.resolve({ reacted: false, reason: "queue-full" })
    return new Promise(resolve => {
        reactionQueue.push({ task, resolve })
        void drainReactionQueue()
    })
}

async function drainReactionQueue() {
    if (reactionActive) return
    reactionActive = true
    try {
        while (reactionQueue.length) {
            const item = reactionQueue.shift()
            try { item.resolve(await item.task()) } catch (error) { item.resolve({ reacted: false, reason: String(error?.message || error).slice(0, 160) }) }
        }
    } finally {
        reactionActive = false
    }
}

async function handleIncomingStatus(sock, msg, context = {}) {
    if (!isStatusMessage(msg)) return { reacted: false, reason: "not-status" }
    if (msg?.key?.fromMe) return { reacted: false, reason: "own-status" }
    if (String(msg?.key?.remoteJid || "").endsWith("@newsletter")) return { reacted: false, reason: "newsletter" }
    const content = mediaCommon.unwrapMessage(msg?.message || {})
    if (content.reactionMessage || content.protocolMessage || content.editedMessage) return { reacted: false, reason: "control-message" }
    const state = snapshot().autoreact
    if (!state.enabled) return { reacted: false, reason: "disabled" }
    const sender = statusSender(msg, context)
    if (!sender.key) return { reacted: false, reason: "invalid-sender" }
    if (state.block.includes(sender.key)) return { reacted: false, reason: "blocked" }
    if (state.allow.length && !state.allow.includes(sender.key)) return { reacted: false, reason: "not-allowed" }
    if (!claimStatus(msg?.key?.id, context.now || Date.now())) return { reacted: false, reason: "duplicate" }
    const emoji = pickEmoji(state.emojis, context.random)
    if (!emoji) return { reacted: false, reason: "no-emoji" }
    return enqueueReaction(async () => {
        const sleep = context.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
        const remaining = Math.max(0, MIN_REACTION_INTERVAL_MS - (Date.now() - lastReactionAt))
        if (remaining) await sleep(remaining)
        // The status key is the only target. No private acknowledgement is sent.
        await sock.sendMessage("status@broadcast", { react: { text: emoji, key: msg.key } }, { broadcast: true, statusJidList: sender.jid ? [sender.jid] : [] })
        lastReactionAt = Date.now()
        return { reacted: true, emoji, senderKey: sender.key }
    })
}

function normalizeEmoji(value) {
    const emoji = String(value || "").trim()
    if (!emoji || emoji.length > 24 || /[\r\n\0]/.test(emoji)) return ""
    return emoji
}

function maskIdentityKey(key) {
    const value = String(key || "")
    const suffix = value.slice(-4)
    return `${value.split(":")[0] || "id"}:***${suffix}`
}

function configureList(kind, action, rawTarget, context = {}) {
    const key = kind === "allow" ? "allow" : "block"
    const target = identity.canonicalIdentity(rawTarget, context)
    if (!target.key) throw new Error("Target kontak tidak valid")
    return update(state => {
        const values = new Set(state.autoreact[key])
        if (action === "add") values.add(target.key)
        if (action === "remove") values.delete(target.key)
        state.autoreact[key] = [...values]
        return state
    })
}

async function uploadStatus(sock, msg, context, commandText) {
    const descriptor = mediaCommon.getMediaDescriptor(msg, { preferQuoted: true })
    const caption = String(commandText || "").replace(/^\.(?:upsw|upstatus)(?:\s+|$)/i, "").trim().slice(0, 4096)
    let payload
    if (!descriptor) {
        if (!caption) throw new Error("Tulis teks atau reply image/video untuk status")
        payload = { text: caption }
    } else {
        if (!new Set(["imageMessage", "videoMessage"]).has(descriptor.type)) throw new Error("Status media hanya mendukung image/video")
        const buffer = await mediaCommon.downloadMedia(sock, descriptor, context)
        if (!buffer?.length || buffer.length > MAX_STATUS_MEDIA_BYTES) throw new Error("Media kosong atau melebihi 16 MB")
        payload = descriptor.type === "imageMessage"
            ? { image: buffer, caption: caption || String(descriptor.media?.caption || "").slice(0, 4096) }
            : { video: buffer, caption: caption || String(descriptor.media?.caption || "").slice(0, 4096), mimetype: descriptor.media?.mimetype || "video/mp4" }
    }
    const configuredRecipients = Array.isArray(context.statusJidList) ? context.statusJidList : []
    let cachedRecipients = []
    try { cachedRecipients = Object.keys(context.contactNameStore?.loadState?.().contacts || {}) } catch {}
    const statusJidList = identity.unique([...configuredRecipients, ...cachedRecipients])
        .map(jid => identity.canonicalIdentity(jid, context))
        .filter(item => item.jid.endsWith("@s.whatsapp.net"))
        .filter(item => item.key !== identity.canonicalIdentity([sock?.user?.id, sock?.user?.lid], context).key)
        .map(item => item.jid)
        .slice(0, 10000)
    const sent = await sock.sendMessage("status@broadcast", payload, { broadcast: true, statusJidList })
    statusProvenance.rememberStatusOrigin({
        key: { ...(sent?.key || {}), remoteJid: "status@broadcast", fromMe: true },
        message: sent?.message || payload,
    }, { source: "owner-status-upload" })
    return sent
}

async function handleStatusAutomationCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    const isUpload = /^\.(?:upsw|upstatus)(?:\s|$)/i.test(text)
    const isControl = /^\.autoreactsw(?:\s|$)/i.test(text)
    if (!isUpload && !isControl) return false
    if (context.isGroup) return true
    if (!context.isOwner) {
        await sock.sendMessage(context.from, { text: "Status automation hanya untuk owner melalui private chat." }, { quoted: msg })
        return true
    }
    if (isUpload) {
        try {
            await uploadStatus(sock, msg, context, text)
            await sock.sendMessage(context.from, { text: "Status WhatsApp berhasil diunggah dan provenance dicatat." }, { quoted: msg })
        } catch (error) {
            await sock.sendMessage(context.from, { text: `Upload status gagal: ${String(error?.message || error).slice(0, 180)}` }, { quoted: msg })
        }
        return true
    }

    const parts = text.split(/\s+/)
    const action = String(parts[1] || "status").toLowerCase()
    try {
        if (action === "on" || action === "off") update(state => { state.autoreact.enabled = action === "on"; return state })
        else if (action === "emoji") {
            const emoji = normalizeEmoji(parts.slice(2).join(" "))
            if (!emoji) throw new Error("Emoji tidak valid")
            update(state => { state.autoreact.emojis = [emoji]; return state })
        } else if (action === "addemoji") {
            const emoji = normalizeEmoji(parts.slice(2).join(" "))
            if (!emoji) throw new Error("Emoji tidak valid")
            update(state => { state.autoreact.emojis = uniqueStrings([...state.autoreact.emojis, emoji], 20); return state })
        } else if (action === "delememoji" || action === "delemoji") {
            const emoji = normalizeEmoji(parts.slice(2).join(" "))
            update(state => { state.autoreact.emojis = state.autoreact.emojis.filter(item => item !== emoji); if (!state.autoreact.emojis.length) state.autoreact.emojis = DEFAULT_EMOJIS; return state })
        } else if (action === "allow" || action === "block") configureList(action, "add", parts.slice(2), context)
        else if (action === "unallow" || action === "unblock") configureList(action === "unallow" ? "allow" : "block", "remove", parts.slice(2), context)
        else if (!["status", "allowlist", "blocklist"].includes(action)) throw new Error("Command tidak dikenal")

        const current = snapshot().autoreact
        const requestedList = action === "allowlist" ? current.allow : action === "blocklist" ? current.block : null
        const output = requestedList
            ? `${action.toUpperCase()} (${requestedList.length})\n${requestedList.map(maskIdentityKey).join("\n") || "Kosong"}`
            : [
                `Auto React Status: ${current.enabled ? "ON" : "OFF"}`,
                `Emoji: ${current.emojis.join(" ")}`,
                `Allowlist: ${current.allow.length}`,
                `Blocklist: ${current.block.length}`,
                `Processed bounded: ${current.processed.length}/${MAX_PROCESSED}`,
                "Format: .autoreactsw on/off/status/emoji/addemoji/delememoji/allow/block/allowlist/blocklist",
            ].join("\n")
        await sock.sendMessage(context.from, { text: output }, { quoted: msg })
    } catch (error) {
        await sock.sendMessage(context.from, { text: `Konfigurasi autoreact gagal: ${String(error?.message || error).slice(0, 180)}` }, { quoted: msg })
    }
    return true
}

function resetRuntimeQueue() {
    for (const item of reactionQueue) item.resolve({ reacted: false, reason: "disposed" })
    reactionQueue = []
    reactionActive = false
    lastReactionAt = 0
}

module.exports = {
    DEFAULT_EMOJIS,
    MAX_PROCESSED,
    MAX_QUEUE,
    STATE_FILE,
    claimStatus,
    configureList,
    handleIncomingStatus,
    handleStatusAutomationCommand,
    isStatusMessage,
    pickEmoji,
    resetRuntimeQueue,
    snapshot,
    statusSender,
    store,
    update,
    uploadStatus,
}
