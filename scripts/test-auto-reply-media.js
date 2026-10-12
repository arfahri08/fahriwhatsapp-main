"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")

const autoReply = require("../modules/autoReply")
const autoReplyScope = require("../modules/autoReplyScope")

const PRIVATE_JID = "628111111111@s.whatsapp.net"

function message(content, key = {}) {
    return {
        key: {
            remoteJid: PRIVATE_JID,
            id: key.id || "TEST-MEDIA",
            fromMe: Boolean(key.fromMe),
        },
        message: content,
    }
}

for (const type of [
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "documentMessage",
    "stickerMessage",
    "ptvMessage",
]) {
    const msg = message({ [type]: { mimetype: "application/octet-stream" } }, { id: `TEST-${type}` })
    assert.strictEqual(autoReplyScope.hasAutoReplyableMedia(msg), true, type)
    assert.strictEqual(autoReply.hasAutoReplyableMedia(msg), true, type)
    assert.strictEqual(autoReplyScope.shouldProcessAutoReplyMessage(msg), true, type)
}

assert.strictEqual(autoReplyScope.hasAutoReplyableMedia(message({ conversation: "halo" })), false)
assert.strictEqual(autoReplyScope.hasAutoReplyableMedia(message({
    ephemeralMessage: {
        message: { stickerMessage: { mimetype: "image/webp" } },
    },
})), true)

const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")
assert.ok(indexSource.includes("const shouldAutoReplyForMedia = autoReply.hasAutoReplyableMedia(msg)"))
assert.ok(indexSource.includes("if (isStickerMediaMessage && !autoReply.shouldProcessMessage(msg"))
assert.ok(!indexSource.includes("if (isStickerMediaMessage) return"))

console.log("PASS media/sticker private dapat mencapai fallback Auto Reply")
