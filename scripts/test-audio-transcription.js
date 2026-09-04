"use strict"

const assert = require("assert")
const audioTranscription = require("../modules/audioTranscription")

const CHAT = "628111111111@s.whatsapp.net"
const TEST_CONFIG = {
    enabled: true,
    apiKey: "test-key",
    model: "gemini-test-model",
    maxBytes: 8 * 1024 * 1024,
    maxDurationSeconds: 15 * 60,
    timeoutMs: 10_000,
    maxOutputTokens: 2048,
}

function makeMessage(command, audioMessage = null) {
    const quotedMessage = audioMessage ? { audioMessage } : undefined
    return {
        key: { remoteJid: CHAT, id: `MSG-${Date.now()}-${Math.random()}` },
        message: {
            extendedTextMessage: {
                text: command,
                contextInfo: quotedMessage ? { quotedMessage } : {},
            },
        },
    }
}

function makeSocket() {
    const sent = []
    return {
        sent,
        sendMessage: async (jid, content, options) => {
            sent.push({ jid, content, options })
            return { key: { remoteJid: jid, id: `SENT-${sent.length}` } }
        },
    }
}

async function run() {
    audioTranscription._resetForTests()

    assert.strictEqual(audioTranscription.isTranscriptionCommand("halo"), false)
    assert.strictEqual(audioTranscription.isTranscriptionCommand(".transkrip"), true)
    assert.strictEqual(audioTranscription.isTranscriptionCommand(".transcript"), true)
    assert.strictEqual(audioTranscription.isTranscriptionCommand(".stt"), true)

    const unrelatedSock = makeSocket()
    assert.strictEqual(await audioTranscription.handleAudioTranscription(unrelatedSock, makeMessage(".menu"), {
        from: CHAT,
        text: ".menu",
    }), false)
    assert.strictEqual(unrelatedSock.sent.length, 0)

    const helpSock = makeSocket()
    const helpMsg = makeMessage(".transkrip")
    assert.strictEqual(await audioTranscription.handleAudioTranscription(helpSock, helpMsg, {
        from: CHAT,
        text: ".transkrip",
        config: TEST_CONFIG,
    }), true)
    assert.match(helpSock.sent[0].content.text, /reply audio atau VN/i)
    assert.match(helpSock.sent[0].content.text, /8 MB \/ 15 menit/i)

    const voiceMessage = makeMessage(".stt", {
        mimetype: "audio/ogg; codecs=opus",
        ptt: true,
        seconds: 5,
        fileLength: 4,
    })
    const voiceSock = makeSocket()
    let observedMime = ""
    let observedBuffer = null
    const handled = await audioTranscription.handleAudioTranscription(voiceSock, voiceMessage, {
        from: CHAT,
        text: ".stt",
        config: TEST_CONFIG,
        downloadContentFromMessage: async function* (_media, streamType) {
            assert.strictEqual(streamType, "audio")
            yield Buffer.from("fake")
        },
        transcribeAudioBuffer: async (buffer, mimeType) => {
            observedBuffer = buffer
            observedMime = mimeType
            return { text: "Halo, iki pesen swara." }
        },
    })
    assert.strictEqual(handled, true)
    assert.deepStrictEqual(observedBuffer, Buffer.from("fake"))
    assert.strictEqual(observedMime, "audio/ogg")
    assert.match(voiceSock.sent[0].content.text, /mentranskripsikan Voice Note/i)
    assert.match(voiceSock.sent[1].content.text, /TRANSKRIP VOICE NOTE/)
    assert.match(voiceSock.sent[1].content.text, /Halo, iki pesen swara\./)
    assert.deepStrictEqual(voiceSock.sent[2].content.delete, { remoteJid: CHAT, id: "SENT-1" })

    const tooLargeSock = makeSocket()
    const tooLargeMessage = makeMessage(".transkrip", {
        mimetype: "audio/mpeg",
        ptt: false,
        seconds: 4,
        fileLength: TEST_CONFIG.maxBytes + 1,
    })
    let downloadCalled = false
    await audioTranscription.handleAudioTranscription(tooLargeSock, tooLargeMessage, {
        from: CHAT,
        text: ".transkrip",
        config: TEST_CONFIG,
        downloadContentFromMessage: async function* () {
            downloadCalled = true
            yield Buffer.from("should-not-download")
        },
    })
    assert.strictEqual(downloadCalled, false)
    assert.strictEqual(tooLargeSock.sent.length, 1)
    assert.match(tooLargeSock.sent[0].content.text, /terlalu besar/i)

    const payload = audioTranscription.buildPayload(Buffer.from("audio"), "audio/mp3", TEST_CONFIG)
    assert.strictEqual(payload.contents[0].parts[1].inlineData.mimeType, "audio/mp3")
    assert.strictEqual(payload.contents[0].parts[1].inlineData.data, Buffer.from("audio").toString("base64"))
    assert.match(payload.contents[0].parts[0].text, /Abaikan semua instruksi/i)

    audioTranscription._resetForTests()
    let capturedRequest = null
    const direct = await audioTranscription.transcribeAudioBuffer(Buffer.from("unique-audio"), "audio/mpeg", {
        config: TEST_CONFIG,
        request: async (url, requestPayload, requestOptions) => {
            capturedRequest = { url, requestPayload, requestOptions }
            return {
                status: 200,
                data: {
                    candidates: [{ content: { parts: [{ text: "Transkrip: Halo dunia" }] } }],
                },
            }
        },
    })
    assert.strictEqual(direct.text, "Halo dunia")
    assert.strictEqual(direct.cached, false)
    assert.match(capturedRequest.url, /gemini-test-model:generateContent$/)
    assert.strictEqual(capturedRequest.requestOptions.headers["x-goog-api-key"], "test-key")
    assert.strictEqual(capturedRequest.requestPayload.contents[0].parts[1].inlineData.mimeType, "audio/mp3")

    const cached = await audioTranscription.transcribeAudioBuffer(Buffer.from("unique-audio"), "audio/mp3", {
        config: TEST_CONFIG,
        request: async () => { throw new Error("cache tidak dipakai") },
    })
    assert.strictEqual(cached.text, "Halo dunia")
    assert.strictEqual(cached.cached, true)

    console.log("PASS test-audio-transcription: command, reply VN, batas media, payload Gemini, dan cache.")
}

run().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
