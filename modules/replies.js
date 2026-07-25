"use strict"

const fs = require("fs")
const path = require("path")
const autoReplyScope = require("./autoReplyScope")

const DATA_FILE = path.join(__dirname, "..", "data", "replies.json")

function load() {
    try {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
        return Array.isArray(parsed) ? parsed.map(String).map(item => item.trim()).filter(Boolean) : []
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
    const list = load()
    if (!list.length) return null
    return list[Math.floor(Math.random() * list.length)]
}

module.exports = {
    DATA_FILE,
    addReply,
    delReply,
    getList,
    getRandomForMessage,
    load,
    save,
}
