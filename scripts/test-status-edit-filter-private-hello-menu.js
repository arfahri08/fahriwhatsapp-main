"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { EventEmitter } = require("events")

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "status-edit-private-menu-"))
process.env.MESSAGE_EDIT_GUARDIAN_STATE_PATH = path.join(tempDir, "messageEditGuardian.json")
process.env.EDIT_TAP_TRACE_PATH = path.join(tempDir, "editEventTrace.jsonl")
process.env.SECURITY_MEDIA_LOG_JID = "120363424006225997@g.us"

const guardian = require("../modules/messageEditGuardian")
const bridge = require("../modules/messageEditRuntimeBridge")
const secretEncryptedEdit = require("../modules/secretEncryptedEdit")
const privateHelloMenu = require("../modules/privateHelloMenu")

function makeFakeBaileys(captured) {
    const passthrough = value => value
    return {
        generateWAMessageFromContent: (jid, content, options) => {
            captured.push({ jid, content, options })
            return { key: { id: "PRIVATE-MENU-1" }, message: content }
        },
        proto: {
            Message: {
                InteractiveMessage: {
                    create: passthrough,
                    Body: { create: passthrough },
                    Footer: { create: passthrough },
                    Header: { create: passthrough },
                    NativeFlowMessage: {
                        create: passthrough,
                        NativeFlowButton: { create: passthrough },
                    },
                },
            },
        },
    }
}

async function main() {
    const statusShell = {
        key: {
            remoteJid: "status@broadcast",
            remoteJidAlt: "6285111111111@s.whatsapp.net",
            id: "STATUS-SHELL-1",
            fromMe: false,
        },
        message: {
            secretEncryptedMessage: {
                secretEncType: 2,
                targetMessageKey: {
                    remoteJid: "status@broadcast",
                    remoteJidAlt: "6285111111111@s.whatsapp.net",
                    id: "STATUS-TARGET-1",
                    fromMe: false,
                },
                encIv: Buffer.alloc(12, 1),
                encPayload: Buffer.alloc(48, 2),
            },
        },
    }
    assert.strictEqual(secretEncryptedEdit.hasStatusOrBroadcastTransport(statusShell), true)
    assert.strictEqual(secretEncryptedEdit.isSecretEncryptedEditMessage(statusShell), false, "status tidak boleh diklasifikasikan sebagai edit")

    const sent = []
    const ev = new EventEmitter()
    let upsertPassthrough = 0
    ev.on("messages.upsert", () => { upsertPassthrough += 1 })
    const sock = {
        ev,
        user: { id: "6288287764273:1@s.whatsapp.net" },
        async sendMessage(jid, content) { sent.push({ jid, content }); return { key: { id: `BOT-${sent.length}` } } },
    }
    const context = {
        sock,
        messageEditGuardian: guardian,
        securityMediaLog: { getSecurityLogJid: () => "120363424006225997@g.us" },
        rememberMessageContent: () => {},
        getMessageSenderJid: msg => msg?.key?.remoteJidAlt || msg?.key?.remoteJid || "",
        ownerJid: () => "6288287764273@s.whatsapp.net",
        isSecurityLogChat: () => false,
        isBotSentMessageId: () => false,
        isBotGeneratedMessage: () => false,
        lidAliasStore: { resolveBestJid: jid => jid },
    }
    assert.strictEqual(bridge.installMessageEditRuntimeBridge(sock, () => context), true)
    ev.emit("messages.upsert", { type: "notify", messages: [statusShell] })
    await bridge.flushMessageEditRuntimeBridge()
    assert.strictEqual(upsertPassthrough, 1, "status tetap harus diteruskan ke listener status biasa")
    assert.strictEqual(sent.length, 0, "status tidak boleh dikirim sebagai jejak edit")

    ev.emit("messages.update", [{
        key: {
            remoteJid: "status@broadcast",
            remoteJidAlt: "6285111111111@s.whatsapp.net",
            id: "STATUS-DIRECT-EDIT-1",
            fromMe: false,
        },
        update: {
            message: { editedMessage: { message: { conversation: "status baru" } } },
        },
    }])
    await bridge.flushMessageEditRuntimeBridge()
    assert.strictEqual(sent.length, 0, "messages.update dari status juga tidak boleh menjadi jejak edit")

    const captured = []
    const relay = []
    const helloSock = {
        user: { id: "6288287764273@s.whatsapp.net" },
        async relayMessage(...args) { relay.push(args) },
        async sendMessage(jid, content) { sent.push({ jid, content }); return { key: { id: "FALLBACK" } } },
    }
    const helloMsg = {
        key: { remoteJid: "6285111111111@s.whatsapp.net", id: "HELLO-1", fromMe: false },
        pushName: "Ur Heart",
        message: { conversation: "halo" },
    }
    assert.strictEqual(privateHelloMenu.isHelloTrigger("halo"), true)
    assert.strictEqual(privateHelloMenu.isHelloTrigger("HALO!!!"), true)
    assert.strictEqual(privateHelloMenu.isHelloTrigger("halo kak"), false)
    const handled = await privateHelloMenu.handlePrivateHello(helloSock, helloMsg, {
        from: helloMsg.key.remoteJid,
        text: "halo",
        isGroup: false,
        displayName: "Ur Heart",
        baileys: makeFakeBaileys(captured),
    })
    assert.strictEqual(handled, true)
    assert.strictEqual(captured.length, 1)
    assert.strictEqual(relay.length, 1)
    const interactive = captured[0].content.viewOnceMessage.message.interactiveMessage
    assert.strictEqual(interactive.header.title, "✦ MENU PRIVATE • USERBOT FAHRI ✦")
    assert.match(interactive.body.text, /antoniusfahri\.my\.id/)
    assert.match(interactive.body.text, /Tentang penulis script bot/)
    const params = JSON.parse(interactive.nativeFlowMessage.buttons[0].buttonParamsJson)
    const rows = params.sections.flatMap(section => section.rows)
    assert.ok(rows.some(row => row.id === ".pmenu all"))
    assert.ok(rows.some(row => row.id === ".pmenu media"))
    assert.ok(rows.some(row => row.id === ".pmenu status"))

    assert.strictEqual(privateHelloMenu.parsePrivateMenuCommand(".pmenu downloader"), "downloader")
    assert.match(privateHelloMenu.buildCategoryText("downloader"), /Spotify/)
    assert.match(privateHelloMenu.buildCategoryText("status"), /tidak dicatat sebagai jejak pesan diedit/)

    const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")
    assert.ok(source.includes('const privateHelloMenu = require("./modules/privateHelloMenu")'))
    assert.ok(source.includes('privateHelloMenu.handlePrivateHello'))
    assert.ok(source.includes('privateHelloMenu.handlePrivateMenuCommand'))

    bridge.disposeMessageEditRuntimeBridge()
    guardian.disposeMessageEditGuardian()
    console.log("PASS test-status-edit-filter-private-hello-menu")
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
