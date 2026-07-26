"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "group-welcome-test-"))
process.env.GROUP_WELCOME_DATA_FILE = path.join(tempRoot, "groupWelcome.json")
process.env.GROUP_WELCOME_EVENT_DELAY_MS = "0"
process.env.GROUP_KICK_STICKER_DIR = path.join(tempRoot, "kick-stickers")
process.env.GROUP_KICK_STICKER_DELAY_MS = "1"

const groupWelcome = require("../modules/groupWelcome")
const groupRemoteControl = require("../modules/groupRemoteControl")

async function run() {
    const selected = groupWelcome.extractInteractiveSelection({
        interactiveResponseMessage: {
            nativeFlowResponseMessage: {
                paramsJson: JSON.stringify({ id: ".groupinfo" }),
            },
        },
    })
    assert.strictEqual(selected, ".groupinfo")

    const nestedSelected = groupWelcome.extractInteractiveSelection({
        ephemeralMessage: {
            message: {
                interactiveResponseMessage: {
                    nativeFlowResponseMessage: {
                        paramsJson: JSON.stringify({ response: { selectedRowId: ".adminlist" } }),
                    },
                },
            },
        },
    })
    assert.strictEqual(nestedSelected, ".adminlist")

    const rendered = groupWelcome.renderTemplate("Halo {user} di {group}, anggota {member_count}", {
        users: ["628111111111@s.whatsapp.net"],
        group: "Tes Grup",
        memberCount: 10,
    })
    assert.strictEqual(rendered, "Halo @628111111111 di Tes Grup, anggota 10")

    const sections = groupWelcome.buildMenuSections()
    assert.ok(sections.length >= 3)
    const menuRows = sections.flatMap(section => section.rows)
    assert.ok(menuRows.some(row => row.id === ".rules"))
    assert.ok(menuRows.some(row => row.id === ".fiturgrup"))
    assert.ok(menuRows.some(row => row.id === ".tourlinfo"))
    assert.ok(menuRows.some(row => row.id === ".quiz"))
    assert.ok(menuRows.some(row => row.id === ".tebakangka"))
    assert.ok(menuRows.some(row => row.id === ".suit"))
    assert.ok(menuRows.some(row => row.id === ".ping"))
    assert.ok(menuRows.some(row => row.id === ".goodbye status"))
    assert.ok(menuRows.some(row => row.id === ".kicksticker status"))
    assert.ok(!menuRows.some(row => row.id === ".menuteks" || row.id === ".menutext"))
    assert.ok(!menuRows.some(row => row.id === ".help" || /help menu/i.test(row.title || "")))

    assert.strictEqual(groupRemoteControl.canonicalFeatureName("welcome"), "welcome")
    assert.strictEqual(groupRemoteControl.canonicalFeatureName("groupmenu"), "groupMenu")
    assert.strictEqual(groupRemoteControl.DEFAULT_FEATURES.welcome, true)
    assert.strictEqual(groupRemoteControl.DEFAULT_FEATURES.groupMenu, true)
    assert.strictEqual(groupRemoteControl.DEFAULT_FEATURES.goodbye, true)
    assert.strictEqual(groupRemoteControl.DEFAULT_FEATURES.kickSticker, true)

    const groupJid = "120363000000000000@g.us"
    const newMember = "628222222222@s.whatsapp.net"
    const botJid = "628999999999@s.whatsapp.net"
    const metadataNotAdmin = {
        id: groupJid,
        subject: "Grup Uji",
        participants: [
            { id: botJid, admin: null },
            { id: newMember, admin: null },
        ],
    }
    const sentNotAdmin = []
    const sockNotAdmin = {
        user: { id: botJid },
        groupMetadata: async () => metadataNotAdmin,
        sendMessage: async (...args) => { sentNotAdmin.push(args) },
    }
    const control = {
        isGroupBotEnabled: () => true,
        isGroupFeatureEnabled: (_jid, feature) => feature === "welcome",
    }
    const skipped = await groupWelcome.handleParticipantUpdate(sockNotAdmin, {
        id: groupJid,
        action: "add",
        participants: [newMember],
    }, {
        groupRemoteControl: control,
        skipDelay: true,
        skipDedupe: true,
        disableInteractive: true,
    })
    assert.strictEqual(skipped.reason, "bot-not-admin")
    assert.strictEqual(sentNotAdmin.length, 0)

    const metadataAdmin = {
        ...metadataNotAdmin,
        participants: [
            { id: botJid, admin: "admin" },
            { id: newMember, admin: null },
        ],
    }
    const lidOnlyBot = "43804539273401@lid"
    const metadataLidAdmin = {
        id: groupJid,
        subject: "Grup LID",
        participants: [
            { id: lidOnlyBot, admin: "admin" },
            { id: newMember, admin: null },
        ],
    }
    const lidSock = { user: { id: botJid } }
    assert.strictEqual(groupWelcome.isBotAdmin(metadataLidAdmin, lidSock), false)
    groupWelcome.rememberBotIdentityCandidates(lidSock, {
        key: { remoteJid: groupJid, participant: lidOnlyBot, fromMe: true },
    })
    assert.strictEqual(groupWelcome.isBotAdmin(metadataLidAdmin, lidSock), true)

    const sentAdmin = []
    const sockAdmin = {
        user: { id: botJid },
        groupMetadata: async () => metadataAdmin,
        sendMessage: async (...args) => {
            sentAdmin.push(args)
            return { key: { id: "TEST" } }
        },
    }
    const sent = await groupWelcome.handleParticipantUpdate(sockAdmin, {
        id: groupJid,
        action: "add",
        participants: [newMember],
    }, {
        groupRemoteControl: control,
        skipDelay: true,
        skipDedupe: true,
        disableInteractive: true,
    })
    assert.strictEqual(sent.handled, true)
    assert.strictEqual(sent.mode, "text")
    assert.strictEqual(sentAdmin.length, 1)
    assert.ok(sentAdmin[0][1].text.includes("@628222222222"))
    assert.ok(sentAdmin[0][1].text.includes("Grup Uji"))

    const commandMessages = []
    const commandSock = {
        user: { id: botJid },
        groupMetadata: async () => metadataAdmin,
        sendMessage: async (_jid, content) => {
            commandMessages.push(content)
            return { key: { id: `CMD-${commandMessages.length}` } }
        },
    }
    const commandContext = {
        from: groupJid,
        isGroup: true,
        senderJid: newMember,
        groupRemoteControl: {
            isGroupFeatureEnabled: () => true,
            getEffectiveGroupConfig: () => ({ botEnabled: true }),
        },
    }

    const generatedPayloads = []
    const relayMessages = []
    const passthrough = value => value
    const fakeBaileys = {
        generateWAMessageFromContent: (jid, content, options) => {
            generatedPayloads.push({ jid, content, options })
            return {
                key: { id: "HARUKA-MENU" },
                message: content,
            }
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
    const mobileMenuSock = {
        user: { id: botJid },
        relayMessage: async (...args) => {
            relayMessages.push(args)
        },
        sendMessage: async () => {
            throw new Error("List fallback tidak boleh dipakai pada jalur utama")
        },
    }
    const mobileMenuResult = await groupWelcome.sendInteractiveMenu(mobileMenuSock, groupJid, {
        baileys: fakeBaileys,
    })
    assert.strictEqual(mobileMenuResult.mode, "haruka-native-flow")
    assert.strictEqual(generatedPayloads.length, 1)
    assert.strictEqual(relayMessages.length, 1)

    const wrappedMessage = generatedPayloads[0].content.viewOnceMessage.message
    assert.strictEqual(wrappedMessage.messageContextInfo.deviceListMetadataVersion, 2)
    assert.deepStrictEqual(wrappedMessage.messageContextInfo.deviceListMetadata, {})
    const interactive = wrappedMessage.interactiveMessage
    assert.strictEqual(interactive.header.title, "✦ MENU GRUP • COMMAND CENTER ✦")
    assert.strictEqual(interactive.nativeFlowMessage.buttons.length, 1)
    assert.strictEqual(interactive.nativeFlowMessage.buttons[0].name, "single_select")
    const mobileParams = JSON.parse(interactive.nativeFlowMessage.buttons[0].buttonParamsJson)
    assert.strictEqual(mobileParams.title, "BUKA MENU")
    assert.ok(mobileParams.sections.length >= 3)
    assert.strictEqual(relayMessages[0][0], groupJid)
    assert.strictEqual(relayMessages[0][2].messageId, "HARUKA-MENU")
    assert.ok(Array.isArray(relayMessages[0][2].additionalNodes))

    assert.strictEqual(await groupWelcome.handleGroupWelcomeCommand(commandSock, { key: { remoteJid: groupJid, participant: newMember } }, {
        ...commandContext,
        text: ".quiz",
    }), true)
    assert.ok(commandMessages.at(-1).text.includes("KUIS CEPAT"))

    assert.strictEqual(await groupWelcome.handleGroupWelcomeCommand(commandSock, { key: { remoteJid: groupJid, participant: newMember } }, {
        ...commandContext,
        text: ".jawab A",
    }), true)
    assert.ok(/JAWABAN/.test(commandMessages.at(-1).text))

    assert.strictEqual(await groupWelcome.handleGroupWelcomeCommand(commandSock, { key: { remoteJid: groupJid, participant: newMember } }, {
        ...commandContext,
        text: ".tebakangka",
    }), true)
    assert.ok(commandMessages.at(-1).text.includes("TEBAK ANGKA"))

    const groupWelcomeSource = fs.readFileSync(path.join(__dirname, "..", "modules", "groupWelcome.js"), "utf8")
    assert.ok(groupWelcomeSource.includes('title: "BUKA MENU"'))
    assert.ok(groupWelcomeSource.includes('name: "single_select"'))
    assert.ok(groupWelcomeSource.includes('viewOnceMessage:'))
    assert.ok(groupWelcomeSource.includes('deviceListMetadataVersion: 2'))
    assert.ok(groupWelcomeSource.includes('Haruka-style Native Flow terkirim'))
    assert.ok(!groupWelcomeSource.includes("☰ BUKA MENU"))
    assert.ok(!groupWelcomeSource.includes(".menuteks"))
    assert.ok(groupWelcomeSource.includes('title: "🎉 WELCOME TO THE GROUP"'))
    assert.ok(!groupWelcome.DEFAULT_TEMPLATE.startsWith("🎉"))
    assert.ok(groupWelcome.DEFAULT_GOODBYE_TEMPLATE.includes("Sampai jumpa"))
    assert.ok(groupWelcomeSource.includes("Menu Build: V1.4.0"))

    const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")
    assert.ok(indexSource.includes("groupWelcome.installGroupWelcome"))
    assert.ok(indexSource.includes("groupWelcome.extractInteractiveSelection"))
    assert.ok(indexSource.includes("groupWelcome.handleGroupWelcomeCommand"))
    assert.ok(indexSource.includes("groupWelcome.buildPingText(msg)"))
    assert.ok(indexSource.includes('handler: "groupAdminGate"'))
    assert.ok(indexSource.includes('reason: "bot-not-admin"'))
    assert.ok(indexSource.includes("groupWelcome.rememberBotIdentityCandidates(sock, msg)"))
    assert.ok(indexSource.includes("groupWelcome.isBotAdmin(inboundGroupMetadata, sock, selfIdentityCandidates)"))
    const gateIndex = indexSource.indexOf("groupWelcome.isBotAdmin(inboundGroupMetadata, sock, selfIdentityCandidates)")
    const stickerSafetyIndex = indexSource.indexOf("stickerSafetyCommandHandled")
    const antiToxicIndex = indexSource.indexOf("shouldRunAntiToxicForMessage")
    assert.ok(gateIndex > 0 && gateIndex < stickerSafetyIndex)
    assert.ok(gateIndex > 0 && gateIndex < antiToxicIndex)

    console.log("PASS test-group-welcome-menu")
}

run().finally(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
}).catch(error => {
    console.error(error)
    process.exitCode = 1
})
