"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "group-admin-runtime-policy-"))
process.env.GROUP_REMOTE_CONTROL_DATA_FILE = path.join(tempRoot, "groupRemoteControl.json")
process.env.GROUP_WELCOME_DATA_FILE = path.join(tempRoot, "groupWelcome.json")
process.env.GROUP_KICK_STICKER_DIR = path.join(tempRoot, "kick-stickers")
process.env.GROUP_WELCOME_EVENT_DELAY_MS = "0"
process.env.EDIT_GUARD_DATA_FILE = path.join(tempRoot, "messageEditGuardian.json")

const groupRemoteControl = require("../modules/groupRemoteControl")
const groupRuntimePolicy = require("../modules/groupRuntimePolicy")
const groupWelcome = require("../modules/groupWelcome")
const messageEditGuardian = require("../modules/messageEditGuardian")

const GROUP = "120363777777777777@g.us"
const BOT = "628999999999@s.whatsapp.net"
const MEMBER = "628111111111@s.whatsapp.net"

function metadata(botAdmin) {
    return {
        id: GROUP,
        subject: "Hard Gate Test",
        participants: [
            { id: BOT, admin: botAdmin ? "admin" : null },
            { id: MEMBER, admin: null },
        ],
    }
}

function makeSock(options = {}) {
    const sent = []
    const relayed = []
    const sock = {
        user: { id: BOT },
        async groupMetadata() {
            if (options.metadataError) throw new Error("metadata unavailable")
            return options.metadata || metadata(Boolean(options.botAdmin))
        },
        async sendMessage(jid, content) {
            sent.push({ jid, content })
            return { key: { id: `SENT-${sent.length}`, remoteJid: jid, fromMe: true } }
        },
        async relayMessage(jid, message, relayOptions) {
            relayed.push({ jid, message, relayOptions })
            return { key: { id: `RELAY-${relayed.length}`, remoteJid: jid, fromMe: true } }
        },
    }
    return { sock, sent, relayed }
}

function resetConfig() {
    groupRemoteControl.saveState({ version: 1, groups: {} })
}

async function lifecycle(action, sock) {
    return groupWelcome.handleParticipantUpdate(sock, {
        id: GROUP,
        action,
        participants: [MEMBER],
    }, {
        groupRemoteControl,
        skipDelay: true,
        skipDedupe: true,
        disableInteractive: true,
    })
}

async function main() {
    resetConfig()
    let fixture = makeSock({ botAdmin: true })
    let result = await lifecycle("add", fixture.sock)
    assert.strictEqual(result.reason, "group-bot-off")
    assert.strictEqual(fixture.sent.length, 0, "grup baru harus diam walaupun bot admin")

    groupRemoteControl.setBotEnabled(GROUP, true, "test-owner")
    fixture = makeSock({ botAdmin: true })
    result = await lifecycle("add", fixture.sock)
    assert.strictEqual(result.reason, "welcome-sent")
    assert.strictEqual(fixture.sent.length, 1, "Group Bot ON + bot admin harus mengirim welcome")

    fixture = makeSock({ botAdmin: true })
    result = await lifecycle("remove", fixture.sock)
    assert.strictEqual(result.reason, "goodbye-sent")
    assert.strictEqual(fixture.sent.length, 1, "Group Bot ON + bot admin harus mengirim goodbye")

    fixture = makeSock({ botAdmin: false })
    assert.strictEqual((await lifecycle("add", fixture.sock)).reason, "bot-not-admin")
    assert.strictEqual(fixture.sent.length, 0, "non-admin add must stay silent")

    fixture = makeSock({ botAdmin: false })
    assert.strictEqual((await lifecycle("remove", fixture.sock)).reason, "bot-not-admin")
    assert.strictEqual(fixture.sent.length, 0, "non-admin remove must stay silent")

    fixture = makeSock({ metadataError: true })
    assert.strictEqual((await lifecycle("add", fixture.sock)).reason, "metadata-unavailable")
    assert.strictEqual((await lifecycle("remove", fixture.sock)).reason, "metadata-unavailable")
    assert.strictEqual(fixture.sent.length, 0, "metadata failure must fail closed for welcome and goodbye")

    const staleFallbackSock = makeSock({ botAdmin: true }).sock
    staleFallbackSock.__resolveGroupMetadataForRuntimePolicy = async () => {
        throw new Error("strict metadata refresh failed")
    }
    const ordinaryWithoutMetadata = await groupRemoteControl.resolveGroupRuntimePolicy(staleFallbackSock, GROUP)
    assert.strictEqual(ordinaryWithoutMetadata.allowed, true, "fitur biasa boleh berjalan setelah Group Bot ON")
    assert.strictEqual(ordinaryWithoutMetadata.managementAllowed, false)
    const managedWithoutMetadata = await groupRemoteControl.resolveGroupRuntimePolicy(staleFallbackSock, GROUP, {
        featureName: "welcome",
    })
    assert.strictEqual(managedWithoutMetadata.reason, "metadata-unavailable")
    assert.strictEqual(managedWithoutMetadata.allowed, false, "metadata gagal harus memblokir welcome")

    resetConfig()
    groupRemoteControl.setBotEnabled(GROUP, false, "test")
    fixture = makeSock({ botAdmin: true })
    assert.strictEqual((await lifecycle("add", fixture.sock)).reason, "group-bot-off")
    assert.strictEqual((await lifecycle("remove", fixture.sock)).reason, "group-bot-off")
    assert.strictEqual(fixture.sent.length, 0, "explicit Group Bot OFF must silence lifecycle")

    resetConfig()
    groupRemoteControl.setBotEnabled(GROUP, true, "test")
    groupRemoteControl.setFeature(GROUP, "welcome", false, "test")
    fixture = makeSock({ botAdmin: true })
    assert.strictEqual((await lifecycle("add", fixture.sock)).reason, "welcome-off")
    assert.strictEqual(fixture.sent.length, 0, "explicit welcome OFF must win")

    resetConfig()
    groupRemoteControl.setBotEnabled(GROUP, true, "test")
    groupRemoteControl.setFeature(GROUP, "goodbye", false, "test")
    fixture = makeSock({ botAdmin: true })
    assert.strictEqual((await lifecycle("remove", fixture.sock)).reason, "goodbye-off")
    assert.strictEqual(fixture.sent.length, 0, "explicit goodbye OFF must win")

    resetConfig()
    groupRemoteControl.setBotEnabled(GROUP, true, "test")
    groupRemoteControl.setFeature(GROUP, "welcome", true, "test")
    fixture = makeSock({ botAdmin: false })
    assert.strictEqual((await lifecycle("add", fixture.sock)).reason, "bot-not-admin")
    assert.strictEqual(fixture.sent.length, 0, "explicit welcome ON cannot bypass admin gate")

    resetConfig()
    groupRemoteControl.setBotEnabled(GROUP, true, "test")
    groupRemoteControl.setFeature(GROUP, "goodbye", true, "test")
    fixture = makeSock({ botAdmin: false })
    assert.strictEqual((await lifecycle("remove", fixture.sock)).reason, "bot-not-admin")
    assert.strictEqual(fixture.sent.length, 0, "explicit goodbye ON cannot bypass admin gate")

    resetConfig()
    const adminPolicy = await groupRemoteControl.resolveGroupRuntimePolicy(makeSock({ botAdmin: true }).sock, GROUP)
    const nonAdminPolicy = await groupRemoteControl.resolveGroupRuntimePolicy(makeSock({ botAdmin: false }).sock, GROUP)
    assert.strictEqual(adminPolicy.botConfig, "DEFAULT")
    assert.strictEqual(adminPolicy.effectiveBotEnabled, false, "grup tanpa config selalu default OFF")
    assert.strictEqual(nonAdminPolicy.effectiveBotEnabled, false, "status admin tidak boleh menyalakan grup otomatis")

    groupRemoteControl.setBotEnabled(GROUP, true, "test")
    const enabledAdminPolicy = await groupRemoteControl.resolveGroupRuntimePolicy(makeSock({ botAdmin: true }).sock, GROUP)
    const enabledNonAdminPolicy = await groupRemoteControl.resolveGroupRuntimePolicy(makeSock({ botAdmin: false }).sock, GROUP)
    assert.strictEqual(enabledAdminPolicy.allowed, true)
    assert.strictEqual(enabledAdminPolicy.managementAllowed, true)
    assert.strictEqual(enabledNonAdminPolicy.allowed, true, "non-admin tetap boleh menjalankan fitur biasa setelah .bot on")
    assert.strictEqual(enabledNonAdminPolicy.managementAllowed, false)

    groupRemoteControl.setBotEnabled(GROUP, false, "test")
    const manualOff = await groupRemoteControl.resolveGroupRuntimePolicy(makeSock({ botAdmin: true }).sock, GROUP)
    assert.strictEqual(manualOff.botConfig, "OFF")
    assert.strictEqual(manualOff.effectiveBotEnabled, false, "manual OFF stays OFF after bot becomes admin")
    assert.strictEqual(groupRemoteControl.getRawGroupConfig(GROUP).botEnabled, false, "raw explicit OFF must be preserved")

    resetConfig()
    groupRemoteControl.setBotEnabled(GROUP, true, "test")
    fixture = makeSock({ botAdmin: false })
    const commandMsg = { key: { remoteJid: GROUP, participant: MEMBER, id: "CMD-1", fromMe: false } }
    assert.strictEqual(await groupWelcome.handleGroupWelcomeCommand(fixture.sock, commandMsg, {
        from: GROUP,
        senderJid: MEMBER,
        text: ".ping",
        isGroup: true,
        groupRemoteControl,
    }), true)
    assert.strictEqual(fixture.sent.length, 1, "command biasa harus tetap bekerja ketika bot non-admin")

    assert.strictEqual(await groupWelcome.handleGroupWelcomeCommand(fixture.sock, commandMsg, {
        from: GROUP,
        senderJid: MEMBER,
        text: ".menu",
        isGroup: true,
        groupRemoteControl,
    }), true)
    assert.ok(fixture.sent.length > 1 || fixture.relayed.length > 0, "menu biasa harus tersedia ketika Group Bot ON")

    const sendsBeforeManagedFeature = fixture.sent.length
    const antiToxicPolicy = await groupRuntimePolicy.resolveGroupRuntimePolicy(fixture.sock, GROUP, {
        groupRemoteControl,
        featureName: "antiToxic",
    })
    if (antiToxicPolicy.allowed) {
        await fixture.sock.sendMessage(GROUP, { text: "anti-toxic warning" })
    }
    assert.strictEqual(antiToxicPolicy.allowed, false)
    assert.strictEqual(fixture.sent.length, sendsBeforeManagedFeature, "anti-toxic warning must stay silent when bot is not admin")

    let editedAntiToxicCalls = 0
    groupRemoteControl.setBotEnabled(GROUP, true, "test")
    const editFixture = makeSock({ botAdmin: false })
    const editTestNow = Date.now()
    messageEditGuardian.rememberOriginalMessage({
        key: { remoteJid: GROUP, id: "EDITED-TOXIC-1", participant: MEMBER, fromMe: false },
        message: { conversation: "pesan awal" },
    }, { senderJid: MEMBER, now: editTestNow })
    const editedResult = await messageEditGuardian.handleMessageEditUpdate({
        key: { remoteJid: GROUP, id: "EDITED-TOXIC-1", participant: MEMBER, fromMe: false },
        update: {
            message: { editedMessage: { message: { conversation: "pesan kasar" } } },
        },
    }, {
        now: editTestNow + 1_000,
        sock: editFixture.sock,
        ownerJid: BOT,
        groupRemoteControl,
        securityMediaLog: { getSecurityLogJid: () => "120363424006225997@g.us" },
        contactNameStore: { resolveContactName: () => "Member" },
        isBotSentMessageId: () => false,
        antiToxicControl: { shouldRunAntiToxic: () => true },
        antiToxic: {
            async handleToxicCheck() {
                editedAntiToxicCalls += 1
                return true
            },
        },
        lidAliasStore: { resolveBestJid: jid => jid },
    })
    assert.strictEqual(
        editedResult.logSent,
        true,
        `internal edit security log must remain active: ${JSON.stringify(editedResult)}`
    )
    assert.strictEqual(editedAntiToxicCalls, 0, "edited anti-toxic path must also obey non-admin gate")

    resetConfig()
    const groupControlFixture = makeSock({ botAdmin: false })
    const ownerGroupCommand = action => groupRemoteControl.handleInGroupBotControlCommand(
        groupControlFixture.sock,
        { key: { remoteJid: GROUP, participant: BOT, fromMe: true, id: `BOT-${action}` } },
        {
            from: GROUP,
            senderJid: BOT,
            text: `.bot ${action}`,
            isGroup: true,
            isOwner: true,
            canControlOwner: true,
        }
    )
    assert.strictEqual(await ownerGroupCommand("on"), true)
    assert.strictEqual(groupRemoteControl.isGroupBotEnabled(GROUP), true)
    assert.match(groupControlFixture.sent.at(-1)?.content?.text || "", /Fitur biasa: ON/)
    assert.match(groupControlFixture.sent.at(-1)?.content?.text || "", /Fitur pengelolaan grup: OFF/)
    assert.match(groupControlFixture.sent.at(-1)?.content?.text || "", /Welcome & goodbye: OFF/)

    assert.strictEqual(await ownerGroupCommand("off"), true)
    assert.strictEqual(groupRemoteControl.isGroupBotEnabled(GROUP), false)
    assert.match(groupControlFixture.sent.at(-1)?.content?.text || "", /Status: OFF/)

    assert.strictEqual(await groupRemoteControl.handleInGroupBotControlCommand(groupControlFixture.sock, {
        key: { remoteJid: GROUP, participant: BOT, fromMe: true, id: "BOT-CUSTOM-TEXT" },
    }, {
        from: GROUP,
        senderJid: BOT,
        text: ".bot lagi makan",
        isGroup: true,
        isOwner: true,
    }), true)
    assert.match(groupControlFixture.sent.at(-1)?.content?.text || "", /Custom Auto Reply tetap khusus private chat owner/)
    assert.strictEqual(groupRemoteControl.isGroupBotEnabled(GROUP), false)

    const beforeUnauthorizedControl = groupControlFixture.sent.length
    assert.strictEqual(await groupRemoteControl.handleInGroupBotControlCommand(groupControlFixture.sock, {
        key: { remoteJid: GROUP, participant: MEMBER, fromMe: false, id: "BOT-UNAUTHORIZED" },
    }, {
        from: GROUP,
        senderJid: MEMBER,
        text: ".bot on",
        isGroup: true,
        isOwner: false,
    }), true)
    assert.strictEqual(groupControlFixture.sent.length, beforeUnauthorizedControl)
    assert.strictEqual(groupRemoteControl.isGroupBotEnabled(GROUP), false, "non-owner tidak boleh menyalakan Group Bot")

    resetConfig()
    const privateFixture = makeSock({ botAdmin: false })
    await groupRemoteControl.handleGroupRemoteControlCommand(privateFixture.sock, {
        key: { remoteJid: "628555555555@s.whatsapp.net", fromMe: true },
    }, {
        from: "628555555555@s.whatsapp.net",
        senderJid: "628555555555@s.whatsapp.net",
        text: `.groupctl status ${GROUP}`,
        isGroup: false,
        isOwner: true,
    })
    const statusText = privateFixture.sent.at(-1)?.content?.text || ""
    assert.match(statusText, /Bot Admin: TIDAK/)
    assert.match(statusText, /Group Bot Config: DEFAULT/)
    assert.match(statusText, /Effective Group Bot: OFF/)
    assert.match(statusText, /Reason: GROUP-BOT-OFF/)

    console.log("PASS test-group-admin-runtime-policy")
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
}).finally(() => {
    messageEditGuardian.disposeMessageEditGuardian()
    const resolved = path.resolve(tempRoot)
    const tempBase = path.resolve(os.tmpdir())
    if (resolved.startsWith(`${tempBase}${path.sep}`)) {
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
