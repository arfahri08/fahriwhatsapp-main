"use strict"
const fs = require("fs")
const path = require("path")
const zlib = require("zlib")
const readline = require("readline")

async function count(file) {
  const input = fs.createReadStream(file).pipe(zlib.createGunzip())
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  let rows = 0
  for await (const line of rl) {
    if (line.trim()) rows++
  }
  return rows
}

(async () => {
  const root = process.argv[2]
  if (!root) throw new Error("missing project root")
  const privateAgent = path.join(root, "modules", "privateAgent.js")
  const curated = path.join(root, "data", "agentprivate", "mamaExamples.jsonl.gz")
  const full = path.join(root, "data", "agentprivate", "mamaExamplesFull.jsonl.gz")
  if (!fs.existsSync(privateAgent)) throw new Error("modules/privateAgent.js missing")
  if (!fs.existsSync(curated)) throw new Error("curated Mama corpus missing")
  if (!fs.existsSync(full)) throw new Error("full Mama corpus missing")
  const rows = await count(full)
  if (rows < 16000) throw new Error(`full Mama corpus unexpectedly small: ${rows}`)
  console.log(`[VERIFY] full Mama corpus rows: ${rows}`)
  console.log("[VERIFY] privateAgent.js present")
})().catch(err => { console.error(`[VERIFY-FAIL] ${err.message}`); process.exit(1) })
