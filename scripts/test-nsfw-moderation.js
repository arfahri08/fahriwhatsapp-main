"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const helpers = require("./group-utility-test-helpers")

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-nsfw-test-"))
process.env.NSFW_MODERATION_STATE_FILE = path.join(temp, "nsfw.json")
const nsfw = require("../modules/imageNsfwModeration")

function imageMsg(id, options = {}) {
    return helpers.makeMsg("", { id, participant: options.participant || helpers.USER_PN, message: { imageMessage: { caption: "photo" } } })
}

async function run() {
    const sock = helpers.makeSock()
    let inference = 0
    const context = helpers.makeContext("", { senderJid: helpers.USER_PN, extra: { inspectImage: async () => { inference += 1; return { available: true, confidence: 0.95, category: "porn", predictions: { Porn: 0.95 } } } } })
    let result = await nsfw.moderateImage(sock, imageMsg("disabled"), context)
    assert.strictEqual(result.reason, "disabled")
    assert.strictEqual(inference, 0, "default disabled tidak menjalankan model")

    nsfw.setGroupConfig(helpers.GROUP_JID, { enabled: true, threshold: 0.8, action: "WARN" }, helpers.ADMIN_JID)
    result = await nsfw.moderateImage(sock, imageMsg("warn"), context)
    assert.strictEqual(result.action, "WARN")
    assert.match(sock.calls.send.at(-1).content.text, /NSFW/)

    nsfw.setGroupConfig(helpers.GROUP_JID, { action: "DELETE" }, helpers.ADMIN_JID)
    result = await nsfw.moderateImage(sock, imageMsg("delete"), context)
    assert.strictEqual(result.action, "DELETE")
    assert.ok(sock.calls.send.at(-1).content.delete)

    const deniedSock = helpers.makeSock({ botAdmin: false })
    const before = deniedSock.calls.send.length
    result = await nsfw.moderateImage(deniedSock, imageMsg("denied"), helpers.makeContext("", { senderJid: helpers.USER_PN, extra: { inspectImage: context.inspectImage } }))
    assert.strictEqual(result.reason, "bot-not-admin")
    assert.strictEqual(deniedSock.calls.send.length, before, "bot bukan admin => zero group action")
    const statusResult = await nsfw.moderateImage(sock, { key: { id: "status", remoteJid: "status@broadcast" }, message: { imageMessage: {} } }, { from: "status@broadcast" })
    assert.strictEqual(statusResult.reason, "excluded")

    let active = 0
    let peak = 0
    let release
    const blocker = new Promise(resolve => { release = resolve })
    const boundedContext = helpers.makeContext("", { senderJid: helpers.USER_PN, extra: { inspectImage: async msg => {
        active += 1; peak = Math.max(peak, active)
        if (msg.key.id === "queue-1") await blocker
        active -= 1
        return { available: true, confidence: 0.1, predictions: { Porn: 0.1 } }
    } } })
    const first = nsfw.moderateImage(sock, imageMsg("queue-1"), boundedContext)
    const second = nsfw.moderateImage(sock, imageMsg("queue-2"), boundedContext)
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(active, 1, "inference concurrency harus satu")
    release()
    await Promise.all([first, second])
    assert.strictEqual(peak, 1)
    assert.strictEqual(nsfw.getQueueHealth().peakActive, 1)
    const moduleSource = fs.readFileSync(path.join(__dirname, "..", "modules", "imageNsfwModeration.js"), "utf8")
    assert.match(moduleSource, /require\("\.\/stickerSafetyGuard"\)/, "harus reuse existing model pipeline")
    assert.doesNotMatch(moduleSource, /require\(["']nsfwjs["']\)/, "tidak boleh membuat loader nsfwjs kedua")

    nsfw.resetRuntime()
    console.log("PASS test-nsfw-moderation")
}

run().finally(() => fs.rmSync(temp, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1 })
