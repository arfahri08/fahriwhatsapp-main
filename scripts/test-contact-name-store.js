"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contact-name-store-test-"))
process.env.CONTACT_NAME_STORE_FILE = path.join(tempRoot, "contactNames.json")

const store = require("../modules/contactNameStore")

try {
    let result = store.rememberContacts([
        {
            id: "628111111111@s.whatsapp.net",
            lid: "123456789012345@lid",
            name: "Mama Rumah",
            notify: "Nama WA",
        },
    ], { source: "test-sync" })
    assert.equal(result.saved, 1)
    assert.equal(store.resolveContactName("628111111111@s.whatsapp.net"), "Mama Rumah")
    assert.equal(store.resolveContactName("123456789012345@lid"), "Mama Rumah")

    result = store.rememberIncomingMessage({
        key: { participant: "628111111111@s.whatsapp.net" },
        pushName: "Push Name Baru",
    }, { senderJid: "628111111111@s.whatsapp.net" })
    assert.equal(store.resolveContactName("628111111111@s.whatsapp.net"), "Mama Rumah", "saved contact name must win over push name")

    const fallback = store.resolveContactName("628222222222@s.whatsapp.net", ["Nama Fallback"])
    assert.equal(fallback, "Nama Fallback")

    assert(fs.existsSync(process.env.CONTACT_NAME_STORE_FILE), "contact cache should persist")
    console.log("CONTACT_NAME_STORE_TESTS_OK")
} finally {
    store.disposeContactNameStore()
    fs.rmSync(tempRoot, { recursive: true, force: true })
}
