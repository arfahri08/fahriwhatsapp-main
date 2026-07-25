// modules/stats.js
// Reset otomatis setiap hari baru

const fs = require("fs")
const path = require("path")

const FILE = path.join(__dirname, "../data/stats.json")

function getToday() {
    return new Date().toISOString().split("T")[0]
}

function load() {
    const empty = { messages: 0, date: getToday() }
    if (!fs.existsSync(FILE)) return empty
    try {
        const data = JSON.parse(fs.readFileSync(FILE, "utf8"))
        // Reset kalau hari sudah berganti
        if (data.date !== getToday()) return empty
        return data
    } catch { return empty }
}

function save(data) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2))
}

function addMessage() {
    const data = load()
    data.messages++
    save(data)
}

function getStats() {
    return load()
}

module.exports = { addMessage, getStats }
