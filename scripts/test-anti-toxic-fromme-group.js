"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
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

// Nilai lama sengaja dibuat true untuk membuktikan bahwa .env tidak dapat
// mengaktifkan warning owner kembali.
process.env.ANTI_TOXIC_WARN_OWNER_MESSAGES = "true"
process.env.ANTI_TOXIC_WARN_OWNER_GROUP_MESSAGES = "true"
process.env.ANTI_TOXIC_STICKER_WARN_FROM_ME = "true"

const antiToxic = require("../modules/antiToxic")
Module._load = originalLoad

async function main() {
    const shouldWarn = antiToxic._shouldWarnOwnerMessageForTest
    assert.strictEqual(typeof shouldWarn, "function", "helper policy harus tersedia")

    assert.strictEqual(
        shouldWarn({ key: { remoteJid: "120363000000000000@g.us", fromMe: true } }),
        false,
        "owner/userbot di grup tidak boleh menerima warning anti-toxic"
    )

    assert.strictEqual(
        shouldWarn({ key: { remoteJid: "628123456789@s.whatsapp.net", fromMe: true } }),
        false,
        "owner/userbot di private tidak boleh menerima warning anti-toxic"
    )

    const root = path.join(__dirname, "..")
    const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8")
    const antiSource = fs.readFileSync(path.join(root, "modules", "antiToxic.js"), "utf8")

    assert(indexSource.includes("OWNER_ANTI_TOXIC_EXEMPT_POLICY"), "index harus memakai marker kebijakan owner exempt")
    assert(indexSource.includes("const allowFromMeStickerModeration = false"), "stiker owner harus dikecualikan")
    assert(indexSource.includes("const allowFromMeTextModeration = false"), "teks owner harus dikecualikan")
    assert(antiSource.includes("if (isOwnerSender)"), "defense-in-depth owner exemption harus tersedia di detector")
    assert(!indexSource.includes("isMe && (isGroup || isAntiToxicWarnOwnerEnabled())"), "kebijakan lama grup tidak boleh tersisa")
    assert(!indexSource.includes("isMe && (itemIsGroup || isAntiToxicWarnOwnerEnabled())"), "kebijakan lama preprocessing tidak boleh tersisa")

    const sent = []
    const ownerJid = "628111111111@s.whatsapp.net"
    const memberJid = "628222222222@s.whatsapp.net"
    const groupJid = "120363000000000000@g.us"
    const sock = {
        user: { id: "628111111111:1@s.whatsapp.net" },
        sendMessage: async (jid, content, options) => {
            sent.push({ jid, content, options })
            return { key: { id: `SENT-${sent.length}`, remoteJid: jid, fromMe: true } }
        },
        groupMetadata: async jid => ({
            id: jid,
            subject: "Regression Test Group",
            participants: [
                { id: memberJid },
                { id: ownerJid, admin: "admin" },
            ],
        }),
        onWhatsApp: async jid => [{ exists: true, jid }],
    }

    // Redam log internal selama integration assertions agar output test ringkas.
    const originalConsoleLog = console.log
    console.log = () => {}
    try {
        const ownerTextResult = await antiToxic.handleToxicCheck({
            key: { remoteJid: groupJid, fromMe: true, participant: ownerJid, id: "OWNER-TEXT" },
            message: { conversation: "anjing" },
            pushName: "Owner",
        }, sock, ownerJid, {})
        assert.strictEqual(ownerTextResult, false, "teks toxic owner di grup harus di-skip")
        assert.strictEqual(sent.length, 0, "teks toxic owner tidak boleh mengirim warning")

        const ownerStickerResult = await antiToxic.handleToxicCheck({
            key: { remoteJid: groupJid, fromMe: true, participant: ownerJid, id: "OWNER-STICKER" },
            message: { stickerMessage: { mimetype: "image/webp" } },
            pushName: "Owner",
        }, sock, ownerJid, {})
        assert.strictEqual(ownerStickerResult, false, "stiker owner di grup harus di-skip")
        assert.strictEqual(sent.length, 0, "stiker owner tidak boleh mengirim warning")

        const memberResult = await antiToxic.handleToxicCheck({
            key: { remoteJid: groupJid, fromMe: false, participant: memberJid, id: "MEMBER-TEXT" },
            message: { conversation: "anjing" },
            pushName: "Member",
        }, sock, ownerJid, {})
        assert.strictEqual(memberResult, true, "member biasa di grup tetap harus dimoderasi")
        assert.strictEqual(sent.length, 1, "member toxic harus menghasilkan tepat satu warning")
        assert.strictEqual(sent[0].jid, groupJid, "warning member harus dikirim ke grup")
        assert.strictEqual(sent[0].options?.quoted?.key?.id, "MEMBER-TEXT", "warning harus reply pesan pelanggar")
        assert(sent[0].content?.mentions?.includes(memberJid), "warning harus mention member pelanggar")
    } finally {
        console.log = originalConsoleLog
    }

    console.log("PASS anti-toxic owner exemption policy")
    console.log("- owner/fromMe group text: exempt")
    console.log("- owner/fromMe group sticker: exempt")
    console.log("- owner/fromMe private: exempt")
    console.log("- legacy env cannot re-enable owner warning")
    console.log("- ordinary group member still receives one quoted + mentioned warning")
}

main().catch(error => {
    console.error(error?.stack || error)
    process.exit(1)
})
