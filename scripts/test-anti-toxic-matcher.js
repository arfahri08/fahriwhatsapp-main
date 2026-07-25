"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const antiToxic = require("../modules/antiToxic")
const matcher = require("../modules/antiToxicMatcher")

const safeState = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "antiToxicSafeWords.json"), "utf8"))
const options = antiToxic.getAntiToxicMatcherOptions()

function expect(input, expected, group) {
    const match = antiToxic.findToxicMatch(input)
    assert.equal(Boolean(match.word), expected === "TOXIC", `${group}: ${input} -> ${match.word || "CLEAN"}`)
    return match
}

async function run() {
    assert.equal(safeState.version, 1)
    assert.equal(safeState.words.length, 390)
    assert.equal(new Set(safeState.words).size, 390)

    const corpus = matcher.testSafeWordCorpus({ ...options, corpus: safeState.words })
    assert.equal(corpus.tested, 390)
    assert.equal(corpus.falsePositive, 0, JSON.stringify(corpus.failed))

    const mandatorySafe = [
        "kontrol", "mengontrol", "pengontrolan", "konten", "konteks", "kontraktor",
        "santai", "rantai", "partai", "pantai", "lantai", "detail", "retail", "taiwan",
        "bangsa", "bangsawan", "bangsal", "blok", "blokir", "global", "tolong", "toleransi",
        "titik", "titip", "pukis", "museum", "musim", "bokeh", "buket", "polisi",
        "kolaborasi", "ngantuk", "mengantar", "kampus", "kompres", "aparat", "keperawatan",
        "begonia", "begadang", "jangka", "jangkauan", "pelajar", "pelayanan", "jenis", "tenis",
        "anjuran", "keranjang",
    ]
    mandatorySafe.forEach(input => expect(input, "CLEAN", "mandatory-safe"))

    const toxicExact = ["kontol", "kontolnya", "tai", "bangsat", "goblok", "tolol"]
    toxicExact.forEach(input => expect(input, "TOXIC", "toxic-exact"))

    const obfuscation = [
        "k0nt0l", "k.o.n.t.o.l", "k-o-n-t-o-l", "k o n t o l", "kooontol",
        "b4ngs4t", "g0bl0k", "ta1", "t.a.i",
    ]
    obfuscation.forEach(input => expect(input, "TOXIC", "obfuscation"))

    const tokenScoped = [
        "kontrol kontol",
        "bangsa bangsat",
        "santai tai",
        "museum kontol",
        "kontrol bangsat",
        "bangsat kontrol",
    ]
    tokenScoped.forEach(input => expect(input, "TOXIC", "token-scoped"))

    const substringSafe = ["santai", "rantai", "partai", "pantai", "lantai", "detail", "retail", "taiwan"]
    substringSafe.forEach(input => expect(input, "CLEAN", "substring-guard"))

    for (const input of ["kontrolnya", "rantainya", "pantainya", "detailnya"]) {
        expect(input, "CLEAN", "safe-clitic")
    }
    for (const input of ["kontolnya", "kontolmu", "kontolku", "kontollah", "kontolkah"]) {
        expect(input, "TOXIC", "toxic-clitic")
    }

    // Jalur Edited Message Guardian dan OCR menyerahkan content ke handler
    // Anti Kasar yang sama. Kandidat berikut memvalidasi keputusan shared matcher.
    expect("sistem kontrol berjalan", "CLEAN", "edited-message-guardian")
    expect("sistem kontrol kontol", "TOXIC", "edited-message-guardian")
    expect("SANTAI", "CLEAN", "ocr-text-matcher")
    expect("TAI", "TOXIC", "ocr-text-matcher")

    const sent = []
    const sock = {
        sendMessage: async (jid, payload) => {
            sent.push({ jid, text: payload?.text || "" })
            return { key: { id: `test-${sent.length}` } }
        },
    }
    assert.equal(await antiToxic.handleAntiToxicSafeMatcherCommand(sock, {}, {
        from: "owner@s.whatsapp.net",
        text: ".kasarsafe test kontrol",
        isGroup: false,
        isOwner: true,
    }), true)
    assert(sent[sent.length - 1].text.includes("Result: CLEAN"))
    assert.equal(await antiToxic.handleAntiToxicSafeMatcherCommand(sock, {}, {
        from: "owner@s.whatsapp.net",
        text: ".antitoxicsafe test kontol",
        isGroup: false,
        isOwner: true,
    }), true)
    assert(sent[sent.length - 1].text.includes("Result: TOXIC"))
    const sentBeforeGroup = sent.length
    assert.equal(await antiToxic.handleAntiToxicSafeMatcherCommand(sock, {}, {
        from: "123@g.us",
        text: ".safeword status",
        isGroup: true,
        isOwner: true,
    }), true)
    assert.equal(sent.length, sentBeforeGroup, "group command must stay silent")
    assert.equal(await antiToxic.handleAntiToxicSafeMatcherCommand(sock, {}, {
        from: "guest@s.whatsapp.net",
        text: ".kasarsafe status",
        isGroup: false,
        isOwner: false,
    }), true)
    assert.equal(sent[sent.length - 1].text, "Akses Ditolak")

    const health = antiToxic.getAntiToxicMatcherHealth()
    assert.equal(health.mode, "STRICT")
    assert.equal(health.safeWords, 390)
    assert.equal(health.shortWordFuzzy, "OFF")
    assert.equal(health.tokenScopedSafeCheck, true)
    assert.equal(health.regression.status, "PASS")
    assert.equal(health.version, "v2")

    const legacy = matcher.analyzeLegacyCollisions({ ...options, corpus: safeState.words })
    assert(legacy.some(item => item.safeToken === "kontrol" && item.toxicCandidate === "kontol"))
    assert(legacy.some(item => item.safeToken === "jangkrik" && item.toxicCandidate === "jangkrik"))

    const kontrolCollision = legacy.find(item => item.safeToken === "kontrol" && item.toxicCandidate === "kontol")
    assert.equal(kontrolCollision.distance, 1)
    assert(Math.abs(kontrolCollision.similarity - (6 / 7)) < 0.000001)

    const shortPolicy = matcher.getDynamicFuzzyPolicy("tai")
    const mediumPolicy = matcher.getDynamicFuzzyPolicy("kontol")
    assert.equal(shortPolicy.enabled, false)
    assert.equal(mediumPolicy.requireSameLength, true)
    assert.equal(mediumPolicy.minimumSimilarity, 0.90)

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anti-toxic-safe-store-test-"))
    try {
        const corruptFile = path.join(tempRoot, "antiToxicSafeWords.json")
        fs.writeFileSync(corruptFile, "{invalid", "utf8")
        const recovered = matcher.loadSafeWordState({ filePath: corruptFile, force: true })
        assert.equal(recovered.words.length, 390)
        assert(fs.readdirSync(tempRoot).some(name => /^antiToxicSafeWords\.corrupt\.\d+\.json$/.test(name)))
    } finally {
        matcher.loadSafeWordState({ force: true })
        const resolved = path.resolve(tempRoot)
        const base = path.resolve(os.tmpdir())
        if (resolved.startsWith(base + path.sep)) fs.rmSync(resolved, { recursive: true, force: true })
    }

    console.log(JSON.stringify({
        marker: "ANTI_TOXIC_MATCHER_TESTS_OK",
        safeCorpus: corpus.tested,
        safePassed: corpus.safe,
        toxicExact: toxicExact.length,
        obfuscation: obfuscation.length,
        tokenScoped: tokenScoped.length,
        substringGuard: substringSafe.length,
        editedMessageGuardian: 2,
        ocrTextMatcher: 2,
        ownerCommands: 4,
        legacyCollisions: legacy.length,
    }))
}

run().catch(error => {
    console.error(error)
    process.exitCode = 1
})
