"use strict"

const path = require("path")
const { createAtomicJsonStore } = require("./atomicJsonStore")

const DATA_FILE = path.join(__dirname, "..", "data", "agentprivate", "state.json")
const MAX_CONTEXT = 24

const store = createAtomicJsonStore({
    filePath: DATA_FILE,
    envName: "PRIVATE_AGENT_STATE_FILE",
    label: "PRIVATE AGENT",
    defaultState: () => ({
        version: 1,
        contacts: {},
        sequence: 0,
    }),
})

function normalizeJid(value) {
    return String(value || "").trim().toLowerCase()
}

function jidNumber(value) {
    const clean = normalizeJid(value)
    const number = clean.split("@")[0].split(":")[0].replace(/[^0-9]/g, "")
    return number
}

function canonicalKey(value) {
    const number = jidNumber(value)
    return number ? number : normalizeJid(value)
}

function getState() {
    return store.snapshot()
}

function getContact(jid) {
    return getState().contacts?.[canonicalKey(jid)] || null
}

function isEnabled(jid) {
    return Boolean(getContact(jid)?.enabled)
}

function updateContact(jid, mutator) {
    const key = canonicalKey(jid)
    if (!key) throw new Error("JID kontak tidak valid")
    let updated = null
    store.update(state => {
        const current = state.contacts?.[key] || {
            jid: normalizeJid(jid),
            number: jidNumber(jid),
            name: "",
            profile: "",
            enabled: false,
            createdAt: null,
            updatedAt: null,
            context: [],
        }
        updated = {
            ...current,
            ...(typeof mutator === "function" ? (mutator({ ...current }) || {}) : {}),
            jid: normalizeJid(jid) || current.jid,
            number: jidNumber(jid) || current.number,
            updatedAt: new Date().toISOString(),
        }
        return {
            ...state,
            contacts: {
                ...(state.contacts || {}),
                [key]: updated,
            },
        }
    })
    return updated
}

function enableContact(jid, name = "", profile = "") {
    return updateContact(jid, current => ({
        ...current,
        name: String(name || current.name || "").slice(0, 100),
        profile: String(profile || current.profile || "").slice(0, 40),
        enabled: true,
        createdAt: current.createdAt || new Date().toISOString(),
    }))
}

function disableContact(jid) {
    const existing = getContact(jid)
    if (!existing) return false
    updateContact(jid, current => ({ ...current, enabled: false }))
    return true
}

function listContacts() {
    return Object.values(getState().contacts || {})
}

function addContextMessage(jid, role, text, reply = "") {
    const key = canonicalKey(jid)
    const cleanText = String(text || "").trim().slice(0, 1200)
    if (!key || !cleanText) return null
    let result = null
    store.update(state => {
        const current = state.contacts?.[key] || {
            jid: normalizeJid(jid),
            number: jidNumber(jid),
            name: "",
            profile: "",
            enabled: false,
            createdAt: null,
            updatedAt: null,
            context: [],
        }
        const now = Date.now()
        const old = Array.isArray(current.context) ? current.context : []
        const context = [...old, {
            role: role === "bot" ? "bot" : "user",
            text: cleanText,
            reply: String(reply || "").trim().slice(0, 1600),
            at: now,
        }].filter(item => Number.isFinite(Number(item.at || 0))).slice(-200)
        result = context
        return {
            ...state,
            contacts: {
                ...(state.contacts || {}),
                [key]: {
                    ...current,
                    context,
                    updatedAt: new Date().toISOString(),
                },
            },
        }
    })
    return result
}

function getContext(jid) {
    return getContact(jid)?.context || []
}

module.exports = {
    DATA_FILE,
    addContextMessage,
    canonicalKey,
    disableContact,
    enableContact,
    getContact,
    getContext,
    getState,
    isEnabled,
    jidNumber,
    listContacts,
    normalizeJid,
    store,
}
