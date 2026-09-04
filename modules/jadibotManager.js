"use strict"

const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const P = require("pino")
const { createAtomicJsonStore } = require("./atomicJsonStore")
const identity = require("./canonicalIdentity")

const DEFAULT_CONFIG_FILE = process.env.JADIBOT_CONFIG_FILE
    ? path.resolve(process.env.JADIBOT_CONFIG_FILE)
    : path.join(__dirname, "..", "data", "jadibotConfig.json")
const DEFAULT_SESSION_ROOT = process.env.JADIBOT_SESSION_ROOT
    ? path.resolve(process.env.JADIBOT_SESSION_ROOT)
    : path.join(__dirname, "..", "data", "jadibot-sessions")
const MIN_LIMIT = 1
const MAX_LIMIT = 10
const DEFAULT_LIMIT = 3
const MAX_RECONNECT_ATTEMPTS = 3
const DELETE_CONFIRM_TTL_MS = 2 * 60 * 1000
const MAX_DELETE_CONFIRMATIONS = 100
const MAX_SESSION_RECORDS = 500

function makeDefaultState() {
    return { version: 1, enabled: false, limit: DEFAULT_LIMIT, sessions: {} }
}

function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "")
    if (digits.length < 8 || digits.length > 16 || /^0/.test(digits)) return ""
    return digits
}

function normalizeState(value = {}) {
    const limit = Number(value.limit)
    return {
        ...makeDefaultState(),
        ...value,
        enabled: value.enabled === true,
        limit: Number.isInteger(limit) && limit >= MIN_LIMIT && limit <= MAX_LIMIT ? limit : DEFAULT_LIMIT,
        sessions: value.sessions && typeof value.sessions === "object" ? value.sessions : {},
    }
}

function safeSessionId(key) {
    const prefix = String(key || "id").startsWith("pn:") ? "pn" : "lid"
    const digest = crypto.createHash("sha256").update(String(key || "")).digest("hex").slice(0, 24)
    return `${prefix}-${digest}`
}

function assertChildPath(root, child) {
    const resolvedRoot = path.resolve(root)
    const resolvedChild = path.resolve(child)
    if (resolvedChild === resolvedRoot || !resolvedChild.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Session path keluar dari root")
    return resolvedChild
}

function publicErrorCode(error) {
    const code = String(error?.code || error?.output?.statusCode || "CONNECT_FAILED").replace(/[^A-Z0-9_-]/gi, "").slice(0, 40)
    return code || "CONNECT_FAILED"
}

async function defaultConnector(options = {}) {
    const baileys = options.baileys || require("@whiskeysockets/baileys")
    const makeWASocket = baileys.default
    const { state, saveCreds } = await baileys.useMultiFileAuthState(options.authDir)
    const socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: "silent" }),
        browser: ["USERBOT Jadibot", "Chrome", "1.0.0"],
        markOnlineOnConnect: false,
        syncFullHistory: false,
    })
    socket.ev.on("creds.update", saveCreds)
    let pairingCode = ""
    if (!state.creds.registered) {
        if (!options.phoneNumber) throw new Error("Nomor WhatsApp diperlukan untuk pairing")
        pairingCode = await socket.requestPairingCode(options.phoneNumber)
    }
    return { socket, pairingCode, registered: state.creds.registered === true }
}

function createJadibotManager(options = {}) {
    const configFile = path.resolve(options.configFile || DEFAULT_CONFIG_FILE)
    const sessionRoot = path.resolve(options.sessionRoot || DEFAULT_SESSION_ROOT)
    const connector = options.connector || defaultConnector
    const reconnectBaseMs = Math.max(10, Number(options.reconnectBaseMs || 2000))
    const maxReconnectAttempts = Math.max(0, Math.min(10, Number(options.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS)))
    const configStore = createAtomicJsonStore({ filePath: configFile, label: "JADIBOT", defaultState: makeDefaultState })
    const active = new Map()
    const deleteConfirmations = new Map()

    const snapshot = () => normalizeState(configStore.snapshot())
    const update = mutator => normalizeState(configStore.update(raw => {
        const state = normalizeState(raw)
        return mutator(state) || state
    }))

    function cleanupConfirmations(now = Date.now()) {
        for (const [key, expiresAt] of deleteConfirmations) if (expiresAt <= now) deleteConfirmations.delete(key)
        while (deleteConfirmations.size > MAX_DELETE_CONFIRMATIONS) deleteConfirmations.delete(deleteConfirmations.keys().next().value)
    }

    function requester(input, context = {}) {
        const resolved = identity.canonicalIdentity(input, context)
        if (!resolved.key) throw new Error("Identitas requester tidak valid")
        return resolved
    }

    function sessionPath(key) {
        return assertChildPath(sessionRoot, path.join(sessionRoot, safeSessionId(key)))
    }

    function persistSession(key, patch = {}) {
        return update(state => {
            const current = state.sessions[key] && typeof state.sessions[key] === "object" ? state.sessions[key] : {}
            state.sessions[key] = { ...current, ...patch, key, updatedAt: new Date().toISOString() }
            const entries = Object.entries(state.sessions).sort((a, b) => String(a[1]?.updatedAt || "").localeCompare(String(b[1]?.updatedAt || "")))
            while (entries.length > MAX_SESSION_RECORDS) {
                const [oldestKey] = entries.shift()
                if (!active.has(oldestKey)) delete state.sessions[oldestKey]
            }
            return state
        }).sessions[key]
    }

    function clearReconnect(record) {
        if (record?.reconnectTimer) clearTimeout(record.reconnectTimer)
        if (record) record.reconnectTimer = null
    }

    function closeSocket(record) {
        if (!record?.socket) return
        try { record.socket.ev?.removeAllListeners?.("connection.update") } catch {}
        try { record.socket.end?.(new Error("jadibot stopped")) } catch {}
        try { record.socket.ws?.close?.() } catch {}
        record.socket = null
    }

    async function connectRecord(record) {
        if (record.stopping) return { started: false, reason: "stopping" }
        const result = await connector({
            authDir: record.authDir,
            phoneNumber: record.phoneNumber,
            requesterKey: record.key,
            reconnectAttempt: record.reconnectAttempts,
        })
        record.socket = result.socket
        record.status = result.registered ? "CONNECTING" : "PAIRING"
        record.pairingCode = String(result.pairingCode || "")
        persistSession(record.key, { status: record.status, sessionId: record.sessionId, reconnectAttempts: record.reconnectAttempts })

        const listener = updateValue => {
            const connection = updateValue?.connection
            if (connection === "open") {
                clearReconnect(record)
                record.status = "OPEN"
                record.reconnectAttempts = 0
                record.pairingCode = ""
                persistSession(record.key, { status: "OPEN", lastConnectedAt: new Date().toISOString(), reconnectAttempts: 0 })
                return
            }
            if (connection !== "close" || record.stopping) return
            closeSocket(record)
            if (record.reconnectAttempts >= maxReconnectAttempts) {
                record.status = "STOPPED_RECONNECT_LIMIT"
                active.delete(record.key)
                persistSession(record.key, { status: record.status, stoppedAt: new Date().toISOString(), reconnectAttempts: record.reconnectAttempts })
                return
            }
            record.reconnectAttempts += 1
            record.status = "RECONNECT_WAIT"
            persistSession(record.key, { status: record.status, reconnectAttempts: record.reconnectAttempts })
            const waitMs = Math.min(30_000, reconnectBaseMs * (2 ** (record.reconnectAttempts - 1)))
            record.reconnectTimer = setTimeout(() => {
                record.reconnectTimer = null
                void connectRecord(record).catch(error => listener({ connection: "close", errorCode: String(error?.code || "connect-error") }))
            }, waitMs)
            record.reconnectTimer.unref?.()
        }
        record.connectionListener = listener
        result.socket?.ev?.on?.("connection.update", listener)
        return { started: true, pairingCode: record.pairingCode, status: record.status, sessionId: record.sessionId }
    }

    async function start(input = {}) {
        const state = snapshot()
        if (!state.enabled) return { started: false, reason: "disabled" }
        const owner = requester(input.requester, input.context)
        if (active.has(owner.key)) {
            const existing = active.get(owner.key)
            return { started: false, duplicate: true, reason: "already-active", status: existing.status, sessionId: existing.sessionId }
        }
        if (active.size >= state.limit) return { started: false, reason: "limit-full", limit: state.limit }
        const phoneNumber = normalizePhone(input.phoneNumber || (owner.type === "pn" ? owner.number : ""))
        if (!phoneNumber) return { started: false, reason: "phone-required" }
        if (owner.type === "pn" && input.phoneNumber && phoneNumber !== owner.number) return { started: false, reason: "phone-mismatch" }
        const authDir = sessionPath(owner.key)
        fs.mkdirSync(authDir, { recursive: true, mode: 0o700 })
        const record = {
            key: owner.key,
            sessionId: safeSessionId(owner.key),
            authDir,
            phoneNumber,
            status: "STARTING",
            reconnectAttempts: 0,
            reconnectTimer: null,
            socket: null,
            stopping: false,
            pairingCode: "",
        }
        active.set(owner.key, record)
        persistSession(owner.key, { sessionId: record.sessionId, status: "STARTING", createdAt: state.sessions[owner.key]?.createdAt || new Date().toISOString() })
        try {
            return await connectRecord(record)
        } catch (error) {
            active.delete(owner.key)
            const errorCode = publicErrorCode(error)
            persistSession(owner.key, { status: "START_FAILED", errorCode })
            return { started: false, reason: "connect-failed", errorCode }
        }
    }

    function stop(input, context = {}) {
        const owner = requester(input, context)
        const record = active.get(owner.key)
        if (!record) return { stopped: false, reason: "not-active" }
        record.stopping = true
        clearReconnect(record)
        closeSocket(record)
        active.delete(owner.key)
        persistSession(owner.key, { status: "STOPPED", stoppedAt: new Date().toISOString(), reconnectAttempts: record.reconnectAttempts })
        return { stopped: true, sessionId: record.sessionId }
    }

    function status(input, context = {}) {
        const owner = requester(input, context)
        const record = active.get(owner.key)
        const persisted = snapshot().sessions[owner.key]
        return {
            exists: Boolean(record || persisted),
            active: Boolean(record),
            status: record?.status || persisted?.status || "NONE",
            sessionId: record?.sessionId || persisted?.sessionId || safeSessionId(owner.key),
            reconnectAttempts: Number(record?.reconnectAttempts ?? persisted?.reconnectAttempts ?? 0),
        }
    }

    function list() {
        const state = snapshot()
        return Object.entries(state.sessions).slice(-100).map(([key, item]) => ({
            requester: `${String(key).split(":")[0]}:***${String(key).slice(-4)}`,
            sessionId: item.sessionId || safeSessionId(key),
            status: active.get(key)?.status || item.status || "STOPPED",
            active: active.has(key),
            reconnectAttempts: Number(active.get(key)?.reconnectAttempts ?? item.reconnectAttempts ?? 0),
        }))
    }

    function requestDelete(input, context = {}) {
        const owner = requester(input, context)
        cleanupConfirmations()
        deleteConfirmations.set(owner.key, Date.now() + DELETE_CONFIRM_TTL_MS)
        return { confirmationRequired: true, sessionId: safeSessionId(owner.key) }
    }

    function confirmDelete(input, context = {}) {
        const owner = requester(input, context)
        cleanupConfirmations()
        if (!deleteConfirmations.has(owner.key)) return { deleted: false, reason: "confirmation-missing" }
        if (active.has(owner.key)) stop(owner.jid, context)
        const target = sessionPath(owner.key)
        if (fs.existsSync(target)) {
            const stats = fs.lstatSync(target)
            if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Session target tidak aman")
            fs.rmSync(target, { recursive: true, force: false })
        }
        deleteConfirmations.delete(owner.key)
        update(state => { delete state.sessions[owner.key]; return state })
        return { deleted: true, sessionId: safeSessionId(owner.key) }
    }

    function configure(action, value) {
        const normalized = String(action || "").toLowerCase()
        if (normalized === "on" || normalized === "off") {
            const next = update(state => { state.enabled = normalized === "on"; return state })
            if (normalized === "off") {
                for (const record of [...active.values()]) {
                    record.stopping = true
                    clearReconnect(record)
                    closeSocket(record)
                    active.delete(record.key)
                    persistSession(record.key, { status: "STOPPED_FEATURE_OFF", stoppedAt: new Date().toISOString() })
                }
            }
            return next
        }
        if (normalized === "limit") {
            const limit = Number(value)
            if (!Number.isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) throw new Error(`Limit harus ${MIN_LIMIT}-${MAX_LIMIT}`)
            return update(state => { state.limit = limit; return state })
        }
        return snapshot()
    }

    function dispose() {
        for (const record of active.values()) {
            record.stopping = true
            clearReconnect(record)
            closeSocket(record)
            persistSession(record.key, { status: "STOPPED_PROCESS", stoppedAt: new Date().toISOString() })
        }
        active.clear()
        deleteConfirmations.clear()
    }

    return {
        active,
        configFile,
        confirmDelete,
        configure,
        dispose,
        list,
        requestDelete,
        sessionPath,
        sessionRoot,
        snapshot,
        start,
        status,
        stop,
        store: configStore,
    }
}

const defaultManager = createJadibotManager()

async function handleJadibotCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    const match = /^\.(jadibot|stopjadibot|statusjadibot|listjadibot|deljadibot|jadibotctl)(?:\s+([\s\S]*))?$/i.exec(text)
    if (!match) return false
    if (context.isGroup) return true
    const command = match[1].toLowerCase()
    const argument = String(match[2] || "").trim()
    const requesterJid = context.senderJid || context.from

    if (command === "jadibotctl" || command === "listjadibot") {
        if (!context.isOwner) {
            await sock.sendMessage(context.from, { text: "Kontrol/list Jadibot hanya untuk owner." }, { quoted: msg })
            return true
        }
        if (command === "listjadibot") {
            const rows = defaultManager.list()
            await sock.sendMessage(context.from, { text: `JADIBOT SESSIONS (${rows.length})\n${rows.map(item => `${item.sessionId} — ${item.status}`).join("\n") || "Kosong"}` }, { quoted: msg })
            return true
        }
        const [action = "status", value] = argument.split(/\s+/)
        try {
            const state = defaultManager.configure(action, value)
            await sock.sendMessage(context.from, { text: `Jadibot: ${state.enabled ? "ON" : "OFF"}\nLimit: ${state.limit}\nAktif: ${defaultManager.active.size}` }, { quoted: msg })
        } catch (error) {
            await sock.sendMessage(context.from, { text: error.message }, { quoted: msg })
        }
        return true
    }

    if (command === "jadibot") {
        const result = await defaultManager.start({ requester: requesterJid, phoneNumber: argument, context })
        const message = result.started
            ? (result.pairingCode
                ? `Pairing code Jadibot: *${result.pairingCode}*\nJangan bagikan kode ini. Auth session disimpan terisolasi.`
                : `Jadibot dimulai: ${result.status}.`)
            : result.reason === "disabled" ? "Fitur Jadibot masih OFF. Owner dapat mengaktifkan dengan .jadibotctl on"
                : result.reason === "limit-full" ? `Limit Jadibot penuh (${result.limit}).`
                    : result.reason === "phone-required" ? "Kirim .jadibot 628xxxxxxxxxx melalui private chat."
                        : result.reason === "phone-mismatch" ? "Nomor pairing harus sama dengan identitas canonical requester."
                        : result.reason === "already-active" ? `Session sudah aktif (${result.status}).`
                            : `Jadibot gagal dimulai: ${result.errorCode || result.reason}`
        await sock.sendMessage(context.from, { text: message }, { quoted: msg })
        return true
    }
    if (command === "stopjadibot") {
        const result = defaultManager.stop(requesterJid, context)
        await sock.sendMessage(context.from, { text: result.stopped ? "Jadibot dihentikan. Auth session tetap tersimpan." : "Tidak ada Jadibot aktif." }, { quoted: msg })
        return true
    }
    if (command === "statusjadibot") {
        const result = defaultManager.status(requesterJid, context)
        await sock.sendMessage(context.from, { text: `Jadibot: ${result.status}\nActive: ${result.active ? "YES" : "NO"}\nSession: ${result.sessionId}\nReconnect: ${result.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}` }, { quoted: msg })
        return true
    }
    if (command === "deljadibot") {
        if (/^konfirmasi$/i.test(argument)) {
            const result = defaultManager.confirmDelete(requesterJid, context)
            await sock.sendMessage(context.from, { text: result.deleted ? "Auth session Jadibot telah dihapus permanen." : "Konfirmasi tidak ada/kedaluwarsa. Ketik .deljadibot dahulu." }, { quoted: msg })
        } else {
            defaultManager.requestDelete(requesterJid, context)
            await sock.sendMessage(context.from, { text: "Penghapusan auth bersifat permanen. Ketik .deljadibot konfirmasi dalam 2 menit untuk melanjutkan." }, { quoted: msg })
        }
        return true
    }
    return true
}

module.exports = {
    DEFAULT_CONFIG_FILE,
    DEFAULT_LIMIT,
    DEFAULT_SESSION_ROOT,
    MAX_RECONNECT_ATTEMPTS,
    createJadibotManager,
    defaultConnector,
    defaultManager,
    handleJadibotCommand,
    normalizePhone,
    safeSessionId,
}
