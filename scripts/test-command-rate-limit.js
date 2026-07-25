"use strict"

const assert = require("assert")
const limiter = require("../modules/commandRateLimiter")

const USER = "628111111111@s.whatsapp.net"
const USER_2 = "628222222222@s.whatsapp.net"
const PRIVATE = USER
const GROUP = "120363000000000001@g.us"

function config(overrides = {}) {
    return {
        version: 1,
        global: {
            enabled: true,
            ownerBypass: true,
            maxCommandsPerMinute: 5,
            chatMaxCommandsPerMinute: 30,
            warningCooldownMs: 30000,
            cooldowns: {
                command: 5000,
                downloader: 30000,
                media: 20000,
                ocr: 45000,
            },
            ...(overrides.global || {}),
        },
        groups: overrides.groups || {},
    }
}

function decide(input = {}) {
    return limiter.checkRateLimit({
        limited: true,
        actorJid: USER,
        chatJid: GROUP,
        category: "command",
        command: ".menu",
        now: 100000,
        configOverride: config(),
        ...input,
    })
}

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test("command biasa diklasifikasikan", () => {
    assert.deepStrictEqual(limiter.classifyRequest({ text: ".menu", isGroup: true }), {
        limited: true,
        category: "command",
        command: ".menu",
    })
})

test("downloader command mendapat kategori downloader", () => {
    assert.strictEqual(limiter.classifyRequest({ text: ".spdl https://open.spotify.com/x", isGroup: true }).category, "downloader")
})

test("media tool mendapat kategori media", () => {
    assert.strictEqual(limiter.classifyRequest({ text: ".stiker", isGroup: true }).category, "media")
})

test("OCR command mendapat kategori OCR", () => {
    assert.strictEqual(limiter.classifyRequest({ text: ".kasarocr test", isGroup: false }).category, "ocr")
})

test("link otomatis hanya dibatasi di private", () => {
    assert.strictEqual(limiter.classifyRequest({ text: "https://youtu.be/test", isGroup: false }).category, "downloader")
    assert.strictEqual(limiter.classifyRequest({ text: "https://youtu.be/test", isGroup: true }).limited, false)
})

test("pesan biasa tidak dibatasi", () => {
    assert.strictEqual(limiter.classifyRequest({ text: "halo semuanya", isGroup: true }).limited, false)
})

test("pemakaian pertama diizinkan", () => {
    limiter.resetRuntimeState()
    assert.strictEqual(decide().allowed, true)
})

test("command kedua dalam cooldown diblokir", () => {
    limiter.resetRuntimeState()
    assert.strictEqual(decide({ now: 100000 }).allowed, true)
    const second = decide({ now: 102000 })
    assert.strictEqual(second.allowed, false)
    assert.strictEqual(second.reason, "category-cooldown")
    assert.strictEqual(second.retryAfterMs, 3000)
})

test("command sesudah cooldown diizinkan", () => {
    limiter.resetRuntimeState()
    assert.strictEqual(decide({ now: 100000 }).allowed, true)
    assert.strictEqual(decide({ now: 105001 }).allowed, true)
})

test("downloader memakai cooldown 30 detik", () => {
    limiter.resetRuntimeState()
    const base = { category: "downloader", command: ".spdl" }
    assert.strictEqual(decide({ ...base, now: 100000 }).allowed, true)
    const blocked = decide({ ...base, now: 110000 })
    assert.strictEqual(blocked.allowed, false)
    assert.strictEqual(blocked.retryAfterMs, 20000)
})

test("media memakai cooldown 20 detik", () => {
    limiter.resetRuntimeState()
    const base = { category: "media", command: ".stiker" }
    assert.strictEqual(decide({ ...base, now: 100000 }).allowed, true)
    assert.strictEqual(decide({ ...base, now: 119999 }).allowed, false)
    assert.strictEqual(decide({ ...base, now: 120001 }).allowed, true)
})

test("OCR memakai cooldown 45 detik", () => {
    limiter.resetRuntimeState()
    const base = { category: "ocr", command: ".kasarocr" }
    assert.strictEqual(decide({ ...base, now: 100000 }).allowed, true)
    assert.strictEqual(decide({ ...base, now: 144999 }).allowed, false)
    assert.strictEqual(decide({ ...base, now: 145001 }).allowed, true)
})

test("owner bypass tidak dibatasi", () => {
    limiter.resetRuntimeState()
    assert.strictEqual(decide({ isOwner: true, now: 100000 }).reason, "owner-bypass")
    assert.strictEqual(decide({ isOwner: true, now: 100001 }).allowed, true)
})

test("group override OFF melewati limiter", () => {
    limiter.resetRuntimeState()
    const disabled = config({ groups: { [GROUP]: { enabled: false } } })
    const result = decide({ configOverride: disabled })
    assert.strictEqual(result.allowed, true)
    assert.strictEqual(result.reason, "disabled")
})

test("maksimal per user per menit berlaku", () => {
    limiter.resetRuntimeState()
    const cfg = config({ global: { cooldowns: { command: 0, downloader: 0, media: 0, ocr: 0 }, maxCommandsPerMinute: 3 } })
    for (let i = 0; i < 3; i += 1) {
        assert.strictEqual(decide({ now: 100000 + i, configOverride: cfg, command: `.c${i}` }).allowed, true)
    }
    const blocked = decide({ now: 100010, configOverride: cfg, command: ".c4" })
    assert.strictEqual(blocked.allowed, false)
    assert.strictEqual(blocked.reason, "user-minute-limit")
})

test("maksimal per chat berlaku lintas user", () => {
    limiter.resetRuntimeState()
    const cfg = config({ global: { cooldowns: { command: 0, downloader: 0, media: 0, ocr: 0 }, maxCommandsPerMinute: 10, chatMaxCommandsPerMinute: 2 } })
    assert.strictEqual(decide({ now: 100000, configOverride: cfg }).allowed, true)
    assert.strictEqual(decide({ now: 100001, configOverride: cfg, actorJid: USER_2 }).allowed, true)
    const blocked = decide({ now: 100002, configOverride: cfg, actorJid: "628333333333@s.whatsapp.net" })
    assert.strictEqual(blocked.allowed, false)
    assert.strictEqual(blocked.reason, "chat-minute-limit")
})

test("warning pertama tampil dan spam berikutnya silent", () => {
    limiter.resetRuntimeState()
    assert.strictEqual(decide({ now: 100000 }).allowed, true)
    const firstBlocked = decide({ now: 101000 })
    const secondBlocked = decide({ now: 102000 })
    assert.strictEqual(firstBlocked.notify, true)
    assert.strictEqual(secondBlocked.notify, false)
})

test("warning dapat muncul lagi setelah cooldown warning", () => {
    limiter.resetRuntimeState()
    const cfg = config({ global: { warningCooldownMs: 3000, cooldowns: { command: 10000, downloader: 30000, media: 20000, ocr: 45000 } } })
    assert.strictEqual(decide({ now: 100000, configOverride: cfg }).allowed, true)
    assert.strictEqual(decide({ now: 101000, configOverride: cfg }).notify, true)
    assert.strictEqual(decide({ now: 104100, configOverride: cfg }).notify, true)
})

test("runtime health mencatat allowed dan blocked", () => {
    limiter.resetRuntimeState()
    decide({ now: 100000 })
    decide({ now: 100001 })
    const health = limiter.getRateLimitHealth()
    assert.ok(health.allowed >= 1)
    assert.ok(health.blocked >= 1)
})

test("parse duration aman", () => {
    assert.strictEqual(limiter.parseDuration("5s"), 5000)
    assert.strictEqual(limiter.parseDuration("1m"), 60000)
    assert.strictEqual(limiter.parseDuration("500ms"), 500)
    assert.strictEqual(limiter.parseDuration("abc"), null)
})

async function main() {
    let passed = 0
    for (const item of tests) {
        await item.fn()
        passed += 1
        console.log(`PASS ${item.name}`)
    }
    console.log(`\n${passed}/${tests.length} command rate-limit tests passed.`)
}

main().catch(error => {
    console.error("FAIL", error.stack || error.message)
    process.exitCode = 1
})
