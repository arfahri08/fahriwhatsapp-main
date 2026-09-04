"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const root = path.join(__dirname, "..")
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "group-routing-policy-"))
process.env.GROUP_REMOTE_CONTROL_DATA_FILE = path.join(tempRoot, "groupRemoteControl.json")
const groupRemoteControl = require(path.join(root, "modules", "groupRemoteControl"))
const autoReply = require(path.join(root, "modules", "autoReply"))
const help = require(path.join(root, "modules", "help"))
const healthCheck = require(path.join(root, "modules", "healthCheck"))

const GROUP_JID = "120363999999999999@g.us"
const PRIVATE_JID = "6281234567890@s.whatsapp.net"

async function main() {
    assert.strictEqual(groupRemoteControl.isGroupBotEnabled(GROUP_JID), false)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "antiToxic"), false)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "downloader"), false)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "antiLink"), false)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "autoReply"), false)

    groupRemoteControl.setBotEnabled(GROUP_JID, true, "test-owner")
    assert.strictEqual(groupRemoteControl.isGroupBotEnabled(GROUP_JID), true)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "downloader"), true, "fitur biasa aktif setelah .bot on")
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "groupMenu"), true)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "antiToxic"), false, "fitur moderasi fail closed tanpa runtime admin")
    const adminRuntime = { effectiveBotEnabled: true, metadataAvailable: true, botAdmin: true }
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "antiToxic", adminRuntime), true)
    assert.strictEqual(groupRemoteControl.isGroupFeatureEnabled(GROUP_JID, "welcome", adminRuntime), true)

    const policy = groupRemoteControl.getInboundGroupPolicySummary()
    assert.match(policy.mode, /DEFAULT OFF/)
    assert.strictEqual(policy.groupDetectLink, false)
    assert.strictEqual(policy.groupAutoReply, false)
    assert.strictEqual(policy.groupDownloader, true)
    assert.strictEqual(policy.groupStickerSafety, true)
    assert.strictEqual(policy.groupBotDefault, "OFF")
    assert.strictEqual(policy.hardAdminGate, true)
    assert.strictEqual(policy.managementAdminGate, true)

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

    const groupControlSource = fs.readFileSync(path.join(root, "modules", "groupRemoteControl.js"), "utf8")
    assert.match(groupControlSource, /ID SIAP DISALIN/)
    assert.match(groupControlSource, /Setiap pesan di bawah berisi kode \+ nama grup \+ ID/)
    assert.match(groupControlSource, /for \(const \[code, item\] of map\) \{[\s\S]*text: `\$\{code\} — \$\{item\.subject\}\\nID: \$\{item\.jid\}`/)

    const menu = help.generateHelpMenu()
    assert.match(menu, /Grup baru selalu Bot group OFF/)
    assert.match(menu, /\.bot on/)
    assert.match(menu, /Detect Link otomatis/)
    assert.doesNotMatch(menu, /hanya menjalankan Anti Kasar/i)
    assert.match(menu, /GROUP ADMIN & UTILITY PACK/)
    assert.match(menu, /\.gcschedule/)
    assert.match(menu, /\.warnautokick/)

    const health = await healthCheck.buildHealthText({
        autoReply,
        groupRemoteControl,
        botStatus: { getStatus: () => true },
    })
    assert.match(health, /DEFAULT OFF/)
    assert.match(health, /Group Detect Link: OFF/)
    assert.match(health, /Group Auto Reply: OFF/)
    assert.match(health, /Group Downloader Commands: ON/)
    assert.match(health, /Group Sticker Safety: ON/)

    const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8")
    assert.match(indexSource, /policy: "groupEnabledNoAutoLinkOrReply"/)
    assert.doesNotMatch(indexSource, /policy: "antiToxicOnly"/)
    assert.match(indexSource, /const groupDownloaderEnabled = !isGroup \|\| groupRemoteControl\.isGroupFeatureEnabled\(from, "downloader", inboundGroupPolicy \|\| \{\}\)/)
    assert.match(indexSource, /if \(!isGroup\) \{\s*const extendedDownloadHandled/)
    assert.match(indexSource, /if \(!isGroup\) \{\s*try \{\s*logPrivateLidPipeline\("before-local-downloader"/)
    assert.match(indexSource, /handler: "groupBotGate"/)
    assert.match(indexSource, /reason: inboundGroupPolicy.reason/)
    assert.match(indexSource, /groupWelcome\.rememberBotIdentityCandidates\(sock, msg\)/)
    assert.match(indexSource, /handleInGroupBotControlCommand\(sock, msg/)
    assert.match(indexSource, /__allowGroupControlOutput/)
    assert.match(indexSource, /groupRuntimePolicy\.resolveGroupRuntimePolicy\(sock, from/)
    assert.match(indexSource, /wrapRelayMessageForGroups\(sock\)/)
    assert.match(indexSource, /authorizeGroupOutput\(sock, jid\)/)
    assert.match(indexSource, /groupUtilityCommands\.handleGroupUtilityCommand/)
    assert.match(indexSource, /groupScheduleManager\.handleGroupScheduleCommand/)
    assert.match(indexSource, /groupModerationTools\.handleGroupModerationCommand/)
    assert.match(indexSource, /groupAttendance\.handleGroupAttendanceCommand/)
    assert.match(indexSource, /groupFloodGuard\.handleIncomingGroupMessage/)
    const groupBotGateIndex = indexSource.indexOf("groupRuntimePolicy.resolveGroupRuntimePolicy(sock, from")
    const utilityRouterIndex = indexSource.indexOf('"groupUtilityCommands", groupUtilityCommands.handleGroupUtilityCommand')
    assert.ok(groupBotGateIndex > indexSource.indexOf("groupWelcome.rememberBotIdentityCandidates(sock, msg)"))
    assert.ok(indexSource.indexOf("handleInGroupBotControlCommand(sock, msg") < groupBotGateIndex)
    assert.ok(utilityRouterIndex > groupBotGateIndex)
    assert.ok(utilityRouterIndex < indexSource.indexOf("stickerSafetyCommandHandled"))
    assert.ok(utilityRouterIndex < indexSource.indexOf("commandRateLimiterCommand"))
    assert.ok(groupBotGateIndex < indexSource.indexOf("stickerSafetyCommandHandled"))
    assert.ok(groupBotGateIndex < indexSource.indexOf("shouldRunAntiToxicForMessage"))

    console.log("GROUP ROUTING POLICY TEST: PASS")
    console.log("- Group ON + bot admin: commands/features continue")
    console.log("- Bot not admin: ordinary features work, management stays silent")
    console.log("- Group OFF: only owner .bot control can pass the gate")
    console.log("- Bare link detection: private-only")
    console.log("- Auto Reply: private-only")
    console.log("- Explicit downloader commands: available in active groups")
}

main().catch(error => {
    console.error("GROUP ROUTING POLICY TEST: FAIL")
    console.error(error.stack || error.message || error)
    process.exitCode = 1
}).finally(() => {
    const resolved = path.resolve(tempRoot)
    const tempBase = path.resolve(os.tmpdir())
    if (resolved.startsWith(`${tempBase}${path.sep}`)) fs.rmSync(resolved, { recursive: true, force: true })
})
