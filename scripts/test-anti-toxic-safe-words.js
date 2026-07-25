"use strict"

const assert = require("assert")
const antiToxic = require("../modules/antiToxic")

for (const text of [
    "kontrol",
    "KONTROL",
    "Kontrol grup aktif",
    "fitur kontrol bot",
    "remote kontrol",
]) {
    assert.equal(antiToxic.findToxicWord(text), null, `safe word must stay clean: ${text}`)
}

assert.equal(antiToxic.findToxicWord("kontol"), "kontol", "real toxic word must still match")
assert.equal(antiToxic.findToxicWord("k0nt0l"), "kontol", "toxic leet variant must still match")

console.log("ANTI_TOXIC_SAFE_WORDS_TESTS_OK")
