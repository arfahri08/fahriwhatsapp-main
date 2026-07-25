"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const ocr = require("../modules/antiToxicStickerOcr")

async function run() {
    assert.strictEqual(ocr.PIPELINE_VERSION, "anti-toxic-sticker-ocr-v5-restored")

    const toxicWords = ["anjing", "bangsat", "ngentot", "kontol"]
    for (const raw of ["NGENTOT", "N G E N T O T", "NGENT0T", "K0NT0L"]) {
        const candidates = ocr.normalizeOcrCandidates(raw)
        const match = ocr.matchOcrCandidatesAgainstWordlist(candidates, toxicWords)
        assert.strictEqual(match.matched, true, `${raw} should match wordlist`)
    }

    // Regression: the old fast pipeline spent all candidates on frame 0.
    // The toxic text below only exists in the middle sampled frame.
    const frames = [
        { buffer: Buffer.from("frame-0"), frameIndex: 0, pageCount: 75, source: "test" },
        { buffer: Buffer.from("frame-37"), frameIndex: 37, pageCount: 75, source: "test" },
        { buffer: Buffer.from("frame-74"), frameIndex: 74, pageCount: 75, source: "test" },
    ]
    const visitedFrames = []
    const result = await ocr.scanStickerForToxicWords(null, {
        buffer: Buffer.from("animated-sticker-regression-v5"),
        stickerMessage: { mimetype: "image/webp", isAnimated: true },
        toxicWords,
        frames,
        ignoreCache: true,
        disableSharp: true,
        recognizer: async candidate => {
            visitedFrames.push(candidate.frameIndex)
            return candidate.frameIndex === 37
                ? { text: "NGENTOT", confidence: 94 }
                : { text: "AMAN", confidence: 94 }
        },
        runtime: {
            pngjsEnabled: false,
            cliEnabled: false,
            maxCandidates: 3,
            maxPasses: 3,
            timeoutMs: 5000,
        },
    })

    assert.strictEqual(result.status, "toxic")
    assert.strictEqual(result.matchedWord, "ngentot")
    assert.strictEqual(result.matchedRawText, "NGENTOT")
    assert.strictEqual(result.matchedFrameIndex, 37)
    assert(visitedFrames.includes(37), `middle frame not scanned: ${visitedFrames.join(",")}`)

    const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")
    const antiSource = fs.readFileSync(path.join(__dirname, "..", "modules", "antiToxic.js"), "utf8")
    assert(indexSource.includes("OCR kata kasar mendapat prioritas pertama"))
    assert(indexSource.includes(".then(() => startBackgroundStickerSafety())"))
    assert(antiSource.includes("🧾 *TEKS KASAR PADA STIKER*"))
    assert(antiSource.includes("> *Kata terdeteksi:*"))
    assert(antiSource.includes("buildStickerOcrWarningContext(stickerOcrResult, triggeredWord)"))

    console.log(JSON.stringify({
        marker: "ANTI_TOXIC_STICKER_OCR_V5_TESTS_OK",
        status: result.status,
        matchedWord: result.matchedWord,
        matchedFrameIndex: result.matchedFrameIndex,
        visitedFrames,
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
