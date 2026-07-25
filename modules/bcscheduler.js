// modules/bcscheduler.js
// Storage dan due-detection Broadcast Scheduler. Delivery memakai socket aktif dari index.js.

const fs = require("fs")
const path = require("path")

const FILE = path.join(__dirname, "../data/bcschedules.json")
const DEFAULT_TIMEZONE = "Asia/Jakarta"
const MAX_ERROR_LENGTH = 180
const PROCESSING_STALE_MS = 10 * 60 * 1000

function getTimezone() {
    return String(process.env.BOT_TIMEZONE || process.env.TZ || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE
}

function getMaxRetries() {
    const value = Number(process.env.BC_SCHEDULER_MAX_RETRIES || 3)
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 3
}

function getRetryDelayMs() {
    const value = Number(process.env.BC_SCHEDULER_RETRY_DELAY_MS || 60000)
    return Number.isFinite(value) && value >= 10000 ? Math.floor(value) : 60000
}

function ensureDir() {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
}

function readRaw() {
    if (!fs.existsSync(FILE)) return []
    try {
        const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"))
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

function save(data) {
    ensureDir()
    const tmp = `${FILE}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
    fs.renameSync(tmp, FILE)
}

function pad2(value) {
    return String(value).padStart(2, "0")
}

function getZonedParts(date = new Date(), timezone = getTimezone()) {
    try {
        const formatter = new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone,
            hour12: false,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        })
        const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
        const hour = parts.hour === "24" ? "00" : parts.hour
        return {
            date: `${parts.year}-${parts.month}-${parts.day}`,
            time: `${hour}:${parts.minute}`,
        }
    } catch {
        return {
            date: date.toISOString().slice(0, 10),
            time: `${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
        }
    }
}

function normalizeTime(value) {
    const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/)
    if (!match) return ""
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return ""
    return `${pad2(hour)}:${pad2(minute)}`
}

function normalizeDate(value) {
    const clean = String(value || "").trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return ""
    const date = new Date(`${clean}T00:00:00Z`)
    if (Number.isNaN(date.getTime())) return ""
    return date.toISOString().slice(0, 10) === clean ? clean : ""
}

function normalizePrivateNumber(value) {
    let number = String(value || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "")
    if (!number) return ""
    if (number.startsWith("0")) number = `62${number.slice(1)}`
    if (number.startsWith("8")) number = `62${number}`
    return number.length >= 7 ? number : ""
}

function normalizeTargetJid(value) {
    const clean = String(value || "").trim().toLowerCase()
    if (!clean || clean === "status@broadcast" || clean.endsWith("@newsletter") || clean.endsWith("@broadcast")) return ""

    if (clean.endsWith("@g.us")) {
        const id = clean.slice(0, -5)
        return /^[0-9-]{5,}$/.test(id) ? `${id}@g.us` : ""
    }

    if (clean.endsWith("@s.whatsapp.net")) {
        const number = normalizePrivateNumber(clean)
        return number ? `${number}@s.whatsapp.net` : ""
    }

    const number = normalizePrivateNumber(clean)
    return number ? `${number}@s.whatsapp.net` : ""
}

function isValidTargetJid(value) {
    return Boolean(normalizeTargetJid(value))
}

function makeId(seed = "") {
    const safeSeed = String(seed || "").replace(/[^A-Za-z0-9]/g, "").slice(-8)
    return `bc_${Date.now().toString(36)}_${safeSeed || Math.random().toString(36).slice(2, 8)}`
}

function clampError(error) {
    const message = String(error?.message || error || "unknown error").replace(/\s+/g, " ").trim()
    return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}...` : message
}

function normalizeSchedule(input = {}, index = 0) {
    const timezone = String(input.timezone || getTimezone()).trim() || getTimezone()
    const time = normalizeTime(input.time)
    const date = normalizeDate(input.date)
    const type = date ? "once" : "daily"
    const targetJid = normalizeTargetJid(input.targetJid || input.target || input.to || process.env.BC_SCHEDULER_DEFAULT_TARGET || "")
    const message = String(input.message || input.text || "").trim()
    const now = Date.now()
    const updatedAt = Number(input.updatedAt || input.createdAt || now)
    let status = String(input.status || "pending").toLowerCase()
    if (!["pending", "processing", "sent", "failed"].includes(status)) status = "pending"

    if (status === "processing") {
        const lastAttemptMs = Date.parse(input.lastAttemptAt || "")
        if (!lastAttemptMs || now - lastAttemptMs > PROCESSING_STALE_MS) status = "pending"
    }

    return {
        id: String(input.id || makeId(`${time}${index}`)),
        targetJid,
        time,
        date,
        type,
        message,
        templateName: String(input.templateName || "").trim(),
        timezone,
        status,
        attempts: Math.max(0, Number(input.attempts || 0) || 0),
        lastAttemptAt: String(input.lastAttemptAt || ""),
        lastDueDate: String(input.lastDueDate || ""),
        lastSent: String(input.lastSent || ""),
        sentAt: String(input.sentAt || ""),
        lastError: String(input.lastError || "").slice(0, MAX_ERROR_LENGTH),
        manualRetry: input.manualRetry === true,
        createdAt: Number(input.createdAt || updatedAt || now),
        updatedAt,
    }
}

function load() {
    return readRaw()
        .map(normalizeSchedule)
        .filter(item => item.time && item.message)
}

function persistNormalized(mutator) {
    const list = load()
    const result = mutator(list)
    save(list)
    return result
}

function findScheduleIndex(list, idOrTime) {
    const clean = String(idOrTime || "").trim()
    return list.findIndex(item => item.id === clean || item.time === normalizeTime(clean))
}

function addSchedule(input, maybeMessage) {
    let schedule = null

    if (typeof input === "object" && input !== null) {
        schedule = normalizeSchedule({
            ...input,
            status: input.status || "pending",
            createdAt: input.createdAt || Date.now(),
            updatedAt: Date.now(),
        })
    } else {
        schedule = normalizeSchedule({
            time: input,
            message: maybeMessage,
            targetJid: process.env.BC_SCHEDULER_DEFAULT_TARGET || "",
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        })
    }

    if (!schedule.time || !schedule.message || !schedule.targetJid) return false

    return persistNormalized(list => {
        const duplicateIndex = list.findIndex(item => (
            item.targetJid === schedule.targetJid &&
            item.time === schedule.time &&
            item.date === schedule.date &&
            item.type === schedule.type
        ))

        if (duplicateIndex >= 0) {
            list[duplicateIndex] = {
                ...list[duplicateIndex],
                ...schedule,
                id: list[duplicateIndex].id,
                createdAt: list[duplicateIndex].createdAt,
                attempts: 0,
                status: "pending",
                lastError: "",
                manualRetry: false,
            }
            return list[duplicateIndex]
        }

        list.push(schedule)
        return schedule
    })
}

function delSchedule(idOrTime) {
    const before = load()
    const index = findScheduleIndex(before, idOrTime)
    if (index < 0) return false
    before.splice(index, 1)
    save(before)
    return true
}

function getList() {
    const list = load()
    save(list)
    return list
}

function isRetryReady(schedule, now = new Date()) {
    if (!schedule.lastAttemptAt) return true
    const lastAttemptMs = Date.parse(schedule.lastAttemptAt)
    if (!lastAttemptMs) return true
    return now.getTime() - lastAttemptMs >= getRetryDelayMs()
}

function isDue(schedule, now = new Date()) {
    const zoned = getZonedParts(now, schedule.timezone || getTimezone())
    if (schedule.status === "sent" || schedule.status === "failed" || schedule.status === "processing") return false
    if (schedule.attempts >= getMaxRetries()) return false
    if (!schedule.targetJid || !schedule.message || !schedule.time) return isRetryReady(schedule, now)

    if (schedule.manualRetry) return isRetryReady(schedule, now)
    if (schedule.lastDueDate === zoned.date && schedule.attempts > 0) return isRetryReady(schedule, now)

    if (schedule.type === "once") {
        const dueKey = `${schedule.date} ${schedule.time}`
        const nowKey = `${zoned.date} ${zoned.time}`
        return dueKey <= nowKey
    }

    return schedule.time === zoned.time && schedule.lastSent !== zoned.date
}

function getDueSchedules(now = new Date()) {
    return getList().filter(schedule => isDue(schedule, now))
}

function markProcessing(idOrTime, now = new Date()) {
    return persistNormalized(list => {
        const index = findScheduleIndex(list, idOrTime)
        if (index < 0) return false
        const zoned = getZonedParts(now, list[index].timezone || getTimezone())
        list[index] = {
            ...list[index],
            status: "processing",
            attempts: Number(list[index].attempts || 0) + 1,
            lastAttemptAt: now.toISOString(),
            lastDueDate: zoned.date,
            updatedAt: Date.now(),
        }
        return true
    })
}

function markSent(idOrTime, now = new Date()) {
    return persistNormalized(list => {
        const index = findScheduleIndex(list, idOrTime)
        if (index < 0) return false
        const zoned = getZonedParts(now, list[index].timezone || getTimezone())
        list[index] = {
            ...list[index],
            status: list[index].type === "once" ? "sent" : "pending",
            attempts: 0,
            lastSent: zoned.date,
            sentAt: now.toISOString(),
            lastError: "",
            manualRetry: false,
            updatedAt: Date.now(),
        }
        return true
    })
}

function markFailed(idOrTime, error, now = new Date()) {
    return persistNormalized(list => {
        const index = findScheduleIndex(list, idOrTime)
        if (index < 0) return false
        const attempts = Number(list[index].attempts || 0)
        list[index] = {
            ...list[index],
            status: attempts >= getMaxRetries() ? "failed" : "pending",
            lastError: clampError(error),
            manualRetry: false,
            updatedAt: Date.now(),
        }
        return true
    })
}

function resetFailed(idOrTime) {
    return persistNormalized(list => {
        const index = findScheduleIndex(list, idOrTime)
        if (index < 0 || list[index].status !== "failed") return false
        list[index] = {
            ...list[index],
            status: "pending",
            attempts: 0,
            lastAttemptAt: "",
            lastError: "",
            manualRetry: true,
            updatedAt: Date.now(),
        }
        return list[index]
    })
}

function getFailedSchedules() {
    return getList().filter(item => item.status === "failed")
}

function getSummary(now = new Date()) {
    const list = getList()
    const counts = {
        total: list.length,
        pending: 0,
        processing: 0,
        sent: 0,
        failed: 0,
    }

    for (const item of list) {
        counts[item.status] = (counts[item.status] || 0) + 1
    }

    const next = list
        .filter(item => item.status === "pending" && item.targetJid && item.message)
        .sort((a, b) => {
            const left = `${a.date || getZonedParts(now, a.timezone).date} ${a.time}`
            const right = `${b.date || getZonedParts(now, b.timezone).date} ${b.time}`
            return left.localeCompare(right)
        })[0] || null

    return {
        ...counts,
        timezone: getTimezone(),
        nextSchedule: next,
    }
}

module.exports = {
    FILE,
    addSchedule,
    delSchedule,
    getList,
    getDueSchedules,
    markProcessing,
    markSent,
    markFailed,
    resetFailed,
    getFailedSchedules,
    getSummary,
    getTimezone,
    normalizeTime,
    normalizeDate,
    normalizeTargetJid,
    isValidTargetJid,
}
