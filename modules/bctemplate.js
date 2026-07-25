// modules/bctemplate.js
const fs = require("fs")
const path = require("path")

const FILE = path.join(__dirname, "../data/bctemplates.json")

function load() {
    if (!fs.existsSync(FILE)) return {}
    try { return JSON.parse(fs.readFileSync(FILE, "utf8")) } catch { return {} }
}

function save(data) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2))
}

function addTemplate(name, text) {
    const data = load()
    data[name.toLowerCase()] = text
    save(data)
}

function delTemplate(name) {
    const data = load()
    if (!data[name.toLowerCase()]) return false
    delete data[name.toLowerCase()]
    save(data)
    return true
}

function getTemplate(name) {
    return load()[name.toLowerCase()] || null
}

function getList() {
    return load()
}

module.exports = { addTemplate, delTemplate, getTemplate, getList }
