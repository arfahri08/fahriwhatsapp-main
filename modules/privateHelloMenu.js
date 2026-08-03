"use strict"

const groupWelcome = require("./groupWelcome")
const help = require("./help")

const WEBSITE_URL = "https://antoniusfahri.my.id"
const HELLO_BUILD = "PRIVATE-HELLO-MENU-2026-08-03.1"

function normalizeText(value) {
    return String(value || "").trim()
}

function isHelloTrigger(text) {
    return /^halo[.!?,]*$/i.test(normalizeText(text))
}

function firstName(value) {
    const clean = normalizeText(value).replace(/^[@+]+/, "")
    if (!clean) return "Kak"
    return clean.split(/\s+/)[0].slice(0, 40) || "Kak"
}

function buildIntroText(name = "Kak") {
    return [
        `👋 Halo, *${firstName(name)}*!`,
        "",
        "Aku adalah *USERBOT FAHRI*, bot WhatsApp pribadi yang membantu otomasi chat, media tools, downloader, reminder, dan fitur keamanan.",
        "",
        `🌐 *${WEBSITE_URL}*`,
        "_(Tentang penulis script bot)_",
        "",
        "Tekan tombol di bawah untuk membuka menu bantuan.",
    ].join("\n")
}

function buildPrivateMenuSections() {
    return [
        {
            title: "BANTUAN UTAMA",
            rows: [
                { header: "HELP", title: "Semua Command", description: "Buka helper text lengkap bot", id: ".pmenu all" },
                { header: "ABOUT", title: "Tentang Bot", description: "Website dan informasi penulis script", id: ".pmenu about" },
            ],
        },
        {
            title: "DOWNLOAD & MEDIA",
            rows: [
                { header: "DOWNLOAD", title: "Downloader", description: "TikTok, Instagram, YouTube, Spotify, dan lainnya", id: ".pmenu downloader" },
                { header: "MEDIA", title: "Media Tools", description: "Stiker, URL, PDF, voice note, dan QR", id: ".pmenu media" },
            ],
        },
        {
            title: "STATUS & UTILITAS",
            rows: [
                { header: "STATUS", title: "Status WhatsApp", description: "Panduan status downloader", id: ".pmenu status" },
                { header: "UTILITY", title: "Utility", description: "Kalkulator dan command praktis", id: ".pmenu utility" },
            ],
        },
    ]
}

function buildPrivateFallbackText(name = "Kak") {
    return [
        buildIntroText(name),
        "",
        "✦ *MENU PRIVATE • USERBOT FAHRI* ✦",
        "• `.help` — semua command",
        "• `.spdl <link>` — Spotify downloader",
        "• `.dlold <url>` — downloader legacy",
        "• `.s` — buat stiker dari media",
        "• `.tourl` — media menjadi URL",
        "• `.pdf` — gambar menjadi PDF",
        "• `.calc <ekspresi>` — kalkulator",
    ].join("\n")
}

function buildCategoryText(category) {
    const value = normalizeText(category).toLowerCase()
    if (value === "all") return help.generateHelpMenu()
    if (value === "about") {
        return [
            "👨‍💻 *TENTANG BOT & PENULIS SCRIPT*",
            "",
            "USERBOT FAHRI dikembangkan sebagai proyek otomasi WhatsApp pribadi untuk membantu pengelolaan chat, media, reminder, downloader, dan keamanan.",
            "",
            `🌐 ${WEBSITE_URL}`,
            "_(Tentang penulis script bot)_",
        ].join("\n")
    }
    if (value === "downloader") {
        return [
            "📥 *DOWNLOADER*",
            "",
            "Kirim link TikTok, Instagram, Threads, YouTube, Facebook, Pinterest, SoundCloud, atau Spotify di private chat.",
            "",
            "`.spdl <link Spotify>`",
            "`.spotify <link Spotify>`",
            "`.dlold <url>`",
        ].join("\n")
    }
    if (value === "media") {
        return [
            "🧰 *MEDIA TOOLS*",
            "",
            "`.s` / `.stiker` — media menjadi stiker",
            "`.tourl` — media menjadi URL",
            "`.pdf` — gambar menjadi PDF",
            "`.vn` / `.ptt` — audio menjadi voice note",
            "`.makeqr` — membuat QR art",
            "`.tgstiker <link pack Telegram>`",
        ].join("\n")
    }
    if (value === "status") {
        return [
            "👁️ *STATUS WHATSAPP*",
            "",
            "`.status` / `.statusdl`",
            "`.statusget`",
            "`.statusid`",
            "",
            "Status broadcast tidak dicatat sebagai jejak pesan diedit.",
        ].join("\n")
    }
    if (value === "utility") {
        return [
            "🧮 *UTILITY*",
            "",
            "`.calc <ekspresi>`",
            "`.hitung <ekspresi>`",
            "`.ping` — cek latency dan uptime",
            "`.help` — buka semua command",
        ].join("\n")
    }
    return "Kategori menu tidak ditemukan. Ketik `.help` untuk melihat seluruh command."
}

function parsePrivateMenuCommand(text) {
    const match = /^\.pmenu(?:\s+(all|about|downloader|media|status|utility))?$/i.exec(normalizeText(text))
    return match ? (match[1] || "all").toLowerCase() : ""
}

async function handlePrivateMenuCommand(sock, msg, context = {}) {
    if (context.isGroup || msg?.key?.fromMe) return false
    const category = parsePrivateMenuCommand(context.text)
    if (!category) return false
    const from = context.from || msg?.key?.remoteJid
    if (!from) return false
    await sock.sendMessage(from, { text: buildCategoryText(category) }, { quoted: msg })
    return true
}

async function handlePrivateHello(sock, msg, context = {}) {
    if (context.isGroup || msg?.key?.fromMe || !isHelloTrigger(context.text)) return false
    const from = context.from || msg?.key?.remoteJid
    if (!from) return false
    const displayName = context.displayName || msg?.pushName || "Kak"
    const result = await groupWelcome.sendInteractiveMenu(sock, from, {
        title: "✦ MENU PRIVATE • USERBOT FAHRI ✦",
        bodyText: buildIntroText(displayName),
        footer: "Pilih kategori bantuan • USERBOT FAHRI",
        sections: buildPrivateMenuSections(),
        quoted: msg,
        fallbackText: buildPrivateFallbackText(displayName),
        baileys: context.baileys,
    })
    console.log(`[PRIVATE HELLO MENU] ${HELLO_BUILD} sent=${Boolean(result?.sent)} mode=${result?.mode || "unknown"} jid=${from}`)
    return Boolean(result?.sent)
}

module.exports = {
    WEBSITE_URL,
    HELLO_BUILD,
    isHelloTrigger,
    buildIntroText,
    buildPrivateMenuSections,
    buildPrivateFallbackText,
    buildCategoryText,
    parsePrivateMenuCommand,
    handlePrivateMenuCommand,
    handlePrivateHello,
}
