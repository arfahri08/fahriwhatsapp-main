"use strict"

const assert = require("assert")
const botNotificationTarget = require("../modules/botNotificationTarget")
const activeNotifier = require("../modules/activeNotifier")
const autoReplyForwarder = require("../modules/autoReplyForwarder")
const healthCheck = require("../modules/healthCheck")

const GROUP_JID = "120363424006225997@g.us"
const OWNER_JID = "6288287764273@s.whatsapp.net"
const USER_JID = "628111111111@s.whatsapp.net"

function createSock() {
    const sent = []
    return {
        sent,
        sendMessage: async (jid, content) => {
            sent.push({ jid, content })
            return { key: { id: `TEST-${sent.length}`, remoteJid: jid, fromMe: true } }
        },
    }
}

async function main() {
    delete process.env.BOT_NOTIFICATION_GROUP_JID

    assert.strictEqual(botNotificationTarget.getBotNotificationGroupJid(), GROUP_JID)
    assert.strictEqual(botNotificationTarget.validateBotNotificationGroupJid(GROUP_JID), true)
    assert.strictEqual(botNotificationTarget.validateBotNotificationGroupJid(OWNER_JID), false)

    const activeSock = createSock()
    const active = await activeNotifier.notifyActive(activeSock, [OWNER_JID], { force: true })
    assert.strictEqual(active.length, 1)
    assert.strictEqual(activeSock.sent.length, 1)
    assert.strictEqual(activeSock.sent[0].jid, GROUP_JID)
    assert.ok(!activeSock.sent.some(item => item.jid === OWNER_JID))

    const forwardSock = createSock()
    const notification = await autoReplyForwarder.sendOwnerNotification(forwardSock, {
        type: "Auto Reply Private Chat",
        senderJid: USER_JID,
        originalText: "halo",
        replyText: "hai",
        ownerJids: [OWNER_JID],
    })
    assert.ok(notification)
    assert.strictEqual(forwardSock.sent.length, 1)
    assert.strictEqual(forwardSock.sent[0].jid, GROUP_JID)
    assert.ok(!forwardSock.sent.some(item => item.jid === OWNER_JID))

    const invalidSourceSock = createSock()
    const invalid = await autoReplyForwarder.sendOwnerNotification(invalidSourceSock, {
        senderJid: GROUP_JID,
        ownerJids: [OWNER_JID],
    })
    assert.strictEqual(invalid, false)
    assert.strictEqual(invalidSourceSock.sent.length, 0)

    const health = await healthCheck.buildHealthText({
        autoReply: { getStatus: () => true },
        botNotificationTarget,
    })
    assert.ok(health.includes(`Bot Notification Target: ${GROUP_JID}`))
    assert.ok(health.includes("Active Notification: GROUP ONLY"))
    assert.ok(health.includes("Restart Notification: GROUP ONLY"))
    assert.ok(health.includes("Auto Reply Forwarder Target: GROUP ONLY"))
    assert.ok(health.includes("Private Owner Notification: OFF"))
    assert.ok(health.includes("PM Fallback: OFF"))

    const commandSock = createSock()
    const handled = await botNotificationTarget.handleBotNotificationCommand(commandSock, {
        key: { remoteJid: OWNER_JID, fromMe: true },
        message: { conversation: ".notifytarget test" },
    }, {
        from: OWNER_JID,
        text: ".notifytarget test",
        isGroup: false,
        isOwner: true,
    })
    assert.strictEqual(handled, true)
    assert.ok(commandSock.sent.some(item => item.jid === GROUP_JID))
    assert.ok(commandSock.sent.some(item => item.jid === OWNER_JID && item.content.text.includes("berhasil")))

    console.log("PASS bot notification target routes active/restart-compatible and auto-reply notifications to group only")
}

main().catch(error => {
    console.error("FAIL", error.stack || error.message)
    process.exitCode = 1
})
