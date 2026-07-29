"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reminder-at-most-once-test-"))
process.env.REMINDER_DATA_DIR = tempRoot
process.env.REMINDER_DATA_FILE = path.join(tempRoot, "reminder.json")
process.env.REMINDER_HEADER_FILE = path.join(tempRoot, "reminder_header.txt")
process.env.REMINDER_MEDIA_DIR = path.join(tempRoot, "media")

fs.mkdirSync(process.env.REMINDER_MEDIA_DIR, { recursive: true })
fs.writeFileSync(process.env.REMINDER_DATA_FILE, "[]\n", "utf8")
const expectedHeader = "[REMINDER] *INI ADALAH PESAN OTOMATIS oleh USERBOT FAHRI*\n\n"
fs.writeFileSync(process.env.REMINDER_HEADER_FILE, expectedHeader, "utf8")

const Module = require("module")
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "@whiskeysockets/baileys") {
        return {
            async downloadContentFromMessage() {
                throw new Error("media download should not run in this test")
            },
        }
    }
    return originalLoad.call(this, request, parent, isMain)
}
const reminder = require("../modules/reminder")
Module._load = originalLoad

function currentTime() {
    const now = new Date()
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
}

async function sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms))
}

async function run() {
    const targets = Array.from({ length: 19 }, (_, index) => ({
        jid: `628123450${String(index).padStart(3, "0")}@s.whatsapp.net`,
        label: `Kontak ${index + 1}`,
    }))

    const batch = await reminder.addReminderBatch(
        targets,
        currentTime(),
        "Pesan massal satu kali",
        null,
        { batchId: "test-batch-19" }
    )
    assert.equal(batch.success, true)
    assert.equal(batch.created, 19)
    assert.equal(reminder.getReminders().length, 19)

    const duplicateBatch = await reminder.addReminderBatch(
        targets,
        currentTime(),
        "Pesan massal satu kali",
        null,
        { batchId: "test-batch-19" }
    )
    assert.equal(duplicateBatch.duplicate, true, "same batch id must be idempotent")
    assert.equal(reminder.getReminders().length, 19, "duplicate save must not grow queue")

    const counts = new Map()
    let firstSendStarted = false
    const sock = {
        async sendMessage(targetJid, outbound) {
            firstSendStarted = true
            counts.set(targetJid, Number(counts.get(targetJid) || 0) + 1)
            assert.equal(outbound.text, expectedHeader + "Pesan massal satu kali")
            await sleep(15)
            return { key: { id: `sent-${targetJid}`, remoteJid: targetJid, fromMe: true } }
        },
    }

    const firstRun = reminder.checkAndSendReminders(sock)
    while (!firstSendStarted) await sleep(1)

    // Queue sudah diclaim sebelum network send, jadi tick/restart tidak membaca batch yang sama.
    assert.equal(reminder.getReminders().length, 0, "due reminders must be claimed before first network send")

    const overlappingRun = reminder.checkAndSendReminders(sock)
    const [firstResult, overlappingResult] = await Promise.all([firstRun, overlappingRun])

    assert.equal(firstResult.claimed, 19)
    assert.equal(firstResult.sent, 19)
    assert.equal(firstResult.failed, 0)
    assert.deepEqual(overlappingResult, firstResult, "overlap must share the same active run")
    assert.equal(counts.size, 19)
    for (const target of targets) {
        assert.equal(counts.get(target.jid), 1, `${target.jid} must receive exactly one message`)
    }
    assert.equal(reminder.getReminders().length, 0)
    assert.equal(fs.readFileSync(process.env.REMINDER_HEADER_FILE, "utf8"), expectedHeader, "header must remain byte-for-byte unchanged")

    console.log("REMINDER_AT_MOST_ONCE_TESTS_OK")
}

run()
    .catch(error => {
        console.error(error)
        process.exitCode = 1
    })
    .finally(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true })
    })
