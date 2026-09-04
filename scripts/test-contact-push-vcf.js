"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-contact-test-"))
process.env.CONTACT_PUSH_STATE_FILE = path.join(temp, "push.json")
process.env.CONTACT_PUSH_MEDIA_DIR = path.join(temp, "media")
const push = require("../modules/contactPushManager")
const vcf = require("../modules/contactServices")

function card(number, name = "Test") {
    return { displayName: name, vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;waid=${number}:${number}\nEND:VCARD` }
}

async function run() {
    const direct = await push.parseContactInput({}, { message: { contactMessage: card("628111111111") } }, {})
    assert.strictEqual(direct.targets.length, 1, "contactMessage harus diparse")
    const multiple = await push.parseContactInput({}, { message: { contactsArrayMessage: { contacts: [card("628111111111"), card("628222222222")] } } }, {})
    assert.strictEqual(multiple.targets.length, 2, "contactsArrayMessage harus diparse")
    const parsedVcf = push.parseVcfText(`${card("628333333333").vcard}\n${card("628444444444").vcard}`)
    assert.strictEqual(parsedVcf.targets.length, 2, "VCF multi-card harus diparse")

    const aliases = { resolveBestJid(jid) { return jid === "123@lid" ? "628555555555@s.whatsapp.net" : jid } }
    const deduped = push.dedupeTargets([
        { jid: "123@lid" }, { jid: "628555555555@s.whatsapp.net" }, { jid: "invalid" }, { jid: "628666666666@s.whatsapp.net" },
    ], { lidAliasStore: aliases })
    assert.strictEqual(deduped.targets.length, 2, "PN/LID harus menjadi satu canonical target")
    assert.strictEqual(deduped.duplicate, 1)
    assert.strictEqual(deduped.invalid, 1)

    const sends = []
    const sock = { user: { id: "999999999999@s.whatsapp.net" }, async sendMessage(jid, content) { sends.push({ jid, content }); return { key: { id: `s-${sends.length}` } } } }
    const base = { from: "999999999999@s.whatsapp.net", senderJid: "999999999999@s.whatsapp.net", isGroup: false, isOwner: true, lidAliasStore: aliases }
    await push.handleContactPush(sock, { key: { id: "a" }, message: { conversation: ".pushkontak" } }, { ...base, text: ".pushkontak" })
    await push.handleContactPush(sock, { key: { id: "b" }, message: { contactMessage: card("628777777777") } }, { ...base, text: "" })
    await push.handleContactPush(sock, { key: { id: "c" }, message: { conversation: "lanjut" } }, { ...base, text: "lanjut" })
    await push.handleContactPush(sock, { key: { id: "d" }, message: { conversation: "pesan promo" } }, { ...base, text: "pesan promo" })
    assert.strictEqual(sends.filter(item => item.jid === "628777777777@s.whatsapp.net").length, 0, "final confirmation wajib")

    push.update(state => ({ ...state, job: { ...state.job, status: "READY" } }))
    await push.executeJob(sock, push.snapshot().job.id, { sleep: async () => {} })
    await push.executeJob(sock, push.snapshot().job.id, { sleep: async () => {} })
    assert.strictEqual(sends.filter(item => item.jid === "628777777777@s.whatsapp.net").length, 1, "duplicate execution tidak boleh double-send")

    const metadata = { participants: [{ id: "999999999999@s.whatsapp.net" }, { id: "123@lid", phoneNumber: "628555555555@s.whatsapp.net" }, { id: "628555555555@s.whatsapp.net", lid: "123@lid" }] }
    const generated = vcf.buildGroupVcf(metadata, sock, { lidAliasStore: aliases, contactNameStore: { resolveContactName: () => "Nama" } })
    assert.strictEqual(generated.contacts.length, 1, "export VCF harus skip bot dan dedupe PN/LID")
    assert.match(generated.text, /BEGIN:VCARD\r\nVERSION:3\.0/)

    push.update(state => ({ ...state, job: { id: "STOP", status: "READY", delaySeconds: 3, content: { type: "text", text: "x" }, targets: [{ key: "pn:1", jid: "628100000001@s.whatsapp.net", status: "PENDING" }, { key: "pn:2", jid: "628100000002@s.whatsapp.net", status: "PENDING" }] } }))
    const stopSock = { async sendMessage() { push.update(state => ({ ...state, job: { ...state.job, stopRequested: true } })); return {} } }
    await push.executeJob(stopSock, "STOP", { sleep: async () => {} })
    assert.strictEqual(push.progress(push.snapshot().job).sent, 1)
    assert.strictEqual(push.progress(push.snapshot().job).pending, 1, "stop queue menyisakan target pending")

    console.log("PASS test-contact-push-vcf")
}

run().finally(() => fs.rmSync(temp, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1 })
