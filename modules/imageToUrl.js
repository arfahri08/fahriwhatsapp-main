"use strict"

const path = require("path")
const { downloadMediaMessage, generateWAMessageFromContent, proto } = require("@whiskeysockets/baileys")
const messageCleaner = require("./messageCleaner")

const CATBOX_UPLOAD_URL = "https://catbox.moe/user/api.php"

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

function detectMediaType(message = {}) {
    if (message.imageMessage) return "image"
    if (message.videoMessage) return "video"
    if (message.stickerMessage) return "sticker"
    if (message.documentMessage) return "document"
    return ""
}

function buildDirectTarget(msg, text = "") {
    const message = unwrapMessage(msg?.message || {})
    const mediaType = detectMediaType(message)
    if (!mediaType) return null

    const caption = message.imageMessage?.caption || message.videoMessage?.caption || message.documentMessage?.caption || text
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
    const media = message.imageMessage || message.videoMessage || message.stickerMessage || message.documentMessage || {}
    const fileName = String(media.fileName || "")
    const extFromName = path.extname(fileName).replace(/^\./, "").toLowerCase()
    if (extFromName) return extFromName

    const mime = String(media.mimetype || "").toLowerCase()
    if (mime.includes("png")) return "png"
    if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg"
    if (mime.includes("webp")) return "webp"
    if (mime.includes("gif")) return "gif"
    if (mime.includes("mp4")) return "mp4"
    if (mime.includes("mpeg")) return "mp3"
    if (mime.includes("pdf")) return "pdf"
    return targetMsg?.mediaType === "video" ? "mp4" : (targetMsg?.mediaType === "sticker" ? "webp" : "bin")
}

function inferMime(targetMsg) {
    const message = unwrapMessage(targetMsg?.message || {})
    const media = message.imageMessage || message.videoMessage || message.stickerMessage || message.documentMessage || {}
    if (media.mimetype) return media.mimetype
    if (targetMsg?.mediaType === "image") return "image/jpeg"
    if (targetMsg?.mediaType === "video") return "video/mp4"
    if (targetMsg?.mediaType === "sticker") return "image/webp"
    return "application/octet-stream"
}

async function uploadToCatbox(buffer, fileName, mimeType) {
    const form = new FormData()
    form.append("reqtype", "fileupload")
    form.append("fileToUpload", new Blob([buffer], { type: mimeType }), fileName)

    const response = await fetch(CATBOX_UPLOAD_URL, {
        method: "POST",
        body: form,
    })

    const text = String(await response.text()).trim()
    if (!response.ok) {
        throw new Error(`upload gagal (${response.status}): ${text.slice(0, 120)}`)
    }
    if (!/^https?:\/\//i.test(text)) {
        throw new Error(`respon upload tidak valid: ${text.slice(0, 160)}`)
    }
    return text
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
                content: [
                    {
                        tag: "native_flow",
                        attrs: { v: "9", name: "mixed" },
                    },
                ],
            },
            {
                tag: "quality_control",
                attrs: { source_type: "third_party" },
            },
        ],
    }
}

async function sendCopyButtonMessage(sock, jid, url, quoted) {
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
        footer: proto.Message.InteractiveMessage.Footer.create({ text: "Image to URL" }),
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
    try {
        await sock.sendPresenceUpdate("composing", from).catch(() => {})
        waitingMsg = await messageCleaner.sendTemporary(sock, from, "⏳ Sedang upload media ke URL...")

        const buffer = await downloadMediaMessage(targetMsg, "buffer", {}, {
            reuploadRequest: sock.updateMediaMessage,
        })
        const ext = inferExtension(targetMsg)
        const mime = inferMime(targetMsg)
        const fileName = `upload_${Date.now()}.${ext}`
        const url = await uploadToCatbox(buffer, fileName, mime)

        if (waitingMsg) {
            await messageCleaner.deleteMessageObject(sock, from, waitingMsg, "status Image to URL")
            waitingMsg = null
        }

        try {
            await sendCopyButtonMessage(sock, from, url, msg)
        } catch (interactiveError) {
            console.log(`[IMAGE TO URL] Gagal kirim tombol salin: ${interactiveError.message}`)
            await sock.sendMessage(from, {
                text: [
                    "✨ *BERHASIL UPLOAD*",
                    "",
                    "Ini link media kamu:",
                    url,
                    "",
                    "Salin link di atas ya.",
                ].join("\n"),
            }, { quoted: msg })
        }
    } catch (error) {
        console.log(`[IMAGE TO URL] Gagal upload media: ${error.message}`)
        if (waitingMsg) {
            await messageCleaner.deleteMessageObject(sock, from, waitingMsg, "status Image to URL")
        }
        await sock.sendMessage(from, {
            text: `Gagal upload media ke URL: ${error.message}`,
        }, { quoted: msg })
    }

    return true
}

module.exports = {
    handleImageToUrl,
    uploadToCatbox,
}
