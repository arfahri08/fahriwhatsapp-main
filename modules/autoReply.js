"use strict"

const fs = require("fs")
const path = require("path")
const autoReplyScope = require("./autoReplyScope")

const DATA_FILE = path.join(__dirname, "..", "data", "autoReply.json")
const DEFAULT_STATE = {
    enabled: true,
    lastToggled: null,
    toggledBy: "system",
}
let cache = null

function load() {
    if (cache) return { ...cache }
    try {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
        cache = { ...DEFAULT_STATE, ...parsed, enabled: parsed?.enabled !== false }
    } catch {
        cache = { ...DEFAULT_STATE }
    }
    return { ...cache }
}

function save(state) {
    const next = { ...DEFAULT_STATE, ...state, enabled: state?.enabled !== false }
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
    const temp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8")
    fs.renameSync(temp, DATA_FILE)
    cache = next
    return { ...next }
}

function getStatus() {
    return load().enabled === true
}

function setStatus(enabled, toggledBy = "system") {
    return save({
        ...load(),
        enabled: Boolean(enabled),
        lastToggled: new Date().toISOString(),
        toggledBy: String(toggledBy || "system"),
    })
}

function shouldProcessMessage(msg, options = {}) {
    return autoReplyScope.shouldRouteAutoReplyMessage(msg, {
        alreadyHandled: options.alreadyHandled === true,
        botEnabled: options.botEnabled !== false,
        autoReplyEnabled: getStatus(),
    })
}

function getScopeStatus() {
    const enabled = getStatus()
    return {
        enabled,
        global: enabled ? "ON" : "OFF",
        privateChat: enabled ? "ON" : "OFF",
        groupChat: "OFF",
        scope: "PRIVATE ONLY",
        forwarder: enabled ? "PRIVATE ONLY" : "OFF",
        keywordReply: enabled ? "PRIVATE ONLY" : "OFF",
        quotedBubble: process.env.AUTO_REPLY_QUOTED_BUBBLE !== "false",
        personalName: process.env.AUTO_REPLY_PERSONAL_NAME !== "false",
    }
}

module.exports = {
    DATA_FILE,
    getScopeStatus,
    getStatus,
    load,
    save,
    setStatus,
    shouldProcessMessage,
}
