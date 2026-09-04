"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const watchdog = require("../modules/sourceWatchdog")

async function waitFor(predicate, timeoutMs = 1500) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
        if (predicate()) return
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error("Timeout menunggu source watchdog")
}

async function run() {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "source-watchdog-"))
    try {
        fs.mkdirSync(path.join(rootDir, "modules"))
        fs.writeFileSync(path.join(rootDir, "index.js"), "module.exports = 1\n")
        fs.writeFileSync(path.join(rootDir, "modules", "feature.js"), "module.exports = 1\n")

        const before = watchdog.snapshotSourceTree(rootDir)
        fs.writeFileSync(path.join(rootDir, "modules", "feature.js"), "module.exports = 22\n")
        const after = watchdog.snapshotSourceTree(rootDir)
        assert.deepStrictEqual(watchdog.diffSnapshots(before, after), ["modules/feature.js"])

        assert.throws(() => {
            fs.writeFileSync(path.join(rootDir, "modules", "feature.js"), "module.exports = {\n")
            watchdog.validateJavaScriptChanges(rootDir, ["modules/feature.js"])
        }, /Unexpected end of input/)

        fs.writeFileSync(path.join(rootDir, "modules", "feature.js"), "module.exports = 3\n")
        let detected = null
        const instance = watchdog.startSourceWatchdog({
            enabled: true,
            rootDir,
            intervalMs: 25,
            debounceMs: 50,
            logger: { log() {} },
            onChange(change) { detected = change },
        })

        fs.writeFileSync(path.join(rootDir, "modules", "feature.js"), "module.exports = 4444\n")
        await waitFor(() => detected !== null)
        assert.deepStrictEqual(detected.paths, ["modules/feature.js"])
        instance.stop()

        console.log("PASS test-source-watchdog: diff, syntax guard, debounce, dan restart callback.")
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true })
    }
}

run().catch(error => {
    console.error(error)
    process.exitCode = 1
})
