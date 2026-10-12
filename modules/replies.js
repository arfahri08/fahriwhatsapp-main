"use strict"

const fs = require("fs")
const path = require("path")
const autoReplyScope = require("./autoReplyScope")

const DATA_FILE = path.join(__dirname, "..", "data", "replies.json")
const VARIATIONS_FILE = path.join(__dirname, "..", "data", "autoReplyVariations.json")
const MAX_RECENT_PER_BUCKET = 5
const MAX_HISTORY_BUCKETS = 1000
const recentSelections = new Map()

const INTENT_PATTERNS = [
    ["salam", /\b(?:ass?alamu'?alaikum|ass?alamualaikum|salamualaikum)\b/i],
    ["identity", /\b(?:kamu siapa|siapa kamu|ini siapa|nama kamu|nama bot|bot apa)\b/i],
    ["ping", /^(?:p+|ping|test|tes|cek|check)[.!?\s]*$/i],
    ["availability", /\b(?:lagi apa|sedang apa|lagi sibuk|sedang sibuk|sibuk|ada orang|ada admin)\b/i],
    ["thanks", /\b(?:terima kasih|makasih|makasi|thanks|thank you|tengkyu)\b/i],
    ["greeting", /^(?:halo|hai|hello|hi|hey|pagi|siang|sore|malam)(?:\s+(?:kak|min|admin|bot))?[.!?\s]*$/i],
]

function load() {
    try {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
        return Array.isArray(parsed) ? parsed.map(String).map(item => item.trim()).filter(Boolean) : []
    } catch {
        return []
    }
}

function loadVariations() {
    try {
        const parsed = JSON.parse(fs.readFileSync(VARIATIONS_FILE, "utf8"))
        const intents = parsed?.intents && typeof parsed.intents === "object" ? parsed.intents : {}
        return {
            fallback: Array.isArray(parsed?.fallback) ? parsed.fallback.map(String).map(item => item.trim()).filter(Boolean) : [],
            followUp: Array.isArray(parsed?.followUp) ? parsed.followUp.map(String).map(item => item.trim()).filter(Boolean) : [],
            intents: Object.fromEntries(Object.entries(intents).map(([key, values]) => [
                key,
                Array.isArray(values) ? values.map(String).map(item => item.trim()).filter(Boolean) : [],
            ])),
        }
    } catch {
        return { fallback: [], followUp: [], intents: {} }
    }
}

function unique(values = []) {
    return [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))]
}

function getHistoryKey(msg, bucket) {
    const jid = String(msg?.key?.remoteJid || "unknown").trim().toLowerCase()
    return `${jid}:${bucket}`
}

function rememberSelection(key, value, limit) {
    const recent = recentSelections.get(key) || []
    const next = [...recent.filter(item => item !== value), value].slice(-limit)
    recentSelections.delete(key)
    recentSelections.set(key, next)
    while (recentSelections.size > MAX_HISTORY_BUCKETS) {
        recentSelections.delete(recentSelections.keys().next().value)
    }
}

function pickNonRepeating(list, msg, bucket) {
    const choices = unique(list)
    if (!choices.length) return null
    if (choices.length === 1) return choices[0]

    const key = getHistoryKey(msg, bucket)
    const recent = recentSelections.get(key) || []
    const available = choices.filter(item => !recent.includes(item))
    const candidates = available.length ? available : choices
    const selected = candidates[Math.floor(Math.random() * candidates.length)]
    rememberSelection(key, selected, Math.min(MAX_RECENT_PER_BUCKET, choices.length - 1))
    return selected
}

function classifyIntent(text) {
    const clean = String(text || "").trim()
    if (!clean) return ""
    return INTENT_PATTERNS.find(([, pattern]) => pattern.test(clean))?.[0] || ""
}

function getFallbackPool() {
    return unique([...load(), ...loadVariations().fallback])
}

function save(list) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
    const temp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temp, `${JSON.stringify(list, null, 2)}\n`, "utf8")
    fs.renameSync(temp, DATA_FILE)
    return list
}

function addReply(value) {
    const text = String(value || "").trim()
    const list = load()
    if (text) {
        list.push(text)
        save(list)
    }
    return list.length
}

function delReply(index) {
    const list = load()
    const position = Number(index) - 1
    if (!Number.isInteger(position) || position < 0 || position >= list.length) return null
    const [removed] = list.splice(position, 1)
    save(list)
    return removed
}

function getList() {
    return load()
}

function getRandomForMessage(msg) {
    if (!autoReplyScope.shouldProcessAutoReplyMessage(msg)) return null
    return pickNonRepeating(getFallbackPool(), msg, "fallback")
}

function getIntentReplyForMessage(msg, text) {
    if (!autoReplyScope.shouldProcessAutoReplyMessage(msg)) return null
    const intent = classifyIntent(text)
    if (!intent) return null
    return pickNonRepeating(loadVariations().intents[intent] || [], msg, `intent:${intent}`)
}

function getFollowUpForMessage(msg) {
    if (!autoReplyScope.shouldProcessAutoReplyMessage(msg)) return null
    return pickNonRepeating(loadVariations().followUp, msg, "follow-up")
}

function getVariationHealth() {
    const variations = loadVariations()
    return {
        editableReplies: load().length,
        fallbackPool: getFallbackPool().length,
        followUp: variations.followUp.length,
        intents: Object.fromEntries(Object.entries(variations.intents).map(([key, values]) => [key, values.length])),
        antiRepeatWindow: MAX_RECENT_PER_BUCKET,
    }
}

module.exports = {
    DATA_FILE,
    VARIATIONS_FILE,
    addReply,
    classifyIntent,
    delReply,
    getFallbackPool,
    getFollowUpForMessage,
    getIntentReplyForMessage,
    getList,
    getRandomForMessage,
    getVariationHealth,
    load,
    loadVariations,
    save,
    _resetRecentForTest: () => recentSelections.clear(),
}
