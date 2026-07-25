"use strict"

const assert = require("assert")

const autoReply = require("../modules/autoReply")
const autoReplyScope = require("../modules/autoReplyScope")
const autoReplyForwarder = require("../modules/autoReplyForwarder")
const customAutoReply = require("../modules/customAutoReply")
const groupRemoteControl = require("../modules/groupRemoteControl")
const healthCheck = require("../modules/healthCheck")
const help = require("../modules/help")
const keywords = require("../modules/keywords")
const manualAutoReplyPause = require("../modules/manualAutoReplyPause")
const replies = require("../modules/replies")
const replyCommands = require("../modules/replyCommands")

const PRIVATE_JID = "628111111111@s.whatsapp.net"
const GROUP_JID = "120363000000000000@g.us"
const OWNER_JID = "6288287764273@s.whatsapp.net"
const NOTIFICATION_GROUP_JID = "120363424006225997@g.us"

function message(remoteJid, content, key = {}) {
    return {
        key: {
            remoteJid,
            id: key.id || "TEST-MESSAGE",
            fromMe: Boolean(key.fromMe),
            ...(key.participant ? { participant: key.participant } : {}),
        },
        message: content,
    }
}

function privateText(text = "halo", key = {}) {
    return message(PRIVATE_JID, { conversation: text }, key)
}

function groupText(text = "halo", extra = {}) {
    return message(GROUP_JID, {
        extendedTextMessage: {
            text,
            ...(extra.contextInfo ? { contextInfo: extra.contextInfo } : {}),
        },
    }, { participant: PRIVATE_JID })
}

const tests = []
function test(name, fn) {
    tests.push({ name, fn })
}

test("1. private text + Auto Reply ON diproses", () => {
    assert.strictEqual(autoReplyScope.shouldRouteAutoReplyMessage(privateText(), {
        autoReplyEnabled: true,
        botEnabled: true,
    }), true)
    assert.strictEqual(autoReply.shouldProcessMessage(privateText(), { botEnabled: true }), true)
})

test("2. private text + Auto Reply OFF tidak diproses", () => {
    assert.strictEqual(autoReplyScope.shouldRouteAutoReplyMessage(privateText(), {
        autoReplyEnabled: false,
        botEnabled: true,
    }), false)
})

test("3. group text biasa tidak diproses", () => {
    assert.strictEqual(autoReplyScope.shouldProcessAutoReplyMessage(groupText()), false)
})

test("4. group mention bot tidak diproses", () => {
    const msg = groupText("@628999 ping", { contextInfo: { mentionedJid: [OWNER_JID] } })
    assert.strictEqual(autoReplyScope.shouldProcessAutoReplyMessage(msg), false)
})

test("5. group reply ke pesan bot tidak diproses", () => {
    const msg = groupText("balas", {
        contextInfo: {
            participant: OWNER_JID,
            quotedMessage: { conversation: "pesan bot" },
        },
    })
    assert.strictEqual(autoReplyScope.shouldProcessAutoReplyMessage(msg), false)
})

test("6. group keyword match tidak diproses", () => {
    assert.strictEqual(keywords.matchKeywordForMessage(groupText("hay"), "hay"), null)
})

test("7. group link tidak masuk Auto Reply", () => {
    assert.strictEqual(autoReplyScope.shouldProcessAutoReplyMessage(groupText("https://example.com")), false)
})

test("8. group caption media tidak masuk Auto Reply", () => {
    const msg = message(GROUP_JID, { imageMessage: { caption: "hay" } }, { participant: PRIVATE_JID })
    assert.strictEqual(autoReplyScope.shouldProcessAutoReplyMessage(msg), false)
})

test("9. group command tidak jatuh ke Auto Reply", () => {
    assert.strictEqual(autoReplyScope.shouldRouteAutoReplyMessage(groupText(".unknown"), {
        autoReplyEnabled: true,
        botEnabled: true,
    }), false)
})

test("10. Group Bot ON tetap tidak mengaktifkan Auto Reply", () => {
    assert.strictEqual(autoReplyScope.shouldRouteAutoReplyMessage(groupText(), {
        autoReplyEnabled: true,
        botEnabled: true,
    }), false)
})

test("11. config group autoReply=true tetap efektif OFF", async () => {
    const effective = groupRemoteControl.getEffectiveGroupConfig(GROUP_JID)
    assert.strictEqual(effective.features.autoReply, true)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "autoReply"), false)
    assert.strictEqual(groupRemoteControl.getInboundGroupPolicySummary().groupAutoReply, false)

    const sent = []
    const sock = {
        groupMetadata: async jid => ({ id: jid, subject: "Test Group", participants: [] }),
        sendMessage: async (jid, content) => { sent.push({ jid, content }); return {} },
    }
    await groupRemoteControl.handleGroupRemoteControlCommand(sock, privateText(), {
        from: PRIVATE_JID,
        text: `.groupctl status ${GROUP_JID}`,
        isOwner: true,
    })
    assert.ok(sent.at(-1)?.content?.text?.includes("Auto Reply: PRIVATE ONLY"))
    assert.ok(sent.at(-1)?.content?.text?.includes("Group Auto Reply: OFF"))

    await groupRemoteControl.handleGroupRemoteControlCommand(sock, privateText(), {
        from: PRIVATE_JID,
        text: `.groupctl feature ${GROUP_JID} autoreply on`,
        isOwner: true,
    })
    assert.strictEqual(sent.at(-1)?.content?.text, "Auto Reply sekarang private-only dan tidak dapat diaktifkan untuk group.")

    const beforeGroupCommand = sent.length
    const handled = await groupRemoteControl.handleGroupRemoteControlCommand(sock, groupText(), {
        from: GROUP_JID,
        text: `.groupctl feature ${GROUP_JID} autoreply on`,
        isGroup: true,
        isOwner: true,
    })
    assert.strictEqual(handled, true)
    assert.strictEqual(sent.length, beforeGroupCommand)
})

test("12. Group Bot OFF tetap silent dari Auto Reply", () => {
    assert.strictEqual(autoReplyScope.shouldRouteAutoReplyMessage(groupText(), {
        autoReplyEnabled: true,
        botEnabled: false,
    }), false)
})

test("13. private keyword match bekerja", () => {
    assert.strictEqual(keywords.matchKeywordForMessage(privateText("hay"), "hay"), "ada yang bisa dibantu?")
})

test("14. private Custom Auto Reply bekerja", () => {
    const reply = customAutoReply.getReplyMessageForMessage(privateText(), [], {
        isCustomAutoReplyOn: true,
        customStatusText: "sedang menguji",
    })
    assert.ok(reply?.text?.includes("sedang menguji"))
    assert.strictEqual(customAutoReply.getReplyMessageForMessage(groupText(), [], {
        isCustomAutoReplyOn: true,
        customStatusText: "sedang menguji",
    }), null)
})

test("15. private Forwarder bekerja sesuai config", async () => {
    const sent = []
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: "sent" } } } }
    const result = await autoReplyForwarder.sendAutoReply(sock, PRIVATE_JID, { text: "balasan" }, {
        msg: privateText("pesan"),
        originalText: "pesan",
        ownerJids: [OWNER_JID],
    })
    assert.ok(result)
    assert.ok(sent.some(item => item.jid === PRIVATE_JID))
    assert.ok(sent.some(item => item.jid === NOTIFICATION_GROUP_JID))
    assert.ok(!sent.some(item => item.jid === OWNER_JID))
})

test("16. group Forwarder tidak meneruskan atau membalas", async () => {
    const sent = []
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); return {} } }
    const result = await autoReplyForwarder.sendAutoReply(sock, GROUP_JID, { text: "balasan" }, {
        msg: groupText("pesan"),
        ownerJids: [OWNER_JID],
    })
    assert.strictEqual(result, false)
    assert.deepStrictEqual(sent, [])
})

test("17. status@broadcast tidak diproses", () => {
    assert.strictEqual(autoReplyScope.shouldProcessAutoReplyMessage(message("status@broadcast", { conversation: "hay" })), false)
})

test("18. newsletter tidak diproses", () => {
    assert.strictEqual(autoReplyScope.shouldProcessAutoReplyMessage(message("12345@newsletter", { conversation: "hay" })), false)
})

test("19. fromMe tidak membuat loop", () => {
    assert.strictEqual(autoReplyScope.shouldProcessAutoReplyMessage(privateText("hay", { fromMe: true })), false)
})

test("20. handler command/downloader/media yang selesai tidak jatuh ke Auto Reply", () => {
    for (const handledType of ["owner-command", "downloader", "media-tool", "blocklist"]) {
        assert.strictEqual(autoReplyScope.shouldRouteAutoReplyMessage(privateText(handledType), {
            autoReplyEnabled: true,
            botEnabled: true,
            alreadyHandled: true,
        }), false)
    }
    assert.ok(replyCommands.formatReplyStatus().includes("Scope: PRIVATE ONLY"))
})

test("21. reaction, revoke, dan message update ditolak forwarder", async () => {
    const reaction = message(PRIVATE_JID, { reactionMessage: { text: "👍" } })
    const revoke = message(PRIVATE_JID, { protocolMessage: { type: 0 } })
    assert.strictEqual(autoReplyScope.shouldProcessAutoReplyMessage(reaction), false)
    assert.strictEqual(autoReplyScope.shouldProcessAutoReplyMessage(revoke), false)

    const sent = []
    const sock = { sendMessage: async (...args) => { sent.push(args); return {} } }
    const result = await autoReplyForwarder.sendAutoReply(sock, PRIVATE_JID, { text: "balasan" }, {
        msg: privateText(),
        isMessageUpdate: true,
        ownerJids: [OWNER_JID],
    })
    assert.strictEqual(result, false)
    assert.deepStrictEqual(sent, [])
})

test("22. random fallback hanya tersedia untuk private incoming", () => {
    assert.strictEqual(typeof replies.getRandomForMessage(privateText()), "string")
    assert.strictEqual(replies.getRandomForMessage(groupText()), null)
})

test("23. help menjelaskan kebijakan Auto Reply dan group", () => {
    const text = help.generateHelpMenu()
    assert.ok(text.includes("Auto Reply hanya bekerja melalui private chat."))
    assert.ok(text.includes("Notifikasi Auto Reply Forwarder dikirim ke grup notification, bukan PM owner."))
    assert.ok(text.includes("Keyword Reply otomatis hanya bekerja di private chat."))
    assert.ok(text.includes("Saat Bot group ON, command dan fitur yang memang mendukung group tetap dapat digunakan sesuai permission dan konfigurasi masing-masing."))
})

test("24. health menampilkan scope dan aman saat status gagal dibaca", async () => {
    const previousYtDlp = process.env.YTDLP_BIN
    const previousFfmpeg = process.env.FFMPEG_BIN
    process.env.YTDLP_BIN = "missing-auto-reply-test-ytdlp"
    process.env.FFMPEG_BIN = "missing-auto-reply-test-ffmpeg"
    try {
        const onText = await healthCheck.buildHealthText({ autoReply: { getStatus: () => true } })
        assert.ok(onText.includes("Auto Reply Global: ON"))
        assert.ok(onText.includes("Auto Reply Scope: PRIVATE ONLY"))
        assert.ok(onText.includes("Private Auto Reply: ON"))
        assert.ok(onText.includes("Group Auto Reply: OFF"))
        assert.ok(onText.includes("Auto Reply Forwarder: PRIVATE ONLY"))
        assert.ok(onText.includes("Bot Notification Target: 120363424006225997@g.us"))
        assert.ok(onText.includes("Auto Reply Forwarder Target: GROUP ONLY"))
        assert.ok(onText.includes("Private Owner Notification: OFF"))
        assert.ok(onText.includes("Keyword Auto Reply: PRIVATE ONLY"))

        const unknownText = await healthCheck.buildHealthText({ autoReply: { getStatus: () => { throw new Error("test") } } })
        assert.ok(unknownText.includes("Auto Reply Global: UNKNOWN"))
        assert.ok(unknownText.includes("Private Auto Reply: UNKNOWN"))
    } finally {
        if (previousYtDlp === undefined) delete process.env.YTDLP_BIN
        else process.env.YTDLP_BIN = previousYtDlp
        if (previousFfmpeg === undefined) delete process.env.FFMPEG_BIN
        else process.env.FFMPEG_BIN = previousFfmpeg
    }
})

test("25. manual pause lama tidak membuka jalur group", async () => {
    const sent = []
    const sock = { sendMessage: async (...args) => { sent.push(args); return {} } }
    const result = await manualAutoReplyPause.handleCommand(sock, groupText(".reply pause"), {
        from: GROUP_JID,
        text: ".reply pause",
        isOwner: true,
    })
    assert.strictEqual(result.handled, true)
    assert.strictEqual(result.action, "silent-private-only")
    assert.deepStrictEqual(sent, [])
    assert.strictEqual(manualAutoReplyPause.isPaused(PRIVATE_JID), false)
})

test("26. command .reply owner hanya merespons di private", async () => {
    const sent = []
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); return {} } }
    assert.strictEqual(await replyCommands.handleReplyCommand(sock, GROUP_JID, ".reply status", { isOwner: true }), true)
    assert.deepStrictEqual(sent, [])

    assert.strictEqual(await replyCommands.handleReplyCommand(sock, PRIVATE_JID, ".reply status", { isOwner: true }), true)
    assert.ok(sent.at(-1)?.content?.text?.includes("Group Chat: OFF"))
    assert.ok(sent.at(-1)?.content?.text?.includes("Scope: PRIVATE ONLY"))
})

async function main() {
    let passed = 0
    for (const item of tests) {
        await item.fn()
        passed += 1
        console.log(`PASS ${item.name}`)
    }
    console.log(`\n${passed}/${tests.length} auto-reply private-only smoke tests passed.`)
}

main().catch(error => {
    console.error("FAIL", error.stack || error.message)
    process.exitCode = 1
})
