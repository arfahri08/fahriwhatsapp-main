"use strict"

const assert = require("assert")
const Module = require("module")
const originalLoad = Module._load

Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "axios") return { post: async () => { throw new Error("network disabled in unit test") } }
    if (request === "form-data") {
        return class FormDataStub {
            append() {}
            getHeaders() { return { "content-type": "multipart/form-data; boundary=test" } }
        }
    }
    if (request === "@whiskeysockets/baileys") {
        return {
            downloadMediaMessage: async () => Buffer.from("test"),
            downloadContentFromMessage: async function* () { yield Buffer.from("test") },
            generateWAMessageFromContent: () => ({ key: { id: "TEST" }, message: {} }),
            proto: { Message: { InteractiveMessage: {} } },
        }
    }
    if (request === "./messageCleaner") {
        return {
            sendTemporary: async () => null,
            deleteMessageObject: async () => true,
        }
    }
    return originalLoad.call(this, request, parent, isMain)
}

const imageToUrl = require("../modules/imageToUrl")
Module._load = originalLoad

assert.strictEqual(
    imageToUrl.normalizeHttpUrl("https://cdn.example.com/file.jpg"),
    "https://cdn.example.com/file.jpg"
)
assert.strictEqual(imageToUrl.normalizeHttpUrl("not-a-url"), "")

assert.strictEqual(
    imageToUrl.extractFirstHttpUrl({ data: { url: "https://cdn.hostify.example/a.jpg" } }),
    "https://cdn.hostify.example/a.jpg"
)
assert.strictEqual(
    imageToUrl.extractFirstHttpUrl({ success: true, files: [{ url: "https://uguu.se/abc.png" }] }),
    "https://uguu.se/abc.png"
)
assert.strictEqual(
    imageToUrl.extractFirstHttpUrl("uploaded: https://files.example.net/demo.webp"),
    "https://files.example.net/demo.webp"
)
assert.deepStrictEqual(imageToUrl.getProviderOrder(), ["hostify", "uguu"])

console.log("PASS test-image-to-url")
