"use strict"

const assert = require("assert")
const antiToxicContext = require("../modules/antiToxicContext")

function response(classification) {
    return {
        status: 200,
        data: {
            candidates: [{
                content: {
                    parts: [{ text: JSON.stringify(classification) }],
                },
            }],
        },
    }
}

function testConfig() {
    return {
        requested: true,
        enabled: true,
        apiKey: "test-key",
        model: "gemini-test",
        scanAll: true,
        timeoutMs: 1000,
        cacheTtlMs: 1000,
        cacheLimit: 20,
        maxTextLength: 1200,
        confidenceThreshold: 0.72,
        implicitConfidenceThreshold: 0.88,
        debug: false,
    }
}

async function run() {
    antiToxicContext.clearCache()

    const neutralText = "jangan buang sampah sembarangan"
    const lexicalSampah = {
        word: "sampah",
        matchedInput: "sampah",
        matchedNormalizedInput: "sampah",
        tokens: ["jangan", "buang", "sampah", "sembarangan"],
        matchedTokens: ["sampah"],
        detectionVariant: "exact",
    }
    let neutralPayload = null
    const neutral = await antiToxicContext.classifyToxicContext(neutralText, {
        isGroup: true,
        lexicalMatch: lexicalSampah,
    }, {
        config: testConfig(),
        skipCache: true,
        ignoreCircuit: true,
        request: async (_url, payload) => {
            neutralPayload = payload
            return response({
                label: "safe",
                confidence: 0.99,
                category: "literal_or_neutral",
                contextType: "literal_or_neutral",
                targeted: false,
                targetEvidence: "",
                evidence: "buang sampah",
                reason: "Instruksi menjaga kebersihan, bukan penghinaan.",
                language: "id",
            })
        },
    })
    assert.equal(neutral.status, "classified")
    assert.equal(neutral.toxic, false)
    assert.equal(neutral.category, "literal_or_neutral")
    assert.equal(antiToxicContext.applyContextDecision(neutralText, lexicalSampah, neutral).word, null)
    assert.equal(neutralPayload.generationConfig.responseMimeType, "application/json")
    assert(neutralPayload.systemInstruction.parts[0].text.includes("KONTEKS"))
    assert(neutralPayload.systemInstruction.parts[0].text.includes("bahasa daerah Indonesia"))
    assert(neutralPayload.systemInstruction.parts[0].text.includes("Contoh Jawa SAFE"))
    assert(neutralPayload.systemInstruction.parts[0].text.includes("Contoh English SAFE"))
    assert(neutralPayload.generationConfig.responseSchema.required.includes("targetEvidence"))

    const replyPayload = antiToxicContext._buildRequestPayloadForTest("wah pintar banget", {
        isReply: true,
        quotedText: "aku salah menghapus semua data",
        lexicalMatch: { word: null },
    })
    const replyEnvelope = JSON.parse(replyPayload.contents[0].parts[0].text)
    assert.equal(replyEnvelope.metadata.replyToAnotherMessage, true)
    assert.equal(replyEnvelope.metadata.quotedMessage, "aku salah menghapus semua data")

    const sarcasmText = "Pintar sekali kamu, hal semudah itu saja semua jadi rusak"
    const sarcasm = await antiToxicContext.classifyToxicContext(sarcasmText, {
        isGroup: true,
        isReply: true,
        lexicalMatch: { word: null, tokens: sarcasmText.split(/\s+/), matchedTokens: [] },
    }, {
        config: testConfig(),
        skipCache: true,
        ignoreCircuit: true,
        request: async () => response({
            label: "toxic",
            confidence: 0.94,
            category: "hostile_sarcasm",
            contextType: "direct_attack",
            targeted: true,
            targetEvidence: "kamu",
            evidence: "Pintar sekali kamu",
            reason: "Pujian semu dipakai untuk merendahkan kemampuan lawan bicara.",
            language: "id",
        }),
    })
    const sarcasmMatch = antiToxicContext.applyContextDecision(sarcasmText, { word: null, tokens: [] }, sarcasm)
    assert.equal(sarcasm.toxic, true)
    assert.equal(sarcasmMatch.word, "sarkasme merendahkan")
    assert.equal(sarcasmMatch.matchedAlias, "Pintar sekali kamu")
    assert.equal(sarcasmMatch.detectionSource, "context-ai")

    const lowConfidence = antiToxicContext._normalizeClassificationForTest({
        label: "toxic",
        confidence: 0.6,
        category: "insult",
        contextType: "direct_attack",
        targeted: true,
        targetEvidence: "kamu",
        evidence: "kamu",
        reason: "Konteks belum cukup.",
        language: "id",
    }, "kamu", testConfig())
    assert.equal(lowConfidence.toxic, false, "toxic confidence di bawah ambang harus tetap bersih")

    const inventedEvidence = antiToxicContext._normalizeClassificationForTest({
        label: "toxic",
        confidence: 0.95,
        category: "insult",
        contextType: "direct_attack",
        targeted: true,
        targetEvidence: "",
        evidence: "kutipan yang tidak ada",
        reason: "Pengujian sanitasi.",
        language: "id",
    }, "pesan asli", testConfig())
    assert.equal(inventedEvidence.evidence, "", "evidence buatan model tidak boleh diteruskan")
    assert.equal(inventedEvidence.toxic, false, "serangan tanpa bukti asli harus diblokir")

    const ordinaryJavanese = antiToxicContext._normalizeClassificationForTest({
        label: "toxic",
        confidence: 0.99,
        category: "threat",
        contextType: "direct_attack",
        targeted: false,
        targetEvidence: "",
        evidence: "arep menyang pasar",
        reason: "Model salah membaca kalimat biasa sebagai ancaman.",
        language: "jv",
    }, "Aku arep menyang pasar sesuk", testConfig())
    assert.equal(ordinaryJavanese.toxic, false, "kalimat Jawa tanpa sasaran tidak boleh menjadi ancaman")
    assert.equal(ordinaryJavanese.decisionGuard, "targeted")

    const inventedJavaneseTarget = antiToxicContext._normalizeClassificationForTest({
        label: "toxic",
        confidence: 0.99,
        category: "insult",
        contextType: "direct_attack",
        targeted: true,
        targetEvidence: "sesuk",
        evidence: "arep menyang pasar",
        reason: "Model mengarang sasaran dari keterangan waktu.",
        language: "jv",
    }, "Aku arep menyang pasar sesuk", testConfig())
    assert.equal(inventedJavaneseTarget.toxic, false, "targetEvidence yang bukan sasaran harus ditolak")
    assert.equal(inventedJavaneseTarget.decisionGuard, "targetAnchored")

    const safeCategoryCannotBecomeToxic = antiToxicContext._normalizeClassificationForTest({
        label: "toxic",
        confidence: 0.99,
        category: "literal_or_neutral",
        contextType: "direct_attack",
        targeted: true,
        targetEvidence: "you",
        evidence: "trash bin",
        reason: "Kategori dan label tidak konsisten.",
        language: "en",
    }, "You moved the trash bin", testConfig())
    assert.equal(safeCategoryCannotBecomeToxic.toxic, false, "kategori netral tidak boleh menjadi toxic")
    assert.equal(safeCategoryCannotBecomeToxic.decisionGuard, "toxicCategory")

    const safeContextCannotBecomeToxic = antiToxicContext._normalizeClassificationForTest({
        label: "toxic",
        confidence: 0.99,
        category: "insult",
        contextType: "literal_or_neutral",
        targeted: true,
        targetEvidence: "kowe",
        evidence: "kowe",
        reason: "Context type dan label tidak konsisten.",
        language: "jv",
    }, "Kowe menyang pasar", testConfig())
    assert.equal(safeContextCannotBecomeToxic.toxic, false, "contextType aman harus membatalkan label toxic")
    assert.equal(safeContextCannotBecomeToxic.decisionGuard, "directAttack")

    const realEnglishThreat = antiToxicContext._normalizeClassificationForTest({
        label: "toxic",
        confidence: 0.96,
        category: "threat",
        contextType: "direct_attack",
        targeted: true,
        targetEvidence: "you",
        evidence: "I will hurt you",
        reason: "Ancaman bahaya diarahkan kepada you.",
        language: "en",
    }, "I will hurt you", testConfig())
    assert.equal(realEnglishThreat.toxic, true, "ancaman asing dengan sasaran jelas harus tetap terdeteksi")

    const weakImplicitSarcasm = antiToxicContext._normalizeClassificationForTest({
        label: "toxic",
        confidence: 0.87,
        category: "hostile_sarcasm",
        contextType: "direct_attack",
        targeted: true,
        targetEvidence: "kamu",
        evidence: "pintar kamu",
        reason: "Keyakinan belum cukup untuk sarkasme implisit.",
        language: "id",
    }, "pintar kamu", testConfig())
    assert.equal(weakImplicitSarcasm.toxic, false, "sarkasme implisit memerlukan keyakinan tinggi")
    assert.equal(weakImplicitSarcasm.requiredConfidence, 0.90)

    const localSafeCases = [
        ["Aku tuku pakan kanggo asuku", { word: "asu", matchedInput: "asuku" }],
        ["Jancuk, kaget aku!", { word: "jancuk", matchedInput: "Jancuk" }],
        ["Gila, apik tenan lagune", { word: "gila", matchedInput: "Gila" }],
        ["jangan gunakan kata bodoh untuk mengejek", { word: "bodoh", matchedInput: "bodoh" }],
        ["jangan buang sampah sembarangan", { word: "sampah", matchedInput: "sampah" }],
        ["This trash bin is full", { word: "sampah", matchedInput: "trash" }],
        ["This garbage bin is full", { word: "garbage", matchedInput: "garbage" }],
        ["Der Müll wird getrennt", { word: "sampah", matchedInput: "Müll" }],
        ["La basura se recicla", { word: "basura", matchedInput: "basura" }],
    ]
    for (const [input, lexicalMatch] of localSafeCases) {
        const result = antiToxicContext.classifyLocalSafeContext(input, { lexicalMatch })
        assert(result && !result.toxic, `local safe rule gagal: ${input}`)
    }
    assert.equal(antiToxicContext.classifyLocalSafeContext("jancuk kowe", {
        lexicalMatch: { word: "jancuk", matchedInput: "jancuk" },
    }), null, "umpatan yang diarahkan harus tetap dinilai model")
    assert.equal(antiToxicContext.classifyLocalSafeContext("dasar goblok kowe", {
        lexicalMatch: { word: "goblok", matchedInput: "goblok" },
    }), null, "serangan kuat tidak boleh ditekan aturan lokal")
    assert.equal(antiToxicContext.classifyLocalSafeContext("You are trash, not a trash bin", {
        lexicalMatch: { word: "trash", matchedInput: "trash" },
    }), null, "serangan Inggris tidak boleh dianggap pembahasan sampah literal")
    assert.equal(antiToxicContext.classifyLocalSafeContext("Eres basura para reciclar", {
        lexicalMatch: { word: "basura", matchedInput: "basura" },
    }), null, "serangan Spanyol tidak boleh dianggap pembahasan sampah literal")

    const failed = await antiToxicContext.classifyToxicContext("dasar menyebalkan", {
        lexicalMatch: { word: null },
    }, {
        config: testConfig(),
        skipCache: true,
        ignoreCircuit: true,
        request: async () => { throw new Error("simulated timeout") },
    })
    assert.equal(failed.status, "unavailable")
    assert.equal(antiToxicContext.applyContextDecision("dasar menyebalkan", { word: null }, failed), null)

    console.log(JSON.stringify({
        marker: "ANTI_TOXIC_CONTEXT_TESTS_OK",
        neutralSuppressed: true,
        implicitSarcasmDetected: true,
        multilingualGuard: true,
        localSafeRules: localSafeCases.length,
        confidenceGuard: true,
        evidenceGuard: true,
        fallbackGuard: true,
    }))
}

run().catch(error => {
    console.error(error)
    process.exitCode = 1
})
