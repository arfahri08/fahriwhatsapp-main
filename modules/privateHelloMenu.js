"use strict"

const groupWelcome = require("./groupWelcome")
const help = require("./help")

const WEBSITE_URL = "https://antoniusfahri.my.id"
const HELLO_BUILD = "PRIVATE-HELLO-MENU-2026-08-04.1"
const WEBSITE_BUTTON_TEXT = "Tentang Penulis Script Bot"
const HELLO_DEDUPE_TTL_MS = 5 * 60 * 1000
const recentHelloMessages = new Map()

console.log(`[PRIVATE HELLO MENU] ${HELLO_BUILD} LOADED`)

function normalizeText(value) {
    return String(value || "").trim()
}

function normalizeJid(value) {
    return String(value || "").trim().toLowerCase()
}

function isPnJid(value) {
    return normalizeJid(value).endsWith("@s.whatsapp.net")
}

function isLidJid(value) {
    return normalizeJid(value).endsWith("@lid")
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
        `Tekan tombol *${WEBSITE_BUTTON_TEXT}* untuk membuka website penulis, atau tekan *BUKA MENU* untuk melihat seluruh bantuan bot.`,
    ].join("\n")
}

function buildPrivateMenuSections() {
    return [
        {
            title: "BANTUAN UTAMA",
            rows: [
                { header: "HELP", title: "Semua Command", description: "Buka helper text lengkap bot", id: ".pmenu all" },
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
            `Buka tombol *${WEBSITE_BUTTON_TEXT}* pada menu utama untuk mengunjungi website penulis script.`,
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

function resolvePrivateReplyJid(msg, context = {}) {
    const candidates = [
        context.replyJid,
        context.resolvedFrom,
        msg?.key?.remoteJidAlt,
        context.resolvedSender,
        context.senderJid,
        msg?.key?.participantAlt,
        msg?.key?.participant,
        context.from,
        msg?.key?.remoteJid,
    ].map(normalizeJid).filter(Boolean)

    return candidates.find(isPnJid)
        || candidates.find(isLidJid)
        || candidates[0]
        || ""
}

function pruneHelloDedupe(now = Date.now()) {
    for (const [key, timestamp] of recentHelloMessages) {
        if (now - timestamp > HELLO_DEDUPE_TTL_MS) recentHelloMessages.delete(key)
    }
}

function claimHelloMessage(msg) {
    const id = normalizeText(msg?.key?.id)
    if (!id) return { claimed: true, key: "" }
    pruneHelloDedupe()
    const key = `${normalizeJid(msg?.key?.remoteJid)}:${id}`
    if (recentHelloMessages.has(key)) return { claimed: false, key }
    recentHelloMessages.set(key, Date.now())
    return { claimed: true, key }
}

function releaseHelloMessage(key) {
    if (key) recentHelloMessages.delete(key)
}

async function sendTextFallback(sock, targetJids, text, msg) {
    let lastError = null
    for (const jid of [...new Set(targetJids.map(normalizeJid).filter(Boolean))]) {
        try {
            await sock.sendMessage(jid, { text }, { quoted: msg })
            return { sent: true, mode: "text-fallback", jid }
        } catch (error) {
            lastError = error
            console.log("[PRIVATE HELLO MENU] fallback gagal", {
                build: HELLO_BUILD,
                jid,
                error: String(error?.message || error).slice(0, 260),
            })
        }
    }
    if (lastError) throw lastError
    return { sent: false, mode: "no-target", jid: "" }
}

async function handlePrivateMenuCommand(sock, msg, context = {}) {
    if (context.isGroup || msg?.key?.fromMe) return false
    const category = parsePrivateMenuCommand(context.text)
    if (!category) return false
    const targetJid = resolvePrivateReplyJid(msg, context)
    if (!targetJid) return false
    await sock.sendMessage(targetJid, { text: buildCategoryText(category) }, { quoted: msg })
    return true
}

async function handlePrivateHello(sock, msg, context = {}) {
    if (context.isGroup || msg?.key?.fromMe || !isHelloTrigger(context.text)) return false

    const targetJid = resolvePrivateReplyJid(msg, context)
    if (!targetJid) {
        console.log("[PRIVATE HELLO MENU] skip-no-target", {
            build: HELLO_BUILD,
            id: msg?.key?.id || "",
            from: context.from || msg?.key?.remoteJid || "",
        })
        return false
    }

    const claim = claimHelloMessage(msg)
    if (!claim.claimed) {
        console.log("[PRIVATE HELLO MENU] duplicate-skip", {
            build: HELLO_BUILD,
            id: msg?.key?.id || "",
            targetJid,
        })
        return true
    }

    const displayName = context.displayName || msg?.pushName || "Kak"
    const originalJid = normalizeJid(context.from || msg?.key?.remoteJid)
    console.log("[PRIVATE HELLO MENU] ROUTE", {
        build: HELLO_BUILD,
        id: msg?.key?.id || "",
        originalJid,
        targetJid,
        botStatus: context.botStatus,
    })

    try {
        const result = await groupWelcome.sendInteractiveMenu(sock, targetJid, {
            title: "✦ MENU PRIVATE • USERBOT FAHRI ✦",
            bodyText: `\n${buildIntroText(displayName)}`,
            footer: "Pilih kategori bantuan • USERBOT FAHRI",
            sections: buildPrivateMenuSections(),
            nativeFlowButtons: [
                {
                    name: "cta_url",
                    buttonParamsJson: JSON.stringify({
                        display_text: WEBSITE_BUTTON_TEXT,
                        url: WEBSITE_URL,
                        merchant_url: WEBSITE_URL,
                    }),
                },
            ],
            menuButtonTitle: "BUKA MENU",
            quoted: msg,
            fallbackText: buildPrivateFallbackText(displayName),
            baileys: context.baileys,
        })
        if (result?.sent) {
            console.log(`[PRIVATE HELLO MENU] ${HELLO_BUILD} sent=true mode=${result?.mode || "unknown"} jid=${targetJid}`)
            return true
        }
    } catch (error) {
        console.log("[PRIVATE HELLO MENU] interactive gagal, pakai fallback", {
            build: HELLO_BUILD,
            targetJid,
            error: String(error?.message || error).slice(0, 260),
        })
    }

    try {
        const fallback = await sendTextFallback(
            sock,
            [targetJid, originalJid],
            buildPrivateFallbackText(displayName),
            msg
        )
        console.log(`[PRIVATE HELLO MENU] ${HELLO_BUILD} sent=${Boolean(fallback.sent)} mode=${fallback.mode} jid=${fallback.jid}`)
        return Boolean(fallback.sent)
    } catch (error) {
        releaseHelloMessage(claim.key)
        console.log("[PRIVATE HELLO MENU] SEND-FAILED", {
            build: HELLO_BUILD,
            targetJid,
            originalJid,
            error: String(error?.message || error).slice(0, 300),
        })
        return false
    }
}

function clearHelloDedupe() {
    recentHelloMessages.clear()
}

module.exports = {
    WEBSITE_URL,
    WEBSITE_BUTTON_TEXT,
    HELLO_BUILD,
    isHelloTrigger,
    buildIntroText,
    buildPrivateMenuSections,
    buildPrivateFallbackText,
    buildCategoryText,
    parsePrivateMenuCommand,
    resolvePrivateReplyJid,
    handlePrivateMenuCommand,
    handlePrivateHello,
    clearHelloDedupe,
}
