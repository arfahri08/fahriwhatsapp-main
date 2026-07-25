"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const ocr = require("../modules/antiToxicStickerOcr")

const WORDS = ["tai", "kontol", "bangsat"]

function optionalPngFixture() {
    let PNG
    try {
        ({ PNG } = require("pngjs"))
    } catch {
        return null
    }
    const width = 80
    const height = 48
    const png = new PNG({ width, height })
    png.data.fill(255)
    for (let y = 10; y < 38; y += 1) {
        for (let x = 10; x < 70; x += 1) {
            if ((x % 20 < 4) || (y < 15)) {
                const index = (y * width + x) * 4
                png.data[index] = 0
                png.data[index + 1] = 0
                png.data[index + 2] = 0
                png.data[index + 3] = 255
            }
        }
    }
    return PNG.sync.write(png)
}

async function run() {
    const source = fs.readFileSync(path.join(__dirname, "..", "modules", "antiToxicStickerOcr.js"), "utf8")
    assert(source.includes("buildPngJsCandidates"), "Termux-safe PNGJS preprocessing must exist")
    assert(source.includes("recognizeCandidateWithCli"), "native Tesseract CLI fallback must exist")
    assert(source.includes("ANTI_TOXIC_STICKER_OCR_MAX_PASSES"), "bounded OCR pass setting must exist")
    assert.strictEqual(ocr.PIPELINE_VERSION, "anti-toxic-sticker-ocr-v5-restored")

    for (const raw of ["TAI", "TA1", "TAl", "T A I", "T.A.I", "TA!"]) {
        const candidates = ocr.normalizeOcrCandidates(raw)
        const match = ocr.matchOcrCandidatesAgainstWordlist(candidates, WORDS)
        assert.strictEqual(match.matched, true, `${raw} should match tai`)
        assert.strictEqual(match.word, "tai")
    }

    for (const safe of ["SANTAI", "RANTAI", "PARTAI", "DETAIL", "TAIWAN"]) {
        const candidates = ocr.normalizeOcrCandidates(safe)
        const match = ocr.matchOcrCandidatesAgainstWordlist(candidates, WORDS)
        assert.strictEqual(match.matched, false, `${safe} must stay clean`)
    }

    const frame = Buffer.from("mock-frame-for-bounded-pipeline")
    let calls = 0
    const result = await ocr.scanStickerForToxicWords(null, {
        buffer: frame,
        stickerMessage: { mimetype: "image/png", isAnimated: false },
        toxicWords: WORDS,
        frames: [{ buffer: frame, frameIndex: 0, pageCount: 1, source: "test" }],
        ignoreCache: true,
        recognizer: async () => {
            calls += 1
            return { text: calls === 1 ? "TAL" : "TAI", confidence: 75 }
        },
        runtime: {
            timeoutMs: 30000,
            maxCandidates: 8,
            maxPasses: 8,
            pngjsEnabled: false,
            cliEnabled: false,
        },
    })
    assert.strictEqual(result.status, "toxic")
    assert.strictEqual(result.matchedWord, "tai")
    assert(calls >= 1 && calls <= 8, `OCR passes must be bounded, got ${calls}`)

    ocr.clearAntiToxicStickerOcrCache()
    let duplicateCalls = 0
    const common = {
        buffer: frame,
        stickerMessage: { mimetype: "image/png", isAnimated: false },
        toxicWords: WORDS,
        frames: [{ buffer: frame, frameIndex: 0, pageCount: 1, source: "test" }],
        recognizer: async () => {
            duplicateCalls += 1
            await new Promise(resolve => setTimeout(resolve, 15))
            return { text: "TAI", confidence: 80 }
        },
        runtime: {
            timeoutMs: 30000,
            maxCandidates: 8,
            maxPasses: 4,
            pngjsEnabled: false,
            cliEnabled: false,
        },
    }
    const [first, second] = await Promise.all([
        ocr.scanStickerForToxicWords(null, common),
        ocr.scanStickerForToxicWords(null, common),
    ])
    assert.strictEqual(first.status, "toxic")
    assert.strictEqual(second.status, "toxic")
    assert.strictEqual(duplicateCalls, 1, "duplicate scan must share in-flight work")

    const pngFixture = optionalPngFixture()
    let pngCandidates = "SKIPPED"
    if (pngFixture) {
        const processed = await ocr.preprocessStickerCandidates([
            { buffer: pngFixture, frameIndex: 0, pageCount: 1, source: "test" },
        ], { maxCandidates: 8, pngjsEnabled: true })
        assert(processed.some(item => String(item.candidate).startsWith("pngjs-")), "PNGJS variants must be generated")
        pngCandidates = processed.length
    }

    const health = ocr.getAntiToxicStickerOcrHealth({ toxicWords: WORDS })
    assert.strictEqual(health.containsTai, true)
    assert.strictEqual(health.cacheVersion, "anti-toxic-sticker-ocr-v5-restored")

    console.log(JSON.stringify({
        marker: "ANTI_TOXIC_STICKER_OCR_V3_TESTS_OK",
        passes: result.passes,
        matchedWord: result.matchedWord,
        pngCandidates,
        cacheVersion: health.cacheVersion,
    }))
}

run()
    .catch(error => {
        console.error(error.stack || error.message)
        process.exitCode = 1
    })
    .finally(async () => {
        await ocr.disposeAntiToxicStickerOcr()
    })
