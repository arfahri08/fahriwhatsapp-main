"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-group-moderation-"))
process.env.GROUP_UTILITY_STATE_FILE = path.join(tempDir, "state.json")

const {
    ADMIN_JID,
    GROUP_JID,
    USER_LID,
    USER_PN,
    USER_TWO,
    assert,
    assertNoGroupEffects,
    makeContext,
    makeMsg,
    makeRemote,
    makeSock,
} = require("./group-utility-test-helpers")
const store = require("../modules/groupUtilityStore")
const moderation = require("../modules/groupModerationTools")
const flood = require("../modules/groupFloodGuard")

async function runModerationHardGates() {
    for (const scenario of [
        { label: "moderation bot non-admin", sock: makeSock({ botAdmin: false }), remote: makeRemote() },
        { label: "moderation metadata unavailable", sock: makeSock({ metadata: new Error("offline") }), remote: makeRemote() },
        { label: "moderation group off", sock: makeSock(), remote: makeRemote({ botEnabled: false }) },
        { label: "moderation feature off", sock: makeSock(), remote: makeRemote({ features: { groupModeration: false } }) },
    ]) {
        const text = ".warn test"
        const msg = makeMsg(text, { quoted: { id: `warn-${scenario.label}`, participant: USER_LID, participantAlt: USER_PN } })
        await moderation.handleGroupModerationCommand(scenario.sock, msg, makeContext(text, { remote: scenario.remote, extra: { store } }))
        assertNoGroupEffects(scenario.sock, scenario.label)
    }
}

async function runWarningLifecycle() {
    const sock = makeSock()
    const warn = async (id, participant, participantAlt, reason = "pelanggaran") => {
        const text = `.warn ${reason}`
        const msg = makeMsg(text, { id, quoted: { id: `quoted-${id}`, participant, participantAlt } })
        await moderation.handleGroupModerationCommand(sock, msg, makeContext(text, { extra: { store } }))
        return msg
    }

    await warn("warn-lid", USER_LID, USER_PN, "pertama")
    await warn("warn-pn", USER_PN, USER_LID, "kedua")
    let state = store.getGroup(GROUP_JID)
    const warningKeys = Object.keys(state.moderation.warnings)
    assert.strictEqual(warningKeys.length, 1, "LID/PN target harus berbagi history warning")
    assert.strictEqual(state.moderation.warnings[warningKeys[0]].length, 2)

    store.reloadState()
    state = store.getGroup(GROUP_JID)
    assert.strictEqual(state.moderation.warnings[warningKeys[0]].length, 2, "warning harus bertahan setelah reload")

    const beforeAdminWarn = JSON.stringify(state.moderation.warnings)
    await warn("warn-admin", ADMIN_JID, ADMIN_JID, "tidak boleh")
    assert.strictEqual(JSON.stringify(store.getGroup(GROUP_JID).moderation.warnings), beforeAdminWarn, "admin tidak boleh diberi warning")

    await warn("warn-third", USER_LID, USER_PN, "ketiga")
    assert.strictEqual(sock.calls.participants.length, 0, "default autoKickOnMaxWarn=false tidak boleh kick")

    await moderation.handleGroupModerationCommand(sock, makeMsg(".warnmax 1"), makeContext(".warnmax 1", { extra: { store } }))
    await moderation.handleGroupModerationCommand(sock, makeMsg(".warnautokick on"), makeContext(".warnautokick on", { extra: { store } }))
    const kickText = ".warn flood"
    const duplicateMsg = makeMsg(kickText, {
        id: "warn-kick-once",
        quoted: { id: "quoted-user-two", participant: USER_TWO, participantAlt: USER_TWO },
    })
    const context = makeContext(kickText, { extra: { store } })
    await moderation.handleGroupModerationCommand(sock, duplicateMsg, context)
    await moderation.handleGroupModerationCommand(sock, duplicateMsg, context)
    assert.strictEqual(sock.calls.participants.length, 1, "auto-kick explicit hanya satu kali untuk duplicate event")
    assert.strictEqual(sock.calls.participants[0].action, "remove")
}

async function runFloodHardGates() {
    const commandCases = [
        { text: ".slowmode on 30", feature: "slowmode" },
        { text: ".antispam on", feature: "antiSpam" },
    ]
    for (const item of commandCases) {
        for (const scenario of [
            { suffix: "bot non-admin", sock: makeSock({ botAdmin: false }), remote: makeRemote() },
            { suffix: "metadata unavailable", sock: makeSock({ metadata: new Error("offline") }), remote: makeRemote() },
            { suffix: "group off", sock: makeSock(), remote: makeRemote({ botEnabled: false }) },
            { suffix: "feature off", sock: makeSock(), remote: makeRemote({ features: { [item.feature]: false } }) },
        ]) {
            await flood.handleGroupFloodCommand(scenario.sock, makeMsg(item.text), makeContext(item.text, { remote: scenario.remote, extra: { store } }))
            assertNoGroupEffects(scenario.sock, `${item.feature} ${scenario.suffix}`)
        }
    }
}

async function runSlowmodeTests() {
    flood.resetRuntimeTrackers()
    store.updateGroup(GROUP_JID, group => ({ ...group, slowmode: { enabled: true, mode: "ALL", seconds: 30 } }))
    const sock = makeSock()
    const memberContext = makeContext("pesan biasa", { senderJid: USER_PN, extra: { store, slowmodeWarnings: true } })
    const first = makeMsg("pesan biasa", { id: "slow-first", participant: USER_LID, participantAlt: USER_PN })
    const second = makeMsg("pesan kedua", { id: "slow-second", participant: USER_PN, participantAlt: USER_LID })
    let result = await flood.evaluateSlowmode(sock, first, memberContext, 1_800_000_000_000)
    assert.strictEqual(result.blocked, false, "pesan pertama harus lolos")
    result = await flood.evaluateSlowmode(sock, second, { ...memberContext, text: "pesan kedua" }, 1_800_000_001_000)
    assert.strictEqual(result.blocked, true, "pesan kedua dalam cooldown harus diblokir")
    assert.strictEqual(sock.calls.send.filter(call => call.content.delete).length, 1, "slowmode ALL harus delete pesan kedua")

    const adminMsg = makeMsg("admin bebas", { id: "slow-admin", participant: ADMIN_JID })
    result = await flood.evaluateSlowmode(sock, adminMsg, makeContext("admin bebas", { senderJid: ADMIN_JID, extra: { store } }), 1_800_000_001_100)
    assert.strictEqual(result.blocked, false, "admin harus exempt slowmode")
    const ownerMsg = makeMsg("owner bebas", { id: "slow-owner", participant: USER_LID, participantAlt: USER_PN })
    result = await flood.evaluateSlowmode(sock, ownerMsg, makeContext("owner bebas", { senderJid: USER_PN, isOwner: true, extra: { store } }), 1_800_000_001_200)
    assert.strictEqual(result.blocked, false, "owner bot harus exempt slowmode")

    flood.resetRuntimeTrackers()
    store.updateGroup(GROUP_JID, group => ({ ...group, slowmode: { enabled: true, mode: "ONLYCOMMAND", seconds: 30 } }))
    result = await flood.evaluateSlowmode(sock, first, memberContext, 1_800_000_100_000)
    assert.strictEqual(result.blocked, false, "ONLYCOMMAND harus membolehkan chat normal")
    const commandOne = makeMsg(".absen", { id: "only-command-1", participant: USER_LID, participantAlt: USER_PN })
    const commandTwo = makeMsg(".absen", { id: "only-command-2", participant: USER_PN, participantAlt: USER_LID })
    result = await flood.evaluateSlowmode(sock, commandOne, { ...memberContext, text: ".absen" }, 1_800_000_101_000)
    assert.strictEqual(result.blocked, false)
    result = await flood.evaluateSlowmode(sock, commandTwo, { ...memberContext, text: ".absen" }, 1_800_000_102_000)
    assert.strictEqual(result.blocked, true, "command cepat kedua tidak boleh dieksekusi")

    const cleanup = flood.cleanupRuntimeTrackers(1_800_000_102_000 + 31 * 60 * 1000)
    assert.strictEqual(cleanup.slowmode, 0, "tracker slowmode harus dibersihkan berdasarkan TTL")
}

async function emitFlood(sock, action, ids, options = {}) {
    flood.resetRuntimeTrackers()
    store.updateGroup(GROUP_JID, group => ({
        ...group,
        antiSpam: { enabled: true, delayMs: 2000, threshold: 3, action },
    }))
    const context = makeContext("flood", { senderJid: USER_PN, remote: options.remote || makeRemote(), extra: { store } })
    const outputs = []
    for (let index = 0; index < ids.length; index += 1) {
        const msg = makeMsg(`flood ${index}`, { id: ids[index], participant: USER_LID, participantAlt: USER_PN })
        outputs.push(await flood.evaluateAntiSpam(sock, msg, { ...context, text: `flood ${index}` }, 1_900_000_000_000 + index * 500))
    }
    return outputs
}

async function runAntiSpamTests() {
    let sock = makeSock()
    let results = await emitFlood(sock, "warn", ["warn-1", "warn-2", "warn-3"])
    assert.strictEqual(results[0].blocked, false, "traffic normal sebelum threshold harus lolos")
    assert.strictEqual(results[2].action, "warn")
    assert.strictEqual(sock.calls.send.length, 1, "warning flood memakai cooldown")

    const adminSock = makeSock()
    store.updateGroup(GROUP_JID, group => ({ ...group, antiSpam: { enabled: true, delayMs: 2000, threshold: 3, action: "delete" } }))
    for (let index = 0; index < 4; index += 1) {
        const msg = makeMsg("admin flood", { id: `admin-flood-${index}`, participant: ADMIN_JID })
        const result = await flood.evaluateAntiSpam(adminSock, msg, makeContext("admin flood", { senderJid: ADMIN_JID, extra: { store } }), 1_910_000_000_000 + index * 100)
        assert.strictEqual(result.blocked, false)
    }
    assertNoGroupEffects(adminSock, "admin anti-spam exempt")

    const ownerSock = makeSock()
    for (let index = 0; index < 4; index += 1) {
        const msg = makeMsg("owner flood", { id: `owner-flood-${index}`, participant: USER_LID, participantAlt: USER_PN })
        const result = await flood.evaluateAntiSpam(ownerSock, msg, makeContext("owner flood", { senderJid: USER_PN, isOwner: true, extra: { store } }), 1_915_000_000_000 + index * 100)
        assert.strictEqual(result.blocked, false)
    }
    assertNoGroupEffects(ownerSock, "owner anti-spam exempt")

    sock = makeSock()
    results = await emitFlood(sock, "delete", ["delete-1", "delete-2", "delete-3", "delete-4"])
    assert.strictEqual(results[2].action, "delete")
    assert.strictEqual(sock.calls.send.filter(call => call.content.delete).length, 1, "aksi delete hanya sekali per threshold")

    sock = makeSock()
    results = await emitFlood(sock, "kick", ["kick-1", "kick-2", "kick-3"])
    assert.strictEqual(results[2].action, "kick")
    assert.strictEqual(sock.calls.participants.length, 1, "kick hanya berjalan ketika action explicit KICK")

    flood.resetRuntimeTrackers()
    store.updateGroup(GROUP_JID, group => ({ ...group, antiSpam: { enabled: true, delayMs: 2000, threshold: 3, action: "kick" } }))
    const deniedSock = makeSock({ botAdmin: false })
    for (let index = 0; index < 3; index += 1) {
        const msg = makeMsg("denied flood", { id: `denied-${index}`, participant: USER_LID, participantAlt: USER_PN })
        await flood.evaluateAntiSpam(deniedSock, msg, makeContext("denied flood", { senderJid: USER_PN, extra: { store } }), 1_920_000_000_000 + index * 100)
    }
    assertNoGroupEffects(deniedSock, "anti-spam current bot non-admin")
}

async function main() {
    try {
        await runModerationHardGates()
        await runWarningLifecycle()
        await runFloodHardGates()
        await runSlowmodeTests()
        await runAntiSpamTests()
        console.log("PASS test-group-moderation-tools")
    } finally {
        flood.resetRuntimeTrackers()
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
