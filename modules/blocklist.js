// modules/blocklist.js
const fs = require("fs")
const path = require("path")

const FILE = path.join(__dirname, "../data/blocklist.json")

function load() {
    if (!fs.existsSync(FILE)) return []
    try {
        const data = JSON.parse(fs.readFileSync(FILE, "utf8"))
        return Array.isArray(data)
            ? data.map(toJid).filter(Boolean)
            : []
    } catch { return [] }
}

function save(data) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2))
}

function toJid(input) {
    let number = String(input || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "")
    if (!number || number.length < 7) return null
    if (number.startsWith("0")) number = `62${number.slice(1)}`
    if (number.startsWith("8")) number = `62${number}`
    return `${number}@s.whatsapp.net`
}

function block(input) {
    const jid = toJid(input)
    if (!jid) return false
    const list = load()
    if (!list.includes(jid)) {
        list.push(jid)
        save(list)
        return true
    }
    return false
}

function unblock(input) {
    const jid = toJid(input)
    if (!jid) return false
    const before = load()
    const after = before.filter(n => n !== jid)
    save(after)
    return before.length !== after.length
}

function isBlocked(input) {
    const list = load()
    const jid = toJid(input)
    if (!jid) return false
    return list.includes(jid)
}

function getList() {
    return load()
}

module.exports = { block, unblock, isBlocked, getList, toJid }
