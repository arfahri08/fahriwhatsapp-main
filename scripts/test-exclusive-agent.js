"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exclusive-agent-test-"))
process.env.EXCLUSIVE_AGENT_STATE_FILE = path.join(tempDir, "state.json")

const agent = require("../modules/exclusiveAgent")
const store = require("../modules/exclusiveAgentStore")

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

async function main() {
    const sends = []
    const sock = {
        sendMessage: async (jid, content, options) => {
            sends.push({ jid, content, options })
            return { key: { id: `S${sends.length}` } }
        },
    }
    const group = "120363999999999999@g.us"
    const other = "120363888888888888@g.us"

    // Disabled group must stay silent.
    let handled = await agent.handleExclusiveGroupMessage(sock, { key: { remoteJid: group, participant: "628111111111@s.whatsapp.net" } }, {
        from: group, isGroup: true, text: "bot piye iki", senderJid: "628111111111@s.whatsapp.net", random: () => 0,
    })
    assert(handled === false && sends.length === 0, "disabled group must be silent")

    // Non-owner cannot activate; command is consumed silently.
    handled = await agent.handleExclusiveToggleCommand(sock, { key: { remoteJid: group } }, {
        from: group, isGroup: true, text: ".fitur", senderJid: "628111111111@s.whatsapp.net", canControlOwner: false,
    })
    assert(handled === true && !store.isEnabled(group) && sends.length === 0, "non-owner activation must be silent")

    // Bare .fitur means ON for owner.
    handled = await agent.handleExclusiveToggleCommand(sock, { key: { remoteJid: group } }, {
        from: group, isGroup: true, text: ".fitur", senderJid: "628999999999@s.whatsapp.net", canControlOwner: true,
    })
    assert(handled === true && store.isEnabled(group), "owner .fitur must enable")
    assert(sends.length === 1 && /Status: ON/.test(sends[0].content.text), "enable confirmation missing")

    // Direct bot call always replies.
    const beforeBot = sends.length
    handled = await agent.handleExclusiveGroupMessage(sock, { key: { remoteJid: group, participant: "628111111111@s.whatsapp.net", id: "M1" } }, {
        from: group,
        isGroup: true,
        text: "bot piye iki kok rame",
        senderJid: "628111111111@s.whatsapp.net",
        random: () => 0.99,
        isBotGeneratedMessage: () => false,
        now: 100000,
    })
    assert(handled === true && sends.length === beforeBot + 1, "direct bot call should reply")
    assert(store.getState().groupMessages[group]?.some(item => item.text === "bot piye iki kok rame"), "enabled group text must be persisted")

    const beforeSocial = sends.length
    handled = await agent.handleExclusiveGroupMessage(sock, { key: { remoteJid: group, participant: "628111111111@s.whatsapp.net", id: "SOCIAL-1" } }, {
        from: group, isGroup: true, text: "hayo link opo iki https://www.instagram.com/p/abc/", senderJid: "628111111111@s.whatsapp.net",
        random: () => 0, isBotGeneratedMessage: () => false, now: 100250,
    })
    assert(handled === false && sends.length === beforeSocial, "social-media link chatter must stay silent")

    const beforeOwner = sends.length
    handled = await agent.handleExclusiveGroupMessage(sock, { key: { remoteJid: group, participant: "628999999999@s.whatsapp.net", fromMe: true, id: "OWNER-1" } }, {
        from: group,
        isGroup: true,
        text: "bot iki piye",
        senderJid: "628999999999@s.whatsapp.net",
        isOwner: true,
        canControlOwner: true,
        isBotGeneratedMessage: () => false,
        now: 100500,
    })
    assert(handled === false && sends.length === beforeOwner, "owner group messages must not receive agent replies")

    // Real DPR conversation retrieval should win over a generic template when similar.
    const beforeContext = sends.length
    handled = await agent.handleExclusiveGroupMessage(sock, { key: { remoteJid: group, participant: "628333333333@s.whatsapp.net", id: "MCTX" } }, {
        from: group,
        isGroup: true,
        text: "tanggung jwb si kucingnya suruh masakin",
        senderJid: "628333333333333@s.whatsapp.net",
        random: () => 0,
        isBotGeneratedMessage: () => false,
        now: 120000,
    })
    assert(handled === true && sends.length === beforeContext + 1 && /kamu sih dek/i.test(sends.at(-1).content.text), `DPR contextual retrieval missing: ${sends.at(-1)?.content?.text || "none"}`)

    // Anton call also replies.
    const beforeAnton = sends.length
    handled = await agent.handleExclusiveGroupMessage(sock, { key: { remoteJid: group, participant: "628222222222@s.whatsapp.net", id: "M2" } }, {
        from: group,
        isGroup: true,
        text: "anton neng ndi iki",
        senderJid: "628222222222@s.whatsapp.net",
        random: () => 0.99,
        isBotGeneratedMessage: () => false,
        now: 101000,
    })
    assert(handled === true && sends.length === beforeAnton + 1, "Anton call should reply")

    // Rough language warning for non-owner when existing anti-toxic did not consume it.
    const beforeRough = sends.length
    handled = await agent.handleExclusiveGroupMessage(sock, { key: { remoteJid: group, participant: "628333333333@s.whatsapp.net", id: "M3" } }, {
        from: group,
        isGroup: true,
        text: "goblok tenan iki",
        senderJid: "628333333333@s.whatsapp.net",
        random: () => 0,
        isBotGeneratedMessage: () => false,
        now: 102000,
    })
    assert(handled === true && sends.length === beforeRough + 1, "rough language should warn")
    assert(/^⚠️/.test(sends.at(-1).content.text), "rough warning prefix missing")

    // Owner remains exempt from rough-language warning; chance is high but selected jawa/general may still reply.
    // Force text to only match rough intent and random above any optional reply; rough branch explicitly skips owner.
    const beforeOwnerRough = sends.length
    handled = await agent.handleExclusiveGroupMessage(sock, { key: { remoteJid: group, participant: "628999999999@s.whatsapp.net", id: "M4" } }, {
        from: group,
        isGroup: true,
        text: "kontol",
        senderJid: "628999999999@s.whatsapp.net",
        canControlOwner: true,
        isOwner: true,
        random: () => 0.999999,
        isBotGeneratedMessage: () => false,
        now: 200000,
    })
    assert(sends.length === beforeOwnerRough, "owner must not receive rough-language warning")

    // Bot-generated outbound loop must be ignored.
    handled = await agent.handleExclusiveGroupMessage(sock, { key: { remoteJid: group, participant: "628999999999@s.whatsapp.net", id: "BOT1", fromMe: true } }, {
        from: group,
        isGroup: true,
        text: "bot hadir",
        senderJid: "628999999999@s.whatsapp.net",
        isBotGeneratedMessage: () => true,
        random: () => 0,
        now: 300000,
    })
    assert(handled === false, "bot-generated message must not loop")

    // Another group remains off.
    handled = await agent.handleExclusiveGroupMessage(sock, { key: { remoteJid: other, participant: "628111111111@s.whatsapp.net" } }, {
        from: other, isGroup: true, text: "bot jawab", senderJid: "628111111111@s.whatsapp.net", random: () => 0,
    })
    assert(handled === false && !store.isEnabled(other), "exclusive state must be per group")

    // Mode command and off.
    await agent.handleExclusiveToggleCommand(sock, { key: { remoteJid: group } }, {
        from: group, isGroup: true, text: ".fitur rame", senderJid: "628999999999@s.whatsapp.net", canControlOwner: true,
    })
    assert(store.getGroup(group).mode === "rame", "rame mode not saved")
    await agent.handleExclusiveToggleCommand(sock, { key: { remoteJid: group } }, {
        from: group, isGroup: true, text: ".fitur off", senderJid: "628999999999@s.whatsapp.net", canControlOwner: true,
    })
    assert(!store.isEnabled(group), "off command failed")

    fs.rmSync(tempDir, { recursive: true, force: true })
    console.log("PASS test-exclusive-agent")
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
