"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { EventEmitter } = require("events")

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "status-edit-private-menu-"))
process.env.EDIT_GUARD_DATA_FILE = path.join(tempDir, "messageEditGuardian.json")
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
    const makeStatusShell = (transportJid, suffix) => ({
        key: {
            remoteJid: transportJid,
            remoteJidAlt: "6285111111111@s.whatsapp.net",
            id: `STATUS-SHELL-${suffix}`,
            fromMe: false,
        },
        message: {
            secretEncryptedMessage: {
                secretEncType: 2,
                targetMessageKey: {
                    remoteJid: transportJid,
                    remoteJidAlt: "6285111111111@s.whatsapp.net",
                    id: `STATUS-TARGET-${suffix}`,
                    fromMe: false,
                },
                encIv: Buffer.alloc(12, 1),
                encPayload: Buffer.alloc(48, 2),
            },
        },
    })
    const statusShell = makeStatusShell("status@broadcast", "STATUS")
    assert.strictEqual(secretEncryptedEdit.hasStatusOrBroadcastTransport(statusShell), true)
    assert.strictEqual(secretEncryptedEdit.isSecretEncryptedEditMessage(statusShell), false, "status tidak boleh diklasifikasikan sebagai edit")
    for (const [jid, suffix] of [["updates@broadcast", "BROADCAST"], ["120363999999@newsletter", "NEWSLETTER"]]) {
        const variant = makeStatusShell(jid, suffix)
        assert.strictEqual(secretEncryptedEdit.hasStatusOrBroadcastTransport(variant), true)
        assert.strictEqual(secretEncryptedEdit.isSecretEncryptedEditMessage(variant), false, `${jid} tidak boleh menjadi edit`)
    }

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

    ev.emit("messages.upsert", {
        type: "notify",
        messages: [
            makeStatusShell("updates@broadcast", "BROADCAST"),
            makeStatusShell("120363999999@newsletter", "NEWSLETTER"),
        ],
    })
    await bridge.flushMessageEditRuntimeBridge()
    assert.strictEqual(sent.length, 0, "broadcast dan newsletter tidak boleh menjadi jejak edit")

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

    const originalStatus = {
        key: {
            remoteJid: "status@broadcast",
            remoteJidAlt: "6285111111111@s.whatsapp.net",
            id: "STATUS-ORIGINAL-123",
            fromMe: false,
        },
        message: { conversation: "status normal tetap diproses listener" },
    }
    const passthroughBeforeProvenance = upsertPassthrough
    ev.emit("messages.upsert", { type: "notify", messages: [originalStatus] })
    await bridge.flushMessageEditRuntimeBridge()
    assert.strictEqual(upsertPassthrough, passthroughBeforeProvenance + 1, "status provenance tetap diteruskan ke listener normal")
    const provenanceHealth = bridge.getMessageEditRuntimeBridgeHealth().statusProvenance
    assert.ok(provenanceHealth.size > 0 && provenanceHealth.size <= provenanceHealth.maxSize)
    assert.ok(provenanceHealth.ttlMs >= 60_000, "status provenance wajib bounded dengan TTL")

    const normalizedSecretStatus = makeStatusShell("6285111111111@s.whatsapp.net", "NORMALIZED-SECRET")
    normalizedSecretStatus.message.secretEncryptedMessage.targetMessageKey.id = "STATUS-ORIGINAL-123"
    assert.strictEqual(secretEncryptedEdit.hasStatusOrBroadcastProvenance(normalizedSecretStatus), true)
    assert.strictEqual(secretEncryptedEdit.isSecretEncryptedEditMessage(normalizedSecretStatus), false, "secret edit PN dengan target ID status harus ditolak")
    ev.emit("messages.upsert", { type: "notify", messages: [normalizedSecretStatus] })
    await bridge.flushMessageEditRuntimeBridge()
    assert.strictEqual(sent.length, 0, "secretEncryptedMessage PN dengan provenance status tidak boleh dilog")

    const provenanceUpdate = remoteJid => ({
        key: {
            remoteJid,
            id: "STATUS-ORIGINAL-123",
            fromMe: false,
        },
        update: {
            message: { editedMessage: { message: { conversation: "status normalized update" } } },
        },
    })
    ev.emit("messages.update", [provenanceUpdate("6285111111111@s.whatsapp.net")])
    ev.emit("messages.update", [provenanceUpdate("17756082725042@lid")])
    await bridge.flushMessageEditRuntimeBridge()
    assert.strictEqual(sent.length, 0, "PN/LID update dengan ID status harus ditolak oleh provenance")
    const directGuardianResult = await guardian.handleMessageEditUpdate(
        provenanceUpdate("6285111111111@s.whatsapp.net"),
        context
    )
    assert.strictEqual(directGuardianResult.result, "status-broadcast", "guardian standalone juga wajib memakai provenance")
    assert.strictEqual(sent.length, 0, "guardian standalone tidak boleh membocorkan status ke jejak edit")

    ev.emit("messages.upsert", {
        type: "notify",
        messages: [{
            key: { remoteJid: "6285111111111@s.whatsapp.net", id: "STATUS-EDIT-SHELL", fromMe: false },
            message: {
                protocolMessage: {
                    type: 14,
                    key: { remoteJid: "6285111111111@s.whatsapp.net", id: "STATUS-ORIGINAL-123", fromMe: false },
                    editedMessage: { conversation: "status protocol edit" },
                },
            },
        }],
    })
    await bridge.flushMessageEditRuntimeBridge()
    assert.strictEqual(sent.length, 0, "protocol MESSAGE_EDIT dengan target ID status harus ditolak")

    const genuineEdit = (remoteJid, id, participant) => ({
        key: { remoteJid, id, fromMe: false, participant },
        update: {
            message: { editedMessage: { message: { conversation: `edited ${id}` } } },
        },
    })
    ev.emit("messages.update", [genuineEdit("6285222222222@s.whatsapp.net", "REAL-PM-EDIT")])
    await bridge.flushMessageEditRuntimeBridge()
    assert.strictEqual(sent.length, 1, "real PM edit tetap masuk jejak edit")
    ev.emit("messages.update", [genuineEdit("6285222222222@s.whatsapp.net", "REAL-PM-EDIT")])
    await bridge.flushMessageEditRuntimeBridge()
    assert.strictEqual(sent.length, 1, "repeated genuine edit tetap mengikuti dedupe lama")
    ev.emit("messages.update", [genuineEdit("120363888888888888@g.us", "REAL-GROUP-EDIT", "6285333333333@s.whatsapp.net")])
    await bridge.flushMessageEditRuntimeBridge()
    assert.strictEqual(sent.length, 2, "real group edit tetap masuk jejak edit")

    const captured = []
    const relay = []
    const helloSock = {
        user: { id: "6288287764273@s.whatsapp.net" },
        async relayMessage(...args) { relay.push(args) },
        async sendMessage(jid, content) { sent.push({ jid, content }); return { key: { id: "FALLBACK" } } },
    }
    const helloMsg = {
        key: {
            remoteJid: "17756082725042@lid",
            remoteJidAlt: "6285168898178@s.whatsapp.net",
            id: "HELLO-1",
            fromMe: false,
        },
        pushName: "Ur Heart",
        message: { conversation: "halo" },
    }
    assert.strictEqual(privateHelloMenu.isHelloTrigger("halo"), true)
    assert.strictEqual(privateHelloMenu.isHelloTrigger("HALO!!!"), true)
    assert.strictEqual(privateHelloMenu.isHelloTrigger("halo kak"), false)
    const resolvedReplyJid = privateHelloMenu.resolvePrivateReplyJid(helloMsg, {
        from: helloMsg.key.remoteJid,
        senderJid: helloMsg.key.remoteJidAlt,
    })
    assert.strictEqual(resolvedReplyJid, "6285168898178@s.whatsapp.net", "LID wajib diarahkan ke PN JID")

    const handled = await privateHelloMenu.handlePrivateHello(helloSock, helloMsg, {
        from: helloMsg.key.remoteJid,
        replyJid: resolvedReplyJid,
        senderJid: helloMsg.key.remoteJidAlt,
        text: "halo",
        isGroup: false,
        botStatus: false,
        contactNameStore: {
            resolveSavedContactName: jid => jid === "6285168898178@s.whatsapp.net" ? "I Linda" : "",
        },
        contactJids: [resolvedReplyJid, helloMsg.key.remoteJid],
        baileys: makeFakeBaileys(captured),
    })
    assert.strictEqual(handled, true, "halo tetap bekerja walau botStatus false")
    assert.strictEqual(captured.length, 1)
    assert.strictEqual(captured[0].jid, "6285168898178@s.whatsapp.net")
    assert.strictEqual(relay.length, 1)
    assert.strictEqual(relay[0][0], "6285168898178@s.whatsapp.net")
    const interactive = captured[0].content.viewOnceMessage.message.interactiveMessage
    assert.strictEqual(interactive.header.title, "✦ MENU PRIVATE • USERBOT ✦")
    assert.ok(interactive.body.text.startsWith("\n👋 Halo, *I*!"), "sapaan harus memakai nama depan kontak yang disimpan owner")
    assert.doesNotMatch(interactive.body.text, /Ur Heart|\*Ur\*/, "pushName profil WhatsApp tidak boleh dipakai")
    assert.ok(!interactive.body.text.startsWith("\n\n"), "jarak judul dan halo cukup satu baris kosong")
    assert.doesNotMatch(interactive.body.text, /wa\.me/, "URL pengembang tidak boleh ditulis di body")
    assert.match(interactive.body.text, /Hubungi Pengembang Bot/)
    const websiteButton = interactive.nativeFlowMessage.buttons.find(button => button.name === "cta_url")
    assert.ok(websiteButton, "website harus berupa tombol cta_url")
    const websiteParams = JSON.parse(websiteButton.buttonParamsJson)
    assert.strictEqual(websiteParams.display_text, "Hubungi Pengembang Bot")
    assert.strictEqual(websiteParams.url, "https://wa.me/6288287764273")
    assert.strictEqual(websiteParams.merchant_url, "https://wa.me/6288287764273")
    const menuButton = interactive.nativeFlowMessage.buttons.find(button => button.name === "single_select")
    assert.ok(menuButton, "helper harus tetap berupa tombol menu")
    const params = JSON.parse(menuButton.buttonParamsJson)
    assert.strictEqual(params.title, "BUKA MENU")
    const rows = params.sections.flatMap(section => section.rows)
    assert.ok(rows.some(row => row.id === ".pmenu all"))
    assert.ok(rows.some(row => row.id === ".pmenu media"))
    assert.ok(rows.some(row => row.id === ".pmenu status"))
    assert.ok(!rows.some(row => row.id === ".pmenu about"), "website tidak boleh disamarkan sebagai row menu")

    assert.strictEqual(privateHelloMenu.resolvePrivateSavedName(helloMsg, {
        senderJid: helloMsg.key.remoteJidAlt,
        contactNameStore: { resolveSavedContactName: () => "" },
    }), "Kak", "kontak yang belum disimpan harus memakai sapaan generik")

    assert.strictEqual(privateHelloMenu.parsePrivateMenuCommand(".pmenu downloader"), "downloader")
    assert.match(privateHelloMenu.buildCategoryText("downloader"), /Spotify/)
    assert.match(privateHelloMenu.buildCategoryText("status"), /tidak dicatat sebagai jejak pesan diedit/)

    const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")
    assert.ok(source.includes('const privateHelloMenu = require("./modules/privateHelloMenu")'))
    assert.ok(source.includes('privateHelloMenu.handlePrivateHello'))
    assert.ok(source.includes('privateHelloMenu.handlePrivateMenuCommand'))
    assert.ok(source.includes('[PRIVATE HELLO ROUTE]'))
    assert.ok(source.includes('privateHelloMenu.resolvePrivateReplyJid'))
    assert.ok(!source.includes('botStatus.getStatus() && privateHelloMenu.isHelloTrigger'), "halo tidak boleh digate status global bot")

    bridge.disposeMessageEditRuntimeBridge()
    guardian.disposeMessageEditGuardian()
    console.log("PASS test-status-edit-filter-private-hello-menu")
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
