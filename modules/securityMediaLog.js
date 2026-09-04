const fs = require("fs")
const path = require("path")
const contactNameStore = require("./contactNameStore")
const lidAliasStore = require("./lidAliasStore")

const DEFAULT_SECURITY_MEDIA_LOG_JID = "120363424006225997@g.us"
const SECURITY_LOG_BUILD = "2026-07-21.6"
const STATE_PATH = path.resolve(process.env.SECURITY_MEDIA_LOG_STATE_PATH || path.join(__dirname, "../data/securityMediaLog.json"))
const DEFAULT_DEDUPE_TTL_MS = 5 * 60 * 1000
const MAX_LOG_TEXT_LENGTH = 3000

const dedupeCache = new Map()
const warnedInvalidTargets = new Set()
let stateLoaded = false
let state = null

function shortError(error) {
    return String(error?.message || error || "unknown error")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300)
}

function validateSecurityLogJid(value) {
    const jid = String(value || "").trim()
    if (!jid || jid === "status@broadcast") return false
    if (/newsletter/i.test(jid)) return false
    return /^\d+@g\.us$/i.test(jid)
}

function resolveConfiguredTarget(envName) {
    const candidates = [
        [envName, process.env[envName]],
        ["SECURITY_MEDIA_LOG_JID", process.env.SECURITY_MEDIA_LOG_JID],
    ]

    for (const [name, rawValue] of candidates) {
        if (rawValue == null || String(rawValue).trim() === "") continue
        const jid = String(rawValue).trim()
        if (validateSecurityLogJid(jid)) return jid.toLowerCase()

        const warningKey = `${name}:${jid}`
        if (!warnedInvalidTargets.has(warningKey)) {
            warnedInvalidTargets.add(warningKey)
            console.log(`[SECURITY LOG] ${name} tidak valid; memakai target default.`)
        }
        return DEFAULT_SECURITY_MEDIA_LOG_JID
    }

    return DEFAULT_SECURITY_MEDIA_LOG_JID
}

function getAntiDeleteLogJid() {
    return resolveConfiguredTarget("ANTI_DELETE_LOG_JID")
}

function getViewOnceLogJid() {
    return resolveConfiguredTarget("VIEWONCE_LOG_JID")
}

function getSecurityLogJid(candidate = "") {
    const envValue = String(process.env.SECURITY_MEDIA_LOG_JID || "").trim()
    if (envValue) {
        if (validateSecurityLogJid(envValue)) return envValue.toLowerCase()
        const warningKey = `SECURITY_MEDIA_LOG_JID:${envValue}`
        if (!warnedInvalidTargets.has(warningKey)) {
            warnedInvalidTargets.add(warningKey)
            console.log("[SECURITY LOG] SECURITY_MEDIA_LOG_JID tidak valid; mencoba target tersimpan.")
        }
    }

    const directCandidate = String(candidate || "").trim()
    if (validateSecurityLogJid(directCandidate)) return directCandidate.toLowerCase()

    const cachedCandidate = String(state?.targetJid || "").trim()
    if (stateLoaded && validateSecurityLogJid(cachedCandidate)) return cachedCandidate.toLowerCase()

    try {
        if (fs.existsSync(STATE_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8") || "{}")
            const persisted = String(parsed?.targetJid || "").trim()
            if (validateSecurityLogJid(persisted)) return persisted.toLowerCase()
        }
    } catch {}

    return DEFAULT_SECURITY_MEDIA_LOG_JID
}

function isSecurityLogChat(jid) {
    const clean = String(jid || "").trim()
    return new Set([
        DEFAULT_SECURITY_MEDIA_LOG_JID,
        getSecurityLogJid(),
        getAntiDeleteLogJid(),
        getViewOnceLogJid(),
    ]).has(clean)
}

function getSecurityPayloadRoute(content = {}) {
    const body = String(content?.text || content?.caption || "").toUpperCase()
    if (!body) return null
    if (body.includes("ANTI-DELETE LOG") || body.includes("PESAN DIHAPUS TERDETEKSI")) {
        return { type: "anti-delete", targetJid: getAntiDeleteLogJid() }
    }
    if (
        body.includes("VIEW ONCE LOG")
        || body.includes("VIEW ONCE MASUK")
        || body.includes("VIEW ONCE DIHAPUS")
        || body.includes("MEDIA VIEW-ONCE MASUK")
        || body.includes("VIEW-ONCE BERHASIL")
    ) {
        return { type: "view-once", targetJid: getViewOnceLogJid() }
    }
    return null
}

function defaultState() {
    return {
        version: 1,
        targetJid: getSecurityLogJid(),
        antiDeleteEnabled: true,
        viewOnceEnabled: true,
        updatedAt: 0,
        lastAntiDeleteAt: null,
        lastViewOnceAt: null,
    }
}

function atomicWriteState(nextState) {
    const dir = path.dirname(STATE_PATH)
    fs.mkdirSync(dir, { recursive: true })
    const tempPath = `${STATE_PATH}.${process.pid}.tmp`
    fs.writeFileSync(tempPath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8")
    fs.renameSync(tempPath, STATE_PATH)
}

function loadState() {
    if (stateLoaded && state) return state

    const fallback = defaultState()
    try {
        if (!fs.existsSync(STATE_PATH)) {
            state = fallback
            atomicWriteState(state)
        } else {
            const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8") || "{}")
            state = {
                ...fallback,
                ...(parsed && typeof parsed === "object" ? parsed : {}),
                version: 1,
                targetJid: getSecurityLogJid(parsed?.targetJid),
                antiDeleteEnabled: parsed?.antiDeleteEnabled !== false,
                viewOnceEnabled: parsed?.viewOnceEnabled !== false,
            }
        }
    } catch (error) {
        try {
            if (fs.existsSync(STATE_PATH)) {
                fs.renameSync(STATE_PATH, `${STATE_PATH}.corrupt-${Date.now()}`)
            }
        } catch {}
        state = fallback
        try {
            atomicWriteState(state)
        } catch (writeError) {
            console.log(`[SECURITY LOG] Config reset gagal: ${shortError(writeError)}`)
        }
        console.log(`[SECURITY LOG] Config rusak direset: ${shortError(error)}`)
    }

    stateLoaded = true
    return state
}

function saveState(nextState) {
    state = {
        ...defaultState(),
        ...(nextState || {}),
        version: 1,
        targetJid: getSecurityLogJid(nextState?.targetJid),
    }
    stateLoaded = true
    atomicWriteState(state)
    return state
}

function isAntiDeleteEnabled() {
    return loadState().antiDeleteEnabled !== false
}

function isViewOnceEnabled() {
    return loadState().viewOnceEnabled !== false
}

function setFeatureEnabled(feature, enabled) {
    const current = loadState()
    const key = feature === "antiDelete" ? "antiDeleteEnabled" : feature === "viewOnce" ? "viewOnceEnabled" : ""
    if (!key) throw new Error("fitur security log tidak dikenal")
    return saveState({
        ...current,
        [key]: Boolean(enabled),
        updatedAt: Date.now(),
    })
}

function getDedupeTtlMs() {
    const value = Number(process.env.SECURITY_LOG_DEDUPE_TTL_MS || DEFAULT_DEDUPE_TTL_MS)
    return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_DEDUPE_TTL_MS
}

function claimDedupe(key, label) {
    const cleanKey = String(key || "").trim()
    if (!cleanKey) return true

    const now = Date.now()
    const ttl = getDedupeTtlMs()
    for (const [storedKey, storedAt] of dedupeCache) {
        if (now - storedAt > ttl) dedupeCache.delete(storedKey)
    }

    if (dedupeCache.has(cleanKey)) {
        console.log(`[SECURITY LOG] Duplicate ${label} diabaikan.`)
        return false
    }

    dedupeCache.set(cleanKey, now)
    return true
}

function releaseDedupe(key) {
    if (key) dedupeCache.delete(String(key))
}

function formatTimestamp(value) {
    const raw = Number(value || 0)
    const milliseconds = raw > 1000000000000 ? raw : raw * 1000
    const date = Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds) : new Date()
    try {
        return date.toLocaleString("id-ID", {
            timeZone: process.env.TZ || "Asia/Jakarta",
            hour12: false,
        })
    } catch {
        return date.toISOString()
    }
}

function shorten(value, limit = MAX_LOG_TEXT_LENGTH) {
    const clean = String(value || "").trim()
    if (clean.length <= limit) return clean
    return `${clean.slice(0, Math.max(0, limit - 14))}... (dipotong)`
}

function normalizeMentionJid(value) {
    const clean = String(value || "").trim()
    if (/^\d+@s\.whatsapp\.net$/i.test(clean)) return clean
    if (/^\d+@lid$/i.test(clean)) return clean
    return null
}

function safeSenderText(senderJid) {
    const mention = normalizeMentionJid(senderJid)
    if (mention) return `@${mention.split("@")[0]}`
    const clean = String(senderJid || "").replace(/[\r\n\t]/g, " ").trim().slice(0, 120)
    return clean || "Tidak diketahui"
}

function resolveSenderContactName(senderJid, providedName = "") {
    const rawJid = String(senderJid || "").trim()
    const resolvedJid = lidAliasStore.resolveBestJid(rawJid) || rawJid
    const savedName = contactNameStore.resolveSavedContactName(resolvedJid)
        || contactNameStore.resolveSavedContactName(rawJid)
    if (savedName) return savedName

    const fallbackName = String(providedName || "")
        .normalize("NFKC")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120)
    return fallbackName || "Belum tersimpan"
}

async function resolveSourceName(sock, sourceJid, providedName) {
    const name = String(providedName || "").trim()
    if (name) return name
    if (!String(sourceJid || "").endsWith("@g.us")) return "Private Chat"
    if (typeof sock?.groupMetadata !== "function") return String(sourceJid)

    let timer = null
    try {
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("group metadata timeout")), 5000)
            if (typeof timer.unref === "function") timer.unref()
        })
        const metadata = await Promise.race([sock.groupMetadata(sourceJid), timeout])
        return String(metadata?.subject || sourceJid)
    } catch {
        return String(sourceJid)
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function existingMedia(media = {}) {
    if (Buffer.isBuffer(media.buffer) && media.buffer.length) return media.buffer
    const filePath = String(media.filePath || "").trim()
    if (!filePath) return null
    try {
        const resolved = path.resolve(filePath)
        const allowedRoots = [
            path.resolve(__dirname, "../data/deleted_media"),
            path.resolve(__dirname, "../data/viewonce2_media"),
        ]
        if (!allowedRoots.some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`))) return null
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null
        return { url: resolved }
    } catch {
        return null
    }
}

function makeMediaOutbound(media, caption, mentions, filePrefix) {
    const source = existingMedia(media)
    if (!source) return null
    const type = String(media.mediaType || media.type || "").toLowerCase()
    const base = { caption, mentions }

    if (type === "image") return { image: source, mimetype: media.mimetype || "image/jpeg", ...base }
    if (type === "video") return { video: source, mimetype: media.mimetype || "video/mp4", ...base }

    const fallbackExtension = type === "sticker" ? "webp" : type === "audio" ? "ogg" : "bin"
    return {
        document: source,
        mimetype: media.mimetype || (type === "sticker" ? "image/webp" : type === "audio" ? "audio/ogg" : "application/octet-stream"),
        fileName: media.fileName || `${filePrefix}_${Date.now()}.${fallbackExtension}`,
        ...base,
    }
}

async function sendWithMentionFallback(sock, targetJid, outbound) {
    try {
        return await sock.sendMessage(targetJid, outbound)
    } catch (error) {
        if (!Array.isArray(outbound?.mentions) || outbound.mentions.length === 0) throw error
        const fallback = { ...outbound }
        delete fallback.mentions
        return sock.sendMessage(targetJid, fallback)
    }
}

async function sendAntiDeleteLog(sock, details = {}) {
    if (!isAntiDeleteEnabled()) return { sent: false, reason: "disabled" }
    const sourceJid = String(details.sourceJid || "").trim()
    if (!sourceJid || isSecurityLogChat(sourceJid) || details.fromMe === true) {
        return { sent: false, reason: "ignored-source" }
    }

    const dedupeKey = `anti-delete:${sourceJid}:${details.messageId || "unknown"}`
    if (!claimDedupe(dedupeKey, "anti-delete")) return { sent: false, reason: "duplicate" }

    try {
        const sourceName = await resolveSourceName(sock, sourceJid, details.sourceName)
        const mention = normalizeMentionJid(details.senderJid)
        const mentions = mention ? [mention] : []
        const mediaType = String(details.messageType || details.media?.mediaType || "other").toLowerCase()
        const isMedia = Boolean(details.media)
        const body = shorten(details.text || details.caption) || (isMedia ? "Tidak ada caption" : "Tidak ada teks")
        const caption = [
            "🗑️ *ANTI-DELETE LOG*",
            "",
            `Sumber: ${sourceName}`,
            `Chat ID: ${sourceJid}`,
            `Pengirim: ${safeSenderText(details.senderJid)}`,
            `Waktu pesan: ${formatTimestamp(details.messageTimestamp)}`,
            `Dihapus pada: ${formatTimestamp(details.deletedAt || Date.now())}`,
            `Tipe: ${mediaType || "other"}`,
            "",
            "Isi pesan:",
            body,
        ].join("\n")

        const outbound = makeMediaOutbound(details.media || {}, caption, mentions, "anti_delete") || {
            text: caption,
            mentions,
        }
        const targetJid = getAntiDeleteLogJid()
        const result = await sendWithMentionFallback(sock, targetJid, outbound)
        try {
            saveState({ ...loadState(), lastAntiDeleteAt: Date.now() })
        } catch (error) {
            console.log(`[SECURITY LOG] Anti-delete status save failed: ${shortError(error)}`)
        }
        return { sent: true, targetJid, result }
    } catch (error) {
        releaseDedupe(dedupeKey)
        console.log(`[SECURITY LOG] Anti-delete send failed: ${shortError(error)}`)
        return { sent: false, reason: "send-failed", error: shortError(error) }
    }
}

async function sendViewOnceLog(sock, details = {}) {
    if (!isViewOnceEnabled()) return { sent: false, reason: "disabled" }
    const sourceJid = String(details.sourceJid || "").trim()
    if (!sourceJid || isSecurityLogChat(sourceJid) || details.fromMe === true) {
        return { sent: false, reason: "ignored-source" }
    }

    const mediaType = String(details.mediaType || details.media?.mediaType || "other").toLowerCase()
    const dedupeKey = `view-once:${sourceJid}:${details.messageId || "unknown"}:${mediaType}`
    if (!claimDedupe(dedupeKey, "view-once")) return { sent: false, reason: "duplicate" }

    try {
        const sourceName = await resolveSourceName(sock, sourceJid, details.sourceName)
        const mention = normalizeMentionJid(details.senderJid)
        const mentions = mention ? [mention] : []
        const senderContactName = resolveSenderContactName(details.senderJid, details.senderName)
        const lines = [
            "👁️ *VIEW ONCE LOG*",
            "",
            `Sumber: ${sourceName}`,
            `Chat ID: ${sourceJid}`,
            `Pengirim: ${safeSenderText(details.senderJid)}`,
            `Nama kontak: ${senderContactName}`,
            `Waktu: ${formatTimestamp(details.messageTimestamp)}`,
            `Tipe: ${mediaType || "other"}`,
            `Caption asli: ${shorten(details.caption) || "Tidak ada caption"}`,
        ]
        const mediaOutbound = makeMediaOutbound(details.media || {}, lines.join("\n"), mentions, "view_once")
        const outbound = mediaOutbound || {
            text: `${lines.join("\n")}\nMedia: Media tidak tersedia atau gagal dicache`,
            mentions,
        }
        const targetJid = getViewOnceLogJid()
        const result = await sendWithMentionFallback(sock, targetJid, outbound)
        try {
            saveState({ ...loadState(), lastViewOnceAt: Date.now() })
        } catch (error) {
            console.log(`[SECURITY LOG] View-once status save failed: ${shortError(error)}`)
        }
        return { sent: true, targetJid, result }
    } catch (error) {
        releaseDedupe(dedupeKey)
        console.log(`[SECURITY LOG] View-once send failed: ${shortError(error)}`)
        return { sent: false, reason: "send-failed", error: shortError(error) }
    }
}

function formatLastTimestamp(value) {
    return value ? formatTimestamp(value) : "belum ada"
}

function getSecurityMediaLogHealth() {
    try {
        const current = loadState()
        return {
            status: "ON",
            targetJid: getSecurityLogJid(),
            antiDeleteEnabled: current.antiDeleteEnabled !== false,
            viewOnceEnabled: current.viewOnceEnabled !== false,
            dedupeTtlMs: getDedupeTtlMs(),
            lastAntiDeleteAt: current.lastAntiDeleteAt || null,
            lastViewOnceAt: current.lastViewOnceAt || null,
        }
    } catch {
        return {
            status: "UNKNOWN",
            targetJid: DEFAULT_SECURITY_MEDIA_LOG_JID,
            antiDeleteEnabled: "UNKNOWN",
            viewOnceEnabled: "UNKNOWN",
            dedupeTtlMs: getDedupeTtlMs(),
            lastAntiDeleteAt: null,
            lastViewOnceAt: null,
        }
    }
}

function formatStatusText() {
    const health = getSecurityMediaLogHealth()
    const ttlMinutes = Math.max(1, Math.round(health.dedupeTtlMs / 60000))
    return [
        "🛡️ SECURITY MEDIA LOG",
        "",
        "Target:",
        health.targetJid,
        "",
        `Anti-Delete: ${health.antiDeleteEnabled === true ? "ON" : health.antiDeleteEnabled === false ? "OFF" : "UNKNOWN"}`,
        `View Once: ${health.viewOnceEnabled === true ? "ON" : health.viewOnceEnabled === false ? "OFF" : "UNKNOWN"}`,
        `Dedupe TTL: ${ttlMinutes} menit`,
        `Build: ${SECURITY_LOG_BUILD}`,
        `Last Anti-Delete: ${formatLastTimestamp(health.lastAntiDeleteAt)}`,
        `Last View Once: ${formatLastTimestamp(health.lastViewOnceAt)}`,
    ].join("\n")
}

function normalizeSecurityCommandText(value) {
    return String(value || "")
        .normalize("NFKC")
        .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim()
}

function isSecurityLogCommand(value) {
    const command = normalizeSecurityCommandText(value).split(" ")[0].toLowerCase()
    return command === ".securitylog" || command === ".seclog"
}

async function handleSecurityLogCommand(sock, msg, context = {}) {
    const text = normalizeSecurityCommandText(context.text)
    const match = text.match(/^\.(?:securitylog|seclog)(?:\s+(.*))?$/i)
    if (!match) return false
    if (context.isGroup) return true

    const from = context.from || msg?.key?.remoteJid
    if (!context.isOwner) {
        await sock.sendMessage(from, { text: "Akses Ditolak" })
        return true
    }

    const args = String(match[1] || "status").trim().toLowerCase().split(/\s+/).filter(Boolean)
    const action = args[0] || "status"

    if (action === "status") {
        await sock.sendMessage(from, { text: formatStatusText() })
        return true
    }

    if (action === "test") {
        try {
            await sock.sendMessage(getSecurityLogJid(), {
                text: [
                    "🧪 *SECURITY LOG TEST*",
                    "",
                    "Anti-Delete dan View Once akan dikirim ke grup ini.",
                    "",
                    "Source: Owner Test",
                    "Status: Berhasil",
                ].join("\n"),
            })
            await sock.sendMessage(from, { text: "✅ Pesan test berhasil dikirim ke grup log." })
        } catch (error) {
            console.log(`[SECURITY LOG] Test send failed: ${shortError(error)}`)
            await sock.sendMessage(from, { text: `❌ Pesan test gagal dikirim: ${shortError(error)}` })
        }
        return true
    }

    if (["antidelete", "viewonce"].includes(action) && ["on", "off"].includes(args[1])) {
        const enabled = args[1] === "on"
        const feature = action === "antidelete" ? "antiDelete" : "viewOnce"
        try {
            setFeatureEnabled(feature, enabled)
            await sock.sendMessage(from, {
                text: `✅ ${action === "antidelete" ? "Anti-Delete" : "View Once"} Log: ${enabled ? "ON" : "OFF"}`,
            })
        } catch (error) {
            console.log(`[SECURITY LOG] Config update failed: ${shortError(error)}`)
            await sock.sendMessage(from, { text: `❌ Gagal menyimpan config: ${shortError(error)}` })
        }
        return true
    }

    await sock.sendMessage(from, {
        text: [
            ".securitylog status",
            ".securitylog test",
            ".securitylog antidelete on/off",
            ".securitylog viewonce on/off",
            "",
            "Alias: .seclog",
        ].join("\n"),
    })
    return true
}

module.exports = {
    SECURITY_MEDIA_LOG_JID: DEFAULT_SECURITY_MEDIA_LOG_JID,
    DEFAULT_SECURITY_MEDIA_LOG_JID,
    SECURITY_LOG_BUILD,
    getSecurityLogJid,
    getAntiDeleteLogJid,
    getViewOnceLogJid,
    isSecurityLogChat,
    getSecurityPayloadRoute,
    validateSecurityLogJid,
    sendAntiDeleteLog,
    sendViewOnceLog,
    getSecurityMediaLogHealth,
    handleSecurityLogCommand,
    isSecurityLogCommand,
    isAntiDeleteEnabled,
    isViewOnceEnabled,
    setFeatureEnabled,
    loadState,
}
