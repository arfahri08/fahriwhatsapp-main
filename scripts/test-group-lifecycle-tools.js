"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "group-lifecycle-test-"))
process.env.GROUP_WELCOME_DATA_FILE = path.join(tempRoot, "groupWelcome.json")
process.env.GROUP_KICK_STICKER_DIR = path.join(tempRoot, "kick-stickers")
process.env.GROUP_WELCOME_EVENT_DELAY_MS = "0"
process.env.GROUP_KICK_STICKER_DELAY_MS = "1"

const groupWelcome = require("../modules/groupWelcome")

function fakeWebp() {
    return Buffer.concat([
        Buffer.from("RIFF", "ascii"),
        Buffer.from([4, 0, 0, 0]),
        Buffer.from("WEBP", "ascii"),
    ])
}

async function main() {
    const groupJid = "120363111111111111@g.us"
    const botJid = "628999999999@s.whatsapp.net"
    const adminJid = "628111111111@s.whatsapp.net"
    const targetJid = "628222222222@s.whatsapp.net"
    const metadata = {
        id: groupJid,
        subject: "Lifecycle Test",
        participants: [
            { id: botJid, admin: "admin" },
            { id: adminJid, admin: "admin" },
            { id: targetJid, admin: null },
        ],
    }
    const featureState = { welcome: true, goodbye: true, groupMenu: true, kickSticker: true }
    const groupRemoteControl = {
        isGroupBotEnabled: () => true,
        isGroupFeatureEnabled: (_jid, feature) => featureState[feature] !== false,
        setFeature: (_jid, feature, enabled) => { featureState[feature] = enabled },
        getEffectiveGroupConfig: () => ({ botEnabled: true }),
    }

    const sent = []
    const operations = []
    const sock = {
        user: { id: botJid },
        groupMetadata: async () => metadata,
        sendMessage: async (_jid, content) => {
            sent.push(content)
            operations.push(content.sticker ? "sticker" : "message")
            return { key: { id: `SENT-${sent.length}` } }
        },
        groupParticipantsUpdate: async (jid, participants, action) => {
            operations.push(`group:${action}`)
            assert.strictEqual(jid, groupJid)
            assert.deepStrictEqual(participants, [targetJid])
            return [{ status: "200" }]
        },
    }

    const goodbye = await groupWelcome.handleParticipantUpdate(sock, {
        id: groupJid,
        action: "remove",
        participants: [targetJid],
    }, {
        groupRemoteControl,
        skipDelay: true,
        skipDedupe: true,
    })
    assert.strictEqual(goodbye.handled, true)
    assert.strictEqual(goodbye.reason, "goodbye-sent")
    assert.ok(sent.at(-1).text.includes("Sampai jumpa"))
    assert.ok(sent.at(-1).text.includes("@628222222222"))

    const ping = groupWelcome.buildPingText({ messageTimestamp: Math.floor(Date.now() / 1000) }, Date.now())
    assert.match(ping, /PONG/)
    assert.match(ping, /Latency:/)
    assert.match(ping, /Uptime:/)

    const setMsg = {
        key: { remoteJid: groupJid, participant: adminJid },
        message: {
            extendedTextMessage: {
                text: ".kicksticker set",
                contextInfo: {
                    stanzaId: "STICKER-1",
                    participant: targetJid,
                    quotedMessage: {
                        stickerMessage: { mimetype: "image/webp" },
                    },
                },
            },
        },
    }
    const commandContext = {
        from: groupJid,
        text: ".kicksticker set",
        senderJid: adminJid,
        groupRemoteControl,
        baileys: {
            downloadMediaMessage: async () => fakeWebp(),
        },
    }
    assert.strictEqual(await groupWelcome.handleGroupWelcomeCommand(sock, setMsg, commandContext), true)
    assert.strictEqual(groupWelcome.getGroupConfig(groupJid).kickStickerConfigured, true)
    assert.ok(fs.existsSync(groupWelcome.getKickStickerPath(groupJid)))

    const kickMsg = {
        key: { remoteJid: groupJid, participant: adminJid },
        message: {
            extendedTextMessage: {
                text: ".kick",
                contextInfo: {
                    stanzaId: "TARGET-1",
                    participant: targetJid,
                    quotedMessage: { conversation: "target message" },
                },
            },
        },
    }
    operations.length = 0
    assert.strictEqual(await groupWelcome.handleGroupWelcomeCommand(sock, kickMsg, {
        ...commandContext,
        text: ".kick",
    }), true)
    assert.deepStrictEqual(operations.slice(0, 2), ["sticker", "group:remove"])

    const imageStickerSource = fs.readFileSync(path.join(__dirname, "..", "modules", "imageSticker.js"), "utf8")
    assert.match(imageStickerSource, /\(\?:\\\.s\|\\\.sti/)
    assert.match(imageStickerSource, /caption \*\.s\*/)

    console.log("PASS test-group-lifecycle-tools")
}

main().finally(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
}).catch(error => {
    console.error(error)
    process.exitCode = 1
})
