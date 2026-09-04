"use strict"

const groupRuntimePolicy = require("./groupRuntimePolicy")
const defaultGroupRemoteControl = require("./groupRemoteControl")
const defaultLidAliasStore = require("./lidAliasStore")

const MEDIA_TYPES = ["imageMessage", "videoMessage", "audioMessage", "stickerMessage", "documentMessage"]

function unique(values = []) {
    return [...new Set((Array.isArray(values) ? values : [values]).map(value => String(value || "").trim().toLowerCase()).filter(Boolean))]
}

function unwrapMessage(message) {
    let current = message || {}
    for (let index = 0; index < 8; index += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message
        else break
    }
    return current || {}
}

function getContextInfo(msg) {
    const message = unwrapMessage(msg?.message || msg || {})
    return message.extendedTextMessage?.contextInfo
        || message.imageMessage?.contextInfo
        || message.videoMessage?.contextInfo
        || message.audioMessage?.contextInfo
        || message.stickerMessage?.contextInfo
        || message.documentMessage?.contextInfo
        || {}
}

function getSenderCandidates(msg, explicitSender = "") {
    return unique([
        explicitSender,
        msg?.key?.participant,
        msg?.key?.participantAlt,
        msg?.participant,
        msg?.participantAlt,
    ])
}

function getParticipantCandidates(participant) {
    return groupRuntimePolicy.normalizeParticipantCandidates(participant)
}

function getAliasStore(context = {}) {
    return context.lidAliasStore || defaultLidAliasStore
}

function resolveAlias(value, context = {}) {
    const jid = String(value || "").trim().toLowerCase()
    if (!jid) return ""
    try {
        return String(getAliasStore(context)?.resolveBestJid?.(jid) || jid).trim().toLowerCase()
    } catch {
        return jid
    }
}

function identityKey(values, context = {}) {
    const candidates = unique(values)
    const resolved = unique(candidates.map(value => resolveAlias(value, context)))
    const pn = [...resolved, ...candidates].find(value => value.endsWith("@s.whatsapp.net"))
    if (pn) return `pn:${groupRuntimePolicy.jidUser(pn)}`
    const lid = [...resolved, ...candidates].find(value => value.endsWith("@lid"))
    if (lid) return `lid:${groupRuntimePolicy.jidUser(lid)}`
    const first = resolved[0] || candidates[0]
    return first ? `jid:${first}` : ""
}

function participantIdentityKey(participant, context = {}, extraCandidates = []) {
    return identityKey([...getParticipantCandidates(participant), ...unique(extraCandidates)], context)
}

function findParticipant(metadata, candidates = [], context = {}) {
    const direct = (metadata?.participants || []).find(participant => groupRuntimePolicy.participantMatches(participant, candidates))
    if (direct) return direct
    const wantedKey = identityKey(candidates, context)
    if (!wantedKey) return null
    return (metadata?.participants || []).find(participant => participantIdentityKey(participant, context) === wantedKey) || null
}

function isSenderAdmin(metadata, msg, senderJid = "", context = {}) {
    if (context.canControlOwner || context.isOwner) return true
    return groupRuntimePolicy.isAdminParticipant(findParticipant(metadata, getSenderCandidates(msg, senderJid), context))
}

function getPreferredJid(participant, context = {}, options = {}) {
    const candidates = getParticipantCandidates(participant)
    const preferredPn = candidates
        .map(value => resolveAlias(value, context))
        .find(value => value.endsWith("@s.whatsapp.net"))
        || candidates.find(value => value.endsWith("@s.whatsapp.net"))
    if (options.forMutation) {
        return String(participant?.id || participant?.jid || preferredPn || candidates[0] || "").trim().toLowerCase()
    }
    return preferredPn || candidates[0] || ""
}

function dedupeParticipants(metadata, context = {}, options = {}) {
    const botCandidates = options.sock ? groupRuntimePolicy.getBotIdentityCandidates(options.sock) : []
    const seen = new Set()
    const result = []
    for (const participant of metadata?.participants || []) {
        if (options.omitBot !== false && botCandidates.length && groupRuntimePolicy.participantMatches(participant, botCandidates)) continue
        const key = participantIdentityKey(participant, context)
        const jid = getPreferredJid(participant, context, options)
        if (!key || !jid || seen.has(key)) continue
        seen.add(key)
        result.push({ participant, key, jid })
    }
    return result
}

async function resolveFeaturePolicy(sock, groupJid, featureName, context = {}, options = {}) {
    const policyOptions = {
        groupRemoteControl: context.groupRemoteControl || defaultGroupRemoteControl,
        featureName,
        extraIdentityCandidates: options.extraIdentityCandidates,
    }
    if (Object.prototype.hasOwnProperty.call(options, "metadata")) policyOptions.metadata = options.metadata
    if (typeof options.getGroupMetadata === "function") policyOptions.getGroupMetadata = options.getGroupMetadata
    return groupRuntimePolicy.resolveGroupRuntimePolicy(sock, groupJid, policyOptions)
}

async function resolveCommandAccess(sock, msg, featureName, context = {}, options = {}) {
    const groupJid = groupRuntimePolicy.normalizeJid(context.from || msg?.key?.remoteJid)
    const policy = await resolveFeaturePolicy(sock, groupJid, featureName, context, options)
    if (!policy.allowed) return { allowed: false, hardDenied: true, groupJid, policy, senderAllowed: false }
    const senderJid = groupRuntimePolicy.normalizeJid(context.senderJid || context.sender || msg?.key?.participantAlt || msg?.key?.participant)
    const senderAllowed = options.allowAnySender === true || isSenderAdmin(policy.metadata, msg, senderJid, context)
    return { allowed: senderAllowed, hardDenied: false, groupJid, policy, senderAllowed, senderJid }
}

function resolveTargetParticipant(metadata, msg, context = {}, explicitCandidates = []) {
    const info = getContextInfo(msg)
    const candidates = unique([
        ...(Array.isArray(info.mentionedJid) ? info.mentionedJid : []),
        info.participantAlt,
        info.participant,
        ...explicitCandidates,
    ])
    const participant = findParticipant(metadata, candidates, context)
    return participant ? {
        participant,
        candidates,
        key: participantIdentityKey(participant, context, candidates),
        jid: getPreferredJid(participant, context),
        mutationJid: getPreferredJid(participant, context, { forMutation: true }),
    } : null
}

function getQuotedTarget(msg) {
    const info = getContextInfo(msg)
    const quotedMessage = unwrapMessage(info.quotedMessage || {})
    if (!info.stanzaId || !Object.keys(quotedMessage).length) return null
    return {
        key: {
            remoteJid: msg?.key?.remoteJid,
            id: info.stanzaId,
            participant: info.participant,
            participantAlt: info.participantAlt,
            fromMe: Boolean(info.participant && groupRuntimePolicy.jidUser(info.participant) === groupRuntimePolicy.jidUser(msg?.key?.participant) && msg?.key?.fromMe),
        },
        message: quotedMessage,
    }
}

function getMediaDescriptor(msg, options = {}) {
    const direct = unwrapMessage(msg?.message || {})
    const quotedTarget = getQuotedTarget(msg)
    const quoted = quotedTarget?.message || {}
    const source = options.preferQuoted !== false && MEDIA_TYPES.some(type => quoted[type]) ? quoted : direct
    const target = source === quoted ? quotedTarget : msg
    const type = MEDIA_TYPES.find(item => source[item])
    if (!type) return null
    return { type, media: source[type], target }
}

async function downloadMedia(sock, descriptor, context = {}) {
    if (!descriptor?.target) throw new Error("Media tidak ditemukan")
    if (typeof context.downloadMedia === "function") return context.downloadMedia(descriptor.target, descriptor)
    const baileys = context.baileys || require("@whiskeysockets/baileys")
    if (typeof baileys.downloadMediaMessage !== "function") throw new Error("downloadMediaMessage tidak tersedia")
    return baileys.downloadMediaMessage(descriptor.target, "buffer", {}, {
        reuploadRequest: sock?.updateMediaMessage,
    })
}

function extractTextFromMessage(message) {
    const content = unwrapMessage(message || {})
    return String(
        content.conversation
        || content.extendedTextMessage?.text
        || content.imageMessage?.caption
        || content.videoMessage?.caption
        || content.documentMessage?.caption
        || ""
    ).trim()
}

function extractQuotedText(msg) {
    return extractTextFromMessage(getQuotedTarget(msg)?.message)
}

function isProtectedParticipant(participant, sock, context = {}) {
    if (!participant) return true
    if (groupRuntimePolicy.isAdminParticipant(participant)) return true
    if (groupRuntimePolicy.participantMatches(participant, groupRuntimePolicy.getBotIdentityCandidates(sock))) return true
    const candidates = getParticipantCandidates(participant)
    if (typeof context.isOwnerJid === "function" && candidates.some(candidate => context.isOwnerJid(candidate))) return true
    const ownerCandidates = unique([context.ownerJid, ...(Array.isArray(context.ownerJids) ? context.ownerJids : [])])
    return ownerCandidates.length > 0 && groupRuntimePolicy.participantMatches(participant, ownerCandidates)
}

module.exports = {
    MEDIA_TYPES,
    dedupeParticipants,
    downloadMedia,
    extractQuotedText,
    extractTextFromMessage,
    findParticipant,
    getAliasStore,
    getContextInfo,
    getMediaDescriptor,
    getParticipantCandidates,
    getPreferredJid,
    getQuotedTarget,
    getSenderCandidates,
    identityKey,
    isProtectedParticipant,
    isSenderAdmin,
    participantIdentityKey,
    resolveCommandAccess,
    resolveFeaturePolicy,
    resolveTargetParticipant,
    unique,
    unwrapMessage,
}
