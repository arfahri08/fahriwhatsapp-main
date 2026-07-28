"use strict"

const assert = require("assert")
const Module = require("module")

// Test policy ini tidak membutuhkan dependency eksternal. Stub hanya dipakai
// agar modules/antiToxic.js dapat dimuat pada lingkungan validasi minimal.
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "axios") {
        return {
            get: async () => ({ data: {} }),
            post: async () => ({ data: {} }),
        }
    }
    if (request === "@whiskeysockets/baileys") {
        return {
            downloadContentFromMessage: async function* emptyDownload() {},
        }
    }
    return originalLoad.call(this, request, parent, isMain)
}

process.env.ANTI_TOXIC_WARN_OWNER_MESSAGES = "false"
process.env.ANTI_TOXIC_WARN_OWNER_GROUP_MESSAGES = "false"

const antiToxic = require("../modules/antiToxic")
Module._load = originalLoad

const shouldWarn = antiToxic._shouldWarnOwnerMessageForTest
assert.strictEqual(typeof shouldWarn, "function", "helper policy harus tersedia")

assert.strictEqual(
    shouldWarn({ key: { remoteJid: "120363000000000000@g.us", fromMe: true } }),
    true,
    "pesan manual userbot di grup wajib dimoderasi walaupun .env lama bernilai false"
)

assert.strictEqual(
    shouldWarn({ key: { remoteJid: "628123456789@s.whatsapp.net", fromMe: true } }),
    false,
    "private chat owner tetap mengikuti ANTI_TOXIC_WARN_OWNER_MESSAGES"
)

console.log("PASS anti-toxic fromMe group policy")
