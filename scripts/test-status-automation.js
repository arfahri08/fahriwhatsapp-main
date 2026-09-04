"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-status-auto-test-"))
process.env.STATUS_AUTOMATION_STATE_FILE = path.join(temp, "status.json")
process.env.MESSAGE_EDIT_GUARDIAN_DATA_FILE = path.join(temp, "edit-guardian.json")
const automation = require("../modules/statusAutomation")
const provenance = require("../modules/statusBroadcastProvenance")
const guardian = require("../modules/messageEditGuardian")
const statusDownloader = require("../modules/statusDownloader")

const sends = []
const sock = {
    async sendMessage(jid, content) {
        sends.push({ jid, content })
        return { key: { id: jid === "status@broadcast" && !content.react ? "own-status-1" : `send-${sends.length}`, remoteJid: jid, fromMe: true }, message: content }
    },
}

function status(id, sender, fromMe = false) {
    return { key: { id, remoteJid: "status@broadcast", participant: sender, fromMe }, message: { imageMessage: { caption: "status" } } }
}

async function run() {
    provenance.resetStatusProvenance()
    assert.strictEqual(automation.snapshot().autoreact.enabled, false, "autoreact default OFF")
    assert.strictEqual((await automation.handleIncomingStatus(sock, status("disabled", "628111111111@s.whatsapp.net"))).reason, "disabled")

    await automation.uploadStatus(sock, { key: { id: "cmd" }, message: { conversation: ".upsw Maintenance" } }, { text: ".upsw Maintenance" }, ".upsw Maintenance")
    assert.strictEqual(sends[0].jid, "status@broadcast", "owner upload harus menuju status broadcast")
    const found = provenance.findStatusProvenance({ key: { id: "own-status-1" } })
    assert.strictEqual(found.matched, true, "status upload provenance harus dipertahankan")
    const editResult = await guardian.handleMessageEditUpdate({ key: { id: "own-status-1", remoteJid: "628999999999@s.whatsapp.net" }, update: { message: { editedMessage: { message: { conversation: "edited" } } } } })
    assert.strictEqual(editResult.result, "status-broadcast", "own status tidak boleh masuk edit log")

    automation.update(state => { state.autoreact.enabled = true; state.autoreact.emojis = ["🔥"]; return state })
    const incoming = status("incoming-1", "628111111111@s.whatsapp.net")
    const reacted = await automation.handleIncomingStatus(sock, incoming, { sleep: async () => {} })
    assert.strictEqual(reacted.reacted, true)
    assert.strictEqual(sends.at(-1).content.react.text, "🔥")
    assert.strictEqual((await automation.handleIncomingStatus(sock, incoming, { sleep: async () => {} })).reason, "duplicate", "status ID hanya direact sekali")
    assert.strictEqual((await automation.handleIncomingStatus(sock, status("own-2", "628111111111@s.whatsapp.net", true))).reason, "own-status")

    automation.configureList("allow", "add", "628111111111")
    assert.strictEqual((await automation.handleIncomingStatus(sock, status("not-allow", "628222222222@s.whatsapp.net"), { sleep: async () => {} })).reason, "not-allowed")
    automation.configureList("block", "add", "628111111111")
    assert.strictEqual((await automation.handleIncomingStatus(sock, status("blocked", "628111111111@s.whatsapp.net"), { sleep: async () => {} })).reason, "blocked")
    assert.strictEqual(typeof statusDownloader.handleStatusDownloader, "function", "status downloader existing harus tetap reachable")

    automation.resetRuntimeQueue()
    console.log("PASS test-status-automation")
}

run().finally(() => fs.rmSync(temp, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1 })
