"use strict"

const fs = require("fs")
const path = require("path")
const autoReplyScope = require("./autoReplyScope")

const DATA_FILE = path.join(__dirname, "..", "data", "customAutoReply.json")
const DEFAULT_STATE = {
    isCustomAutoReplyOn: false,
    customStatusText: "",
}
let cache = null

function load() {
    if (cache) return { ...cache }
    try {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
        cache = { ...DEFAULT_STATE, ...parsed, isCustomAutoReplyOn: parsed?.isCustomAutoReplyOn === true }
    } catch {
        cache = { ...DEFAULT_STATE }
    }
    return { ...cache }
}

function save(state) {
    const next = {
        ...DEFAULT_STATE,
        ...state,
        isCustomAutoReplyOn: state?.isCustomAutoReplyOn === true,
        customStatusText: String(state?.customStatusText || "").trim(),
    }
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
    const temp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8")
    fs.renameSync(temp, DATA_FILE)
    cache = next
    return { ...next }
}

function setEnabled(enabled) {
    return save({ ...load(), isCustomAutoReplyOn: Boolean(enabled) })
}

function enableLastStatus() {
    const state = load()
    if (!state.customStatusText) return null
    return save({ ...state, isCustomAutoReplyOn: true })
}

function setStatus(statusText) {
    const text = String(statusText || "").trim()
    if (!text) return null
    return save({ isCustomAutoReplyOn: true, customStatusText: text })
}

function getReplyMessageForMessage(msg, excludedJids = [], override = null) {
    if (!autoReplyScope.shouldProcessAutoReplyMessage(msg)) return null
    const sender = String(msg?.key?.remoteJid || "").trim()
    if (new Set((excludedJids || []).map(String)).has(sender)) return null
    const state = override ? { ...load(), ...override } : load()
    if (state.isCustomAutoReplyOn !== true) return null
    const status = String(state.customStatusText || "").trim()
    if (!status) return null
    return {
        text: `Halo, saat ini Fahri ${status}. Pesanmu sudah diterima dan akan dibalas setelah tersedia.`,
    }
}

module.exports = {
    DATA_FILE,
    enableLastStatus,
    getReplyMessageForMessage,
    load,
    save,
    setEnabled,
    setStatus,
}
