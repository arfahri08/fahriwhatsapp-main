require("dotenv").config()
try {
    require("./scripts/patch-baileys-group-retry").applyBaileysGroupRetryPatch({
        silent: process.env.BAILEYS_PATCH_LOG === "false",
    })
} catch (error) {
    console.log(`[BAILEYS PATCH] Gagal memasang patch sebelum start: ${error.message}`)
}
const baileys = require("@whiskeysockets/baileys")
const makeWASocket = baileys.default
const { useMultiFileAuthState, DisconnectReason, downloadContentFromMessage, fetchLatestBaileysVersion } = baileys
const P = require("pino")
const qrcode = require("qrcode-terminal")
const axios = require("axios")
const fs = require("fs")
const PDFDocument = require("pdfkit")
const path = require("path")
const sticker = require("./modules/sticker")
const afk = require("./modules/afk")
const { delay } = require("./modules/delay")
const keywords = require("./modules/keywords")
const blocklist = require("./modules/blocklist")
const scheduler = require("./modules/scheduler")
const stats = require("./modules/stats")
const replies = require("./modules/replies")
const { getWeatherText } = require("./modules/weather")
const bctemplate = require("./modules/bctemplate")
const bcscheduler = require("./modules/bcscheduler")
const viewonce = require("./modules/viewonce")
const viewonce2 = require("./modules/viewonce2")
const deletedMessageNotifier = require("./modules/deletedMessageNotifier")
const securityMediaLog = require("./modules/securityMediaLog")
const botStatus = require("./modules/botStatus")
const callHandler = require("./modules/callHandler")
const localDownloader = require("./modules/localDownloader")
const spotifyDownloader = require("./modules/spotifyDownloader")
const legacyDownloader = require("./modules/downloader")
const mediaCleanupManager = require("./modules/mediaCleanupManager")
const activeNotifier = require("./modules/activeNotifier")
const messageCleaner = require("./modules/messageCleaner")
const statusPanel = require("./modules/statusPanel")
const statusDownloader = require("./modules/statusDownloader")
const targetedStatusDownloader = require("./modules/targetedStatusDownloader")
const statusInbox = require("./modules/statusInbox")
const incomingMediaLogger = require("./modules/incomingMediaLogger")
const reminder = require("./modules/reminder");
const help = require("./modules/help");
const autoReply = require("./modules/autoReply");
const manualAutoReplyPause = require("./modules/manualAutoReplyPause");
const customAutoReply = require("./modules/customAutoReply");
const tgStickerConverter = require("./modules/telegramStickerConverter");
const legacyTgSticker = require("./modules/tg_sticker");
const autoReplyForwarder = require("./modules/autoReplyForwarder");
const botBlocklistManager = require("./modules/botBlocklistManager");
const imageSticker = require("./modules/imageSticker");
const imageToPdfFeature = require("./modules/imageToPdf");
const calculator = require("./modules/calculator");
const settings = require("./modules/settings");
const antiToxic = require("./modules/antiToxic");
const antiToxicStickerOcr = require("./modules/antiToxicStickerOcr");
const antiToxicControl = require("./modules/antiToxicControl");
const antiToxicReflectionConfig = require("./modules/antiToxicReflectionConfig");
const groupRemoteControl = require("./modules/groupRemoteControl");
const lidAliasStore = require("./modules/lidAliasStore");
const extendedDownloader = require("./modules/extendedDownloader");
const fakeVn = require("./modules/fakeVn");
const qrArt = require("./modules/qrArt");
const stickerSafetyGuard = require("./modules/stickerSafetyGuard");
const healthCheck = require("./modules/healthCheck");
const routerTraceModule = require("./modules/routerTrace");
const routerTrace = {
    trace: typeof routerTraceModule.trace === "function" ? routerTraceModule.trace : () => false,
    run: typeof routerTraceModule.run === "function"
        ? routerTraceModule.run
        : async (_msg, _context, _handler, callback) => (typeof callback === "function" ? callback() : false),
    detectCommand: typeof routerTraceModule.detectCommand === "function" ? routerTraceModule.detectCommand : () => "",
    detectPlatform: typeof routerTraceModule.detectPlatform === "function" ? routerTraceModule.detectPlatform : () => "",
};
const reactionWorkflow = require("./modules/reactionWorkflow");
const messageEditGuardian = require("./modules/messageEditGuardian");
const loginManager = require("./modules/login");
const backup = require("./modules/backup");

// ===== ADVANCED FEATURE CONFIG =====
const PRIORITY_USERS = ["6288287764273@s.whatsapp.net"] // isi nomor penting
let BOT_MODE = "normal" // normal | formal | santai | sales

const followUpTracker = new Map()
const botSentMessageIds = new Map()
const botSentMessagePayloads = new Map()
const processedIncomingMessageIds = new Map()
const messageContentCache = new Map()
let reconnectTimer = null
let reconnectAttempts = 0
let isStartingBot = false
let activeSock = null
let pendingLoginConfig = null
let activeShutdownHook = null
let isProcessShuttingDown = false
let broadcastSchedulerTimer = null
let broadcastSchedulerRunning = false
const processingBroadcastIds = new Set()

const RECONNECT_BASE_DELAY_MS = Number(process.env.WA_RECONNECT_MIN_DELAY_MS || 3000)
const RECONNECT_MAX_DELAY_MS = Number(process.env.WA_RECONNECT_MAX_DELAY_MS || 15000)
const AUTH_SAVE_WAIT_MS = Number(process.env.WA_AUTH_SAVE_WAIT_MS || 5000)
const GROUP_WARMUP_DELAY_MS = Number(process.env.WA_GROUP_WARMUP_DELAY_MS || 90000)
const ACTIVE_NOTIFY_DELAY_MS = Number(process.env.ACTIVE_NOTIFY_DELAY_MS || 30000)
const SHUTDOWN_GRACE_MS = Number(process.env.WA_SHUTDOWN_GRACE_MS || 5000)
const BOT_SENT_MESSAGE_TTL_MS = 10 * 60 * 1000
const PROCESSED_INCOMING_MESSAGE_TTL_MS = 5 * 60 * 1000
const PROCESSED_INCOMING_MESSAGE_MAX_SIZE = 3000
const MESSAGE_CONTENT_CACHE_TTL_MS = 30 * 60 * 1000
const MESSAGE_CONTENT_CACHE_MAX_SIZE = 1000
const GROUP_METADATA_CACHE_TTL_MS = Number(process.env.GROUP_METADATA_CACHE_TTL_MS || 60 * 60 * 1000)
const GROUP_METADATA_STALE_TTL_MS = Number(process.env.GROUP_METADATA_STALE_TTL_MS || 6 * 60 * 60 * 1000)
const GROUP_METADATA_CACHE_MAX_SIZE = Number(process.env.GROUP_METADATA_CACHE_MAX_SIZE || 500)
const groupMetadataCache = new Map()
const RESTART_NOTICE_PATH = path.join(__dirname, "data", "restartNotice.json")
const INSTANCE_LOCK_PATH = path.join(__dirname, "data", "runtime.lock")
const RESTART_EXIT_DELAY_MS = Number(process.env.RESTART_EXIT_DELAY_MS || 3500)
const RESTART_SEND_TIMEOUT_MS = Number(process.env.RESTART_SEND_TIMEOUT_MS || 15000)
const RESTART_HELP_EDIT_DELAY_MS = Number(process.env.RESTART_HELP_EDIT_DELAY_MS || 1500)
const RESTART_WAIT_TEXT = "🔄 Sedang menerapkan perubahan dan me-restart bot. Silakan tunggu sekitar 5-10 detik..."
const LID_SEND_STATUS_WAIT_MS = Number(process.env.LID_SEND_STATUS_WAIT_MS || 2500)

function isBroadcastJid(jid) {
    const value = String(jid || "").trim().toLowerCase()
    return value === "status@broadcast" || value.endsWith("@broadcast")
}

function isNewsletterJid(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@newsletter")
}

function isLidJid(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@lid")
}

function shouldIgnoreLidMessages() {
    return String(process.env.WA_IGNORE_LID_MESSAGES || "false").trim().toLowerCase() === "true"
}

function isEnvEnabled(value, fallback = true) {
    const clean = String(value ?? "").trim()
    if (!clean) return fallback
    return !/^(0|false|off|no)$/i.test(clean)
}

function shouldSilencePrivateOnlyCommandInGroup(text, isGroup) {
    if (!isGroup) return false
    const lower = String(text || "").trim().toLowerCase()
    return lower === ".bot"
        || lower.startsWith(".bot ")
        || lower === ".reply"
        || lower.startsWith(".reply ")
        || lower === ".reactionctl"
        || lower.startsWith(".reactionctl ")
        || lower === ".reactctl"
        || lower.startsWith(".reactctl ")
        || lower === ".reactiontest"
        || lower === ".reacttest"
        || lower === ".securitylog"
        || lower.startsWith(".securitylog ")
        || lower === ".seclog"
        || lower.startsWith(".seclog ")
        || lower.startsWith(".bcprepare ")
        || lower === ".bcprepare"
        || lower.startsWith(".bcaction ")
        || lower === ".bcaction"
        || lower === ".healthreact"
        || lower.startsWith(".healthreact ")
}

const legacyDownloaderCommandSessions = new Map()
const LEGACY_DOWNLOADER_SESSION_TTL_MS = 120000

function isIncomingMediaLoggerEnabled() {
    const configured = process.env.INCOMING_MEDIA_LOGGER_ENABLED ?? process.env.MEDIA_INTAKE_LOG_ENABLED
    return isEnvEnabled(configured, false)
}

function extractFirstUrl(text) {
    const match = String(text || "").match(/https?:\/\/[^\s]+/i)
    return match ? match[0].replace(/[),.?!]+$/g, "") : ""
}

function normalizeSafeKey(value, maxLength = 64) {
    const key = String(value || "").trim()
    if (!key || key.length > maxLength || !/^[A-Za-z0-9_.:-]+$/.test(key)) return ""
    return key
}

function isSensitiveSettingsKey(key) {
    return /(secret|token|password|passwd|pass|key|cookie|auth|session|credential|private|sftp)/i.test(String(key || ""))
}

function formatSettingValue(value) {
    if (value == null) return "-"
    if (typeof value === "string") return value
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

async function handleSettingsCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    const match = text.match(/^\.settings(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/i)
    if (!match) return false

    if (context.isGroup) return true

    if (!context.isOwner) {
        await sock.sendMessage(context.from, { text: "Akses Ditolak" })
        return true
    }

    const action = String(match[1] || "help").toLowerCase()
    const rest = String(match[2] || "").trim()

    if (action === "list") {
        const all = settings.getAll()
        const visibleKeys = Object.keys(all).filter(key => !isSensitiveSettingsKey(key)).sort()
        const hiddenCount = Object.keys(all).length - visibleKeys.length
        await sock.sendMessage(context.from, {
            text: [
                "*Settings*",
                "",
                visibleKeys.length
                    ? visibleKeys.map(key => `- ${key}: ${formatSettingValue(all[key])}`).join("\n")
                    : "Belum ada setting publik.",
                hiddenCount > 0 ? `\n${hiddenCount} setting sensitif disembunyikan.` : "",
            ].join("\n").trim(),
        })
        return true
    }

    if (action === "get") {
        const key = normalizeSafeKey(rest)
        if (!key) {
            await sock.sendMessage(context.from, { text: "Format: .settings get <key>" })
            return true
        }

        if (isSensitiveSettingsKey(key)) {
            await sock.sendMessage(context.from, { text: "Setting sensitif tidak ditampilkan." })
            return true
        }

        await sock.sendMessage(context.from, {
            text: `${key}: ${formatSettingValue(settings.get(key))}`,
        })
        return true
    }

    if (action === "set") {
        await sock.sendMessage(context.from, {
            text: "Settings set belum diaktifkan untuk menjaga konfigurasi tetap aman. Gunakan .settings list atau .settings get <key>.",
        })
        return true
    }

    await sock.sendMessage(context.from, {
        text: [
            "*Settings*",
            ".settings list",
            ".settings get <key>",
        ].join("\n"),
    })
    return true
}

function splitTemplateAddPayload(payload) {
    const separatorIndex = String(payload || "").indexOf("|")
    if (separatorIndex < 0) return null
    return {
        name: String(payload).slice(0, separatorIndex).trim(),
        body: String(payload).slice(separatorIndex + 1).trim(),
    }
}

async function handleBroadcastTemplateCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    const match = text.match(/^\.(bctemplate|bct)(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/i)
    if (!match) return false

    if (context.isGroup) return true

    if (!context.isOwner) {
        await sock.sendMessage(context.from, { text: "Akses Ditolak" })
        return true
    }

    const action = String(match[2] || "help").toLowerCase()
    const rest = String(match[3] || "").trim()

    if (action === "list") {
        const list = bctemplate.getList()
        const names = Object.keys(list).sort()
        await sock.sendMessage(context.from, {
            text: names.length
                ? `*Broadcast Template*\n\n${names.map((name, index) => `${index + 1}. ${name}`).join("\n")}`
                : "Belum ada broadcast template.",
        })
        return true
    }

    if (action === "get") {
        const name = normalizeSafeKey(rest, 40)
        if (!name) {
            await sock.sendMessage(context.from, { text: "Format: .bctemplate get <nama>" })
            return true
        }

        const template = bctemplate.getTemplate(name)
        await sock.sendMessage(context.from, {
            text: template ? `*${name}*\n\n${template}` : `Template "${name}" tidak ditemukan.`,
        })
        return true
    }

    if (action === "del") {
        const name = normalizeSafeKey(rest, 40)
        if (!name) {
            await sock.sendMessage(context.from, { text: "Format: .bctemplate del <nama>" })
            return true
        }

        const ok = bctemplate.delTemplate(name)
        await sock.sendMessage(context.from, {
            text: ok ? `Template "${name}" dihapus.` : `Template "${name}" tidak ditemukan.`,
        })
        return true
    }

    if (action === "add") {
        const payload = splitTemplateAddPayload(rest)
        const name = normalizeSafeKey(payload?.name, 40)
        const body = String(payload?.body || "").trim()

        if (!payload || !name || !body) {
            await sock.sendMessage(context.from, {
                text: "Format: .bctemplate add <nama>|<isi pesan>",
            })
            return true
        }

        if (body.length > 4000) {
            await sock.sendMessage(context.from, { text: "Isi template terlalu panjang. Maksimal 4000 karakter." })
            return true
        }

        bctemplate.addTemplate(name, body)
        await sock.sendMessage(context.from, { text: `Template "${name}" disimpan.` })
        return true
    }

    await sock.sendMessage(context.from, {
        text: [
            "*Broadcast Template*",
            ".bctemplate add <nama>|<isi pesan>",
            ".bctemplate list",
            ".bctemplate get <nama>",
            ".bctemplate del <nama>",
            "",
            "Alias: .bct add/list/get/del",
        ].join("\n"),
    })
    return true
}

function isBroadcastSchedulerCommand(text) {
    return /^(\.bcjadwal|\.listbcjadwal|\.delbcjadwal|\.bcstatus|\.bcfail|\.bcretry)(?:\s|$)/i.test(String(text || "").trim())
}

function getBroadcastSchedulerIntervalMs() {
    const value = Number(process.env.BC_SCHEDULER_INTERVAL_MS || 30000)
    if (!Number.isFinite(value)) return 30000
    return Math.max(10000, Math.floor(value))
}

function getBroadcastSchedulerRuntimeStatus() {
    return {
        running: Boolean(broadcastSchedulerTimer),
        intervalMs: getBroadcastSchedulerIntervalMs(),
        processing: processingBroadcastIds.size,
    }
}

function formatBroadcastDateTime(schedule) {
    if (!schedule) return "-"
    const timezone = schedule.timezone || bcscheduler.getTimezone()
    return schedule.date
        ? `${schedule.date} ${schedule.time} (${timezone})`
        : `setiap hari ${schedule.time} (${timezone})`
}

function formatBroadcastScheduleLine(schedule, index) {
    const label = index == null ? schedule.id : `${index + 1}. ${schedule.id}`
    const preview = String(schedule.message || "").replace(/\s+/g, " ").slice(0, 80)
    return [
        `${label}`,
        `Target: ${schedule.targetJid || "-"}`,
        `Waktu: ${formatBroadcastDateTime(schedule)}`,
        `Status: ${schedule.status}${schedule.attempts ? `, attempts ${schedule.attempts}` : ""}`,
        schedule.lastError ? `Error: ${schedule.lastError}` : "",
        `Pesan: ${preview || "-"}`,
    ].filter(Boolean).join("\n")
}

function parseBroadcastSchedulePayload(raw) {
    const payload = String(raw || "").trim()
    const templateMatch = payload.match(/^template\s+(\S+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})$/i)
    if (templateMatch) {
        return {
            mode: "template",
            templateName: templateMatch[1],
            targetJid: templateMatch[2],
            date: templateMatch[3],
            time: templateMatch[4],
        }
    }

    const parts = payload.split("|").map(part => part.trim())
    if (parts.length >= 3) {
        const dateTimeMatch = parts[1].match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})$/)
        if (dateTimeMatch) {
            return {
                mode: "inline",
                targetJid: parts[0],
                date: dateTimeMatch[1],
                time: dateTimeMatch[2],
                message: parts.slice(2).join("|").trim(),
            }
        }

        return {
            mode: "inline",
            targetJid: parts[0],
            time: parts[1],
            message: parts.slice(2).join("|").trim(),
        }
    }

    if (parts.length >= 2 && bcscheduler.normalizeTime(parts[0])) {
        return {
            mode: "legacy",
            targetJid: process.env.BC_SCHEDULER_DEFAULT_TARGET || "",
            time: parts[0],
            message: parts.slice(1).join("|").trim(),
        }
    }

    return null
}

function getBroadcastSchedulerHelpText() {
    return [
        "*Broadcast Scheduler*",
        "",
        ".bcjadwal <target_jid> | <HH:MM> | <pesan>",
        ".bcjadwal <target_jid> | <YYYY-MM-DD> <HH:MM> | <pesan>",
        ".bcjadwal template <nama_template> <target_jid> <YYYY-MM-DD> <HH:MM>",
        ".listbcjadwal",
        ".delbcjadwal <id/jam>",
        ".bcstatus",
        ".bcfail",
        ".bcretry <id>",
        "",
        `Timezone: ${bcscheduler.getTimezone()}`,
    ].join("\n")
}

async function handleBroadcastSchedulerCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    if (!isBroadcastSchedulerCommand(text)) return false

    if (context.isGroup) return true

    if (!context.isOwner) {
        await sock.sendMessage(context.from, { text: "Akses Ditolak" })
        return true
    }

    const lower = text.toLowerCase()

    if (lower === ".bcstatus") {
        const runtime = getBroadcastSchedulerRuntimeStatus()
        const summary = bcscheduler.getSummary()
        await sock.sendMessage(context.from, {
            text: [
                "*Broadcast Scheduler*",
                "",
                `Engine: ${runtime.running ? "ON" : "OFF"}`,
                `Interval: ${Math.round(runtime.intervalMs / 1000)} detik`,
                `Pending: ${summary.pending}`,
                `Processing: ${summary.processing + runtime.processing}`,
                `Sent: ${summary.sent}`,
                `Failed: ${summary.failed}`,
                `Next Schedule: ${formatBroadcastDateTime(summary.nextSchedule)}`,
                `Timezone: ${summary.timezone}`,
            ].join("\n"),
        })
        return true
    }

    if (lower === ".bcfail") {
        const failed = bcscheduler.getFailedSchedules()
        await sock.sendMessage(context.from, {
            text: failed.length
                ? `*Broadcast Failed (${failed.length})*\n\n${failed.map(formatBroadcastScheduleLine).join("\n\n")}`
                : "Tidak ada broadcast schedule gagal.",
        })
        return true
    }

    if (lower.startsWith(".bcretry")) {
        const id = text.replace(/^\.bcretry\s*/i, "").trim()
        if (!id) {
            await sock.sendMessage(context.from, { text: "Format: .bcretry <id>" })
            return true
        }

        const schedule = bcscheduler.resetFailed(id)
        await sock.sendMessage(context.from, {
            text: schedule ? `Schedule ${schedule.id} dikembalikan ke pending.` : `Schedule gagal "${id}" tidak ditemukan.`,
        })
        return true
    }

    if (lower === ".listbcjadwal") {
        const list = bcscheduler.getList()
        await sock.sendMessage(context.from, {
            text: list.length
                ? `*Jadwal Broadcast (${list.length})*\n\n${list.map(formatBroadcastScheduleLine).join("\n\n")}`
                : "Belum ada jadwal broadcast.",
        })
        return true
    }

    if (lower.startsWith(".delbcjadwal")) {
        const id = text.replace(/^\.delbcjadwal\s*/i, "").trim()
        if (!id) {
            await sock.sendMessage(context.from, { text: "Format: .delbcjadwal <id/jam>" })
            return true
        }

        const ok = bcscheduler.delSchedule(id)
        await sock.sendMessage(context.from, { text: ok ? `Jadwal ${id} dihapus.` : `Jadwal ${id} tidak ditemukan.` })
        return true
    }

    if (lower === ".bcjadwal") {
        await sock.sendMessage(context.from, { text: getBroadcastSchedulerHelpText() })
        return true
    }

    if (lower.startsWith(".bcjadwal ")) {
        const parsed = parseBroadcastSchedulePayload(text.replace(/^\.bcjadwal\s+/i, ""))
        if (!parsed) {
            await sock.sendMessage(context.from, { text: getBroadcastSchedulerHelpText() })
            return true
        }

        let message = parsed.message
        if (parsed.mode === "template") {
            message = bctemplate.getTemplate(parsed.templateName)
            if (!message) {
                await sock.sendMessage(context.from, { text: `Template "${parsed.templateName}" tidak ditemukan.` })
                return true
            }
        }

        const targetJid = bcscheduler.normalizeTargetJid(parsed.targetJid)
        const time = bcscheduler.normalizeTime(parsed.time)
        const date = parsed.date ? bcscheduler.normalizeDate(parsed.date) : ""
        if (!targetJid || !time || (parsed.date && !date) || !String(message || "").trim()) {
            await sock.sendMessage(context.from, { text: getBroadcastSchedulerHelpText() })
            return true
        }

        const schedule = bcscheduler.addSchedule({
            targetJid,
            time,
            date,
            message,
            templateName: parsed.templateName || "",
            timezone: bcscheduler.getTimezone(),
        })

        if (!schedule) {
            await sock.sendMessage(context.from, { text: "Gagal menyimpan jadwal broadcast. Periksa target, waktu, dan isi pesan." })
            return true
        }

        await sock.sendMessage(context.from, {
            text: [
                "Jadwal broadcast disimpan.",
                "",
                `ID: ${schedule.id}`,
                `Target: ${schedule.targetJid}`,
                `Waktu: ${formatBroadcastDateTime(schedule)}`,
                parsed.mode === "legacy" ? "Catatan: format lama memakai BC_SCHEDULER_DEFAULT_TARGET." : "",
                "",
                "Preview:",
                String(schedule.message).slice(0, 500),
            ].filter(Boolean).join("\n"),
        })
        return true
    }

    return false
}

async function handleCalculatorCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    const match = text.match(/^\.(calc|hitung)(?:\s+([\s\S]+))?$/i)
    if (!match) return false

    const expression = String(match[2] || "").trim()
    if (!expression) {
        await sock.sendMessage(context.from, { text: "Format: .calc 12 / (2 + 1)" })
        return true
    }

    try {
        const result = calculator.calculate(expression)
        await sock.sendMessage(context.from, { text: `${expression} = ${result}` })
    } catch (error) {
        await sock.sendMessage(context.from, { text: `Gagal hitung: ${error.message}` })
    }

    return true
}

async function handleLegacyDownloaderCommand(sock, msg, context = {}) {
    if (context.isGroup || String(context.from || msg?.key?.remoteJid || "").toLowerCase().endsWith("@g.us")) {
        return false
    }

    const text = String(context.text || "").trim()
    const lower = text.toLowerCase()
    const now = Date.now()
    const session = legacyDownloaderCommandSessions.get(context.from)

    if (session && session.expiresAt <= now) {
        legacyDownloaderCommandSessions.delete(context.from)
    }

    if (/^[123]$/.test(text) && legacyDownloaderCommandSessions.has(context.from)) {
        const handled = await legacyDownloader.handleInteractiveDownload(sock, context.from, text, msg.pushName)
        if (handled || text === "3") legacyDownloaderCommandSessions.delete(context.from)
        return handled
    }

    const isLegacyCommand = lower === ".olddl"
        || lower.startsWith(".olddl ")
        || lower === ".dlold"
        || lower.startsWith(".dlold ")
    if (!isLegacyCommand) return false

    const url = extractFirstUrl(text)
    if (!url) {
        await sock.sendMessage(context.from, { text: "Format: .dlold <url>" })
        return true
    }

    if (spotifyDownloader.isSpotifyUrl(url)) {
        await sock.sendMessage(context.from, { text: "Link Spotify sudah ditangani Spotify Downloader." })
        return true
    }

    const handled = await legacyDownloader.handleInteractiveDownload(sock, context.from, url, msg.pushName)
    if (handled) {
        legacyDownloaderCommandSessions.set(context.from, {
            expiresAt: now + LEGACY_DOWNLOADER_SESSION_TTL_MS,
        })
    }
    return true
}

async function handleLegacyTelegramStickerCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    const match = text.match(/^\.(tgstikerold|tgpack|tgsticker2)(?:\s+([\s\S]+))?$/i)
    if (!match) return false

    const url = String(match[2] || "").trim()
    if (!url) {
        await sock.sendMessage(context.from, {
            text: "Format: .tgstikerold https://t.me/addstickers/nama_pack",
        })
        return true
    }

    const transformedText = `.tgstiker ${url}`
    return legacyTgSticker.handleTgStickerMessage(sock, context.from, transformedText, msg, msg.pushName)
}

function canSendScheduledBroadcastTo(targetJid) {
    if (!String(targetJid || "").endsWith("@g.us")) return true
    try {
        const config = groupRemoteControl.getEffectiveGroupConfig(targetJid)
        return config.features?.broadcast !== false
    } catch {
        return true
    }
}

async function runBroadcastSchedulerTick(sock) {
    if (broadcastSchedulerRunning) return
    if (!sock || typeof sock.sendMessage !== "function") return

    broadcastSchedulerRunning = true
    try {
        const dueSchedules = bcscheduler.getDueSchedules()
        for (const schedule of dueSchedules) {
            if (!schedule?.id || processingBroadcastIds.has(schedule.id)) continue
            processingBroadcastIds.add(schedule.id)

            try {
                const locked = bcscheduler.markProcessing(schedule.id)
                if (!locked) continue

                const targetJid = bcscheduler.normalizeTargetJid(schedule.targetJid)
                const message = String(schedule.message || "").trim()
                if (!targetJid) throw new Error("target JID tidak valid")
                if (!message) throw new Error("isi broadcast kosong")
                if (!canSendScheduledBroadcastTo(targetJid)) {
                    throw new Error("broadcast dimatikan untuk grup target")
                }

                await sock.sendMessage(targetJid, { text: message })
                bcscheduler.markSent(schedule.id)
                console.log("[BC SCHEDULER] Broadcast terkirim.", {
                    id: schedule.id,
                    target: targetJid,
                })
            } catch (error) {
                bcscheduler.markFailed(schedule.id, error)
                console.log("[BC SCHEDULER] Gagal mengirim broadcast.", {
                    id: schedule.id,
                    error: error.message,
                })
            } finally {
                processingBroadcastIds.delete(schedule.id)
            }
        }
    } catch (error) {
        console.log("[BC SCHEDULER] Tick error:", error.message)
    } finally {
        broadcastSchedulerRunning = false
    }
}

function startBroadcastScheduler(sock) {
    stopBroadcastScheduler()
    const intervalMs = getBroadcastSchedulerIntervalMs()
    console.log(`🔄 Memulai Broadcast Scheduler (${Math.round(intervalMs / 1000)} detik).`)
    broadcastSchedulerTimer = setInterval(() => {
        runBroadcastSchedulerTick(sock).catch(error => {
            console.log("[BC SCHEDULER] Tick async error:", error.message)
        })
    }, intervalMs)
    if (typeof broadcastSchedulerTimer.unref === "function") broadcastSchedulerTimer.unref()
    runBroadcastSchedulerTick(sock).catch(error => {
        console.log("[BC SCHEDULER] Initial tick error:", error.message)
    })
}

function stopBroadcastScheduler() {
    if (broadcastSchedulerTimer) {
        clearInterval(broadcastSchedulerTimer)
        broadcastSchedulerTimer = null
    }
    broadcastSchedulerRunning = false
    processingBroadcastIds.clear()
}

function getDisconnectStatusCode(error) {
    const statusCode = Number(error?.output?.statusCode || error?.data?.statusCode || error?.statusCode || 0)
    if (Number.isFinite(statusCode) && statusCode > 0) return statusCode
    const messageCode = String(error?.message || "").match(/\b(4\d\d|5\d\d)\b/)
    return messageCode ? Number(messageCode[1]) : 0
}

function getDisconnectReasonName(statusCode) {
    return DisconnectReason?.[statusCode] || "unknown"
}

function getDisconnectConflictType(error) {
    const seen = new Set()
    const scan = (value) => {
        if (!value || typeof value !== "object" || seen.has(value)) return ""
        seen.add(value)

        if (value.tag === "conflict" && value.attrs?.type) return String(value.attrs.type)
        if (value.tag === "stream:error") {
            for (const child of value.content || []) {
                const found = scan(child)
                if (found) return found
            }
        }

        for (const key of ["reasonNode", "fullErrorNode", "node", "data", "output"]) {
            const found = scan(value[key])
            if (found) return found
        }

        if (Array.isArray(value.content)) {
            for (const child of value.content) {
                const found = scan(child)
                if (found) return found
            }
        }

        return ""
    }

    return scan(error)
}

function shouldEditActiveNoticeToHelp() {
    return isEnvEnabled(process.env.RESTART_HELP_AFTER_ACTIVE, false)
}

let instanceLockOwned = false

function isPidAlive(pid) {
    const cleanPid = Number(pid)
    if (!Number.isFinite(cleanPid) || cleanPid <= 0) return false
    if (cleanPid === process.pid) return true

    try {
        process.kill(cleanPid, 0)
        return true
    } catch (error) {
        return error?.code === "EPERM"
    }
}

function readInstanceLock() {
    try {
        return JSON.parse(fs.readFileSync(INSTANCE_LOCK_PATH, "utf8"))
    } catch {
        return null
    }
}

function releaseInstanceLock() {
    if (!instanceLockOwned) return

    try {
        const lock = readInstanceLock()
        if (!lock || Number(lock.pid) === process.pid) {
            fs.rmSync(INSTANCE_LOCK_PATH, { force: true })
        }
    } catch {}

    instanceLockOwned = false
}

function acquireInstanceLock() {
    fs.mkdirSync(path.dirname(INSTANCE_LOCK_PATH), { recursive: true })

    const payload = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        cwd: process.cwd(),
        argv: process.argv,
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = fs.openSync(INSTANCE_LOCK_PATH, "wx")
            try {
                fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`)
            } finally {
                fs.closeSync(fd)
            }
            instanceLockOwned = true
            return
        } catch (error) {
            if (error?.code !== "EEXIST") throw error

            const existing = readInstanceLock()
            if (existing?.pid && isPidAlive(existing.pid)) {
                console.log("")
                console.log("❌ Bot WhatsApp sudah berjalan di proses lain.")
                console.log(`[LOCK] Lock aktif: pid=${existing.pid}, cwd=${existing.cwd || "-"}`)
                console.log("Stop proses lama dulu sebelum login ulang, supaya folder auth tidak rusak.")
                console.log("Termux:")
                console.log("  pm2 stop a")
                console.log("  pm2 delete a")
                console.log(`  kill ${existing.pid}`)
                console.log("")
                process.exit(1)
            }

            console.log("[LOCK] Runtime lock lama/stale ditemukan, dibersihkan.")
            fs.rmSync(INSTANCE_LOCK_PATH, { force: true })
        }
    }
}

async function requestProcessShutdown(reason, exitCode) {
    if (isProcessShuttingDown) return
    isProcessShuttingDown = true

    console.log(`[SHUTDOWN] ${reason}, menutup bot dengan aman...`)
    if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
    }

    try {
        if (typeof activeShutdownHook === "function") {
            await Promise.race([
                activeShutdownHook(reason),
                waitMs(SHUTDOWN_GRACE_MS).then(() => {
                    console.log(`[SHUTDOWN] Timeout ${SHUTDOWN_GRACE_MS}ms, lanjut keluar.`)
                }),
            ])
        } else if (activeSock) {
            cleanupSocket(activeSock)
        }
    } catch (error) {
        console.log(`[SHUTDOWN] Gagal shutdown bersih: ${error.message}`)
    }

    releaseInstanceLock()
    process.exit(exitCode)
}

function installProcessGuards() {
    process.once("exit", releaseInstanceLock)
    process.once("SIGINT", () => {
        requestProcessShutdown("SIGINT", 130)
    })
    process.once("SIGTERM", () => {
        requestProcessShutdown("SIGTERM", 143)
    })
    process.on("uncaughtException", (error) => {
        console.log("[FATAL] Uncaught exception:", error?.stack || error?.message || error)
        requestProcessShutdown("uncaughtException", 1)
    })
    process.on("unhandledRejection", (error) => {
        console.log("[FATAL] Unhandled rejection:", error?.stack || error?.message || error)
        requestProcessShutdown("unhandledRejection", 1)
    })
}

function shouldIgnoreIncomingJid(jid) {
    return isNewsletterJid(jid) || (shouldIgnoreLidMessages() && isLidJid(jid))
}

function isAntiToxicDebug() {
    return /^(1|true|yes|on)$/i.test(String(process.env.ANTI_TOXIC_DEBUG || "false").trim())
}

function isAntiToxicWarnOwnerEnabled() {
    return /^(1|true|yes|on)$/i.test(String(
        process.env.ANTI_TOXIC_WARN_OWNER_MESSAGES
        || process.env.ANTI_TOXIC_TEST_OWNER
        || "false"
    ).trim())
}

function debugAntiToxicPipeline(stage, details = {}) {
    if (!isAntiToxicDebug()) return
    console.log("[ANTI-TOXIC PIPELINE]", { stage, ...details })
}

function unwrapBasicMessageForAntiToxic(message) {
    let current = message || {}

    for (let i = 0; i < 8; i += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message
        else break
    }

    return current || {}
}

function getAntiToxicPipelineText(msg) {
    const message = unwrapBasicMessageForAntiToxic(msg?.message || {})
    return String(
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        message.buttonsResponseMessage?.selectedDisplayText ||
        message.listResponseMessage?.title ||
        message.listResponseMessage?.singleSelectReply?.selectedRowId ||
        message.templateButtonReplyMessage?.selectedDisplayText ||
        ""
    ).trim()
}

function getAntiToxicBasicText(msg) {
    return getAntiToxicPipelineText(msg)
}

function isAntiToxicSystemText(text) {
    const clean = String(text || "").trim()
    return clean.startsWith("*ANTI-TOXIC TERDETEKSI TAPI WARNING GAGAL DIKIRIM*")
        || clean.startsWith("ANTI-TOXIC TERDETEKSI TAPI WARNING GAGAL")
        || clean.startsWith("*ANTI-TOXIC STATUS*")
        || clean.startsWith("ANTI-TOXIC STATUS")
        || clean.startsWith("ANTI-TOXIC CHECK")
        || clean.includes("ANTI-TOXIC TERDETEKSI TAPI WARNING GAGAL DIKIRIM")
        || clean.includes("Pengirim masih berupa LID:")
        || clean.includes("Penyebab: bot belum punya mapping LID")
        || clean.includes("Solusi manual kalau owner tahu nomor user:")
        || clean.includes("Targets tried:")
        || clean.includes("Send mode:")
}

function isAntiToxicGeneratedWarningText(text) {
    const clean = String(text || "").trim()
    return clean.startsWith("🤬 ATTENTION")
        || clean.startsWith("ðŸ¤¬ ATTENTION")
        || clean.includes("Kamu terdeteksi mengucapkan kata kasar terlarang")
        || clean.includes("Tolong jangan diulangi lagi ya")
        || clean.includes("Renungan Hari Ini")
        || clean.startsWith("*ANTI-TOXIC")
        || clean.includes("WARNING GAGAL DIKIRIM")
}

function isAntiToxicOwnerCommandText(text) {
    const clean = String(text || "").trim().toLowerCase()
    return clean.startsWith(".cekkasar")
        || clean.startsWith(".kasar")
        || clean.startsWith(".antitoxicsafe")
        || clean.startsWith(".safeword")
        || clean.startsWith(".antitoxicocr")
        || clean.startsWith(".antitoxicstatus")
        || clean.startsWith(".antitoxicreload")
        || clean.startsWith(".testwarn")
        || clean.startsWith(".bindlid")
        || clean.startsWith(".ceklid")
        || clean.startsWith(".unlid")
        || clean.startsWith(".listlid")
}

function isPrivatePnJid(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@s.whatsapp.net")
}

function trackLidAliasFromMessage(msg) {
    const key = msg?.key || {}
    if (msg?.key?.fromMe) {
        console.log("[LID ALIAS TRACK] skip-fromMe", {
            id: key.id,
            remoteJid: key.remoteJid,
            participant: key.participant,
            fromMe: key.fromMe,
        })
        return
    }

    const candidates = {
        remoteJid: key.remoteJid,
        remoteJidAlt: key.remoteJidAlt,
        participant: key.participant,
        participantAlt: key.participantAlt,
        msgParticipant: msg?.participant,
        msgParticipantAlt: msg?.participantAlt,
    }

    const values = Object.values(candidates)
    const lids = values.filter(jid => isLidJid(jid))
    const pns = values.filter(jid => isPrivatePnJid(jid))

    for (const lid of lids) {
        lidAliasStore.rememberSeenLid(lid, {
            source: "messages.upsert",
            pushName: msg?.pushName || "",
            messageId: key.id,
            remoteJid: key.remoteJid,
            remoteJidAlt: key.remoteJidAlt,
            participant: key.participant,
            participantAlt: key.participantAlt,
        })

        for (const pn of pns) {
            lidAliasStore.rememberAlias(lid, pn, {
                source: "message-key-alt",
                pushName: msg?.pushName || "",
                messageId: key.id,
                remoteJid: key.remoteJid,
                remoteJidAlt: key.remoteJidAlt,
                participant: key.participant,
                participantAlt: key.participantAlt,
            })
        }
    }

    if (process.env.LID_ALIAS_DEBUG === "true") {
        console.log("[LID ALIAS TRACK]", {
            id: key.id,
            pushName: msg?.pushName,
            candidates,
            lids,
            pns,
        })
    }
}

function getIgnoredIncomingReason(jid) {
    if (isNewsletterJid(jid)) return "newsletter"
    if (shouldIgnoreLidMessages() && isLidJid(jid)) return "lid"
    return null
}

function getIgnoredNodeReason(node) {
    const attrs = node?.attrs || {}
    return [attrs.from, attrs.participant, attrs.recipient]
        .map(getIgnoredIncomingReason)
        .find(Boolean) || null
}

function installUnsupportedIncomingMessageFilter(sock) {
    const ws = sock?.ws
    if (!ws || ws.__unsupportedIncomingMessageFilterInstalled || typeof ws.emit !== "function") return

    const originalEmit = ws.emit.bind(ws)
    ws.emit = function filteredEmit(eventName, node, ...args) {
        try {
            const reason = eventName === "CB:message" ? getIgnoredNodeReason(node) : null
            if (reason) {
                if (typeof sock.sendMessageAck === "function") {
                    sock.sendMessageAck(node).catch(error => {
                        console.log(`[WA INCOMING FILTER] Gagal ack ${reason}: ${error.message}`)
                    })
                }

                if (process.env.WA_LOG_INCOMING_FILTER === "true" || process.env.WA_LOG_NEWSLETTER_FILTER === "true") {
                    console.log(`[WA INCOMING FILTER] Abaikan ${reason} message ${node?.attrs?.id || "-"} dari ${node?.attrs?.from || "-"}`)
                }
                return true
            }
        } catch (error) {
            console.log(`[WA INCOMING FILTER] Error filter: ${error.message}`)
        }

        return originalEmit(eventName, node, ...args)
    }

    ws.__unsupportedIncomingMessageFilterInstalled = true
}

function normalizeOwnerJid(value) {
    const clean = String(value || "").trim()
    if (!clean) return null
    if (clean.endsWith("@s.whatsapp.net")) return clean

    const number = clean.replace(/[^0-9]/g, "")
    return number ? `${number}@s.whatsapp.net` : null
}

function getOwnerControlJid() {
    const envTarget = String(process.env.OWNER_JID || process.env.ACTIVE_NOTIFY_JIDS || "")
        .split(",")
        .map(normalizeOwnerJid)
        .find(Boolean)

    return envTarget || normalizeOwnerJid(PRIORITY_USERS[0])
}

function isOwnerJid(value) {
    const resolved = lidAliasStore.resolveBestJid(value)
    const normalized = normalizeOwnerJid(resolved || value)
    if (!normalized) return false

    const ownerCandidates = [getOwnerControlJid(), ...PRIORITY_USERS]
        .map(normalizeOwnerJid)
        .filter(Boolean)

    const number = normalized.split("@")[0]
    return ownerCandidates.some(ownerJid => ownerJid === normalized || ownerJid.split("@")[0] === number)
}

function resolveOutgoingPrivateJid(jid) {
    const clean = String(jid || "").trim()
    if (!isLidJid(clean)) return clean

    const resolved = lidAliasStore.resolveBestJid(clean)
    if (resolved && resolved !== clean && isPrivatePnJid(resolved)) {
        console.log("[LID SEND] Pakai alias PN untuk kirim pesan", {
            lid: clean,
            pn: resolved,
        })
        return resolved
    }

    return clean
}

function getLidAliasContextInfo(msg) {
    const message = unwrapBasicMessageForAntiToxic(msg?.message || {})
    return (
        message.extendedTextMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.documentMessage?.contextInfo ||
        message.audioMessage?.contextInfo ||
        message.stickerMessage?.contextInfo ||
        {}
    )
}

function parseLidAliasCommand(text) {
    const clean = String(text || "").trim()
    const match = clean.match(/^(\.bindlid|\.lidbind|\.lidalias|\.listlid|\.lids)(?:\s+([\s\S]*))?$/i)
    if (!match) return null

    const command = match[1].toLowerCase()
    if (command === ".listlid" || command === ".lids") return { action: "list", args: "" }
    return { action: "bind", args: String(match[2] || "").trim() }
}

function extractLidFromAliasCommand(msg, args) {
    const parts = String(args || "").trim().split(/\s+/).filter(Boolean)
    const directArg = parts.find(part => isLidJid(part))
    if (directArg) return lidAliasStore.normalizeLidJid(directArg)

    const contextInfo = getLidAliasContextInfo(msg)
    return [
        contextInfo.participant,
        contextInfo.remoteJid,
        msg?.key?.remoteJid,
        msg?.key?.remoteJidAlt,
        msg?.key?.participant,
        msg?.key?.participantAlt,
        msg?.participant,
        msg?.participantAlt,
    ].map(lidAliasStore.normalizeLidJid).find(Boolean) || null
}

function extractPnFromAliasCommand(args) {
    return String(args || "")
        .trim()
        .split(/\s+/)
        .filter(part => !isLidJid(part))
        .map(lidAliasStore.normalizePnJid)
        .find(Boolean) || null
}

function formatAliasList() {
    const aliases = lidAliasStore.listAliases()
        .filter(entry => entry?.lid)

    if (!aliases.length) return "Alias LID masih kosong."

    return `Daftar Alias LID:\n\n${aliases.map((entry, index) => {
        const pn = lidAliasStore.normalizePnJid(entry?.pn)
        const lid = lidAliasStore.normalizeLidJid(entry?.lid)
        return `${index + 1}. ${lid || "-"} -> ${pn || "(belum ada nomor)"}`
    }).join("\n")}`
}

async function handleLidAliasCommand(sock, msg, context = {}) {
    if (!context.isOwner) return false

    const parsed = parseLidAliasCommand(context.text)
    if (!parsed) return false

    const from = context.from || msg?.key?.remoteJid

    if (parsed.action === "list") {
        await sock.sendMessage(from, { text: formatAliasList() })
        return true
    }

    const lid = extractLidFromAliasCommand(msg, parsed.args)
    const pn = extractPnFromAliasCommand(parsed.args)

    if (!lid || !pn) {
        await sock.sendMessage(from, {
            text:
                "Format: *.bindlid 088xxxx* dari chat target LID, atau *.bindlid 223xxx@lid 088xxxx*.\n" +
                "Setelah bind, bot akan kirim balasan ke nomor PN supaya tidak nyangkut di @lid.",
        })
        return true
    }

    const result = lidAliasStore.rememberAlias(lid, pn, {
        source: "manual-bind-command",
        messageId: msg?.key?.id,
        remoteJid: msg?.key?.remoteJid,
        remoteJidAlt: msg?.key?.remoteJidAlt,
        participant: msg?.key?.participant,
        participantAlt: msg?.key?.participantAlt,
        boundBy: context.senderJid || "",
    })

    await sock.sendMessage(from, {
        text: result?.saved
            ? `Alias LID tersimpan:\n${lid} -> ${pn}`
            : `Gagal simpan alias LID: ${result?.reason || "unknown"}`,
    })
    return true
}

function isWatchedPrivateLidChat(from, senderJid) {
    if (isLidJid(from) || isLidJid(senderJid)) return true

    const values = [from, senderJid]
        .map(lidAliasStore.normalizePnJid)
        .filter(Boolean)
    if (!values.length) return false

    return lidAliasStore.listAliases()
        .map(entry => lidAliasStore.normalizePnJid(entry?.pn))
        .some(pn => pn && values.includes(pn))
}

function logPrivateLidPipeline(stage, details = {}) {
    if (!isWatchedPrivateLidChat(details.from, details.senderJid)) return

    console.log("[PRIVATE LID PIPELINE]", {
        stage,
        from: details.from,
        senderJid: details.senderJid,
        fromMe: details.fromMe,
        isOwner: details.isOwner,
        canControlOwner: details.canControlOwner,
        id: details.id,
        textPreview: String(details.text || "").slice(0, 120),
        messageTypes: details.messageTypes,
        remoteJidAlt: details.remoteJidAlt,
        participant: details.participant,
        participantAlt: details.participantAlt,
        resolvedFrom: details.from ? lidAliasStore.resolveBestJid(details.from) : null,
        resolvedSender: details.senderJid ? lidAliasStore.resolveBestJid(details.senderJid) : null,
    })
}

function getJidNumber(value) {
    return String(value || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "")
}

function normalizeReminderNumber(value) {
    let number = getJidNumber(value)
    if (!number) return null

    if (number.startsWith("0")) number = `62${number.slice(1)}`
    else if (number.startsWith("8")) number = `62${number}`

    return number.length >= 9 && number.length <= 16 ? number : null
}

function normalizeReminderUserJid(value) {
    const number = normalizeReminderNumber(value)
    return number ? `${number}@s.whatsapp.net` : null
}

function unwrapReminderMessage(message) {
    let current = message || {}

    for (let i = 0; i < 6; i += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message
        else break
    }

    return current || {}
}

function getReminderContextInfo(msg) {
    const message = unwrapReminderMessage(msg?.message || {})
    return (
        message.extendedTextMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.documentMessage?.contextInfo ||
        message.audioMessage?.contextInfo ||
        message.stickerMessage?.contextInfo ||
        message.contactMessage?.contextInfo ||
        {}
    )
}

function getReminderContactEntries(message) {
    const current = unwrapReminderMessage(message || {})
    if (current.contactMessage) return [current.contactMessage]
    if (current.contactsArrayMessage?.contacts?.length) return current.contactsArrayMessage.contacts
    return []
}

function extractReminderNumbersFromVcard(vcard) {
    const text = String(vcard || "")
    const waids = [...text.matchAll(/waid=(\d+)/gi)].map(match => match[1])
    const telLines = text
        .split(/\r?\n/)
        .filter(line => /^TEL/i.test(line))
        .map(line => line.split(":").slice(1).join(":"))
    const genericNumbers = [...text.matchAll(/(?:\+?62|0|8)(?:[\s().-]*\d){7,13}(?!\d)/g)]
        .map(match => match[0])

    return [...new Set([...waids, ...telLines, ...genericNumbers].map(normalizeReminderNumber).filter(Boolean))]
}

function uniqueReminderTargets(targets) {
    const seen = new Set()
    const result = []

    for (const target of targets || []) {
        const jid = normalizeReminderUserJid(target?.jid || target)
        if (!jid) continue

        const key = getJidNumber(jid)
        if (!key || seen.has(key)) continue
        seen.add(key)

        result.push({
            jid,
            number: key,
            label: target?.label || key,
            source: target?.source || "unknown",
        })
    }

    return result
}

function extractReminderContactTargetsFromMessage(message) {
    const targets = []

    for (const entry of getReminderContactEntries(message)) {
        const numbers = extractReminderNumbersFromVcard(entry?.vcard)
        for (const number of numbers) {
            targets.push({
                jid: `${number}@s.whatsapp.net`,
                number,
                label: entry?.displayName || number,
                source: "contact",
            })
        }
    }

    return uniqueReminderTargets(targets)
}

function extractReminderTextTargets(text) {
    const clean = String(text || "")
    if (!clean) return []

    const targets = []
    const jidPattern = /[0-9A-Za-z._:-]+@s\.whatsapp\.net/gi

    for (const match of clean.matchAll(jidPattern)) {
        const jid = normalizeReminderUserJid(match[0])
        if (jid) targets.push({ jid, label: getJidNumber(jid), source: "jid" })
    }

    const withoutJids = clean.replace(jidPattern, " ")
    const phonePattern = /(?:\+?62|0|8)(?:[\s().-]*\d){7,13}(?!\d)/g

    for (const match of withoutJids.matchAll(phonePattern)) {
        const number = normalizeReminderNumber(match[0])
        if (number) targets.push({ jid: `${number}@s.whatsapp.net`, number, label: number, source: "number" })
    }

    return uniqueReminderTargets(targets)
}

function extractReminderMentionTargets(msg) {
    const mentions = getReminderContextInfo(msg).mentionedJid
    if (!Array.isArray(mentions)) return []

    return uniqueReminderTargets(mentions.map(jid => ({
        jid,
        label: getJidNumber(jid),
        source: "mention",
    })))
}

function extractReminderQuotedTargets(msg, context = {}) {
    const contextInfo = getReminderContextInfo(msg)
    const quotedContacts = extractReminderContactTargetsFromMessage(contextInfo.quotedMessage)
    if (quotedContacts.length > 0) {
        return quotedContacts.map(target => ({ ...target, source: `quoted-${target.source}` }))
    }

    if (!contextInfo.quotedMessage && !contextInfo.stanzaId) return []

    const remoteJid = context.remoteJid || msg?.key?.remoteJid || ""
    const isGroupChat = isGroupJid(remoteJid)
    const candidates = [
        contextInfo.participantAlt,
        contextInfo.participant,
        isGroupChat ? "" : contextInfo.remoteJidAlt,
        isGroupChat ? "" : contextInfo.remoteJid,
        isGroupChat ? "" : msg?.key?.remoteJidAlt,
        isGroupChat ? "" : msg?.key?.remoteJid,
    ]
    const ownerLikeNumbers = [
        context.ownerJid,
        context.senderJid,
        msg?.key?.participantAlt,
        msg?.key?.participant,
        msg?.participantAlt,
        msg?.participant,
    ].map(getJidNumber).filter(Boolean)

    const targetJid = candidates
        .map(normalizeReminderUserJid)
        .filter(Boolean)
        .find(jid => !ownerLikeNumbers.includes(getJidNumber(jid)))

    return targetJid ? uniqueReminderTargets([{
        jid: targetJid,
        label: getJidNumber(targetJid),
        source: "reply",
    }]) : []
}

function collectReminderTargets(msg, targetText, context = {}) {
    const textTargets = extractReminderTextTargets(targetText)
    const contactTargets = extractReminderContactTargetsFromMessage(msg?.message)
    const mentionTargets = extractReminderMentionTargets(msg)
    const quotedTargets = extractReminderQuotedTargets(msg, context)
    const hasDirectTargets = textTargets.length > 0 || contactTargets.length > 0 || mentionTargets.length > 0

    return uniqueReminderTargets([
        ...textTargets,
        ...contactTargets,
        ...mentionTargets,
        ...quotedTargets.filter(target => !hasDirectTargets || String(target.source || "").includes("contact")),
    ])
}

function normalizeReminderTime(value) {
    const clean = String(value || "").trim().replace(".", ":")
    const match = clean.match(/^(\d{1,2}):([0-5]\d)$/)
    if (!match) return null

    const hour = Number(match[1])
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null

    return `${String(hour).padStart(2, "0")}:${match[2]}`
}

function formatReminderTargetList(targets) {
    return (targets || [])
        .map(target => target.label && target.label !== target.number
            ? `${target.label} (${target.number})`
            : target.number)
        .join(", ")
}

function isSameJidUser(a, b) {
    const numberA = getJidNumber(a)
    const numberB = getJidNumber(b)
    return Boolean(numberA && numberB && numberA === numberB)
}

function isOwnerControlMessage(msg, senderJid, from) {
    if (msg?.key?.fromMe) return true

    const ownerJid = getOwnerControlJid()
    const ownerNumber = getJidNumber(ownerJid)
    if (!ownerNumber) return false

    return getJidNumber(senderJid) === ownerNumber || getJidNumber(from) === ownerNumber
}

function pruneBotSentMessageIds(now = Date.now()) {
    for (const [id, seenAt] of botSentMessageIds) {
        if (now - seenAt > BOT_SENT_MESSAGE_TTL_MS) botSentMessageIds.delete(id)
    }
}

function rememberBotSentMessage(sentMsg) {
    const id = sentMsg?.key?.id
    if (!id) return

    const now = Date.now()
    pruneBotSentMessageIds(now)
    botSentMessageIds.set(id, now)
}

function rememberBotSentMessagePayload(sentMsg, targetJid, content, options) {
    const id = sentMsg?.key?.id
    if (!id) return

    const now = Date.now()
    pruneBotSentMessageIds(now)
    botSentMessageIds.set(id, now)
    botSentMessagePayloads.set(id, {
        targetJid,
        content,
        options,
        seenAt: now,
        retried: false,
    })

    for (const [key, value] of botSentMessagePayloads) {
        if (!value?.seenAt || now - value.seenAt > BOT_SENT_MESSAGE_TTL_MS) {
            botSentMessagePayloads.delete(key)
        }
    }
}

function isBotGeneratedMessage(msg) {
    const id = msg?.key?.id
    if (!id) return false

    pruneBotSentMessageIds()
    return botSentMessageIds.has(id)
}

function isBotSentMessageId(id) {
    if (!id) return false

    pruneBotSentMessageIds()
    return botSentMessageIds.has(id)
}

async function retryFailedLidSendViaAlias(sock, update) {
    const id = update?.key?.id
    const remoteJid = update?.key?.remoteJid
    const status = update?.update?.status ?? update?.status

    if (!id || !isLidJid(remoteJid) || !isFailedSendStatus(status)) return false

    const payload = botSentMessagePayloads.get(id)
    if (!payload || payload.retried) return false

    const aliasJid = lidAliasStore.resolveBestJid(remoteJid)
    if (!aliasJid || aliasJid === remoteJid || !isPrivatePnJid(aliasJid)) return false

    const content = payload.content || {}
    if (content.delete || content.react || content.edit) return false

    payload.retried = true
    console.log("[LID SEND] Status 0, kirim ulang via PN alias", {
        failedMessageId: id,
        lid: remoteJid,
        aliasJid,
        originalTargetJid: payload.targetJid,
        contentTypes: Object.keys(content),
    })

    await preparePrivateSendTarget(sock, aliasJid, "status-0-retry-alias")
    await sock.sendMessage(aliasJid, content, {
        ...(payload.options || {}),
        quoted: undefined,
        useUserDevicesCache: false,
    })
    return true
}

function getIncomingMessageDedupeKeys(msg) {
    const key = msg?.key || {}
    const id = String(key.id || "").trim()
    if (!id) return []

    const remoteJids = [key.remoteJid, key.remoteJidAlt]
        .map(item => String(item || "").trim())
        .filter(Boolean)
    const participants = [key.participant, key.participantAlt, msg?.participant]
        .map(item => String(item || "").trim())
        .filter(Boolean)

    const keys = new Set([`id:${id}`])
    for (const remoteJid of remoteJids) {
        keys.add(`${remoteJid}:${id}`)
        for (const participant of participants) {
            keys.add(`${remoteJid}:${participant}:${id}`)
        }
    }

    return [...keys]
}

function pruneProcessedIncomingMessages(now = Date.now()) {
    for (const [key, seenAt] of processedIncomingMessageIds) {
        if (now - seenAt > PROCESSED_INCOMING_MESSAGE_TTL_MS) {
            processedIncomingMessageIds.delete(key)
        }
    }

    while (processedIncomingMessageIds.size > PROCESSED_INCOMING_MESSAGE_MAX_SIZE) {
        const oldestKey = processedIncomingMessageIds.keys().next().value
        if (!oldestKey) break
        processedIncomingMessageIds.delete(oldestKey)
    }
}

function markIncomingMessageProcessed(msg) {
    const keys = getIncomingMessageDedupeKeys(msg)
    if (!keys.length) return true

    const now = Date.now()
    pruneProcessedIncomingMessages(now)

    if (keys.some(key => processedIncomingMessageIds.has(key))) return false

    for (const key of keys) processedIncomingMessageIds.set(key, now)
    return true
}

function getMessageCacheKeys(key = {}) {
    const id = key.id
    if (!id) return []

    const remoteJid = key.remoteJid || ""
    const participant = key.participant || ""
    return [
        `${remoteJid}:${id}`,
        participant ? `${remoteJid}:${participant}:${id}` : null,
        id,
    ].filter(Boolean)
}

function pruneMessageContentCache(now = Date.now()) {
    for (const [cacheKey, entry] of messageContentCache) {
        if (!entry?.message || now - entry.seenAt > MESSAGE_CONTENT_CACHE_TTL_MS) {
            messageContentCache.delete(cacheKey)
        }
    }

    while (messageContentCache.size > MESSAGE_CONTENT_CACHE_MAX_SIZE) {
        const oldestKey = messageContentCache.keys().next().value
        if (!oldestKey) break
        messageContentCache.delete(oldestKey)
    }
}

function rememberMessageContent(msg) {
    const message = msg?.message
    const key = msg?.key
    if (!hasMessageContent(msg) || !key?.id) return

    const now = Date.now()
    pruneMessageContentCache(now)
    for (const cacheKey of getMessageCacheKeys(key)) {
        messageContentCache.set(cacheKey, { message, seenAt: now })
    }
}

async function getCachedMessageContent(key) {
    pruneMessageContentCache()
    for (const cacheKey of getMessageCacheKeys(key)) {
        const entry = messageContentCache.get(cacheKey)
        if (entry?.message) return entry.message
    }
    return undefined
}

function getMessageTypeKeys(msg) {
    return Object.keys(msg?.message || {})
}

function hasMessageContent(msg) {
    return getMessageTypeKeys(msg).length > 0
}

function isGroupJid(jid) {
    return String(jid || "").endsWith("@g.us")
}

function getBotUserJid(sock) {
    const id = String(sock?.user?.id || "").split(":")[0]
    if (!id) return null
    return id.includes("@") ? id : `${id}@s.whatsapp.net`
}

function getMessageRemoteJid(msg) {
    return msg?.key?.remoteJid || msg?.key?.remoteJidAlt || ""
}

function getMessageSenderJid(msg, sock) {
    const remoteJid = getMessageRemoteJid(msg)
    const key = msg?.key || {}

    if (isGroupJid(remoteJid)) {
        if (key.fromMe) return getBotUserJid(sock) || key.participantAlt || key.participant || msg?.participant || remoteJid
        return key.participantAlt || key.participant || msg?.participant || remoteJid
    }

    if (key.fromMe) return getBotUserJid(sock) || key.participantAlt || key.participant || remoteJid
    return key.remoteJidAlt || remoteJid
}

function normalizeIncomingMessage(msg, sock) {
    if (process.env.ANTI_TOXIC_DEBUG === "true") {
        console.log("[LID DEBUG INCOMING]", {
            id: msg?.key?.id,
            remoteJid: msg?.key?.remoteJid,
            remoteJidAlt: msg?.key?.remoteJidAlt,
            participant: msg?.key?.participant,
            participantAlt: msg?.key?.participantAlt,
            fromMe: msg?.key?.fromMe,
        })
    }

    if (!msg?.key?.remoteJid && msg?.key?.remoteJidAlt) {
        msg.key.remoteJid = msg.key.remoteJidAlt
    }
    if (!msg?.key?.remoteJid) return msg

    const remoteJid = msg.key.remoteJid
    if (isBroadcastJid(remoteJid) || isNewsletterJid(remoteJid)) return msg

    const senderJid = getMessageSenderJid(msg, sock)
    if (!msg.key.participant || (isGroupJid(remoteJid) && isGroupJid(msg.key.participant))) {
        msg.key.participant = senderJid
    }
    if (!msg.participant && senderJid) msg.participant = senderJid

    return msg
}

function waitMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function withSendTimeout(promise, timeoutMs, label) {
    let timer
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`${label} timeout after ${timeoutMs}ms`)
            error.code = "GROUP_SEND_TIMEOUT"
            reject(error)
        }, timeoutMs)
    })

    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer)
    })
}

function getErrorStatusCode(error) {
    const candidates = [
        error?.data,
        error?.statusCode,
        error?.code,
        error?.output?.statusCode,
        error?.output?.payload?.statusCode,
        error?.data?.statusCode,
    ]

    for (const value of candidates) {
        const numeric = Number(value)
        if (Number.isFinite(numeric)) return numeric
    }

    return null
}

function isFailedSendStatus(status) {
    return Number(status) === 0 || String(status || "").toLowerCase() === "error"
}

function shouldFallbackOnNoLidStatus() {
    return !/^(0|false|off|no)$/i.test(String(process.env.LID_SEND_FALLBACK_ON_NO_STATUS || "true").trim())
}

function waitForSentMessageStatus(sock, sent, timeoutMs = LID_SEND_STATUS_WAIT_MS) {
    const messageId = sent?.key?.id
    if (!messageId || !sock?.ev || typeof sock.ev.on !== "function" || timeoutMs <= 0) {
        return Promise.resolve(null)
    }

    return new Promise(resolve => {
        let done = false
        const finish = value => {
            if (done) return
            done = true
            clearTimeout(timer)

            if (typeof sock.ev.off === "function") {
                sock.ev.off("messages.update", handler)
            } else if (typeof sock.ev.removeListener === "function") {
                sock.ev.removeListener("messages.update", handler)
            }

            resolve(value)
        }

        const handler = updates => {
            for (const item of updates || []) {
                if (item?.key?.id !== messageId) continue

                finish({
                    status: item?.update?.status ?? item?.status,
                    updateKeys: Object.keys(item?.update || {}),
                    remoteJid: item?.key?.remoteJid,
                    fromMe: item?.key?.fromMe,
                    participant: item?.key?.participant,
                })
                return
            }
        }

        const timer = setTimeout(() => finish(null), timeoutMs)
        if (typeof timer.unref === "function") timer.unref()
        sock.ev.on("messages.update", handler)
    })
}

function isRateLimitError(error) {
    if (getErrorStatusCode(error) === 429) return true

    const message = String(error?.message || error?.output?.payload?.message || "").toLowerCase()
    return message.includes("rate-overlimit")
        || message.includes("rate limit")
        || message.includes("too many requests")
}

function pruneGroupMetadataCache(now = Date.now()) {
    for (const [jid, entry] of groupMetadataCache) {
        if (!entry?.cachedAt || now - entry.cachedAt > GROUP_METADATA_STALE_TTL_MS) {
            groupMetadataCache.delete(jid)
        }
    }

    while (groupMetadataCache.size > GROUP_METADATA_CACHE_MAX_SIZE) {
        const oldestJid = groupMetadataCache.keys().next().value
        if (!oldestJid) break
        groupMetadataCache.delete(oldestJid)
    }
}

function rememberGroupMetadata(jid, metadata) {
    const normalizedJid = String(jid || "").trim()
    if (!isGroupJid(normalizedJid) || !Array.isArray(metadata?.participants)) return metadata

    const entry = {
        metadata,
        cachedAt: Date.now(),
    }
    groupMetadataCache.set(normalizedJid, entry)
    pruneGroupMetadataCache(entry.cachedAt)
    return metadata
}

function getCachedGroupMetadata(jid, maxAgeMs = GROUP_METADATA_CACHE_TTL_MS) {
    const normalizedJid = String(jid || "").trim()
    if (!isGroupJid(normalizedJid)) return null

    const entry = groupMetadataCache.get(normalizedJid)
    if (!entry?.metadata || !entry?.cachedAt) return null

    return Date.now() - entry.cachedAt <= maxAgeMs ? entry.metadata : null
}

function clearGroupMetadataCache(jid, reason = "update") {
    const normalizedJid = String(jid || "").trim()
    if (!isGroupJid(normalizedJid)) return

    if (groupMetadataCache.delete(normalizedJid)) {
        console.log(`[GROUP META] Cache metadata ${normalizedJid} dihapus (${reason})`)
    }
}

function installGroupMetadataCache(sock) {
    if (!sock || sock.__groupMetadataCacheInstalled || typeof sock.groupMetadata !== "function") return

    const originalGroupMetadata = sock.groupMetadata.bind(sock)
    sock.groupMetadata = async function cachedGroupMetadata(jid) {
        const normalizedJid = String(jid || "").trim()
        if (!isGroupJid(normalizedJid)) return originalGroupMetadata(jid)

        const cached = getCachedGroupMetadata(normalizedJid)
        if (cached) return cached

        try {
            const metadata = await originalGroupMetadata(normalizedJid)
            return rememberGroupMetadata(normalizedJid, metadata)
        } catch (error) {
            const stale = getCachedGroupMetadata(normalizedJid, GROUP_METADATA_STALE_TTL_MS)
            if (stale && isRateLimitError(error)) {
                console.log(`[GROUP META] Pakai cache stale untuk ${normalizedJid} karena rate-overlimit`)
                return stale
            }
            throw error
        }
    }

    sock.__groupMetadataCacheInstalled = true
    console.log("[GROUP META] Cache metadata grup aktif")
}

function installGroupMetadataCacheInvalidation(sock) {
    if (!sock?.ev || sock.__groupMetadataCacheInvalidationInstalled) return

    sock.ev.on("groups.update", (updates = []) => {
        for (const update of updates || []) clearGroupMetadataCache(update?.id, "groups.update")
    })

    sock.ev.on("group-participants.update", (update = {}) => {
        clearGroupMetadataCache(update?.id, "group-participants.update")
    })

    sock.__groupMetadataCacheInvalidationInstalled = true
}

function installPhoneNumberAliasTracker(sock) {
    if (!sock?.ev || sock.__phoneNumberAliasTrackerInstalled) return

    sock.ev.on("chats.phoneNumberShare", ({ lid, jid } = {}) => {
        try {
            const result = lidAliasStore.rememberAlias(lid, jid, {
                source: "chats.phoneNumberShare",
            })
            console.log("[LID ALIAS] phoneNumberShare", {
                lid,
                jid,
                saved: result?.saved,
                reason: result?.reason,
            })
        } catch (error) {
            console.log("[LID ALIAS] Gagal simpan phoneNumberShare", {
                lid,
                jid,
                errorMessage: error.message,
            })
        }

        try {
            const result = antiToxicReflectionConfig.rememberUserAliases(lid, jid)
            if (result?.saved && process.env.ANTI_TOXIC_REFLECTION_ALIAS_DEBUG === "true") {
                console.log("[ANTI-TOXIC RENUNGAN] Alias nomor tersimpan dari phoneNumberShare", {
                    lid,
                    jid,
                    aliases: result.aliases,
                    linkedProfile: result.linkedProfile,
                })
            }
        } catch (error) {
            console.log("[ANTI-TOXIC RENUNGAN] Gagal simpan alias phoneNumberShare", {
                lid,
                jid,
                errorMessage: error.message,
            })
        }
    })

    sock.ev.on("contacts.update", (updates = []) => {
        for (const contact of updates || []) {
            try {
                const lidCandidates = [
                    contact?.lid,
                    contact?.id,
                    contact?.jid,
                ].filter(jid => isLidJid(jid))

                const pnCandidates = [
                    contact?.phoneNumber,
                    contact?.notify,
                    contact?.verifiedName,
                    contact?.id,
                    contact?.jid,
                ].filter(jid => isPrivatePnJid(jid))

                for (const lid of lidCandidates) {
                    lidAliasStore.rememberSeenLid(lid, {
                        source: "contacts.update",
                        pushName: contact?.name || contact?.notify || "",
                    })

                    for (const pn of pnCandidates) {
                        lidAliasStore.rememberAlias(lid, pn, {
                            source: "contacts.update",
                            pushName: contact?.name || contact?.notify || "",
                        })
                    }
                }
            } catch (error) {
                console.log("[LID ALIAS] Gagal proses contacts.update", {
                    id: contact?.id,
                    jid: contact?.jid,
                    errorMessage: error.message,
                })
            }
        }
    })

    sock.__phoneNumberAliasTrackerInstalled = true
}

function isMissingSessionError(error) {
    const message = String(error?.message || error?.name || "").toLowerCase()
    const stack = String(error?.stack || "").toLowerCase()

    return message.includes("no sessions")
        || message.includes("invalid prekey")
        || message.includes("prekey")
        || stack.includes("session_cipher")
        || stack.includes("session_builder")
}

function getParticipantJidsFromMetadata(metadata) {
    if (!Array.isArray(metadata?.participants)) return []

    return [...new Set(metadata.participants
        .map(item => item?.phoneNumber || item?.id || item?.jid || item)
        .filter(value => typeof value === "string" && value.includes("@"))
        .filter(value => !isGroupJid(value) && !isBroadcastJid(value) && !isNewsletterJid(value)))]
}

function isUserChatJid(jid) {
    const value = String(jid || "").trim().toLowerCase()
    return value.endsWith("@s.whatsapp.net") || value.endsWith("@lid")
}

async function repairGroupSessionsBeforeRetry(sock, jid) {
    if (!isGroupJid(jid)) return

    console.log(`[GROUP SEND] Repair session grup ${jid}: refresh metadata, sessions, dan sender-key`)

    try {
        clearGroupMetadataCache(jid, "missing-session")
        const metadata = await sock.groupMetadata(jid)
        const participantJids = getParticipantJidsFromMetadata(metadata)

        if (participantJids.length && typeof sock.assertSessions === "function") {
            await sock.assertSessions(participantJids, true)
            console.log(`[GROUP SEND] assertSessions selesai untuk ${participantJids.length} peserta ${jid}`)
        }
    } catch (error) {
        console.log("[GROUP SEND] Gagal repair assertSessions grup", {
            remoteJid: jid,
            errorMessage: error.message,
            errorCode: getErrorStatusCode(error) || error?.code || "unknown",
        })
    }

    try {
        await sock?.authState?.keys?.set?.({ "sender-key-memory": { [jid]: null } })
        console.log(`[GROUP SEND] sender-key-memory ${jid} dibersihkan setelah No sessions`)
    } catch (error) {
        console.log(`[GROUP SEND] Gagal bersihkan sender-key-memory ${jid}: ${error.message}`)
    }
}

async function repairPrivateSessionBeforeRetry(sock, jid) {
    if (!isUserChatJid(jid)) return

    console.log(`[PRIVATE SEND] Repair session ${jid}: force assertSessions`)
    try {
        if (typeof sock.assertSessions === "function") {
            await sock.assertSessions([jid], true)
            console.log(`[PRIVATE SEND] assertSessions selesai untuk ${jid}`)
        }
    } catch (error) {
        console.log("[PRIVATE SEND] Gagal repair assertSessions", {
            remoteJid: jid,
            errorMessage: error.message,
            errorCode: getErrorStatusCode(error) || error?.code || "unknown",
        })
    }
}

async function preparePrivateSendTarget(sock, jid, reason = "private-send") {
    if (!isUserChatJid(jid)) return

    try {
        if (typeof sock.updateBlockStatus === "function") {
            await sock.updateBlockStatus(jid, "unblock")
            console.log("[PRIVATE SEND] Native unblock dipaksa sebelum kirim", { jid, reason })
        }
    } catch (error) {
        console.log("[PRIVATE SEND] Native unblock gagal/diabaikan", {
            jid,
            reason,
            errorMessage: error.message,
            errorCode: getErrorStatusCode(error) || error?.code || "unknown",
        })
    }

    await repairPrivateSessionBeforeRetry(sock, jid)
}

async function warmUpGroupMetadata(sock) {
    if (String(process.env.WA_GROUP_WARMUP || "true").trim().toLowerCase() === "false") return
    if (typeof sock?.groupFetchAllParticipating !== "function") return

    try {
        const groups = await sock.groupFetchAllParticipating()
        const entries = Object.entries(groups || {})
        for (const [jid, metadata] of entries) rememberGroupMetadata(jid, metadata)
        console.log(`[GROUP META] Warm-up metadata ${entries.length} grup selesai`)
    } catch (error) {
        console.log("[GROUP META] Warm-up metadata grup gagal", {
            errorMessage: error.message,
            errorCode: getErrorStatusCode(error) || error?.code || "unknown",
        })
    }
}

async function sendMessageWithSessionRepair(sock, originalSendMessage, jid, content, options = {}) {
    try {
        return await originalSendMessage(jid, content || {}, options || {})
    } catch (error) {
        if (!isMissingSessionError(error)) throw error

        if (isGroupJid(jid)) {
            await repairGroupSessionsBeforeRetry(sock, jid)
            await waitMs(Number(process.env.GROUP_SESSION_REPAIR_DELAY_MS || 1500))
            return originalSendMessage(jid, content || {}, {
                ...(options || {}),
                useUserDevicesCache: false,
                useCachedGroupMetadata: false,
            })
        }

        await repairPrivateSessionBeforeRetry(sock, jid)
        await waitMs(Number(process.env.PRIVATE_SESSION_REPAIR_DELAY_MS || 1000))
        return originalSendMessage(jid, content || {}, {
            ...(options || {}),
            useUserDevicesCache: false,
        })
    }
}

async function sendPrivateMessageWithLidFallback(sock, originalSendMessage, originalJid, jid, content, options = {}) {
    const isAliasRoute = isLidJid(originalJid) && jid !== originalJid && isPrivatePnJid(jid)
    if (!isAliasRoute) return sendMessageWithSessionRepair(sock, originalSendMessage, jid, content, options)

    console.log("[LID SEND] Coba kirim via PN alias", {
        lid: originalJid,
        pn: jid,
        contentType: Object.keys(content || {})[0] || "unknown",
    })

    try {
        await preparePrivateSendTarget(sock, jid, "lid-alias-primary")
        const sendOptions = {
            ...(options || {}),
            useUserDevicesCache: false,
        }
        const sent = await sendMessageWithSessionRepair(sock, originalSendMessage, jid, content, sendOptions)
        const statusInfo = await waitForSentMessageStatus(sock, sent)

        console.log("[LID SEND] Status kirim via PN alias", {
            lid: originalJid,
            pn: jid,
            sentMessageId: sent?.key?.id,
            sentRemoteJid: sent?.key?.remoteJid,
            status: statusInfo?.status ?? null,
            updateKeys: statusInfo?.updateKeys || [],
        })

        if (statusInfo && !isFailedSendStatus(statusInfo.status)) return sent
        if (!statusInfo && !shouldFallbackOnNoLidStatus()) return sent

        console.log("[LID SEND] Retry PN alias setelah status gagal/no-status", {
            lid: originalJid,
            pn: jid,
            reason: statusInfo ? `status-${statusInfo.status}` : "no-status-update",
        })
        await preparePrivateSendTarget(sock, jid, "lid-alias-status-retry")
        const retryPn = await sendMessageWithSessionRepair(sock, originalSendMessage, jid, content, {
            ...sendOptions,
            useUserDevicesCache: false,
        })
        const retryStatus = await waitForSentMessageStatus(sock, retryPn)
        console.log("[LID SEND] Status retry PN alias", {
            lid: originalJid,
            pn: jid,
            sentMessageId: retryPn?.key?.id,
            status: retryStatus?.status ?? null,
            updateKeys: retryStatus?.updateKeys || [],
        })

        if (retryStatus && !isFailedSendStatus(retryStatus.status)) return retryPn

        console.log("[LID SEND] Fallback terakhir kirim via LID asli", {
            lid: originalJid,
            pn: jid,
            reason: retryStatus ? `retry-status-${retryStatus.status}` : "retry-no-status",
        })
        await preparePrivateSendTarget(sock, originalJid, "lid-final-fallback")
        return sendMessageWithSessionRepair(sock, originalSendMessage, originalJid, content, {
            ...(options || {}),
            useUserDevicesCache: false,
        })
    } catch (error) {
        console.log("[LID SEND] Kirim via PN alias gagal, fallback ke LID asli", {
            lid: originalJid,
            pn: jid,
            errorMessage: error.message,
            errorCode: getErrorStatusCode(error) || error?.code || "unknown",
        })
        await preparePrivateSendTarget(sock, originalJid, "lid-error-fallback")
        return sendMessageWithSessionRepair(sock, originalSendMessage, originalJid, content, {
            ...(options || {}),
            useUserDevicesCache: false,
        })
    }
}

async function sendGroupMessageSafely(sock, originalSendMessage, jid, content, options = {}) {
    // Mode grup dibuat seperti PrimonProto: serahkan proses group relay,
    // quoted, sender-key, retry, dan metadata ke Baileys bawaan.
    return sendMessageWithSessionRepair(sock, originalSendMessage, jid, content, options)
}

function wrapSendMessageForGroups(sock) {
    if (!sock || sock.__sendMessageGroupsWrapped || typeof sock.sendMessage !== "function") return

    const originalSendMessage = sock.sendMessage.bind(sock)
    
    sock.sendMessage = async function wrappedSendMessage(jid, content, options) {
        // Normalize arguments
        jid = String(jid || "").trim()
        options = options || {}
        content = content || {}
        const securityPayloadRoute = securityMediaLog.getSecurityPayloadRoute(content)
        if (securityPayloadRoute && !securityMediaLog.isSecurityLogChat(jid)) {
            console.log("[SECURITY LOG ROUTE] Legacy outbound dialihkan ke grup log.", {
                type: securityPayloadRoute.type,
                build: securityMediaLog.SECURITY_LOG_BUILD,
            })
            jid = securityPayloadRoute.targetJid
            options = { ...options }
            delete options.quoted
        }
        const skipLidAliasResolve = options.__skipLidAliasResolve === true
        if (skipLidAliasResolve) {
            options = { ...options }
            delete options.__skipLidAliasResolve
        }
        const originalJid = jid
        jid = skipLidAliasResolve ? jid : resolveOutgoingPrivateJid(jid)
        
        if (!jid) {
            console.log("[GROUP SEND WRAPPER] JID kosong, skip wrapper")
            return originalSendMessage(jid, content, options)
        }

        // Route group messages ke direct handler ala PrimonProto.
        if (isGroupJid(jid)) {
            try {
                return await sendGroupMessageSafely(sock, originalSendMessage, jid, content, options)
            } catch (error) {
                console.log("[GROUP SEND] Direct group send gagal", {
                    remoteJid: jid,
                    contentType: Object.keys(content || {})[0] || "unknown",
                    hadQuoted: Boolean(options?.quoted),
                    errorMessage: error.message,
                    errorCode: getErrorStatusCode(error) || error?.code || "unknown",
                })
                throw error
            }
        }
        
        try {
            return await sendPrivateMessageWithLidFallback(sock, originalSendMessage, originalJid, jid, content, options)
        } catch (error) {
            console.log("[PRIVATE SEND] Kirim pesan gagal", {
                remoteJid: jid,
                originalJid,
                contentType: Object.keys(content || {})[0] || "unknown",
                hadQuoted: Boolean(options?.quoted),
                errorMessage: error.message,
                errorCode: getErrorStatusCode(error) || error?.code || "unknown",
            })
            throw error
        }
    }

    sock.__sendMessageGroupsWrapped = true
    console.log("[GROUP SEND WRAPPER] Mode grup Primon/direct aktif")
}

function wrapSendMessageTracker(sock) {
    if (!sock || sock.__sendMessageTrackerWrapped || typeof sock.sendMessage !== "function") return

    const originalSendMessage = sock.sendMessage.bind(sock)
    sock.sendMessage = async (jid, content, options = {}) => {
        const sentMsg = await originalSendMessage(jid, content, options)
        try {
            rememberBotSentMessagePayload(sentMsg, jid, content, options)
            rememberMessageContent(sentMsg)

            if (process.env.WA_LOG_BOT_SENT_TRACKER === "true") {
                console.log("[BOT SENT TRACKER]", {
                    id: sentMsg?.key?.id,
                    remoteJid: sentMsg?.key?.remoteJid,
                    fromMe: sentMsg?.key?.fromMe,
                    targetJid: jid,
                    contentTypes: Object.keys(content || {}),
                })
            }
        } catch (error) {
            console.log("[BOT SENT TRACKER] gagal track send", {
                targetJid: jid,
                errorMessage: error.message,
            })
        }
        return sentMsg
    }

    sock.__sendMessageTrackerWrapped = true
    console.log("[BOT SENT TRACKER] aktif")
}
function clearFollowUpTimers() {
    for (const timeout of followUpTracker.values()) clearTimeout(timeout)
    followUpTracker.clear()
}

function clearFollowUpFor(jid) {
    const timeout = followUpTracker.get(jid)
    if (timeout) clearTimeout(timeout)
    followUpTracker.delete(jid)
}

function cleanupSocket(sock) {
    stopBroadcastScheduler()
    try {
        reactionWorkflow.disposeReactionWorkflow(sock)
    } catch {}
    try {
        messageEditGuardian.disposeMessageEditGuardian()
    } catch {}
    try {
        const ocrDispose = antiToxicStickerOcr.disposeAntiToxicStickerOcr()
        if (ocrDispose && typeof ocrDispose.catch === "function") {
            ocrDispose.catch(error => {
                console.log(`[ANTI TOXIC OCR] Dispose failed: ${String(error.message || error).slice(0, 300)}`)
            })
        }
    } catch {}
    try {
        callHandler.disposeCallHandler(sock)
    } catch {}
    try {
        mediaCleanupManager.dispose?.()
    } catch {}
    try {
        const stickerSafetyDispose = stickerSafetyGuard.disposeStickerSafety?.()
        if (stickerSafetyDispose && typeof stickerSafetyDispose.catch === "function") {
            stickerSafetyDispose.catch(error => {
                console.log(`[STICKER SAFETY] Gagal dispose: ${error.message}`)
            })
        }
    } catch {}

    const events = ["messages.upsert", "messages.update", "messages.reaction", "connection.update", "creds.update", "call", "groups.update", "group-participants.update", "chats.phoneNumberShare", "contacts.update"]
    for (const eventName of events) {
        try {
            if (typeof sock.ev.removeAllListeners === "function") {
                sock.ev.removeAllListeners(eventName)
            }
        } catch {}
    }

    try {
        if (sock.ws && typeof sock.ws.close === "function") sock.ws.close()
    } catch {}
}

function scheduleReconnect(reason) {
    if (reconnectTimer) return

    const delay = Math.min(
        RECONNECT_MAX_DELAY_MS,
        RECONNECT_BASE_DELAY_MS * Math.max(1, reconnectAttempts + 1)
    )

    reconnectAttempts += 1
    console.log(`[RECONNECT] Coba lagi dalam ${Math.round(delay / 1000)} detik${reason ? ` (${reason})` : ""}.`)

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        startBot().catch((error) => {
            console.log(`[RECONNECT] Gagal start bot: ${error.message}`)
            scheduleReconnect(error.message)
        })
    }, delay)
}

// CRM
const crmFile = "./crm.json"
if (!fs.existsSync(crmFile)) fs.writeFileSync(crmFile, JSON.stringify([]))

async function imageToPdf(buffer, mimeType) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ autoFirstPage: false, margin: 20 })
        const chunks = []
        doc.on("data", chunk => chunks.push(chunk))
        doc.on("end", () => resolve(Buffer.concat(chunks)))
        doc.on("error", reject)

        const img = doc.openImage(buffer)
        doc.addPage({ size: [img.width, img.height], margin: 0 })
        doc.image(buffer, 0, 0, { width: img.width, height: img.height })
        doc.end()
    })
}

// ===== HELPER: SEND MESSAGE DAN AUTO DELETE =====
async function sendAndDelete(sock, jid, messageObj, delayMs = 0) {
    try {
        const sentMsg = await sock.sendMessage(jid, messageObj);
        
        if (delayMs > 0) {
            setTimeout(async () => {
                try {
                    await messageCleaner.deleteMessageObject(sock, jid, sentMsg, "pesan auto-delete");
                    console.log(`🗑️ [Auto-Delete] Pesan status berhasil dihapus`);
                } catch (err) {
                    console.log(`⚠️ [Auto-Delete] Gagal hapus pesan: ${err.message}`);
                }
            }, delayMs);
        }
        return sentMsg;
    } catch (error) {
        console.log(`❌ [Send Message Error]: ${error.message}`);
        return null;
    }
}

function saveRestartNotice(jid, messageOrKey) {
    const key = messageOrKey?.key || messageOrKey
    if (!jid || !key?.id) return

    try {
        fs.mkdirSync(path.dirname(RESTART_NOTICE_PATH), { recursive: true })
        fs.writeFileSync(RESTART_NOTICE_PATH, JSON.stringify({
            jid,
            key: {
                ...key,
                remoteJid: key.remoteJid || jid,
            },
            savedAt: Date.now(),
        }, null, 2))
    } catch (error) {
        console.log(`[RESTART] Gagal menyimpan data pesan restart: ${error.message}`)
    }
}

function consumeRestartNotice() {
    try {
        if (!fs.existsSync(RESTART_NOTICE_PATH)) return null
        const notice = JSON.parse(fs.readFileSync(RESTART_NOTICE_PATH, "utf8"))
        fs.unlinkSync(RESTART_NOTICE_PATH)
        if (!notice?.jid || !notice?.key?.id) return null
        return notice
    } catch (error) {
        console.log(`[RESTART] Gagal membaca data pesan restart: ${error.message}`)
        return null
    }
}

function hasRestartNotice() {
    try {
        return fs.existsSync(RESTART_NOTICE_PATH)
    } catch {
        return false
    }
}

async function editMessageText(sock, jid, key, text, label = "pesan") {
    if (!jid || !key?.id || !text) return false

    const editKey = {
        ...key,
        remoteJid: key.remoteJid || jid,
    }

    try {
        await withSendTimeout(
            sock.sendMessage(jid, { text, edit: editKey }),
            RESTART_SEND_TIMEOUT_MS,
            `edit ${label}`
        )
        return true
    } catch (error) {
        console.log(`[RESTART] Gagal edit ${label}`, {
            jid,
            messageId: key.id,
            errorMessage: error.message,
            statusCode: error?.output?.statusCode || error?.statusCode || error?.data?.statusCode || error?.code,
        })
        return false
    }
}

async function showHelpAfterRestart(sock) {
    const notice = consumeRestartNotice()
    if (!notice) return

    const age = Date.now() - Number(notice.savedAt || 0)
    if (age > 10 * 60 * 1000) {
        console.log("[RESTART] Abaikan pesan restart lama.")
        return
    }

    const activeText = typeof activeNotifier.getActiveText === "function"
        ? activeNotifier.getActiveText()
        : "✅ *USERBOT FAHRI AKTIF*\n\nBot sudah tersambung ke WhatsApp."

    if (!await editMessageText(sock, notice.jid, notice.key, activeText, "pesan restart menjadi aktif")) {
        try {
            await withSendTimeout(
                sock.sendMessage(notice.jid, { text: activeText }),
                RESTART_SEND_TIMEOUT_MS,
                "send aktif setelah restart"
            )
            console.log("[RESTART] Notifikasi aktif dikirim sebagai fallback setelah restart.")
        } catch (error) {
            console.log("[RESTART] Gagal kirim notifikasi aktif setelah restart", {
                jid: notice.jid,
                errorMessage: error.message,
                statusCode: error?.output?.statusCode || error?.statusCode || error?.data?.statusCode || error?.code,
            })
        }
        return
    }

    console.log("[RESTART] Pesan restart diedit menjadi notifikasi aktif.")

    if (!shouldEditActiveNoticeToHelp()) {
        return
    }

    await waitMs(Math.max(0, RESTART_HELP_EDIT_DELAY_MS))

    const helpText = help.generateHelpMenu()

    if (await editMessageText(sock, notice.jid, notice.key, helpText, "notifikasi aktif menjadi help menu")) {
        console.log("[RESTART] Notifikasi aktif diedit menjadi help menu.")
        return
    }

    try {
        await withSendTimeout(
            sock.sendMessage(notice.jid, { text: helpText }),
            RESTART_SEND_TIMEOUT_MS,
            "send help setelah restart"
        )
        console.log("[RESTART] Help menu dikirim sebagai fallback setelah restart.")
    } catch (error) {
        console.log("[RESTART] Gagal kirim help menu setelah restart", {
            jid: notice.jid,
            errorMessage: error.message,
            statusCode: error?.output?.statusCode || error?.statusCode || error?.data?.statusCode || error?.code,
        })
    }
}

function getRestartReplyJid(from) {
    if (!from || isBroadcastJid(from) || isNewsletterJid(from)) return getOwnerControlJid()
    if (isGroupJid(from)) {
        const ownerJid = getOwnerControlJid()
        console.log(`[RESTART] Command restart dari grup (${from}), notifikasi diarahkan ke owner: ${ownerJid || "-"}`)
        return ownerJid || from
    }
    if (isLidJid(from)) {
        const ownerJid = getOwnerControlJid()
        console.log(`[RESTART] Remote JID berupa LID (${from}), balasan restart diarahkan ke owner: ${ownerJid || "-"}`)
        return ownerJid || from
    }
    return from
}

async function sendRestartNotice(sock, jid) {
    if (!jid) return null

    const message = {
        text: RESTART_WAIT_TEXT
    }

    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            const sentMsg = await withSendTimeout(
                sock.sendMessage(jid, message),
                RESTART_SEND_TIMEOUT_MS,
                "restart notice"
            )

            if (sentMsg?.key?.id) {
                saveRestartNotice(jid, sentMsg)
            } else {
                console.log("[RESTART] Notifikasi restart terkirim, tapi Baileys tidak mengembalikan key pesan.")
            }

            return sentMsg
        } catch (error) {
            console.log("[RESTART] Gagal kirim notifikasi restart", {
                jid,
                attempt,
                errorMessage: error.message,
                statusCode: error?.output?.statusCode || error?.statusCode || error?.data?.statusCode || error?.code,
                stack: error.stack,
            })

            if (attempt < 2) await waitMs(800)
        }
    }

    return null
}

async function editRestartCommandToNotice(sock, msg, jid) {
    const commandKey = msg?.key
    if (!jid || !commandKey?.id || !commandKey.fromMe) {
        return sendRestartNotice(sock, getRestartReplyJid(jid))
    }

    if (await editMessageText(sock, jid, commandKey, RESTART_WAIT_TEXT, "pesan command restart")) {
        saveRestartNotice(jid, commandKey)
        return { key: commandKey }
    }

    return sendRestartNotice(sock, getRestartReplyJid(jid))
}

async function startBot() {
    if (isStartingBot) {
        console.log("[START] Proses start bot masih berjalan, skip duplikat.")
        return
    }

    isStartingBot = true
    let state
    let saveCreds
    try {
        ({ state, saveCreds } = await useMultiFileAuthState("auth"))
    } finally {
        isStartingBot = false
    }

    if (activeSock) {
        try {
            cleanupSocket(activeSock)
            if (typeof activeSock.end === "function") activeSock.end(new Error("Replacing active socket"))
            else if (activeSock.ws && typeof activeSock.ws.close === "function") activeSock.ws.close()
        } catch (error) {
            console.log(`[START] Gagal menutup socket lama: ${error.message}`)
        } finally {
            activeSock = null
            global.sock = null
        }
    }

    let waVersion
    const pinnedVersion = String(process.env.WA_PIN_BAILEYS_VERSION || "false").trim()
    if (pinnedVersion && pinnedVersion !== "false") {
        const parsedVersion = pinnedVersion.split(".").map(part => Number(part)).filter(Number.isFinite)
        if (parsedVersion.length === 3) {
            waVersion = parsedVersion
            console.log(`[WA] Menggunakan pinned WhatsApp Web version dari env: ${waVersion.join(".")}`)
        }
    }

    if (!waVersion) {
        try {
            const latest = await fetchLatestBaileysVersion()
            waVersion = latest.version
            console.log(`[WA] Menggunakan WhatsApp Web version: ${waVersion.join(".")} | latest: ${latest.isLatest}`)
        } catch (error) {
            console.log(`[WA] Gagal mengambil latest Baileys version, pakai default bawaan package: ${error.message}`)
        }
    }

    const loginConfig = state?.creds?.registered
        ? await loginManager.resolveLoginConfig({
            env: process.env,
            state,
            ownerJid: getOwnerControlJid(),
            fallbackJids: [process.env.OWNER_JID, process.env.VIEWONCE2_OWNER_JID],
            log: (...args) => console.log(...args),
        })
        : (pendingLoginConfig || await loginManager.resolveLoginConfig({
            env: process.env,
            state,
            ownerJid: getOwnerControlJid(),
            fallbackJids: [process.env.OWNER_JID, process.env.VIEWONCE2_OWNER_JID],
            log: (...args) => console.log(...args),
        }))
    if (!state?.creds?.registered) pendingLoginConfig = loginConfig

    const sock = makeWASocket({
        auth: state,
        logger: P({ level: process.env.WA_LOG_LEVEL || "error" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        ...(waVersion ? { version: waVersion } : {}),
        markOnlineOnConnect: false,
        connectTimeoutMs: Number(process.env.WA_CONNECT_TIMEOUT_MS || 30000),
        defaultQueryTimeoutMs: Number(process.env.WA_DEFAULT_QUERY_TIMEOUT_MS || 30000),
        keepAliveIntervalMs: Number(process.env.WA_KEEP_ALIVE_INTERVAL_MS || 20000),
        emitOwnEvents: true,
        fireInitQueries: !/^(0|false|off|no)$/i.test(String(process.env.WA_FIRE_INIT_QUERIES || "true").trim()),
        printQRInTerminal: false,
        syncFullHistory: isEnvEnabled(process.env.WA_SYNC_FULL_HISTORY, false),
        generateHighQualityLinkPreview: false,
        shouldIgnoreJid: shouldIgnoreIncomingJid,
        cachedGroupMetadata: async (jid) => getCachedGroupMetadata(jid, GROUP_METADATA_STALE_TTL_MS) || undefined,
        getMessage: getCachedMessageContent,
    })

    installUnsupportedIncomingMessageFilter(sock)
    activeSock = sock
    global.sock = sock
    installGroupMetadataCache(sock)
    wrapSendMessageForGroups(sock)
    wrapSendMessageTracker(sock)
    installGroupMetadataCacheInvalidation(sock)
    installPhoneNumberAliasTracker(sock)
    reactionWorkflow.installReactionWorkflow(sock, {
        isOwnerJid,
        resolveOwnerJid: getOwnerControlJid,
        lidAliasStore,
        services: {
            bcscheduler,
            bctemplate,
            mediaCleanupManager,
            healthCheck,
            groupRemoteControl,
            broadcastSchedulerStatus: getBroadcastSchedulerRuntimeStatus,
            healthContext: {
                botStatus,
                autoReply,
                statusInbox,
                groupRemoteControl,
                antiToxic,
                antiToxicControl,
                antiToxicStickerOcr,
                stickerSafetyGuard,
                securityMediaLog,
                messageEditGuardian,
            },
        },
    })
    let credsSavePromise = Promise.resolve()
    const queueCredsSave = () => {
        credsSavePromise = credsSavePromise
            .catch(() => {})
            .then(() => saveCreds())
            .catch((error) => {
                console.log(`[AUTH] Gagal menyimpan session WhatsApp: ${error.message}`)
            })
        return credsSavePromise
    }
    const waitForCredsSave = async (label) => {
        let timedOut = false
        await Promise.race([
            credsSavePromise,
            waitMs(AUTH_SAVE_WAIT_MS).then(() => {
                timedOut = true
            }),
        ])
        if (timedOut) {
            console.log(`[AUTH] Save session masih berjalan setelah ${AUTH_SAVE_WAIT_MS}ms (${label}), lanjut reconnect.`)
        }
    }
    sock.ev.on("creds.update", queueCredsSave)
    
    // Flag untuk track status koneksi
    let isConnected = false;
    let reminderInterval = null;
    const loginRuntime = loginManager.createLoginRuntime(loginConfig, {
        env: process.env,
        qrcode,
        log: (...args) => console.log(...args),
        isActiveSocket: currentSock => activeSock === currentSock,
    })
    const postOpenTimers = new Set()
    const clearPostOpenTimers = () => {
        for (const timer of postOpenTimers) clearTimeout(timer)
        postOpenTimers.clear()
    }
    const schedulePostOpenTask = (label, delayMs, task) => {
        const delayMsClean = Math.max(0, Number(delayMs) || 0)
        if (delayMsClean > 0) {
            console.log(`[STARTUP] ${label} ditunda ${Math.round(delayMsClean / 1000)} detik supaya session baru stabil.`)
        }

        const timer = setTimeout(async () => {
            postOpenTimers.delete(timer)
            if (!isConnected || activeSock !== sock) {
                console.log(`[STARTUP] ${label} dibatalkan karena socket sudah tidak aktif.`)
                return
            }

            try {
                await task()
            } catch (error) {
                console.log(`[STARTUP] ${label} gagal: ${error.message}`)
            }
        }, delayMsClean)
        postOpenTimers.add(timer)
    }
    activeShutdownHook = async (reason) => {
        console.log(`[SHUTDOWN] Membersihkan socket WhatsApp aktif (${reason}).`)
        if (reminderInterval) {
            clearInterval(reminderInterval)
            reminderInterval = null
        }
        stopBroadcastScheduler()
        loginRuntime.dispose()
        clearPostOpenTimers()
        clearFollowUpTimers()
        await queueCredsSave()
        await waitForCredsSave(`shutdown ${reason}`)
        cleanupSocket(sock)
        if (activeSock === sock) {
            activeSock = null
            global.sock = null
        }
        if (activeShutdownHook) activeShutdownHook = null
    }

    // ===== CONNECTION STATUS HANDLER =====
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update

        await loginRuntime.handleConnectionUpdate(sock, update)

        if (connection === "open") {
            await waitForCredsSave("open")
            pendingLoginConfig = null
            isConnected = true;
            reconnectAttempts = 0;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            console.log("\n✅ Bot berhasil terhubung ke WhatsApp!\n")

            schedulePostOpenTask("warm-up metadata grup", GROUP_WARMUP_DELAY_MS, () => warmUpGroupMetadata(sock))
            
            // HANYA mulai background task setelah bot terhubung
            if (!reminderInterval) {
                console.log("🔄 Memulai mesin REMINDER OTOMATIS...")
                reminderInterval = setInterval(async () => {
                    try {
                        await reminder.checkAndSendReminders(sock);
                    } catch (error) {
                        console.log(`[Reminder] Error: ${error.message}`);
                    }
                }, 10000);
            }

            startBroadcastScheduler(sock)

            // Aktifkan handler telepon untuk socket yang sedang aktif.
            callHandler.handleCall(sock, {
                ownerJids: [getOwnerControlJid(), ...PRIORITY_USERS].filter(Boolean),
            });

            mediaCleanupManager.init(sock, {
                ownerJid: getOwnerControlJid(),
                ownerJids: [getOwnerControlJid(), ...PRIORITY_USERS].filter(Boolean),
                maxAgeHours: Number(process.env.MEDIA_CLEANUP_MAX_AGE_HOURS || 48),
                scanIntervalMs: Number(process.env.MEDIA_CLEANUP_SCAN_INTERVAL_MS || 60 * 60 * 1000),
            });

            // Kirim tanda aktif ke PM owner setelah restart / reconnect.
            const commandRestartPending = hasRestartNotice()
            const sendActiveNoticeAndHelp = async () => {
                const activeNoticePromise = commandRestartPending
                    ? Promise.resolve([])
                    : activeNotifier.notifyActive(sock, PRIORITY_USERS, { force: true })
                await activeNoticePromise
                    .catch((error) => {
                        console.log(`[ACTIVE] Error: ${error.message}`)
                        return []
                    })
                    .then(() => showHelpAfterRestart(sock))
                    .catch((error) => console.log(`[RESTART] Gagal tampilkan help setelah restart: ${error.message}`));
            }
            schedulePostOpenTask("notifikasi aktif", commandRestartPending ? 0 : ACTIVE_NOTIFY_DELAY_MS, sendActiveNoticeAndHelp)
        }

        if (connection === "close") {
            isConnected = false;
            const statusCode = getDisconnectStatusCode(lastDisconnect?.error)
            const reasonName = getDisconnectReasonName(statusCode)
            const conflictType = getDisconnectConflictType(lastDisconnect?.error)
            const shouldReconnect = ![
                DisconnectReason.loggedOut,
                DisconnectReason.forbidden,
                DisconnectReason.multideviceMismatch,
                DisconnectReason.badSession,
            ].includes(statusCode);

            console.log(`\n⚠️ Bot terputus dari WhatsApp (${statusCode || "-"} ${reasonName}${conflictType ? `, ${conflictType}` : ""})`)
            if (lastDisconnect?.error?.message) {
                console.log(`[WA DISCONNECT] ${lastDisconnect.error.message}`)
            }

            if (reminderInterval) {
                clearInterval(reminderInterval);
                reminderInterval = null;
            }
            stopBroadcastScheduler()
            loginRuntime.dispose()
            clearPostOpenTimers()
            await waitForCredsSave(`disconnect ${statusCode || "unknown"}`)
            clearFollowUpTimers();
            cleanupSocket(sock);
            const wasActiveSock = activeSock === sock
            if (wasActiveSock) {
                activeSock = null;
                global.sock = null;
            }
            if (wasActiveSock) {
                activeShutdownHook = null
            }

            if (shouldReconnect && !isProcessShuttingDown) {
                scheduleReconnect(reasonName || lastDisconnect?.error?.message);
            } else {
                if (conflictType === "device_removed") {
                    console.log("❌ WhatsApp menghapus linked device ini. Pastikan tidak ada proses bot lain yang memakai folder auth yang sama.")
                }
                if (!isProcessShuttingDown) {
                    console.log("❌ Session WhatsApp tidak valid lagi. Backup lalu hapus folder auth untuk login ulang.\n");
                }
            }
        }

        if (connection === "connecting") console.log("🔗 Menghubungkan ke WhatsApp...");
    })

    sock.ev.on("messages.update", async (updates) => {
        const ownerForwardJids = [getOwnerControlJid(), ...PRIORITY_USERS].filter(Boolean)

        for (const item of updates || []) {
            if (securityMediaLog.isSecurityLogChat(item?.key?.remoteJid) || securityMediaLog.isSecurityLogChat(item?.key?.remoteJidAlt)) continue

            try {
                if (isBotSentMessageId(item?.key?.id)) {
                    console.log("[BOT SENT UPDATE]", {
                        id: item?.key?.id,
                        remoteJid: item?.key?.remoteJid,
                        fromMe: item?.key?.fromMe,
                        participant: item?.key?.participant,
                        updateKeys: Object.keys(item?.update || {}),
                        status: item?.update?.status ?? item?.status,
                    })

                    await retryFailedLidSendViaAlias(sock, item)
                }
            } catch (error) {
                console.log("[BOT SENT UPDATE] Handler error", {
                    id: item?.key?.id,
                    remoteJid: item?.key?.remoteJid,
                    error: String(error.message || error).slice(0, 300),
                })
            }

            let viewOnceDeleteHandled = false
            try {
                viewOnceDeleteHandled = await viewonce2.handleMessageUpdate(sock, item, {
                    getMessageContent: getCachedMessageContent,
                })
            } catch (error) {
                console.log("[VIEWONCE2] Handler messages.update error", {
                    id: item?.key?.id,
                    remoteJid: item?.key?.remoteJid,
                    error: String(error.message || error).slice(0, 300),
                })
            }

            if (!viewOnceDeleteHandled) {
                try {
                    await deletedMessageNotifier.handleMessageUpdate(sock, item)
                } catch (error) {
                    console.log("[DELETE NOTIFY] Handler messages.update error", {
                        id: item?.key?.id,
                        remoteJid: item?.key?.remoteJid,
                        error: String(error.message || error).slice(0, 300),
                    })
                }
            }
        }

        try {
            await messageEditGuardian.handleMessageUpdates(updates, {
                sock,
                antiToxic,
                antiToxicControl,
                antiToxicReflectionConfig,
                groupRemoteControl,
                lidAliasStore,
                getMessage: getCachedMessageContent,
                ownerJid: getOwnerControlJid,
                routerTrace,
                isSecurityLogChat: jid => securityMediaLog.isSecurityLogChat(jid),
            })
        } catch (error) {
            console.log(`[EDIT GUARD] Failed to process message edit: ${String(error.message || error).slice(0, 300)}`)
        }
    })

    sock.ev.on("messages.upsert", async (upsert) => {
        const rawMessage = (() => {
            try {
                return typeof structuredClone === "function" ? structuredClone(upsert) : JSON.parse(JSON.stringify(upsert))
            } catch {
                return upsert
            }
        })()
        const messages = (upsert?.messages || [])
            .map(item => normalizeIncomingMessage(item, sock))
            .filter(item => !shouldIgnoreIncomingJid(item?.key?.remoteJid))
            .filter(item => !securityMediaLog.isSecurityLogChat(item?.key?.remoteJid) && !securityMediaLog.isSecurityLogChat(item?.key?.remoteJidAlt))
            .filter(Boolean)

        if (process.env.VIEWONCE_DEBUG === "true") {
            console.log("[ViewOnce DEBUG] messages.upsert", {
                count: messages.length,
                items: messages.map(item => ({
                    remoteJid: item?.key?.remoteJid,
                    id: item?.key?.id,
                    fromMe: item?.key?.fromMe,
                    participant: item?.key?.participant,
                    messageTypes: getMessageTypeKeys(item),
                })),
            })
        }

        const ownerForwardJids = [getOwnerControlJid(), ...PRIORITY_USERS].filter(Boolean)
        const skippedGlobalMessageKeys = new Set()
        const markMessageGloballySkipped = (msg) => {
            for (const key of getIncomingMessageDedupeKeys(msg)) {
                skippedGlobalMessageKeys.add(key)
            }
        }
        const isMessageGloballySkipped = (msg) => (
            getIncomingMessageDedupeKeys(msg).some(key => skippedGlobalMessageKeys.has(key))
        )
        const skippedAntiToxicMessageKeys = new Set()
        const markAntiToxicMessageSkipped = (msg) => {
            for (const key of getIncomingMessageDedupeKeys(msg)) {
                skippedAntiToxicMessageKeys.add(key)
            }
        }
        const isAntiToxicMessageSkipped = (msg) => (
            getIncomingMessageDedupeKeys(msg).some(key => skippedAntiToxicMessageKeys.has(key))
        )

        for (const item of messages || []) {
            const pipelineText = getAntiToxicPipelineText(item)
            const isMe = Boolean(item?.key?.fromMe)
            const isAntiToxicOwnerCommand = isAntiToxicOwnerCommandText(pipelineText)
            const allowFromMeTextModeration = isMe && isAntiToxicWarnOwnerEnabled()
            const shouldSkipBotGenerated = isMe
                && !isAntiToxicOwnerCommand
                && (
                    isBotGeneratedMessage(item)
                    || isAntiToxicGeneratedWarningText(pipelineText)
                )

            if (shouldSkipBotGenerated) {
                console.log("[PIPELINE] skip-bot-generated-message-global", {
                    id: item?.key?.id,
                    remoteJid: item?.key?.remoteJid,
                    fromMe: item?.key?.fromMe,
                    textPreview: pipelineText.slice(0, 120),
                    messageTypes: getMessageTypeKeys(item),
                })
                markMessageGloballySkipped(item)
                markAntiToxicMessageSkipped(item)
                continue
            }

            trackLidAliasFromMessage(item)
            if (!hasMessageContent(item)) {
                debugAntiToxicPipeline("skip-empty-message-shell", {
                    id: item?.key?.id,
                    remoteJid: item?.key?.remoteJid,
                    participant: item?.key?.participant,
                    fromMe: item?.key?.fromMe,
                    note: "Belum ada isi message, jangan masuk dedupe anti-toxic.",
                })
                continue
            }

            rememberMessageContent(item)
            try {
                messageEditGuardian.rememberOriginalMessage(item, {
                    senderJid: getMessageSenderJid(item, sock),
                    lidAliasStore,
                    isBotGenerated: isBotGeneratedMessage(item),
                })
            } catch (error) {
                console.log(`[EDIT GUARD] Failed to cache original message: ${String(error.message || error).slice(0, 300)}`)
            }

            if (isMe && !isAntiToxicOwnerCommand && !allowFromMeTextModeration) {
                console.log("[ANTI-TOXIC PIPELINE] skip-fromMe-non-command", {
                    id: item?.key?.id,
                    remoteJid: item?.key?.remoteJid,
                    participant: item?.key?.participant,
                    fromMe: item?.key?.fromMe,
                    textPreview: pipelineText.slice(0, 120),
                    messageTypes: getMessageTypeKeys(item),
                })
                continue
            }

            if (isMe && isAntiToxicSystemText(pipelineText)) {
                debugAntiToxicPipeline("skip-anti-toxic-system-from-me", {
                    id: item?.key?.id,
                    remoteJid: item?.key?.remoteJid,
                    fromMe: item?.key?.fromMe,
                    textPreview: pipelineText.slice(0, 120),
                    messageTypes: getMessageTypeKeys(item),
                })
                continue
            }
        }

        for (const item of messages || []) {
            if (isMessageGloballySkipped(item)) continue
            if (isAntiToxicMessageSkipped(item)) continue
            if (!hasMessageContent(item)) continue
            const pipelineText = getAntiToxicPipelineText(item)
            const isMe = Boolean(item?.key?.fromMe)
            const isAntiToxicOwnerCommand = isAntiToxicOwnerCommandText(pipelineText)
            const allowFromMeTextModeration = isMe && isAntiToxicWarnOwnerEnabled()
            if (isMe && !isAntiToxicOwnerCommand && !allowFromMeTextModeration) continue

            const itemFrom = item?.key?.remoteJid || ""
            const itemSenderJid = getMessageSenderJid(item, sock)
            debugAntiToxicPipeline("incoming-message", {
                id: item?.key?.id,
                remoteJid: itemFrom,
                remoteJidAlt: item?.key?.remoteJidAlt,
                participant: item?.key?.participant,
                participantAlt: item?.key?.participantAlt,
                fromMe: item?.key?.fromMe,
                senderJid: itemSenderJid,
                isGroup: isGroupJid(itemFrom),
                text: pipelineText,
                messageTypes: getMessageTypeKeys(item),
            })
        }

        // Status broadcast harus masuk cache sebelum handler lain sempat return/continue.
        for (const item of messages || []) {
            if (isMessageGloballySkipped(item)) continue
            if (!hasMessageContent(item)) continue
            if (item?.key?.remoteJid !== "status@broadcast") continue

            statusDownloader.rememberStatus(item)
            await statusInbox.rememberIncomingStatus(sock, item, { lidAliasStore })
        }

        // Fast lane view-once: buka dan cache dulu sebelum module lain mencoba
        // download media yang sama. Ini mengurangi risiko VO keburu expired/dihapus.
        for (const item of messages || []) {
            if (isMessageGloballySkipped(item)) continue
            if (!hasMessageContent(item)) continue
            try {
                await viewonce2.handleIncomingViewOnce(sock, item)
            } catch (error) {
                console.log("[VIEWONCE2] Fast lane error", {
                    id: item?.key?.id,
                    remoteJid: item?.key?.remoteJid,
                    error: String(error.message || error).slice(0, 300),
                })
            }
        }

        for (const item of messages || []) {
            if (isMessageGloballySkipped(item)) continue
            if (!hasMessageContent(item)) continue
            try {
                await deletedMessageNotifier.cacheIncomingMessage(item)
            } catch (error) {
                console.log("[DELETE NOTIFY] Gagal cache pesan masuk", {
                    id: item?.key?.id,
                    remoteJid: item?.key?.remoteJid,
                    error: String(error.message || error).slice(0, 300),
                })
            }
        }

        // Cek view-once untuk semua item di batch upsert, bukan cuma pesan pertama.
        // Baileys kadang mengirim beberapa pesan sekaligus, dan view-once bisa bukan item pertama.
        for (const item of messages || []) {
            if (isMessageGloballySkipped(item)) continue
            if (!hasMessageContent(item)) continue

            const viewOnceDeleteHandled = await viewonce2.handleDeleteSignal(sock, item, {
                getMessageContent: getCachedMessageContent,
            })
            if (viewOnceDeleteHandled) continue

            const deleteHandled = await deletedMessageNotifier.handleDeleteSignal(sock, item)
            if (deleteHandled) continue

            // Reply/react owner memakai cache V2 lebih dulu. Legacy hanya dipakai
            // jika V2 benar-benar tidak mempunyai record target.
            const manualSenderJid = getMessageSenderJid(item, sock)
            const manualIsOwner = Boolean(
                item?.key?.fromMe
                || PRIORITY_USERS.includes(manualSenderJid)
                || isOwnerControlMessage(item, manualSenderJid, item?.key?.remoteJid)
            )
            let manualViewOnceFallbackHandled = await viewonce2.handleManualViewOnceFallback(sock, item, {
                isOwner: manualIsOwner,
            })
            if (!manualViewOnceFallbackHandled) {
                manualViewOnceFallbackHandled = await viewonce.handleAntiViewOnce(sock, item, {
                    ownerJids: ownerForwardJids,
                    getMessageContent: getCachedMessageContent,
                })
            }
            if (manualViewOnceFallbackHandled) {
                markMessageGloballySkipped(item)
            }
            continue
        }

        const msg = (messages || []).find(item => (
            hasMessageContent(item)
            && !deletedMessageNotifier.isDeleteSignal(item)
            && !isMessageGloballySkipped(item)
            && !isAntiToxicMessageSkipped(item)
            && !(item?.key?.fromMe && !isAntiToxicOwnerCommandText(getAntiToxicPipelineText(item)) && (
                isBotGeneratedMessage(item)
                || isAntiToxicGeneratedWarningText(getAntiToxicPipelineText(item))
            ))
        ))
        if (!hasMessageContent(msg)) return
        if (!markIncomingMessageProcessed(msg)) {
            if (process.env.WA_LOG_DUPLICATE_MESSAGES === "true") {
                console.log("[WA DEDUPE] Abaikan pesan duplicate", {
                    remoteJid: msg.key?.remoteJid,
                    participant: msg.key?.participant,
                    id: msg.key?.id,
                    fromMe: msg.key?.fromMe,
                    messageTypes: getMessageTypeKeys(msg),
                })
            }
            return
        }
        const from = msg.key.remoteJid
        if (shouldIgnoreIncomingJid(from)) return
        const isMe = msg.key.fromMe
        const isGroup = from.includes("@g.us")
        const senderJid = getMessageSenderJid(msg, sock)
        const isOwner = isMe || PRIORITY_USERS.includes(senderJid) || PRIORITY_USERS.includes(from)
        const canControlOwner = isOwner || isOwnerControlMessage(msg, senderJid, from)
        const incomingMessage = msg.message || {}
        const hasIncomingImage = Boolean(incomingMessage.imageMessage)
        const shouldAutoReplyForMedia = hasIncomingImage
        const text = getAntiToxicBasicText(msg)
        const commandText = text.toLowerCase()
        const isAntiToxicOwnerCommand = isAntiToxicOwnerCommandText(text)
        const traceContext = {
            from,
            text,
            ...(isGroup ? { policy: "antiToxicOnly" } : {}),
        }

        const traceGroupAutoReplySkips = () => {
            routerTrace.trace(msg, {
                ...traceContext,
                scope: "group",
                handler: "autoReply",
                skipped: true,
                reason: "private-only",
            })
            routerTrace.trace(msg, {
                ...traceContext,
                scope: "group",
                handler: "keywordReply",
                skipped: true,
                reason: "private-only",
            })
        }

        if (isGroup) {
            traceGroupAutoReplySkips()
            const groupBotEnabled = groupRemoteControl.isGroupBotEnabled(from)
            const antiToxicInboundAllowed = groupRemoteControl.isInboundGroupFeatureAllowed("antiToxic")
            const groupAntiToxicEnabled = groupRemoteControl.isGroupFeatureEnabled(from, "antiToxic")

            if (!groupBotEnabled || !antiToxicInboundAllowed || !groupAntiToxicEnabled) {
                routerTrace.trace(msg, {
                    ...traceContext,
                    policy: groupBotEnabled ? "antiToxicOnly" : "disabled",
                    handler: "antiToxic",
                    skipped: true,
                    reason: !groupBotEnabled ? "bot-disabled" : "feature-disabled",
                })
                debugAntiToxicPipeline("skip-by-group-inbound-policy", {
                    id: msg?.key?.id,
                    from,
                    senderJid,
                    reason: !groupBotEnabled ? "bot-disabled" : "anti-toxic-disabled",
                })
                return
            }
        }

        if (!isGroup && securityMediaLog.isSecurityLogCommand(text)) {
            const privateReplyJid = !isGroup && String(senderJid || "").endsWith("@s.whatsapp.net")
                ? senderJid
                : (!isGroup && String(msg?.key?.remoteJidAlt || "").endsWith("@s.whatsapp.net")
                    ? msg.key.remoteJidAlt
                    : from)
            console.log("[SECURITY LOG CMD] Fast intercept matched.", {
                command: commandText.split(/\s+/)[0],
                isGroup,
                isOwner: canControlOwner,
                build: securityMediaLog.SECURITY_LOG_BUILD,
            })
            const handled = await securityMediaLog.handleSecurityLogCommand(sock, msg, {
                from: privateReplyJid,
                text,
                isGroup,
                isOwner: canControlOwner,
            })
            if (handled) return
        }
        const sendAutoReplyWithForward = async (replyMessage, originalText = text) => {
            if (!autoReply.shouldProcessMessage(msg, { botEnabled: botStatus.getStatus() })) return false
            const sent = await autoReplyForwarder.sendAutoReply(sock, from, replyMessage, {
                msg,
                originalText,
                ownerJids: ownerForwardJids,
            })
            routerTrace.trace(msg, {
                ...traceContext,
                scope: "private",
                handler: "autoReply",
                handled: Boolean(sent),
                skipped: !sent,
                reason: sent ? undefined : "private-only",
            })
            return sent
        }
        logPrivateLidPipeline("selected-message", {
            from,
            senderJid,
            fromMe: isMe,
            isOwner,
            canControlOwner,
            id: msg?.key?.id,
            text,
            messageTypes: getMessageTypeKeys(msg),
            remoteJidAlt: msg?.key?.remoteJidAlt,
            participant: msg?.key?.participant,
            participantAlt: msg?.key?.participantAlt,
        })

        const groupRemoteControlHandled = !isGroup && await routerTrace.run(msg, traceContext, "groupRemoteControl", () => groupRemoteControl.handleGroupRemoteControlCommand(sock, msg, {
            from,
            sender: senderJid,
            senderJid,
            text,
            isGroup,
            canControlOwner,
            isOwner,
        }))
        if (groupRemoteControlHandled) return

        const remoteReflectionHandled = !isGroup && await routerTrace.run(msg, traceContext, "antiToxicReflectionConfig", () => antiToxicReflectionConfig.handleRemoteReflectionCommand(sock, msg, {
            from,
            remoteJid: from,
            sender: senderJid,
            senderJid,
            text,
            isGroup,
            canControlOwner,
            isOwner,
            groupRemoteControl,
        }))
        if (remoteReflectionHandled) return

        const antiToxicSafeMatcherHandled = !isGroup && await routerTrace.run(msg, traceContext, "antiToxicSafeMatcher", () => antiToxic.handleAntiToxicSafeMatcherCommand(sock, msg, {
            from,
            text,
            isGroup,
            isOwner: canControlOwner,
        }))
        if (antiToxicSafeMatcherHandled) return

        const antiToxicStickerOcrHandled = !isGroup && await routerTrace.run(msg, traceContext, "antiToxicStickerOcrCommand", () => antiToxicStickerOcr.handleAntiToxicStickerOcrCommand(sock, msg, {
            from,
            text,
            isGroup,
            isOwner: canControlOwner,
            getToxicWords: antiToxic.loadWords,
        }))
        if (antiToxicStickerOcrHandled) return

        const stickerSafetyCommandHandled = !isGroup && await routerTrace.run(msg, traceContext, "stickerSafetyCommand", () => stickerSafetyGuard.handleStickerSafetyCommand(sock, msg, {
            from,
            sender: senderJid,
            senderJid,
            text,
            isGroup,
            canControlOwner,
            isOwner,
            groupRemoteControl,
        }))
        if (stickerSafetyCommandHandled) return

        const stickerSafetyResult = !isGroup && await routerTrace.run(msg, traceContext, "stickerSafetyGuard", () => stickerSafetyGuard.handleStickerSafety(sock, msg, {
            from,
            sender: senderJid,
            senderJid,
            text,
            isGroup,
            canControlOwner,
            isOwner,
            groupRemoteControl,
            lidAliasStore,
        }))
        if (stickerSafetyResult?.warned) return

        const antiToxicControlHandled = !isGroup && await routerTrace.run(msg, traceContext, "antiToxicControl", () => antiToxicControl.handleAntiToxicControlCommand(sock, msg, {
            from,
            sender: senderJid,
            senderJid,
            text,
            isGroup,
            canControlOwner,
        }))
        if (antiToxicControlHandled) return

        const selectedMessageTypes = getMessageTypeKeys(msg)
        const allowFromMeStickerModeration = isMe
            && selectedMessageTypes.includes("stickerMessage")
            && /^(1|true|yes|on)$/i.test(String(
            process.env.ANTI_TOXIC_STICKER_WARN_FROM_ME
                || process.env.ANTI_TOXIC_TEST_STICKER_FROM_ME
                || "false"
            ).trim())
        const allowFromMeTextModeration = isMe && isAntiToxicWarnOwnerEnabled()
        const skipAntiToxicBecauseBotGenerated = isMe && isBotGeneratedMessage(msg)
        const skipAntiToxicBecauseFromMeNonCommand = isMe
            && !isAntiToxicOwnerCommand
            && !allowFromMeStickerModeration
            && !allowFromMeTextModeration

        if (skipAntiToxicBecauseBotGenerated) {
            console.log("[ANTI-TOXIC PIPELINE] skip-bot-generated-message", {
                id: msg?.key?.id,
                remoteJid: msg?.key?.remoteJid,
                fromMe: msg?.key?.fromMe,
                messageTypes: getMessageTypeKeys(msg),
            })
            return
        }

        if (skipAntiToxicBecauseFromMeNonCommand) {
            console.log("[ANTI-TOXIC PIPELINE] skip-from-me-non-command", {
                id: msg?.key?.id,
                remoteJid: msg?.key?.remoteJid,
                participant: msg?.key?.participant,
                fromMe: msg?.key?.fromMe,
                textPreview: text.slice(0, 100),
                messageTypes: selectedMessageTypes,
            })
        }

        if (from === "status@broadcast" && !isMe) return

        if (!isGroup && isIncomingMediaLoggerEnabled() && !isMe) {
            try {
                await incomingMediaLogger.handleIncomingMedia(sock, msg, {
                    ownerJids: ownerForwardJids,
                })
            } catch (error) {
                console.log("[MEDIA INTAKE] Logger wrapper error", {
                    id: msg?.key?.id,
                    remoteJid: from,
                    error: error.message,
                })
            }
        }

        let toxicHandled = false

        const shouldRunAntiToxicForMessage = antiToxicControl.shouldRunAntiToxic(msg)
            && (!isGroup || groupRemoteControl.isGroupFeatureEnabled(from, "antiToxic"))
        if (!shouldRunAntiToxicForMessage) {
            debugAntiToxicPipeline("skip-by-group-control", {
                id: msg?.key?.id,
                from,
                senderJid,
                isGroup,
                mode: antiToxicControl.getAntiToxicModeForMessage(msg),
                remoteAntiToxic: !isGroup || groupRemoteControl.isGroupFeatureEnabled(from, "antiToxic"),
            })
        }

        if (!skipAntiToxicBecauseFromMeNonCommand && shouldRunAntiToxicForMessage) {
            if (isAntiToxicDebug()) {
                console.log("[WA KEY AUDIT]", {
                    id: msg?.key?.id,
                    remoteJid: msg?.key?.remoteJid,
                    remoteJidAlt: msg?.key?.remoteJidAlt,
                    participant: msg?.key?.participant,
                    participantAlt: msg?.key?.participantAlt,
                    senderLid: msg?.key?.senderLid,
                    senderPn: msg?.key?.senderPn,
                    participantLid: msg?.key?.participantLid,
                    participantPn: msg?.key?.participantPn,
                    addressingMode: msg?.key?.addressingMode,
                    fromMe: msg?.key?.fromMe,
                    pushName: msg?.pushName,
                    messageTypes: getMessageTypeKeys(msg),
                })
            }

            debugAntiToxicPipeline("before-handle-toxic-check", {
                id: msg?.key?.id,
                from,
                senderJid,
                fromMe: msg?.key?.fromMe,
                isGroup,
                text,
                ownerJid: getOwnerControlJid(),
                messageTypes: getMessageTypeKeys(msg),
            })

            toxicHandled = await routerTrace.run(msg, traceContext, "antiToxic", () => antiToxic.handleToxicCheck(msg, sock, getOwnerControlJid(), {
                groupPrivateReply: isGroup && groupRemoteControl.isGroupAntiToxicPrivateReplyEnabled(from),
            }))

            debugAntiToxicPipeline("after-handle-toxic-check", {
                id: msg?.key?.id,
                from,
                senderJid,
                toxicHandled,
            })
        }

        if (isGroup) {
            if (!toxicHandled) {
                const command = routerTrace.detectCommand(text)
                const platform = routerTrace.detectPlatform(text)
                routerTrace.trace(msg, {
                    ...traceContext,
                    command,
                    platform,
                    handler: platform ? "linkDetection" : (command ? "command" : "groupInbound"),
                    skipped: true,
                })
            }
            return
        }

        if (toxicHandled) return

        // Legacy antiNsfwSticker routing dinonaktifkan agar stiker tidak diproses dua kali.
        // Sticker Safety Guard menjadi handler utama moderasi stiker.
        if (process.env.STICKER_SAFETY_LEGACY_FALLBACK === "true") {
            console.log("[STICKER SAFETY] Legacy fallback diminta, tetapi routing default legacy tetap OFF untuk mencegah double warning.")
        }

        const manualPauseCommandResult = await manualAutoReplyPause.handleCommand(sock, msg, {
            from,
            text,
            senderJid,
            isOwner: canControlOwner,
        })
        if (manualPauseCommandResult && manualPauseCommandResult.handled) {
            if (manualPauseCommandResult.targetJid) clearFollowUpFor(manualPauseCommandResult.targetJid)
            return
        }

        const mediaCleanupHandled = await routerTrace.run(msg, traceContext, "mediaCleanupManager", () => mediaCleanupManager.handleCleanupCommand(sock, msg, text, {
            ownerJid: getOwnerControlJid(),
            ownerJids: ownerForwardJids,
        }));
        if (mediaCleanupHandled) return;

        const healthHandled = await routerTrace.run(msg, traceContext, "healthCheck", () => healthCheck.handleHealthCommand(sock, msg, {
            from,
            text,
            isGroup,
            isOwner: canControlOwner,
            botStatus,
            autoReply,
            statusInbox,
            groupRemoteControl,
            antiToxic,
            antiToxicControl,
            antiToxicStickerOcr,
            stickerSafetyGuard,
            securityMediaLog,
            messageEditGuardian,
            bcscheduler,
            broadcastSchedulerStatus: getBroadcastSchedulerRuntimeStatus,
        }))
        if (healthHandled) return

        const messageEditGuardianHandled = await routerTrace.run(msg, traceContext, "messageEditGuardianCommand", () => messageEditGuardian.handleMessageEditGuardianCommand(sock, msg, {
            from,
            text,
            isGroup,
            isOwner: canControlOwner,
            senderJid,
            groupRemoteControl,
            antiToxicControl,
        }))
        if (messageEditGuardianHandled) return

        const settingsHandled = await routerTrace.run(msg, traceContext, "settings", () => handleSettingsCommand(sock, msg, {
            from,
            text,
            isGroup,
            isOwner: canControlOwner,
        }))
        if (settingsHandled) return

        const broadcastTemplateHandled = await routerTrace.run(msg, traceContext, "bctemplate", () => handleBroadcastTemplateCommand(sock, msg, {
            from,
            text,
            isGroup,
            isOwner: canControlOwner,
        }))
        if (broadcastTemplateHandled) return

        const broadcastSchedulerCommandHandled = await routerTrace.run(msg, traceContext, "bcschedulerCommand", () => handleBroadcastSchedulerCommand(sock, msg, {
            from,
            text,
            isGroup,
            isOwner: canControlOwner,
        }))
        if (broadcastSchedulerCommandHandled) return

        const reactionWorkflowCommandHandled = await routerTrace.run(msg, traceContext, "reactionWorkflowCommand", () => reactionWorkflow.handleReactionControlCommand(sock, msg, {
            from,
            text,
            isGroup,
            isOwner: canControlOwner,
            ownerJid: getOwnerControlJid(),
            allowedActorJids: [getOwnerControlJid(), ...PRIORITY_USERS].filter(Boolean),
            services: {
                bcscheduler,
                bctemplate,
                healthCheck,
                mediaCleanupManager,
                groupRemoteControl,
                broadcastSchedulerStatus: getBroadcastSchedulerRuntimeStatus,
                healthContext: {
                    botStatus,
                    autoReply,
                    statusInbox,
                    groupRemoteControl,
                    antiToxic,
                    antiToxicControl,
                    antiToxicStickerOcr,
                    stickerSafetyGuard,
                    securityMediaLog,
                    messageEditGuardian,
                },
            },
        }))
        if (reactionWorkflowCommandHandled) return

        const calculatorHandled = await routerTrace.run(msg, traceContext, "calculator", () => handleCalculatorCommand(sock, msg, {
            from,
            text,
            isGroup,
        }))
        if (calculatorHandled) return

        const handledSpotify = !isGroup && await routerTrace.run(msg, traceContext, "spotifyDownloader", () => spotifyDownloader.handleSpotifyDownloader(sock, msg, {
            from,
            sender: senderJid,
            senderJid,
            text,
            isGroup,
            isOwnerControlMessage: isOwnerControlMessage(msg, senderJid, from),
            isOwner,
            canControlOwner,
            groupRemoteControl,
        }))
        if (handledSpotify) return

        if (!isGroup) {
            const extendedDownloadHandled = await routerTrace.run(msg, traceContext, "extendedDownloader", () => extendedDownloader.handleExtendedDownload(msg, sock))
            if (extendedDownloadHandled) return
        }

        if (!isGroup) {
            const legacyDownloaderHandled = await routerTrace.run(msg, traceContext, "legacyDownloader", () => handleLegacyDownloaderCommand(sock, msg, {
                from,
                text,
                isGroup,
            }))
            if (legacyDownloaderHandled) return
        }

        const legacyTelegramStickerHandled = await routerTrace.run(msg, traceContext, "legacyTgSticker", () => handleLegacyTelegramStickerCommand(sock, msg, {
            from,
            text,
            isGroup,
        }))
        if (legacyTelegramStickerHandled) return

        const fakeVnHandled = await routerTrace.run(msg, traceContext, "fakeVn", () => fakeVn.handleFakeVn(msg, sock))
        if (fakeVnHandled) return

        if (commandText === ".reset" || commandText === ".upt") {
            if (!isOwnerControlMessage(msg, senderJid, from)) {
                try {
                    await sock.sendMessage(from, { text: "Akses Ditolak" })
                } catch (error) {
                    console.log(`[RESTART] Gagal kirim penolakan akses: ${error.message}`)
                }
                return
            }

            await editRestartCommandToNotice(sock, msg, from)

            setTimeout(() => {
                requestProcessShutdown(`${commandText} command`, 0)
            }, Math.max(1000, RESTART_EXIT_DELAY_MS))
            return
        }

        const lidAliasHandled = await handleLidAliasCommand(sock, msg, {
            from,
            text,
            senderJid,
            isOwner: canControlOwner,
        })
        if (lidAliasHandled) return

        const botBlocklistHandled = await routerTrace.run(msg, traceContext, "botBlocklistManager", () => botBlocklistManager.handleBotBlocklist(sock, msg, {
            from,
            text,
            isOwner: canControlOwner,
            ownerJids: ownerForwardJids,
        }))
        if (botBlocklistHandled) return

        const statusInboxHandled = await routerTrace.run(msg, traceContext, "statusInbox", () => statusInbox.handleStatusIdCommand(sock, msg, {
            from,
            sender: senderJid,
            senderJid,
            text,
            isGroup,
            isOwner: canControlOwner,
            canControlOwner,
            lidAliasStore,
        }))
        if (statusInboxHandled) return

        const targetedStatusHandled = await routerTrace.run(msg, traceContext, "targetedStatusDownloader", () => targetedStatusDownloader.handleTargetedStatusCommand(sock, msg, {
            from,
            sender: senderJid,
            senderJid,
            text,
            isGroup,
            isOwner: canControlOwner,
            canControlOwner,
            lidAliasStore,
        }))
        if (targetedStatusHandled) return

        const statusDownloaderHandled = await routerTrace.run(msg, traceContext, "statusDownloader", () => statusDownloader.handleStatusDownloader(sock, msg, {
            from,
            text,
            isOwner: canControlOwner,
        }))
        if (statusDownloaderHandled) return

        // Check blocklist
        if (!canControlOwner && blocklist.isBlocked(senderJid || from)) {
            console.log("[BLOCKLIST] Pesan diabaikan karena sender masuk blocklist bot", {
                from,
                senderJid,
                textPreview: text.slice(0, 80),
            })
            return
        }

        if (commandText === ".help" || commandText === ".menu") {
            logPrivateLidPipeline("send-help-menu", {
                from,
                senderJid,
                fromMe: isMe,
                isOwner,
                canControlOwner,
                id: msg?.key?.id,
                text,
                messageTypes: Object.keys(msg?.message || {}),
                remoteJidAlt: msg?.key?.remoteJidAlt,
                participant: msg?.key?.participant,
                participantAlt: msg?.key?.participantAlt,
            })
            await sock.sendMessage(from, { text: help.generateHelpMenu() })
            return
        }

        // --- STATUS PANEL LIST RESPONSE (OWNER ONLY) ---
        const selectedStatusId = statusPanel.extractSelectedId(msg)
        if (selectedStatusId && statusPanel.isStatusPanelId(selectedStatusId)) {
            if (!isOwner) {
                console.log(`[PANEL] Abaikan pilihan status dari non-owner: ${from}`)
                return
            }

            const result = statusPanel.applySelection(selectedStatusId, customAutoReply)
            await sock.sendMessage(getOwnerControlJid() || from, { text: result.text })
            return
        }

        // --- STATUS PANEL COMMAND (OWNER ONLY) ---
        if (isOwner) {
            const statusCommandId = statusPanel.extractCommandId(text)
            if (statusCommandId) {
                const result = statusPanel.applySelection(statusCommandId, customAutoReply)
                await sock.sendMessage(getOwnerControlJid() || from, { text: result.text })
                return
            }

            if (text.toLowerCase() === ".panel") {
                console.log(`[PANEL] Buka panel status dari ${from}`)
                await statusPanel.sendPanel(sock, from, customAutoReply.load())
                return
            }
        }

        // Status broadcast disimpan untuk view once, tapi jangan diproses auto-reply/downloader.
        if (from === "status@broadcast") return

        const visualQrHandled = await routerTrace.run(msg, traceContext, "qrArt", () => qrArt.handleVisualQR(msg, sock, getOwnerControlJid()))
        if (visualQrHandled) return

        const imageStickerHandled = await routerTrace.run(msg, traceContext, "imageSticker", () => imageSticker.handleStickerCommand(sock, msg, {
            from,
            text,
            isOwner: canControlOwner,
        }))
        if (imageStickerHandled) return

        const imageToPdfHandled = await routerTrace.run(msg, traceContext, "imageToPdf", () => imageToPdfFeature.handleImageToPdf(sock, msg, {
            from,
            text,
        }))
        if (imageToPdfHandled) return

        // --- AUTO-DOWNLOADER UNIVERSAL ---
        // Gate ini sengaja di atas command owner dan auto-reply supaya owner/non-owner
        // sama-sama bisa pakai link downloader serta memilih menu 1/2/3.
        let localDownload = false
        if (!isGroup) {
            try {
                logPrivateLidPipeline("before-local-downloader", {
                    from,
                    senderJid,
                    fromMe: isMe,
                    isOwner,
                    canControlOwner,
                    id: msg?.key?.id,
                    text,
                    messageTypes: Object.keys(msg?.message || {}),
                    remoteJidAlt: msg?.key?.remoteJidAlt,
                    participant: msg?.key?.participant,
                    participantAlt: msg?.key?.participantAlt,
                })
                localDownload = await routerTrace.run(msg, traceContext, "localDownloader", () => localDownloader.handleLocalDownload(sock, from, text, msg.pushName, msg.key))
                logPrivateLidPipeline("after-local-downloader", {
                    from,
                    senderJid,
                    fromMe: isMe,
                    isOwner,
                    canControlOwner,
                    id: msg?.key?.id,
                    text,
                    messageTypes: Object.keys(msg?.message || {}),
                    remoteJidAlt: msg?.key?.remoteJidAlt,
                    participant: msg?.key?.participant,
                    participantAlt: msg?.key?.participantAlt,
                    localDownload,
                })
            } catch (error) {
                console.log("[LOCAL DOWNLOADER] Handler error", {
                    remoteJid: from,
                    messageId: msg.key?.id,
                    errorMessage: error.message,
                    statusCode: error?.output?.statusCode || error?.statusCode || error?.data?.statusCode || error?.code,
                    stack: error.stack,
                })
            }
        }
        if (localDownload) return

        // --- COMMAND HANDLER (OWNER ONLY) ---
        if (isMe) {
            const backupHandled = await backup.handleBackupCommand(sock, msg, {
                from,
                text,
                isOwner: isMe,
                ownerJid: getOwnerControlJid(),
            });
            if (backupHandled) return;

            // --- JADWAL BROADCAST ---
            if (text.startsWith(".bcjadwal ")) {
                const parts = text.replace(".bcjadwal ", "").split("|")
                if (parts.length < 2) { await sock.sendMessage(from, { text: "Format: .bcjadwal [HH:MM] | [pesan]" }); return }
                const ok = bcscheduler.addSchedule(parts[0].trim(), parts.slice(1).join("|").trim())
                await sock.sendMessage(from, { text: ok ? `✅ Jadwal broadcast ${parts[0].trim()} disimpan` : `Format waktu salah. Contoh: 20:00` }); return
            }
                if (text.startsWith(".delbcjadwal ")) {
                    const time = text.replace(".delbcjadwal ", "").trim()
                    const ok = bcscheduler.delSchedule(time)
                    await sock.sendMessage(from, { text: ok ? `🗑️ Jadwal ${time} dihapus` : `Jadwal tidak ditemukan` }); return
                }
                if (text === ".listbcjadwal") {
                    const list = bcscheduler.getList()
                    if (list.length === 0) { await sock.sendMessage(from, { text: "Belum ada jadwal broadcast." }); return }
                    const now = new Date()
                    const today = now.toISOString().split("T")[0]
                    await sock.sendMessage(from, { text: `⏰ *Jadwal Broadcast (${list.length}):*\n\n${list.map((s, i) => `${i + 1}. ${s.time} → "${s.message}"\n   Terakhir kirim: ${s.lastSent === today ? "hari ini ✅" : s.lastSent || "belum pernah"}`).join("\n\n")}` }); return
                }

                // --- REMINDER / PESAN TERJADWAL ---
                if (text.startsWith(".remind ")) {
                    const parts = text.replace(/^\.remind\s+/i, "").split("|").map(part => part.trim());
                    const reminderContext = {
                        remoteJid: from,
                        senderJid,
                        ownerJid: getOwnerControlJid(),
                    };

                    let targets = [];
                    let time = null;
                    let msgText = "";

                    if (parts.length >= 3) {
                        targets = collectReminderTargets(msg, parts[0], reminderContext);
                        time = normalizeReminderTime(parts[1]);
                        msgText = parts.slice(2).join("|").trim();
                    } else if (parts.length >= 2) {
                        targets = collectReminderTargets(msg, "", reminderContext);
                        time = normalizeReminderTime(parts[0]);
                        msgText = parts.slice(1).join("|").trim();
                    } else {
                        await sock.sendMessage(from, {
                            text:
                                "❌ Format salah!\n" +
                                "Contoh: *.remind 62812345678 | 15:30 | Jangan lupa makan*\n" +
                                "Bisa juga reply/kirim kontak lalu: *.remind 15:30 | Jangan lupa makan*",
                        });
                        return;
                    }

                    if (!time) {
                        await sock.sendMessage(from, { text: "❌ Format jam salah. Pakai format HH:MM, contoh: 15:30" });
                        return;
                    }

                    if (targets.length === 0) {
                        await sock.sendMessage(from, {
                            text:
                                "❌ Target reminder belum ketemu.\n" +
                                "Pakai nomor, mention, reply pesan target, atau reply/kirim contact card.\n" +
                                "Contoh: *.remind kontak | 15:30 | Jangan lupa makan*",
                        });
                        return;
                    }

                    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

                    // Kirim pesan status dan simpan key-nya
                    const statusMsg = await messageCleaner.sendTemporary(sock, from, "⏳ Sedang memproses dan menyimpan jadwal...");

                    const results = [];
                    for (const target of targets) {
                        const success = await reminder.addReminder(target.jid, time, msgText, quotedMsg, {
                            targetLabel: target.label,
                        });
                        results.push({ target, success });
                    }
                    const successCount = results.filter(item => item.success).length;

                    // Hapus pesan status
                    await messageCleaner.deleteMessageObject(sock, from, statusMsg, "status reminder");

                    if (successCount > 0) {
                        const failed = results.filter(item => !item.success);
                        const failedText = failed.length
                            ? `\n⚠️ Gagal simpan untuk: ${formatReminderTargetList(failed.map(item => item.target))}`
                            : "";
                        await sock.sendMessage(from, {
                            text:
                                `✅ Berhasil! ${successCount}/${targets.length} reminder disimpan.\n` +
                                `Target: *${formatReminderTargetList(results.filter(item => item.success).map(item => item.target))}*\n` +
                                `Jam: *${time}* WIB.` +
                                failedText,
                        });
                    } else {
                        await sock.sendMessage(from, { text: "❌ Gagal menyimpan jadwal. Cek log Termux." });
                    }
                    return;
                }

                // --- CEK JADWAL REMINDER ---
                if (text === ".listremind") {
                    const list = reminder.getReminders();
                    if (list.length === 0) { await sock.sendMessage(from, { text: "Kosong. Gak ada jadwal." }); return; }
                    
                    let balasan = `📋 *DAFTAR REMINDER (${list.length}):*\n\n`;
                    list.forEach((rem, i) => {
                        const targetLabel = rem.targetLabel
                            ? `${rem.targetLabel} (${rem.target.split('@')[0]})`
                            : rem.target.split('@')[0];
                        balasan += `${i + 1}. Ke: ${targetLabel}\n⏰ Jam: ${rem.time}\n💬 Pesan: ${rem.message || "(Media)"}\n\n`;
                    });
                    await sock.sendMessage(from, { text: balasan }); return;
                }

                // --- HAPUS JADWAL REMINDER ---
                if (text.startsWith(".delremind ")) {
                    const nomerAntrean = parseInt(text.replace(".delremind ", "").trim());
                    const sukses = reminder.delReminder(nomerAntrean);
                    
                    if (sukses) { await sock.sendMessage(from, { text: `🗑️ Jadwal nomer ${nomerAntrean} berhasil dihapus!` }); } 
                    else { await sock.sendMessage(from, { text: "❌ Gagal. Pastikan nomer antreannya bener (Cek .listremind dulu)." }); }
                    return;
                }

                // --- GANTI TEMPLATE HEADER REMINDER ---
                if (text.startsWith(".setheader ")) {
                    const newHeader = text.replace(".setheader ", "").trim();
                    reminder.setHeader(newHeader);
                    await sock.sendMessage(from, { 
                        text: `✅ Template Header berhasil diubah!\n\nPreview jadinya nanti begini:\n\n${newHeader}\n(Isi pesan jadwal lu di sini)` 
                    });
                    return;
                }

                // --- MANAGE BLACKLIST (PURE BOT SYSTEM) ---
                if (text === ".blocklist") {
                    const list = blocklist.getList();
                    if (list.length === 0) { await sock.sendMessage(from, { text: "Blocklist kosong." }); return; }
                    await sock.sendMessage(from, { text: `🚫 *Daftar Blacklist Bot:*\n\n${list.map((n, i) => `${i + 1}. ${n.replace("@s.whatsapp.net", "")}`).join("\n")}` });
                    return;
                }
                if (text.startsWith(".block")) {
                    let number = "";
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (quoted && quoted.participant) {
                        number = quoted.participant.split("@")[0]; 
                    } else {
                        number = text.replace(".block", "").trim().replace(/[^0-9]/g, "");
                    }
                    if (!number) return sock.sendMessage(from, { text: "Nomornya mana? Atau *reply* pesannya lalu ketik .block" });
                    if (number.startsWith("0")) number = "62" + number.slice(1);

                    blocklist.block(number);
                    await sock.sendMessage(from, { text: `✅ Sip! 🚫 ${number} berhasil dimasukkan ke Blacklist.` });
                    return;
                }
                if (text.startsWith(".unblock")) {
                    let number = "";
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (quoted && quoted.participant) {
                        number = quoted.participant.split("@")[0];
                    } else {
                        number = text.replace(".unblock", "").trim().replace(/[^0-9]/g, "");
                    }
                    if (!number) return sock.sendMessage(from, { text: "Nomornya mana? Atau *reply* pesannya lalu ketik .unblock" });
                    if (number.startsWith("0")) number = "62" + number.slice(1);

                    blocklist.unblock(number);
                    await sock.sendMessage(from, { text: `✅ Berhasil! ${number} dihapus dari Blacklist.` });
                    return;
                }

                // --- HELP ---
                if (commandText === ".help" || commandText === ".menu") {
                    await sock.sendMessage(from, { text: help.generateHelpMenu() }); return
                }

                // --- TOGGLE AUTO REPLY ---
                const lowerOwnerText = text.toLowerCase()
                if (lowerOwnerText === ".bot status" || lowerOwnerText === ".bot") {
                    const customState = customAutoReply.load()
                    const globalActive = botStatus.getStatus()
                    await sock.sendMessage(from, {
                        text: [
                            "🛌 *Bot Status*",
                            "",
                            `Bot: ${globalActive ? "aktif" : "tidur"}`,
                            `Auto-reply private: ${autoReply.getStatus() ? "aktif" : "nonaktif"}`,
                            `Custom auto-reply: ${customState.isCustomAutoReplyOn ? "aktif" : "nonaktif"}`,
                            `Status: ${customState.customStatusText || "-"}`,
                            "",
                            "Catatan: .bot dan .reply sebaiknya digunakan lewat private chat owner dengan bot.",
                        ].join("\n"),
                    });
                    return;
                }
                if (lowerOwnerText === ".bot off") {
                    customAutoReply.setEnabled(false);
                    await sock.sendMessage(from, { text: "✅ Custom auto-reply dimatikan." });
                    return;
                }
                if (lowerOwnerText === ".bot on") {
                    const state = customAutoReply.enableLastStatus();
                    await sock.sendMessage(from, {
                        text: state
                            ? `✅ Custom auto-reply dinyalakan.\nStatus: ${state.customStatusText}`
                            : "❌ Belum ada status tersimpan. Set dulu dengan: *.bot lagi sibuk*",
                    });
                    return;
                }
                if (lowerOwnerText.startsWith(".bot ")) {
                    const activity = text.slice(5).trim();
                    const state = customAutoReply.setStatus(activity);
                    await sock.sendMessage(from, {
                        text: state
                            ? `Status diatur ke: ${state.customStatusText}`
                            : "❌ Status kosong. Contoh: *.bot lagi makan*",
                    });
                    return;
                }

                if (lowerOwnerText === ".reply on") { autoReply.setStatus(true, from); await sock.sendMessage(from, { text: "✅ Auto-reply private chat diaktifkan dan tersimpan." }); return }
                if (lowerOwnerText === ".reply off") { autoReply.setStatus(false, from); await sock.sendMessage(from, { text: "✅ Auto-reply private chat dinonaktifkan dan tersimpan." }); return }
                if (lowerOwnerText === ".reply status") {
                    const status = autoReply.getScopeStatus()
                    await sock.sendMessage(from, { text: [
                        "AUTO REPLY STATUS",
                        "",
                        `Global Status: ${status.global}`,
                        `Private Chat: ${status.privateChat}`,
                        "Group Chat: OFF",
                        "Scope: PRIVATE ONLY",
                        `Forward to Owner: ${status.forwarder}`,
                        `Keyword Reply: ${status.keywordReply}`,
                    ].join("\n") })
                    return
                }
                if (lowerOwnerText === ".reply") { await sock.sendMessage(from, { text: "🤖 *Auto Reply*\n\n.reply on\nMengaktifkan auto-reply untuk private chat.\n\n.reply off\nMematikan auto-reply untuk private chat.\n\n.reply status\nMelihat status auto-reply saat ini.\n\nCatatan:\nAuto-reply hanya berjalan di private chat.\nAuto-reply tidak berjalan di grup.\nCommand .reply sebaiknya digunakan lewat private chat owner dengan bot." }); return }

                if (text.startsWith(".afk")) { afk.setAFK(text.replace(".afk", "").trim() || "lagi sibuk"); await sock.sendMessage(from, { text: `AFK aktif: ${afk.getReason()}` }); return }
                if (text === ".unafk") { afk.clearAFK(); await sock.sendMessage(from, { text: "AFK off" }); return }
                if (text.startsWith(".addreply ")) { await sock.sendMessage(from, { text: `Ditambah ✅. Total: ${replies.addReply(text.replace(".addreply ", "").trim())}` }); return }
                if (text.startsWith(".delreply ")) { const n = parseInt(text.replace(".delreply ", "").trim()); const r = replies.delReply(n); await sock.sendMessage(from, { text: r ? `Dihapus: "${r}"` : "Tidak ada." }); return }
                if (text === ".listreply") { await sock.sendMessage(from, { text: `💬 *Balasan:*\n\n${replies.getList().map((r, i) => `${i + 1}. ${r}`).join("\n")}` }); return }
                if (text.startsWith(".addkeyword ")) { const p = text.replace(".addkeyword ", "").split("|"); if (p.length < 2) return; keywords.addKeyword(p[0].trim(), p.slice(1).join("|").trim()); await sock.sendMessage(from, { text: "Keyword ditambah ✅" }); return }
                if (text.startsWith(".delkeyword ")) { keywords.delKeyword(text.replace(".delkeyword ", "").trim()); await sock.sendMessage(from, { text: "Keyword dihapus" }); return }
                if (text === ".listkeyword") { const list = keywords.getList(); await sock.sendMessage(from, { text: list.length === 0 ? "Kosong." : `📋 *Keyword:*\n\n${list.map((k, i) => `${i + 1}. "${k.keyword}" → "${k.reply}"`).join("\n")}` }); return }
                if (text.startsWith(".jadwal ")) { const p = text.replace(".jadwal ", "").split("|"); if (p.length < 2) return; const ok = scheduler.addSchedule(p[0].trim(), p.slice(1).join("|").trim()); await sock.sendMessage(from, { text: ok ? "Jadwal ditambah ✅" : "Format salah." }); return }
                if (text.startsWith(".deljadwal ")) { const ok = scheduler.delSchedule(text.replace(".deljadwal ", "").trim()); await sock.sendMessage(from, { text: ok ? "Dihapus" : "Tidak ditemukan" }); return }
                if (text === ".listjadwal") { const list = scheduler.getList(); await sock.sendMessage(from, { text: list.length === 0 ? "Kosong." : `⏰ *Jadwal:*\n\n${list.map((s, i) => `${i + 1}. ${s.time} → "${s.message}"`).join("\n")}\n\n✅ Aktif: "${scheduler.getActiveMessage() || "tidak ada"}"` }); return }
                if (text === ".stat") { const s = stats.getStats(); await sock.sendMessage(from, { text: `📊 Pesan: ${s.messages} | Tanggal: ${s.date}` }); return }

                // --- TELEGRAM STICKER CONVERTER ---
                if (text.toLowerCase().startsWith(".tgstiker ")) {
                    const handled = await tgStickerConverter.handleTelegramStickerCommand(sock, from, text, msg.pushName);
                    if (handled) return;
                }

                if (text.startsWith(".")) return
                return
            }

            // =========================================================================
            // ===== AUTO-REPLY ORANG LAIN =============================================
            
           // Jika bot sedang OFF dan yang chat bukan owner, abaikan semua proses di bawahnya
        try {
            if (isGroup) return;

            if (!botStatus.getStatus() && !isMe) return;

            // Scope and global status are checked together so no non-private source
            // can enter custom, keyword, or fallback Auto Reply.
            if (!autoReply.shouldProcessMessage(msg, { botEnabled: botStatus.getStatus() })) return;

            const customReplyMessage = customAutoReply.getReplyMessageForMessage(msg, [getOwnerControlJid(), ...PRIORITY_USERS]);
            if (customReplyMessage && !isMe) {
                await sock.sendPresenceUpdate("composing", from);
                await delay(900 + Math.random() * 900);
                await sock.sendPresenceUpdate("paused", from);
                await sendAutoReplyWithForward(customReplyMessage);
                return;
            }

            // --- IMAGE TO PDF (ADAPTIF) [UNTUK ORANG LAIN] ---
            let targetPdfUser = null;
            if (msg.message?.imageMessage && (msg.message.imageMessage.caption || "").trim().toLowerCase() === ".pdf") {
                targetPdfUser = msg.message.imageMessage;
            } else if (text.toLowerCase() === ".pdf" && msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
                targetPdfUser = msg.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
            }

if (targetPdfUser) {
    await sock.sendPresenceUpdate("composing", from);
    const statusMsg = await messageCleaner.sendTemporary(sock, from, "⏳ Sedang convert gambar ke PDF...");
    try {
        let buf;
        // Coba download dari URL langsung dulu (bypass enkripsi)
        const directUrl = targetPdfUser.url
        if (directUrl) {
            const res = await axios.get(directUrl, { responseType: "arraybuffer", timeout: 15000 })
            buf = Buffer.from(res.data)
        } else {
            // Fallback ke cara lama kalau tidak ada URL
            const stream = await downloadContentFromMessage(targetPdfUser, "image")
            const chunks = []
            for await (const chunk of stream) chunks.push(chunk)
            buf = Buffer.concat(chunks)
        }
                    const pdfBuf = await imageToPdf(buf);
                    
                    // Hapus pesan status
                    await messageCleaner.deleteMessageObject(sock, from, statusMsg, "status PDF");
                    
                    await sock.sendMessage(from, {
                        document: pdfBuf, mimetype: "application/pdf", fileName: `Dokumen_${Date.now()}.pdf`, caption: "✅ Berhasil convert ke PDF!"
                    });
                } catch (e) {
                    // Hapus pesan status jika error
                    await messageCleaner.deleteMessageObject(sock, from, statusMsg, "status PDF");
                    
                    await sock.sendMessage(from, { text: "❌ Gagal convert: " + e.message });
                }
                return;
            }

            if (!text && !shouldAutoReplyForMedia) return
            stats.addMessage()

            if (afk.isAFK()) { await sendAutoReplyWithForward({ text: `Lagi ${afk.getReason()} nih, nanti aku bales ya` }); return }

            const isPriority = PRIORITY_USERS.includes(from)

            if (!isPriority) {
                await sock.sendPresenceUpdate("composing", from)
                await delay(1200 + Math.random() * 1800)
                await sock.sendPresenceUpdate("paused", from)
            }

            if (text && text.toLowerCase().startsWith("cuaca ")) {
                try { await sendAutoReplyWithForward({ text: await getWeatherText(text.slice(6).trim()) })
                } catch { await sendAutoReplyWithForward({ text: "Cuaca tidak ditemukan 😅" }) }
                return
            }
            const keywordReply = text ? keywords.matchKeywordForMessage(msg, text) : null
            if (keywordReply) {
                routerTrace.trace(msg, { ...traceContext, scope: "private", handler: "keywordReply", handled: true })
                await sendAutoReplyWithForward({ text: keywordReply });
                return
            }

            const scheduledReply = scheduler.getActiveMessage()
            if (scheduledReply) { await sendAutoReplyWithForward({ text: scheduledReply }); return }

            const lowText = text.toLowerCase()
            if (lowText && (lowText.includes("halo") || lowText.includes("assalamualaikum"))) { await sendAutoReplyWithForward({ text: "Halo! Ada yang bisa dibantu? Chat lagi aja ya, ini bot auto-reply." }); return }
            if (lowText && (lowText.includes("siapa") || lowText.includes("nama"))) { await sendAutoReplyWithForward({ text: "Aku bot asisten pribadi. Ada pesan penting?" }); return }
            if (lowText && (lowText.includes("p") || lowText.includes("ping"))) { await sendAutoReplyWithForward({ text: "Pesan sudah diterima" }); return }
            if (lowText && (lowText.includes("lagi apa") || lowText.includes("sibuk"))) { await sendAutoReplyWithForward({ text: "Lagi standby sebagai USERBOT" }); return }

            const hour = new Date().getHours()
            let timeGreeting = ""
            if (hour >= 0 && hour < 5) timeGreeting = "Selamat dini hari"
            else if (hour < 12) timeGreeting = "Selamat pagi"
            else if (hour < 18) timeGreeting = "Selamat siang"
            else timeGreeting = "Selamat malam"

            const randomReply = replies.getRandomForMessage(msg)
            if (!randomReply) return
            let baseReply = randomReply

            // 🔥 SELALU ADA GREETING
            baseReply = `${timeGreeting}, ${baseReply}`

            // MODE TAMBAHAN
            if (BOT_MODE === "formal") {
                baseReply = `${timeGreeting}, pesan Anda telah kami terima. ${randomReply}`
            } else if (BOT_MODE === "sales") {
                baseReply = `${timeGreeting}, ${randomReply}\n\nApakah ingin langsung diproses hari ini?`
            } else if (BOT_MODE === "santai") {
                baseReply = `${timeGreeting}, ${randomReply} 😄`
            }

            await sendAutoReplyWithForward({ text: baseReply })

            // ===== FOLLOW UP SYSTEM =====
            if (!isMe && !isGroup) {
                if (followUpTracker.has(from)) {
                    clearTimeout(followUpTracker.get(from))
                }

                const timeout = setTimeout(async () => {
                    try {
                        if (!autoReply.shouldProcessMessage(msg, { botEnabled: botStatus.getStatus() })) return
                        await autoReplyForwarder.sendAutoReply(sock, from, {
                            text: "Apakah masih ingin dilanjutkan atau ada yang ingin ditanyakan lagi?"
                        }, {
                            remoteJid: from,
                            originalText: text,
                            ownerJids: ownerForwardJids,
                        })
                    } catch {} finally {
                        followUpTracker.delete(from)
                    }
                }, 30 * 60 * 1000)

                followUpTracker.set(from, timeout)
            }

        } catch (error) {
          console.log("Handler error:", error.message)
        }
    })

}

installProcessGuards()
acquireInstanceLock()

startBot().catch((error) => {
    console.log(`[START] Gagal start bot: ${error.message}`)
    scheduleReconnect(error.message)
})
