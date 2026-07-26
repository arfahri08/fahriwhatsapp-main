"use strict"

const path = require("path")
const axios = require("axios")
const FormData = require("form-data")
const {
    downloadMediaMessage,
    downloadContentFromMessage,
    generateWAMessageFromContent,
    proto,
} = require("@whiskeysockets/baileys")
const messageCleaner = require("./messageCleaner")

const HOSTIFY_UPLOAD_URL = "https://upload.hostify.indevs.in/api/upload"
const UGUU_UPLOAD_URL = "https://uguu.se/upload"
const UPLOAD_TIMEOUT_MS = Math.max(15000, Number(process.env.IMAGE_TO_URL_TIMEOUT_MS || 60000))

function unwrapMessage(message) {
    let current = message || {}
    for (let i = 0; i < 8; i += 1) {
        if (current?.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current?.viewOnceMessage?.message) current = current.viewOnceMessage.message
        else if (current?.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
        else if (current?.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message
        else if (current?.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message
        else break
    }
    return current || {}
}

function getCommandText(msg, fallbackText = "") {
    const message = unwrapMessage(msg?.message || {})
    return String(
        fallbackText
        || message.conversation
        || message.extendedTextMessage?.text
        || message.imageMessage?.caption
        || message.videoMessage?.caption
        || message.documentMessage?.caption
        || ""
    ).trim()
}

function isToUrlCommand(text) {
    return /^\.tourl(?:\s|$)/i.test(String(text || "").trim())
}

function detectMediaType(message = {}) {
    if (message.imageMessage) return "image"
    if (message.videoMessage) return "video"
    if (message.stickerMessage) return "sticker"
    if (message.documentMessage) return "document"
    return ""
}

function getMediaNode(message = {}) {
    return message.imageMessage
        || message.videoMessage
        || message.stickerMessage
        || message.documentMessage
        || null
}

function buildQuotedTarget(msg) {
    const message = unwrapMessage(msg?.message || {})
    const contextInfo =
        message.extendedTextMessage?.contextInfo
        || message.imageMessage?.contextInfo
        || message.videoMessage?.contextInfo
        || message.documentMessage?.contextInfo
        || message.stickerMessage?.contextInfo
        || {}

    const quoted = unwrapMessage(contextInfo.quotedMessage || {})
    const mediaType = detectMediaType(quoted)
    if (!mediaType) return null

    return {
        key: {
            remoteJid: contextInfo.remoteJid || msg?.key?.remoteJid,
            id: contextInfo.stanzaId,
            participant: contextInfo.participant,
            fromMe: false,
        },
        message: quoted,
        mediaType,
    }
}

function buildDirectTarget(msg, text = "") {
    const message = unwrapMessage(msg?.message || {})
    const mediaType = detectMediaType(message)
    if (!mediaType) return null

    const caption = message.imageMessage?.caption
        || message.videoMessage?.caption
        || message.documentMessage?.caption
        || text
    if (!isToUrlCommand(caption)) return null

    return {
        ...msg,
        message,
        mediaType,
    }
}

function getTargetMessage(msg, text = "") {
    return buildDirectTarget(msg, text) || (isToUrlCommand(text) ? buildQuotedTarget(msg) : null)
}

function inferExtension(targetMsg) {
    const message = unwrapMessage(targetMsg?.message || {})
    const media = getMediaNode(message) || {}
    const fileName = String(media.fileName || "")
    const extFromName = path.extname(fileName).replace(/^\./, "").toLowerCase()
    if (extFromName) return extFromName

    const mime = String(media.mimetype || "").toLowerCase()
    if (mime.includes("png")) return "png"
    if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg"
    if (mime.includes("webp")) return "webp"
    if (mime.includes("gif")) return "gif"
    if (mime.includes("avif")) return "avif"
    if (mime.includes("mp4")) return "mp4"
    if (mime.includes("quicktime")) return "mov"
    if (mime.includes("webm")) return "webm"
    if (mime.includes("mpeg")) return "mp3"
    if (mime.includes("pdf")) return "pdf"
    return targetMsg?.mediaType === "video"
        ? "mp4"
        : (targetMsg?.mediaType === "sticker" ? "webp" : "bin")
}

function inferMime(targetMsg) {
    const message = unwrapMessage(targetMsg?.message || {})
    const media = getMediaNode(message) || {}
    if (media.mimetype) return media.mimetype
    if (targetMsg?.mediaType === "image") return "image/jpeg"
    if (targetMsg?.mediaType === "video") return "video/mp4"
    if (targetMsg?.mediaType === "sticker") return "image/webp"
    return "application/octet-stream"
}

function safeFileName(value) {
    const clean = String(value || "upload.bin")
        .replace(/[^A-Za-z0-9._-]/g, "_")
        .replace(/^\.+/, "")
        .slice(-120)
    return clean || `upload_${Date.now()}.bin`
}

function normalizeHttpUrl(value) {
    const raw = String(value || "").trim().replace(/^['"]|['"]$/g, "")
    if (!/^https?:\/\//i.test(raw)) return ""
    try {
        const parsed = new URL(raw)
        if (!parsed.hostname || !parsed.pathname) return ""
        return parsed.toString()
    } catch {
        return ""
    }
}

function collectResponseCandidates(value, output = [], depth = 0) {
    if (depth > 8 || value == null) return output
    if (typeof value === "string" || typeof value === "number") {
        output.push(String(value))
        return output
    }
    if (Array.isArray(value)) {
        for (const item of value) collectResponseCandidates(item, output, depth + 1)
        return output
    }
    if (typeof value === "object") {
        const preferredKeys = [
            "direct_url", "directUrl", "secure_url", "secureUrl", "download_url", "downloadUrl",
            "file_url", "fileUrl", "url", "link", "location", "src", "path",
        ]
        for (const key of preferredKeys) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                collectResponseCandidates(value[key], output, depth + 1)
            }
        }
        for (const [key, item] of Object.entries(value)) {
            if (!preferredKeys.includes(key)) collectResponseCandidates(item, output, depth + 1)
        }
    }
    return output
}

function extractFirstHttpUrl(data, headers = {}) {
    const candidates = [headers.location, headers.Location, ...collectResponseCandidates(data)]
    for (const candidate of candidates) {
        const direct = normalizeHttpUrl(candidate)
        if (direct) return direct

        const embedded = String(candidate || "").match(/https?:\/\/[^\s"'<>\\]+/i)
        if (embedded) {
            const normalized = normalizeHttpUrl(embedded[0])
            if (normalized) return normalized
        }
    }
    return ""
}

function makeUploadForm(fieldName, buffer, fileName, mimeType) {
    const form = new FormData()
    form.append(fieldName, buffer, {
        filename: safeFileName(fileName),
        contentType: mimeType || "application/octet-stream",
        knownLength: buffer.length,
    })
    return form
}

function responsePreview(data) {
    const text = typeof data === "string" ? data : JSON.stringify(data || {})
    return text.replace(/\s+/g, " ").trim().slice(0, 220)
}

async function postMultipart(endpoint, fieldName, buffer, fileName, mimeType) {
    const form = makeUploadForm(fieldName, buffer, fileName, mimeType)
    return axios.post(endpoint, form, {
        headers: {
            ...form.getHeaders(),
            Accept: "application/json, text/plain, */*",
            "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36",
        },
        timeout: UPLOAD_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
    })
}

async function uploadToHostify(buffer, fileName, mimeType) {
    const response = await postMultipart(HOSTIFY_UPLOAD_URL, "file", buffer, fileName, mimeType)
    const url = extractFirstHttpUrl(response.data, response.headers)
    if (response.status >= 200 && response.status < 300 && url) return url

    throw new Error(`Hostify HTTP ${response.status}: ${responsePreview(response.data) || "tanpa URL"}`)
}

async function uploadToUguu(buffer, fileName, mimeType) {
    const response = await postMultipart(UGUU_UPLOAD_URL, "files[]", buffer, fileName, mimeType)
    const url = extractFirstHttpUrl(response.data, response.headers)
    if (response.status >= 200 && response.status < 300 && url) return url

    throw new Error(`Uguu HTTP ${response.status}: ${responsePreview(response.data) || "tanpa URL"}`)
}

function getProviderOrder() {
    const preferred = String(process.env.IMAGE_TO_URL_PROVIDER || "hostify").trim().toLowerCase()
    if (preferred === "uguu") return ["uguu", "hostify"]
    return ["hostify", "uguu"]
}

async function uploadMedia(buffer, fileName, mimeType) {
    const errors = []
    for (const provider of getProviderOrder()) {
        try {
            if (provider === "hostify") {
                return { url: await uploadToHostify(buffer, fileName, mimeType), provider: "Hostify" }
            }
            if (provider === "uguu") {
                return { url: await uploadToUguu(buffer, fileName, mimeType), provider: "Uguu" }
            }
        } catch (error) {
            const message = String(error?.message || error)
            errors.push(message)
            console.log(`[IMAGE TO URL] ${provider} gagal: ${message}`)
        }
    }

    throw new Error(errors.join(" | ") || "semua provider upload gagal")
}

async function downloadTargetBuffer(sock, targetMsg) {
    try {
        return await downloadMediaMessage(targetMsg, "buffer", {}, {
            reuploadRequest: sock.updateMediaMessage,
        })
    } catch (firstError) {
        const message = unwrapMessage(targetMsg?.message || {})
        const media = getMediaNode(message)
        const mediaType = targetMsg?.mediaType || detectMediaType(message)
        if (!media || !mediaType) throw firstError

        try {
            const stream = await downloadContentFromMessage(media, mediaType)
            const chunks = []
            for await (const chunk of stream) chunks.push(chunk)
            const buffer = Buffer.concat(chunks)
            if (!buffer.length) throw new Error("buffer media kosong")
            return buffer
        } catch (fallbackError) {
            throw new Error(`downloadMediaMessage: ${firstError.message}; fallback stream: ${fallbackError.message}`)
        }
    }
}

function getPrivacyModeTs() {
    const offset = 77980457
    return String(Math.floor(Date.now() / 1000) - offset)
}

function buildMixedNativeFlowBizNode() {
    return {
        tag: "biz",
        attrs: {
            actual_actors: "2",
            host_storage: "2",
            privacy_mode_ts: getPrivacyModeTs(),
        },
        content: [
            {
                tag: "interactive",
                attrs: { type: "native_flow", v: "1" },
                content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }],
            },
            { tag: "quality_control", attrs: { source_type: "third_party" } },
        ],
    }
}

async function sendCopyButtonMessage(sock, jid, url, quoted, provider = "Image to URL") {
    if (typeof generateWAMessageFromContent !== "function" || !proto?.Message?.InteractiveMessage) {
        throw new Error("InteractiveMessage tidak tersedia")
    }
    const interactiveMessage = proto.Message.InteractiveMessage.create({
        body: proto.Message.InteractiveMessage.Body.create({
            text: [
                "✨ *BERHASIL UPLOAD*",
                "",
                "Ini link media kamu:",
                url,
                "",
                "Tekan tombol di bawah untuk menyalin link.",
            ].join("\n"),
        }),
        footer: proto.Message.InteractiveMessage.Footer.create({ text: `Image to URL • ${provider}` }),
        header: proto.Message.InteractiveMessage.Header.create({
            title: "UPLOAD VIA BOT",
            hasMediaAttachment: false,
        }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: [
                proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton?.create
                    ? proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton.create({
                        name: "cta_copy",
                        buttonParamsJson: JSON.stringify({
                            display_text: "Salin Link",
                            id: "copy_media_url",
                            copy_code: url,
                        }),
                    })
                    : {
                        name: "cta_copy",
                        buttonParamsJson: JSON.stringify({
                            display_text: "Salin Link",
                            id: "copy_media_url",
                            copy_code: url,
                        }),
                    },
            ],
            messageParamsJson: "{}",
            messageVersion: 1,
        }),
    })

    const generated = generateWAMessageFromContent(jid, { interactiveMessage }, {
        userJid: sock?.user?.id,
        quoted,
    })
    await sock.relayMessage(jid, generated.message, {
        messageId: generated.key.id,
        additionalNodes: [buildMixedNativeFlowBizNode()],
    })
    return true
}

async function handleImageToUrl(sock, msg, context = {}) {
    const from = context.from || msg?.key?.remoteJid
    const text = getCommandText(msg, context.text)
    if (!isToUrlCommand(text) && !buildDirectTarget(msg, text)) return false

    const targetMsg = getTargetMessage(msg, text)
    if (!targetMsg) {
        await sock.sendMessage(from, {
            text: [
                "🖼️ *IMAGE TO URL*",
                "",
                "Cara pakai:",
                "• kirim gambar/video dengan caption *.tourl*",
                "• atau reply gambar/stiker/video lalu ketik *.tourl*",
            ].join("\n"),
        }, { quoted: msg })
        return true
    }

    let waitingMsg = null
    let stage = "mengunduh media WhatsApp"
    try {
        await sock.sendPresenceUpdate("composing", from).catch(() => {})
        waitingMsg = await messageCleaner.sendTemporary(sock, from, "⏳ Sedang upload media ke URL...")

        const buffer = await downloadTargetBuffer(sock, targetMsg)
        const ext = inferExtension(targetMsg)
        const mime = inferMime(targetMsg)
        const fileName = `upload_${Date.now()}.${ext}`

        stage = "mengunggah ke hosting"
        const uploaded = await uploadMedia(buffer, fileName, mime)

        if (waitingMsg) {
            await messageCleaner.deleteMessageObject(sock, from, waitingMsg, "status Image to URL")
            waitingMsg = null
        }

        try {
            await sendCopyButtonMessage(sock, from, uploaded.url, msg, uploaded.provider)
        } catch (interactiveError) {
            console.log(`[IMAGE TO URL] Gagal kirim tombol salin: ${interactiveError.message}`)
            await sock.sendMessage(from, {
                text: [
                    "✨ *BERHASIL UPLOAD*",
                    "",
                    `Provider: *${uploaded.provider}*`,
                    "Ini link media kamu:",
                    uploaded.url,
                    "",
                    "Salin link di atas ya.",
                ].join("\n"),
            }, { quoted: msg })
        }
    } catch (error) {
        console.log(`[IMAGE TO URL] Gagal pada tahap ${stage}: ${error.message}`)
        if (waitingMsg) {
            await messageCleaner.deleteMessageObject(sock, from, waitingMsg, "status Image to URL")
        }
        await sock.sendMessage(from, {
            text: `Gagal Image to URL pada tahap ${stage}: ${error.message}`.slice(0, 1500),
        }, { quoted: msg })
    }

    return true
}

module.exports = {
    collectResponseCandidates,
    extractFirstHttpUrl,
    getProviderOrder,
    handleImageToUrl,
    normalizeHttpUrl,
    uploadMedia,
    uploadToHostify,
    uploadToUguu,
}
