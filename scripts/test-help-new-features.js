"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const help = require("../modules/help")
const groupWelcome = require("../modules/groupWelcome")
const privateMenu = require("../modules/privateHelloMenu")

function includesAll(text, commands, label) {
    for (const command of commands) assert.ok(text.includes(command), `${label} harus memuat ${command}`)
}

function run() {
    const group = `${groupWelcome.buildFallbackMenuText()}\n${JSON.stringify(groupWelcome.buildMenuSections())}`
    includesAll(group, [".gcopen", ".gcschedule", ".tagall", ".warn", ".slowmode", ".antispam", ".nsfw", ".transkrip"], "group helper")

    const privateText = `${help.generateHelpMenu()}\n${privateMenu.buildPrivateFallbackText("Tester")}\n${privateMenu.buildCategoryText("store")}\n${privateMenu.buildCategoryText("subbot")}\n${privateMenu.buildCategoryText("tools")}`
    includesAll(privateText, [".shop", ".beli", ".saldo", ".deposit", ".jadibot", ".inspect", ".web2zip", ".transkrip", ".stt"], "private helper")
    const owner = `${help.generateHelpMenu()}\n${privateMenu.buildCategoryText("owner")}`
    includesAll(owner, [".jpm", ".pushkontak", ".upsw", ".autoreactsw", ".depositacc", ".orderdone", ".jadibotctl"], "owner private helper")
    assert.strictEqual(privateMenu.WEBSITE_URL, "https://wa.me/6288287764273")
    assert.strictEqual(privateMenu.WEBSITE_BUTTON_TEXT, "Hubungi Pengembang Bot")
    assert.ok(help.generateHelpMenu().endsWith("Pengembang bot : 088287764273"))
    assert.ok(privateMenu.buildPrivateMenuSections().some(section => section.rows.some(row => row.id === ".pmenu store")))

    const forbidden = /(?:DIGITALOCEAN|PTERODACTYL|VIRTUSIM|Bearer\s+[A-Za-z0-9._-]{12,}|(?:apiKey|api_key)\s*[:=]\s*["'][^"']{8,})/i
    const files = [
        "atomicJsonStore.js", "canonicalIdentity.js", "controlledBroadcast.js", "contactServices.js", "contactPushManager.js",
        "commerceManager.js", "commerceCommands.js", "jadibotManager.js", "statusAutomation.js", "whatsappInspect.js", "webToZip.js",
        "safeMockup.js", "imageNsfwModeration.js", "serviceCommandCatalog.js",
    ]
    for (const file of files) {
        const source = fs.readFileSync(path.join(__dirname, "..", "modules", file), "utf8")
        assert.doesNotMatch(source, forbidden, `${file} tidak boleh memuat external credential/provider terlarang`)
    }
    console.log("PASS test-help-new-features")
}

run()
