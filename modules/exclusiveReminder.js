"use strict"

const store = require("./exclusiveAgentStore")
const reminderContactFlow = require("./reminderContactFlow")
const canonicalIdentity = require("./canonicalIdentity")
const defaultLidAliasStore = require("./lidAliasStore")

const SESSION_TTL_MS = 20 * 60 * 1000
const TICK_MS = 30_000
const sessions = new Map()
let schedulerTimer = null
let schedulerSock = null
let schedulerContext = {}
let tickPromise = null

function sessionKey(value) {
    return String(value || "").trim().toLowerCase()
}

function cleanupSessions(now = Date.now()) {
    for (const [key, session] of sessions) {
        if (!session?.updatedAt || now - session.updatedAt > SESSION_TTL_MS) sessions.delete(key)
    }
}

function getMessageText(msg) {
    let current = msg?.message || {}
    for (let i = 0; i < 8; i += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
        else break
    }
    return String(
        current.conversation
        || current.extendedTextMessage?.text
        || current.imageMessage?.caption
        || current.videoMessage?.caption
        || ""
    ).trim()
}

function normalizeGroupInput(value) {
    const raw = String(value || "").trim()
    const match = raw.match(/(\d{8,25}-?\d*)@g\.us/i)
    return match ? `${match[1]}@g.us`.toLowerCase() : raw
}

async function resolveGroup(sock, value, context = {}) {
    const raw = normalizeGroupInput(value)
    let resolved = null
    if (/@g\.us$/i.test(raw)) {
        resolved = { ok: true, jid: raw }
    } else if (typeof context.resolveGroupTarget === "function") {
        try { resolved = await context.resolveGroupTarget(raw, sock) } catch {}
    }
    if (!resolved?.ok || !/@g\.us$/i.test(String(resolved.jid || ""))) return { ok: false, reason: "invalid-group" }
    try {
        const metadata = typeof sock?.__resolveGroupMetadataForRuntimePolicy === "function"
            ? await sock.__resolveGroupMetadataForRuntimePolicy(resolved.jid, { forceRefresh: true })
            : await sock.groupMetadata(resolved.jid)
        if (!metadata || !Array.isArray(metadata.participants)) return { ok: false, reason: "metadata-unavailable" }
        return { ok: true, jid: resolved.jid, subject: metadata.subject || resolved.subject || resolved.jid, metadata }
    } catch (error) {
        return { ok: false, reason: "metadata-error", error }
    }
}

function participantPhoneNumbers(participant, context = {}) {
    const extra = [
        participant?.phoneNumber,
        participant?.phoneNumberJid,
        participant?.pn,
        participant?.idAlt,
        participant?.participantAlt,
    ].filter(Boolean)
    const identity = canonicalIdentity.participantIdentity(participant, {
        lidAliasStore: context.lidAliasStore || defaultLidAliasStore,
    }, extra)
    const values = new Set()
    if (identity?.number && identity.type === "pn") values.add(identity.number)
    for (const candidate of identity?.candidates || []) {
        const number = canonicalIdentity.normalizePhoneNumber(candidate)
        if (number) values.add(number)
    }
    for (const candidate of extra) {
        const number = canonicalIdentity.normalizePhoneNumber(candidate)
        if (number) values.add(number)
    }
    return values
}

function validateTargetsAgainstMetadata(targets, metadata, context = {}) {
    const memberNumbers = new Set()
    for (const participant of metadata?.participants || []) {
        for (const number of participantPhoneNumbers(participant, context)) memberNumbers.add(number)
    }
    const valid = []
    const invalid = []
    for (const target of reminderContactFlow.uniqueTargets(targets || [])) {
        if (memberNumbers.has(target.number)) valid.push(target)
        else invalid.push(target)
    }
    return { valid, invalid, memberNumbers }
}

function formatTargets(targets = []) {
    return targets.map((target, index) => `${index + 1}. ${target.label || target.number} (${target.number})`).join("\n")
}

async function startWizard(sock, chatJid) {
    sessions.set(sessionKey(chatJid), { stage: "group", chatJid, updatedAt: Date.now() })
    await sock.sendMessage(chatJid, {
        text: [
            "🕌 *REMINDER EKSKLUSIF*",
            "",
            "Kirim *ID grup* yang targetnya sudah diaktifkan dengan *.fitur*.",
            "Boleh group JID `...@g.us` atau kode grup yang dikenali bot.",
        ].join("\n"),
    })
    return true
}

function formatStatus() {
    const settings = store.getSettings()
    const subscriptions = store.listSubscriptions()
    const lines = [
        "🕌 *STATUS REMINDER EKSKLUSIF*",
        "",
        `Jumat default: ${settings.fridayTime || "11:30"} (${settings.timezone || "Asia/Jakarta"})`,
        `Lokasi sholat harian: ${settings.prayerLocation ? `${settings.prayerLocation.latitude}, ${settings.prayerLocation.longitude}` : "belum diatur"}`,
        `Subscription: ${subscriptions.length}`,
    ]
    for (const sub of subscriptions.slice(0, 20)) {
        lines.push(`${sub.id} — ${sub.groupSubject || sub.groupJid} — ${sub.targets?.length || 0} kontak — ${sub.enabled === false ? "OFF" : "ON"}`)
    }
    if (!settings.prayerLocation) lines.push("", "Set lokasi sekali: .fiturreminder lokasi <lat> <lon>")
    return lines.join("\n")
}

async function handleCommand(sock, msg, context = {}) {
    const from = String(context.from || msg?.key?.remoteJid || "")
    const isGroup = context.isGroup === true || /@g\.us$/i.test(from)
    const text = String(context.text || getMessageText(msg)).trim()
    const lower = text.toLowerCase()
    cleanupSessions()

    if (isGroup) return false
    if (!(context.canControlOwner || context.isOwner)) return false

    if (/^\.fiturreminder(?:\s|$)/i.test(text)) {
        const args = text.replace(/^\.fiturreminder\b/i, "").trim().split(/\s+/).filter(Boolean)
        const action = String(args[0] || "").toLowerCase()
        if (!action) return startWizard(sock, from)
        if (action === "batal" || action === "cancel") {
            sessions.delete(sessionKey(from))
            await sock.sendMessage(from, { text: "✅ Wizard reminder dibatalkan." })
            return true
        }
        if (action === "status") {
            await sock.sendMessage(from, { text: formatStatus() })
            return true
        }
        if (action === "hapus" || action === "delete") {
            const id = String(args[1] || "").toUpperCase()
            const removed = store.removeSubscription(id)
            await sock.sendMessage(from, { text: removed ? `✅ ${id} dihapus.` : `❌ Subscription ${id || "?"} tidak ditemukan.` })
            return true
        }
        if (action === "lokasi") {
            try {
                const location = store.setPrayerLocation(args[1], args[2], store.getSettings().timezone || "Asia/Jakarta")
                await sock.sendMessage(from, { text: `✅ Lokasi perhitungan waktu sholat disimpan: ${location.prayerLocation.latitude}, ${location.prayerLocation.longitude}` })
            } catch (error) {
                await sock.sendMessage(from, { text: "Format: .fiturreminder lokasi <latitude> <longitude>" })
            }
            return true
        }
        await sock.sendMessage(from, {
            text: ".fiturreminder | .fiturreminder status | .fiturreminder lokasi <lat> <lon> | .fiturreminder hapus <ERxxxx>",
        })
        return true
    }

    const session = sessions.get(sessionKey(from))
    if (!session) return false
    session.updatedAt = Date.now()

    if (session.stage === "group") {
        const resolved = await resolveGroup(sock, text, context)
        if (!resolved.ok) {
            await sock.sendMessage(from, { text: "❌ Grup tidak dapat diverifikasi. Kirim ID grup/kode yang benar." })
            return true
        }
        if (!store.isEnabled(resolved.jid)) {
            await sock.sendMessage(from, {
                text: `❌ Fitur eksklusif belum ON di *${resolved.subject}*. Jalankan *.fitur* di grup itu dulu, lalu kirim ID grup lagi.`,
            })
            return true
        }
        session.stage = "contacts"
        session.groupJid = resolved.jid
        session.groupSubject = resolved.subject
        session.metadata = resolved.metadata
        await sock.sendMessage(from, {
            text: [
                `✅ Grup: *${resolved.subject}*`,
                "",
                "Sekarang kirim *contact card* orang yang mau menerima reminder.",
                "Boleh satu atau beberapa kontak sekaligus. Semua nomor akan dicek apakah benar masih anggota grup tersebut.",
            ].join("\n"),
        })
        return true
    }

    if (session.stage === "contacts") {
        let targets = reminderContactFlow.extractContactTargets(msg?.message || msg)
        if (!targets.length) targets = reminderContactFlow.extractTextTargets(text)
        if (!targets.length) {
            await sock.sendMessage(from, { text: "❌ Kontak belum terbaca. Kirim contact card WhatsApp atau daftar nomor yang valid." })
            return true
        }

        const refreshed = await resolveGroup(sock, session.groupJid, context)
        if (!refreshed.ok) {
            await sock.sendMessage(from, { text: "❌ Metadata grup gagal dibaca. Tidak ada reminder yang disimpan; coba lagi nanti." })
            return true
        }
        const checked = validateTargetsAgainstMetadata(targets, refreshed.metadata, context)
        if (checked.invalid.length) {
            await sock.sendMessage(from, {
                text: [
                    "❌ *ADA KONTAK YANG TIDAK TERVERIFIKASI SEBAGAI ANGGOTA GRUP*",
                    "",
                    formatTargets(checked.invalid),
                    "",
                    "Tidak ada subscription yang disimpan. Kirim ulang hanya kontak yang memang ada di grup.",
                ].join("\n"),
            })
            return true
        }

        const created = store.addReminderSubscription({
            groupJid: session.groupJid,
            groupSubject: session.groupSubject,
            targets: checked.valid,
            createdBy: context.senderJid || from,
            fridayEnabled: true,
            prayerEnabled: true,
        })
        sessions.delete(sessionKey(from))
        const settings = store.getSettings()
        await sock.sendMessage(from, {
            text: [
                "✅ *REMINDER EKSKLUSIF AKTIF*",
                "",
                `ID: ${created.id}`,
                `Grup: ${created.groupSubject}`,
                `Kontak tervalidasi: ${created.targets.length}`,
                formatTargets(created.targets),
                "",
                `Jumat: aktif setiap Jumat ${settings.fridayTime || "11:30"} (${settings.timezone || "Asia/Jakarta"})`,
                settings.prayerLocation
                    ? "Waktu sholat harian: aktif berdasarkan lokasi yang tersimpan."
                    : "Waktu sholat harian: menunggu lokasi. Set sekali dengan .fiturreminder lokasi <lat> <lon>.",
                "",
                "Saat reminder akan dikirim, keanggotaan grup dicek ulang. Kontak yang sudah keluar grup otomatis tidak dikirimi.",
            ].join("\n"),
        })
        return true
    }

    sessions.delete(sessionKey(from))
    return false
}

function getZonedParts(date = new Date(), timeZone = "Asia/Jakarta") {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date).reduce((out, part) => {
        if (part.type !== "literal") out[part.type] = part.value
        return out
    }, {})
    return {
        year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
        weekday: parts.weekday, hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour}:${parts.minute}`,
    }
}

function timezoneOffsetHours(date, timeZone) {
    const p = getZonedParts(date, timeZone)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    return (asUtc - date.getTime()) / 3_600_000
}

function deg2rad(value) { return value * Math.PI / 180 }
function rad2deg(value) { return value * 180 / Math.PI }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)) }
function normalizeHour(value) { let h = value % 24; if (h < 0) h += 24; return h }

function dayOfYear(year, month, day) {
    const start = Date.UTC(year, 0, 0)
    const current = Date.UTC(year, month - 1, day)
    return Math.floor((current - start) / 86_400_000)
}

function solarDeclinationAndEot(n) {
    const gamma = 2 * Math.PI / 365 * (n - 1)
    const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
        - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
        - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma)
    const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
        - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma))
    return { decl, eot }
}

function hourAngleForZenith(latitudeRad, declinationRad, zenithDeg) {
    const cosH = (Math.cos(deg2rad(zenithDeg)) - Math.sin(latitudeRad) * Math.sin(declinationRad))
        / (Math.cos(latitudeRad) * Math.cos(declinationRad))
    if (cosH < -1 || cosH > 1) return null
    return rad2deg(Math.acos(clamp(cosH, -1, 1))) / 15
}

function hourAngleForAltitude(latitudeRad, declinationRad, altitudeRad) {
    const cosH = (Math.sin(altitudeRad) - Math.sin(latitudeRad) * Math.sin(declinationRad))
        / (Math.cos(latitudeRad) * Math.cos(declinationRad))
    if (cosH < -1 || cosH > 1) return null
    return rad2deg(Math.acos(clamp(cosH, -1, 1))) / 15
}

function formatHour(value) {
    let minutes = Math.round(normalizeHour(value) * 60)
    minutes %= 1440
    const hour = Math.floor(minutes / 60)
    const minute = minutes % 60
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

function computePrayerTimes(date, latitude, longitude, timeZone = "Asia/Jakarta") {
    const zoned = getZonedParts(date, timeZone)
    const n = dayOfYear(zoned.year, zoned.month, zoned.day)
    const { decl, eot } = solarDeclinationAndEot(n)
    const lat = deg2rad(Number(latitude))
    const offset = timezoneOffsetHours(date, timeZone)
    const solarNoon = 12 + offset - Number(longitude) / 15 - eot / 60
    const sunriseHA = hourAngleForZenith(lat, decl, 90.833)
    const fajrHA = hourAngleForZenith(lat, decl, 110) // Kemenag-style Subuh ~20 deg
    const ishaHA = hourAngleForZenith(lat, decl, 108) // Isya ~18 deg
    const shadowAngle = Math.atan(1 / (1 + Math.tan(Math.abs(lat - decl))))
    const asrHA = hourAngleForAltitude(lat, decl, shadowAngle)
    if ([sunriseHA, fajrHA, ishaHA, asrHA].some(value => value == null)) return null
    return {
        subuh: formatHour(solarNoon - fajrHA),
        terbit: formatHour(solarNoon - sunriseHA),
        dzuhur: formatHour(solarNoon + 2 / 60),
        ashar: formatHour(solarNoon + asrHA),
        maghrib: formatHour(solarNoon + sunriseHA + 2 / 60),
        isya: formatHour(solarNoon + ishaHA),
    }
}

function shiftTime(time, minutesDelta) {
    const match = String(time || "").match(/^(\d{2}):(\d{2})$/)
    if (!match) return ""
    let total = Number(match[1]) * 60 + Number(match[2]) + Number(minutesDelta || 0)
    total = ((total % 1440) + 1440) % 1440
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}

async function refreshMembership(sock, subscription, context = {}) {
    const resolved = await resolveGroup(sock, subscription.groupJid, context)
    if (!resolved.ok) return { ok: false, valid: [], invalid: subscription.targets || [], reason: resolved.reason }
    const checked = validateTargetsAgainstMetadata(subscription.targets || [], resolved.metadata, context)
    return { ok: true, ...checked }
}

async function sendReminderToTargets(sock, subscription, event, message, context = {}) {
    const membership = await refreshMembership(sock, subscription, context)
    if (!membership.ok) {
        console.log(`[EXCLUSIVE REMINDER] SKIP ${subscription.id} event=${event} reason=${membership.reason}`)
        return { sent: 0, skipped: subscription.targets?.length || 0, reason: membership.reason }
    }
    let skipped = membership.invalid.length
    if (!membership.valid.length) return { sent: 0, skipped }
    const mentions = membership.valid.map(target => target.jid).filter(Boolean)
    const mentionText = membership.valid.map(target => `@${target.number}`).join(" ")
    try {
        await sock.sendMessage(subscription.groupJid, {
            text: `${message}\n\n${mentionText}`,
            mentions,
        })
        return { sent: membership.valid.length, skipped }
    } catch (error) {
        skipped += membership.valid.length
        console.log(`[EXCLUSIVE REMINDER] send gagal sub=${subscription.id} group=${subscription.groupJid}: ${String(error?.message || error).slice(0, 180)}`)
        return { sent: 0, skipped }
    }
}

async function runReminderTick(sock, context = {}, now = new Date()) {
    if (!sock) return { checked: 0, due: 0, sent: 0, skipped: 0 }
    const settings = store.getSettings()
    const timeZone = settings.timezone || "Asia/Jakarta"
    const local = getZonedParts(now, timeZone)
    const subscriptions = store.listSubscriptions().filter(sub => sub.enabled !== false)
    const result = { checked: subscriptions.length, due: 0, sent: 0, skipped: 0 }
    let prayerTimes = null
    if (settings.prayerLocation) {
        prayerTimes = computePrayerTimes(now, settings.prayerLocation.latitude, settings.prayerLocation.longitude, timeZone)
    }

    for (const subscription of subscriptions) {
        if (!store.isEnabled(subscription.groupJid)) continue
        const events = []
        if (subscription.fridayEnabled !== false && local.weekday === "Fri" && local.time === String(settings.fridayTime || "11:30")) {
            events.push({ key: "jumat", message: "🕌 *Pengingat Sholat Jumat*\n\nWes Jumat. Siap-siap wudhu lan mangkat Sholat Jumat yo. Yen iso ojo mepet wektu." })
        }
        if (subscription.prayerEnabled !== false && prayerTimes) {
            const lead = Number(settings.prayerLeadMinutes || 0)
            for (const [name, time] of Object.entries(prayerTimes)) {
                if (name === "terbit") continue
                if (local.time === shiftTime(time, -lead)) {
                    const label = { subuh: "Subuh", dzuhur: "Dzuhur", ashar: "Ashar", maghrib: "Maghrib", isya: "Isya" }[name] || name
                    events.push({ key: `sholat:${name}`, message: `🕌 *Pengingat ${label}*\n\nPon tekan wektu ${label}. Yen saget mandek sekedap kegiatane lan siap-siap sholat nggeh.` })
                }
            }
        }
        for (const event of events) {
            const runKey = `${local.date}:${event.key}`
            if (subscription.lastRuns?.[event.key] === runKey) continue
            result.due += 1
            const sendResult = await sendReminderToTargets(sock, subscription, event.key, event.message, context)
            result.sent += sendResult.sent
            result.skipped += sendResult.skipped
            store.updateSubscription(subscription.id, current => ({
                ...current,
                lastRuns: { ...(current.lastRuns || {}), [event.key]: runKey },
                lastResult: { event: event.key, at: new Date().toISOString(), ...sendResult },
            }))
            console.log(`[EXCLUSIVE REMINDER] ${subscription.id} event=${event.key} sent=${sendResult.sent} skipped=${sendResult.skipped}`)
        }
    }
    return result
}

function triggerTick() {
    if (!schedulerSock || tickPromise) return tickPromise
    tickPromise = runReminderTick(schedulerSock, schedulerContext)
        .catch(error => console.log(`[EXCLUSIVE REMINDER] Tick gagal: ${String(error?.message || error).slice(0, 240)}`))
        .finally(() => { tickPromise = null })
    return tickPromise
}

function installExclusiveReminder(sock, context = {}) {
    schedulerSock = sock
    schedulerContext = context
    if (schedulerTimer) return false
    schedulerTimer = setInterval(triggerTick, Number(context.tickIntervalMs || TICK_MS))
    if (typeof schedulerTimer.unref === "function") schedulerTimer.unref()
    triggerTick()
    return true
}

function disposeExclusiveReminder(sock) {
    if (sock && schedulerSock && sock !== schedulerSock) return false
    if (schedulerTimer) clearInterval(schedulerTimer)
    schedulerTimer = null
    schedulerSock = null
    schedulerContext = {}
    tickPromise = null
    sessions.clear()
    return true
}

module.exports = {
    cleanupSessions,
    computePrayerTimes,
    disposeExclusiveReminder,
    formatStatus,
    getZonedParts,
    handleCommand,
    installExclusiveReminder,
    participantPhoneNumbers,
    refreshMembership,
    resolveGroup,
    runReminderTick,
    sendReminderToTargets,
    shiftTime,
    validateTargetsAgainstMetadata,
}
