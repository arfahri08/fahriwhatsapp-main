"use strict"

const assert = require("assert")
const inspect = require("../modules/whatsappInspect")

async function run() {
    const calls = { info: 0, join: 0, send: [] }
    const sock = {
        async groupGetInviteInfo(code) {
            calls.info += 1
            assert.strictEqual(code, "AbCdEfGhIjKlMn")
            return { id: "123@g.us", subject: "Test Group", subjectOwner: "6281@s.whatsapp.net", desc: "Description", size: 2, announce: true, restrict: false, joinApprovalMode: true, participants: [{ admin: "admin" }, { admin: null }] }
        },
        async groupAcceptInvite() { calls.join += 1 },
        async sendMessage(jid, content) { calls.send.push({ jid, content }); return {} },
    }
    const parsed = inspect.parseInviteLink("https://chat.whatsapp.com/AbCdEfGhIjKlMn?utm_source=x")
    assert.strictEqual(parsed.code, "AbCdEfGhIjKlMn")
    await inspect.handleInspectCommand(sock, { key: { id: "i1" }, message: { conversation: ".inspect" } }, { from: "6289@s.whatsapp.net", senderJid: "6289@s.whatsapp.net", text: ".inspect https://chat.whatsapp.com/AbCdEfGhIjKlMn?utm_source=x", isGroup: false, isOwner: false })
    assert.strictEqual(calls.info, 1)
    assert.strictEqual(calls.join, 0, "inspect tidak boleh auto-join")
    assert.match(calls.send[0].content.text, /Member count: 2/)
    assert.doesNotMatch(calls.send[0].content.text, /AbCdEfGhIjKlMn/, "invite code tidak boleh dipantulkan")

    const sanitized = inspect.sanitizeMessageStructure({ messageSecret: "secret", mediaKey: "key", directPath: "/sensitive", nested: { ok: "yes", bytes: Buffer.alloc(100) } })
    assert.strictEqual(sanitized.messageSecret, "[REDACTED]")
    assert.strictEqual(sanitized.mediaKey, "[REDACTED]")
    assert.strictEqual(sanitized.directPath, "[REDACTED]")
    assert.match(sanitized.nested.bytes, /BINARY REDACTED/)

    calls.send.length = 0
    const huge = "x".repeat(5000)
    const msg = {
        key: { id: "q1", remoteJid: "6289@s.whatsapp.net" },
        message: { extendedTextMessage: { text: ".q", contextInfo: { stanzaId: "quoted", participant: "6281@s.whatsapp.net", quotedMessage: { extendedTextMessage: { text: huge, contextInfo: { messageSecret: "must-redact", mediaKey: "must-redact" } } } } } },
    }
    await inspect.handleInspectCommand(sock, msg, { from: "6289@s.whatsapp.net", text: ".q", isGroup: false, isOwner: true, maxInlineJson: 100 })
    assert.ok(Buffer.isBuffer(calls.send[0].content.document), "huge JSON harus dikirim sebagai document")
    const documentText = calls.send[0].content.document.toString("utf8")
    assert.doesNotMatch(documentText, /must-redact/)
    assert.match(documentText, /REDACTED/)
    console.log("PASS test-whatsapp-inspect")
}

run().catch(error => { console.error(error); process.exitCode = 1 })
