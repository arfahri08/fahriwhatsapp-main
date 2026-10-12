"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "saved-contact-name-priority-"))
process.env.CONTACT_NAME_STORE_FILE = path.join(tempRoot, "contactNames.json")

const contactNameStore = require("../modules/contactNameStore")
const autoReplyForwarder = require("../modules/autoReplyForwarder")
const privateHelloMenu = require("../modules/privateHelloMenu")

const PN = "628111111111@s.whatsapp.net"
const LID = "123456789012345@lid"
const UNKNOWN = "628222222222@s.whatsapp.net"

function privateMessage(jid, pushName) {
    return {
        key: {
            remoteJid: jid,
            remoteJidAlt: jid === LID ? PN : undefined,
            id: "NAME-TEST",
            fromMe: false,
        },
        pushName,
        message: { conversation: "halo" },
    }
}

try {
    contactNameStore.rememberContacts([{
        id: PN,
        lid: LID,
        name: "6211 I Linda",
        notify: "Nama Profil Yang Salah",
    }], { source: "test-phone-address-book" })

    assert.strictEqual(contactNameStore.resolveSavedContactName(PN), "6211 I Linda")
    assert.strictEqual(contactNameStore.resolveSavedContactFirstName(PN), "I")
    assert.strictEqual(contactNameStore.resolveSavedContactFirstName(LID), "I")

    const knownMessage = privateMessage(LID, "Nama Profil WhatsApp Bukan Kontak")
    const knownOptions = {
        senderJid: LID,
        contactJids: [PN, LID],
        contactNameStore,
    }
    assert.strictEqual(autoReplyForwarder.resolvePersonalName(knownMessage, knownOptions), "I")
    assert.strictEqual(autoReplyForwarder.getFirstName(knownMessage, knownOptions), "I")
    assert.strictEqual(
        autoReplyForwarder.renderPersonalText("Halo, {name}!", knownMessage, knownOptions),
        "Halo, I!"
    )
    assert.doesNotMatch(
        autoReplyForwarder.renderPersonalText("Halo, {name}!", knownMessage, knownOptions),
        /Nama Profil WhatsApp/
    )

    const unknownMessage = privateMessage(UNKNOWN, "Nama Profil Tidak Boleh Dipakai")
    const unknownOptions = { senderJid: UNKNOWN, contactNameStore }
    assert.strictEqual(autoReplyForwarder.resolvePersonalName(unknownMessage, unknownOptions), "")
    assert.strictEqual(autoReplyForwarder.getFirstName(unknownMessage, unknownOptions), "Kak")
    assert.strictEqual(
        autoReplyForwarder.renderPersonalText("Halo, {name}!", unknownMessage, unknownOptions),
        "Halo, *Kak*!"
    )

    const pushOnlyStore = {
        resolveContactName: () => "Nama WA",
        resolveSavedContactName: () => "",
        resolveSavedContactFirstName: () => "",
    }
    assert.strictEqual(autoReplyForwarder.getFirstName(unknownMessage, {
        senderJid: UNKNOWN,
        contactNameStore: pushOnlyStore,
    }), "Kak", "resolveContactName/pushName tidak boleh menjadi fallback")

    assert.match(privateHelloMenu.buildIntroText("I"), /Halo, \*I\*!/)

    const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")
    const privateAgentSource = fs.readFileSync(path.join(__dirname, "..", "modules", "privateAgent.js"), "utf8")
    assert(indexSource.includes("displayName: savedContactFirstName"))
    assert(indexSource.includes("contactJids: senderContactJids"))
    assert(indexSource.includes("contactNameStore,"))
    assert(!indexSource.includes("displayName: msg?.pushName"))
    assert(privateAgentSource.includes("const contactFirstName = mentionReplyName(jid)"))
    assert(!privateAgentSource.includes("extractSavedContactFirstName?.(contact?.name)"))

    console.log("PASS test-saved-contact-name-priority")
} finally {
    contactNameStore.disposeContactNameStore()
    fs.rmSync(tempRoot, { recursive: true, force: true })
}
