"use strict"

const learnedBotIdentities = new Set()
const MAX_LEARNED_BOT_IDENTITIES = 32

function normalizeJid(value) {
    return String(value || "").trim().toLowerCase()
}

function isGroupJid(value) {
    return normalizeJid(value).endsWith("@g.us")
}

function jidUser(value) {
    return normalizeJid(value).split("@")[0].split(":")[0]
}

function unique(values = []) {
    return [...new Set((Array.isArray(values) ? values : [values]).map(normalizeJid).filter(Boolean))]
}

function normalizeParticipantCandidates(participant) {
    if (!participant) return []
    if (typeof participant === "string") return [normalizeJid(participant)]
    return unique([
        participant.id,
        participant.jid,
        participant.lid,
        participant.phoneNumber,
        participant.pn,
    ])
}

function participantMatches(participant, candidates = []) {
    const candidateUsers = new Set(unique(candidates).map(jidUser).filter(Boolean))
    return normalizeParticipantCandidates(participant).some(value => candidateUsers.has(jidUser(value)))
}

function isAdminParticipant(participant) {
    return ["admin", "superadmin"].includes(String(participant?.admin || "").toLowerCase())
}

function getBotIdentityCandidates(sock, extraCandidates = []) {
    return unique([
        sock?.user?.id,
        sock?.user?.lid,
        sock?.user?.jid,
        sock?.user?.phoneNumber,
        sock?.user?.pn,
        sock?.authState?.creds?.me?.id,
        sock?.authState?.creds?.me?.lid,
        sock?.authState?.creds?.me?.phoneNumber,
        sock?.authState?.creds?.me?.pn,
        ...learnedBotIdentities,
        ...(Array.isArray(extraCandidates) ? extraCandidates : [extraCandidates]),
    ])
}

function rememberBotIdentityCandidates(sock, messageOrMsg) {
    const msg = messageOrMsg?.key ? messageOrMsg : { key: messageOrMsg || {} }
    const key = msg?.key || {}
    if (key.fromMe !== true) return getBotIdentityCandidates(sock)

    for (const candidate of unique([
        key.participant,
        key.participantAlt,
        msg?.participant,
        msg?.participantAlt,
    ])) {
        learnedBotIdentities.delete(candidate)
        learnedBotIdentities.add(candidate)
    }
    while (learnedBotIdentities.size > MAX_LEARNED_BOT_IDENTITIES) {
        const oldest = learnedBotIdentities.values().next().value
        if (!oldest) break
        learnedBotIdentities.delete(oldest)
    }
    return getBotIdentityCandidates(sock)
}

function getBotParticipant(metadata, sock, extraCandidates = []) {
    const identities = getBotIdentityCandidates(sock, extraCandidates)
    return (metadata?.participants || []).find(participant => participantMatches(participant, identities)) || null
}

function isBotAdmin(metadata, sock, extraCandidates = []) {
    return isAdminParticipant(getBotParticipant(metadata, sock, extraCandidates))
}

function getConfiguredGroupState(groupRemoteControl, groupJid, featureName = "") {
    let config = null
    try {
        config = groupRemoteControl?.getEffectiveGroupConfig?.(groupJid) || null
    } catch {}

    let configuredBotEnabled = config?.configuredBotEnabled
    if (typeof configuredBotEnabled !== "boolean") {
        if (typeof config?.botEnabled === "boolean") configuredBotEnabled = config.botEnabled
        else {
            try {
                configuredBotEnabled = groupRemoteControl?.isGroupBotEnabled?.(groupJid) !== false
            } catch {
                configuredBotEnabled = true
            }
        }
    }

    let configuredFeatureEnabled = true
    if (featureName) {
        if (config?.features && typeof config.features[featureName] === "boolean") {
            configuredFeatureEnabled = config.features[featureName]
        } else if (typeof groupRemoteControl?.isGroupFeatureEnabled === "function") {
            try {
                configuredFeatureEnabled = groupRemoteControl.isGroupFeatureEnabled(groupJid, featureName) !== false
            } catch {
                configuredFeatureEnabled = false
            }
        }
    }

    return {
        config,
        configuredBotEnabled,
        configuredFeatureEnabled,
        botConfig: config?.botConfig || (configuredBotEnabled ? "DEFAULT" : "OFF"),
    }
}

async function resolveGroupRuntimePolicy(sock, groupJid, options = {}) {
    const jid = normalizeJid(groupJid)
    const featureName = String(options.featureName || options.feature || "").trim()
    const configured = getConfiguredGroupState(options.groupRemoteControl, jid, featureName)
    if (!isGroupJid(jid)) {
        return {
            allowed: false,
            reason: "not-group",
            groupJid: jid,
            featureName,
            ...configured,
            metadata: null,
            metadataAvailable: false,
            botAdmin: false,
            effectiveBotEnabled: false,
            effectiveFeatureEnabled: false,
        }
    }

    let metadata = null
    let metadataError = null
    if (Object.prototype.hasOwnProperty.call(options, "metadata")) {
        metadata = options.metadata
    } else {
        try {
            const metadataResolver = typeof options.getGroupMetadata === "function"
                ? options.getGroupMetadata
                : (typeof sock?.__resolveGroupMetadataForRuntimePolicy === "function"
                    ? sock.__resolveGroupMetadataForRuntimePolicy.bind(sock)
                    : sock?.groupMetadata?.bind(sock))
            metadata = await metadataResolver?.(jid)
        } catch (error) {
            metadataError = error
        }
    }

    const metadataAvailable = Boolean(metadata && Array.isArray(metadata.participants))
    const botAdmin = metadataAvailable && isBotAdmin(metadata, sock, options.extraIdentityCandidates)
    const effectiveBotEnabled = Boolean(
        metadataAvailable
        && botAdmin
        && configured.configuredBotEnabled
    )
    const effectiveFeatureEnabled = Boolean(
        effectiveBotEnabled
        && (!featureName || configured.configuredFeatureEnabled)
    )

    let reason = "allowed"
    if (!metadataAvailable) reason = "metadata-unavailable"
    else if (!botAdmin) reason = "bot-not-admin"
    else if (!configured.configuredBotEnabled) reason = "group-bot-off"
    else if (featureName && !configured.configuredFeatureEnabled) reason = `${featureName}-off`

    return {
        allowed: effectiveFeatureEnabled,
        reason,
        groupJid: jid,
        featureName,
        ...configured,
        metadata,
        metadataAvailable,
        metadataError,
        botAdmin,
        effectiveBotEnabled,
        effectiveFeatureEnabled,
    }
}

module.exports = {
    getBotIdentityCandidates,
    getBotParticipant,
    isAdminParticipant,
    isBotAdmin,
    isGroupJid,
    jidUser,
    normalizeJid,
    normalizeParticipantCandidates,
    participantMatches,
    rememberBotIdentityCandidates,
    resolveGroupRuntimePolicy,
}
