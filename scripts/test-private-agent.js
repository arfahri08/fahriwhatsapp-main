"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "private-agent-test-"))
process.env.PRIVATE_AGENT_STATE_FILE = path.join(tempRoot, "state.json")

const agent = require("../modules/privateAgent")
const store = require("../modules/agentPrivateStore")

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

async function main() {
    const sends = []
    const sock = {
        sendMessage: async (jid, content, options) => {
            sends.push({ jid, content, options })
            return { key: { id: `P${sends.length}` } }
        },
    }

    const owner = "6288287764273@s.whatsapp.net"
    const mama = "628111222333@s.whatsapp.net"

    let handled = await agent.handlePrivateAgent(sock, { key: { remoteJid: owner } }, {
        from: owner, senderJid: owner, text: ".agent", isGroup: false, isOwner: true,
    })
    assert(handled === true, ".agent start not handled")

    handled = await agent.handlePrivateAgent(sock, {
        key: { remoteJid: owner },
        message: {
            contactMessage: {
                displayName: "Mama Novie",
                vcard: "BEGIN:VCARD\nFN:Mama Novie\nTEL;waid=628111222333:+628111222333\nEND:VCARD",
            },
        },
    }, {
        from: owner, senderJid: owner, text: "", isGroup: false, isOwner: true,
    })
    assert(handled === true && store.isEnabled(mama), "Mama contact not enabled")
    assert(store.getContact(mama).profile === "mama", "Mama profile not selected")

    handled = await agent.handlePrivateAgent(sock, { key: { remoteJid: mama } }, {
        from: mama, senderJid: mama, text: "Sdh ikut bae", isGroup: false, isOwner: false,
    })
    assert(handled === true, "active Mama message not handled")
    assert(/bayi|snack|wkwk|malu|iya/i.test(sends.at(-1).content.text), "historical/contextual response missing")

    const beforeAcknowledgement = sends.length
    handled = await agent.handlePrivateAgent(sock, { key: { remoteJid: mama, id: "ACK-1" } }, {
        from: mama, senderJid: mama, text: "sipp", isGroup: false, isOwner: false,
    })
    assert(handled === true && sends.length === beforeAcknowledgement + 1, "acknowledgement must be handled once")
    assert(sends.at(-1).content.react?.text === "👍", "acknowledgement must react instead of replying")

    handled = await agent.handlePrivateAgent(sock, { key: { remoteJid: "628999888777@s.whatsapp.net" } }, {
        from: "628999888777@s.whatsapp.net",
        senderJid: "628999888777@s.whatsapp.net",
        text: "Sdh ikut bae", isGroup: false, isOwner: false,
    })
    assert(handled === false, "disabled private contact must stay untouched")

    handled = await agent.handlePrivateAgent(sock, { key: { remoteJid: mama } }, {
        from: mama, senderJid: mama, text: ".help", isGroup: false, isOwner: false,
    })
    assert(handled === false, "private agent must not swallow commands")

    handled = await agent.handlePrivateAgent(sock, { key: { remoteJid: mama } }, {
        from: mama, senderJid: mama, text: "https://example.com/x", isGroup: false, isOwner: false,
    })
    assert(handled === false, "private agent must not swallow URLs")

    handled = await agent.handlePrivateAgent(sock, { key: { remoteJid: owner } }, {
        from: owner, senderJid: owner, text: ".agent status", isGroup: false, isOwner: true,
    })
    assert(handled === true && /Mama Novie/.test(sends.at(-1).content.text), "private agent status missing contact")

    handled = await agent.handlePrivateAgent(sock, { key: { remoteJid: owner } }, {
        from: owner, senderJid: owner, text: ".agent off", isGroup: false, isOwner: true,
    })
    assert(handled === true, ".agent off command not handled")

    handled = await agent.handlePrivateAgent(sock, {
        key: { remoteJid: owner },
        message: {
            contactMessage: {
                displayName: "Mama Novie",
                vcard: "BEGIN:VCARD\nFN:Mama Novie\nTEL;waid=628111222333:+628111222333\nEND:VCARD",
            },
        },
    }, {
        from: owner, senderJid: owner, text: "", isGroup: false, isOwner: true,
    })
    assert(handled === true && !store.isEnabled(mama), "private contact disable failed")

    fs.rmSync(tempRoot, { recursive: true, force: true })
    console.log("PASS test-private-agent")
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
