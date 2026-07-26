"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "group-welcome-test-"))
process.env.GROUP_WELCOME_DATA_FILE = path.join(tempRoot, "groupWelcome.json")
process.env.GROUP_WELCOME_EVENT_DELAY_MS = "0"

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
    assert.ok(!menuRows.some(row => row.id === ".help" || /help menu/i.test(row.title || "")))

    assert.strictEqual(groupRemoteControl.canonicalFeatureName("welcome"), "welcome")
    assert.strictEqual(groupRemoteControl.canonicalFeatureName("groupmenu"), "groupMenu")
    assert.strictEqual(groupRemoteControl.DEFAULT_FEATURES.welcome, true)
    assert.strictEqual(groupRemoteControl.DEFAULT_FEATURES.groupMenu, true)

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
    assert.ok(groupWelcomeSource.includes('buttonText: "BUKA MENU"'))
    assert.ok(!groupWelcomeSource.includes("☰ BUKA MENU"))
    assert.ok(groupWelcomeSource.includes('title: "🎉 WELCOME TO THE GROUP"'))
    assert.ok(!groupWelcome.DEFAULT_TEMPLATE.startsWith("🎉"))
    assert.ok(groupWelcomeSource.includes("Menu Build: V1.2.9"))

    const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")
    assert.ok(indexSource.includes("groupWelcome.installGroupWelcome"))
    assert.ok(indexSource.includes("groupWelcome.extractInteractiveSelection"))
    assert.ok(indexSource.includes("groupWelcome.handleGroupWelcomeCommand"))
    assert.ok(indexSource.includes('handler: "groupAdminGate"'))
    assert.ok(indexSource.includes('reason: "bot-not-admin"'))
    assert.ok(indexSource.includes("groupWelcome.isBotAdmin(inboundGroupMetadata, sock)"))
    const gateIndex = indexSource.indexOf("groupWelcome.isBotAdmin(inboundGroupMetadata, sock)")
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
