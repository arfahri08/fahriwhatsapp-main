"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-security-research-v111-"))
process.env.WA_SECURITY_RESEARCH_STATE_PATH = path.join(tmp, "state.json")

const lab = require("../modules/waSecurityResearchLab")

async function main() {
    lab.resetRuntimeForTests()

    assert.strictEqual(lab.toJid("081234567890"), "6281234567890@s.whatsapp.net")

    const safe = lab.analyzePayload({ text: "Halo aman" })
    assert.strictEqual(safe.safe, true)

    const oversized = lab.analyzePayload({ text: "x".repeat(lab.LIMITS.maxSingleStringChars + 1) })
    assert.strictEqual(oversized.blocked, true)

    const scan = lab.analyzeSourceText("for (let i=0;i<10;i++) sock.relayMessage(jid, x); x.repeat(10)")
    assert.ok(scan.findings.some(x => x.name === "relay-message"))
    assert.ok(scan.findings.some(x => x.name === "loop"))
    assert.ok(scan.findings.some(x => x.name === "repeat-builder"))

    let transportSendCount = 0
    const guardedSock = {
        sendMessage: async () => { transportSendCount += 1; return { key: { id: `SAFE-${transportSendCount}` } } },
        relayMessage: async () => ({ key: { id: "RELAY" } }),
    }
    assert.strictEqual(lab.installOutboundSafetyGuard(guardedSock), true)
    assert.strictEqual(lab.installOutboundSafetyGuard(guardedSock), false)
    await guardedSock.sendMessage("628111111111@s.whatsapp.net", { text: "normal" })
    assert.strictEqual(transportSendCount, 1)

    let blocked = false
    try {
        await guardedSock.sendMessage("628111111111@s.whatsapp.net", { text: "z".repeat(lab.LIMITS.maxSingleStringChars + 10) })
    } catch (error) {
        blocked = error?.code === "WA_PAYLOAD_BLOCKED"
    }
    assert.strictEqual(blocked, true)
    assert.strictEqual(transportSendCount, 1, "blocked payload must not reach transport")

    const sends = []
    const sock = {
        sendMessage: async (jid, content) => {
            sends.push({ jid, content })
            return { key: { id: `TEST-${sends.length}` } }
        },
    }
    lab.installOutboundSafetyGuard(sock)

    const msg = { key: { remoteJid: "628111111111@s.whatsapp.net", id: "CMD1" }, message: { conversation: "" } }
    const ctx = text => ({
        text,
        from: msg.key.remoteJid,
        replyJid: msg.key.remoteJid,
        isGroup: false,
        isOwner: true,
        canControlOwner: true,
    })

    assert.strictEqual(await lab.handleResearchLabCommand(sock, msg, ctx(".waresearch target 628222222222")), true)
    const beforeProbe = sends.length
    assert.strictEqual(await lab.handleResearchLabCommand(sock, msg, ctx(".waresearch send baseline")), true)
    assert.strictEqual(sends.length, beforeProbe + 2, "target probe + owner acknowledgement expected")
    assert.strictEqual(sends[beforeProbe].jid, "628222222222@s.whatsapp.net")
    assert.ok(String(sends[beforeProbe].content.text).includes("baseline probe"))

    const beforeUnicode = sends.length
    await lab.handleResearchLabCommand(sock, msg, ctx(".waresearch send unicode 9999"))
    const unicodePayload = sends[beforeUnicode].content.text
    const zeroWidthCount = [...unicodePayload].filter(ch => ch === "\u200B").length
    assert.strictEqual(zeroWidthCount, lab.MAX_SAFE_UNICODE_MARKS)


    // Simplified manual live test: command -> number -> automatic testing -> report.
    const beforeSimpleTest = sends.length
    assert.strictEqual(await lab.handleResearchLabCommand(sock, msg, ctx(".waresearch test")), true)
    assert.ok(String(sends.at(-1).content.text).includes("Ketik nomor test"))
    const beforeNumber = sends.length
    assert.strictEqual(await lab.handleResearchLabCommand(sock, msg, ctx("628333333333")), true)
    assert.strictEqual(sends.length, beforeNumber + 3, "number input should produce testing notice + exactly one target send + owner report")
    assert.ok(String(sends[beforeNumber].content.text).includes("Testing ke"))
    assert.strictEqual(sends[beforeNumber + 1].jid, "628333333333@s.whatsapp.net")
    assert.ok(String(sends[beforeNumber + 1].content.text).includes("baseline probe"))
    assert.ok(String(sends[beforeNumber + 2].content.text).includes("LAPORAN PERCOBAAN WA"))
    assert.ok(String(sends[beforeNumber + 2].content.text).includes("BERHASIL DIKIRIM"))
    assert.ok(sends.length >= beforeSimpleTest + 4)

    // Direct target form also tests immediately; there is no probe-choice/preview/KIRIM stage.
    const beforeDirect = sends.length
    assert.strictEqual(await lab.handleResearchLabCommand(sock, msg, ctx(".waresearch test 628444444444")), true)
    assert.strictEqual(sends.length, beforeDirect + 3)
    assert.strictEqual(sends[beforeDirect + 1].jid, "628444444444@s.whatsapp.net")
    assert.ok(String(sends[beforeDirect + 2].content.text).includes("LAPORAN PERCOBAAN WA"))
    assert.ok(!sends.slice(beforeSimpleTest).some(x => String(x.content?.text || "").includes("Pilih probe live aman")))
    assert.ok(!sends.slice(beforeSimpleTest).some(x => String(x.content?.text || "").includes("PREVIEW LIVE RESEARCH TEST")))

    const beforeDryRun = sends.length
    await lab.handleResearchLabCommand(sock, msg, ctx(".waresearch simulate crash"))
    assert.strictEqual(sends.length, beforeDryRun + 1, "simulate must only reply to owner")
    assert.ok(String(sends.at(-1).content.text).includes("MOCK ONLY"))

    const beforeGroup = sends.length
    await lab.handleResearchLabCommand(sock, msg, { ...ctx(".waresearch send baseline"), isGroup: true })
    await lab.handleResearchLabCommand(sock, msg, { ...ctx(".waresearch send baseline"), isOwner: false, canControlOwner: false })
    assert.strictEqual(sends.length, beforeGroup)

    const helpSource = fs.readFileSync(path.join(__dirname, "../modules/help.js"), "utf8")
    const privateMenuSource = fs.readFileSync(path.join(__dirname, "../modules/privateHelloMenu.js"), "utf8")
    const catalogSource = fs.readFileSync(path.join(__dirname, "../modules/serviceCommandCatalog.js"), "utf8")
    const indexSource = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8")
    assert(helpSource.includes(".waresearch test"))
    assert(helpSource.includes("testing otomatis"))
    assert(privateMenuSource.includes(".pmenu research"))
    assert(privateMenuSource.includes(".waresearch test"))
    assert(privateMenuSource.includes("testing otomatis"))
    assert(catalogSource.includes("testing nomor manual + laporan"))
    assert(indexSource.includes("waSecurityResearchLab.installOutboundSafetyGuard(sock)"))
    assert(indexSource.includes("waSecurityResearchLab.handleResearchLabCommand"))

    console.log("PASS test-wa-security-research-lab")
}

main().finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
}).catch(error => {
    console.error(error)
    process.exit(1)
})
