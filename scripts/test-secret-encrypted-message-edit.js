"use strict"

const assert = require("assert")
const crypto = require("crypto")
const { EventEmitter } = require("events")
const bridge = require("../modules/messageEditRuntimeBridge")
const secretEdit = require("../modules/secretEncryptedEdit")

function extractText(message) {
    let current = message || {}
    for (let i = 0; i < 8; i += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current.editedMessage?.message) current = current.editedMessage.message
        else break
    }
    return String(current.conversation || current.extendedTextMessage?.text || "").trim()
}

function encodeMessage(message) {
    return Buffer.from(JSON.stringify(message), "utf8")
}

function encryptEdit({ messageSecret, originalMessageId, originalSender, modificationSender, editedMessage }) {
    const key = secretEdit.deriveMessageEditKey(
        messageSecret,
        originalMessageId,
        originalSender,
        modificationSender
    )
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
    const ciphertext = Buffer.concat([cipher.update(encodeMessage(editedMessage)), cipher.final()])
    return {
        encIv: iv,
        encPayload: Buffer.concat([ciphertext, cipher.getAuthTag()]),
    }
}

function makeHarness() {
    const contentById = new Map()
    const sentLogs = []
    const socketEvents = new EventEmitter()
    const sock = {
        ev: socketEvents,
        user: {
            id: "6288287764273:12@s.whatsapp.net",
            lid: "999111222333@lid",
        },
    }
    const guardian = {
        extractMessageText: extractText,
        isMessageEditUpsert: () => false,
        rememberOriginalMessage: () => true,
        normalizeMessageUpdate: () => null,
        handleMessageEditUpdate: async () => ({ handled: false }),
        sendEditedMessageLog: async (_context, details) => {
            sentLogs.push(details)
            return { sent: true, targetJid: "120363000000000000@g.us" }
        },
    }
    const context = {
        sock,
        messageEditGuardian: guardian,
        securityMediaLog: {
            getSecurityLogJid: () => "120363000000000000@g.us",
        },
        contactNameStore: {},
        getMessage: async key => contentById.get(String(key?.id || "")),
        rememberMessageContent: msg => {
            if (msg?.key?.id && msg?.message) contentById.set(String(msg.key.id), msg.message)
        },
        getMessageSenderJid: msg => (
            msg?.key?.participantAlt
            || msg?.key?.participant
            || msg?.key?.remoteJidAlt
            || msg?.key?.remoteJid
            || ""
        ),
        ownerJid: () => "6288287764273@s.whatsapp.net",
        isSecurityLogChat: jid => jid === "120363000000000000@g.us",
        isBotSentMessageId: () => false,
        isBotGeneratedMessage: () => false,
        proto: {
            Message: {
                decode: buffer => JSON.parse(Buffer.from(buffer).toString("utf8")),
            },
        },
    }
    bridge.installMessageEditRuntimeBridge(sock, () => context)
    return { sock, sentLogs, contentById }
}

async function testPrivateLidSecretEdit() {
    const harness = makeHarness()
    const originalId = "AC6F792DA68154A595655FDD2496491B"
    const shellId = "AC6D6DB96E7D1229D6A877DA433F072F"
    const lid = "17756082725042@lid"
    const pn = "6285168898178@s.whatsapp.net"
    const messageSecret = crypto.randomBytes(32)

    harness.sock.ev.emit("messages.upsert", {
        type: "notify",
        messages: [{
            key: {
                id: originalId,
                remoteJid: lid,
                remoteJidAlt: pn,
                participant: pn,
                fromMe: false,
            },
            pushName: "Ur heart",
            message: {
                conversation: "dysjsb",
                messageContextInfo: { messageSecret },
            },
        }],
    })

    const encrypted = encryptEdit({
        messageSecret,
        originalMessageId: originalId,
        originalSender: lid,
        modificationSender: lid,
        editedMessage: { conversation: "a" },
    })
    const editShell = {
        key: {
            id: shellId,
            remoteJid: lid,
            remoteJidAlt: pn,
            participant: pn,
            fromMe: false,
        },
        message: {
            messageContextInfo: {},
            secretEncryptedMessage: {
                targetMessageKey: {
                    id: originalId,
                    remoteJid: lid,
                    fromMe: false,
                },
                secretEncType: 2,
                ...encrypted,
            },
        },
    }

    assert.strictEqual(bridge.isSecretEncryptedEditMessage(editShell), true)
    harness.sock.ev.emit("messages.upsert", { type: "notify", messages: [editShell] })
    await bridge.flushMessageEditRuntimeBridge()

    assert.strictEqual(harness.sentLogs.length, 1, "PM edit harus mengirim tepat satu log")
    assert.strictEqual(harness.sentLogs[0].originalText, "dysjsb")
    assert.strictEqual(harness.sentLogs[0].editedText, "a")
    assert.strictEqual(harness.sentLogs[0].senderJid, pn)
    assert.strictEqual(harness.sentLogs[0].messageId, originalId)

    harness.sock.ev.emit("messages.upsert", { type: "notify", messages: [editShell] })
    await bridge.flushMessageEditRuntimeBridge()
    assert.strictEqual(harness.sentLogs.length, 1, "event edit duplikat tidak boleh mengirim lagi")

    const encryptedAgain = encryptEdit({
        messageSecret,
        originalMessageId: originalId,
        originalSender: lid,
        modificationSender: lid,
        editedMessage: { conversation: "b" },
    })
    harness.sock.ev.emit("messages.upsert", {
        type: "notify",
        messages: [{
            key: {
                id: "AC6D6DB96E7D1229D6A877DA433F0999",
                remoteJid: lid,
                remoteJidAlt: pn,
                participant: pn,
                fromMe: false,
            },
            message: {
                secretEncryptedMessage: {
                    targetMessageKey: { id: originalId, remoteJid: lid, fromMe: false },
                    secretEncType: 2,
                    ...encryptedAgain,
                },
            },
        }],
    })
    await bridge.flushMessageEditRuntimeBridge()
    assert.strictEqual(harness.sentLogs.length, 2, "edit kedua pada pesan sama tetap harus terkirim sekali")
    assert.strictEqual(harness.sentLogs[1].originalText, "a", "pesan lama edit kedua harus hasil edit pertama")
    assert.strictEqual(harness.sentLogs[1].editedText, "b")
    bridge.disposeMessageEditRuntimeBridge()
}

async function testGroupSecretEdit() {
    const harness = makeHarness()
    const originalId = "GROUP-ORIGINAL-1"
    const group = "120363123456789012@g.us"
    const sender = "628111222333@s.whatsapp.net"
    const messageSecret = crypto.randomBytes(32)

    harness.sock.ev.emit("messages.upsert", {
        type: "notify",
        messages: [{
            key: { id: originalId, remoteJid: group, participant: sender, fromMe: false },
            message: {
                conversation: "pesan lama grup",
                messageContextInfo: { messageSecret },
            },
        }],
    })

    const encrypted = encryptEdit({
        messageSecret,
        originalMessageId: originalId,
        originalSender: sender,
        modificationSender: sender,
        editedMessage: { extendedTextMessage: { text: "pesan baru grup" } },
    })
    harness.sock.ev.emit("messages.upsert", {
        type: "notify",
        messages: [{
            key: {
                id: "GROUP-SHELL-EDIT-1",
                remoteJid: group,
                participant: sender,
                fromMe: false,
            },
            message: {
                secretEncryptedMessage: {
                    targetMessageKey: {
                        id: originalId,
                        remoteJid: group,
                        participant: sender,
                        fromMe: false,
                    },
                    secretEncType: "MESSAGE_EDIT",
                    ...encrypted,
                },
            },
        }],
    })
    await bridge.flushMessageEditRuntimeBridge()

    assert.strictEqual(harness.sentLogs.length, 1, "group edit harus mengirim tepat satu log")
    assert.strictEqual(harness.sentLogs[0].chatJid, group)
    assert.strictEqual(harness.sentLogs[0].senderJid, sender)
    assert.strictEqual(harness.sentLogs[0].originalText, "pesan lama grup")
    assert.strictEqual(harness.sentLogs[0].editedText, "pesan baru grup")
    bridge.disposeMessageEditRuntimeBridge()
}

async function testMissingOriginalSecretDoesNotSend() {
    const harness = makeHarness()
    const broken = {
        key: {
            id: "BROKEN-SHELL",
            remoteJid: "1888999000@lid",
            remoteJidAlt: "628999000111@s.whatsapp.net",
            fromMe: false,
        },
        message: {
            secretEncryptedMessage: {
                targetMessageKey: { id: "MISSING-ORIGINAL", remoteJid: "1888999000@lid", fromMe: false },
                secretEncType: 2,
                encIv: crypto.randomBytes(12),
                encPayload: crypto.randomBytes(40),
            },
        },
    }
    harness.sock.ev.emit("messages.upsert", { type: "notify", messages: [broken] })
    await bridge.flushMessageEditRuntimeBridge()
    assert.strictEqual(harness.sentLogs.length, 0)
    bridge.disposeMessageEditRuntimeBridge()
}

async function main() {
    await testPrivateLidSecretEdit()
    await testGroupSecretEdit()
    await testMissingOriginalSecretDoesNotSend()
    console.log("PASS secretEncryptedMessage edit decrypt: PM LID, grup, repeated edit, dedupe, missing-secret")
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
