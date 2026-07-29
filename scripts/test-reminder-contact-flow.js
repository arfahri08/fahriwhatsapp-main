"use strict"

const assert = require("assert")
const flow = require("../modules/reminderContactFlow")

const OWNER_CHAT = "628999999999@s.whatsapp.net"

function message(text = "", message = null, id = `m-${Math.random()}`) {
    return {
        key: { remoteJid: OWNER_CHAT, fromMe: true, id },
        message: message || { conversation: text },
    }
}

function contactEntry(name, number) {
    return {
        displayName: name,
        vcard: [
            "BEGIN:VCARD",
            "VERSION:3.0",
            `FN:${name}`,
            `TEL;type=CELL;type=VOICE;waid=${number}:+${number}`,
            "END:VCARD",
        ].join("\n"),
    }
}

async function run() {
    flow.disposeReminderContactFlow()
    const sends = []
    const reminderCalls = []
    const promptKey = { id: "prompt-1", remoteJid: OWNER_CHAT, fromMe: true }
    const sock = {
        async sendMessage(targetJid, outbound) {
            sends.push({ targetJid, outbound })
            return { key: outbound.edit || promptKey }
        },
    }
    const reminder = {
        async addReminder(jid, time, text, media, options) {
            reminderCalls.push({ jid, time, text, media, options })
            return true
        },
    }
    const context = text => ({
        from: OWNER_CHAT,
        text,
        isGroup: false,
        isOwner: true,
        reminder,
    })

    let handled = await flow.handleReminderContactFlow(sock, message(".remind"), context(".remind"))
    assert.equal(handled, true, "exact .remind starts wizard")
    assert.equal(sends.length, 1)
    assert(!sends[0].outbound.edit, "first prompt is a new message")
    assert(sends[0].outbound.text.includes("kirim *kontak*"))

    const contactMessage = {
        contactsArrayMessage: {
            displayName: "2 kontak",
            contacts: [
                contactEntry("Mama Rumah", "628111111111"),
                contactEntry("Kakak", "628222222222"),
            ],
        },
    }
    handled = await flow.handleReminderContactFlow(sock, message("", contactMessage), context(""))
    assert.equal(handled, true)
    assert.equal(sends.length, 2)
    assert.deepEqual(sends[1].outbound.edit, promptKey, "contact result edits the same bot prompt")
    assert(sends[1].outbound.text.includes("628111111111 — Mama Rumah"))
    assert(sends[1].outbound.text.includes("628222222222 — Kakak"))

    handled = await flow.handleReminderContactFlow(
        sock,
        message("081333333333, 081444444444"),
        context("081333333333, 081444444444")
    )
    assert.equal(handled, true, "owner can correct detected numbers")
    assert(sends.at(-1).outbound.text.includes("628133333333"))
    assert(sends.at(-1).outbound.text.includes("628144444444"))

    handled = await flow.handleReminderContactFlow(sock, message("lanjut"), context("lanjut"))
    assert.equal(handled, true)
    assert(sends.at(-1).outbound.text.includes("MASUKKAN PESAN REMINDER"))
    assert.deepEqual(sends.at(-1).outbound.edit, promptKey)

    handled = await flow.handleReminderContactFlow(
        sock,
        message("Jangan lupa ibadah malam"),
        context("Jangan lupa ibadah malam")
    )
    assert.equal(handled, true)
    assert(sends.at(-1).outbound.text.includes("TENTUKAN JAM REMINDER"))
    assert(sends.at(-1).outbound.text.includes("Header reminder tetap menggunakan template lama"))

    handled = await flow.handleReminderContactFlow(sock, message("19:30"), context("19:30"))
    assert.equal(handled, true)
    assert.equal(reminderCalls.length, 2, "one reminder per corrected target")
    assert.deepEqual(reminderCalls.map(item => item.jid), [
        "6281333333333@s.whatsapp.net",
        "6281444444444@s.whatsapp.net",
    ])
    assert(reminderCalls.every(item => item.time === "19:30"))
    assert(reminderCalls.every(item => item.text === "Jangan lupa ibadah malam"))
    assert.equal(flow.getSession(OWNER_CHAT), null, "session clears after save")
    assert(sends.at(-1).outbound.text.includes("REMINDER BERHASIL DISIMPAN"))

    // Regression: event jam yang sama bisa masuk dua kali saat batch besar masih disimpan.
    // Sesi harus dikunci sebelum await pertama agar hanya satu batch dibuat.
    flow.disposeReminderContactFlow()
    const concurrentSends = []
    let batchCalls = 0
    let releaseBatch
    const batchGate = new Promise(resolve => { releaseBatch = resolve })
    const concurrentSock = {
        async sendMessage(targetJid, outbound) {
            concurrentSends.push({ targetJid, outbound })
            return { key: outbound.edit || promptKey }
        },
    }
    const batchReminder = {
        async addReminderBatch(targets, time, text, media, options) {
            batchCalls += 1
            assert.equal(targets.length, 2)
            assert.equal(time, "20:15")
            assert.equal(text, "Batch besar sekali kirim")
            assert(options.batchId.includes("fixed-time-message"))
            await batchGate
            return { success: true, created: targets.length, duplicate: false }
        },
    }
    const batchContext = text => ({
        from: OWNER_CHAT,
        text,
        isGroup: false,
        isOwner: true,
        reminder: batchReminder,
    })

    await flow.handleReminderContactFlow(concurrentSock, message(".remind"), batchContext(".remind"))
    await flow.handleReminderContactFlow(concurrentSock, message("", contactMessage), batchContext(""))
    await flow.handleReminderContactFlow(concurrentSock, message("lanjut"), batchContext("lanjut"))
    await flow.handleReminderContactFlow(
        concurrentSock,
        message("Batch besar sekali kirim"),
        batchContext("Batch besar sekali kirim")
    )

    const fixedTimeMessage = message("20:15", null, "fixed-time-message")
    const firstSave = flow.handleReminderContactFlow(concurrentSock, fixedTimeMessage, batchContext("20:15"))
    const duplicateSave = flow.handleReminderContactFlow(concurrentSock, fixedTimeMessage, batchContext("20:15"))
    assert.equal(batchCalls, 1, "duplicate time event must not start a second batch")
    releaseBatch()
    assert.equal(await firstSave, true)
    assert.equal(await duplicateSave, true)
    assert.equal(batchCalls, 1, "only one batch save after both handlers finish")
    assert.equal(flow.getSession(OWNER_CHAT), null, "session clears after locked batch completes")

    flow.disposeReminderContactFlow()
    console.log("REMINDER_CONTACT_FLOW_TESTS_OK")
}

run().catch(error => {
    console.error(error)
    process.exitCode = 1
}).finally(() => flow.disposeReminderContactFlow())
