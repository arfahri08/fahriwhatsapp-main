"use strict"

const common = require("./groupUtilityCommon")
const defaultStore = require("./groupUtilityStore")

const FEATURE_NAME = "groupAttendance"
const COMMAND_PATTERN = /^(?:\.mulaiabsen|\.absen|\.cekabsen|\.hapusabsen)(?:\s|$)/i
const MAX_ARCHIVES = 10

function isAttendanceCommand(text) {
    return COMMAND_PATTERN.test(String(text || "").trim())
}

function normalizeAttendance(value = {}) {
    return {
        ...value,
        active: value.active && typeof value.active === "object" ? value.active : null,
        archives: Array.isArray(value.archives) ? value.archives.slice(-MAX_ARCHIVES) : [],
    }
}

function updateAttendance(store, groupJid, mutator) {
    return store.updateGroup(groupJid, group => {
        const attendance = normalizeAttendance(group.attendance)
        const next = mutator(attendance) || attendance
        return { ...group, attendance: next }
    })
}

function formatSession(session) {
    const participants = Object.values(session?.participants || {}).sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
    const lines = [
        `ABSENSI: ${session?.title || "Absensi Grup"}`,
        `Dibuat: ${session?.createdAt || "-"}`,
        `Hadir: ${participants.length}`,
        "",
    ]
    if (!participants.length) lines.push("Belum ada peserta yang absen.")
    participants.forEach((item, index) => {
        lines.push(`${index + 1}. @${String(item.jid || "anggota").split("@")[0]} — ${item.name || "Anggota"}`)
    })
    return { text: lines.join("\n"), mentions: common.unique(participants.map(item => item.jid)) }
}

async function handleStart(sock, msg, access, argument, context, store) {
    const current = normalizeAttendance(store.getGroup(access.groupJid)?.attendance)
    if (current.active) {
        await sock.sendMessage(access.groupJid, { text: `Absensi "${current.active.title}" masih aktif. Tutup dengan .hapusabsen terlebih dahulu.` }, { quoted: msg })
        return true
    }
    const title = String(argument || "Absensi Grup").trim().slice(0, 200) || "Absensi Grup"
    const session = {
        id: `${Date.now()}-${String(msg?.key?.id || "session")}`,
        title,
        createdBy: access.senderJid,
        by: access.senderJid,
        createdAt: new Date().toISOString(),
        participants: {},
    }
    updateAttendance(store, access.groupJid, attendance => ({ ...attendance, active: session }))
    await sock.sendMessage(access.groupJid, {
        text: `Absensi "${title}" dimulai. Anggota dapat mengetik .absen.`,
    }, { quoted: msg })
    return true
}

async function handleAttend(sock, msg, access, context, store) {
    const attendance = normalizeAttendance(store.getGroup(access.groupJid)?.attendance)
    if (!attendance.active) {
        await sock.sendMessage(access.groupJid, { text: "Belum ada sesi absensi aktif." }, { quoted: msg })
        return true
    }
    const senderCandidates = common.getSenderCandidates(msg, access.senderJid)
    const participant = common.findParticipant(access.policy.metadata, senderCandidates, context)
    if (!participant) {
        await sock.sendMessage(access.groupJid, { text: "Identitas anggota tidak dapat dicocokkan dengan metadata grup." }, { quoted: msg })
        return true
    }
    const key = common.participantIdentityKey(participant, context, senderCandidates)
    const jid = common.getPreferredJid(participant, context)
    if (attendance.active.participants?.[key]) {
        await sock.sendMessage(access.groupJid, { text: `@${jid.split("@")[0]} sudah tercatat hadir.`, mentions: [jid] }, { quoted: msg })
        return true
    }
    const record = { jid, name: String(msg?.pushName || "Anggota").slice(0, 100), at: Date.now(), createdAt: new Date().toISOString() }
    updateAttendance(store, access.groupJid, current => ({
        ...current,
        active: {
            ...current.active,
            participants: { ...(current.active?.participants || {}), [key]: record },
        },
    }))
    await sock.sendMessage(access.groupJid, { text: `Kehadiran @${jid.split("@")[0]} tercatat.`, mentions: [jid] }, { quoted: msg })
    return true
}

async function handleClose(sock, msg, access, store) {
    const attendance = normalizeAttendance(store.getGroup(access.groupJid)?.attendance)
    if (!attendance.active) {
        await sock.sendMessage(access.groupJid, { text: "Tidak ada sesi absensi aktif." }, { quoted: msg })
        return true
    }
    const closed = { ...attendance.active, closedAt: new Date().toISOString(), closedBy: access.senderJid }
    updateAttendance(store, access.groupJid, current => ({
        ...current,
        active: null,
        archives: [...(current.archives || []), closed].slice(-MAX_ARCHIVES),
    }))
    await sock.sendMessage(access.groupJid, { text: `Absensi "${closed.title}" ditutup dengan ${Object.keys(closed.participants || {}).length} peserta.` }, { quoted: msg })
    return true
}

async function handleGroupAttendanceCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    if (!isAttendanceCommand(text)) return false
    const command = text.split(/\s+/)[0].toLowerCase()
    const argument = text.slice(command.length).trim()
    const allowAnySender = command === ".absen" || command === ".cekabsen"
    const access = await common.resolveCommandAccess(sock, msg, FEATURE_NAME, context, { allowAnySender })
    if (access.hardDenied) return true
    if (!access.allowed) {
        await sock.sendMessage(access.groupJid, { text: "Perintah ini hanya untuk admin grup atau owner bot." }, { quoted: msg })
        return true
    }
    const store = context.store || defaultStore
    if (command === ".mulaiabsen") return handleStart(sock, msg, access, argument, context, store)
    if (command === ".absen") return handleAttend(sock, msg, access, context, store)
    if (command === ".cekabsen") {
        const session = normalizeAttendance(store.getGroup(access.groupJid)?.attendance).active
        if (!session) {
            await sock.sendMessage(access.groupJid, { text: "Belum ada sesi absensi aktif." }, { quoted: msg })
            return true
        }
        await sock.sendMessage(access.groupJid, formatSession(session), { quoted: msg })
        return true
    }
    if (command === ".hapusabsen") return handleClose(sock, msg, access, store)
    return false
}

module.exports = {
    FEATURE_NAME,
    MAX_ARCHIVES,
    formatSession,
    handleGroupAttendanceCommand,
    isAttendanceCommand,
    normalizeAttendance,
}
