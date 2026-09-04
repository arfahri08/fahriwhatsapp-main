"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exclusive-reminder-test-"))
process.env.EXCLUSIVE_AGENT_STATE_FILE = path.join(tempDir, "state.json")

const store = require("../modules/exclusiveAgentStore")
const reminder = require("../modules/exclusiveReminder")

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function contactMessage(numbers) {
    return {
        contactsArrayMessage: {
            contacts: numbers.map((number, index) => ({
                displayName: `Kontak ${index + 1}`,
                vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:Kontak ${index + 1}\nTEL;type=CELL;type=VOICE;waid=${number}:+${number}\nEND:VCARD`,
            })),
        },
    }
}

async function main() {
    const group = "120363999999999999@g.us"
    const members = ["628111111111", "628222222222", "628333333333", "628444444444", "628555555555"]
    const metadata = {
        id: group,
        subject: "Grup Test Agent",
        participants: members.map(number => ({ id: `${number}@s.whatsapp.net`, admin: null })),
    }
    const sends = []
    const sock = {
        groupMetadata: async jid => {
            if (jid !== group) throw new Error("group unknown")
            return metadata
        },
        sendMessage: async (jid, content) => {
            sends.push({ jid, content })
            return { key: { id: `S${sends.length}` } }
        },
    }
    const ownerChat = "628999999999@s.whatsapp.net"
    store.setEnabled(group, true, ownerChat)

    // Wizard start.
    let handled = await reminder.handleCommand(sock, { key: { remoteJid: ownerChat }, message: { conversation: ".fiturreminder" } }, {
        from: ownerChat, text: ".fiturreminder", isGroup: false, canControlOwner: true, senderJid: ownerChat,
        resolveGroupTarget: async input => ({ ok: input === group, jid: input, subject: metadata.subject }),
    })
    assert(handled === true && /Kirim \*ID grup\*/.test(sends.at(-1).content.text), "wizard did not ask group")

    handled = await reminder.handleCommand(sock, { key: { remoteJid: ownerChat }, message: { conversation: group } }, {
        from: ownerChat, text: group, isGroup: false, canControlOwner: true, senderJid: ownerChat,
        resolveGroupTarget: async input => ({ ok: input === group, jid: input, subject: metadata.subject }),
    })
    assert(handled === true && /Sekarang kirim/.test(sends.at(-1).content.text), "wizard did not ask contacts")

    // An invalid member must reject the whole batch.
    const badMsg = { key: { remoteJid: ownerChat }, message: contactMessage([members[0], "628777777777"]) }
    handled = await reminder.handleCommand(sock, badMsg, {
        from: ownerChat, text: "", isGroup: false, canControlOwner: true, senderJid: ownerChat,
        resolveGroupTarget: async input => ({ ok: true, jid: group, subject: metadata.subject }),
    })
    assert(handled === true && /TIDAK TERVERIFIKASI/.test(sends.at(-1).content.text), "invalid member must be rejected")
    assert(store.listSubscriptions().length === 0, "invalid batch must not be saved")

    // Five valid contacts are accepted.
    const goodMsg = { key: { remoteJid: ownerChat }, message: contactMessage(members) }
    handled = await reminder.handleCommand(sock, goodMsg, {
        from: ownerChat, text: "", isGroup: false, canControlOwner: true, senderJid: ownerChat,
        resolveGroupTarget: async input => ({ ok: true, jid: group, subject: metadata.subject }),
    })
    assert(handled === true, "valid contacts not handled")
    const subscriptions = store.listSubscriptions()
    assert(subscriptions.length === 1 && subscriptions[0].targets.length === 5, "five contacts not saved")

    // Friday 2026-08-21 11:30 Asia/Jakarta = 04:30 UTC. No prayer location needed for Friday default.
    const beforeFriday = sends.length
    const tick = await reminder.runReminderTick(sock, {
        resolveGroupTarget: async input => ({ ok: true, jid: group, subject: metadata.subject }),
    }, new Date("2026-08-21T04:30:00Z"))
    const fridaySends = sends.slice(beforeFriday).filter(item => item.jid === group)
    assert(tick.due === 1 && tick.sent === 5 && fridaySends.length === 1, "Friday reminder must send once in the group")
    assert(fridaySends[0].content.mentions.length === 5, "Friday reminder must mention five validated members")
    assert(fridaySends[0].content.mentions.every(jid => members.some(number => jid === `${number}@s.whatsapp.net`)), "Friday mentions must be group members")
    assert(/Sholat Jumat/.test(fridaySends[0].content.text), "Friday message incorrect")
    assert(!sends.slice(beforeFriday).some(item => item.jid.endsWith("@s.whatsapp.net")), "Friday reminder must not be sent privately")

    // Same minute cannot double-send due to idempotent lastRuns.
    const second = await reminder.runReminderTick(sock, {
        resolveGroupTarget: async input => ({ ok: true, jid: group, subject: metadata.subject }),
    }, new Date("2026-08-21T04:30:20Z"))
    assert(second.due === 0 && second.sent === 0, "Friday reminder must be idempotent")

    // Membership is re-checked at delivery: remove one member, next direct send helper should skip it.
    metadata.participants = metadata.participants.slice(0, 4)
    const membership = await reminder.refreshMembership(sock, subscriptions[0], {})
    assert(membership.valid.length === 4 && membership.invalid.length === 1, "membership re-check failed")

    // Local prayer calculation returns a complete daily schedule once location is configured.
    store.setPrayerLocation(-2.9, 104.7, "Asia/Jakarta")
    const prayerTimes = reminder.computePrayerTimes(new Date("2026-08-21T05:00:00Z"), -2.9, 104.7, "Asia/Jakarta")
    assert(prayerTimes && ["subuh", "dzuhur", "ashar", "maghrib", "isya"].every(name => /^\d{2}:\d{2}$/.test(prayerTimes[name])), "prayer time calculation incomplete")

    fs.rmSync(tempDir, { recursive: true, force: true })
    console.log("PASS test-exclusive-reminder")
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
