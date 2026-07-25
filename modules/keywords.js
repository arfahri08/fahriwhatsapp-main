"use strict"

const fs = require("fs")
const path = require("path")
const autoReplyScope = require("./autoReplyScope")

const DATA_FILE = path.join(__dirname, "..", "data", "keywords.json")

function normalize(value) {
    return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
}

function load() {
    try {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
        return Array.isArray(parsed) ? parsed.filter(item => item && item.keyword && item.reply) : []
    } catch {
        return []
    }
}

function save(list) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
    const temp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temp, `${JSON.stringify(list, null, 2)}\n`, "utf8")
    fs.renameSync(temp, DATA_FILE)
    return list
}

function addKeyword(keyword, reply) {
    const key = String(keyword || "").trim()
    const value = String(reply || "").trim()
    if (!key || !value) return false
    const list = load()
    const normalized = normalize(key)
    const existing = list.find(item => normalize(item.keyword) === normalized)
    if (existing) existing.reply = value
    else list.push({ keyword: key, reply: value })
    save(list)
    return true
}

function delKeyword(keyword) {
    const normalized = normalize(keyword)
    const list = load()
    const next = list.filter(item => normalize(item.keyword) !== normalized)
    if (next.length === list.length) return false
    save(next)
    return true
}

function getList() {
    return load()
}

function matchKeywordForMessage(msg, text) {
    if (!autoReplyScope.shouldProcessAutoReplyMessage(msg)) return null
    const normalizedText = normalize(text)
    if (!normalizedText) return null
    const matches = load()
        .map(item => ({ ...item, normalized: normalize(item.keyword) }))
        .filter(item => item.normalized && (
            normalizedText === item.normalized
            || normalizedText.includes(item.normalized)
        ))
        .sort((a, b) => b.normalized.length - a.normalized.length)
    return matches[0]?.reply || null
}

module.exports = {
    DATA_FILE,
    addKeyword,
    delKeyword,
    getList,
    load,
    matchKeywordForMessage,
    save,
}
