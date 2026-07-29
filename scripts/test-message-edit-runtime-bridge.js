const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { EventEmitter } = require("events")

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-tap-test-"))
process.env.MESSAGE_EDIT_GUARDIAN_STATE_PATH = path.join(tempDir, "messageEditGuardian.json")
process.env.EDIT_TAP_TRACE_PATH = path.join(tempDir, "editEventTrace.jsonl")
process.env.SECURITY_MEDIA_LOG_JID = "120363424006225997@g.us"

const guardian = require("../modules/messageEditGuardian")
const bridge = require("../modules/messageEditRuntimeBridge")

const sent = []
const cache = new Map()
const ev = new EventEmitter()
const sock = {
    ev,
    user: { id: "6288287764273:7@s.whatsapp.net" },
    async sendMessage(jid, content) {
        sent.push({ jid, content })
        return { key: { remoteJid: jid, id: `BOT-${sent.length}`, fromMe: true } }
    },
}

function cacheKey(key = {}) {
    return `${key.remoteJid || key.remoteJidAlt || ""}:${key.id || ""}`
}

function rememberMessageContent(msg) {
    if (msg?.key?.id && msg?.message) cache.set(cacheKey(msg.key), msg.message)
}

async function getMessage(key) {
    return cache.get(cacheKey(key))
}

const context = {
    sock,
    messageEditGuardian: guardian,
    securityMediaLog: {
        getSecurityLogJid: () => "120363424006225997@g.us",
    },
    contactNameStore: {
        resolveContactName: (jid, fallbacks = []) => {
            if (String(jid).startsWith("628111")) return "Budi Kontak"
            if (String(jid).startsWith("628222")) return "Sari Kontak"
            return fallbacks.find(Boolean) || ""
        },
    },
    getMessage,
    rememberMessageContent,
    getMessageSenderJid: msg => msg?.key?.participant || msg?.key?.remoteJid || "",
    ownerJid: () => "6288287764273@s.whatsapp.net",
    isSecurityLogChat: jid => jid === "120363424006225997@g.us",
    isBotSentMessageId: () => false,
    isBotGeneratedMessage: () => false,
    lidAliasStore: { resolveBestJid: jid => jid },
    groupRemoteControl: {
        isGroupBotEnabled: () => false,
        isGroupFeatureEnabled: () => false,
        isGroupAntiToxicPrivateReplyEnabled: () => false,
    },
    antiToxicControl: { shouldRunAntiToxic: () => false },
    antiToxic: { handleToxicCheck: async () => false },
}

async function main() {
    let normalListenerCount = 0
    ev.on("messages.update", () => { normalListenerCount += 1 })

    assert.strictEqual(bridge.installMessageEditRuntimeBridge(sock, () => context), true)
    assert.strictEqual(bridge.getMessageEditRuntimeBridgeHealth().installed, true)

    ev.emit("messages.upsert", {
        type: "notify",
        messages: [{
            key: {
                remoteJid: "120363999999999999@g.us",
                id: "GROUP-ORIGINAL-1",
                fromMe: false,
                participant: "6281111111111@s.whatsapp.net",
            },
            pushName: "Budi Push",
            message: { conversation: "pesan grup lama" },
            messageTimestamp: 100,
        }],
    })

    const groupUpdate = [{
        key: {
            remoteJid: "120363999999999999@g.us",
            id: "GROUP-ORIGINAL-1",
            fromMe: false,
            participant: "6281111111111@s.whatsapp.net",
        },
        update: {
            message: {
                editedMessage: {
                    message: { conversation: "pesan grup baru" },
                },
            },
            messageTimestamp: 101,
        },
    }]
    ev.emit("messages.update", groupUpdate)
    await bridge.flushMessageEditRuntimeBridge()

    assert.strictEqual(normalListenerCount, 1, "listener asli messages.update harus tetap menerima event")
    assert.strictEqual(sent.length, 1, "edit grup harus mengirim tepat satu log")
    assert.strictEqual(sent[0].jid, "120363424006225997@g.us")
    assert.match(sent[0].content.text, /pesan grup lama/)
    assert.match(sent[0].content.text, /pesan grup baru/)
    assert.match(sent[0].content.text, /Budi Kontak/)
    assert.deepStrictEqual(sent[0].content.mentions, ["6281111111111@s.whatsapp.net"])

    // Event duplikat dari jalur lain tidak boleh mengirim ulang.
    ev.emit("messages.update", groupUpdate)
    await bridge.flushMessageEditRuntimeBridge()
    assert.strictEqual(sent.length, 1, "event edit duplikat tidak boleh membuat log kedua")

    ev.emit("messages.upsert", {
        type: "notify",
        messages: [{
            key: {
                remoteJid: "6282222222222@s.whatsapp.net",
                id: "PM-ORIGINAL-1",
                fromMe: false,
            },
            pushName: "Sari Push",
            message: { conversation: "pesan pm lama" },
            messageTimestamp: 200,
        }],
    })

    ev.emit("messages.update", [{
        key: {
            remoteJid: "6282222222222@s.whatsapp.net",
            id: "PM-ORIGINAL-1",
            fromMe: false,
        },
        update: {
            message: {
                editedMessage: {
                    message: { conversation: "pesan pm baru" },
                },
            },
            messageTimestamp: 201,
        },
    }])
    await bridge.flushMessageEditRuntimeBridge()

    assert.strictEqual(sent.length, 2, "edit PM harus masuk grup log")
    assert.match(sent[1].content.text, /pesan pm lama/)
    assert.match(sent[1].content.text, /pesan pm baru/)
    assert.match(sent[1].content.text, /Sari Kontak/)
    assert.deepStrictEqual(sent[1].content.mentions, ["6282222222222@s.whatsapp.net"])

    const trace = fs.readFileSync(process.env.EDIT_TAP_TRACE_PATH, "utf8")
    assert.match(trace, /messages\.update/)
    assert.match(trace, /edit-log-result/)

    bridge.disposeMessageEditRuntimeBridge()
    guardian.disposeMessageEditGuardian()
    console.log("PASS test-message-edit-runtime-bridge")
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
