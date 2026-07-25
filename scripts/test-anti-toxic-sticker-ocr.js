"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const sharp = require("sharp")
const ocr = require("../modules/antiToxicStickerOcr")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anti-toxic-sticker-ocr-test-"))
const WORDS = ["tai"]

function svgFixture(text, options = {}) {
    const background = options.transparent
        ? ""
        : `<rect width="100%" height="100%" fill="${options.background || "white"}"/>`
    const transform = options.rotate
        ? `transform="rotate(${Number(options.rotate)} 256 256)"`
        : ""
    const outline = options.outline
        ? `stroke="${options.stroke || "black"}" stroke-width="10" paint-order="stroke"`
        : ""
    return Buffer.from([
        '<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">',
        background,
        `<g ${transform}>`,
        `<text x="256" y="315" font-family="DejaVu Sans" font-size="${options.size || 220}" font-weight="bold" text-anchor="middle" fill="${options.fill || "black"}" ${outline}>${text}</text>`,
        "</g>",
        "</svg>",
    ].join(""))
}

async function makeWebpFixture(name, text, options = {}) {
    const buffer = await sharp(svgFixture(text, options)).webp({ lossless: true }).toBuffer()
    fs.writeFileSync(path.join(tempRoot, `${name}.webp`), buffer)
    return buffer
}

async function runRealStaticFixture(name, text, options = {}) {
    const buffer = await makeWebpFixture(name, text, options)
    const result = await ocr.scanStickerForToxicWords(null, {
        buffer,
        stickerMessage: { mimetype: "image/webp", isAnimated: false },
        toxicWords: WORDS,
        ignoreCache: true,
    })
    assert.equal(result.status, "toxic", `${name} must be toxic: ${JSON.stringify(result.rawTexts)}`)
    assert.equal(result.matchedWord, "tai", `${name} canonical word`)
    assert.equal(result.frames, 1, `${name} static frame count`)
    return result
}

async function makeAnimatedMiddleFrameFixture() {
    const sourcePath = path.join(
        __dirname,
        "..",
        "node_modules",
        "tesseract.js",
        "docs",
        "images",
        "demo.gif"
    )
    const metadata = await sharp(sourcePath, { animated: true, pages: -1 }).metadata()
    const pages = Math.min(5, Number(metadata.pages || 5))
    const pageHeight = Number(metadata.pageHeight || Math.floor(metadata.height / pages))
    const overlayHeight = pageHeight * pages
    const middlePage = Math.floor(pages / 2)
    const overlay = Buffer.from([
        `<svg width="${metadata.width}" height="${overlayHeight}" xmlns="http://www.w3.org/2000/svg">`,
        `<rect x="0" y="${pageHeight * middlePage}" width="${metadata.width}" height="${pageHeight}" fill="white"/>`,
        `<text x="${metadata.width / 2}" y="${pageHeight * middlePage + pageHeight * 0.72}" font-family="DejaVu Sans" font-size="${Math.floor(pageHeight * 0.62)}" font-weight="bold" text-anchor="middle" fill="black">TAI</text>`,
        "</svg>",
    ].join(""))
    const animated = await sharp(sourcePath, { animated: true, pages })
        .composite([{ input: overlay, top: 0, left: 0 }])
        .webp({ lossless: true, loop: 0, delay: Array(pages).fill(150) })
        .toBuffer()
    fs.writeFileSync(path.join(tempRoot, "animated-middle-tai.webp"), animated)
    return animated
}

function assertNormalization(raw, expectedMatch) {
    const candidates = ocr.normalizeOcrCandidates(raw)
    const match = ocr.matchOcrCandidatesAgainstWordlist(candidates, WORDS)
    assert.equal(match.matched, expectedMatch, `${raw} match result`)
    if (expectedMatch) assert.equal(match.word, "tai", `${raw} canonical word`)
    return candidates
}

async function scanWithMock(buffer, rawText, options = {}) {
    let calls = 0
    const result = await ocr.scanStickerForToxicWords(null, {
        buffer,
        stickerMessage: { mimetype: "image/webp", isAnimated: Boolean(options.animated) },
        toxicWords: options.toxicWords || WORDS,
        ignoreCache: options.ignoreCache !== false,
        recognizer: async () => {
            calls += 1
            return { text: rawText, confidence: options.confidence ?? 90 }
        },
        ...(options.scanOptions || {}),
    })
    return { result, calls }
}

async function run() {
    const initialHealth = ocr.getAntiToxicStickerOcrHealth({ toxicWords: WORDS })
    assert.equal(initialHealth.worker, "LAZY", "require must not initialize worker")
    assert.equal(initialHealth.cacheVersion, "anti-toxic-sticker-ocr-v5-restored")
    assert.equal(initialHealth.containsTai, true)

    for (const raw of ["TAI", "tai", "TaI", "TA1", "TAl", "T A I", "T.A.I", "T-A-I", "TA!", "TA|", "TÁI", "T\nA\nI"]) {
        const candidates = assertNormalization(raw, true)
        assert(candidates.includes("tai"), `${raw} must include tai candidate`)
    }
    for (const raw of ["SANTAI", "RANTAI", "PARTAI", "DETAIL", "TAIWAN", "TAILORED"]) {
        assertNormalization(raw, false)
    }

    const fixtureResults = []
    fixtureResults.push(await runRealStaticFixture("white-black", "TAI"))
    fixtureResults.push(await runRealStaticFixture("black-white", "TAI", { background: "black", fill: "white" }))
    fixtureResults.push(await runRealStaticFixture("small", "TAI", { size: 90 }))
    fixtureResults.push(await runRealStaticFixture("large", "TAI", { size: 280 }))
    fixtureResults.push(await runRealStaticFixture("rotated", "TAI", { rotate: 8 }))
    fixtureResults.push(await runRealStaticFixture("transparent", "TAI", { transparent: true }))
    fixtureResults.push(await runRealStaticFixture("outline", "TAI", { fill: "white", outline: true }))
    assert(fixtureResults.every(result => result.candidates <= 10), "candidate count must stay bounded")

    const normalizationFixtures = {
        spaced: "T A I",
        digit: "TA1",
        letter_l: "TAl",
        bang: "TA!",
    }
    for (const [name, raw] of Object.entries(normalizationFixtures)) {
        const buffer = await makeWebpFixture(name, raw)
        const { result } = await scanWithMock(buffer, raw)
        assert.equal(result.status, "toxic", `${name} mock OCR pipeline`)
        assert.equal(result.matchedWord, "tai", `${name} canonical match`)
    }

    const animated = await makeAnimatedMiddleFrameFixture()
    const animatedResult = await ocr.scanStickerForToxicWords(null, {
        buffer: animated,
        stickerMessage: { mimetype: "image/webp", isAnimated: true },
        toxicWords: WORDS,
        ignoreCache: true,
    })
    assert.equal(animatedResult.status, "toxic", `animated middle frame: ${JSON.stringify(animatedResult.rawTexts)}`)
    assert.equal(animatedResult.matchedWord, "tai")
    assert(animatedResult.frames >= 3 && animatedResult.frames <= 5, "animated frame sampling must be bounded and distributed")

    for (const cleanWord of ["SANTAI", "RANTAI", "PARTAI", "DETAIL"]) {
        const buffer = await makeWebpFixture(`clean-${cleanWord.toLowerCase()}`, cleanWord, { size: 100 })
        const result = await ocr.scanStickerForToxicWords(null, {
            buffer,
            stickerMessage: { mimetype: "image/webp", isAnimated: false },
            toxicWords: WORDS,
            ignoreCache: true,
        })
        assert.equal(result.status, "clean", `${cleanWord} must not match tai substring`)
    }

    const blank = await makeWebpFixture("blank", "")
    const blankResult = await scanWithMock(blank, "")
    assert.equal(blankResult.result.status, "clean", "sticker without text must be clean")
    assert.equal(blankResult.result.reason, "ocr_empty")

    const invalidResult = await ocr.scanStickerForToxicWords(null, {
        buffer: Buffer.from("not-an-image"),
        stickerMessage: { mimetype: "image/webp" },
        toxicWords: WORDS,
        ignoreCache: true,
    })
    assert.equal(invalidResult.status, "error", "invalid buffer must fail safely")
    assert(["conversion_failed", "ffmpeg_missing"].includes(invalidResult.reason), "invalid buffer error category")

    const tooLargeResult = await ocr.scanStickerForToxicWords(null, {
        buffer: Buffer.alloc(101),
        stickerMessage: { mimetype: "image/webp" },
        toxicWords: WORDS,
        ignoreCache: true,
        runtime: { maxBytes: 100 },
    })
    assert.equal(tooLargeResult.reason, "too_large", "oversized buffer must skip")

    const timeoutFrame = await sharp(svgFixture("TAI")).png().toBuffer()
    const timeoutResult = await ocr.scanStickerForToxicWords(null, {
        buffer: timeoutFrame,
        stickerMessage: { mimetype: "image/png" },
        toxicWords: WORDS,
        ignoreCache: true,
        frames: [{ buffer: timeoutFrame, frameIndex: 0, pageCount: 1 }],
        recognizer: () => new Promise(() => {}),
        runtime: { timeoutMs: 250, maxCandidates: 1 },
    })
    assert.equal(timeoutResult.status, "error", "timeout must fail safely")
    assert.equal(timeoutResult.reason, "ocr_timeout")

    ocr.clearAntiToxicStickerOcrCache()
    let wordlistCalls = 0
    const wordlistBuffer = await makeWebpFixture("wordlist-version", "TAI")
    const commonWordlistOptions = {
        buffer: wordlistBuffer,
        stickerMessage: { mimetype: "image/webp" },
        recognizer: async () => {
            wordlistCalls += 1
            return { text: "TAI", confidence: 90 }
        },
    }
    const oldClean = await ocr.scanStickerForToxicWords(null, {
        ...commonWordlistOptions,
        toxicWords: ["other"],
    })
    assert.equal(oldClean.status, "clean")
    const afterWordlistChange = await ocr.scanStickerForToxicWords(null, {
        ...commonWordlistOptions,
        toxicWords: WORDS,
    })
    assert.equal(afterWordlistChange.status, "toxic", "wordlist hash must invalidate old clean cache")

    ocr.clearAntiToxicStickerOcrCache()
    let cacheCalls = 0
    const cacheOptions = {
        buffer: wordlistBuffer,
        stickerMessage: { mimetype: "image/webp" },
        toxicWords: WORDS,
        recognizer: async () => {
            cacheCalls += 1
            return { text: "TAI", confidence: 90 }
        },
    }
    const firstToxic = await ocr.scanStickerForToxicWords(null, cacheOptions)
    const callsAfterFirst = cacheCalls
    const cachedToxic = await ocr.scanStickerForToxicWords(null, cacheOptions)
    assert.equal(firstToxic.status, "toxic")
    assert.equal(cachedToxic.status, "toxic")
    assert.equal(cachedToxic.cacheHit, true, "toxic cache must be reused")
    assert.equal(cacheCalls, callsAfterFirst, "cache hit must not repeat OCR")

    ocr.clearAntiToxicStickerOcrCache()
    let duplicateCalls = 0
    const duplicateOptions = {
        buffer: wordlistBuffer,
        stickerMessage: { mimetype: "image/webp" },
        toxicWords: WORDS,
        recognizer: async () => {
            duplicateCalls += 1
            await new Promise(resolve => setTimeout(resolve, 30))
            return { text: "TAI", confidence: 90 }
        },
    }
    const [duplicateA, duplicateB] = await Promise.all([
        ocr.scanStickerForToxicWords(null, duplicateOptions),
        ocr.scanStickerForToxicWords(null, duplicateOptions),
    ])
    assert.equal(duplicateA.status, "toxic")
    assert.equal(duplicateB.status, "toxic")
    assert.equal(Boolean(duplicateA.duplicate || duplicateB.duplicate), true, "concurrent duplicate must share work")
    assert.equal(duplicateCalls, 1, "concurrent duplicate must OCR once")

    const lowConfidence = await scanWithMock(wordlistBuffer, "TAl", { confidence: 10 })
    assert.equal(lowConfidence.result.status, "toxic", "low confidence must require repeated canonical vote")
    assert(lowConfidence.calls >= 2, "low confidence match must not accept first observation")

    const missingTaiHealth = ocr.getAntiToxicStickerOcrHealth({ toxicWords: ["other"] })
    const loadedTaiHealth = ocr.getAntiToxicStickerOcrHealth({ toxicWords: WORDS })
    assert.equal(missingTaiHealth.containsTai, false)
    assert.equal(loadedTaiHealth.containsTai, true)
    assert(loadedTaiHealth.cacheEntries <= loadedTaiHealth.cacheLimit)

    console.log(JSON.stringify({
        marker: "ANTI_TOXIC_STICKER_OCR_TESTS_OK",
        staticFixtures: fixtureResults.length,
        animatedFrames: animatedResult.frames,
        animatedResult: animatedResult.status,
        cacheVersion: loadedTaiHealth.cacheVersion,
    }))
}

run()
    .catch(error => {
        console.error(error)
        process.exitCode = 1
    })
    .finally(async () => {
        await ocr.disposeAntiToxicStickerOcr()
        const resolved = path.resolve(tempRoot)
        const base = path.resolve(os.tmpdir())
        if (resolved.startsWith(base + path.sep)) fs.rmSync(resolved, { recursive: true, force: true })
    })
