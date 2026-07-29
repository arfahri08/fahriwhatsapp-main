"use strict"

const sessions = new Map()
const DEFAULT_TTL_MS = 30 * 60 * 1000

function getTtlMs() {
    const value = Number(process.env.REMINDER_FLOW_TTL_MS || DEFAULT_TTL_MS)
    return Number.isFinite(value) && value >= 60000 ? value : DEFAULT_TTL_MS
}

function normalizeKey(value) {
    return String(value || "").trim().toLowerCase()
}

function getJidNumber(value) {
    return String(value || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "")
}

function normalizeNumber(value) {
    let number = getJidNumber(value)
    if (!number) return ""
    if (number.startsWith("0")) number = `62${number.slice(1)}`
    else if (number.startsWith("8")) number = `62${number}`
    return number.length >= 9 && number.length <= 16 ? number : ""
}

function normalizeTarget(target = {}) {
    const number = normalizeNumber(target.number || target.jid || target)
    if (!number) return null
    const label = String(target.label || number).replace(/[\r\n\t]+/g, " ").trim().slice(0, 100) || number
    return {
        jid: `${number}@s.whatsapp.net`,
        number,
        label,
        source: String(target.source || "unknown").slice(0, 40),
    }
}

function uniqueTargets(targets = []) {
    const seen = new Set()
    const result = []
    for (const raw of targets) {
        const target = normalizeTarget(raw)
        if (!target || seen.has(target.number)) continue
        seen.add(target.number)
        result.push(target)
    }
    return result
}

function unwrapMessage(message) {
    let current = message || {}
    for (let index = 0; index < 8; index += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message
        else break
    }
    return current || {}
}

function getContactEntries(message) {
    const current = unwrapMessage(message)
    if (current.contactMessage) return [current.contactMessage]
    if (Array.isArray(current.contactsArrayMessage?.contacts)) return current.contactsArrayMessage.contacts
    return []
}

function extractNumbersFromVcard(vcard) {
    const text = String(vcard || "")
    const waids = [...text.matchAll(/waid=(\d+)/gi)].map(match => match[1])
    const telLines = text
        .split(/\r?\n/)
        .filter(line => /^TEL/i.test(line))
        .map(line => line.split(":").slice(1).join(":"))
    const generic = [...text.matchAll(/(?:\+?62|0|8)(?:[\s().-]*\d){7,13}(?!\d)/g)].map(match => match[0])
    return [...new Set([...waids, ...telLines, ...generic].map(normalizeNumber).filter(Boolean))]
}

function extractContactTargets(message) {
    const targets = []
    for (const contact of getContactEntries(message)) {
        const numbers = extractNumbersFromVcard(contact?.vcard)
        for (const number of numbers) {
            targets.push({
                number,
                label: contact?.displayName || number,
                source: "contact",
            })
        }
    }
    return uniqueTargets(targets)
}

function extractTextTargets(text) {
    const clean = String(text || "")
    const matches = [...clean.matchAll(/(?:\+?62|0|8)(?:[\s().-]*\d){7,13}(?!\d)/g)]
    return uniqueTargets(matches.map(match => ({
        number: match[0],
        label: normalizeNumber(match[0]),
        source: "correction",
    })))
}

function extractMessageText(message) {
    const current = unwrapMessage(message)
    return String(
        current.conversation
        || current.extendedTextMessage?.text
        || current.imageMessage?.caption
        || current.videoMessage?.caption
        || current.documentMessage?.caption
        || ""
    ).trim()
}

function getReminderMediaMessage(message) {
    const current = unwrapMessage(message)
    if (
        current.imageMessage
        || current.videoMessage
        || current.audioMessage
        || current.documentMessage
    ) return current
    return null
}

function normalizeTime(value) {
    const clean = String(value || "").trim().replace(".", ":")
    const match = clean.match(/^(\d{1,2}):([0-5]\d)$/)
    if (!match) return ""
    const hour = Number(match[1])
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return ""
    return `${String(hour).padStart(2, "0")}:${match[2]}`
}

function formatTargets(targets) {
    return (targets || []).map((target, index) => {
        const label = target.label && target.label !== target.number ? ` — ${target.label}` : ""
        return `${index + 1}. ${target.number}${label}`
    }).join("\n")
}

async function sendPrompt(sock, chatJid, text) {
    return sock.sendMessage(chatJid, { text })
}

async function editPrompt(sock, session, text) {
    if (session?.promptKey) {
        try {
            const edited = await sock.sendMessage(session.chatJid, { text, edit: session.promptKey })
            if (edited?.key) session.promptKey = edited.key
            session.updatedAt = Date.now()
            return edited
        } catch (error) {
            console.log(`[REMINDER FLOW] Edit prompt gagal, kirim prompt baru: ${String(error.message || error).slice(0, 180)}`)
        }
    }
    const sent = await sendPrompt(sock, session.chatJid, text)
    if (sent?.key) session.promptKey = sent.key
    session.updatedAt = Date.now()
    return sent
}

function cleanupSessions(now = Date.now()) {
    const ttl = getTtlMs()
    for (const [key, session] of sessions) {
        if (!session?.updatedAt || now - session.updatedAt > ttl) sessions.delete(key)
    }
}

function getSession(chatJid) {
    cleanupSessions()
    return sessions.get(normalizeKey(chatJid)) || null
}

async function startFlow(sock, chatJid) {
    const key = normalizeKey(chatJid)
    const sent = await sendPrompt(sock, chatJid, [
        "⏰ *BUAT REMINDER BARU*",
        "",
        "Silakan kirim *kontak* atau *list beberapa kontak* yang akan menerima reminder.",
        "",
        "Tidak perlu mengetik nomor satu per satu.",
        "Ketik *batal* untuk membatalkan.",
    ].join("\n"))
    sessions.set(key, {
        chatJid,
        stage: "contacts",
        targets: [],
        messageText: "",
        messageContent: null,
        promptKey: sent?.key || null,
        updatedAt: Date.now(),
    })
    return true
}

function isStartCommand(text) {
    return /^\.(?:remind|reminder)$/i.test(String(text || "").trim())
}

function isDirectLegacyCommand(text) {
    return /^\.remind\s+/i.test(String(text || "").trim())
}

async function handleReminderContactFlow(sock, msg, context = {}) {
    const from = String(context.from || msg?.key?.remoteJid || "")
    const text = String(context.text ?? extractMessageText(msg?.message)).trim()
    const isGroup = context.isGroup === true || from.endsWith("@g.us")
    if (isGroup) return false

    if (isStartCommand(text)) {
        if (!context.isOwner) return false
        await startFlow(sock, from)
        return true
    }

    let session = getSession(from)
    if (!session || !context.isOwner) return false

    if (isDirectLegacyCommand(text)) {
        sessions.delete(normalizeKey(from))
        return false
    }

    const lower = text.toLowerCase()
    if (["batal", "cancel", ".batal", ".cancel"].includes(lower)) {
        await editPrompt(sock, session, "❌ *REMINDER DIBATALKAN*")
        sessions.delete(normalizeKey(from))
        return true
    }

    if (text.startsWith(".")) return false

    if (session.stage === "contacts") {
        const contacts = extractContactTargets(msg?.message)
        const corrections = contacts.length ? [] : extractTextTargets(text)
        const targets = uniqueTargets([...contacts, ...corrections])
        if (!targets.length) {
            await editPrompt(sock, session, [
                "⚠️ *KONTAK BELUM TERDETEKSI*",
                "",
                "Kirim contact card atau list kontak dari WhatsApp.",
                "Nomor teks hanya dipakai sebagai koreksi bila contact card terbaca salah.",
            ].join("\n"))
            return true
        }

        session.targets = targets
        session.stage = "confirm"
        await editPrompt(sock, session, [
            "✅ *KONTAK BERHASIL DIDETEKSI*",
            "",
            formatTargets(targets),
            "",
            "Periksa nomor di atas.",
            "• Ketik *lanjut* bila sudah benar.",
            "• Bila ada kesalahan, kirim ulang kontak/list kontak atau kirim daftar nomor yang sudah diperbaiki.",
            "• Ketik *batal* untuk membatalkan.",
        ].join("\n"))
        return true
    }

    if (session.stage === "confirm") {
        if (["lanjut", "benar", "ya", "oke", "ok"].includes(lower)) {
            session.stage = "message"
            await editPrompt(sock, session, [
                "💬 *MASUKKAN PESAN REMINDER*",
                "",
                "Silakan kirim pesan yang ingin dimasukkan ke reminder.",
                "Pesan teks maupun media dengan caption didukung.",
            ].join("\n"))
            return true
        }

        const contacts = extractContactTargets(msg?.message)
        const corrected = contacts.length ? contacts : extractTextTargets(text)
        if (corrected.length) {
            session.targets = uniqueTargets(corrected)
            await editPrompt(sock, session, [
                "✅ *DAFTAR TARGET DIPERBARUI*",
                "",
                formatTargets(session.targets),
                "",
                "Ketik *lanjut* bila sudah benar, atau kirim koreksi lagi.",
            ].join("\n"))
            return true
        }

        await editPrompt(sock, session, [
            "⚠️ *KONFIRMASI TARGET*",
            "",
            formatTargets(session.targets),
            "",
            "Ketik *lanjut* bila benar, atau kirim ulang kontak/nomor yang sudah dikoreksi.",
        ].join("\n"))
        return true
    }

    if (session.stage === "message") {
        const messageText = extractMessageText(msg?.message)
        const mediaMessage = getReminderMediaMessage(msg?.message)
        if (!messageText && !mediaMessage) {
            await editPrompt(sock, session, "⚠️ Pesan reminder belum terbaca. Kirim teks atau media yang ingin dijadwalkan.")
            return true
        }
        session.messageText = messageText
        session.messageContent = mediaMessage
        session.stage = "time"
        await editPrompt(sock, session, [
            "🕒 *TENTUKAN JAM REMINDER*",
            "",
            "Kirim jam dengan format *HH:MM* WIB.",
            "Contoh: *15:30*",
            "",
            "Header reminder tetap menggunakan template lama.",
        ].join("\n"))
        return true
    }

    if (session.stage === "time") {
        const time = normalizeTime(text)
        if (!time) {
            await editPrompt(sock, session, [
                "⚠️ *FORMAT JAM SALAH*",
                "",
                "Kirim jam dengan format *HH:MM* WIB.",
                "Contoh: *08:15* atau *20:30*",
            ].join("\n"))
            return true
        }

        const reminderModule = context.reminder || require("./reminder")
        const results = []
        for (const target of session.targets) {
            const success = await reminderModule.addReminder(
                target.jid,
                time,
                session.messageText,
                session.messageContent,
                { targetLabel: target.label }
            )
            results.push({ target, success: Boolean(success) })
        }

        const successTargets = results.filter(item => item.success).map(item => item.target)
        const failedTargets = results.filter(item => !item.success).map(item => item.target)
        const lines = [
            successTargets.length ? "✅ *REMINDER BERHASIL DISIMPAN*" : "❌ *REMINDER GAGAL DISIMPAN*",
            "",
            `Berhasil: ${successTargets.length}/${session.targets.length}`,
            `Jam: *${time} WIB*`,
            "",
            "Target:",
            formatTargets(successTargets.length ? successTargets : session.targets),
        ]
        if (failedTargets.length) {
            lines.push("", "Gagal:", formatTargets(failedTargets))
        }
        await editPrompt(sock, session, lines.join("\n"))
        sessions.delete(normalizeKey(from))
        return true
    }

    sessions.delete(normalizeKey(from))
    return false
}

function disposeReminderContactFlow() {
    sessions.clear()
}

module.exports = {
    handleReminderContactFlow,
    startFlow,
    extractContactTargets,
    extractTextTargets,
    normalizeTime,
    uniqueTargets,
    getSession,
    cleanupSessions,
    disposeReminderContactFlow,
}
