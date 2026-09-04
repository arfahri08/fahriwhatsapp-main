"use strict"

const privateStore = require("./agentPrivateStore")
const reminderContactFlow = require("./reminderContactFlow")
const canonicalIdentity = require("./canonicalIdentity")
const contactNameStore = require("./contactNameStore")

const MAX_RECENT_REPLIES = 12
const SESSION_TTL_MS = 20 * 60 * 1000
const sessions = new Map()

function normalizeText(value) {
    return String(value || "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, " ")
        .replace(/[“”‘’`]/g, "'")
        .replace(/[^\p{L}\p{N}\s?]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
}

function tokens(value) {
    return new Set(normalizeText(value).split(/\s+/).filter(Boolean))
}

function similarity(a, b) {
    const A = tokens(a)
    const B = tokens(b)
    if (!A.size || !B.size) return 0
    let overlap = 0
    for (const item of A) if (B.has(item)) overlap += 1
    const union = new Set([...A, ...B]).size
    return union ? overlap / union : 0
}

function sessionKey(jid) {
    return privateStore.canonicalKey(jid)
}

function getSession(jid) {
    const key = sessionKey(jid)
    const session = sessions.get(key)
    if (!session) return null
    if (Date.now() - Number(session.updatedAt || 0) > SESSION_TTL_MS) {
        sessions.delete(key)
        return null
    }
    return session
}

function setSession(jid, session) {
    sessions.set(sessionKey(jid), { ...session, updatedAt: Date.now() })
}

function clearSession(jid) {
    sessions.delete(sessionKey(jid))
}

function formatContactTargets(targets) {
    return targets.map((target, index) => `${index + 1}. ${target.number}${target.label && target.label !== target.number ? ` — ${target.label}` : ""}`).join("\n")
}

function resolveBestPrivateJid(context = {}) {
    const candidates = [
        context.senderJid,
        context.from,
        context.replyJid,
        context.remoteJidAlt,
        context.participant,
    ]
    for (const value of candidates) {
        const direct = String(value || "").trim()
        if (/@s\.whatsapp\.net$/.test(direct)) return direct
        try {
            const resolved = canonicalIdentity?.resolveBestJid
                ? canonicalIdentity.resolveBestJid(direct)
                : ""
            if (resolved) return resolved
        } catch {}
    }
    return candidates.find(Boolean) || ""
}

function isPrivateStartCommand(text) {
    return /^\.(?:agent|privateagent|agenprivate)$/i.test(String(text || "").trim())
}

function isPrivateOffCommand(text) {
    return /^\.(?:agent|privateagent|agenprivate)\s+off$/i.test(String(text || "").trim())
}

function isPrivateStatusCommand(text) {
    return /^\.(?:agent|privateagent|agenprivate)\s+status$/i.test(String(text || "").trim())
}

function isActivePrivateAgentContact(context = {}) {
    const jid = resolveBestPrivateJid(context)
    return Boolean(jid && privateStore.isEnabled(jid))
}

function isShortAcknowledgement(text) {
    return /^(?:ok+|oke+|okay|sip+|sipp+|siap|noted|thanks|makasih)[.!\s]*$/i.test(String(text || "").trim())
}

function mentionReplyName(jid, fallback = "Kak") {
    try {
        if (typeof contactNameStore.resolveSavedContactName === "function") {
            return contactNameStore.resolveSavedContactName(jid) || fallback
        }
    } catch {}
    return fallback
}

function classifySimple(text) {
    const clean = normalizeText(text)
    if (!clean) return "empty"
    if (/^(pagi|selamat pagi|assalamualaikum)/.test(clean)) return "greeting"
    if (clean.endsWith("?") || /\b(kenapo|dimano|dimana|berapa|kapan|apo|apa|gimano|bagaimana|mau|biso|bisa)\b/.test(clean)) return "question"
    if (/\b(makan|lapar|makanan|minum|ngopi|pempek|kapal selam|yoshinoya)\b/.test(clean)) return "food"
    if (/\b(balek|pulang|jemput|jalan|mall|gubeng|surabaya|gresik)\b/.test(clean)) return "movement"
    if (/\b(doa|berkat|rezeki|rizki|gereja|amin)\b/.test(clean)) return "blessing"
    if (/\b(hati hati|jangan lupa|awas|ingat|ketinggalan)\b/.test(clean)) return "care"
    return "general"
}

function fallbackResponse(text, context, contactName) {
    const kind = classifySimple(text)
    const recent = (context || []).filter(item => item.role === "user").slice(-4).map(item => item.text).join(" ")
    const sameTopic = recent && similarity(recent, text) > 0.08

    const generic = {
        greeting: [
            "Iyo ma, pagi. Lagi ngurus ini dulu.",
            "Pagi ma, iya aku baca. Lagi santai ini.",
            "Iyo ma, pagi. Ada apo?"
        ],
        question: [
            "Iya ma, aku cek dulu ya.",
            "Bentar ma, aku lihat dulu biar dak salah jawab.",
            "Iyo ma, ngerti. Aku jawab pelan-pelan dulu."
        ],
        food: [
            "Iyo ma, nanti aku kabarin ya.",
            "Bisa ma, aku lihat dulu yang paling gampang.",
            "Iya ma, nanti sekalian aku cari."
        ],
        movement: [
            "Iyo ma, nanti aku kabarin pas udah jelas.",
            "Masih jalan ini ma, nanti aku kabari lagi.",
            "Iya ma, aku lihat dulu kondisi di sini."
        ],
        blessing: [
            "Amin ma, makasih banyak doanya.",
            "Amin ya ma 🙏 makasih doanya.",
            "Amin ma, semoga semuanya lancar."
        ],
        care: [
            "Iyo ma, siap. Makasih udah ngingetin.",
            "Iya ma, aku ingat kok.",
            "Siap ma, nanti aku cek lagi."
        ],
        general: [
            "Iyo ma.",
            "Iya ma, aku baca.",
            "Hehe iya ma.",
            "Oke ma, nanti aku kabarin.",
            "Iya ma, ngerti."
        ],
    }

    if (sameTopic && kind === "question") return "Iyo ma, aku masih ngikutin yang tadi. Bentar aku jawab ya."
    const rows = generic[kind] || generic.general
    return rows[Math.floor(Math.random() * rows.length)]
}

function buildResponse(text, jid) {
    const contact = privateStore.getContact(jid)
    const context = privateStore.getContext(jid)
    return fallbackResponse(text, context, contact?.name || mentionReplyName(jid))
}

async function handlePrivateAgent(sock, msg, context = {}) {
    if (context.isGroup) return false

    const from = String(context.from || msg?.key?.remoteJid || "")
    const text = String(context.text || "").trim()
    const isOwner = Boolean(context.isOwner || context.canControlOwner)
    const targetJid = resolveBestPrivateJid(context)

    if (isPrivateStartCommand(text)) {
        if (!isOwner) return false
        await sock.sendMessage(from, {
            text: [
                "🤖 *PRIVATE AGENT*",
                "",
                "Kirim *contact card* orang yang ingin dibalas menggunakan agent.",
                "Jawaban + konteksnya akan disimpan khusus untuk kontak tersebut.",
                "",
                "Ketik *batal* untuk membatalkan.",
            ].join("\n")
        }, { quoted: msg })
        setSession(from, { stage: "contact" })
        return true
    }

    if (isPrivateOffCommand(text)) {
        if (!isOwner) return false
        const enabled = privateStore.listContacts().filter(item => item.enabled)
        if (!enabled.length) {
            await sock.sendMessage(from, { text: "ℹ️ Belum ada kontak Private Agent yang aktif." }, { quoted: msg })
            return true
        }
        await sock.sendMessage(from, {
            text: [
                "🤖 *MATIKAN PRIVATE AGENT*",
                "",
                "Kirim contact card kontak yang ingin dimatikan.",
                "",
                enabled.map((item, index) => `${index + 1}. ${item.name || item.number || item.jid}`).join("\n"),
                "",
                "Ketik *batal* untuk membatalkan.",
            ].join("\n")
        }, { quoted: msg })
        setSession(from, { stage: "disableContact" })
        return true
    }

    if (isPrivateStatusCommand(text)) {
        if (!isOwner) return false
        const rows = privateStore.listContacts().filter(item => item.enabled)
        const body = rows.length
            ? rows.map((item, i) => `${i + 1}. ${item.name || item.number || item.jid}`).join("\n")
            : "Belum ada kontak yang diaktifkan."
        await sock.sendMessage(from, { text: `🤖 *PRIVATE AGENT AKTIF*\n\n${body}` }, { quoted: msg })
        return true
    }

    const session = getSession(from)
    if (session && isOwner) {
        if (/^(batal|cancel|\.batal|\.cancel)$/i.test(text)) {
            clearSession(from)
            await sock.sendMessage(from, { text: "❌ Private Agent dibatalkan." }, { quoted: msg })
            return true
        }

        if (session.stage === "contact" || session.stage === "disableContact") {
            const targets = reminderContactFlow.extractContactTargets(msg?.message)
            if (!targets.length) {
                await sock.sendMessage(from, {
                    text: session.stage === "disableContact"
                        ? "⚠️ Kontak belum terbaca. Kirim contact card kontak yang ingin dimatikan."
                        : "⚠️ Kontak belum terbaca. Kirim contact card orang yang ingin diaktifkan."
                }, { quoted: msg })
                return true
            }
            const target = targets[0]
            const jid = `${target.number}@s.whatsapp.net`
            const name = target.label || target.number

            if (session.stage === "disableContact") {
                privateStore.disableContact(jid)
                clearSession(from)
                await sock.sendMessage(from, {
                    text: `✅ Private Agent dimatikan untuk ${name}.`,
                }, { quoted: msg })
                return true
            }

            const profile = /mama|novie/i.test(name) ? "mama" : ""
            privateStore.enableContact(jid, name, profile)
            clearSession(from)
            await sock.sendMessage(from, {
                text: [
                    "✅ *PRIVATE AGENT AKTIF*",
                    "",
                    `Kontak: ${name}`,
                    `Nomor: ${target.number}`,
                    `Mode: ${profile === "mama" ? "Mama context" : "Private context learning"}`,
                    "",
                    "Mulai sekarang pesan dari kontak ini akan diproses agent.",
                    "Ketik *.agent off* lalu kirim contact card untuk mematikannya.",
                ].join("\n")
            }, { quoted: msg })
            return true
        }
    }

    // Only active target contacts reach this section.
    if (!targetJid || !privateStore.isEnabled(targetJid)) return false

    // Never hijack commands, media links, or downloader URLs.
    if (!text || text.startsWith(".")) return false
    if (/https?:\/\/|www\./i.test(text)) return false
    if (context.isBotGeneratedMessage && context.isBotGeneratedMessage(msg)) return false

    if (isShortAcknowledgement(text)) {
        await sock.sendMessage(from, { react: { text: "👍", key: msg.key } })
        privateStore.addContextMessage(targetJid, "user", text, "[reaction-only]")
        return true
    }

    const reply = buildResponse(text, targetJid)
    if (!reply) return false

    privateStore.addContextMessage(targetJid, "user", text, reply)
    await sock.sendMessage(from, { text: reply }, { quoted: msg })
    privateStore.addContextMessage(targetJid, "bot", reply)
    return true
}

function disposePrivateAgent() {
    sessions.clear()
}

module.exports = {
    disposePrivateAgent,
    handlePrivateAgent,
    isActivePrivateAgentContact,
    normalizeText,
    similarity,
}
