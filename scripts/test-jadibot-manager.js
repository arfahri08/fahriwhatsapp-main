"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { EventEmitter } = require("events")
const { createJadibotManager } = require("../modules/jadibotManager")

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-jadibot-test-"))
let connectorCalls = 0
const sockets = []
async function connector() {
    connectorCalls += 1
    const ev = new EventEmitter()
    const socket = { ev, ended: false, end() { this.ended = true } }
    sockets.push(socket)
    return { socket, pairingCode: connectorCalls === 1 ? "1234-5678" : "", registered: connectorCalls > 1 }
}

async function wait(ms = 30) { return new Promise(resolve => setTimeout(resolve, ms)) }

async function run() {
    const manager = createJadibotManager({ configFile: path.join(temp, "config.json"), sessionRoot: path.join(temp, "sessions"), connector, reconnectBaseMs: 10, maxReconnectAttempts: 1 })
    let result = await manager.start({ requester: "628111111111@s.whatsapp.net" })
    assert.strictEqual(result.reason, "disabled", "Jadibot wajib disabled default")
    manager.configure("on")
    manager.configure("limit", 1)
    result = await manager.start({ requester: "628111111111@s.whatsapp.net" })
    assert.strictEqual(result.started, true)
    assert.strictEqual(result.pairingCode, "1234-5678")
    assert.ok(manager.sessionPath("pn:628111111111").startsWith(path.join(temp, "sessions") + path.sep), "session path harus isolated")
    const duplicate = await manager.start({ requester: "628111111111@s.whatsapp.net" })
    assert.strictEqual(duplicate.duplicate, true)
    assert.strictEqual(connectorCalls, 1, "duplicate start tidak membuat socket kedua")
    const full = await manager.start({ requester: "628222222222@s.whatsapp.net" })
    assert.strictEqual(full.reason, "limit-full")

    sockets[0].ev.emit("connection.update", { connection: "close" })
    await wait()
    assert.strictEqual(connectorCalls, 2, "reconnect bounded harus mencoba sekali")
    sockets[1].ev.emit("connection.update", { connection: "close" })
    await wait()
    assert.strictEqual(manager.active.size, 0, "session berhenti setelah reconnect limit")

    manager.configure("limit", 2)
    await manager.start({ requester: "628111111111@s.whatsapp.net" })
    const stopped = manager.stop("628111111111@s.whatsapp.net")
    assert.strictEqual(stopped.stopped, true)
    assert.strictEqual(sockets.at(-1).ended, true, "stop harus menutup socket")
    const statusText = JSON.stringify({ status: manager.status("628111111111@s.whatsapp.net"), list: manager.list() })
    assert.doesNotMatch(statusText, /1234-5678|creds\.json|advSecretKey|noiseKey|signalKey/i, "status/list tidak boleh menampilkan secret")

    manager.requestDelete("628111111111@s.whatsapp.net")
    assert.strictEqual(manager.confirmDelete("628111111111@s.whatsapp.net").deleted, true)
    assert.strictEqual(fs.existsSync(manager.sessionPath("pn:628111111111")), false)
    manager.dispose()
    console.log("PASS test-jadibot-manager")
}

run().finally(() => fs.rmSync(temp, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1 })
