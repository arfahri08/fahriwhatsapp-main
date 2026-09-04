"use strict"

const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const { createAtomicJsonStore } = require("./atomicJsonStore")
const groupRuntimePolicy = require("./groupRuntimePolicy")
const defaultGroupRemoteControl = require("./groupRemoteControl")
const mediaCommon = require("./groupUtilityCommon")

const STATE_FILE = process.env.CONTROLLED_BROADCAST_STATE_FILE
    ? path.resolve(process.env.CONTROLLED_BROADCAST_STATE_FILE)
    : path.join(__dirname, "..", "data", "broadcastState.json")
const MEDIA_DIR = process.env.CONTROLLED_BROADCAST_MEDIA_DIR
    ? path.resolve(process.env.CONTROLLED_BROADCAST_MEDIA_DIR)
    : path.join(__dirname, "..", "data", "broadcast-media")
const FEATURE_NAME = "broadcast"
const MIN_DELAY_SECONDS = 3
const MAX_DELAY_SECONDS = 60
const DEFAULT_DELAY_SECONDS = 5
const MAX_MEDIA_BYTES = 16 * 1024 * 1024
const activeExecutions = new Map()

const store = createAtomicJsonStore({
    filePath: STATE_FILE,
    label: "CONTROLLED JPM",
    defaultState: () => ({
        version: 1,
        config: { delaySeconds: DEFAULT_DELAY_SECONDS, whitelist: [], blacklist: [] },
        job: null,
    }),
})

function uniqueGroupJids(values = []) {
    return [...new Set((Array.isArray(values) ? values : [values])
        .map(groupRuntimePolicy.normalizeJid)
        .filter(groupRuntimePolicy.isGroupJid))]
}

function normalizeState(value = store.snapshot()) {
    const config = value.config && typeof value.config === "object" ? value.config : {}
    const delay = Number(config.delaySeconds)
    return {
        ...value,
        config: {
            ...config,
            delaySeconds: Number.isInteger(delay) && delay >= MIN_DELAY_SECONDS && delay <= MAX_DELAY_SECONDS ? delay : DEFAULT_DELAY_SECONDS,
            whitelist: uniqueGroupJids(config.whitelist),
            blacklist: uniqueGroupJids(config.blacklist),
        },
        job: value.job && typeof value.job === "object" ? value.job : null,
    }
}

function snapshot() {
    return normalizeState(store.snapshot())
}

function update(mutator) {
    return normalizeState(store.update(state => {
        const normalized = normalizeState(state)
        return mutator(normalized) || normalized
    }))
}

function makeId(prefix = "JPM") {
    return `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`
}

async function getAllGroups(sock) {
    const records = await sock?.groupFetchAllParticipating?.()
    const values = Array.isArray(records) ? records : Object.values(records || {})
    return uniqueGroupJids(values.map(item => item?.id || item?.jid || item))
}

function selectTargets(groups, mode, config) {
    const all = uniqueGroupJids(groups)
    if (mode === "whitelist") {
        const allowed = new Set(config.whitelist)
        return all.filter(jid => allowed.has(jid))
    }
    if (mode === "except-blacklist") {
        const blocked = new Set(config.blacklist)
        return all.filter(jid => !blocked.has(jid))
    }
    return all
}

function freshMetadata(sock) {
    return async jid => {
        if (typeof sock?.__resolveGroupMetadataForRuntimePolicy === "function") {
            return sock.__resolveGroupMetadataForRuntimePolicy(jid, { forceRefresh: true })
        }
        return sock?.groupMetadata?.(jid)
    }
}

async function resolveTargetPolicy(sock, jid, context = {}) {
    return groupRuntimePolicy.resolveGroupRuntimePolicy(sock, jid, {
        groupRemoteControl: context.groupRemoteControl || defaultGroupRemoteControl,
        featureName: FEATURE_NAME,
        getGroupMetadata: freshMetadata(sock),
    })
}

async function previewTargets(sock, mode, context = {}) {
    const current = snapshot()
    const discovered = await getAllGroups(sock)
    const selected = selectTargets(discovered, mode, current.config)
    const targets = []
    const counts = { found: discovered.length, selected: selected.length, eligible: 0, botNotAdmin: 0, botOff: 0, metadataUnavailable: 0, featureOff: 0 }
    for (const jid of selected) {
        const policy = await resolveTargetPolicy(sock, jid, context)
        const status = policy.allowed ? "PENDING" : "SKIPPED_PREVIEW"
        targets.push({ jid, status, previewReason: policy.allowed ? "eligible" : policy.reason })
        if (policy.allowed) counts.eligible += 1
        else if (policy.reason === "bot-not-admin") counts.botNotAdmin += 1
        else if (policy.reason === "metadata-unavailable") counts.metadataUnavailable += 1
        else if (policy.reason === "group-bot-off") counts.botOff += 1
        else counts.featureOff += 1
    }
    return { counts, targets }
}

function contentFile(jobId, extension = "bin") {
    const safeId = String(jobId || "job").replace(/[^a-z0-9_-]/gi, "")
    return path.join(MEDIA_DIR, `${safeId}.${String(extension || "bin").replace(/[^a-z0-9]/gi, "")}`)
}

async function captureContent(sock, msg, context = {}, jobId = makeId()) {
    const descriptor = mediaCommon.getMediaDescriptor(msg, { preferQuoted: true })
    if (!descriptor) {
        const text = String(context.text || mediaCommon.extractQuotedText(msg) || "").trim()
        if (!text) throw new Error("Kirim atau reply teks/media untuk isi JPM")
        return { type: "text", text: text.slice(0, 4096) }
    }
    const buffer = await mediaCommon.downloadMedia(sock, descriptor, context)
    if (!buffer?.length || buffer.length > MAX_MEDIA_BYTES) throw new Error("Media JPM kosong atau melebihi 16 MB")
    const type = descriptor.type.replace(/Message$/, "")
    const extension = type === "image" ? "jpg" : type === "video" ? "mp4" : type === "audio" ? "ogg" : "bin"
    const file = contentFile(jobId, extension)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, buffer, { mode: 0o600 })
    return {
        type,
        file,
        caption: String(descriptor.media?.caption || context.text || "").trim().slice(0, 4096),
        mimetype: String(descriptor.media?.mimetype || ""),
        fileName: String(descriptor.media?.fileName || `broadcast.${extension}`).slice(0, 120),
        ptt: Boolean(descriptor.media?.ptt),
    }
}

function materializeContent(content) {
    if (content?.type === "text") return { text: String(content.text || "") }
    const buffer = fs.readFileSync(content.file)
    if (content.type === "image") return { image: buffer, caption: content.caption || "", mimetype: content.mimetype || undefined }
    if (content.type === "video") return { video: buffer, caption: content.caption || "", mimetype: content.mimetype || undefined }
    if (content.type === "audio") return { audio: buffer, mimetype: content.mimetype || "audio/ogg; codecs=opus", ptt: content.ptt === true }
    if (content.type === "document") return { document: buffer, mimetype: content.mimetype || "application/octet-stream", fileName: content.fileName || "broadcast.bin", caption: content.caption || "" }
    throw new Error("Tipe konten JPM tidak didukung")
}

function formatPreview(job) {
    const counts = job?.preview || {}
    const delay = Number(job?.delaySeconds || DEFAULT_DELAY_SECONDS)
    const estimate = Math.ceil(Number(counts.eligible || 0) * delay / 60)
    return [
        "PREVIEW JPM TERKONTROL",
        "",
        `Job: ${job?.id || "-"}`,
        `Grup ditemukan: ${counts.found || 0}`,
        `Grup terpilih: ${counts.selected || 0}`,
        `Eligible: ${counts.eligible || 0}`,
        `Skip bot bukan admin: ${counts.botNotAdmin || 0}`,
        `Skip Group Bot OFF: ${counts.botOff || 0}`,
        `Skip metadata gagal: ${counts.metadataUnavailable || 0}`,
        `Skip feature OFF: ${counts.featureOff || 0}`,
        `Delay: ${delay} detik`,
        `Estimasi: sekitar ${estimate} menit`,
        "",
        "Balas KONFIRMASI atau BATAL.",
    ].join("\n")
}

function jobProgress(job) {
    const targets = Array.isArray(job?.targets) ? job.targets : []
    const count = status => targets.filter(target => target.status === status).length
    return {
        total: targets.length,
        sent: count("SENT"),
        pending: count("PENDING"),
        skipped: targets.filter(target => String(target.status).startsWith("SKIPPED")).length,
        failed: count("FAILED_AMBIGUOUS"),
    }
}

async function cooperativeDelay(ms, jobId, context = {}) {
    const sleep = context.sleep || (delay => new Promise(resolve => setTimeout(resolve, delay)))
    let remaining = Math.max(0, Number(ms || 0))
    while (remaining > 0) {
        const current = snapshot().job
        if (!current || current.id !== jobId || current.stopRequested) return false
        const part = Math.min(250, remaining)
        await sleep(part)
        remaining -= part
    }
    return true
}

async function executeJob(sock, jobId, context = {}) {
    if (activeExecutions.has(jobId)) return activeExecutions.get(jobId)
    const execution = (async () => {
        let state = snapshot()
        if (!state.job || state.job.id !== jobId) return { started: false, reason: "job-not-found" }
        update(current => ({ ...current, job: { ...current.job, status: "RUNNING", stopRequested: false, startedAt: current.job.startedAt || new Date().toISOString() } }))
        for (;;) {
            state = snapshot()
            const job = state.job
            if (!job || job.id !== jobId) break
            if (job.stopRequested) {
                update(current => ({ ...current, job: { ...current.job, status: "STOPPED", stoppedAt: new Date().toISOString() } }))
                break
            }
            if (job.status !== "RUNNING") break
            const target = (job.targets || []).find(item => item.status === "PENDING")
            if (!target) {
                update(current => ({ ...current, job: { ...current.job, status: "COMPLETED", completedAt: new Date().toISOString() } }))
                break
            }
            const policy = await resolveTargetPolicy(sock, target.jid, context)
            if (!policy.allowed) {
                update(current => ({ ...current, job: { ...current.job, targets: current.job.targets.map(item => item.jid === target.jid ? { ...item, status: "SKIPPED_RUNTIME", reason: policy.reason, finishedAt: new Date().toISOString() } : item) } }))
                console.log(`[CONTROLLED JPM] SKIP ${target.jid} reason=${policy.reason}`)
                continue
            }
            // Mark SENDING before the network call. An ambiguous response is terminal
            // and never auto-retried, preventing accidental duplicate mass messages.
            const attemptId = crypto.randomUUID()
            update(current => ({ ...current, job: { ...current.job, targets: current.job.targets.map(item => item.jid === target.jid ? { ...item, status: "SENDING", attemptId, attemptedAt: new Date().toISOString() } : item) } }))
            try {
                await sock.sendMessage(target.jid, materializeContent(job.content))
                update(current => ({ ...current, job: { ...current.job, targets: current.job.targets.map(item => item.jid === target.jid ? { ...item, status: "SENT", sentAt: new Date().toISOString() } : item) } }))
            } catch (error) {
                update(current => ({ ...current, job: { ...current.job, targets: current.job.targets.map(item => item.jid === target.jid ? { ...item, status: "FAILED_AMBIGUOUS", error: String(error?.message || error).slice(0, 160), finishedAt: new Date().toISOString() } : item) } }))
            }
            const progress = jobProgress(snapshot().job)
            const interval = Number(context.progressEvery || 5)
            if (context.ownerJid && progress.sent > 0 && progress.sent % interval === 0) {
                await sock.sendMessage(context.ownerJid, { text: `Progress JPM ${jobId}: ${progress.sent}/${progress.total}, skip ${progress.skipped}, gagal ${progress.failed}.` })
            }
            if (progress.pending > 0 && !(await cooperativeDelay(Number(job.delaySeconds || DEFAULT_DELAY_SECONDS) * 1000, jobId, context))) continue
        }
        const finalJob = snapshot().job
        const finalProgress = jobProgress(finalJob)
        if (context.ownerJid) {
            try { await sock.sendMessage(context.ownerJid, { text: `JPM ${jobId} ${finalJob?.status || "SELESAI"}: sent ${finalProgress.sent}/${finalProgress.total}, skip ${finalProgress.skipped}, gagal ${finalProgress.failed}, pending ${finalProgress.pending}.` }) } catch {}
        }
        return { started: true, job: finalJob, progress: finalProgress }
    })().finally(() => activeExecutions.delete(jobId))
    activeExecutions.set(jobId, execution)
    return execution
}

function updateList(kind, action, jid) {
    const key = kind === "whitelist" ? "whitelist" : "blacklist"
    return update(state => {
        const current = new Set(state.config[key])
        if (action === "add" && groupRuntimePolicy.isGroupJid(jid)) current.add(groupRuntimePolicy.normalizeJid(jid))
        if (action === "remove") current.delete(groupRuntimePolicy.normalizeJid(jid))
        if (action === "clear") current.clear()
        return { ...state, config: { ...state.config, [key]: [...current] } }
    })
}

function isJpmCommand(text) {
    return /^\.jpm(?:\s|$)/i.test(String(text || "").trim())
}

async function handleControlledBroadcast(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    const state = snapshot()
    const activeWizard = !context.isGroup && context.isOwner && state.job && ["SELECT_TARGET", "WAIT_CONTENT", "PREVIEW"].includes(state.job.status)
    if (!isJpmCommand(text) && !activeWizard) return false
    if (context.isGroup) return true
    if (!context.isOwner) {
        await sock.sendMessage(context.from, { text: "Akses JPM hanya untuk owner melalui private chat." }, { quoted: msg })
        return true
    }
    const parts = text.split(/\s+/)
    const action = String(parts[1] || "").toLowerCase()
    if (isJpmCommand(text) && action === "status") {
        const job = snapshot().job
        const progress = jobProgress(job)
        await sock.sendMessage(context.from, { text: job ? `JPM ${job.id}: ${job.status}\nSent ${progress.sent}/${progress.total}, pending ${progress.pending}, skip ${progress.skipped}, gagal ${progress.failed}.` : "Belum ada job JPM." }, { quoted: msg })
        return true
    }
    if (isJpmCommand(text) && action === "stop") {
        update(current => ({ ...current, job: current.job ? { ...current.job, stopRequested: true, status: "STOPPING" } : null }))
        await sock.sendMessage(context.from, { text: "Permintaan stop JPM diterima." }, { quoted: msg })
        return true
    }
    if (isJpmCommand(text) && action === "delay") {
        const delaySeconds = Number(parts[2])
        if (!Number.isInteger(delaySeconds) || delaySeconds < MIN_DELAY_SECONDS || delaySeconds > MAX_DELAY_SECONDS) {
            await sock.sendMessage(context.from, { text: `Delay JPM harus ${MIN_DELAY_SECONDS}-${MAX_DELAY_SECONDS} detik.` }, { quoted: msg })
            return true
        }
        update(current => ({ ...current, config: { ...current.config, delaySeconds } }))
        await sock.sendMessage(context.from, { text: `Delay JPM diubah menjadi ${delaySeconds} detik.` }, { quoted: msg })
        return true
    }
    if (isJpmCommand(text) && ["blacklist", "whitelist"].includes(action)) {
        const operation = String(parts[2] || "list").toLowerCase()
        const jid = parts[3]
        if (["add", "remove", "clear"].includes(operation)) updateList(action, operation, jid)
        const list = snapshot().config[action]
        await sock.sendMessage(context.from, { text: `${action.toUpperCase()} JPM (${list.length})\n${list.join("\n") || "Kosong"}\n\nFormat: .jpm ${action} add/remove <groupJid>` }, { quoted: msg })
        return true
    }
    if (isJpmCommand(text) && action === "resume") {
        const job = snapshot().job
        if (!job || !["STOPPED", "PAUSED_RESTART", "RUNNING", "STOPPING"].includes(job.status) || !(job.targets || []).some(item => item.status === "PENDING")) {
            await sock.sendMessage(context.from, { text: "Tidak ada job JPM yang dapat dilanjutkan." }, { quoted: msg })
            return true
        }
        update(current => ({ ...current, job: { ...current.job, status: "READY", stopRequested: false } }))
        await sock.sendMessage(context.from, { text: `JPM ${job.id} dilanjutkan secara eksplisit.` }, { quoted: msg })
        void executeJob(sock, job.id, { ...context, ownerJid: context.from }).catch(error => console.log(`[CONTROLLED JPM] Resume gagal: ${String(error?.message || error).slice(0, 180)}`))
        return true
    }

    let job = snapshot().job
    if (isJpmCommand(text)) {
        if (state.job && ["READY", "RUNNING", "STOPPING"].includes(state.job.status)) {
            await sock.sendMessage(context.from, { text: `JPM ${state.job.id} masih ${state.job.status}. Gunakan .jpm status atau .jpm stop terlebih dahulu.` }, { quoted: msg })
            return true
        }
        job = { id: makeId(), ownerJid: context.from, status: "SELECT_TARGET", createdAt: new Date().toISOString(), mode: "", content: null, targets: [], delaySeconds: snapshot().config.delaySeconds }
        update(current => ({ ...current, job }))
        await sock.sendMessage(context.from, { text: "Pilih target JPM:\n- semua\n- whitelist\n- kecuali blacklist\n\nKetik salah satu pilihan." }, { quoted: msg })
        return true
    }
    const lower = text.toLowerCase()
    if (lower === "batal") {
        update(current => ({ ...current, job: current.job ? { ...current.job, status: "CANCELLED", cancelledAt: new Date().toISOString() } : null }))
        await sock.sendMessage(context.from, { text: "JPM dibatalkan." }, { quoted: msg })
        return true
    }
    if (job?.status === "SELECT_TARGET") {
        const mode = lower === "semua" ? "all" : lower === "whitelist" ? "whitelist" : /kecuali\s+blacklist/.test(lower) ? "except-blacklist" : ""
        if (!mode) {
            await sock.sendMessage(context.from, { text: "Pilihan tidak valid. Ketik: semua, whitelist, atau kecuali blacklist." }, { quoted: msg })
            return true
        }
        update(current => ({ ...current, job: { ...current.job, mode, status: "WAIT_CONTENT" } }))
        await sock.sendMessage(context.from, { text: "Kirim atau reply teks/image/video/document/audio yang akan dibroadcast." }, { quoted: msg })
        return true
    }
    if (job?.status === "WAIT_CONTENT") {
        try {
            const content = await captureContent(sock, msg, context, job.id)
            const preview = await previewTargets(sock, job.mode, context)
            update(current => ({ ...current, job: { ...current.job, content, preview: preview.counts, targets: preview.targets, status: "PREVIEW" } }))
            await sock.sendMessage(context.from, { text: formatPreview(snapshot().job) }, { quoted: msg })
        } catch (error) {
            await sock.sendMessage(context.from, { text: `Konten JPM gagal dibaca: ${String(error?.message || error).slice(0, 180)}` }, { quoted: msg })
        }
        return true
    }
    if (job?.status === "PREVIEW" && lower === "konfirmasi") {
        update(current => ({ ...current, job: { ...current.job, status: "READY", stopRequested: false } }))
        await sock.sendMessage(context.from, { text: `JPM ${job.id} dimulai. Gunakan .jpm stop untuk menghentikan.` }, { quoted: msg })
        void executeJob(sock, job.id, { ...context, ownerJid: context.from }).catch(error => console.log(`[CONTROLLED JPM] Eksekusi gagal: ${String(error?.message || error).slice(0, 180)}`))
        return true
    }
    return true
}

function markRestartPaused() {
    const state = snapshot()
    if (state.job?.status === "RUNNING" || state.job?.status === "SENDING" || state.job?.status === "STOPPING") {
        update(current => ({ ...current, job: { ...current.job, status: "PAUSED_RESTART", stopRequested: false, pausedAt: new Date().toISOString(), targets: (current.job.targets || []).map(item => item.status === "SENDING" ? { ...item, status: "FAILED_AMBIGUOUS", reason: "restart-during-send" } : item) } }))
    }
}

function dispose() {
    markRestartPaused()
    activeExecutions.clear()
}

module.exports = {
    DEFAULT_DELAY_SECONDS,
    FEATURE_NAME,
    MAX_DELAY_SECONDS,
    MEDIA_DIR,
    MIN_DELAY_SECONDS,
    STATE_FILE,
    captureContent,
    dispose,
    executeJob,
    formatPreview,
    getAllGroups,
    handleControlledBroadcast,
    isJpmCommand,
    jobProgress,
    markRestartPaused,
    materializeContent,
    previewTargets,
    selectTargets,
    snapshot,
    store,
    uniqueGroupJids,
    update,
}
