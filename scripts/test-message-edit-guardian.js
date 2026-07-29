"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "message-edit-guardian-test-"))
const stateFile = path.join(tempRoot, "messageEditGuardian.json")

process.env.EDIT_GUARD_DATA_FILE = stateFile
process.env.EDIT_GUARD_ENABLED = "true"
process.env.EDIT_GUARD_DEBUG = "false"
process.env.EDIT_GUARD_CACHE_TTL_MS = "100000"
process.env.EDIT_GUARD_CACHE_MAX = "2"
process.env.EDIT_GUARD_DEDUPE_TTL_MS = "86400000"
process.env.EDIT_GUARD_DEDUPE_MAX = "20"
process.env.EDIT_GUARD_LOG_MAX = "20"

const guardian = require("../modules/messageEditGuardian")

const GROUP = "120363000000000000@g.us"
const PRIVATE = "628111111111@s.whatsapp.net"
const SENDER = "628222222222@s.whatsapp.net"

function defaultState() {
    return {
        version: 1,
        global: { enabled: true, debug: false },
        groups: {},
        stats: {
            totalEditEvents: 0,
            processedEdits: 0,
            toxicEdits: 0,
            duplicateEdits: 0,
            skippedPrivate: 0,
            skippedBotOff: 0,
            skippedAntiToxicOff: 0,
            lastEventAt: null,
            lastToxicEditAt: null,
        },
        recent: [],
        dedupe: [],
    }
}

function resetState() {
    guardian.disposeMessageEditGuardian()
    guardian.saveState(defaultState())
}

function originalMessage(id, text, options = {}) {
    const message = options.message || { conversation: text }
    return {
        key: {
            remoteJid: options.remoteJid || GROUP,
            id,
            fromMe: Boolean(options.fromMe),
            participant: options.participant || SENDER,
        },
        participant: options.participant || SENDER,
        pushName: "Test User",
        messageTimestamp: 1700000000,
        message,
    }
}

function editUpdate(id, editedMessage, options = {}) {
    return {
        key: {
            remoteJid: options.remoteJid || GROUP,
            id,
            fromMe: Boolean(options.fromMe),
            participant: options.participant === undefined ? SENDER : options.participant,
        },
        update: {
            message: options.protocol
                ? {
                    protocolMessage: {
                        type: options.protocolType ?? 14,
                        editedMessage,
                    },
                }
                : {
                    editedMessage: {
                        message: editedMessage,
                    },
                },
            messageTimestamp: 1700000100,
        },
    }
}

function materializedEditUpdate(id, editedMessage, options = {}) {
    return {
        key: {
            remoteJid: options.remoteJid || GROUP,
            remoteJidAlt: options.remoteJidAlt,
            id,
            fromMe: Boolean(options.fromMe),
            participant: options.participant,
            participantAlt: options.participantAlt,
        },
        update: {
            // Bentuk nyata hasil process-message Baileys v7 untuk MESSAGE_EDIT:
            // konten baru langsung berada di update.message.
            message: editedMessage,
            messageTimestamp: 1700000100,
        },
    }
}

function makeContext(overrides = {}) {
    const counters = overrides.counters || { anti: 0, other: 0, logs: [] }
    if (!Array.isArray(counters.logs)) counters.logs = []
    return {
        now: overrides.now || 2000,
        sock: {
            async sendMessage(targetJid, outbound) {
                counters.logs.push({ targetJid, outbound })
                return { key: { id: `log-${counters.logs.length}`, remoteJid: targetJid, fromMe: true } }
            },
        },
        ownerJid: "628999999999@s.whatsapp.net",
        securityMediaLog: {
            getSecurityLogJid: () => "120363424006225997@g.us",
        },
        contactNameStore: {
            resolveContactName: () => "Nama Kontak Saya",
        },
        isBotSentMessageId: () => false,
        antiToxic: {
            async handleToxicCheck(msg) {
                counters.anti += 1
                const text = guardian.extractMessageText(msg.message)
                return /kasar|anjir/i.test(text)
            },
        },
        antiToxicControl: {
            shouldRunAntiToxic: () => overrides.antiControl !== false,
        },
        groupRemoteControl: {
            isGroupBotEnabled: () => overrides.botEnabled !== false,
            isGroupFeatureEnabled: (_jid, feature) => {
                if (feature === "antiToxic") return overrides.antiToxicEnabled !== false
                if (feature === "editGuardian") return overrides.remoteGuardianEnabled !== false
                counters.other += 1
                return true
            },
            isGroupAntiToxicPrivateReplyEnabled: () => false,
        },
        lidAliasStore: {
            resolveBestJid: value => value,
        },
        getMessage: overrides.getMessage,
        spotifyDownloader: () => { counters.other += 1 },
        localDownloader: () => { counters.other += 1 },
        autoReply: () => { counters.other += 1 },
        counters,
    }
}

async function run() {
    assert.equal(fs.existsSync(stateFile), false, "require must not write state")

    const arrayResult = await guardian.handleMessageUpdates([], makeContext())
    assert.deepEqual(arrayResult, [], "messages.update array normalization")

    assert.equal(guardian.normalizeMessageUpdate({
        key: { remoteJid: GROUP, id: "non-edit", participant: SENDER },
        update: { status: 3 },
    }), null, "non-edit update must be null")

    assert.equal(guardian.normalizeMessageUpdate(editUpdate(
        "delete",
        { conversation: "ignored" },
        { protocol: true, protocolType: 0 }
    )), null, "protocol delete must not be edit")

    const conversation = guardian.normalizeMessageUpdate(editUpdate("conversation", {
        conversation: "Edited conversation",
    }))
    assert.equal(conversation.editedText, "Edited conversation")

    const extended = guardian.normalizeMessageUpdate(editUpdate("extended", {
        extendedTextMessage: { text: "Edited extended text" },
    }))
    assert.equal(extended.editedText, "Edited extended text")

    const image = guardian.normalizeMessageUpdate(editUpdate("image", {
        imageMessage: { caption: "Edited image caption" },
    }))
    assert.equal(image.editedText, "Edited image caption")

    const video = guardian.normalizeMessageUpdate(editUpdate("video", {
        videoMessage: { caption: "Edited video caption" },
    }))
    assert.equal(video.editedText, "Edited video caption")

    const document = guardian.normalizeMessageUpdate(editUpdate("document", {
        documentMessage: { caption: "Edited document caption" },
    }))
    assert.equal(document.editedText, "Edited document caption")

    const protocol = guardian.normalizeMessageUpdate(editUpdate(
        "protocol",
        { conversation: "Protocol edit" },
        { protocol: true }
    ))
    assert.equal(protocol.editedText, "Protocol edit")

    const materialized = guardian.normalizeMessageUpdate(materializedEditUpdate(
        "materialized",
        { conversation: "Materialized direct edit" },
        { participant: SENDER }
    ))
    assert(materialized, "Baileys v7 direct update.message edit must normalize")
    assert.equal(materialized.editedText, "Materialized direct edit")

    const upsertEnvelope = {
        key: {
            remoteJid: GROUP,
            id: "edit-envelope-event",
            fromMe: false,
            participant: SENDER,
        },
        messageTimestamp: 1700000100,
        message: {
            protocolMessage: {
                type: 14,
                key: {
                    remoteJid: GROUP,
                    id: "upsert-original-id",
                    fromMe: false,
                    participant: SENDER,
                },
                editedMessage: {
                    conversation: "Edited through upsert",
                },
                timestampMs: 1700000100000,
            },
        },
    }
    const normalizedUpsert = guardian.normalizeEditUpsertMessage(upsertEnvelope)
    assert(normalizedUpsert, "messages.upsert protocol edit must normalize")
    assert.equal(normalizedUpsert.key.id, "upsert-original-id", "protocol key must point to original message id")
    assert.equal(guardian.isMessageEditUpsert(upsertEnvelope), true, "upsert edit envelope detector")

    const privateUpsertEnvelope = {
        key: { remoteJid: PRIVATE, id: "private-edit-event", fromMe: false },
        message: {
            protocolMessage: {
                type: 14,
                key: { remoteJid: PRIVATE, id: "private-original-id", fromMe: false },
                editedMessage: { conversation: "Private upsert edit" },
            },
        },
    }
    const normalizedPrivateUpsert = guardian.normalizeEditUpsertMessage(privateUpsertEnvelope)
    assert(normalizedPrivateUpsert, "private messages.upsert edit must normalize")
    assert.equal(normalizedPrivateUpsert.key.remoteJid, PRIVATE)
    assert.equal(normalizedPrivateUpsert.key.id, "private-original-id")

    const mixedGroupUpsert = {
        key: { remoteJid: GROUP, id: "mixed-edit-event", fromMe: false, participant: SENDER },
        message: {
            protocolMessage: {
                type: 14,
                key: { remoteJid: SENDER, id: "mixed-original-id", fromMe: false, participant: SENDER },
                editedMessage: { conversation: "Mixed group edit" },
            },
        },
    }
    const normalizedMixedGroup = guardian.normalizeEditUpsertMessage(mixedGroupUpsert)
    assert(normalizedMixedGroup, "group chat must survive mixed protocol PN key")
    assert.equal(normalizedMixedGroup.key.remoteJid, GROUP, "group JID must win over participant PN")

    resetState()
    guardian.rememberOriginalMessage(originalMessage("array-edit", "Original array text"), { now: 1000 })
    const arrayCounters = { anti: 0, other: 0 }
    const processedArray = await guardian.handleMessageUpdates([
        editUpdate("array-edit", { conversation: "Edited array text" }),
    ], makeContext({ counters: arrayCounters }))
    assert.equal(processedArray.length, 1, "messages.update array item count")
    assert.equal(processedArray[0].result, "clean", "messages.update array valid edit must process")
    assert.equal(arrayCounters.anti, 1, "messages.update array must call only Anti Kasar")
    assert.equal(arrayCounters.other, 0, "messages.update array must not call other routers")

    assert.equal(arrayCounters.logs.length, 1, "valid edit must send one security log")
    const editLog = arrayCounters.logs[0]
    assert.equal(editLog.targetJid, "120363424006225997@g.us", "edit log must use configured security log group")
    assert(editLog.outbound.text.includes("> ✏️ *JEJAK EDIT PESAN TERDETEKSI*"), "edit log title")
    assert(editLog.outbound.text.includes("Pengirim: @628222222222 (Nama Kontak Saya)"), "sender mention and saved contact name")
    assert(editLog.outbound.text.includes("Pesan lama:\nOriginal array text"), "old message must be present")
    assert(editLog.outbound.text.includes("Pesan baru:\n*Edited array text*"), "new message must be bold")
    assert.deepEqual(editLog.outbound.mentions, [SENDER], "sender must be mentioned")

    const duplicateLogResult = await guardian.handleMessageEditUpdate(
        editUpdate("array-edit", { conversation: "Edited array text" }),
        makeContext({ counters: arrayCounters, now: 2100 })
    )
    assert.equal(duplicateLogResult.result, "duplicate", "duplicate edit log must be deduped")
    assert.equal(arrayCounters.logs.length, 1, "duplicate edit must not send another log")

    resetState()
    guardian.rememberOriginalMessage(originalMessage("upsert-original-id", "Original from upsert"), { now: 1000 })
    const upsertCounters = { anti: 0, other: 0, logs: [] }
    const upsertResult = await guardian.handleMessageEditUpsert(
        upsertEnvelope,
        makeContext({ counters: upsertCounters, botEnabled: false })
    )
    assert.equal(upsertResult.logSent, true, "messages.upsert edit must send security log")
    assert.equal(upsertCounters.logs.length, 1, "messages.upsert edit sends exactly one log")
    assert(upsertCounters.logs[0].outbound.text.includes("Original from upsert"), "upsert edit log keeps old text")
    assert(upsertCounters.logs[0].outbound.text.includes("*Edited through upsert*"), "upsert edit log keeps new text")
    assert.equal(upsertCounters.anti, 0, "Bot OFF upsert source skips moderation only")

    resetState()
    guardian.rememberOriginalMessage(originalMessage("same", "Halo semuanya"), { now: 1000 })
    let counters = { anti: 0, other: 0 }
    let result = await guardian.handleMessageEditUpdate(
        editUpdate("same", { conversation: "Halo semuanya" }),
        makeContext({ counters })
    )
    assert.equal(result.result, "skipped", "same text must skip")
    assert.equal(counters.anti, 0)

    guardian.rememberOriginalMessage(originalMessage("space", "Halo semuanya"), { now: 1000 })
    result = await guardian.handleMessageEditUpdate(
        editUpdate("space", { conversation: "  HALO   semuanya  " }),
        makeContext({ counters })
    )
    assert.equal(result.result, "skipped", "whitespace-only edit must skip")
    assert.equal(counters.anti, 0)

    resetState()
    counters = { anti: 0, other: 0, logs: [] }
    guardian.rememberOriginalMessage(originalMessage("private", "Private original", {
        remoteJid: PRIVATE,
        participant: PRIVATE,
    }), { now: 1000, senderJid: PRIVATE })
    result = await guardian.handleMessageEditUpdate(
        materializedEditUpdate("private", { conversation: "Private edit" }, { remoteJid: PRIVATE }),
        makeContext({ counters })
    )
    assert.equal(result.result, "skipped", "private edit must be logged without moderation")
    assert.equal(result.logSent, true, "private edit must send security log")
    assert.equal(counters.logs.length, 1, "private edit sends exactly one log")
    assert(counters.logs[0].outbound.text.includes("Private original"), "private old text must be logged")
    assert(counters.logs[0].outbound.text.includes("*Private edit*"), "private new text must be logged")
    assert.equal(counters.anti, 0, "private edit must not run Anti Kasar")

    resetState()
    counters = { anti: 0, other: 0, logs: [] }
    guardian.rememberOriginalMessage(originalMessage("direct-group", "Direct original"), { now: 1000 })
    result = await guardian.handleMessageEditUpdate(
        materializedEditUpdate("direct-group", { conversation: "Direct edited" }, { participant: SENDER }),
        makeContext({ counters })
    )
    assert.equal(result.logSent, true, "materialized group edit must send log")
    assert.equal(counters.logs.length, 1, "materialized group edit sends one log")
    assert.equal(counters.anti, 1, "materialized group edit still checks Anti Kasar")

    resetState()
    counters = { anti: 0, other: 0, logs: [] }
    guardian.rememberOriginalMessage(originalMessage("from-me", "Initial", {
        fromMe: true,
        participant: "628999999999@s.whatsapp.net",
    }), { now: 1000 })
    const ownerLogBefore = counters.logs.length
    result = await guardian.handleMessageEditUpdate(
        editUpdate("from-me", { conversation: "kasar" }, {
            fromMe: true,
            participant: "628999999999@s.whatsapp.net",
        }),
        makeContext({ counters })
    )
    assert.equal(result.result, "skipped", "fromMe edit must skip moderation")
    assert.equal(result.logSent, true, "manual owner group edit should still be logged")
    assert.equal(counters.logs.length, ownerLogBefore + 1, "owner edit sends exactly one log")
    assert.equal(counters.anti, 0)

    guardian.rememberOriginalMessage(originalMessage("bot-off", "Initial"), { now: 1000 })
    const botOffLogsBefore = counters.logs.length
    result = await guardian.handleMessageEditUpdate(
        editUpdate("bot-off", { conversation: "kasar" }),
        makeContext({ counters, botEnabled: false })
    )
    assert.equal(result.result, "skipped", "Bot OFF must skip moderation")
    assert.equal(result.logSent, true, "Bot OFF source group must still send edit log")
    assert.equal(counters.logs.length, botOffLogsBefore + 1, "Bot OFF source group sends exactly one edit log")
    assert.equal(counters.anti, 0)

    guardian.rememberOriginalMessage(originalMessage("anti-off", "Initial"), { now: 1000 })
    result = await guardian.handleMessageEditUpdate(
        editUpdate("anti-off", { conversation: "kasar" }),
        makeContext({ counters, antiToxicEnabled: false })
    )
    assert.equal(result.result, "skipped", "Anti Kasar OFF must skip")
    assert.equal(counters.anti, 0)

    guardian.rememberOriginalMessage(originalMessage("anti-control-off", "Initial"), { now: 1000 })
    result = await guardian.handleMessageEditUpdate(
        editUpdate("anti-control-off", { conversation: "kasar" }),
        makeContext({ counters, antiControl: false })
    )
    assert.equal(result.result, "skipped", "Anti Kasar control OFF/silent must skip")
    assert.equal(counters.anti, 0)

    let state = guardian.loadState()
    state.global.enabled = false
    guardian.saveState(state)
    guardian.rememberOriginalMessage(originalMessage("guardian-off", "Initial"), { now: 1000 })
    result = await guardian.handleMessageEditUpdate(
        editUpdate("guardian-off", { conversation: "kasar" }),
        makeContext({ counters })
    )
    assert.equal(result.result, "skipped", "Guardian OFF must skip")
    assert.equal(counters.anti, 0)
    state.global.enabled = true
    guardian.saveState(state)

    guardian.rememberOriginalMessage(originalMessage("unique", "Initial safe"), { now: 1000 })
    result = await guardian.handleMessageEditUpdate(
        editUpdate("unique", { conversation: "pesan kasar" }),
        makeContext({ counters })
    )
    assert.equal(result.result, "toxic", "unique toxic edit must process")
    assert.equal(counters.anti, 1, "Anti Kasar must be called once")
    assert.equal(counters.other, 0, "other routers must never run")

    result = await guardian.handleMessageEditUpdate(
        editUpdate("unique", { conversation: "pesan kasar" }),
        makeContext({ counters, now: 2100 })
    )
    assert.equal(result.result, "duplicate", "duplicate hash must skip")
    assert.equal(counters.anti, 1)

    result = await guardian.handleMessageEditUpdate(
        editUpdate("unique", { conversation: "anjir versi kedua" }),
        makeContext({ counters, now: 2200 })
    )
    assert.equal(result.result, "toxic", "second distinct edit must process")
    assert.equal(counters.anti, 2)
    assert.equal(counters.other, 0)

    guardian.rememberOriginalMessage(originalMessage("link", "Initial"), { now: 1000 })
    result = await guardian.handleMessageEditUpdate(
        editUpdate("link", { conversation: "https://youtube.com/watch?v=test" }),
        makeContext({ counters, now: 2300 })
    )
    assert.equal(result.result, "clean", "link-only edit must be clean")
    assert.equal(counters.other, 0, "link edit must not call downloader")

    guardian.rememberOriginalMessage(originalMessage("toxic-link", "Initial"), { now: 1000 })
    result = await guardian.handleMessageEditUpdate(
        editUpdate("toxic-link", { conversation: "anjir https://youtube.com/watch?v=test" }),
        makeContext({ counters, now: 2400 })
    )
    assert.equal(result.result, "toxic", "toxic plus link uses only Anti Kasar")
    assert.equal(counters.other, 0)

    guardian.rememberOriginalMessage(originalMessage("command", "Initial"), { now: 1000 })
    result = await guardian.handleMessageEditUpdate(
        editUpdate("command", { conversation: ".help" }),
        makeContext({ counters, now: 2500 })
    )
    assert.equal(result.result, "skipped", "edited command must skip")
    assert.equal(counters.other, 0)

    guardian.disposeMessageEditGuardian()
    guardian.rememberOriginalMessage(originalMessage("expire", "Expire me"), { now: 1000 })
    guardian.cleanupMessageEditCache(101001)
    assert.equal(guardian.getMessageEditGuardianHealth().cacheSize, 0, "expired cache must be removed")

    guardian.disposeMessageEditGuardian()
    guardian.rememberOriginalMessage(originalMessage("evict-1", "One"), { now: 1000 })
    guardian.rememberOriginalMessage(originalMessage("evict-2", "Two"), { now: 1001 })
    guardian.rememberOriginalMessage(originalMessage("evict-3", "Three"), { now: 1002 })
    assert.equal(guardian.cleanupMessageEditCache(1003).cacheSize, 2, "cache max eviction")

    const persistentText = fs.readFileSync(stateFile, "utf8")
    assert(!persistentText.includes("Initial safe"), "original text must not persist")
    assert(!persistentText.includes("anjir versi kedua"), "edited text must not persist")
    assert(!persistentText.includes("youtube.com"), "link text must not persist")

    guardian.disposeMessageEditGuardian()
    fs.writeFileSync(stateFile, "{not valid json", "utf8")
    const recovered = guardian.loadState()
    assert.equal(recovered.version, 1, "corrupt JSON must recover")
    assert(fs.readdirSync(tempRoot).some(name => /^messageEditGuardian\.corrupt\.\d+\.json$/.test(name)), "corrupt backup must exist")

    console.log("MESSAGE_EDIT_GUARDIAN_TESTS_OK")
}

run()
    .catch(error => {
        console.error(error)
        process.exitCode = 1
    })
    .finally(() => {
        guardian.disposeMessageEditGuardian()
        const resolvedTemp = path.resolve(tempRoot)
        const resolvedBase = path.resolve(os.tmpdir())
        if (resolvedTemp.startsWith(resolvedBase + path.sep)) {
            fs.rmSync(resolvedTemp, { recursive: true, force: true })
        }
    })
