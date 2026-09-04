"use strict"

const callHandler = require("./callHandler")
const { spawn } = require("child_process")

const LANGUAGE_ALIASES = new Map([
    ["id", "id"], ["indonesia", "id"], ["indonesian", "id"],
    ["jv", "jv"], ["jawa", "jv"], ["javanese", "jv"],
    ["su", "su"], ["sunda", "su"], ["sundanese", "su"],
    ["ms", "ms"], ["melayu", "ms"], ["malay", "ms"],
    ["en", "en"], ["inggris", "en"], ["english", "en"],
    ["ar", "ar"], ["arab", "ar"], ["arabic", "ar"],
    ["ja", "ja"], ["jepang", "ja"], ["japanese", "ja"],
    ["ko", "ko"], ["korea", "ko"], ["korean", "ko"],
    ["zh", "zh-cn"], ["zh-cn", "zh-cn"], ["mandarin", "zh-cn"], ["chinese", "zh-cn"],
    ["es", "es"], ["spanyol", "es"], ["spanish", "es"],
    ["de", "de"], ["jerman", "de"], ["german", "de"],
    ["fr", "fr"], ["prancis", "fr"], ["french", "fr"],
    ["nl", "nl"], ["belanda", "nl"], ["dutch", "nl"],
    ["ru", "ru"], ["rusia", "ru"], ["russian", "ru"],
    ["hi", "hi"], ["hindi", "hi"], ["th", "th"], ["thai", "th"],
])

function unwrapMessage(message) {
    let current = message || {}
    for (let index = 0; index < 8; index += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
        else if (current.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message
        else break
    }
    return current || {}
}

function extractMessageText(message) {
    const current = unwrapMessage(message)
    return String(
        current.conversation
        || current.extendedTextMessage?.text
        || current.imageMessage?.caption
        || current.videoMessage?.caption
        || current.documentMessage?.caption
        || current.buttonsResponseMessage?.selectedDisplayText
        || current.listResponseMessage?.title
        || ""
    ).normalize("NFKC").replace(/\s+/g, " ").trim()
}

function getContextInfo(msg) {
    const message = unwrapMessage(msg?.message || {})
    return message.extendedTextMessage?.contextInfo
        || message.imageMessage?.contextInfo
        || message.videoMessage?.contextInfo
        || message.documentMessage?.contextInfo
        || {}
}

function getQuotedText(msg) {
    return extractMessageText(getContextInfo(msg).quotedMessage || {})
}

function resolveLanguage(value) {
    const clean = String(value || "").trim().toLowerCase().replace(/_/g, "-")
    if (!clean) return "id"
    return LANGUAGE_ALIASES.get(clean) || (/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(clean) ? clean : "")
}


const RANDOM_TTS_PROFILES = [
    { name: "natural", filters: [] },
    { name: "hangat", filters: ["asetrate=44100*1.035,aresample=44100,atempo=1/1.035"] },
    { name: "rendah", filters: ["asetrate=44100*0.94,aresample=44100,atempo=1/0.94"] },
    { name: "ceria", filters: ["asetrate=44100*1.065,aresample=44100,atempo=1/1.065"] },
    { name: "pelan", filters: ["atempo=0.92"] },
    { name: "cepat", filters: ["atempo=1.08"] },
]

function pickRandomVoiceProfile() {
    return RANDOM_TTS_PROFILES[Math.floor(Math.random() * RANDOM_TTS_PROFILES.length)]
}

function runFfmpegBuffer(input, filters = []) {
    return new Promise((resolve, reject) => {
        if (!filters.length) return resolve(input)
        const ffmpeg = String(process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg").trim() || "ffmpeg"
        const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0"]
        args.push("-filter:a", filters.join(","), "-c:a", "libopus", "-b:a", "64k", "-vbr", "on", "-application", "voip", "-f", "ogg", "pipe:1")
        const child = spawn(ffmpeg, args, { windowsHide: true })
        const out=[]; const err=[]
        child.stdout.on("data", d=>out.push(Buffer.from(d)))
        child.stderr.on("data", d=>err.push(Buffer.from(d)))
        child.on("error", reject)
        child.on("close", code => {
            if (code !== 0) return reject(new Error(Buffer.concat(err).toString("utf8").trim().slice(-500) || `ffmpeg exit ${code}`))
            const audio=Buffer.concat(out)
            if (!audio.length) return reject(new Error("FFmpeg tidak menghasilkan audio"))
            resolve(audio)
        })
        child.stdin.end(input)
    })
}

async function randomizeTtsContent(content) {
    const profile = pickRandomVoiceProfile()
    if (!profile.filters.length || !Buffer.isBuffer(content?.audio)) return { ...content, ttsVoiceProfile: profile.name }
    try {
        const audio = await runFfmpegBuffer(content.audio, profile.filters)
        return { ...content, audio, mimetype: "audio/ogg; codecs=opus", ptt: true, ttsVoiceProfile: profile.name }
    } catch (error) {
        console.log(`[TTS] Random voice ${profile.name} dilewati: ${String(error.message || error).slice(0,140)}`)
        return { ...content, ttsVoiceProfile: "natural" }
    }
}


function parseTtsCommand(value) {
    const text = String(value || "").trim()
    const match = /^\.tts(?:\s+([\s\S]*))?$/i.exec(text)
    if (!match) return null

    let input = String(match[1] || "").trim()
    let language = "id"
    let invalidLanguage = ""
    const languageMatch = /^--(?:lang|language)(?:=|\s+)([^\s]+)(?:\s+([\s\S]*))?$/i.exec(input)
    if (languageMatch) {
        language = resolveLanguage(languageMatch[1])
        if (!language) invalidLanguage = languageMatch[1]
        input = String(languageMatch[2] || "").trim()
    }

    return { input, language: language || "id", invalidLanguage }
}

function usageText(maxCharacters = callHandler.getTtsMaxCharacters()) {
    return [
        "ðŸŽ™ï¸ *TEXT TO VOICE NOTE*",
        "",
        "`.tts Halo, apa kabar?`",
        "atau reply pesan teks lalu kirim `.tts`.",
        "",
        "Bahasa lain: `.tts --lang en Hello everyone`",
        "Contoh kode: `id`, `jv`, `su`, `en`, `ms`, `ar`, `ja`, `ko`, `zh-cn`, `es`, `de`, `fr`.",
        `Maksimal ${maxCharacters} karakter.`,
    ].join("\n")
}

function friendlyError(error) {
    const detail = String(error?.message || error || "")
    if (error?.code === "TTS_TEXT_TOO_LONG" || /maksimal\s+\d+\s+karakter/i.test(detail)) return `âŒ ${detail}`
    if (error?.code === "TTS_VOICE_NOTE_CONVERSION_FAILED" || /ffmpeg|libopus|voice note/i.test(detail)) {
        return "âŒ TTS berhasil dibuat, tetapi belum bisa dijadikan VN. Pastikan FFmpeg dengan codec libopus sudah terpasang."
    }
    return "âŒ TTS sedang gagal membuat Voice Note. Coba lagi beberapa saat nanti."
}

async function handleTextToSpeech(sock, msg, context = {}) {
    const replyJid = String(context.from || msg?.key?.remoteJid || "").trim()
    const sender = String(context.senderJid || context.sender || replyJid || "").trim().toLowerCase()
    const incomingText = context.text || extractMessageText(msg?.message || "")
    const parsed = parseTtsCommand(incomingText)
    if (!parsed) return false

    if (!replyJid) return true
    if (parsed.invalidLanguage) {
        await sock.sendMessage(replyJid, { text: `âŒ Kode bahasa \`${parsed.invalidLanguage}\` tidak valid.\n\n${usageText()}` }, { quoted: msg })
        return true
    }

    const spokenText = parsed.input || getQuotedText(msg)
    if (!spokenText) {
        await sock.sendMessage(replyJid, { text: usageText() }, { quoted: msg })
        return true
    }

    const maxCharacters = callHandler.getTtsMaxCharacters()
    if (spokenText.length > maxCharacters) {
        await sock.sendMessage(replyJid, {
            text: `âŒ Teks terlalu panjang. Maksimal ${maxCharacters} karakter.`,
        }, { quoted: msg })
        return true
    }

    try {
        const createVoiceNote = typeof context.createTtsVoiceNoteContent === "function"
            ? context.createTtsVoiceNoteContent
            : callHandler.createTtsVoiceNoteContent
        let content = await createVoiceNote(spokenText, { language: parsed.language })
        content = await randomizeTtsContent(content)
        if (!Buffer.isBuffer(content?.audio) || content.ptt !== true) {
            throw new Error("Provider TTS tidak menghasilkan Voice Note OGG/Opus")
        }
        await sock.sendMessage(replyJid, {
            ...content,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
        }, { quoted: msg })
    } catch (error) {
        console.log(`[TTS COMMAND] Gagal: ${String(error?.message || error).replace(/\s+/g, " ").slice(0, 200)}`)
        await sock.sendMessage(replyJid, { text: friendlyError(error) }, { quoted: msg })
    }

    return true
}

module.exports = {
    extractMessageText,
    getQuotedText,
    handleTextToSpeech,
    parseTtsCommand,
    resolveLanguage,
    usageText,
    pickRandomVoiceProfile,
}

