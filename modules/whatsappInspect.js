"use strict"

const groupCommon = require("./groupUtilityCommon")

const MAX_INLINE_JSON = 6000
const MAX_STRING = 1200
const MAX_ARRAY = 100
const MAX_OBJECT_KEYS = 200
const MAX_DEPTH = 10
const REDACT_KEY = /(?:secret|mediaKey|fileEncSha256|fileSha256|directPath|token|credential|password|passphrase|auth|noiseKey|signalKey|advSecretKey|pairing|session|cookie)/i
const BINARY_KEY = /(?:thumbnail|jpegThumbnail|binary|buffer|payload|ciphertext|stream)/i

function cleanText(value, max = 1500) {
    return String(value || "").replace(/[\0\r]/g, "").trim().slice(0, max)
}

function parseInviteLink(value) {
    const raw = cleanText(value, 1000)
    let url
    try { url = new URL(raw) } catch { return null }
    if (url.protocol !== "https:") return null
    const host = url.hostname.toLowerCase()
    if (!new Set(["chat.whatsapp.com", "www.chat.whatsapp.com"]).has(host)) return null
    const code = url.pathname.split("/").filter(Boolean)[0] || ""
    if (!/^[A-Za-z0-9_-]{12,64}$/.test(code)) return null
    return { type: "group_invite", code }
}

function sanitizedInviteInfo(info = {}) {
    const participants = Array.isArray(info.participants) ? info.participants : []
    const adminCount = participants.filter(item => item?.admin === "admin" || item?.admin === "superadmin").length
    return {
        type: "WhatsApp Group Invite",
        name: cleanText(info.subject || info.name || "-", 200),
        id: cleanText(info.id || info.jid || "-", 120),
        creator: cleanText(info.subjectOwner || info.owner || info.creator || "-", 120),
        description: cleanText(info.desc || info.description || "-", 1000),
        memberCount: Number(info.size ?? info.participantCount ?? participants.length ?? 0),
        adminCount,
        announcement: Boolean(info.announce || info.announcement),
        locked: Boolean(info.restrict || info.locked),
        joinApproval: Boolean(info.joinApprovalMode || info.membershipApprovalMode),
        communityParent: cleanText(info.linkedParent || info.parentGroupJid || info.parent || "-", 120),
    }
}

function formatInviteInfo(info) {
    return [
        "WHATSAPP INSPECT",
        `Type: ${info.type}`,
        `Name: ${info.name}`,
        `ID: ${info.id}`,
        `Creator: ${info.creator}`,
        `Description: ${info.description}`,
        `Member count: ${info.memberCount}`,
        `Admin count: ${info.adminCount}`,
        `Announcement: ${info.announcement ? "ON" : "OFF"}`,
        `Locked: ${info.locked ? "YES" : "NO"}`,
        `Join approval: ${info.joinApproval ? "ON" : "OFF"}`,
        `Community parent: ${info.communityParent}`,
        "",
        "Invite diperiksa tanpa join otomatis; kode/link tidak ditampilkan ulang.",
    ].join("\n")
}

function looksLikeLargeBase64(value) {
    return value.length > 512 && /^[A-Za-z0-9+/=_-]+$/.test(value)
}

function sanitizeMessageStructure(value, options = {}, seen = new WeakSet(), depth = 0, keyName = "") {
    if (REDACT_KEY.test(keyName)) return "[REDACTED]"
    if (BINARY_KEY.test(keyName)) return "[BINARY REDACTED]"
    if (value == null || typeof value === "boolean" || typeof value === "number") return value
    if (typeof value === "bigint") return String(value)
    if (typeof value === "string") {
        if (looksLikeLargeBase64(value)) return `[LARGE DATA REDACTED: ${value.length} chars]`
        return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[TRUNCATED]` : value
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[BINARY REDACTED: ${value.length} bytes]`
    if (typeof value !== "object") return `[${typeof value}]`
    if (depth >= Number(options.maxDepth || MAX_DEPTH)) return "[MAX DEPTH]"
    if (seen.has(value)) return "[CIRCULAR]"
    seen.add(value)
    if (Array.isArray(value)) {
        const limit = Number(options.maxArray || MAX_ARRAY)
        const output = value.slice(0, limit).map(item => sanitizeMessageStructure(item, options, seen, depth + 1, keyName))
        if (value.length > limit) output.push(`[${value.length - limit} ITEMS TRUNCATED]`)
        return output
    }
    const output = {}
    const entries = Object.entries(value)
    for (const [key, child] of entries.slice(0, Number(options.maxObjectKeys || MAX_OBJECT_KEYS))) {
        output[key] = sanitizeMessageStructure(child, options, seen, depth + 1, key)
    }
    if (entries.length > Number(options.maxObjectKeys || MAX_OBJECT_KEYS)) output.__truncatedKeys = entries.length - Number(options.maxObjectKeys || MAX_OBJECT_KEYS)
    return output
}

async function ensureGroupOutputAllowed(sock, msg, context = {}) {
    if (!context.isGroup) return true
    const access = await groupCommon.resolveCommandAccess(sock, msg, "groupUtilities", context, { allowAnySender: true })
    return access.allowed
}

async function handleInspectCommand(sock, msg, context = {}) {
    const text = cleanText(context.text, 5000)
    const root = text.split(/\s+/)[0].toLowerCase()
    if (![".inspect", ".inspectmsg", ".q"].includes(root)) return false

    if (root === ".inspect") {
        if (!(await ensureGroupOutputAllowed(sock, msg, context))) return true
        const target = parseInviteLink(text.replace(/^\.inspect\s*/i, ""))
        if (!target) {
            await sock.sendMessage(context.from, { text: "Format: .inspect https://chat.whatsapp.com/KODE" }, { quoted: msg })
            return true
        }
        try {
            const info = await sock.groupGetInviteInfo(target.code)
            await sock.sendMessage(context.from, { text: formatInviteInfo(sanitizedInviteInfo(info)) }, { quoted: msg })
        } catch (error) {
            await sock.sendMessage(context.from, { text: `Invite tidak dapat diperiksa: ${cleanText(error?.message || error, 180)}` }, { quoted: msg })
        }
        return true
    }

    if (context.isGroup) return true
    if (!context.isOwner) {
        await sock.sendMessage(context.from, { text: "Inspect message hanya untuk owner melalui private chat." }, { quoted: msg })
        return true
    }
    const quoted = groupCommon.getQuotedTarget(msg)
    if (!quoted) {
        await sock.sendMessage(context.from, { text: "Reply sebuah pesan lalu ketik .inspectmsg atau .q" }, { quoted: msg })
        return true
    }
    const sanitized = sanitizeMessageStructure(quoted)
    const json = JSON.stringify(sanitized, null, 2)
    if (json.length > Number(context.maxInlineJson || MAX_INLINE_JSON)) {
        await sock.sendMessage(context.from, {
            document: Buffer.from(json, "utf8"),
            mimetype: "application/json",
            fileName: `inspect-${cleanText(quoted.key?.id || "message", 80).replace(/[^a-z0-9_-]/gi, "") || "message"}.json`,
            caption: "Struktur pesan tersanitasi. Secret, key, token, directPath, dan binary telah direduksi.",
        }, { quoted: msg })
    } else {
        await sock.sendMessage(context.from, { text: `INSPECT MESSAGE (SANITIZED)\n\n${json}` }, { quoted: msg })
    }
    return true
}

module.exports = {
    MAX_INLINE_JSON,
    MAX_OBJECT_KEYS,
    formatInviteInfo,
    handleInspectCommand,
    parseInviteLink,
    sanitizeMessageStructure,
    sanitizedInviteInfo,
}
