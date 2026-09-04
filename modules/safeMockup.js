"use strict"

const { PNG } = require("pngjs")

const WATERMARK = "SIMULASI / FAKE"
const WIDTH = 900
const HEIGHT = 600
const MAX_NAME = 50
const MAX_TEXT = 500
const GLYPHS = {
    " ": ["00000","00000","00000","00000","00000","00000","00000"],
    "/": ["00001","00010","00100","01000","10000","00000","00000"],
    ".": ["00000","00000","00000","00000","00000","00110","00110"],
    "-": ["00000","00000","00000","11111","00000","00000","00000"],
    "?": ["01110","10001","00001","00010","00100","00000","00100"],
    "A": ["01110","10001","10001","11111","10001","10001","10001"],
    "B": ["11110","10001","10001","11110","10001","10001","11110"],
    "C": ["01111","10000","10000","10000","10000","10000","01111"],
    "D": ["11110","10001","10001","10001","10001","10001","11110"],
    "E": ["11111","10000","10000","11110","10000","10000","11111"],
    "F": ["11111","10000","10000","11110","10000","10000","10000"],
    "G": ["01111","10000","10000","10111","10001","10001","01111"],
    "H": ["10001","10001","10001","11111","10001","10001","10001"],
    "I": ["11111","00100","00100","00100","00100","00100","11111"],
    "J": ["00111","00010","00010","00010","10010","10010","01100"],
    "K": ["10001","10010","10100","11000","10100","10010","10001"],
    "L": ["10000","10000","10000","10000","10000","10000","11111"],
    "M": ["10001","11011","10101","10101","10001","10001","10001"],
    "N": ["10001","11001","10101","10011","10001","10001","10001"],
    "O": ["01110","10001","10001","10001","10001","10001","01110"],
    "P": ["11110","10001","10001","11110","10000","10000","10000"],
    "Q": ["01110","10001","10001","10001","10101","10010","01101"],
    "R": ["11110","10001","10001","11110","10100","10010","10001"],
    "S": ["01111","10000","10000","01110","00001","00001","11110"],
    "T": ["11111","00100","00100","00100","00100","00100","00100"],
    "U": ["10001","10001","10001","10001","10001","10001","01110"],
    "V": ["10001","10001","10001","10001","10001","01010","00100"],
    "W": ["10001","10001","10001","10101","10101","11011","10001"],
    "X": ["10001","10001","01010","00100","01010","10001","10001"],
    "Y": ["10001","10001","01010","00100","00100","00100","00100"],
    "Z": ["11111","00001","00010","00100","01000","10000","11111"],
    "0": ["01110","10011","10101","10101","11001","10001","01110"],
    "1": ["00100","01100","00100","00100","00100","00100","01110"],
    "2": ["01110","10001","00001","00010","00100","01000","11111"],
    "3": ["11110","00001","00001","01110","00001","00001","11110"],
    "4": ["00010","00110","01010","10010","11111","00010","00010"],
    "5": ["11111","10000","10000","11110","00001","00001","11110"],
    "6": ["01110","10000","10000","11110","10001","10001","01110"],
    "7": ["11111","00001","00010","00100","01000","01000","01000"],
    "8": ["01110","10001","10001","01110","10001","10001","01110"],
    "9": ["01110","10001","10001","01111","00001","00001","01110"],
}

function setPixel(png, x, y, color) {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return
    const index = (png.width * y + x) << 2
    png.data[index] = color[0]
    png.data[index + 1] = color[1]
    png.data[index + 2] = color[2]
    png.data[index + 3] = color[3] ?? 255
}

function rectangle(png, x, y, width, height, color) {
    for (let row = Math.max(0, y); row < Math.min(png.height, y + height); row += 1) {
        for (let column = Math.max(0, x); column < Math.min(png.width, x + width); column += 1) setPixel(png, column, row, color)
    }
}

function drawText(png, value, x, y, scale = 3, color = [255, 255, 255, 255], maxWidth = WIDTH - x - 20) {
    const input = String(value || "").toUpperCase()
    let cursorX = x
    let cursorY = y
    for (const character of input) {
        if (character === "\n" || cursorX + 6 * scale > x + maxWidth) {
            cursorX = x
            cursorY += 9 * scale
            if (character === "\n") continue
        }
        const glyph = GLYPHS[character] || GLYPHS["?"]
        glyph.forEach((row, rowIndex) => [...row].forEach((bit, columnIndex) => {
            if (bit !== "1") return
            rectangle(png, cursorX + columnIndex * scale, cursorY + rowIndex * scale, scale, scale, color)
        }))
        cursorX += 6 * scale
    }
}

function cleanInput(value, max, label) {
    const text = String(value || "").replace(/[\0\r]/g, "").trim()
    if (!text) throw new Error(`${label} wajib diisi`)
    if (text.length > max) throw new Error(`${label} maksimal ${max} karakter`)
    return text
}

function renderMockup(type, input = {}) {
    const kind = String(type || "").toLowerCase()
    if (!new Set(["chat", "call", "story"]).has(kind)) throw new Error("Tipe mockup tidak didukung")
    const name = cleanInput(input.name || "KONTAK", MAX_NAME, "Nama")
    const text = kind === "call" ? cleanInput(input.text || "PANGGILAN MASUK", 100, "Status") : cleanInput(input.text, MAX_TEXT, "Teks")
    const png = new PNG({ width: WIDTH, height: HEIGHT, colorType: 6 })
    rectangle(png, 0, 0, WIDTH, HEIGHT, kind === "story" ? [15, 18, 25, 255] : [9, 24, 30, 255])
    rectangle(png, 0, 0, WIDTH, 92, [28, 62, 67, 255])
    rectangle(png, 28, 18, 56, 56, [83, 160, 142, 255])
    drawText(png, name, 105, 30, 4, [245, 248, 248, 255], 740)

    if (kind === "chat") {
        rectangle(png, 205, 175, 640, 230, [0, 92, 75, 255])
        drawText(png, text, 235, 210, 3, [255, 255, 255, 255], 570)
    } else if (kind === "call") {
        rectangle(png, 342, 150, 216, 216, [42, 96, 91, 255])
        drawText(png, "CALL", 380, 230, 6, [255, 255, 255, 255], 180)
        drawText(png, text, 150, 410, 4, [235, 240, 240, 255], 600)
    } else {
        rectangle(png, 120, 130, 660, 330, [34, 49, 63, 255])
        drawText(png, text, 165, 195, 4, [255, 255, 255, 255], 570)
    }

    rectangle(png, 0, HEIGHT - 82, WIDTH, 82, [188, 28, 48, 255])
    drawText(png, WATERMARK, 115, HEIGHT - 62, 6, [255, 255, 255, 255], 700)
    return PNG.sync.write(png)
}

function parseCommand(text) {
    const match = /^\.(mockchat|fakechat|mockcall|fakecall|mockstory|fakestory)(?:\s+([\s\S]*))?$/i.exec(String(text || "").trim())
    if (!match) return null
    const kind = /chat$/i.test(match[1]) ? "chat" : /call$/i.test(match[1]) ? "call" : "story"
    const parts = String(match[2] || "").split("|").map(item => item.trim())
    return { kind, name: parts[0] || "KONTAK", text: parts.slice(1).join("|").trim() || (kind === "call" ? "PANGGILAN MASUK" : "") }
}

async function handleSafeMockup(sock, msg, context = {}) {
    const parsed = parseCommand(context.text)
    if (!parsed) return false
    if (context.isGroup) return true
    try {
        const image = renderMockup(parsed.kind, parsed)
        await sock.sendMessage(context.from, {
            image,
            caption: `${WATERMARK}\nMockup ${parsed.kind} generik; bukan bukti kejadian atau transaksi asli.`,
        }, { quoted: msg })
    } catch (error) {
        await sock.sendMessage(context.from, { text: `${error.message}\nFormat: .mock${parsed.kind} Nama | Teks` }, { quoted: msg })
    }
    return true
}

module.exports = {
    HEIGHT,
    MAX_NAME,
    MAX_TEXT,
    WATERMARK,
    WIDTH,
    handleSafeMockup,
    parseCommand,
    renderMockup,
}
