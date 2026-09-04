"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-group-schedule-"))
process.env.GROUP_UTILITY_STATE_FILE = path.join(tempDir, "state.json")

const {
    GROUP_JID,
    assert,
    assertNoGroupEffects,
    makeContext,
    makeMsg,
    makeRemote,
    makeSock,
} = require("./group-utility-test-helpers")
const store = require("../modules/groupUtilityStore")
const schedule = require("../modules/groupScheduleManager")

function setDue(action = "open", time = "00:00") {
    store.updateGroup(GROUP_JID, group => ({
        ...group,
        preservedUnknownField: { keep: true },
        schedule: { enabled: true, open: null, close: null, lastRuns: {}, [action]: time },
    }))
}

async function runHardGateTests() {
    for (const scenario of [
        { label: "schedule bot non-admin", sock: makeSock({ botAdmin: false }), remote: makeRemote() },
        { label: "schedule metadata unavailable", sock: makeSock({ metadata: new Error("offline") }), remote: makeRemote() },
        { label: "schedule group off", sock: makeSock(), remote: makeRemote({ botEnabled: false }) },
        { label: "schedule feature off", sock: makeSock(), remote: makeRemote({ features: { groupSchedule: false } }) },
    ]) {
        const text = ".gcschedule open 06:00"
        await schedule.handleGroupScheduleCommand(scenario.sock, makeMsg(text), makeContext(text, { remote: scenario.remote, extra: { store } }))
        assertNoGroupEffects(scenario.sock, scenario.label)
    }
}

async function runPersistenceAndCommandTest() {
    const sock = makeSock()
    await schedule.handleGroupScheduleCommand(sock, makeMsg(".gcschedule open 06:00"), makeContext(".gcschedule open 06:00", { extra: { store } }))
    await schedule.handleGroupScheduleCommand(sock, makeMsg(".jadwalgroup close 22:00"), makeContext(".jadwalgroup close 22:00", { extra: { store } }))
    let state = store.getGroup(GROUP_JID)
    assert.strictEqual(state.schedule.open, "06:00")
    assert.strictEqual(state.schedule.close, "22:00")
    store.reloadState()
    state = store.getGroup(GROUP_JID)
    assert.strictEqual(state.schedule.open, "06:00", "jadwal buka harus persisten")
    assert.strictEqual(state.schedule.close, "22:00", "jadwal tutup harus persisten")

    await schedule.handleGroupScheduleCommand(sock, makeMsg(".gcschedule hapus open"), makeContext(".gcschedule hapus open", { extra: { store } }))
    assert.strictEqual(store.getGroup(GROUP_JID).schedule.open, null)
}

async function runDueAndSkipTests() {
    const midnightJakarta = new Date("2026-01-01T17:00:00.000Z")
    assert.deepStrictEqual(schedule.getJakartaParts(midnightJakarta), { date: "2026-01-02", time: "00:00" })

    setDue("open", "00:00")
    const sock = makeSock()
    let result = await schedule.runScheduleTick(sock, { store, groupRemoteControl: makeRemote() }, midnightJakarta)
    assert.strictEqual(result.executed, 1)
    assert.deepStrictEqual(sock.calls.settings, [{ jid: GROUP_JID, setting: "not_announcement" }])
    result = await schedule.runScheduleTick(sock, { store, groupRemoteControl: makeRemote() }, midnightJakarta)
    assert.strictEqual(result.executed, 0, "tick yang sama tidak boleh menjalankan aksi dua kali")
    assert.strictEqual(sock.calls.settings.length, 1)
    assert.strictEqual(store.getGroup(GROUP_JID).preservedUnknownField.keep, true, "field asing harus dipertahankan")

    setDue("close", "00:00")
    const nonAdminSock = makeSock({ botAdmin: false })
    result = await schedule.runScheduleTick(nonAdminSock, { store, groupRemoteControl: makeRemote() }, new Date("2026-01-02T17:00:00.000Z"))
    assert.strictEqual(result.skipped, 1)
    assertNoGroupEffects(nonAdminSock, "due current bot non-admin")

    setDue("open", "00:00")
    const offSock = makeSock()
    result = await schedule.runScheduleTick(offSock, { store, groupRemoteControl: makeRemote({ botEnabled: false }) }, new Date("2026-01-03T17:00:00.000Z"))
    assert.strictEqual(result.skipped, 1)
    assertNoGroupEffects(offSock, "due current Group Bot OFF")

    setDue("open", "00:00")
    const featureOffSock = makeSock()
    result = await schedule.runScheduleTick(featureOffSock, { store, groupRemoteControl: makeRemote({ features: { groupSchedule: false } }) }, new Date("2026-01-04T17:00:00.000Z"))
    assert.strictEqual(result.skipped, 1)
    assertNoGroupEffects(featureOffSock, "due current feature OFF")
}

async function runSingleTimerTest() {
    store.updateGroup(GROUP_JID, group => ({ ...group, schedule: { enabled: false, open: null, close: null, lastRuns: {} } }))
    const sock = makeSock()
    const first = schedule.installGroupScheduleManager(sock, { store, groupRemoteControl: makeRemote(), tickIntervalMs: 60_000 })
    const second = schedule.installGroupScheduleManager(sock, { store, groupRemoteControl: makeRemote(), tickIntervalMs: 60_000 })
    assert.strictEqual(first, true)
    assert.strictEqual(second, false, "hanya boleh ada satu global scheduler")
    assert.strictEqual(schedule.getSchedulerRuntimeStatus().installed, true)
    schedule.disposeGroupScheduleManager(sock)
    assert.strictEqual(schedule.getSchedulerRuntimeStatus().installed, false)
}

function runStoreSafetyTest() {
    store.saveState({ ...store.loadState(), unknownTopLevel: { keep: "yes" } })
    store.updateGroup(GROUP_JID, group => ({ ...group, anotherField: 42 }))
    assert.strictEqual(store.loadState().unknownTopLevel.keep, "yes", "unknown top-level field harus dipertahankan")

    fs.writeFileSync(process.env.GROUP_UTILITY_STATE_FILE, "{json-rusak", "utf8")
    store.resetCache()
    const recovered = store.loadState()
    assert.deepStrictEqual(recovered.groups, {}, "corrupt JSON harus fail-safe ke state kosong")
}

async function main() {
    try {
        await runHardGateTests()
        await runPersistenceAndCommandTest()
        await runDueAndSkipTests()
        await runSingleTimerTest()
        runStoreSafetyTest()
        console.log("PASS test-group-schedule")
    } finally {
        schedule.disposeGroupScheduleManager()
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
