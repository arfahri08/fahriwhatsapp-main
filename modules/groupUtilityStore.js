"use strict"

const fs = require("fs")
const path = require("path")

const DATA_FILE = process.env.GROUP_UTILITY_STATE_FILE
    ? path.resolve(process.env.GROUP_UTILITY_STATE_FILE)
    : path.join(__dirname, "..", "data", "groupUtilityState.json")

let stateCache = null

function defaultState() {
    return { version: 1, groups: {} }
}

function isPlainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value))
}

function normalizeState(value) {
    const source = isPlainObject(value) ? value : {}
    return {
        ...source,
        version: Number.isFinite(Number(source.version)) ? Number(source.version) : 1,
        groups: isPlainObject(source.groups) ? source.groups : {},
    }
}

function loadState(options = {}) {
    if (stateCache && options.force !== true) return stateCache
    try {
        stateCache = normalizeState(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")))
    } catch (error) {
        if (error?.code !== "ENOENT") {
            console.log(`[GROUP UTILITY STORE] Gagal membaca state, memakai default: ${error?.message || error}`)
        }
        stateCache = defaultState()
    }
    return stateCache
}

function saveState(nextState = stateCache || defaultState()) {
    const normalized = normalizeState(nextState)
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
    const tempFile = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    try {
        fs.writeFileSync(tempFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
        fs.renameSync(tempFile, DATA_FILE)
    } catch (error) {
        try {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile)
        } catch {}
        throw error
    }
    stateCache = normalized
    return clone(normalized)
}

function normalizeGroupJid(value) {
    const jid = String(value || "").trim().toLowerCase()
    return jid.endsWith("@g.us") ? jid : ""
}

function getGroup(groupJid) {
    const jid = normalizeGroupJid(groupJid)
    if (!jid) return null
    return clone(loadState().groups[jid] || {})
}

function updateGroup(groupJid, mutator) {
    const jid = normalizeGroupJid(groupJid)
    if (!jid || typeof mutator !== "function") return null
    const state = loadState()
    const current = isPlainObject(state.groups[jid]) ? clone(state.groups[jid]) : {}
    const mutated = mutator(current)
    const next = isPlainObject(mutated) ? mutated : current
    state.groups[jid] = next
    saveState(state)
    return clone(next)
}

function getGroups() {
    return clone(loadState().groups)
}

function reloadState() {
    stateCache = null
    return clone(loadState({ force: true }))
}

function resetCache() {
    stateCache = null
}

module.exports = {
    DATA_FILE,
    defaultState,
    getGroup,
    getGroups,
    loadState,
    reloadState,
    resetCache,
    saveState,
    updateGroup,
}
