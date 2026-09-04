"use strict"

const fs = require("fs")
const path = require("path")
const zlib = require("zlib")
const readline = require("readline")

async function main() {
    const root = path.join(__dirname, "..")
    const corpus = path.join(root, "data", "exclusiveAgentCorpus.jsonl.gz")
    const meta = JSON.parse(fs.readFileSync(path.join(root, "data", "exclusiveAgentCorpus.meta.json"), "utf8"))
    let rows = 0
    const intents = new Map()
    const input = fs.createReadStream(corpus).pipe(zlib.createGunzip())
    const rl = readline.createInterface({ input, crlfDelay: Infinity })
    for await (const line of rl) {
        if (!line.trim()) continue
        const item = JSON.parse(line)
        if (!item.input || !item.reply || !item.intent) throw new Error(`invalid corpus row ${rows + 1}`)
        rows += 1
        intents.set(item.intent, (intents.get(item.intent) || 0) + 1)
    }
    if (rows !== 220000 || rows !== meta.rows) throw new Error(`expected 220000 rows, got ${rows}`)
    for (const [intent, expected] of Object.entries(meta.categories || {})) {
        if (intents.get(intent) !== expected) throw new Error(`${intent}: expected ${expected}, got ${intents.get(intent) || 0}`)
    }
    if (String(meta.adultContent || "") !== "mild/non-explicit only because group member ages are not known") {
        throw new Error("adult safety metadata missing")
    }
    console.log(`PASS test-exclusive-agent-corpus rows=${rows}`)
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
