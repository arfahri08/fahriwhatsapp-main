"use strict"

const fs = require("fs")
const path = require("path")
const { downloadContentFromMessage } = require("@whiskeysockets/baileys")

const dataDir = path.resolve(process.env.REMINDER_DATA_DIR || path.join(__dirname, "../data"))
const mediaDir = path.resolve(process.env.REMINDER_MEDIA_DIR || path.join(dataDir, "media"))
const dbPath = path.resolve(process.env.REMINDER_DATA_FILE || path.join(dataDir, "reminder.json"))
const headerPath = path.resolve(process.env.REMINDER_HEADER_FILE || path.join(dataDir, "reminder_header.txt"))
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(mediaDir, { recursive: true })
fs.mkdirSync(path.dirname(dbPath), { recursive: true })
fs.mkdirSync(path.dirname(headerPath), { recursive: true })
if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, "[]\n", "utf8")
if (!fs.existsSync(headerPath)) {
    fs.writeFileSync(headerPath, "[REMINDER] *INI ADALAH PESAN OTOMATIS oleh USERBOT FAHRI*\n\n", "utf8")
}

let lastCctvLogTime = null
let activeReminderRun = null
const batchClaimCache = new Map()
const BATCH_CLAIM_TTL_MS = 24 * 60 * 60 * 1000

function readReminders() {
    try {
        const parsed = JSON.parse(fs.readFileSync(dbPath, "utf8"))
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

function writeRemindersAtomic(reminders) {
    const normalized = Array.isArray(reminders) ? reminders : []
    const temporary = `${dbPath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
    fs.renameSync(temporary, dbPath)
    return normalized
}

function setHeader(text) {
    fs.writeFileSync(headerPath, `${String(text || "")}\n\n`, "utf8")
    return true
}

function getJidNumber(value) {
    return String(value || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "")
}

function normalizeTarget(value, fallbackLabel = "") {
    const raw = typeof value === "object" && value !== null ? value : { jid: value }
    const number = getJidNumber(raw.jid || raw.target || raw.number || value)
    if (!number) return null
    const label = String(raw.label || raw.targetLabel || fallbackLabel || number)
        .replace(/[\r\n\t]+/g, " ")
        .trim()
        .slice(0, 100) || number
    return {
        jid: `${number}@s.whatsapp.net`,
        number,
        label,
    }
}

function uniqueTargets(values = []) {
    const result = []
    const seen = new Set()
    for (const value of values) {
        const target = normalizeTarget(value)
        if (!target || seen.has(target.number)) continue
        seen.add(target.number)
        result.push(target)
    }
    return result
}

function normalizeBatchId(value) {
    return String(value || "")
        .replace(/[^a-zA-Z0-9:_@.-]+/g, "-")
        .slice(0, 220)
}


function cleanupBatchClaims(now = Date.now()) {
    for (const [batchId, expiresAt] of batchClaimCache) {
        if (Number(expiresAt || 0) <= now) batchClaimCache.delete(batchId)
    }
}

function hasBatchClaim(batchId, now = Date.now()) {
    cleanupBatchClaims(now)
    return Boolean(batchId && Number(batchClaimCache.get(batchId) || 0) > now)
}

function claimBatchId(batchId, now = Date.now()) {
    if (!batchId) return
    cleanupBatchClaims(now)
    batchClaimCache.set(batchId, now + BATCH_CLAIM_TTL_MS)
}

function getMediaDescriptor(quotedMsg) {
    if (!quotedMsg || typeof quotedMsg !== "object") return null
    if (quotedMsg.imageMessage) return { content: quotedMsg.imageMessage, type: "image", extension: "jpg" }
    if (quotedMsg.videoMessage) return { content: quotedMsg.videoMessage, type: "video", extension: "mp4" }
    if (quotedMsg.audioMessage) return { content: quotedMsg.audioMessage, type: "audio", extension: "mp3" }
    if (quotedMsg.documentMessage) {
        const fileName = String(quotedMsg.documentMessage.fileName || "file")
        const extension = fileName.includes(".") ? fileName.split(".").pop() : "bin"
        return { content: quotedMsg.documentMessage, type: "document", extension }
    }
    return null
}

async function downloadMediaBuffer(descriptor) {
    if (!descriptor) return null
    const stream = await downloadContentFromMessage(descriptor.content, descriptor.type)
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    return Buffer.concat(chunks)
}

function saveMediaBuffer(buffer, extension, index) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null
    const safeExtension = String(extension || "bin").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "bin"
    const fileName = `remind_${Date.now()}_${process.pid}_${index}_${Math.random().toString(36).slice(2, 8)}.${safeExtension}`
    const filePath = path.join(mediaDir, fileName)
    fs.writeFileSync(filePath, buffer)
    return filePath
}

async function addReminderBatch(targetValues, time, text, quotedMsg, options = {}) {
    const targets = uniqueTargets(targetValues)
    if (!targets.length) {
        return { success: false, created: 0, duplicate: false, total: 0, reminders: [] }
    }

    const batchId = normalizeBatchId(options.batchId || options.requestId)
    const now = Date.now()
    if (hasBatchClaim(batchId, now)) {
        return {
            success: true,
            created: 0,
            duplicate: true,
            total: targets.length,
            reminders: [],
        }
    }

    const existing = readReminders()
    if (batchId) {
        const existingBatch = existing.filter(item => String(item?.batchId || "") === batchId)
        if (existingBatch.length) {
            claimBatchId(batchId, now)
            return {
                success: true,
                created: 0,
                duplicate: true,
                total: existingBatch.length,
                reminders: existingBatch,
            }
        }
    }

    const descriptor = getMediaDescriptor(quotedMsg)
    const mediaBuffer = descriptor ? await downloadMediaBuffer(descriptor) : null
    const createdAt = Date.now()
    const newItems = []

    try {
        for (let index = 0; index < targets.length; index += 1) {
            const target = targets[index]
            const mediaPath = descriptor
                ? saveMediaBuffer(mediaBuffer, descriptor.extension, index)
                : null

            newItems.push({
                id: `${createdAt}_${index}_${Math.random().toString(36).slice(2, 8)}`,
                batchId,
                target: target.jid,
                targetLabel: target.label,
                time: String(time || "").trim(),
                message: String(text || ""),
                mediaPath,
                mediaType: descriptor?.type || null,
                createdAt,
            })
        }

        writeRemindersAtomic([...existing, ...newItems])
        claimBatchId(batchId)
        return {
            success: true,
            created: newItems.length,
            duplicate: false,
            total: newItems.length,
            reminders: newItems,
        }
    } catch (error) {
        for (const item of newItems) {
            try {
                if (item.mediaPath && fs.existsSync(item.mediaPath)) fs.unlinkSync(item.mediaPath)
            } catch {}
        }
        console.log(`[Reminder] Gagal menyimpan batch: ${String(error?.message || error).slice(0, 300)}`)
        return { success: false, created: 0, duplicate: false, total: targets.length, reminders: [], error }
    }
}

async function addReminder(targetNumber, time, text, quotedMsg, options = {}) {
    const result = await addReminderBatch(
        [{ jid: targetNumber, label: options.targetLabel }],
        time,
        text,
        quotedMsg,
        options
    )
    return result.success === true
}

function currentMinuteWib(now = new Date()) {
    return now.getHours().toString().padStart(2, "0") + ":" + now.getMinutes().toString().padStart(2, "0")
}

async function sendReminder(sock, rem, headerText) {
    const finalMessage = headerText + (rem.message || "")
    if (rem.mediaPath && fs.existsSync(rem.mediaPath)) {
        const mediaSource = { url: rem.mediaPath }
        if (rem.mediaType === "image") {
            await sock.sendMessage(rem.target, { image: mediaSource, caption: finalMessage })
        } else if (rem.mediaType === "video") {
            await sock.sendMessage(rem.target, { video: mediaSource, caption: finalMessage })
        } else if (rem.mediaType === "audio") {
            await sock.sendMessage(rem.target, { audio: mediaSource, mimetype: "audio/mp4", ptt: false })
        } else if (rem.mediaType === "document") {
            await sock.sendMessage(rem.target, {
                document: mediaSource,
                mimetype: "application/octet-stream",
                fileName: path.basename(rem.mediaPath),
                caption: finalMessage,
            })
        } else {
            await sock.sendMessage(rem.target, { text: finalMessage })
        }
    } else {
        await sock.sendMessage(rem.target, { text: finalMessage })
    }
}

async function runReminderCheck(sock) {
    const reminders = readReminders()
    const currentTime = currentMinuteWib(new Date())

    if (lastCctvLogTime !== currentTime) {
        console.log(`\n[CCTV] Jam: ${currentTime} | Antrean: ${reminders.length}`)
        lastCctvLogTime = currentTime
    }
    if (!reminders.length) return { claimed: 0, sent: 0, failed: 0 }

    const due = []
    const remaining = []
    for (const rem of reminders) {
        if (String(rem?.time || "") === currentTime) due.push(rem)
        else remaining.push(rem)
    }
    if (!due.length) return { claimed: 0, sent: 0, failed: 0 }

    // Claim sebelum network send. Ini sengaja memakai at-most-once delivery:
    // run yang overlap/restart tidak bisa membaca batch yang sama lalu mengirim ulang.
    writeRemindersAtomic(remaining)

    const headerText = fs.readFileSync(headerPath, "utf8")
    let sent = 0
    let failed = 0

    for (const rem of due) {
        console.log(`[Reminder] Mengeksekusi ${rem.id || "-"} ke ${String(rem.target || "").split("@")[0]}...`)
        try {
            await sendReminder(sock, rem, headerText)
            sent += 1
            console.log(`[Reminder] Terkirim sekali: ${rem.id || "-"}`)
        } catch (error) {
            failed += 1
            console.log(`[Reminder] Gagal tanpa auto-retry ${rem.id || "-"}: ${String(error?.message || error).slice(0, 300)}`)
        } finally {
            try {
                if (rem.mediaPath && fs.existsSync(rem.mediaPath)) fs.unlinkSync(rem.mediaPath)
            } catch {}
        }
    }

    return { claimed: due.length, sent, failed }
}

async function checkAndSendReminders(sock) {
    if (activeReminderRun) {
        console.log("[Reminder] Skip tick overlap: proses sebelumnya masih berjalan.")
        return activeReminderRun
    }

    activeReminderRun = runReminderCheck(sock)
    try {
        return await activeReminderRun
    } finally {
        activeReminderRun = null
    }
}

function getReminders() {
    return readReminders()
}

function delReminder(index) {
    try {
        const reminders = readReminders()
        if (index < 1 || index > reminders.length) return false
        const rem = reminders[index - 1]
        reminders.splice(index - 1, 1)
        writeRemindersAtomic(reminders)
        try {
            if (rem.mediaPath && fs.existsSync(rem.mediaPath)) fs.unlinkSync(rem.mediaPath)
        } catch {}
        return true
    } catch {
        return false
    }
}

function getReminderRuntimeState() {
    return {
        running: Boolean(activeReminderRun),
        queued: readReminders().length,
    }
}

module.exports = {
    addReminder,
    addReminderBatch,
    checkAndSendReminders,
    setHeader,
    getReminders,
    delReminder,
    getReminderRuntimeState,
    writeRemindersAtomic,
}
