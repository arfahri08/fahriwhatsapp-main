"use strict"

const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const { createAtomicJsonStore } = require("./atomicJsonStore")
const identity = require("./canonicalIdentity")
const reminderContactFlow = require("./reminderContactFlow")
const mediaCommon = require("./groupUtilityCommon")

const STATE_FILE = process.env.CONTACT_PUSH_STATE_FILE
    ? path.resolve(process.env.CONTACT_PUSH_STATE_FILE)
    : path.join(__dirname, "..", "data", "contactPushState.json")
const MEDIA_DIR = process.env.CONTACT_PUSH_MEDIA_DIR
    ? path.resolve(process.env.CONTACT_PUSH_MEDIA_DIR)
    : path.join(__dirname, "..", "data", "contact-push-media")
const MIN_DELAY_SECONDS = 3
const MAX_DELAY_SECONDS = 60
const DEFAULT_DELAY_SECONDS = 5
const MAX_MEDIA_BYTES = 16 * 1024 * 1024
const MAX_VCF_BYTES = 2 * 1024 * 1024
const MAX_TARGETS = 5000
const activeExecutions = new Map()

const store = createAtomicJsonStore({
    filePath: STATE_FILE,
    label: "CONTACT PUSH",
    defaultState: () => ({ version: 1, config: { delaySeconds: DEFAULT_DELAY_SECONDS }, job: null }),
})

function makeId() {
    return `PUSH-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`
}

function snapshot() {
    const state = store.snapshot()
    const delay = Number(state.config?.delaySeconds)
    return {
        ...state,
        config: {
            ...(state.config || {}),
            delaySeconds: Number.isInteger(delay) && delay >= MIN_DELAY_SECONDS && delay <= MAX_DELAY_SECONDS ? delay : DEFAULT_DELAY_SECONDS,
        },
        job: state.job && typeof state.job === "object" ? state.job : null,
    }
}

function update(mutator) {
    store.update(state => mutator({ ...state }) || state)
    return snapshot()
}

function rawContactCount(message) {
    const current = mediaCommon.unwrapMessage(message || {})
    if (current.contactMessage) return 1
    if (Array.isArray(current.contactsArrayMessage?.contacts)) return current.contactsArrayMessage.contacts.length
    return 0
}

function parseVcfText(text) {
    const cards = String(text || "").split(/(?=BEGIN:VCARD)/i).filter(card => /BEGIN:VCARD/i.test(card))
    const targets = []
    let invalid = 0
    for (const card of cards) {
        const parsed = reminderContactFlow.extractContactTargets({ contactMessage: { displayName: (/^FN:(.*)$/im.exec(card)?.[1] || "Kontak").trim(), vcard: card } })
        if (!parsed.length) invalid += 1
        targets.push(...parsed)
    }
    return { targets, raw: cards.length, invalid }
}

function dedupeTargets(targets = [], context = {}, sock = null) {
    const botCandidates = sock ? require("./groupRuntimePolicy").getBotIdentityCandidates(sock) : []
    const botKeys = new Set(botCandidates.map(value => identity.canonicalIdentity(value, context).key).filter(Boolean))
    const seen = new Set()
    const result = []
    let duplicate = 0
    let invalid = 0
    for (const target of targets) {
        const canonical = identity.canonicalIdentity([target?.jid, target?.number], context)
        if (!canonical.key || canonical.type !== "pn") {
            invalid += 1
            continue
        }
        if (botKeys.has(canonical.key)) continue
        if (seen.has(canonical.key)) {
            duplicate += 1
            continue
        }
        seen.add(canonical.key)
        if (result.length >= MAX_TARGETS) {
            invalid += 1
            continue
        }
        result.push({ key: canonical.key, jid: canonical.jid, number: canonical.number, label: String(target?.label || canonical.number).slice(0, 100), status: "PENDING" })
    }
    return { targets: result, duplicate, invalid }
}

async function parseContactInput(sock, msg, context = {}) {
    if (typeof context.parseContacts === "function") return context.parseContacts(msg)
    const message = mediaCommon.unwrapMessage(msg?.message || {})
    const direct = reminderContactFlow.extractContactTargets(message)
    if (direct.length || rawContactCount(message)) {
        return { targets: direct, raw: rawContactCount(message), invalid: Math.max(0, rawContactCount(message) - direct.length) }
    }
    const descriptor = mediaCommon.getMediaDescriptor(msg, { preferQuoted: true })
    if (descriptor?.type === "documentMessage" && (/vcard|text\/x-vcard/i.test(descriptor.media?.mimetype || "") || /\.vcf$/i.test(descriptor.media?.fileName || ""))) {
        const buffer = await mediaCommon.downloadMedia(sock, descriptor, context)
        if (!buffer?.length || buffer.length > MAX_VCF_BYTES) throw new Error("VCF kosong atau melebihi 2 MB")
        return parseVcfText(buffer.toString("utf8"))
    }
    const corrections = reminderContactFlow.extractTextTargets(String(context.text || ""))
    return { targets: corrections, raw: corrections.length, invalid: 0 }
}

async function capturePushContent(sock, msg, context, jobId) {
    const descriptor = mediaCommon.getMediaDescriptor(msg, { preferQuoted: true })
    if (!descriptor) {
        const text = String(context.text || mediaCommon.extractQuotedText(msg) || "").trim()
        if (!text) throw new Error("Pesan push kosong")
        return { type: "text", text: text.slice(0, 4096) }
    }
    const buffer = await mediaCommon.downloadMedia(sock, descriptor, context)
    if (!buffer?.length || buffer.length > MAX_MEDIA_BYTES) throw new Error("Media push kosong atau melebihi 16 MB")
    const type = descriptor.type.replace(/Message$/, "")
    const ext = type === "image" ? "jpg" : type === "video" ? "mp4" : type === "audio" ? "ogg" : "bin"
    fs.mkdirSync(MEDIA_DIR, { recursive: true })
    const file = path.join(MEDIA_DIR, `${String(jobId).replace(/[^a-z0-9_-]/gi, "")}.${ext}`)
    fs.writeFileSync(file, buffer, { mode: 0o600 })
    return { type, file, caption: String(descriptor.media?.caption || context.text || "").slice(0, 4096), mimetype: descriptor.media?.mimetype || "", fileName: descriptor.media?.fileName || `pesan.${ext}`, ptt: Boolean(descriptor.media?.ptt) }
}

function materializeContent(content) {
    if (content?.type === "text") return { text: content.text }
    const data = fs.readFileSync(content.file)
    if (content.type === "image") return { image: data, caption: content.caption || "" }
    if (content.type === "video") return { video: data, caption: content.caption || "", mimetype: content.mimetype || undefined }
    if (content.type === "audio") return { audio: data, ptt: content.ptt === true, mimetype: content.mimetype || "audio/ogg; codecs=opus" }
    if (content.type === "document") return { document: data, fileName: content.fileName || "dokumen", mimetype: content.mimetype || "application/octet-stream", caption: content.caption || "" }
    throw new Error("Tipe pesan push tidak didukung")
}

function progress(job) {
    const targets = job?.targets || []
    return {
        total: targets.length,
        sent: targets.filter(item => item.status === "SENT").length,
        pending: targets.filter(item => item.status === "PENDING").length,
        failed: targets.filter(item => item.status === "FAILED_AMBIGUOUS").length,
    }
}

async function executeJob(sock, jobId, context = {}) {
    if (activeExecutions.has(jobId)) return activeExecutions.get(jobId)
    const promise = (async () => {
        update(state => ({ ...state, job: state.job?.id === jobId ? { ...state.job, status: "RUNNING", stopRequested: false } : state.job }))
        for (;;) {
            const job = snapshot().job
            if (!job || job.id !== jobId) break
            if (job.stopRequested) {
                update(state => ({ ...state, job: { ...state.job, status: "STOPPED", stoppedAt: new Date().toISOString() } }))
                break
            }
            const target = job.targets.find(item => item.status === "PENDING")
            if (!target) {
                update(state => ({ ...state, job: { ...state.job, status: "COMPLETED", completedAt: new Date().toISOString() } }))
                break
            }
            const attemptId = crypto.randomUUID()
            update(state => ({ ...state, job: { ...state.job, targets: state.job.targets.map(item => item.key === target.key ? { ...item, status: "SENDING", attemptId, attemptedAt: new Date().toISOString() } : item) } }))
            try {
                await sock.sendMessage(target.jid, materializeContent(job.content))
                update(state => ({ ...state, job: { ...state.job, targets: state.job.targets.map(item => item.key === target.key ? { ...item, status: "SENT", sentAt: new Date().toISOString() } : item) } }))
            } catch (error) {
                update(state => ({ ...state, job: { ...state.job, targets: state.job.targets.map(item => item.key === target.key ? { ...item, status: "FAILED_AMBIGUOUS", error: String(error?.message || error).slice(0, 160) } : item) } }))
            }
            const currentProgress = progress(snapshot().job)
            if (context.from && currentProgress.sent > 0 && currentProgress.sent % Number(context.progressEvery || 5) === 0) {
                try { await sock.sendMessage(context.from, { text: `Progress push ${jobId}: ${currentProgress.sent}/${currentProgress.total}, gagal ${currentProgress.failed}.` }) } catch {}
            }
            if (progress(snapshot().job).pending > 0) {
                const sleep = context.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
                let remaining = Number(job.delaySeconds || DEFAULT_DELAY_SECONDS) * 1000
                while (remaining > 0 && !snapshot().job?.stopRequested) {
                    const chunk = Math.min(250, remaining)
                    await sleep(chunk)
                    remaining -= chunk
                }
                if (snapshot().job?.stopRequested) continue
            }
        }
        const finalJob = snapshot().job
        const finalProgress = progress(finalJob)
        if (context.from) {
            try { await sock.sendMessage(context.from, { text: `Push ${jobId} ${finalJob?.status || "SELESAI"}: sent ${finalProgress.sent}/${finalProgress.total}, gagal ${finalProgress.failed}, pending ${finalProgress.pending}.` }) } catch {}
        }
        return { job: finalJob, progress: finalProgress }
    })().finally(() => activeExecutions.delete(jobId))
    activeExecutions.set(jobId, promise)
    return promise
}

function isPushCommand(text) {
    return /^\.pushkontak(?:\s|$)/i.test(String(text || "").trim())
}

async function handleContactPush(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    const current = snapshot().job
    const active = !context.isGroup && context.isOwner && current && ["CONTACTS", "MESSAGE", "PREVIEW"].includes(current.status)
    if (!isPushCommand(text) && !active) return false
    if (context.isGroup) return true
    if (!context.isOwner) {
        await sock.sendMessage(context.from, { text: "Push kontak hanya untuk owner melalui private chat." }, { quoted: msg })
        return true
    }
    const parts = text.split(/\s+/)
    const action = String(parts[1] || "").toLowerCase()
    if (isPushCommand(text) && action === "status") {
        const job = snapshot().job
        const stats = progress(job)
        await sock.sendMessage(context.from, { text: job ? `Push ${job.id}: ${job.status}; sent ${stats.sent}/${stats.total}, pending ${stats.pending}, gagal ${stats.failed}.` : "Belum ada job push kontak." }, { quoted: msg })
        return true
    }
    if (isPushCommand(text) && action === "stop") {
        update(state => ({ ...state, job: state.job ? { ...state.job, stopRequested: true, status: "STOPPING" } : null }))
        await sock.sendMessage(context.from, { text: "Permintaan stop push kontak diterima." }, { quoted: msg })
        return true
    }
    if (isPushCommand(text) && action === "delay") {
        const delaySeconds = Number(parts[2])
        if (!Number.isInteger(delaySeconds) || delaySeconds < MIN_DELAY_SECONDS || delaySeconds > MAX_DELAY_SECONDS) {
            await sock.sendMessage(context.from, { text: `Delay harus ${MIN_DELAY_SECONDS}-${MAX_DELAY_SECONDS} detik.` }, { quoted: msg })
            return true
        }
        update(state => ({ ...state, config: { ...state.config, delaySeconds } }))
        await sock.sendMessage(context.from, { text: `Delay push kontak: ${delaySeconds} detik.` }, { quoted: msg })
        return true
    }
    if (isPushCommand(text)) {
        if (current && ["READY", "RUNNING", "STOPPING"].includes(current.status)) {
            await sock.sendMessage(context.from, { text: `Push ${current.id} masih ${current.status}. Gunakan .pushkontak status atau .pushkontak stop.` }, { quoted: msg })
            return true
        }
        const job = { id: makeId(), ownerJid: context.from, status: "CONTACTS", createdAt: new Date().toISOString(), targets: [], rawCount: 0, duplicateCount: 0, invalidCount: 0, content: null, delaySeconds: snapshot().config.delaySeconds }
        update(state => ({ ...state, job }))
        await sock.sendMessage(context.from, { text: "Kirim kartu kontak, beberapa kontak, atau document VCF. Bisa kirim koreksi tambahan, lalu ketik LANJUT." }, { quoted: msg })
        return true
    }
    const lower = text.toLowerCase()
    if (lower === "batal") {
        update(state => ({ ...state, job: state.job ? { ...state.job, status: "CANCELLED" } : null }))
        await sock.sendMessage(context.from, { text: "Push kontak dibatalkan." }, { quoted: msg })
        return true
    }
    const job = snapshot().job
    if (job?.status === "CONTACTS") {
        if (lower === "lanjut") {
            if (!job.targets.length) {
                await sock.sendMessage(context.from, { text: "Belum ada kontak valid. Kirim kontak/VCF terlebih dahulu." }, { quoted: msg })
                return true
            }
            update(state => ({ ...state, job: { ...state.job, status: "MESSAGE" } }))
            await sock.sendMessage(context.from, { text: "Sekarang kirim atau reply pesan text/media yang akan dikirim ke kontak." }, { quoted: msg })
            return true
        }
        const parsed = await parseContactInput(sock, msg, context)
        const combined = dedupeTargets([...(job.targets || []), ...(parsed.targets || [])], context, sock)
        const previousCount = job.targets.length
        const added = Math.max(0, combined.targets.length - previousCount)
        update(state => ({ ...state, job: { ...state.job, targets: combined.targets, rawCount: Number(state.job.rawCount || 0) + Number(parsed.raw || 0), duplicateCount: Number(state.job.duplicateCount || 0) + combined.duplicate, invalidCount: Number(state.job.invalidCount || 0) + Number(parsed.invalid || 0) + combined.invalid } }))
        const latest = snapshot().job
        await sock.sendMessage(context.from, { text: `Kontak: ${latest.rawCount} terdeteksi, ${latest.targets.length} valid unik, ${latest.duplicateCount} duplicate, ${latest.invalidCount} invalid. Ditambah ${added}. Ketik LANJUT atau kirim koreksi.` }, { quoted: msg })
        return true
    }
    if (job?.status === "MESSAGE") {
        try {
            const content = await capturePushContent(sock, msg, context, job.id)
            update(state => ({ ...state, job: { ...state.job, content, status: "PREVIEW" } }))
            const latest = snapshot().job
            const samples = latest.targets.slice(0, 5).map(item => `***${item.number.slice(-4)}`).join(", ")
            await sock.sendMessage(context.from, { text: `PREVIEW PUSH KONTAK\nValid: ${latest.targets.length}\nDuplicate: ${latest.duplicateCount}\nInvalid: ${latest.invalidCount}\nSample: ${samples || "-"}\nDelay: ${latest.delaySeconds} detik\n\nBalas KONFIRMASI atau BATAL.` }, { quoted: msg })
        } catch (error) {
            await sock.sendMessage(context.from, { text: `Pesan push gagal dibaca: ${String(error?.message || error).slice(0, 180)}` }, { quoted: msg })
        }
        return true
    }
    if (job?.status === "PREVIEW" && lower === "konfirmasi") {
        update(state => ({ ...state, job: { ...state.job, status: "READY", stopRequested: false } }))
        await sock.sendMessage(context.from, { text: `Push kontak ${job.id} dimulai.` }, { quoted: msg })
        void executeJob(sock, job.id, context).catch(error => console.log(`[CONTACT PUSH] Eksekusi gagal: ${String(error?.message || error).slice(0, 180)}`))
        return true
    }
    return true
}

function dispose() {
    const current = snapshot().job
    if (current && ["RUNNING", "STOPPING", "SENDING"].includes(current.status)) {
        update(state => ({ ...state, job: { ...state.job, stopRequested: true, status: "STOPPING" } }))
    }
    activeExecutions.clear()
}

module.exports = {
    DEFAULT_DELAY_SECONDS,
    MEDIA_DIR,
    STATE_FILE,
    capturePushContent,
    dedupeTargets,
    dispose,
    executeJob,
    handleContactPush,
    isPushCommand,
    materializeContent,
    parseContactInput,
    parseVcfText,
    progress,
    snapshot,
    store,
    update,
}
