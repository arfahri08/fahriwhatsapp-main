"use strict"

const fs = require("fs")
const path = require("path")
const matcher = require("../modules/antiToxicMatcher")
const antiToxic = require("../modules/antiToxic")

const toxicFile = path.join(__dirname, "..", "data", "kataKasar.json")
const safeFile = path.join(__dirname, "..", "data", "antiToxicSafeWords.json")
const toxicWords = JSON.parse(fs.readFileSync(toxicFile, "utf8"))
const safeState = JSON.parse(fs.readFileSync(safeFile, "utf8"))
const options = {
    ...antiToxic.getAntiToxicMatcherOptions(),
    toxicWords,
    safeWords: safeState.words,
}

const legacy = matcher.analyzeLegacyCollisions({ ...options, corpus: safeState.words })
const regression = matcher.testSafeWordCorpus({ ...options, corpus: safeState.words })

console.log("SAFE WORD COLLISION AUDIT")
console.log("")
console.log(`Safe words tested: ${safeState.words.length}`)
console.log(`Toxic words tested: ${toxicWords.length}`)
console.log(`Potential comparisons: ${safeState.words.length * toxicWords.length}`)
console.log(`Legacy collisions documented: ${legacy.length}`)
for (const item of legacy) {
    console.log(`- ${item.safeToken} -> ${item.toxicCandidate} | distance=${item.distance} | similarity=${item.similarity.toFixed(3)} | ${item.type}`)
}
console.log(`False positives: ${regression.falsePositive}`)
console.log(`Result: ${regression.status}`)

if (regression.falsePositive > 0) {
    for (const item of regression.failed.slice(0, 30)) {
        console.log(`FAILED: ${item.safeWord} -> ${item.matchedWord} (${item.matchType})`)
    }
    process.exitCode = 1
}
