"use strict"

function isEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.ROUTER_TRACE_ENABLED || "false").trim())
}

function clean(value, max = 120) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim()
    return text.length > max ? `${text.slice(0, max)}…` : text
}

function detectCommand(text) {
    const match = String(text || "").trim().match(/^([.!/#][^\s]+)/)
    return match ? match[1].toLowerCase() : ""
}

function detectPlatform(text) {
    const value = String(text || "").toLowerCase()
    if (!/https?:\/\//i.test(value)) return ""
    if (/spotify\.com/.test(value)) return "spotify"
    if (/tiktok\.com|vt\.tiktok\.com/.test(value)) return "tiktok"
    if (/instagram\.com/.test(value)) return "instagram"
    if (/youtube\.com|youtu\.be/.test(value)) return "youtube"
    if (/facebook\.com|fb\.watch/.test(value)) return "facebook"
    if (/pinterest\.|pin\.it/.test(value)) return "pinterest"
    if (/soundcloud\.com/.test(value)) return "soundcloud"
    if (/threads\.net/.test(value)) return "threads"
    return "link"
}

function trace(msg, context = {}) {
    if (!isEnabled()) return false
    const payload = {
        id: clean(msg?.key?.id, 80),
        remoteJid: clean(msg?.key?.remoteJid, 100),
        fromMe: Boolean(msg?.key?.fromMe),
        scope: context.scope || (String(msg?.key?.remoteJid || "").endsWith("@g.us") ? "group" : "private"),
        policy: context.policy,
        handler: context.handler,
        command: context.command || detectCommand(context.text),
        platform: context.platform || detectPlatform(context.text),
        handled: context.handled,
        skipped: context.skipped,
        reason: context.reason,
        error: context.error ? clean(context.error, 240) : undefined,
    }
    for (const key of Object.keys(payload)) {
        if (payload[key] === undefined || payload[key] === "") delete payload[key]
    }
    console.log("[ROUTER]", payload)
    return true
}

async function run(msg, context, handler, callback) {
    if (typeof callback !== "function") return false
    const startedAt = Date.now()
    try {
        const result = await callback()
        trace(msg, {
            ...(context || {}),
            handler,
            handled: Boolean(result?.handled ?? result),
            skipped: result === false || result == null,
            durationMs: Date.now() - startedAt,
        })
        return result
    } catch (error) {
        const message = clean(error?.message || error, 300)
        console.log(`[ROUTER] Handler ${handler} gagal: ${message}`)
        trace(msg, {
            ...(context || {}),
            handler,
            handled: false,
            skipped: true,
            reason: "handler-error",
            error: message,
        })
        if (/^(1|true|yes|on)$/i.test(String(process.env.ROUTER_TRACE_THROW_HANDLER_ERRORS || "false"))) {
            throw error
        }
        return false
    }
}

module.exports = {
    detectCommand,
    detectPlatform,
    isEnabled,
    run,
    trace,
}
