"use strict"

const readline = require("readline")

const METHOD_QR = "qr"
const METHOD_PAIRING = "pairing"
const METHOD_ASK = "ask"

function isFalseEnv(value) {
    return /^(0|false|off|no)$/i.test(String(value ?? "").trim())
}

function isTrueEnv(value) {
    return /^(1|true|on|yes)$/i.test(String(value ?? "").trim())
}

function cleanPhoneNumber(value) {
    return String(value || "")
        .replace(/@s\.whatsapp\.net$/i, "")
        .replace(/[^\d]/g, "")
}

function cleanCustomPairingCode(value) {
    const code = String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase()
    return code.length === 8 ? code : ""
}

function normalizeLoginMethod(value) {
    const clean = String(value || "").trim().toLowerCase()
    if (["1", "qr", "qrcode", "qr_code"].includes(clean)) return METHOD_QR
    if (["2", "pairing", "pairing_code", "phone", "phone_number", "number"].includes(clean)) return METHOD_PAIRING
    if (["ask", "prompt", "pilih", "choice"].includes(clean)) return METHOD_ASK
    return ""
}

function canPrompt(input = process.stdin, output = process.stdout) {
    return Boolean(input?.isTTY && output?.isTTY)
}

function getPairingPhoneNumber(env = process.env, fallbackJids = []) {
    const configured = cleanPhoneNumber(env.WA_PAIRING_PHONE_NUMBER || env.WA_LOGIN_PHONE_NUMBER)
    if (configured) return configured

    for (const jid of fallbackJids) {
        const number = cleanPhoneNumber(jid)
        if (number) return number
    }

    return ""
}

function shouldShowQrForPairing(env = process.env) {
    if (isFalseEnv(env.WA_HIDE_QR_WHEN_PAIRING)) return true
    return isTrueEnv(env.WA_PAIRING_FALLBACK_QR)
}

function formatPairingCode(code) {
    const clean = String(code || "").replace(/[^a-z0-9]/gi, "").toUpperCase()
    if (clean.length !== 8) return String(code || "")
    return `${clean.slice(0, 4)}-${clean.slice(4)}`
}

function logPairingInstructions(log, number, code) {
    log("")
    log("================================================")
    log(" WHATSAPP PAIRING CODE")
    log("================================================")
    log(` Nomor : ${number}`)
    log(` Kode  : ${formatPairingCode(code)}`)
    log("================================================")
    log(" Buka WhatsApp di HP:")
    log(" Linked devices > Link a device")
    log(" Pilih 'Link with phone number instead'")
    log(" Masukkan kode di atas.")
    log("================================================")
    log("")
}

async function promptLoginConfig(options = {}) {
    const env = options.env || process.env
    const input = options.input || process.stdin
    const output = options.output || process.stdout
    const fallbackJids = options.fallbackJids || []
    const log = typeof options.log === "function" ? options.log : console.log
    const defaultNumber = getPairingPhoneNumber(env, fallbackJids)

    const rl = readline.createInterface({ input, output })
    const question = (text) => new Promise(resolve => rl.question(text, answer => resolve(String(answer || "").trim())))

    try {
        log("")
        const answer = await question("Login WhatsApp pakai QR code (1) atau Phone Number / Pairing Code (2)? ")
        const method = normalizeLoginMethod(answer) || METHOD_QR

        if (method !== METHOD_PAIRING) {
            return { method: METHOD_QR, phoneNumber: "", showQr: true }
        }

        log("")
        log("Catatan: kalau linked device bot lama masih ada, logout dulu dari WhatsApp > Linked devices.")
        const numberAnswer = await question(`Nomor WhatsApp dengan country code${defaultNumber ? ` [${defaultNumber}]` : ""}: `)
        const phoneNumber = cleanPhoneNumber(numberAnswer || defaultNumber)

        if (!phoneNumber) {
            log("[LOGIN] Nomor kosong, fallback ke QR.")
            return { method: METHOD_QR, phoneNumber: "", showQr: true }
        }

        return {
            method: METHOD_PAIRING,
            phoneNumber,
            customPairingCode: cleanCustomPairingCode(env.WA_PAIRING_CUSTOM_CODE),
            showQr: shouldShowQrForPairing(env),
        }
    } finally {
        rl.close()
    }
}

async function resolveLoginConfig(options = {}) {
    const env = options.env || process.env
    const state = options.state || {}
    const log = typeof options.log === "function" ? options.log : console.log
    const input = options.input || process.stdin
    const output = options.output || process.stdout
    const fallbackJids = [options.ownerJid, ...(options.fallbackJids || [])].filter(Boolean)

    if (state?.creds?.registered) {
        return { method: "registered", phoneNumber: "", showQr: false }
    }

    const rawMethod = env.WA_LOGIN_METHOD || env.WA_LOGIN_MODE || ""
    let method = normalizeLoginMethod(rawMethod)
    const phoneNumber = getPairingPhoneNumber(env, fallbackJids)

    if (!method) {
        method = phoneNumber ? METHOD_PAIRING : (canPrompt(input, output) ? METHOD_ASK : METHOD_QR)
    }

    if (method === METHOD_ASK) {
        if (canPrompt(input, output)) {
            return promptLoginConfig({ env, input, output, fallbackJids, log })
        }

        const configuredFallback = normalizeLoginMethod(env.WA_NON_INTERACTIVE_LOGIN_METHOD || env.WA_PM2_LOGIN_METHOD)
        const fallbackMethod = configuredFallback && configuredFallback !== METHOD_ASK ? configuredFallback : METHOD_QR
        log(`[LOGIN] Mode ask aktif, tapi proses tidak interaktif. Pakai ${fallbackMethod === METHOD_PAIRING ? "pairing code dari .env" : "QR"} sebagai fallback.`)
        method = fallbackMethod
    }

    if (method === METHOD_PAIRING && !phoneNumber) {
        if (canPrompt(input, output)) {
            return promptLoginConfig({ env, input, output, fallbackJids, log })
        }

        log("[LOGIN] WA_LOGIN_METHOD=pairing tapi WA_PAIRING_PHONE_NUMBER kosong. Fallback ke QR.")
        method = METHOD_QR
    }

    return {
        method,
        phoneNumber: method === METHOD_PAIRING ? phoneNumber : "",
        customPairingCode: cleanCustomPairingCode(env.WA_PAIRING_CUSTOM_CODE),
        showQr: method === METHOD_QR || shouldShowQrForPairing(env),
    }
}

function createLoginRuntime(config = {}, options = {}) {
    const env = options.env || process.env
    const log = typeof options.log === "function" ? options.log : console.log
    const qrcode = options.qrcode
    const isActiveSocket = typeof options.isActiveSocket === "function" ? options.isActiveSocket : () => true
    const requestDelayMs = Math.max(0, Number(env.WA_PAIRING_CODE_REQUEST_DELAY_MS || 1500) || 0)

    let qrShown = false
    let hiddenQrLogged = false
    let pairingRequested = false
    let pairingInFlight = false
    let pairingTimer = null
    let connected = false

    const dispose = () => {
        if (pairingTimer) {
            clearTimeout(pairingTimer)
            pairingTimer = null
        }
        connected = true
    }

    const showQr = (qr) => {
        if (!qr || !config.showQr) return
        qrShown = true
        log("")
        log("==============================================")
        log(" SCAN QR CODE WHATSAPP")
        log("==============================================")
        log("")
        if (qrcode?.generate) qrcode.generate(qr, { small: true })
        else log(qr)
        log("")
    }

    const requestPairingCode = (sock, trigger) => {
        if (config.method !== METHOD_PAIRING) return
        if (connected) return
        if (sock?.authState?.creds?.registered) return
        if (pairingRequested || pairingInFlight || pairingTimer) return
        if (typeof sock?.requestPairingCode !== "function") {
            log("[PAIRING LOGIN] Baileys tidak menyediakan requestPairingCode di socket ini.")
            return
        }

        log(`[PAIRING LOGIN] Login ref siap (${trigger}), pairing code diminta dalam ${Math.round(requestDelayMs / 1000)} detik.`)
        pairingTimer = setTimeout(async () => {
            pairingTimer = null
            if (!isActiveSocket(sock)) {
                log("[PAIRING LOGIN] Batal meminta pairing code karena socket sudah tidak aktif.")
                return
            }
            if (connected) {
                log("[PAIRING LOGIN] Batal meminta pairing code karena socket sudah berhasil open.")
                return
            }
            if (sock?.authState?.creds?.registered) return

            pairingInFlight = true
            try {
                log(`[PAIRING LOGIN] Meminta pairing code untuk ${config.phoneNumber}...`)
                const code = await sock.requestPairingCode(config.phoneNumber, config.customPairingCode || undefined)
                pairingRequested = true
                logPairingInstructions(log, config.phoneNumber, code)
            } catch (error) {
                log(`[PAIRING LOGIN] Gagal meminta pairing code: ${error.message}`)
            } finally {
                pairingInFlight = false
            }
        }, requestDelayMs)
    }

    const handleConnectionUpdate = async (sock, update = {}) => {
        if (config.method === "registered") return

        const { connection, qr } = update

        if (connection === "open") {
            connected = true
            dispose()
            return
        }

        if (qr) {
            if (config.method === METHOD_PAIRING && !config.showQr) {
                if (!hiddenQrLogged) {
                    hiddenQrLogged = true
                    log("[PAIRING LOGIN] QR diterima tapi disembunyikan karena mode pairing code aktif.")
                }
            } else {
                showQr(qr)
            }

            requestPairingCode(sock, "qr")
            return
        }

        if (config.method === METHOD_PAIRING && !connection && !sock?.authState?.creds?.registered) {
            requestPairingCode(sock, "login-update")
        }
    }

    return {
        dispose,
        handleConnectionUpdate,
        getState: () => ({
            method: config.method,
            qrShown,
            pairingRequested,
            pairingInFlight,
        }),
    }
}

module.exports = {
    METHOD_ASK,
    METHOD_PAIRING,
    METHOD_QR,
    cleanPhoneNumber,
    createLoginRuntime,
    formatPairingCode,
    getPairingPhoneNumber,
    normalizeLoginMethod,
    resolveLoginConfig,
}
