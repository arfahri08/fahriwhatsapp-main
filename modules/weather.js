// modules/weather.js
// Pakai wttr.in — gratis, tidak perlu API key
const https = require("https")

async function fetchWeather(city) {
    return new Promise((resolve, reject) => {
        const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`
        https.get(url, (res) => {
            let data = ""
            res.on("data", chunk => data += chunk)
            res.on("end", () => {
                try { resolve(JSON.parse(data)) }
                catch (e) { reject(new Error("Kota tidak ditemukan")) }
            })
        }).on("error", reject)
    })
}

// Emoji berdasarkan kode cuaca wttr.in
function weatherEmoji(code) {
    const c = parseInt(code)
    if (c === 113) return "☀️"
    if (c === 116) return "⛅"
    if ([119, 122].includes(c)) return "☁️"
    if ([143, 248, 260].includes(c)) return "🌫️"
    if ([176, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 317, 320, 353, 356, 359, 362, 365, 374, 377].includes(c)) return "🌧️"
    if ([179, 182, 185, 227, 230, 323, 326, 329, 332, 335, 338, 350, 368, 371, 395].includes(c)) return "🌨️"
    if ([200, 386, 389, 392].includes(c)) return "⛈️"
    return "🌤️"
}

async function getWeatherText(city) {
    const data = await fetchWeather(city)
    const current = data.current_condition[0]
    const area = data.nearest_area[0]

    const namaKota = area.areaName[0].value
    const negara = area.country[0].value
    const suhu = current.temp_C
    const suhuRasa = current.FeelsLikeC
    const desc = current.lang_id?.[0]?.value || current.weatherDesc[0].value
    const emoji = weatherEmoji(current.weatherCode)
    const kelembapan = current.humidity
    const angin = current.windspeedKmph
    const visibilitas = current.visibility

    return (
        `${emoji} *Cuaca di ${namaKota}, ${negara}*\n\n` +
        `🌡️ Suhu: ${suhu}°C (terasa ${suhuRasa}°C)\n` +
        `🌥️ Kondisi: ${desc}\n` +
        `💧 Kelembapan: ${kelembapan}%\n` +
        `💨 Angin: ${angin} km/h\n` +
        `👁️ Visibilitas: ${visibilitas} km`
    )
}

module.exports = { getWeatherText }
