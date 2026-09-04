"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "viewonce-sender-test-"))
process.env.SECURITY_MEDIA_LOG_STATE_PATH = path.join(tempRoot, "securityMediaLog.json")
process.env.CONTACT_NAME_STORE_FILE = path.join(tempRoot, "contactNames.json")
process.env.SECURITY_MEDIA_LOG_JID = "120363424006225997@g.us"

const contactNameStore = require("../modules/contactNameStore")
const securityMediaLog = require("../modules/securityMediaLog")
const viewonce = require("../modules/viewonce")
const viewonce2 = require("../modules/viewonce2")

const GROUP_JID = "120363000000000001@g.us"
const REZA_JID = "628111111111@s.whatsapp.net"
const AFNAN_JID = "628222222222@s.whatsapp.net"

const originalViewOnce = {
    viewOnceMessageV2: {
        message: {
            imageMessage: {
                viewOnce: true,
                mimetype: "image/jpeg",
                url: "https://example.invalid/viewonce",
                mediaKey: Buffer.alloc(32, 1),
            },
        },
    },
}

function makeReply(replierJid, replierName, id) {
    return {
        key: {
            id,
            remoteJid: GROUP_JID,
            participant: replierJid,
            fromMe: false,
        },
        pushName: replierName,
        messageTimestamp: 1_700_000_000,
        message: {
            extendedTextMessage: {
                text: "buka vo ini",
                contextInfo: {
                    stanzaId: "VO-ASLI-REZA",
                    participant: REZA_JID,
                    quotedMessage: originalViewOnce,
                },
            },
        },
    }
}

async function run() {
    assert.ok(viewonce.getViewOnceMediaInfo(originalViewOnce), "VO asli harus tetap terdeteksi")

    const afnanReply = makeReply(AFNAN_JID, "Afnan", "REPLY-AFNAN")
    assert.strictEqual(
        viewonce.getViewOnceMediaInfo(afnanReply.message),
        null,
        "VO di quotedMessage tidak boleh dianggap sebagai VO baru milik Afnan"
    )

    const sentFromReplyScan = []
    const replySock = {
        sendMessage: async (...args) => { sentFromReplyScan.push(args) },
        groupMetadata: async () => ({ subject: "Grup Uji", participants: [] }),
    }
    assert.strictEqual(await viewonce2.handleIncomingViewOnce(replySock, afnanReply), false)
    assert.strictEqual(sentFromReplyScan.length, 0, "reply VO tidak boleh membuat log baru dengan identitas replier")

    contactNameStore.rememberContact({ id: REZA_JID, name: "Reza Kontak" }, { source: "test-whatsapp-contact" })
    const logMessages = []
    const logSock = {
        groupMetadata: async () => ({ subject: "Grup Uji" }),
        sendMessage: async (jid, content) => {
            logMessages.push({ jid, content })
            return { key: { id: "LOG-1" } }
        },
    }

    const result = await securityMediaLog.sendViewOnceLog(logSock, {
        sourceJid: GROUP_JID,
        senderJid: REZA_JID,
        senderName: "Nama Profil Reza",
        messageId: "VO-ASLI-REZA-TEST",
        mediaType: "image",
        messageTimestamp: 1_700_000_000,
        caption: "contoh",
        fromMe: false,
    })
    assert.strictEqual(result.sent, true)
    assert.strictEqual(logMessages.length, 1)
    assert.deepStrictEqual(logMessages[0].content.mentions, [REZA_JID])
    assert.match(logMessages[0].content.text, /Pengirim: @628111111111/)
    assert.match(logMessages[0].content.text, /Nama kontak: Reza Kontak/)
    assert.doesNotMatch(logMessages[0].content.text, /Afnan/)

    console.log("PASS test-viewonce-sender-consistency: quoted VO tidak mengganti pengirim dan nama kontak tampil.")
}

run().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
