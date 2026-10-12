"use strict"

const fs = require("fs")
const path = require("path")
const {
    ADMIN_JID,
    BOT_JID,
    GROUP_JID,
    USER_LID,
    USER_PN,
    assert,
    assertNoGroupEffects,
    makeContext,
    makeMetadata,
    makeMsg,
    makeRemote,
    makeSock,
} = require("./group-utility-test-helpers")
const utility = require("../modules/groupUtilityCommands")

async function runHardGateTests() {
    for (const scenario of [
        { label: "bot non-admin", sock: makeSock({ botAdmin: false }), remote: makeRemote() },
        { label: "metadata unavailable", sock: makeSock({ metadata: new Error("offline") }), remote: makeRemote() },
        { label: "Group Bot OFF", sock: makeSock(), remote: makeRemote({ botEnabled: false }) },
        { label: "feature utilities OFF", sock: makeSock(), remote: makeRemote({ features: { groupUtilities: false } }) },
    ]) {
        const msg = makeMsg(".gcopen", { id: `gate-${scenario.label}` })
        const handled = await utility.handleGroupUtilityCommand(scenario.sock, msg, makeContext(".gcopen", { remote: scenario.remote }))
        assert.strictEqual(handled, true, `${scenario.label}: command harus dikenali`)
        assertNoGroupEffects(scenario.sock, scenario.label)
    }
}

async function runOpenCloseTests() {
    const openSock = makeSock({ metadata: makeMetadata({ announce: true }) })
    await utility.handleGroupUtilityCommand(openSock, makeMsg(".gcopen"), makeContext(".gcopen"))
    assert.deepStrictEqual(openSock.calls.settings, [{ jid: GROUP_JID, setting: "not_announcement" }])

    const closeSock = makeSock({ metadata: makeMetadata({ announce: false }) })
    await utility.handleGroupUtilityCommand(closeSock, makeMsg(".close"), makeContext(".close"))
    assert.deepStrictEqual(closeSock.calls.settings, [{ jid: GROUP_JID, setting: "announcement" }])

    const nonAdminSock = makeSock()
    const nonAdminMsg = makeMsg(".open", { participant: USER_LID, participantAlt: USER_PN })
    await utility.handleGroupUtilityCommand(nonAdminSock, nonAdminMsg, makeContext(".open", { senderJid: USER_PN }))
    assert.strictEqual(nonAdminSock.calls.settings.length, 0, "member biasa tidak boleh membuka grup")
    assert.strictEqual(nonAdminSock.calls.send.length, 1, "member mendapat human permission error")
}

async function runProfileAndPinTests() {
    const sock = makeSock()
    await utility.handleGroupUtilityCommand(sock, makeMsg(".setnamegc Nama Baru"), makeContext(".setnamegc Nama Baru"))
    await utility.handleGroupUtilityCommand(sock, makeMsg(".setdeskgc Deskripsi Baru"), makeContext(".setdeskgc Deskripsi Baru"))
    await utility.handleGroupUtilityCommand(sock, makeMsg(".setdeskgc clear"), makeContext(".setdeskgc clear"))
    const ppMsg = makeMsg(".setppgc", { message: { imageMessage: { caption: ".setppgc", mimetype: "image/jpeg" } } })
    await utility.handleGroupUtilityCommand(sock, ppMsg, makeContext(".setppgc", { extra: { downloadMedia: async () => Buffer.from("picture") } }))
    assert.deepStrictEqual(sock.calls.subjects[0], { jid: GROUP_JID, subject: "Nama Baru" })
    assert.strictEqual(sock.calls.descriptions[0].description, "Deskripsi Baru")
    assert.strictEqual(sock.calls.descriptions[1].description, "")
    assert.strictEqual(sock.calls.pictures.length, 1)
    assert.strictEqual(sock.calls.pictures[0].buffer.toString(), "picture")

    const deniedSock = makeSock()
    const deniedMsg = makeMsg(".setnamegc Dilarang", { participant: USER_LID, participantAlt: USER_PN })
    await utility.handleGroupUtilityCommand(deniedSock, deniedMsg, makeContext(".setnamegc Dilarang", { senderJid: USER_PN }))
    assert.strictEqual(deniedSock.calls.subjects.length, 0, "profile tidak boleh dimutasi oleh member biasa")
    assert.strictEqual(deniedSock.calls.pictures.length, 0)

    const pinMsg = makeMsg(".pin 24", { quoted: { id: "quoted-pin", participant: USER_LID, participantAlt: USER_PN } })
    await utility.handleGroupUtilityCommand(sock, pinMsg, makeContext(".pin 24"))
    const pinCall = sock.calls.send.find(call => call.content.pin)
    assert(pinCall, "pin harus memakai sendMessage native Baileys")
    assert.strictEqual(pinCall.content.pin.id, "quoted-pin")
    assert.strictEqual(pinCall.content.type, 1)
    assert.strictEqual(pinCall.content.time, 24 * 3600)
}

async function runPollTests() {
    const sock = makeSock()
    await utility.handleGroupUtilityCommand(sock, makeMsg(".poll Pilih warna | Merah, Biru"), makeContext(".poll Pilih warna | Merah, Biru"))
    await utility.handleGroupUtilityCommand(sock, makeMsg(".poll multi | Pilih menu | Nasi, Mi, Soto"), makeContext(".poll multi | Pilih menu | Nasi, Mi, Soto"))
    const polls = sock.calls.send.filter(call => call.content.poll).map(call => call.content.poll)
    assert.strictEqual(polls.length, 2)
    assert.strictEqual(polls[0].selectableCount, 1)
    assert.strictEqual(polls[1].selectableCount, 3)
    assert.deepStrictEqual(polls[1].values, ["Nasi", "Mi", "Soto"])

    const before = polls.length
    await utility.handleGroupUtilityCommand(sock, makeMsg(".poll Salah | Sama, Sama"), makeContext(".poll Salah | Sama, Sama"))
    assert.strictEqual(sock.calls.send.filter(call => call.content.poll).length, before, "poll invalid tidak boleh dikirim")
}

async function runTagTests() {
    const memberSock = makeSock()
    const memberHandled = await utility.handleGroupUtilityCommand(
        memberSock,
        makeMsg(".tagall dilarang", { fromMe: false }),
        makeContext(".tagall dilarang")
    )
    assert.strictEqual(memberHandled, true, "command anggota dikenali lalu diabaikan")
    assert.strictEqual(memberSock.calls.send.length, 0, "anggota lain tidak boleh mendapat balasan")
    assert.strictEqual(memberSock.calls.metadata, 0, "command anggota tidak perlu mengambil metadata")

    const sock = makeSock({ botAdmin: false })
    const inlineMsg = makeMsg(".tagall halo", { fromMe: true, id: "tagall-inline" })
    await utility.handleGroupUtilityCommand(
        sock,
        inlineMsg,
        makeContext(".tagall halo", { remote: makeRemote({ botEnabled: false }) })
    )
    const tag = sock.calls.send.find(call => Array.isArray(call.content.mentions))
    assert(tag, "tagall harus tetap berjalan saat bot bukan admin dan Group Bot OFF")
    assert.strictEqual(tag.content.text, "@all\nhalo")
    assert.strictEqual(tag.options?.[utility.TAGALL_OUTPUT_BYPASS_OPTION], true, "output tagall harus melewati gate grup DEFAULT OFF")
    assert.strictEqual(tag.options?.quoted, undefined, "bubble tagall inline tidak boleh quoted")
    assert.strictEqual(tag.content.mentions.filter(jid => jid === USER_PN).length, 1, "LID+PN user yang sama hanya sekali")
    assert(!tag.content.mentions.includes(BOT_JID), "akun bot harus dihilangkan dari tagall")
    const inlineDelete = sock.calls.send.find(call => call.content.delete)
    assert(inlineDelete, "command inline harus dihapus setelah mention berhasil")
    assert.strictEqual(inlineDelete.content.delete.id, inlineMsg.key.id)
    assert.strictEqual(inlineDelete.options?.[utility.TAGALL_OUTPUT_BYPASS_OPTION], true, "delete command tagall juga harus melewati output gate")

    const editSock = makeSock({ botAdmin: false })
    const editMsg = makeMsg(".tagall", {
        fromMe: true,
        id: "tagall-edit",
        quoted: { id: "quoted-original", participant: USER_LID },
    })
    await utility.handleGroupUtilityCommand(
        editSock,
        editMsg,
        makeContext(".tagall", { remote: makeRemote({ botEnabled: false }) })
    )
    assert.strictEqual(editSock.calls.send.length, 1, "mode edit tidak boleh membuat bubble atau delete tambahan")
    const edited = editSock.calls.send[0]
    assert.deepStrictEqual(edited.content.edit, { ...editMsg.key, remoteJid: GROUP_JID })
    assert.strictEqual(edited.content.delete, undefined, "mode edit tidak boleh mengirim delete")
    assert(!edited.content.text.includes("@all"), "mode edit tidak boleh menampilkan @all")
    assert(edited.content.text.split("\n").every(line => /^@\d+$/.test(line)), "mode edit harus berisi mention satu per baris")
    assert.strictEqual(edited.options?.[utility.TAGALL_OUTPUT_BYPASS_OPTION], true, "edit tagall harus melewati output gate grup DEFAULT OFF")
    assert.strictEqual(editMsg.message.extendedTextMessage.contextInfo.stanzaId, "quoted-original", "edit mempertahankan bubble command yang memiliki hubungan reply")

    const failureSock = makeSock()
    failureSock.sendMessage = async () => { throw new Error("send mention gagal") }
    await utility.handleGroupUtilityCommand(
        failureSock,
        makeMsg(".tagall gagal", { fromMe: true, id: "tagall-failed" }),
        makeContext(".tagall gagal")
    )
    assert.strictEqual(failureSock.calls.send.some(call => call.content.delete), false, "command tidak boleh dihapus jika mention gagal")

    const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")
    const fastRouteAt = indexSource.indexOf("if (isGroup && isMe && groupUtilityCommands.isTagallCommand(text))")
    const groupGateAt = indexSource.indexOf("inboundGroupPolicy = await groupRuntimePolicy.resolveGroupRuntimePolicy", fastRouteAt)
    assert(fastRouteAt >= 0 && groupGateAt > fastRouteAt, "runtime harus memproses self tagall sebelum gate admin/Group Bot")
    assert(indexSource.includes("if (isSelfTagallOutput)"), "output gate harus memiliki bypass khusus self tagall")
    assert(indexSource.includes("delete options[groupUtilityCommands.TAGALL_OUTPUT_BYPASS_OPTION]"), "marker internal tagall harus dibuang sebelum dikirim ke Baileys")

    const mediaMsg = makeMsg(".hidetag pengumuman", {
        quoted: { id: "quoted-image", participant: USER_LID, message: { imageMessage: { mimetype: "image/jpeg" } } },
    })
    const hidetagSock = makeSock()
    await utility.handleGroupUtilityCommand(hidetagSock, mediaMsg, makeContext(".hidetag pengumuman", {
        extra: { downloadMedia: async () => Buffer.from("hidden-image") },
    }))
    const hidden = hidetagSock.calls.send.find(call => Buffer.isBuffer(call.content.image))
    assert(hidden, "hidetag reply image harus mempertahankan media")
    assert.strictEqual(hidden.content.caption, "pengumuman")
    assert.strictEqual(hidden.content.mentions.filter(jid => jid === USER_PN).length, 1)
    assert.notStrictEqual(hidden.options?.quoted?.key?.remoteJid, "status@broadcast", "tidak boleh membuat quote status palsu")
}

async function main() {
    await runHardGateTests()
    await runOpenCloseTests()
    await runProfileAndPinTests()
    await runPollTests()
    await runTagTests()
    console.log("PASS test-group-utility-pack")
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
