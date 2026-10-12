"use strict"

const assert = require("assert")
const replies = require("../modules/replies")

const PRIVATE_JID = "628111111111@s.whatsapp.net"
const GROUP_JID = "120363000000000000@g.us"

function message(remoteJid, text = "halo") {
    return {
        key: { remoteJid, id: `TEST-${text}`, fromMe: false },
        message: { conversation: text },
    }
}

function privateMessage(text = "halo") {
    return message(PRIVATE_JID, text)
}

function groupMessage(text = "halo") {
    return message(GROUP_JID, text)
}

function collect(count, callback) {
    return Array.from({ length: count }, callback)
}

function assertNoAdjacentDuplicates(values, label) {
    for (let index = 1; index < values.length; index += 1) {
        assert.notStrictEqual(values[index], values[index - 1], `${label} tidak boleh berulang langsung`)
    }
}

function run() {
    const health = replies.getVariationHealth()
    assert(health.fallbackPool >= 60, "fallback harus memiliki sedikitnya 60 variasi")
    assert(health.followUp >= 8, "follow-up harus memiliki sedikitnya 8 variasi")
    for (const intent of ["salam", "identity", "ping", "availability", "thanks", "greeting"]) {
        assert(health.intents[intent] >= 8, `intent ${intent} harus memiliki sedikitnya 8 variasi`)
    }
    assert.strictEqual(health.antiRepeatWindow, 5)

    assert.strictEqual(replies.classifyIntent("Assalamualaikum"), "salam")
    assert.strictEqual(replies.classifyIntent("kamu siapa?"), "identity")
    assert.strictEqual(replies.classifyIntent("p"), "ping")
    assert.strictEqual(replies.classifyIntent("PING!"), "ping")
    assert.strictEqual(replies.classifyIntent("lagi sibuk?"), "availability")
    assert.strictEqual(replies.classifyIntent("makasih ya"), "thanks")
    assert.strictEqual(replies.classifyIntent("halo kak"), "greeting")
    assert.strictEqual(replies.classifyIntent("sampai bertemu besok"), "", "huruf p di tengah pesan bukan intent ping")
    assert.strictEqual(replies.classifyIntent("tolong periksa pesan ini"), "", "pesan biasa harus masuk fallback")

    const originalRandom = Math.random
    Math.random = () => 0
    try {
        replies._resetRecentForTest()
        const fallback = collect(8, () => replies.getRandomForMessage(privateMessage("pesan biasa")))
        assertNoAdjacentDuplicates(fallback, "fallback")
        assert(new Set(fallback).size >= 6, "anti-repeat harus memberi setidaknya 6 fallback berbeda sebelum berputar")

        replies._resetRecentForTest()
        const pings = collect(8, () => replies.getIntentReplyForMessage(privateMessage("ping"), "ping"))
        assertNoAdjacentDuplicates(pings, "intent ping")
        assert(new Set(pings).size >= 6, "intent ping harus bervariasi")

        replies._resetRecentForTest()
        const followUps = collect(8, () => replies.getFollowUpForMessage(privateMessage()))
        assertNoAdjacentDuplicates(followUps, "follow-up")
        assert(new Set(followUps).size >= 6, "follow-up harus bervariasi")
    } finally {
        Math.random = originalRandom
        replies._resetRecentForTest()
    }

    assert.strictEqual(replies.getIntentReplyForMessage(groupMessage("ping"), "ping"), null)
    assert.strictEqual(replies.getFollowUpForMessage(groupMessage()), null)
    assert.strictEqual(replies.getRandomForMessage(groupMessage()), null)

    console.log("PASS test-auto-reply-variation")
}

run()
