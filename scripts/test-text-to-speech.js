"use strict"

const assert = require("assert")
const textToSpeech = require("../modules/textToSpeech")

const VALID_OGG_OPUS = Buffer.concat([
    Buffer.from("OggS"),
    Buffer.alloc(24),
    Buffer.from("OpusHead"),
    Buffer.alloc(24),
])

function makeMessage(text, quotedText = "") {
    const contextInfo = quotedText
        ? { quotedMessage: { conversation: quotedText } }
        : {}
    return {
        key: { remoteJid: "628111111111@s.whatsapp.net", id: `MSG-${Date.now()}` },
        message: { extendedTextMessage: { text, contextInfo } },
    }
}

function makeSocket() {
    const sent = []
    return {
        sent,
        sendMessage: async (jid, content, options) => {
            sent.push({ jid, content, options })
            return { key: { id: `SENT-${sent.length}` } }
        },
    }
}

async function run() {
    assert.strictEqual(textToSpeech.parseTtsCommand("bukan command"), null)
    assert.strictEqual(typeof textToSpeech.handleTtsCustom, "function")
    assert.deepStrictEqual(textToSpeech.parseTtsCommand(".tts Halo dunia"), {
        input: "Halo dunia",
        language: "id",
        invalidLanguage: "",
    })
    assert.strictEqual(textToSpeech.parseTtsCommand(".tts --lang jawa Sugeng enjing").language, "jv")
    assert.strictEqual(textToSpeech.parseTtsCommand(".tts --lang en Hello").input, "Hello")

    const directSock = makeSocket()
    const directMsg = makeMessage(".tts Halo dunia")
    let received = null
    assert.strictEqual(await textToSpeech.handleTextToSpeech(directSock, directMsg, {
        from: directMsg.key.remoteJid,
        text: ".tts Halo dunia",
        createTtsVoiceNoteContent: async (text, options) => {
            received = { text, options }
            return { audio: VALID_OGG_OPUS, mimetype: "audio/ogg; codecs=opus", ptt: true }
        },
    }), true)
    assert.deepStrictEqual(received, { text: "Halo dunia", options: { language: "id" } })
    assert.strictEqual(directSock.sent.length, 1)
    assert.ok(Buffer.isBuffer(directSock.sent[0].content.audio))
    assert.strictEqual(directSock.sent[0].content.ptt, true)
    assert.strictEqual(directSock.sent[0].options.quoted, directMsg)

    const quoteSock = makeSocket()
    const quoteMsg = makeMessage(".tts --lang en", "This quoted chat becomes a voice note")
    await textToSpeech.handleTextToSpeech(quoteSock, quoteMsg, {
        from: quoteMsg.key.remoteJid,
        text: ".tts --lang en",
        createTtsVoiceNoteContent: async (text, options) => {
            assert.strictEqual(text, "This quoted chat becomes a voice note")
            assert.strictEqual(options.language, "en")
            return { audio: VALID_OGG_OPUS, ptt: true }
        },
    })
    assert.strictEqual(quoteSock.sent[0].content.ptt, true)

    const helpSock = makeSocket()
    const helpMsg = makeMessage(".tts")
    await textToSpeech.handleTextToSpeech(helpSock, helpMsg, { from: helpMsg.key.remoteJid, text: ".tts" })
    assert.match(helpSock.sent[0].content.text, /reply pesan teks/i)

    const invalidSock = makeSocket()
    const invalidMsg = makeMessage(".tts --lang ??? halo")
    await textToSpeech.handleTextToSpeech(invalidSock, invalidMsg, { from: invalidMsg.key.remoteJid, text: ".tts --lang ??? halo" })
    assert.match(invalidSock.sent[0].content.text, /kode bahasa/i)

    console.log("PASS test-text-to-speech: teks langsung, quoted chat, bahasa, PTT, dan validasi.")
}

run().catch(error => {
    console.error(error)
    process.exitCode = 1
})
