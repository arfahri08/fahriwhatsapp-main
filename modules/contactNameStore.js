"use strict"

const fs = require("fs")
const path = require("path")

const DEFAULT_DATA_FILE = path.join(__dirname, "..", "data", "contactNames.json")
const DEFAULT_MAX_CONTACTS = 10000

let stateCache = null
let stateFileCache = ""

function getDataFile() {
    return path.resolve(process.env.CONTACT_NAME_STORE_FILE || DEFAULT_DATA_FILE)
}

function cleanName(value) {
    const clean = String(value || "")
        .normalize("NFKC")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    if (!clean) return ""
    const onlyNumber = clean.replace(/[^0-9]/g, "")
    if (onlyNumber && onlyNumber.length >= 8) return ""
    return clean.slice(0, 120)
}

function getJidNumber(value) {
    return String(value || "")
        .split("@")[0]
        .split(":")[0]
        .replace(/[^0-9]/g, "")
}

function normalizePhoneNumber(value) {
    let number = getJidNumber(value)
    if (!number) return ""
    if (number.startsWith("0")) number = `62${number.slice(1)}`
    else if (number.startsWith("8")) number = `62${number}`
    return number.length >= 8 && number.length <= 16 ? number : ""
}

function normalizeContactJid(value) {
    const clean = String(value || "").trim().toLowerCase()
    if (!clean) return ""
    if (/^\d+@lid$/i.test(clean) || /^\d+@s\.whatsapp\.net$/i.test(clean)) return clean
    const number = normalizePhoneNumber(clean)
    return number ? `${number}@s.whatsapp.net` : ""
}

function defaultState() {
    return {
        version: 1,
        contacts: {},
    }
}

function normalizeEntry(entry = {}) {
    return {
        savedName: cleanName(entry.savedName),
        pushName: cleanName(entry.pushName),
        source: String(entry.source || "unknown").slice(0, 80),
        updatedAt: Math.max(0, Number(entry.updatedAt || 0) || 0),
    }
}

function normalizeState(raw) {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
    const contacts = {}
    for (const [jid, entry] of Object.entries(value.contacts || {})) {
        const normalizedJid = normalizeContactJid(jid)
        if (!normalizedJid) continue
        const normalizedEntry = normalizeEntry(entry)
        if (!normalizedEntry.savedName && !normalizedEntry.pushName) continue
        contacts[normalizedJid] = normalizedEntry
    }
    return { version: 1, contacts }
}

function writeAtomic(state, filePath = getDataFile()) {
    const normalized = normalizeState(state)
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
    fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
    fs.renameSync(temp, filePath)
    return normalized
}

function loadState(filePath = getDataFile()) {
    if (stateCache && stateFileCache === filePath) return stateCache
    try {
        stateCache = fs.existsSync(filePath)
            ? normalizeState(JSON.parse(fs.readFileSync(filePath, "utf8") || "{}"))
            : defaultState()
    } catch (error) {
        console.log(`[CONTACT NAME] Gagal membaca cache: ${String(error.message || error).slice(0, 200)}`)
        stateCache = defaultState()
    }
    stateFileCache = filePath
    return stateCache
}

function saveState(state, filePath = getDataFile()) {
    stateCache = writeAtomic(state, filePath)
    stateFileCache = filePath
    return stateCache
}

function pruneContacts(state) {
    const max = Math.max(100, Number(process.env.CONTACT_NAME_STORE_MAX || DEFAULT_MAX_CONTACTS) || DEFAULT_MAX_CONTACTS)
    const entries = Object.entries(state.contacts || {})
    if (entries.length <= max) return state
    entries.sort((a, b) => Number(a[1]?.updatedAt || 0) - Number(b[1]?.updatedAt || 0))
    for (const [jid] of entries.slice(0, entries.length - max)) delete state.contacts[jid]
    return state
}

function contactJids(contact = {}) {
    return [...new Set([
        contact.id,
        contact.jid,
        contact.lid,
        contact.phoneNumber,
    ].map(normalizeContactJid).filter(Boolean))]
}

function applyContactToState(state, contact = {}, options = {}, now = Date.now()) {
    const jids = contactJids(contact)
    if (!jids.length) return { changed: false, reason: "no-jid", jids: [] }

    const savedName = cleanName(contact.name || contact.shortName || options.savedName)
    const pushName = cleanName(
        contact.notify
        || contact.verifiedName
        || contact.verifiedBizName
        || contact.pushName
        || options.pushName
    )
    if (!savedName && !pushName) return { changed: false, reason: "no-name", jids }

    let changed = false
    for (const jid of jids) {
        const existing = normalizeEntry(state.contacts[jid] || {})
        const nextSavedName = savedName || existing.savedName
        const nextPushName = pushName || existing.pushName
        if (existing.savedName === nextSavedName && existing.pushName === nextPushName) continue
        state.contacts[jid] = {
            savedName: nextSavedName,
            pushName: nextPushName,
            source: String(options.source || "contacts").slice(0, 80),
            updatedAt: now,
        }
        changed = true
    }
    return { changed, jids, savedName, pushName }
}

function rememberContact(contact = {}, options = {}) {
    const state = loadState()
    const result = applyContactToState(state, contact, options)
    if (!result.changed) return { saved: false, reason: result.reason || "unchanged", jids: result.jids }
    pruneContacts(state)
    saveState(state)
    return { saved: true, ...result }
}

function rememberContacts(contacts = [], options = {}) {
    const list = Array.isArray(contacts) ? contacts : [contacts]
    const state = loadState()
    const now = Date.now()
    let changed = 0
    for (const contact of list) {
        try {
            if (applyContactToState(state, contact, options, now).changed) changed += 1
        } catch (error) {
            console.log(`[CONTACT NAME] Gagal simpan contact: ${String(error.message || error).slice(0, 160)}`)
        }
    }
    if (changed > 0) {
        pruneContacts(state)
        saveState(state)
    }
    return { saved: changed }
}

function rememberIncomingMessage(msg, options = {}) {
    const jid = normalizeContactJid(
        options.senderJid
        || msg?.key?.participantAlt
        || msg?.key?.participant
        || msg?.participantAlt
        || msg?.participant
        || msg?.key?.remoteJidAlt
        || msg?.key?.remoteJid
    )
    const pushName = cleanName(msg?.pushName || msg?.verifiedBizName || msg?.notifyName)
    if (!jid || !pushName) return { saved: false }
    return rememberContact({ id: jid, pushName }, { source: "incoming-message", pushName })
}

function resolveContactName(jid, fallbacks = []) {
    const normalizedJid = normalizeContactJid(jid)
    const state = loadState()
    const entry = normalizedJid ? state.contacts[normalizedJid] : null
    if (entry?.savedName) return entry.savedName

    const number = getJidNumber(normalizedJid)
    if (number) {
        for (const [storedJid, storedEntry] of Object.entries(state.contacts || {})) {
            if (getJidNumber(storedJid) !== number) continue
            if (storedEntry?.savedName) return cleanName(storedEntry.savedName)
        }
    }

    const fallbackList = Array.isArray(fallbacks) ? fallbacks : [fallbacks]
    for (const fallback of fallbackList) {
        const name = cleanName(fallback)
        if (name) return name
    }

    if (entry?.pushName) return entry.pushName
    return ""
}

function resolveSavedContactName(jid) {
    const normalizedJid = normalizeContactJid(jid)
    const state = loadState()
    const entry = normalizedJid ? state.contacts[normalizedJid] : null
    if (entry?.savedName) return cleanName(entry.savedName)

    const number = getJidNumber(normalizedJid)
    if (!number) return ""
    for (const [storedJid, storedEntry] of Object.entries(state.contacts || {})) {
        if (getJidNumber(storedJid) !== number) continue
        if (storedEntry?.savedName) return cleanName(storedEntry.savedName)
    }
    return ""
}

function disposeContactNameStore() {
    stateCache = null
    stateFileCache = ""
}

module.exports = {
    rememberContact,
    rememberContacts,
    rememberIncomingMessage,
    resolveContactName,
    resolveSavedContactName,
    normalizeContactJid,
    getJidNumber,
    loadState,
    saveState,
    disposeContactNameStore,
}
