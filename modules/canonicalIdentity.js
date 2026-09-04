"use strict"

const groupRuntimePolicy = require("./groupRuntimePolicy")
const defaultLidAliasStore = require("./lidAliasStore")

function normalizeJid(value) {
    return groupRuntimePolicy.normalizeJid(value)
}

function unique(values = []) {
    return [...new Set((Array.isArray(values) ? values : [values]).map(normalizeJid).filter(Boolean))]
}

function aliasStore(context = {}) {
    return context.lidAliasStore || defaultLidAliasStore
}

function resolveBestJid(value, context = {}) {
    const jid = normalizeJid(value)
    if (!jid) return ""
    try {
        return normalizeJid(aliasStore(context)?.resolveBestJid?.(jid) || jid)
    } catch {
        return jid
    }
}

function normalizePhoneNumber(value) {
    let number = String(value || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "")
    if (number.startsWith("0")) number = `62${number.slice(1)}`
    else if (number.startsWith("8")) number = `62${number}`
    return number.length >= 9 && number.length <= 16 ? number : ""
}

function normalizePhoneJid(value, context = {}) {
    const resolved = resolveBestJid(value, context)
    if (resolved.endsWith("@lid")) return ""
    const number = normalizePhoneNumber(resolved || value)
    return number ? `${number}@s.whatsapp.net` : ""
}

function canonicalIdentity(values, context = {}) {
    const raw = unique(values)
    const resolved = unique(raw.map(value => resolveBestJid(value, context)))
    const pn = [...resolved, ...raw].find(value => value.endsWith("@s.whatsapp.net"))
    if (pn) {
        const number = normalizePhoneNumber(pn)
        if (number) return { key: `pn:${number}`, jid: `${number}@s.whatsapp.net`, type: "pn", number, candidates: unique([...raw, ...resolved]) }
    }
    const lid = [...resolved, ...raw].find(value => value.endsWith("@lid"))
    if (lid) {
        const number = groupRuntimePolicy.jidUser(lid)
        return { key: `lid:${number}`, jid: lid, type: "lid", number, candidates: unique([...raw, ...resolved]) }
    }
    const phone = normalizePhoneNumber(raw[0])
    if (phone) return { key: `pn:${phone}`, jid: `${phone}@s.whatsapp.net`, type: "pn", number: phone, candidates: raw }
    return { key: "", jid: "", type: "unknown", number: "", candidates: raw }
}

function participantIdentity(participant, context = {}, extra = []) {
    return canonicalIdentity([
        ...groupRuntimePolicy.normalizeParticipantCandidates(participant),
        ...(Array.isArray(extra) ? extra : [extra]),
    ], context)
}

function senderIdentity(msg, context = {}) {
    return canonicalIdentity([
        context.senderJid,
        context.sender,
        msg?.key?.participantAlt,
        msg?.key?.participant,
        msg?.participantAlt,
        msg?.participant,
        msg?.key?.remoteJidAlt,
        msg?.key?.remoteJid,
    ], context)
}

function mergeCanonicalRecords(records = {}, identity) {
    if (!identity?.key) return { records, key: "" }
    const next = { ...(records || {}) }
    if (next[identity.key]) return { records: next, key: identity.key }
    const aliasKeys = Object.keys(next).filter(key => {
        const entry = next[key]
        const entryIdentity = canonicalIdentity([entry?.jid, ...(entry?.aliases || [])])
        return entryIdentity.key && entryIdentity.key === identity.key
    })
    if (!aliasKeys.length) return { records: next, key: identity.key }
    const first = aliasKeys.shift()
    next[identity.key] = { ...next[first], jid: identity.jid, aliases: unique([...(next[first]?.aliases || []), ...identity.candidates]) }
    delete next[first]
    for (const key of aliasKeys) delete next[key]
    return { records: next, key: identity.key }
}

module.exports = {
    canonicalIdentity,
    mergeCanonicalRecords,
    normalizeJid,
    normalizePhoneJid,
    normalizePhoneNumber,
    participantIdentity,
    resolveBestJid,
    senderIdentity,
    unique,
}
