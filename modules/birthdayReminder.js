"use strict"

const fs = require("fs")
const path = require("path")
const reminderContactFlow = require("./reminderContactFlow")

const dataPath = path.resolve(process.env.BIRTHDAY_DATA_FILE || path.join(__dirname, "../data/birthday.json"))
const timeZone = String(process.env.BIRTHDAY_TIMEZONE || "Asia/Jakarta").trim() || "Asia/Jakarta"
const sendHour = Number(process.env.BIRTHDAY_HOUR || 6)
const sendMinute = Number(process.env.BIRTHDAY_MINUTE || 30)
const sessions = new Map()
let activeRun = null

fs.mkdirSync(path.dirname(dataPath), { recursive: true })
if (!fs.existsSync(dataPath)) fs.writeFileSync(dataPath, "[]\n", "utf8")

function readBirthdays() {
    try {
        const value = JSON.parse(fs.readFileSync(dataPath, "utf8"))
        return Array.isArray(value) ? value : []
    } catch {
        return []
    }
}

function writeBirthdays(items) {
    const temporary = `${dataPath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(items, null, 2)}\n`, "utf8")
    fs.renameSync(temporary, dataPath)
}

function normalizeNumber(value) {
    let number = String(value || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "")
    if (number.startsWith("0")) number = `62${number.slice(1)}`
    else if (number.startsWith("8")) number = `62${number}`
    return /^62\d{8,14}$/.test(number) ? number : ""
}

function normalizeDate(value) {
    const match = String(value || "").trim().match(/^(\d{1,2})[\/-](\d{1,2})$/)
    if (!match) return ""
    const day = Number(match[1])
    const month = Number(match[2])
    if (!Number.isInteger(day) || !Number.isInteger(month) || month < 1 || month > 12 || day < 1 || day > 31) return ""
    const check = new Date(Date.UTC(2024, month - 1, day))
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return ""
    return `${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}`
}

function getZonedParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date)
    const result = {}
    for (const part of parts) result[part.type] = part.value
    return {
        year: Number(result.year),
        day: Number(result.day),
        month: Number(result.month),
        hour: Number(result.hour),
        minute: Number(result.minute),
    }
}

function extractMessageText(message) {
    let current = message || {}
    for (let index = 0; index < 8; index += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message
        else break
    }
    return String(
        current.conversation
        || current.extendedTextMessage?.text
        || current.imageMessage?.caption
        || current.videoMessage?.caption
        || current.documentMessage?.caption
        || ""
    ).trim()
}

function getSession(from) {
    return sessions.get(String(from || "").toLowerCase()) || null
}

async function editPrompt(sock, session, text) {
    if (session.promptKey) {
        try {
            const edited = await sock.sendMessage(session.chatJid, { text, edit: session.promptKey })
            if (edited?.key) session.promptKey = edited.key
            return edited
        } catch (error) {
            console.log(`[BIRTHDAY] Edit prompt gagal: ${String(error.message || error).slice(0, 160)}`)
        }
    }
    const sent = await sock.sendMessage(session.chatJid, { text })
    if (sent?.key) session.promptKey = sent.key
    return sent
}

function formatEntry(entry, index) {
    return `${index + 1}. ${entry.name || "Tanpa nama"} — ${entry.nickname || "belum ada panggilan"} — ${entry.birthday || "tanggal belum diisi"}`
}

async function startFlow(sock, from) {
    const sent = await sock.sendMessage(from, {
        text: [
            "🎂 *TAMBAH REMINDER ULANG TAHUN*",
            "",
            "Kirim *contact card* target ulang tahun.",
            "Ketik *batal* untuk membatalkan.",
        ].join("\n"),
    })
    sessions.set(String(from).toLowerCase(), {
        chatJid: from,
        stage: "contact",
        promptKey: sent?.key || null,
        updatedAt: Date.now(),
    })
}

async function handleBirthdayFlow(sock, msg, context = {}) {
    const from = String(context.from || msg?.key?.remoteJid || "")
    const text = String(context.text || extractMessageText(msg?.message)).trim()
    if (!from || context.isGroup || !context.isOwner) return false

    if (/^\.hbd(?:\s+list)?$/i.test(text)) {
        if (/\s+list$/i.test(text)) {
            const entries = readBirthdays()
            await sock.sendMessage(from, {
                text: entries.length
                    ? ["🎂 *DAFTAR REMINDER ULANG TAHUN*", "", ...entries.map(formatEntry)].join("\n")
                    : "Belum ada data ulang tahun.",
            })
            return true
        }
        await startFlow(sock, from)
        return true
    }

    const session = getSession(from)
    if (!session) return false
    if (["batal", "cancel", ".batal", ".cancel"].includes(text.toLowerCase())) {
        await editPrompt(sock, session, "❌ *SETUP ULANG TAHUN DIBATALKAN*")
        sessions.delete(from.toLowerCase())
        return true
    }
    if (text.startsWith(".")) return false

    if (session.stage === "contact") {
        const contacts = reminderContactFlow.extractContactTargets(msg?.message)
        const textTargets = contacts.length ? contacts : reminderContactFlow.extractTextTargets(text)
        const target = textTargets[0]
        if (!target) {
            await editPrompt(sock, session, "⚠️ Kontak belum terbaca. Kirim contact card atau nomor target, lalu ketik *batal* bila ingin keluar.")
            return true
        }
        session.target = target
        session.stage = "nickname"
        await editPrompt(sock, session, [
            `✅ Target: ${target.number}`,
            "",
            "Sekarang kirim *nama panggilan* yang ingin dipakai di ucapan.",
            "Contoh: *bunda*, *My day 1*, atau *jerii*.",
        ].join("\n"))
        return true
    }

    if (session.stage === "nickname") {
        const nickname = text.replace(/\s+/g, " ").trim().slice(0, 60)
        if (!nickname) {
            await editPrompt(sock, session, "⚠️ Nama panggilan belum diisi. Kirim nama panggilan target.")
            return true
        }
        session.nickname = nickname
        session.stage = "date"
        await editPrompt(sock, session, [
            `✅ Nama panggilan: *${nickname}*`,
            "",
            "Sekarang kirim tanggal ulang tahun dengan format *DD-MM*.",
            "Contoh: *07-09*",
        ].join("\n"))
        return true
    }

    if (session.stage === "date") {
        const birthday = normalizeDate(text)
        if (!birthday) {
            await editPrompt(sock, session, "⚠️ Format tanggal salah. Gunakan *DD-MM*, contoh *07-09*.")
            return true
        }
        const entries = readBirthdays()
        const existing = entries.find(entry => normalizeNumber(entry.number || entry.jid) === session.target.number)
        const next = {
            ...(existing || {}),
            number: session.target.number,
            jid: `${session.target.number}@s.whatsapp.net`,
            name: existing?.name || session.target.label || session.target.number,
            nickname: session.nickname,
            birthday,
            lastSentYear: null,
            aliases: Array.isArray(existing?.aliases) ? existing.aliases : [],
            updatedAt: new Date().toISOString(),
        }
        const updated = existing ? entries.map(entry => entry === existing ? next : entry) : [...entries, next]
        writeBirthdays(updated)
        await editPrompt(sock, session, [
            "✅ *REMINDER ULANG TAHUN TERSIMPAN*",
            "",
            `Target: ${next.name}`,
            `Panggilan: ${next.nickname}`,
            `Tanggal: ${next.birthday}`,
            "Waktu kirim: *06:30 WIB* setiap tahun.",
        ].join("\n"))
        sessions.delete(from.toLowerCase())
        return true
    }

    return true
}

function getBirthdayMessage(entry) {
    return [
        `🎂 Selamat ulang tahun, ${entry.nickname || entry.name || "kamu"}!`,
        "",
        `Semoga panjang umur, sehat selalu, dan semua harapan baik ${entry.nickname || entry.name || "kamu"} dimudahkan.`,
        "Have a wonderful birthday! 🎉",
    ].join("\n")
}

async function runBirthdayCheck(sock, now = new Date()) {
    const local = getZonedParts(now)
    if (local.hour !== sendHour || local.minute !== sendMinute) return { sent: 0, skipped: 0 }
    const entries = readBirthdays()
    let sent = 0
    let skipped = 0
    const updated = entries.map(entry => {
        const birthday = normalizeDate(entry.birthday)
        if (!birthday || birthday !== `${String(local.day).padStart(2, "0")}-${String(local.month).padStart(2, "0")}` || String(entry.lastSentYear || "") === String(local.year)) {
            skipped += 1
            return entry
        }
        try {
            sock.sendMessage(entry.jid || `${normalizeNumber(entry.number)}@s.whatsapp.net`, { text: getBirthdayMessage(entry) })
                .then(() => {})
                .catch(error => console.log(`[BIRTHDAY] Gagal kirim ${entry.name || entry.number}: ${String(error.message || error).slice(0, 160)}`))
            sent += 1
            return { ...entry, lastSentYear: local.year }
        } catch (error) {
            console.log(`[BIRTHDAY] Gagal proses ${entry.name || entry.number}: ${String(error.message || error).slice(0, 160)}`)
            return entry
        }
    })
    if (sent) writeBirthdays(updated)
    return { sent, skipped }
}

async function checkAndSendBirthdays(sock) {
    if (activeRun) return activeRun
    activeRun = runBirthdayCheck(sock)
    try {
        return await activeRun
    } finally {
        activeRun = null
    }
}

module.exports = {
    handleBirthdayFlow,
    checkAndSendBirthdays,
    getBirthdayMessage,
    normalizeDate,
    readBirthdays,
}
