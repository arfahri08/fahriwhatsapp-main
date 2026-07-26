"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")

const root = path.join(__dirname, "..")
const groupRemoteControl = require(path.join(root, "modules", "groupRemoteControl"))
const autoReply = require(path.join(root, "modules", "autoReply"))
const help = require(path.join(root, "modules", "help"))
const healthCheck = require(path.join(root, "modules", "healthCheck"))

const GROUP_JID = "120363999999999999@g.us"
const PRIVATE_JID = "6281234567890@s.whatsapp.net"

async function main() {
    assert.strictEqual(groupRemoteControl.isGroupBotEnabled(GROUP_JID), true)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "antiToxic"), true)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "editGuardian"), true)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "downloader"), true)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "stickerSafety"), true)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "stickerText"), true)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "stickerNsfw"), true)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "antiLink"), false)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "autoReply"), false)

    const policy = groupRemoteControl.getInboundGroupPolicySummary()
    assert.match(policy.mode, /COMMANDS & FEATURES/)
    assert.strictEqual(policy.groupDetectLink, false)
    assert.strictEqual(policy.groupAutoReply, false)
    assert.strictEqual(policy.groupDownloader, true)
    assert.strictEqual(policy.groupStickerSafety, true)

    const groupMessage = {
        key: { remoteJid: GROUP_JID, participant: PRIVATE_JID, fromMe: false, id: "GROUP-1" },
        message: { conversation: "halo" },
    }
    const privateMessage = {
        key: { remoteJid: PRIVATE_JID, fromMe: false, id: "PRIVATE-1" },
        message: { conversation: "halo" },
    }
    assert.strictEqual(autoReply.shouldProcessMessage(groupMessage, { botEnabled: true }), false)
    assert.strictEqual(autoReply.shouldProcessMessage(privateMessage, { botEnabled: true }), true)

    const spotifySource = fs.readFileSync(path.join(root, "modules", "spotifyDownloader.js"), "utf8")
    assert.match(spotifySource, /if \(isGroup && !parsedCommand\.isSpotifyCommand\) return false/)
    assert.doesNotMatch(spotifySource, /if \(isGroup\) return false/)

    const menu = help.generateHelpMenu()
    assert.match(menu, /Saat Bot group ON/)
    assert.match(menu, /Detect Link otomatis/)
    assert.doesNotMatch(menu, /hanya menjalankan Anti Kasar/i)

    const health = await healthCheck.buildHealthText({
        autoReply,
        groupRemoteControl,
        botStatus: { getStatus: () => true },
    })
    assert.match(health, /COMMANDS & FEATURES/)
    assert.match(health, /Group Detect Link: OFF/)
    assert.match(health, /Group Auto Reply: OFF/)
    assert.match(health, /Group Downloader Commands: ON/)
    assert.match(health, /Group Sticker Safety: ON/)

    const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8")
    assert.match(indexSource, /policy: "groupEnabledNoAutoLinkOrReply"/)
    assert.doesNotMatch(indexSource, /policy: "antiToxicOnly"/)
    assert.match(indexSource, /const groupDownloaderEnabled = !isGroup \|\| groupRemoteControl\.isGroupFeatureEnabled\(from, "downloader"\)/)
    assert.match(indexSource, /if \(!isGroup\) \{\s*const extendedDownloadHandled/)
    assert.match(indexSource, /if \(!isGroup\) \{\s*try \{\s*logPrivateLidPipeline\("before-local-downloader"/)
    assert.match(indexSource, /handler: "groupAdminGate"/)
    assert.match(indexSource, /reason: "bot-not-admin"/)
    assert.match(indexSource, /groupWelcome\.isBotAdmin\(inboundGroupMetadata, sock\)/)
    const adminGateIndex = indexSource.indexOf("groupWelcome.isBotAdmin(inboundGroupMetadata, sock)")
    assert.ok(adminGateIndex > indexSource.indexOf("groupRemoteControl.isGroupBotEnabled(from)"))
    assert.ok(adminGateIndex < indexSource.indexOf("stickerSafetyCommandHandled"))
    assert.ok(adminGateIndex < indexSource.indexOf("shouldRunAntiToxicForMessage"))

    console.log("GROUP ROUTING POLICY TEST: PASS")
    console.log("- Group ON + bot admin: commands/features continue")
    console.log("- Bot not admin: all inbound group features stay silent")
    console.log("- Group OFF: gate remains available via groupRemoteControl")
    console.log("- Bare link detection: private-only")
    console.log("- Auto Reply: private-only")
    console.log("- Explicit downloader commands: available in active groups")
}

main().catch(error => {
    console.error("GROUP ROUTING POLICY TEST: FAIL")
    console.error(error.stack || error.message || error)
    process.exitCode = 1
})
