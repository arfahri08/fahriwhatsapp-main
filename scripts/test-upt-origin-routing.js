"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")

async function run() {
    const root = path.join(__dirname, "..")
    const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8")

    assert.ok(indexSource.includes("// UPT_ORIGIN_ROUTING_BUILD: V1.3.3"))
    assert.ok(indexSource.includes("function shouldEditActiveNoticeToHelp() {\n    return true\n}"))
    assert.ok(indexSource.includes("saveRestartNotice(replyJid, commandKey)"))
    assert.ok(indexSource.includes("Command diedit menjadi pesan restart pada chat asal."))
    assert.ok(indexSource.includes("return sendRestartNotice(sock, replyJid)"))
    assert.ok(indexSource.includes("active-after-command-restart"))
    assert.ok(indexSource.includes("if (commandRestartPending) {\n                    await showHelpAfterRestart(sock)"))
    assert.ok(!indexSource.includes("return sendRestartNotice(sock, botNotificationTarget.getBotNotificationGroupJid())"))

    const modulePath = require.resolve("../modules/activeNotifier")
    const targetModulePath = require.resolve("../modules/botNotificationTarget")
    delete process.env.BOT_NOTIFICATION_GROUP_JID
    delete require.cache[modulePath]
    delete require.cache[targetModulePath]

    const botNotificationTarget = require("../modules/botNotificationTarget")
    let activeNotifier = require("../modules/activeNotifier")
    const defaultGroup = botNotificationTarget.getBotNotificationGroupJid()

    assert.ok(defaultGroup.endsWith("@g.us"))
    assert.deepStrictEqual(
        activeNotifier.getTargets(["628111111111@s.whatsapp.net"]),
        [defaultGroup]
    )

    const defaultGroupSent = []
    await activeNotifier.notifyActive({
        sendMessage: async (jid, content) => {
            defaultGroupSent.push({ jid, content })
            return { key: { id: "GR-DEFAULT", remoteJid: jid } }
        },
    }, ["628111111111@s.whatsapp.net"], { force: true, reason: "test-default-group" })
    assert.strictEqual(defaultGroupSent.length, 1)
    assert.strictEqual(defaultGroupSent[0].jid, defaultGroup)

    process.env.BOT_NOTIFICATION_GROUP_JID = "120363123456789000@g.us"
    delete require.cache[modulePath]
    delete require.cache[targetModulePath]
    activeNotifier = require("../modules/activeNotifier")

    assert.deepStrictEqual(
        activeNotifier.getTargets(["628111111111@s.whatsapp.net"]),
        ["120363123456789000@g.us"]
    )

    const configuredGroupSent = []
    await activeNotifier.notifyActive({
        sendMessage: async (jid, content) => {
            configuredGroupSent.push({ jid, content })
            return { key: { id: "GR-CUSTOM", remoteJid: jid } }
        },
    }, ["628111111111@s.whatsapp.net"], { force: true, reason: "test-configured-group" })
    assert.strictEqual(configuredGroupSent.length, 1)
    assert.strictEqual(configuredGroupSent[0].jid, "120363123456789000@g.us")

    delete process.env.BOT_NOTIFICATION_GROUP_JID
    delete require.cache[modulePath]
    delete require.cache[targetModulePath]
    activeNotifier = require("../modules/activeNotifier")
    const targetModule = require("../modules/botNotificationTarget")
    const originalGetTarget = targetModule.getBotNotificationGroupJid
    targetModule.getBotNotificationGroupJid = () => ""
    try {
        assert.deepStrictEqual(
            activeNotifier.getTargets(["628111111111@s.whatsapp.net"]),
            ["628111111111@s.whatsapp.net"]
        )
    } finally {
        targetModule.getBotNotificationGroupJid = originalGetTarget
    }

    console.log("PASS test-upt-origin-routing")
}

run().catch(error => {
    console.error(error)
    process.exitCode = 1
})
