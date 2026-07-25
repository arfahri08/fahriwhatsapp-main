// modules/scheduler.js
// Cara kerja: setiap jadwal punya waktu mulai (HH:MM)
// Bot otomatis pakai pesan jadwal yang paling dekat sebelum jam sekarang
// Contoh: jadwal 22:00 = mulai jam 10 malam sampai jadwal berikutnya

const fs = require("fs")
const path = require("path")

const FILE = path.join(__dirname, "../data/scheduler.json")

function load() {
    if (!fs.existsSync(FILE)) return []
    try { return JSON.parse(fs.readFileSync(FILE, "utf8")) } catch { return [] }
}

function save(data) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2))
}

function addSchedule(time, message) {
    // Validasi format HH:MM
    if (!/^\d{1,2}:\d{2}$/.test(time)) return false
    const list = load()
    const idx = list.findIndex(s => s.time === time)
    if (idx >= 0) list[idx].message = message
    else list.push({ time, message })
    save(list)
    return true
}

function delSchedule(time) {
    const before = load()
    const after = before.filter(s => s.time !== time)
    save(after)
    return before.length !== after.length
}

function getList() {
    return load()
}

function timeToMinutes(time) {
    const [h, m] = time.split(":").map(Number)
    return h * 60 + (m || 0)
}

// Ambil pesan jadwal yang aktif sekarang
function getActiveMessage() {
    const list = load()
    if (list.length === 0) return null

    const now = new Date()
    const currentMinutes = now.getHours() * 60 + now.getMinutes()

    const sorted = list
        .map(s => ({ ...s, minutes: timeToMinutes(s.time) }))
        .sort((a, b) => a.minutes - b.minutes)

    // Cari jadwal terakhir yang sudah lewat
    let active = null
    for (const s of sorted) {
        if (s.minutes <= currentMinutes) active = s
    }

    // Kalau belum ada yang lewat (misal jam 00:30, jadwal terkecil 07:00),
    // pakai jadwal terakhir di hari sebelumnya
    if (!active) active = sorted[sorted.length - 1]

    return active ? active.message : null
}

module.exports = { addSchedule, delSchedule, getList, getActiveMessage }
