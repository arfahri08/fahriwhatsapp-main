// modules/settings.js

const fs = require("fs")
const path = require("path")

const FILE = path.join(__dirname, "../data/settings.json")

const DEFAULT = {
    aiEnabled: true,
    aiPrompt: "Kamu manusia Indonesia santai, jawab pendek dan natural seperti chat biasa"
}

function load() {
    if (!fs.existsSync(FILE)) return { ...DEFAULT }
    try {
        return { ...DEFAULT, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }
    } catch {
        return { ...DEFAULT }
    }
}

function save(data) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2))
}

function get(key) {
    return load()[key]
}

function set(key, value) {
    const data = load()
    data[key] = value
    save(data)
}

function getAll() {
    return load()
}

module.exports = { get, set, getAll }
