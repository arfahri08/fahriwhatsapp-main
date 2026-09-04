"use strict"

const store = require("./exclusiveAgentStore")

const LEXICON_FILE = require("path").join(__dirname, "..", "data", "exclusiveAgentLexicon.json")
const COMMAND_RE = /^\.fitur(?:\s+(on|off|status|rame|santai))?\s*$/i
const GROUP_MEMORY_TTL_MS = 20 * 60 * 1000
const GROUP_MEMORY_MAX = 8
const GROUP_COOLDOWN_MS = 10_000
const USER_COOLDOWN_MS = 25_000

let lexiconCache = null
const groupMemory = new Map()
const groupLastReply = new Map()
const userLastReply = new Map()
const groupRecentReplies = new Map()

function loadLexicon() {
    if (lexiconCache) return lexiconCache
    lexiconCache = JSON.parse(fs.readFileSync(LEXICON_FILE, "utf8"))
    return lexiconCache
}

function similarityScore(a, b) {
    const A = words(a)
    const B = words(b)
    if (!A.size || !B.size) return 0
    let overlap = 0
    for (const token of A) if (B.has(token)) overlap += 1
    return overlap / new Set([...A, ...B]).size
}

function replyHasUngroundedMemberName(reply, sourceText) {
    const normalizedSource = ` ${normalizeText(sourceText)} `
    for (const member of loadLexicon().groupMembers || []) {
        const aliases = [member.name, ...(member.aliases || [])]
            .map(normalizeText)
            .filter(alias => alias.length >= 4)
        const replyText = normalizeText(reply)
        if (aliases.some(alias => (` ${replyText} `).includes(` ${alias} `))
            && !aliases.some(alias => normalizedSource.includes(` ${alias} `))) return true
    }
    return false
}

function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[^\p{L}\p{N}+]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
}

function isSocialMediaUrl(value) {
    const urls = String(value || "").match(/https?:\/\/[^\s<>'"]+/gi) || []
    return urls.some(url => {
        try {
            const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "")
            return ["instagram.com", "instagr.am", "facebook.com", "fb.watch", "fb.com", "tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "threads.com", "threads.net", "youtube.com", "youtu.be"].some(domain => host === domain || host.endsWith(`.${domain}`))
        } catch {
            return false
        }
    })
}

function words(value) {
    return new Set(normalizeText(value).split(" ").filter(Boolean))
}

function matchesKeyword(normalized, tokenSet, keyword) {
    const clean = normalizeText(keyword)
    if (!clean) return false
    if (clean.includes(" ") || clean.includes("+") || clean.length <= 2) {
        return (` ${normalized} `).includes(` ${clean} `) || normalized.includes(clean)
    }
    return tokenSet.has(clean)
}

function scoreIntents(text) {
    const lexicon = loadLexicon()
    const normalized = normalizeText(text)
    const tokenSet = words(normalized)
    const scores = []
    for (const [intent, config] of Object.entries(lexicon.intents || {})) {
        let score = 0
        for (const keyword of config.keywords || []) {
            if (matchesKeyword(normalized, tokenSet, keyword)) score += keyword.length > 6 ? 3 : 2
        }
        if (score > 0) scores.push({ intent, score })
    }
    scores.sort((a, b) => b.score - a.score || a.intent.localeCompare(b.intent))
    return scores
}

function rememberGroupMessage(groupJid, senderJid, text, now = Date.now()) {
    const current = groupMemory.has(groupJid)
        ? (groupMemory.get(groupJid) || [])
        : store.getGroupMessages(groupJid).slice(-GROUP_MEMORY_MAX)
    current.push({ senderJid, text: String(text || "").slice(0, 500), at: now })
    groupMemory.set(groupJid, current.slice(-GROUP_MEMORY_MAX))
    store.appendGroupMessage(groupJid, { senderJid, text, at: now })
    return current.slice(-GROUP_MEMORY_MAX)
}

function recentTopicBoost(groupJid, intent) {
    const current = groupMemory.get(groupJid) || []
    let count = 0
    for (const item of current) {
        if (scoreIntents(item.text).some(result => result.intent === intent)) count += 1
    }
    return Math.min(4, count)
}

function pickResponse(intent, text, random = Math.random) {
    const responses = loadLexicon().intents?.[intent]?.responses || []
    if (!responses.length) return ""
    let hash = 2166136261
    for (const char of String(text || "")) {
        hash ^= char.codePointAt(0)
        hash = Math.imul(hash, 16777619)
    }
    const recent = groupRecentReplies.get(intent) || []
    const candidates = responses.length > recent.length
        ? responses.map((reply, index) => ({ reply, index })).filter(item => !recent.includes(item.reply))
        : responses.map((reply, index) => ({ reply, index }))
    const jitter = Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * candidates.length)
    const selected = candidates[Math.abs(hash + jitter) % candidates.length]?.reply || responses[0]
    groupRecentReplies.set(intent, [...recent, selected].slice(-Math.min(3, responses.length)))
    return selected
}

function isDirectBotCall(text) {
    const normalized = normalizeText(text)
    const aliases = loadLexicon().botAliases || []
    return aliases.some(alias => (` ${normalized} `).includes(` ${normalizeText(alias)} `))
}

function isAntonCall(text) {
    const normalized = normalizeText(text)
    const aliases = loadLexicon().antonAliases || []
    return aliases.some(alias => (` ${normalized} `).includes(` ${normalizeText(alias)} `))
}

// Roster anggota grup (di luar Anton/bot, yang punya jalur prioritas sendiri).
// Dipakai supaya balasan bisa nyebut nama yang relevan, bukan cuma template generik.
function findMentionedMember(text) {
    const normalized = normalizeText(text)
    const padded = ` ${normalized} `
    const members = loadLexicon().groupMembers || []
    for (const member of members) {
        for (const alias of member.aliases || []) {
            const clean = normalizeText(alias)
            if (clean && padded.includes(` ${clean} `)) return member.name
        }
    }
    return ""
}

// Glosarium istilah/slang yang pernah benar-benar ditanyakan di grup (mis. "nian").
// Kalau kata yang ditanyakan cocok, jawab pakai penjelasan asli, bukan template acak,
// supaya kerasa beneran "ngerti konteks" alih-alih cuma nebak-nebak.
function findGlossaryTerm(text) {
    const glossary = loadLexicon().glossary || {}
    const tokenSet = words(text)
    for (const term of Object.keys(glossary)) {
        if (tokenSet.has(normalizeText(term))) return term
    }
    return ""
}

function applyPlaceholders(reply, context = {}) {
    if (!reply || !reply.includes("{{name}}")) return reply
    const name = context.mentionedName || "dia"
    return reply.split("{{name}}").join(name)
}

function cooldownAllowed(groupJid, senderJid, now, direct) {
    if (direct) return true
    const groupAt = Number(groupLastReply.get(groupJid) || 0)
    const userAt = Number(userLastReply.get(`${groupJid}:${senderJid}`) || 0)
    return now - groupAt >= GROUP_COOLDOWN_MS && now - userAt >= USER_COOLDOWN_MS
}

function markReply(groupJid, senderJid, now) {
    groupLastReply.set(groupJid, now)
    userLastReply.set(`${groupJid}:${senderJid}`, now)
}

function formatStatus(groupJid, config) {
    return [
        "🤖 *FITUR EKSKLUSIF GRUP*",
        "",
        `Grup: ${groupJid}`,
        `Status: ${config?.enabled ? "ON" : "OFF"}`,
        `Mode: ${config?.mode || "santai"}`,
        "",
        "Aktif hanya di grup yang owner nyalakan dengan *.fitur*.",
        "Fitur default grup tetap terpisah dan tidak diubah.",
    ].join("\n")
}

async function handleExclusiveToggleCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    const match = text.match(COMMAND_RE)
    if (!match) return false
    const groupJid = String(context.from || msg?.key?.remoteJid || "")
    if (!context.isGroup || !/@g\.us$/.test(groupJid)) return false

    // Command ini owner-only. Untuk non-owner sengaja silent supaya fitur eksklusif tidak
    // dapat dipancing member lain.
    if (!(context.canControlOwner || context.isOwner)) return true

    const action = String(match[1] || "on").toLowerCase()
    const actor = context.senderJid || context.sender || groupJid
    let config
    if (action === "off") config = store.setEnabled(groupJid, false, actor)
    else if (action === "rame" || action === "santai") {
        config = store.setEnabled(groupJid, true, actor)
        config = store.setMode(groupJid, action, actor)
    } else if (action === "status") config = store.getGroup(groupJid) || { enabled: false, mode: "santai" }
    else config = store.setEnabled(groupJid, true, actor)

    await sock.sendMessage(groupJid, { text: formatStatus(groupJid, config) }, { quoted: msg })
    return true
}

async function handleExclusiveGroupMessage(sock, msg, context = {}) {
    const groupJid = String(context.from || msg?.key?.remoteJid || "")
    if (!context.isGroup || !/@g\.us$/.test(groupJid)) return false
    if (!store.isEnabled(groupJid)) return false
    const text = String(context.text || "").trim()
    if (!text || text.startsWith(".")) return false
    if (typeof context.isBotGeneratedMessage === "function" && context.isBotGeneratedMessage(msg)) return false

    const senderJid = String(context.senderJid || context.sender || msg?.key?.participant || "")
    const now = Number(context.now || Date.now())
    rememberGroupMessage(groupJid, senderJid, text, now)

    // Pesan owner tetap menjadi konteks percakapan, tetapi bot tidak membalas chat
    // yang dikirim owner sendiri di dalam grup.
    if (context.isOwner || context.canControlOwner || msg?.key?.fromMe) return false
    if (isSocialMediaUrl(text)) return false

    const scored = scoreIntents(text)
    const directBot = isDirectBotCall(text)
    const antonCall = isAntonCall(text)
    const rough = scored.find(item => item.intent === "rough_language")

    // Owner mengikuti policy anti-toxic existing: tidak diperingati karena kata kasar.
    if (rough && !(context.canControlOwner || context.isOwner)) {
        if (!cooldownAllowed(groupJid, senderJid, now, true)) return false
        const reply = pickResponse("rough_language", text, context.random || Math.random)
        if (!reply) return false
        await sock.sendMessage(groupJid, { text: reply }, { quoted: msg })
        markReply(groupJid, senderJid, now)
        return true
    }

    let selected = scored[0] || null
    if (directBot) selected = { intent: "bot_call", score: 100 }
    else if (antonCall) selected = { intent: "anton_call", score: 90 }
    if (!selected) return false

    // Pertanyaan arti kata (mis. "nian artinya apa ton") diperlakukan kayak pertanyaan
    // langsung: kalau istilahnya ada di glosarium, bot wajib jawab pakai jawaban asli
    // (bukan gambling probabilitas kayak banter biasa), bahkan kalau di kalimat yang sama
    // Anton/bot ikut disebut. Konteks "nanya sesuatu" lebih penting daripada sekadar disapa.
    const glossaryTerm = findGlossaryTerm(text)

    const direct = directBot || antonCall || Boolean(glossaryTerm)
    if (!cooldownAllowed(groupJid, senderJid, now, direct)) return false

    const config = store.getGroup(groupJid) || {}
    const baseChance = Number(config.replyChance ?? (config.mode === "rame" ? 0.72 : 0.45))
    const topicBoost = recentTopicBoost(groupJid, selected.intent) * 0.04
    const probability = direct ? 1 : Math.min(0.9, baseChance + topicBoost + Math.min(0.18, selected.score * 0.02))
    const rng = context.random || Math.random
    if (!direct && rng() > probability) return false

    const lexicon = loadLexicon()
    const recent = store.getGroupMessages(groupJid).slice(-20)
    let reply = glossaryTerm
        ? lexicon.glossary[glossaryTerm]
        : pickResponse(selected.intent, text, rng)
    if (!reply) return false
    reply = applyPlaceholders(reply, { mentionedName: findMentionedMember(text) })
    await sock.sendMessage(groupJid, { text: reply }, { quoted: msg })
    markReply(groupJid, senderJid, now)
    return true
}

function disposeExclusiveAgent() {
    groupMemory.clear()
    groupLastReply.clear()
    userLastReply.clear()
    groupRecentReplies.clear()
}

module.exports = {
    COMMAND_RE,
    LEXICON_FILE,
    applyPlaceholders,
    disposeExclusiveAgent,
    findGlossaryTerm,
    findMentionedMember,
    handleExclusiveGroupMessage,
    handleExclusiveToggleCommand,
    isAntonCall,
    isDirectBotCall,
    loadLexicon,
    normalizeText,
    isSocialMediaUrl,
    pickResponse,
    rememberGroupMessage,
    scoreIntents,
}
