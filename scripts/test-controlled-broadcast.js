"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-jpm-test-"))
process.env.CONTROLLED_BROADCAST_STATE_FILE = path.join(temp, "broadcast.json")
process.env.CONTROLLED_BROADCAST_MEDIA_DIR = path.join(temp, "media")
const jpm = require("../modules/controlledBroadcast")

const bot = "999999999999@s.whatsapp.net"
const groups = ["1@g.us", "1@g.us", "2@g.us", "3@g.us", "4@g.us", "5@g.us"]
const metadataCalls = new Map()
const sent = []
const remote = {
    getEffectiveGroupConfig(jid) {
        return { configuredBotEnabled: jid !== "3@g.us", features: { broadcast: true } }
    },
    isGroupBotEnabled(jid) { return jid !== "3@g.us" },
    isGroupFeatureEnabled() { return true },
}
const sock = {
    user: { id: bot },
    async groupFetchAllParticipating() { return Object.fromEntries(groups.map((jid, index) => [`${index}`, { id: jid }])) },
    async groupMetadata(jid) {
        const count = (metadataCalls.get(jid) || 0) + 1
        metadataCalls.set(jid, count)
        if (jid === "4@g.us") throw new Error("metadata unavailable")
        const admin = jid !== "2@g.us" && !(jid === "5@g.us" && count >= 2)
        return { id: jid, participants: [{ id: bot, admin: admin ? "admin" : null }] }
    },
    async sendMessage(jid, content) { sent.push({ jid, content }); return { key: { id: `sent-${sent.length}`, remoteJid: jid } } },
}

async function run() {
    const preview = await jpm.previewTargets(sock, "all", { groupRemoteControl: remote })
    assert.strictEqual(preview.counts.found, 5, "duplicate group harus didedupe")
    assert.strictEqual(preview.counts.botNotAdmin, 1)
    assert.strictEqual(preview.counts.botOff, 1)
    assert.strictEqual(preview.counts.metadataUnavailable, 1)
    assert.strictEqual(preview.counts.eligible, 2)

    jpm.update(state => ({ ...state, job: { id: "JPM-A", status: "READY", delaySeconds: 3, content: { type: "text", text: "hello" }, targets: preview.targets } }))
    await jpm.executeJob(sock, "JPM-A", { groupRemoteControl: remote, sleep: async () => {} })
    assert.deepStrictEqual(sent.map(item => item.jid), ["1@g.us"], "admin yang hilang sebelum send harus di-skip")
    assert.strictEqual(jpm.snapshot().job.targets.find(item => item.jid === "5@g.us").status, "SKIPPED_RUNTIME")

    sent.length = 0
    jpm.update(state => ({ ...state, job: { id: "JPM-STOP", status: "READY", delaySeconds: 3, content: { type: "text", text: "stop" }, targets: [{ jid: "1@g.us", status: "PENDING" }, { jid: "6@g.us", status: "PENDING" }] } }))
    const originalSend = sock.sendMessage
    sock.sendMessage = async (jid, content) => {
        const output = await originalSend(jid, content)
        jpm.update(state => ({ ...state, job: { ...state.job, stopRequested: true } }))
        return output
    }
    await jpm.executeJob(sock, "JPM-STOP", { groupRemoteControl: remote, sleep: async () => {} })
    assert.strictEqual(sent.length, 1, "stop cooperative harus mencegah target tersisa")
    assert.strictEqual(jpm.snapshot().job.status, "STOPPED")
    sock.sendMessage = originalSend
    sent.length = 0

    jpm.update(state => ({ ...state, job: { id: "JPM-RESTART", status: "RUNNING", delaySeconds: 3, content: { type: "text", text: "resume" }, targets: [{ jid: "1@g.us", status: "SENT" }, { jid: "6@g.us", status: "SENDING" }, { jid: "7@g.us", status: "PENDING" }] } }))
    jpm.markRestartPaused()
    assert.strictEqual(jpm.snapshot().job.status, "PAUSED_RESTART")
    assert.strictEqual(jpm.snapshot().job.targets[1].status, "FAILED_AMBIGUOUS")
    assert.strictEqual(sent.length, 0, "restart state tidak boleh auto-resume")
    await jpm.executeJob(sock, "JPM-RESTART", { groupRemoteControl: remote, sleep: async () => {} })
    assert.strictEqual(sent.filter(item => item.jid === "1@g.us").length, 0, "target SENT tidak boleh dikirim ulang")
    assert.strictEqual(sent.filter(item => item.jid === "7@g.us").length, 1, "explicit execute/resume mengirim hanya pending")

    console.log("PASS test-controlled-broadcast")
}

run().finally(() => fs.rmSync(temp, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1 })
