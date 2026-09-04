"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-group-attendance-"))
process.env.GROUP_UTILITY_STATE_FILE = path.join(tempDir, "state.json")

const {
    GROUP_JID,
    USER_LID,
    USER_PN,
    assert,
    assertNoGroupEffects,
    makeContext,
    makeMsg,
    makeRemote,
    makeSock,
} = require("./group-utility-test-helpers")
const store = require("../modules/groupUtilityStore")
const attendance = require("../modules/groupAttendance")

async function runHardGateTests() {
    for (const scenario of [
        { label: "attendance bot non-admin", sock: makeSock({ botAdmin: false }), remote: makeRemote() },
        { label: "attendance metadata unavailable", sock: makeSock({ metadata: new Error("offline") }), remote: makeRemote() },
        { label: "attendance group off", sock: makeSock(), remote: makeRemote({ botEnabled: false }) },
        { label: "attendance feature off", sock: makeSock(), remote: makeRemote({ features: { groupAttendance: false } }) },
    ]) {
        const text = ".mulaiabsen Test"
        await attendance.handleGroupAttendanceCommand(scenario.sock, makeMsg(text), makeContext(text, { remote: scenario.remote, extra: { store } }))
        assertNoGroupEffects(scenario.sock, scenario.label)
    }
}

async function runAttendanceLifecycle() {
    const sock = makeSock()
    const startText = ".mulaiabsen Shift Pagi"
    await attendance.handleGroupAttendanceCommand(sock, makeMsg(startText, { id: "attendance-start" }), makeContext(startText, { extra: { store } }))
    let group = store.getGroup(GROUP_JID)
    assert.strictEqual(group.attendance.active.title, "Shift Pagi")
    assert.strictEqual(Object.keys(group.attendance.active.participants).length, 0)
    await attendance.handleGroupAttendanceCommand(sock, makeMsg(".mulaiabsen Sesi Kedua"), makeContext(".mulaiabsen Sesi Kedua", { extra: { store } }))
    assert.strictEqual(store.getGroup(GROUP_JID).attendance.active.title, "Shift Pagi", "hanya boleh ada satu sesi aktif")

    const userContext = makeContext(".absen", { senderJid: USER_PN, extra: { store } })
    await attendance.handleGroupAttendanceCommand(sock, makeMsg(".absen", {
        id: "attendance-user-lid",
        participant: USER_LID,
        participantAlt: USER_PN,
        pushName: "User Satu",
    }), userContext)
    await attendance.handleGroupAttendanceCommand(sock, makeMsg(".absen", {
        id: "attendance-user-pn",
        participant: USER_PN,
        participantAlt: USER_LID,
        pushName: "User Sama",
    }), userContext)
    group = store.getGroup(GROUP_JID)
    assert.strictEqual(Object.keys(group.attendance.active.participants).length, 1, "LID dan PN harus menjadi satu peserta")

    store.reloadState()
    group = store.getGroup(GROUP_JID)
    assert.strictEqual(group.attendance.active.title, "Shift Pagi", "sesi aktif harus bertahan setelah reload")
    assert.strictEqual(Object.keys(group.attendance.active.participants).length, 1)

    await attendance.handleGroupAttendanceCommand(sock, makeMsg(".cekabsen"), makeContext(".cekabsen", { senderJid: USER_PN, extra: { store } }))
    const list = sock.calls.send.find(call => String(call.content.text || "").includes("ABSENSI: Shift Pagi"))
    assert(list, "cekabsen harus mengirim daftar aktif")

    await attendance.handleGroupAttendanceCommand(sock, makeMsg(".hapusabsen"), makeContext(".hapusabsen", { extra: { store } }))
    group = store.getGroup(GROUP_JID)
    assert.strictEqual(group.attendance.active, null)
    assert.strictEqual(group.attendance.archives.length, 1, "sesi ditutup harus diarsipkan secara bounded")
    assert.strictEqual(Object.keys(group.attendance.archives[0].participants).length, 1)
}

async function main() {
    try {
        await runHardGateTests()
        await runAttendanceLifecycle()
        console.log("PASS test-group-attendance")
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
