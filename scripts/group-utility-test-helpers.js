"use strict"

const assert = require("assert")

const GROUP_JID = "120363000000000001@g.us"
const BOT_JID = "999999999999@s.whatsapp.net"
const OWNER_JID = "111111111111@s.whatsapp.net"
const ADMIN_JID = "222222222222@s.whatsapp.net"
const USER_LID = "333333333333@lid"
const USER_PN = "628333333333@s.whatsapp.net"
const USER_TWO = "628444444444@s.whatsapp.net"

function makeMetadata(options = {}) {
    const botAdmin = options.botAdmin !== false
    return {
        id: GROUP_JID,
        subject: "Test Group",
        announce: options.announce === true,
        participants: [
            { id: BOT_JID, admin: botAdmin ? "admin" : null },
            { id: OWNER_JID, admin: "superadmin" },
            { id: ADMIN_JID, admin: "admin" },
            { id: USER_LID, phoneNumber: USER_PN, admin: null },
            { id: USER_PN, lid: USER_LID, admin: null },
            { id: USER_TWO, admin: null },
        ],
    }
}

function makeRemote(options = {}) {
    const features = { ...(options.features || {}) }
    const configuredBotEnabled = options.botEnabled !== false
    return {
        getEffectiveGroupConfig() {
            return {
                configuredBotEnabled,
                botEnabled: configuredBotEnabled,
                botConfig: configuredBotEnabled ? "DEFAULT" : "OFF",
                features,
            }
        },
        isGroupBotEnabled() {
            return configuredBotEnabled
        },
        isGroupFeatureEnabled(jid, feature) {
            return configuredBotEnabled && features[feature] !== false
        },
    }
}

function makeSock(options = {}) {
    const calls = {
        send: [],
        settings: [],
        subjects: [],
        descriptions: [],
        pictures: [],
        participants: [],
        metadata: 0,
    }
    let metadata = options.metadata === undefined ? makeMetadata(options) : options.metadata
    const sock = {
        user: { id: `${BOT_JID.split("@")[0]}:1@s.whatsapp.net` },
        calls,
        setMetadata(value) { metadata = value },
        async groupMetadata() {
            calls.metadata += 1
            if (metadata instanceof Error) throw metadata
            return metadata
        },
        async sendMessage(jid, content, sendOptions) {
            calls.send.push({ jid, content, options: sendOptions })
            return { key: { id: `sent-${calls.send.length}`, remoteJid: jid, fromMe: true } }
        },
        async groupSettingUpdate(jid, setting) {
            calls.settings.push({ jid, setting })
        },
        async groupUpdateSubject(jid, subject) {
            calls.subjects.push({ jid, subject })
        },
        async groupUpdateDescription(jid, description) {
            calls.descriptions.push({ jid, description })
        },
        async updateProfilePicture(jid, buffer) {
            calls.pictures.push({ jid, buffer })
        },
        async groupParticipantsUpdate(jid, participants, action) {
            calls.participants.push({ jid, participants, action })
        },
    }
    return sock
}

function makeMsg(text, options = {}) {
    const participant = options.participant || ADMIN_JID
    const participantAlt = options.participantAlt || participant
    const contextInfo = {
        ...(options.quoted ? {
            stanzaId: options.quoted.id || "quoted-1",
            participant: options.quoted.participant || USER_LID,
            participantAlt: options.quoted.participantAlt || USER_PN,
            quotedMessage: options.quoted.message || { conversation: "quoted text" },
        } : {}),
        ...(options.mentions ? { mentionedJid: options.mentions } : {}),
    }
    const message = options.message || {
        extendedTextMessage: {
            text,
            contextInfo,
        },
    }
    return {
        key: {
            remoteJid: GROUP_JID,
            id: options.id || `msg-${Math.random().toString(16).slice(2)}`,
            participant,
            participantAlt,
            fromMe: options.fromMe === true,
        },
        pushName: options.pushName || "Tester",
        message,
    }
}

function makeContext(text, options = {}) {
    return {
        from: GROUP_JID,
        text,
        senderJid: options.senderJid || ADMIN_JID,
        sender: options.senderJid || ADMIN_JID,
        isGroup: true,
        isOwner: options.isOwner === true,
        canControlOwner: options.isOwner === true,
        ownerJid: OWNER_JID,
        isOwnerJid: jid => String(jid || "").split("@")[0] === OWNER_JID.split("@")[0],
        groupRemoteControl: options.remote || makeRemote(),
        lidAliasStore: options.lidAliasStore || {
            resolveBestJid(value) {
                return String(value || "").toLowerCase() === USER_LID ? USER_PN : value
            },
        },
        ...(options.extra || {}),
    }
}

function assertNoGroupEffects(sock, label) {
    assert.strictEqual(sock.calls.send.length, 0, `${label}: output harus nol`)
    assert.strictEqual(sock.calls.settings.length, 0, `${label}: setting mutation harus nol`)
    assert.strictEqual(sock.calls.subjects.length, 0, `${label}: subject mutation harus nol`)
    assert.strictEqual(sock.calls.descriptions.length, 0, `${label}: description mutation harus nol`)
    assert.strictEqual(sock.calls.pictures.length, 0, `${label}: picture mutation harus nol`)
    assert.strictEqual(sock.calls.participants.length, 0, `${label}: participant mutation harus nol`)
}

module.exports = {
    ADMIN_JID,
    BOT_JID,
    GROUP_JID,
    OWNER_JID,
    USER_LID,
    USER_PN,
    USER_TWO,
    assert,
    assertNoGroupEffects,
    makeContext,
    makeMetadata,
    makeMsg,
    makeRemote,
    makeSock,
}
