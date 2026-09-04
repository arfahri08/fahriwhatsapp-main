"use strict"

const assert = require("assert")
const { PNG } = require("pngjs")
const mockup = require("../modules/safeMockup")

function run() {
    for (const kind of ["chat", "call", "story"]) {
        const buffer = mockup.renderMockup(kind, { name: "ALICE", text: kind === "call" ? "PANGGILAN MASUK" : "HALO DUNIA" })
        assert.ok(Buffer.isBuffer(buffer) && buffer.length > 1000, `${kind} image harus dihasilkan`)
        const png = PNG.sync.read(buffer)
        assert.strictEqual(png.width, mockup.WIDTH)
        const bottom = (png.width * (png.height - 20) + 20) << 2
        assert.ok(png.data[bottom] > png.data[bottom + 1], "watermark band harus terlihat permanen")
    }
    assert.strictEqual(mockup.WATERMARK, "SIMULASI / FAKE")
    assert.throws(() => mockup.renderMockup("chat", { name: "A".repeat(mockup.MAX_NAME + 1), text: "x" }), /maksimal/)
    assert.throws(() => mockup.renderMockup("chat", { name: "A", text: "x".repeat(mockup.MAX_TEXT + 1) }), /maksimal/)
    assert.strictEqual(mockup.parseCommand(".faketransfer Bank | Rp1.000.000"), null, "fake payment tidak boleh tersedia")
    assert.strictEqual(mockup.parseCommand(".fakektp Nama"), null, "fake identity tidak boleh tersedia")
    const parsed = mockup.parseCommand(".fakechat Nama | Pesan")
    assert.deepStrictEqual(parsed, { kind: "chat", name: "Nama", text: "Pesan" })
    console.log("PASS test-safe-mockup")
}

run()
