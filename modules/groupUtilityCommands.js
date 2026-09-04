"use strict"

const groupRuntimePolicy = require("./groupRuntimePolicy")
const common = require("./groupUtilityCommon")

const FEATURE_NAME = "groupUtilities"
const COMMAND_PATTERN = /^(?:\.gcopen|\.open|\.gcclose|\.close|\.setnamegc|\.setdeskgc|\.setppgc|\.pin|\.poll|\.tagall|\.hidetag)(?:\s|$)/i
const SUBJECT_MAX = 100
const DESCRIPTION_MAX = 2048
const POLL_QUESTION_MAX = 255
const POLL_OPTION_MAX = 100

function isGroupUtilityCommand(text) {
    return COMMAND_PATTERN.test(String(text || "").trim())
}

async function sendPermissionDenied(sock, groupJid, msg) {
    await sock.sendMessage(groupJid, { text: "Perintah ini hanya untuk admin grup atau owner bot." }, { quoted: msg })
}

function buildParticipantMentions(metadata, sock, context = {}) {
    return common.dedupeParticipants(metadata, context, { sock, omitBot: true }).map(item => item.jid)
}

function parsePoll(text) {
    const raw = String(text || "").replace(/^\.poll\b/i, "").trim()
    const fields = raw.split("|").map(value => value.trim())
    let selectableCount = 1
    if (String(fields[0] || "").toLowerCase() === "multi") {
        selectableCount = 0
        fields.shift()
    }
    const name = String(fields.shift() || "").trim()
    const values = fields.join("|").split(",").map(value => value.trim()).filter(Boolean)
    return { name, values, selectableCount: selectableCount === 0 ? values.length : 1 }
}

function validatePoll(poll) {
    if (!poll.name) return "Pertanyaan poll wajib diisi."
    if (poll.name.length > POLL_QUESTION_MAX) return `Pertanyaan maksimal ${POLL_QUESTION_MAX} karakter.`
    if (poll.values.length < 2 || poll.values.length > 12) return "Poll harus memiliki 2 sampai 12 opsi."
    if (poll.values.some(value => value.length > POLL_OPTION_MAX)) return `Setiap opsi maksimal ${POLL_OPTION_MAX} karakter.`
    if (new Set(poll.values).size !== poll.values.length) return "Opsi poll tidak boleh duplikat persis."
    return ""
}

function buildHidetagMediaContent(descriptor, buffer, text, mentions) {
    const media = descriptor.media || {}
    if (descriptor.type === "imageMessage") return { image: buffer, caption: text || String(media.caption || ""), mentions }
    if (descriptor.type === "videoMessage") return { video: buffer, caption: text || String(media.caption || ""), mimetype: media.mimetype, mentions }
    if (descriptor.type === "audioMessage") return { audio: buffer, mimetype: media.mimetype || "audio/ogg; codecs=opus", ptt: Boolean(media.ptt), mentions }
    if (descriptor.type === "stickerMessage") return { sticker: buffer, mentions }
    if (descriptor.type === "documentMessage") {
        return {
            document: buffer,
            mimetype: media.mimetype || "application/octet-stream",
            fileName: media.fileName || "dokumen",
            caption: text || String(media.caption || ""),
            mentions,
        }
    }
    return null
}

async function handleGroupOpenClose(sock, msg, access, command) {
    const shouldOpen = command === ".gcopen" || command === ".open"
    const alreadyDesired = shouldOpen
        ? access.policy.metadata?.announce === false
        : access.policy.metadata?.announce === true
    if (alreadyDesired) {
        await sock.sendMessage(access.groupJid, {
            text: shouldOpen ? "Grup sudah terbuka untuk semua anggota." : "Grup sudah tertutup (hanya admin yang dapat mengirim).",
        }, { quoted: msg })
        return true
    }
    await sock.groupSettingUpdate(access.groupJid, shouldOpen ? "not_announcement" : "announcement")
    await sock.sendMessage(access.groupJid, {
        text: shouldOpen ? "Grup berhasil dibuka untuk semua anggota." : "Grup berhasil ditutup. Hanya admin yang dapat mengirim pesan.",
    }, { quoted: msg })
    return true
}

async function handleProfileCommand(sock, msg, access, command, argument, context) {
    if (command === ".setnamegc") {
        const subject = argument.trim()
        if (!subject) {
            await sock.sendMessage(access.groupJid, { text: "Format: .setnamegc <nama grup>" }, { quoted: msg })
            return true
        }
        if (subject.length > SUBJECT_MAX) {
            await sock.sendMessage(access.groupJid, { text: `Nama grup maksimal ${SUBJECT_MAX} karakter.` }, { quoted: msg })
            return true
        }
        await sock.groupUpdateSubject(access.groupJid, subject)
        await sock.sendMessage(access.groupJid, { text: "Nama grup berhasil diperbarui." }, { quoted: msg })
        return true
    }

    if (command === ".setdeskgc") {
        const description = /^clear$/i.test(argument.trim()) ? "" : argument.trim()
        if (!argument.trim()) {
            await sock.sendMessage(access.groupJid, { text: "Format: .setdeskgc <deskripsi> atau .setdeskgc clear" }, { quoted: msg })
            return true
        }
        if (description.length > DESCRIPTION_MAX) {
            await sock.sendMessage(access.groupJid, { text: `Deskripsi maksimal ${DESCRIPTION_MAX} karakter.` }, { quoted: msg })
            return true
        }
        await sock.groupUpdateDescription(access.groupJid, description)
        await sock.sendMessage(access.groupJid, { text: description ? "Deskripsi grup berhasil diperbarui." : "Deskripsi grup berhasil dihapus." }, { quoted: msg })
        return true
    }

    const descriptor = common.getMediaDescriptor(msg, { preferQuoted: true })
    if (!descriptor || descriptor.type !== "imageMessage") {
        await sock.sendMessage(access.groupJid, { text: "Reply gambar atau kirim gambar dengan caption .setppgc." }, { quoted: msg })
        return true
    }
    try {
        const buffer = await common.downloadMedia(sock, descriptor, context)
        await sock.updateProfilePicture(access.groupJid, buffer)
        await sock.sendMessage(access.groupJid, { text: "Foto profil grup berhasil diperbarui." }, { quoted: msg })
    } catch (error) {
        await sock.sendMessage(access.groupJid, { text: `Foto profil gagal diperbarui: ${String(error?.message || error).slice(0, 180)}` }, { quoted: msg })
    }
    return true
}

async function handlePin(sock, msg, access, argument) {
    const quoted = common.getQuotedTarget(msg)
    if (!quoted?.key?.id) {
        await sock.sendMessage(access.groupJid, { text: "Reply pesan yang ingin dipin. Contoh: .pin 24" }, { quoted: msg })
        return true
    }
    const hours = argument.trim() ? Number(argument.trim()) : 24
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
        await sock.sendMessage(access.groupJid, { text: "Durasi pin harus berupa 1 sampai 720 jam." }, { quoted: msg })
        return true
    }
    const botCandidates = groupRuntimePolicy.getBotIdentityCandidates(sock)
    const quotedParticipant = quoted.key.participant || common.getContextInfo(msg).participant
    const pinKey = {
        remoteJid: access.groupJid,
        id: quoted.key.id,
        participant: quotedParticipant,
        fromMe: botCandidates.some(candidate => groupRuntimePolicy.jidUser(candidate) === groupRuntimePolicy.jidUser(quotedParticipant)),
    }
    await sock.sendMessage(access.groupJid, { pin: pinKey, type: 1, time: hours * 3600 })
    return true
}

async function handlePoll(sock, msg, access, text) {
    const poll = parsePoll(text)
    const error = validatePoll(poll)
    if (error) {
        await sock.sendMessage(access.groupJid, {
            text: `${error}\nFormat: .poll Pertanyaan | Opsi 1, Opsi 2\nMulti: .poll multi | Pertanyaan | Opsi 1, Opsi 2`,
        }, { quoted: msg })
        return true
    }
    await sock.sendMessage(access.groupJid, { poll })
    return true
}

async function handleTagall(sock, msg, access, argument) {
    const mentions = buildParticipantMentions(access.policy.metadata, sock, access.context)
    const labels = mentions.map(jid => `@${groupRuntimePolicy.jidUser(jid)}`).join(" ")
    const prefix = argument.trim()
    const text = [prefix, labels].filter(Boolean).join("\n") || "Tag semua anggota"
    await sock.sendMessage(access.groupJid, { text, mentions }, { quoted: msg })
    return true
}

async function handleHidetag(sock, msg, access, argument, context) {
    const mentions = buildParticipantMentions(access.policy.metadata, sock, access.context)
    const descriptor = common.getMediaDescriptor(msg, { preferQuoted: true })
    if (descriptor) {
        try {
            const buffer = await common.downloadMedia(sock, descriptor, context)
            const content = buildHidetagMediaContent(descriptor, buffer, argument.trim(), mentions)
            await sock.sendMessage(access.groupJid, content, { quoted: msg })
        } catch (error) {
            await sock.sendMessage(access.groupJid, { text: `Media hidetag gagal diproses: ${String(error?.message || error).slice(0, 180)}` }, { quoted: msg })
        }
        return true
    }
    const quotedText = common.extractQuotedText(msg)
    const text = argument.trim() || quotedText
    if (!text) {
        await sock.sendMessage(access.groupJid, { text: "Format: .hidetag <teks>, atau reply teks/media." }, { quoted: msg })
        return true
    }
    await sock.sendMessage(access.groupJid, { text, mentions }, { quoted: msg })
    return true
}

async function handleGroupUtilityCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    if (!isGroupUtilityCommand(text)) return false
    const command = text.split(/\s+/)[0].toLowerCase()
    const argument = text.slice(command.length).trim()
    const access = await common.resolveCommandAccess(sock, msg, FEATURE_NAME, context)
    if (access.hardDenied) return true
    if (!access.allowed) {
        await sendPermissionDenied(sock, access.groupJid, msg)
        return true
    }
    access.context = context

    try {
        if ([".gcopen", ".open", ".gcclose", ".close"].includes(command)) {
            return handleGroupOpenClose(sock, msg, access, command)
        }
        if ([".setnamegc", ".setdeskgc", ".setppgc"].includes(command)) {
            return handleProfileCommand(sock, msg, access, command, argument, context)
        }
        if (command === ".pin") return handlePin(sock, msg, access, argument)
        if (command === ".poll") return handlePoll(sock, msg, access, text)
        if (command === ".tagall") return handleTagall(sock, msg, access, argument)
        if (command === ".hidetag") return handleHidetag(sock, msg, access, argument, context)
    } catch (error) {
        console.log("[GROUP UTILITY] Command gagal", {
            groupJid: access.groupJid,
            command,
            error: String(error?.message || error).slice(0, 240),
        })
        await sock.sendMessage(access.groupJid, { text: `Perintah gagal dijalankan: ${String(error?.message || error).slice(0, 180)}` }, { quoted: msg })
        return true
    }
    return false
}

module.exports = {
    DESCRIPTION_MAX,
    FEATURE_NAME,
    POLL_OPTION_MAX,
    POLL_QUESTION_MAX,
    SUBJECT_MAX,
    buildHidetagMediaContent,
    buildParticipantMentions,
    handleGroupUtilityCommand,
    isGroupUtilityCommand,
    parsePoll,
    validatePoll,
}
