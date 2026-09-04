"use strict"

const fs = require("fs")
const path = require("path")

function assertContains(text, needle, label) {
    if (!text.includes(needle)) throw new Error(`missing ${label}: ${needle}`)
}

const root = path.join(__dirname, "..")
const index = fs.readFileSync(path.join(root, "index.js"), "utf8")
const help = fs.readFileSync(path.join(root, "modules", "help.js"), "utf8")
const privateMenu = fs.readFileSync(path.join(root, "modules", "privateHelloMenu.js"), "utf8")

for (const [needle, label] of [
    ['require("./modules/exclusiveAgent")', "exclusive agent require"],
    ['require("./modules/exclusiveReminder")', "exclusive reminder require"],
    ['exclusiveAgent.handleExclusiveToggleCommand', "pre-gate .fitur toggle"],
    ['exclusiveAgent.handleExclusiveGroupMessage', "group agent runtime"],
    ['exclusiveReminder.handleCommand', "private reminder wizard"],
    ['exclusiveReminder.installExclusiveReminder', "reminder scheduler install"],
    ['exclusiveReminder.disposeExclusiveReminder', "reminder scheduler dispose"],
]) assertContains(index, needle, label)

assertContains(help, ".fitur — owner mengaktifkan agent eksklusif", "group help .fitur")
assertContains(help, ".fiturreminder — wizard reminder eksklusif", "owner help reminder")
assertContains(privateMenu, ".fiturreminder", "private owner menu")

const togglePos = index.indexOf("exclusiveAgent.handleExclusiveToggleCommand")
const groupGatePos = index.indexOf("groupRemoteControl.handleInGroupBotControlCommand")
if (!(togglePos >= 0 && groupGatePos >= 0 && togglePos < groupGatePos)) throw new Error(".fitur toggle must be before group bot gate")
const toxicReturnPos = index.indexOf("if (toxicHandled) return")
const agentRuntimePos = index.indexOf("exclusiveAgent.handleExclusiveGroupMessage")
if (!(toxicReturnPos >= 0 && agentRuntimePos > toxicReturnPos)) throw new Error("exclusive agent must run after existing anti-toxic")
const exclusiveReminderPos = index.indexOf("exclusiveReminder.handleCommand")
const legacyReminderPos = index.indexOf("reminderContactFlow.handleReminderContactFlow")
if (!(exclusiveReminderPos >= 0 && legacyReminderPos > exclusiveReminderPos)) throw new Error("exclusive reminder wizard must run before legacy reminder flow")

console.log("PASS test-exclusive-agent-integration")
