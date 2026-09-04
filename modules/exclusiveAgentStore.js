"use strict"

const path = require("path")
const { createAtomicJsonStore } = require("./atomicJsonStore")

const DATA_FILE = path.join(__dirname, "..", "data", "exclusiveAgentState.json")

const store = createAtomicJsonStore({
    filePath: DATA_FILE,
    envName: "EXCLUSIVE_AGENT_STATE_FILE",
    label: "EXCLUSIVE AGENT",
    defaultState: () => ({
        version: 1,
        groups: {},
        groupMessages: {},
        reminderSubscriptions: {},
        settings: {
            timezone: "Asia/Jakarta",
            prayerLocation: null,
            prayerLeadMinutes: 0,
            fridayTime: "11:30",
        },
        sequence: 0,
    }),
})

function normalizeGroupJid(value) {
    const jid = String(value || "").trim().toLowerCase()
    return /@g\.us$/.test(jid) ? jid : ""
}

function getState() {
    return store.snapshot()
}

function getGroup(groupJid) {
    const jid = normalizeGroupJid(groupJid)
    if (!jid) return null
    return getState().groups?.[jid] || null
}

function isEnabled(groupJid) {
    return getGroup(groupJid)?.enabled === true
}

function updateGroup(groupJid, mutator, actor = "") {
    const jid = normalizeGroupJid(groupJid)
    if (!jid) throw new Error("Group JID tidak valid")
    const next = store.update(state => {
        const current = state.groups?.[jid] || {
            enabled: false,
            mode: "santai",
            replyChance: 0.45,
            enabledAt: null,
            enabledBy: "",
            updatedAt: null,
        }
        const changed = typeof mutator === "function" ? (mutator({ ...current }) || current) : current
        return {
            ...state,
            groups: {
                ...(state.groups || {}),
                [jid]: {
                    ...current,
                    ...changed,
                    updatedAt: new Date().toISOString(),
                    updatedBy: String(actor || "").slice(0, 120),
                },
            },
        }
    })
    return next.groups[jid]
}

function setEnabled(groupJid, enabled, actor = "") {
    return updateGroup(groupJid, current => ({
        ...current,
        enabled: Boolean(enabled),
        enabledAt: enabled ? (current.enabledAt || new Date().toISOString()) : current.enabledAt,
        enabledBy: enabled ? String(actor || "").slice(0, 120) : current.enabledBy,
    }), actor)
}

function setMode(groupJid, mode, actor = "") {
    const clean = String(mode || "").toLowerCase()
    if (!["santai", "rame"].includes(clean)) throw new Error("Mode tidak valid")
    return updateGroup(groupJid, current => ({
        ...current,
        mode: clean,
        replyChance: clean === "rame" ? 0.72 : 0.45,
    }), actor)
}

function appendGroupMessage(groupJid, message = {}) {
    const jid = normalizeGroupJid(groupJid)
    if (!jid || !isEnabled(jid)) return []
    const text = String(message.text || "").trim().slice(0, 1000)
    if (!text) return getState().groupMessages?.[jid] || []
    let nextMessages = []
    store.update(state => {
        const current = Array.isArray(state.groupMessages?.[jid]) ? state.groupMessages[jid] : []
        const now = Number(message.at || Date.now())
        nextMessages = [...current, {
            senderJid: String(message.senderJid || "").slice(0, 120),
            text,
            at: now,
        }].filter(item => Number.isFinite(Number(item.at || 0))).slice(-200)
        return {
            ...state,
            groupMessages: { ...(state.groupMessages || {}), [jid]: nextMessages },
        }
    })
    return nextMessages
}

function getGroupMessages(groupJid) {
    const jid = normalizeGroupJid(groupJid)
    if (!jid) return []
    const messages = getState().groupMessages?.[jid]
    return Array.isArray(messages) ? messages.slice(-200) : []
}

function getSettings() {
    return getState().settings || {}
}

function updateSettings(mutator) {
    return store.update(state => {
        const current = { ...(state.settings || {}) }
        const next = typeof mutator === "function" ? (mutator(current) || current) : current
        return { ...state, settings: { ...current, ...next } }
    }).settings
}

function setPrayerLocation(latitude, longitude, timezone = "Asia/Jakarta") {
    const lat = Number(latitude)
    const lon = Number(longitude)
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error("Latitude tidak valid")
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error("Longitude tidak valid")
    return updateSettings(current => ({
        ...current,
        timezone: String(timezone || current.timezone || "Asia/Jakarta"),
        prayerLocation: { latitude: lat, longitude: lon },
    }))
}

function nextSubscriptionId(state) {
    let sequence = Number(state.sequence || 0) + 1
    if (!Number.isSafeInteger(sequence) || sequence < 1) sequence = 1
    return { sequence, id: `ER${String(sequence).padStart(4, "0")}` }
}

function addReminderSubscription(subscription = {}) {
    let created = null
    store.update(state => {
        const next = nextSubscriptionId(state)
        created = {
            id: next.id,
            groupJid: normalizeGroupJid(subscription.groupJid),
            groupSubject: String(subscription.groupSubject || "").slice(0, 120),
            targets: Array.isArray(subscription.targets) ? subscription.targets.map(item => ({
                jid: String(item.jid || ""),
                number: String(item.number || ""),
                label: String(item.label || item.number || "").slice(0, 100),
            })) : [],
            enabled: true,
            fridayEnabled: subscription.fridayEnabled !== false,
            prayerEnabled: subscription.prayerEnabled !== false,
            createdAt: new Date().toISOString(),
            createdBy: String(subscription.createdBy || "").slice(0, 120),
            lastRuns: {},
        }
        if (!created.groupJid || !created.targets.length) throw new Error("Subscription tidak lengkap")
        return {
            ...state,
            sequence: next.sequence,
            reminderSubscriptions: {
                ...(state.reminderSubscriptions || {}),
                [created.id]: created,
            },
        }
    })
    return created
}

function updateSubscription(id, mutator) {
    const key = String(id || "").toUpperCase()
    let updated = null
    store.update(state => {
        const current = state.reminderSubscriptions?.[key]
        if (!current) return state
        updated = typeof mutator === "function" ? (mutator(JSON.parse(JSON.stringify(current))) || current) : current
        return {
            ...state,
            reminderSubscriptions: {
                ...(state.reminderSubscriptions || {}),
                [key]: updated,
            },
        }
    })
    return updated
}

function removeSubscription(id) {
    const key = String(id || "").toUpperCase()
    let removed = false
    store.update(state => {
        if (!state.reminderSubscriptions?.[key]) return state
        const next = { ...(state.reminderSubscriptions || {}) }
        delete next[key]
        removed = true
        return { ...state, reminderSubscriptions: next }
    })
    return removed
}

function listSubscriptions() {
    return Object.values(getState().reminderSubscriptions || {})
}

module.exports = {
    DATA_FILE,
    addReminderSubscription,
    appendGroupMessage,
    getGroup,
    getGroupMessages,
    getSettings,
    getState,
    isEnabled,
    listSubscriptions,
    normalizeGroupJid,
    removeSubscription,
    setEnabled,
    setMode,
    setPrayerLocation,
    store,
    updateGroup,
    updateSettings,
    updateSubscription,
}
