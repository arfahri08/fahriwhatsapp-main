"use strict"

const common = require("./groupUtilityCommon")
const defaultStore = require("./groupUtilityStore")

const FEATURE_NAME = "groupSchedule"
const TIME_ZONE = "Asia/Jakarta"
const COMMAND_PATTERN = /^(?:\.gcschedule|\.jadwalgroup)(?:\s|$)/i
const TICK_INTERVAL_MS = 30_000

let schedulerTimer = null
let schedulerSock = null
let schedulerContext = {}
let tickPromise = null

function isScheduleCommand(text) {
    return COMMAND_PATTERN.test(String(text || "").trim())
}

function isValidTime(value) {
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || "").trim())
}

function getJakartaParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date).reduce((result, part) => {
        if (part.type !== "literal") result[part.type] = part.value
        return result
    }, {})
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour}:${parts.minute}`,
    }
}

function getSchedule(group, create = false) {
    const current = group?.schedule && typeof group.schedule === "object" ? group.schedule : null
    if (current || !create) return current
    return { enabled: true, open: null, close: null, lastRuns: {} }
}

function normalizeSchedule(schedule = {}) {
    return {
        ...schedule,
        enabled: schedule.enabled !== false,
        open: isValidTime(schedule.open) ? schedule.open : null,
        close: isValidTime(schedule.close) ? schedule.close : null,
        lastRuns: schedule.lastRuns && typeof schedule.lastRuns === "object" ? schedule.lastRuns : {},
    }
}

function formatScheduleStatus(groupJid, schedule) {
    const config = normalizeSchedule(schedule || {})
    return [
        "JADWAL GRUP",
        "",
        `Grup: ${groupJid}`,
        `Status: ${config.enabled ? "ON" : "OFF"}`,
        `Buka: ${config.open || "belum diatur"}`,
        `Tutup: ${config.close || "belum diatur"}`,
        `Zona waktu: ${TIME_ZONE}`,
    ].join("\n")
}

function parseScheduleCommand(text) {
    const raw = String(text || "").trim().replace(/^(?:\.gcschedule|\.jadwalgroup)\b/i, "").trim()
    const parts = raw.split(/\s+/).filter(Boolean)
    let action = String(parts[0] || "status").toLowerCase()
    if (action === "hapus") action = "delete"
    let target = String(parts[1] || "").toLowerCase()
    if (target === "buka") target = "open"
    if (target === "tutup") target = "close"
    return { action, target, value: String(parts[2] || (action === "open" || action === "close" ? parts[1] || "" : "")) }
}

function updateSchedule(store, groupJid, mutator) {
    return store.updateGroup(groupJid, group => {
        const schedule = normalizeSchedule(getSchedule(group, true))
        const next = mutator(schedule) || schedule
        return { ...group, schedule: next }
    })
}

async function handleGroupScheduleCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    if (!isScheduleCommand(text)) return false
    const access = await common.resolveCommandAccess(sock, msg, FEATURE_NAME, context)
    if (access.hardDenied) return true
    if (!access.allowed) {
        await sock.sendMessage(access.groupJid, { text: "Perintah jadwal hanya untuk admin grup atau owner bot." }, { quoted: msg })
        return true
    }
    const store = context.store || defaultStore
    const parsed = parseScheduleCommand(text)
    const current = getSchedule(store.getGroup(access.groupJid) || {}, true)

    if (parsed.action === "status") {
        await sock.sendMessage(access.groupJid, { text: formatScheduleStatus(access.groupJid, current) }, { quoted: msg })
        return true
    }
    if (parsed.action === "off") {
        const next = updateSchedule(store, access.groupJid, schedule => ({ ...schedule, enabled: false }))
        await sock.sendMessage(access.groupJid, { text: formatScheduleStatus(access.groupJid, next.schedule) }, { quoted: msg })
        return true
    }
    if (parsed.action === "delete") {
        if (!["open", "close"].includes(parsed.target)) {
            await sock.sendMessage(access.groupJid, { text: "Format: .gcschedule delete open/close" }, { quoted: msg })
            return true
        }
        const next = updateSchedule(store, access.groupJid, schedule => ({ ...schedule, [parsed.target]: null }))
        await sock.sendMessage(access.groupJid, { text: formatScheduleStatus(access.groupJid, next.schedule) }, { quoted: msg })
        return true
    }
    if (["open", "close"].includes(parsed.action)) {
        const time = String(parsed.target || parsed.value || "").trim()
        if (!isValidTime(time)) {
            await sock.sendMessage(access.groupJid, { text: `Format: .gcschedule ${parsed.action} HH:MM (zona ${TIME_ZONE})` }, { quoted: msg })
            return true
        }
        const next = updateSchedule(store, access.groupJid, schedule => ({ ...schedule, enabled: true, [parsed.action]: time }))
        await sock.sendMessage(access.groupJid, { text: formatScheduleStatus(access.groupJid, next.schedule) }, { quoted: msg })
        return true
    }
    await sock.sendMessage(access.groupJid, {
        text: "Gunakan .gcschedule status/open HH:MM/close HH:MM/delete open|close/off",
    }, { quoted: msg })
    return true
}

function buildFreshMetadataResolver(sock) {
    return async groupJid => {
        if (typeof sock?.__resolveGroupMetadataForRuntimePolicy === "function") {
            return sock.__resolveGroupMetadataForRuntimePolicy(groupJid, { forceRefresh: true })
        }
        return sock?.groupMetadata?.(groupJid)
    }
}

function markScheduleAttempt(store, groupJid, action, localDate, extra = {}) {
    updateSchedule(store, groupJid, schedule => ({
        ...schedule,
        lastRuns: {
            ...(schedule.lastRuns || {}),
            [action]: localDate,
        },
        lastAttempt: {
            action,
            localDate,
            at: new Date().toISOString(),
            ...extra,
        },
    }))
}

async function runScheduleTick(sock, context = {}, now = new Date()) {
    if (!sock) return { checked: 0, due: 0, executed: 0, skipped: 0 }
    const store = context.store || defaultStore
    const local = getJakartaParts(now)
    const groups = store.getGroups()
    const result = { checked: 0, due: 0, executed: 0, skipped: 0 }

    for (const [groupJid, group] of Object.entries(groups)) {
        const schedule = normalizeSchedule(getSchedule(group) || {})
        if (!schedule.enabled) continue
        result.checked += 1
        for (const action of ["open", "close"]) {
            if (schedule[action] !== local.time || schedule.lastRuns?.[action] === local.date) continue
            result.due += 1
            const policy = await common.resolveFeaturePolicy(sock, groupJid, FEATURE_NAME, context, {
                getGroupMetadata: buildFreshMetadataResolver(sock),
            })
            if (!policy.allowed) {
                result.skipped += 1
                markScheduleAttempt(store, groupJid, action, local.date, { status: "skipped", reason: policy.reason })
                console.log(`[GROUP SCHEDULE] SKIP ${groupJid} action=${action.toUpperCase()} at=${local.date} ${local.time} reason=${policy.reason}`)
                continue
            }
            try {
                await sock.groupSettingUpdate(groupJid, action === "open" ? "not_announcement" : "announcement")
                result.executed += 1
                markScheduleAttempt(store, groupJid, action, local.date, { status: "executed" })
                console.log(`[GROUP SCHEDULE] ${action.toUpperCase()} ${groupJid} at=${local.date} ${local.time}`)
            } catch (error) {
                result.skipped += 1
                markScheduleAttempt(store, groupJid, action, local.date, { status: "failed", reason: String(error?.message || error).slice(0, 180) })
                console.log(`[GROUP SCHEDULE] SKIP ${groupJid} action=${action.toUpperCase()} at=${local.date} ${local.time} reason=${String(error?.message || error).slice(0, 180)}`)
            }
        }
    }
    return result
}

function triggerScheduleTick() {
    if (tickPromise || !schedulerSock) return tickPromise
    tickPromise = runScheduleTick(schedulerSock, schedulerContext)
        .catch(error => console.log(`[GROUP SCHEDULE] Tick gagal: ${String(error?.message || error).slice(0, 240)}`))
        .finally(() => { tickPromise = null })
    return tickPromise
}

function installGroupScheduleManager(sock, context = {}) {
    schedulerSock = sock
    schedulerContext = context
    if (schedulerTimer) return false
    schedulerTimer = setInterval(triggerScheduleTick, Number(context.tickIntervalMs || TICK_INTERVAL_MS))
    if (typeof schedulerTimer.unref === "function") schedulerTimer.unref()
    triggerScheduleTick()
    return true
}

function disposeGroupScheduleManager(sock) {
    if (sock && schedulerSock && sock !== schedulerSock) return false
    if (schedulerTimer) clearInterval(schedulerTimer)
    schedulerTimer = null
    schedulerSock = null
    schedulerContext = {}
    return true
}

function getSchedulerRuntimeStatus() {
    return { installed: Boolean(schedulerTimer), running: Boolean(tickPromise), timeZone: TIME_ZONE }
}

module.exports = {
    FEATURE_NAME,
    TICK_INTERVAL_MS,
    TIME_ZONE,
    buildFreshMetadataResolver,
    disposeGroupScheduleManager,
    formatScheduleStatus,
    getJakartaParts,
    getSchedulerRuntimeStatus,
    handleGroupScheduleCommand,
    installGroupScheduleManager,
    isScheduleCommand,
    isValidTime,
    normalizeSchedule,
    parseScheduleCommand,
    runScheduleTick,
}
