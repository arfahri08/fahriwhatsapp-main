"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const guard = require("../modules/stickerSafetyGuard");

const ROOT = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "modules", "stickerSafetyGuard.js"), "utf8");

function test(name, fn) {
    try {
        fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        console.error(`not ok - ${name}`);
        console.error(error.stack || error.message);
        process.exitCode = 1;
    }
}

const groupStickerMsg = {
    key: {
        remoteJid: "120363000000000000@g.us",
        participant: "6281111111111@s.whatsapp.net",
        id: "msg-1",
    },
    message: {
        stickerMessage: {
            isAnimated: false,
        },
    },
};

const privateStickerMsg = {
    key: {
        remoteJid: "6281111111111@s.whatsapp.net",
        id: "msg-2",
    },
    message: {
        stickerMessage: {
            isAnimated: false,
        },
    },
};

test("isStickerMessage static", () => {
    assert.strictEqual(guard.isStickerMessage(groupStickerMsg), true);
});

test("isStickerMessage animated", () => {
    assert.strictEqual(guard.isStickerMessage({ message: { stickerMessage: { isAnimated: true } } }), true);
});

test("normalize OCR text", () => {
    const normalized = guard.normalizeOcrText("  BABI!!!\nKauuu  ");
    assert.strictEqual(normalized.normalizedText, "babi kauu");
});

test("leetspeak normalization", () => {
    const normalized = guard.normalizeOcrText("b4b1 4nj1ng");
    assert.strictEqual(normalized.leetNormalizedText, "babi anjing");
});

test("word boundary matching", () => {
    const matches = guard.findStickerBadWords("dasar anjing", ["anjing"]);
    assert.strictEqual(matches.length, 1);
});

test("no false substring match", () => {
    const matches = guard.findStickerBadWords("basuki hadir", ["asu"]);
    assert.strictEqual(matches.length, 0);
});

test("NSFW score map neutral", () => {
    const result = guard.evaluateNsfwPredictions([{ frameIndex: 0, predictions: { Neutral: 0.99 } }], { isStatic: true });
    assert.strictEqual(result.violation, false);
});

test("porn hard threshold", () => {
    const result = guard.evaluateNsfwPredictions([{ frameIndex: 0, predictions: { Porn: 0.95 } }], { isStatic: true });
    assert.strictEqual(result.violation, true);
    assert.strictEqual(result.category, "porn");
});

test("hentai hard threshold", () => {
    const result = guard.evaluateNsfwPredictions([{ frameIndex: 0, predictions: { Hentai: 0.95 } }], { isStatic: true });
    assert.strictEqual(result.violation, true);
    assert.strictEqual(result.category, "hentai");
});

test("sexy low does not trigger", () => {
    const result = guard.evaluateNsfwPredictions([{ frameIndex: 0, predictions: { Sexy: 0.45 } }], { isStatic: true });
    assert.strictEqual(result.violation, false);
});

test("multi-frame consensus", () => {
    const result = guard.evaluateNsfwPredictions([
        { frameIndex: 0, predictions: { Porn: 0.8 } },
        { frameIndex: 1, predictions: { Porn: 0.78 } },
    ], { isStatic: false });
    assert.strictEqual(result.violation, true);
    assert.strictEqual(result.category, "porn");
});

test("SHA-256 cache code exists", () => {
    assert(source.includes("sha256(buffer)"));
    assert(source.includes("getCacheRecord(hash)"));
    assert(source.includes("setCacheRecord(hash"));
});

test("cache expiration code exists", () => {
    assert(source.includes("expiresAt"));
    assert(source.includes("pruneResultCache"));
});

test("queue limit code exists", () => {
    assert(source.includes("STICKER_SAFETY_QUEUE_MAX"));
    assert(source.includes("queue-full"));
});

test("OCR failure but NSFW continues", () => {
    assert(source.includes("inspectStickerText(frames"));
    assert(source.includes("inspectStickerNsfw(frames"));
    assert(source.includes("Promise.all"));
});

test("NSFW failure but OCR continues", () => {
    assert(source.includes("nsfwEnabled"));
    assert(source.includes("catch(error => ({"));
});

test("warning group mention", () => {
    const warning = guard.buildStickerTextWarning(groupStickerMsg, { ocr: { badWords: [{ masked: "a***g" }] } }, {
        senderJid: "6281111111111@s.whatsapp.net",
    });
    assert(warning.text.includes("@6281111111111"));
    assert.deepStrictEqual(warning.mentions, ["6281111111111@s.whatsapp.net"]);
});

test("private warning without mention", () => {
    const warning = guard.buildStickerNsfwWarning(privateStickerMsg, { nsfw: { category: "porn" } }, {
        senderJid: "6281111111111@s.whatsapp.net",
    });
    assert(!warning.mentions);
    assert(!warning.text.includes("@6281111111111"));
});

test("no group-name line", () => {
    const warning = guard.buildStickerNsfwWarning(groupStickerMsg, { nsfw: { category: "porn" } }, {
        senderJid: "6281111111111@s.whatsapp.net",
    });
    assert(!/grup:/i.test(warning.text));
    assert(!/nama grup/i.test(warning.text));
});

test("model/tensor disposal", () => {
    assert(source.includes("finally"));
    assert(source.includes("tensor.dispose"));
});


test("static porn uses normal threshold, not hard-only", () => {
    const result = guard.evaluateNsfwPredictions([
        { frameIndex: 0, region: "full", predictions: { Porn: 0.8, Hentai: 0.02, Sexy: 0.05 } },
    ], { isStatic: true });
    assert.strictEqual(result.violation, true);
    assert.strictEqual(result.category, "porn");
    assert.strictEqual(result.reason, "porn-static-threshold");
});

test("static hentai uses normal threshold", () => {
    const result = guard.evaluateNsfwPredictions([
        { frameIndex: 0, region: "full", predictions: { Porn: 0.02, Hentai: 0.8, Sexy: 0.05 } },
    ], { isStatic: true });
    assert.strictEqual(result.violation, true);
    assert.strictEqual(result.category, "hentai");
});

test("static nudity/sexy can trigger warning", () => {
    const result = guard.evaluateNsfwPredictions([
        { frameIndex: 0, region: "center", predictions: { Porn: 0.05, Hentai: 0.02, Sexy: 0.91 } },
    ], { isStatic: true });
    assert.strictEqual(result.violation, true);
    assert.strictEqual(result.category, "nudity");
});

test("combined porn and hentai evidence triggers", () => {
    const result = guard.evaluateNsfwPredictions([
        { frameIndex: 0, region: "center", predictions: { Porn: 0.44, Hentai: 0.41, Sexy: 0.04 } },
    ], { isStatic: true });
    assert.strictEqual(result.violation, true);
    assert.strictEqual(result.category, "explicit");
});

test("animated consensus counts distinct frames", () => {
    const result = guard.evaluateNsfwPredictions([
        { frameIndex: 0, region: "full", predictions: { Porn: 0.76 } },
        { frameIndex: 0, region: "center", predictions: { Porn: 0.78 } },
        { frameIndex: 1, region: "full", predictions: { Porn: 0.74 } },
    ], { isStatic: false });
    assert.strictEqual(result.violation, true);
    assert.strictEqual(result.category, "porn");
});

test("multiple crops of one animated frame do not fake temporal consensus", () => {
    const result = guard.evaluateNsfwPredictions([
        { frameIndex: 0, region: "full", predictions: { Porn: 0.71, Hentai: 0.01, Sexy: 0.02 } },
        { frameIndex: 0, region: "center", predictions: { Porn: 0.71, Hentai: 0.01, Sexy: 0.02 } },
        { frameIndex: 1, region: "full", predictions: { Porn: 0.05, Hentai: 0.01, Sexy: 0.02 } },
    ], { isStatic: false });
    assert.strictEqual(result.violation, false);
});

test("animated timestamps cover full duration", () => {
    assert.deepStrictEqual(guard.buildEvenSampleTimestamps(4, 5), [0, 0.99, 1.98, 2.97, 3.96]);
});

test("cache pipeline version invalidates old clean results", () => {
    assert.strictEqual(guard.NSFW_PIPELINE_VERSION, "sticker-nsfw-v7-false-positive-guard");
    assert(source.includes("`${NSFW_PIPELINE_VERSION}:${hash}`"));
});

test("bundled named NSFW model is loaded", () => {
    assert(source.includes("nsfwRuntime.load(config.nsfwModelName)"));
    assert(!source.includes("nsfwRuntime.load(undefined"));
});

test("NSFW scan uses evenly distributed animated sampling", () => {
    assert(source.includes("buildEvenSampleTimestamps"));
    assert(source.includes("probeMediaDuration"));
    assert(source.includes("extractFrameAtTimestamp"));
});

test("NSFW scan has crop-region second pass", () => {
    assert(source.includes("buildNsfwRegions"));
    assert(source.includes("regionScans"));
    assert(source.includes("rankSuspiciousFrames"));
});


test("ImageMagick is primary animated decoder", () => {
    assert(source.includes("extractFramesWithImageMagick"));
    assert(source.includes("-coalesce"));
    assert(source.indexOf("extractFramesWithImageMagick") < source.indexOf("extractFramesWithFfmpeg"));
});

test("local ONNX vision is integrated", () => {
    assert(source.includes('require("./localNsfwVision")'));
    assert(source.includes("inspectFrames(frames"));
    assert(source.includes("sticker-nsfw-v7-false-positive-guard"));
});

test("indeterminate result is not cached", () => {
    assert(source.includes("if (!result.indeterminate) setCacheRecord"));
    assert(source.includes("all-nsfw-engines-unavailable"));
});

test("fromMe sticker scanning stays enabled", () => {
    assert(!source.includes('if (msg?.key?.fromMe) return { inspected: false, reason: "from-me" }'));
    assert(source.includes("scanFromMe"));
});


test("automatic scans use fast background mode", () => {
    const indexSource = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
    assert(indexSource.includes("stickerSafetyGuardBackground"));
    assert(indexSource.includes("fastMode: true"));
    assert(indexSource.includes("if (isStickerMediaMessage) return"));
});

test("automatic sticker OCR duplicate is off by default", () => {
    const source = fs.readFileSync(path.join(ROOT, "modules", "stickerSafetyGuard.js"), "utf8");
    assert(source.includes("STICKER_SAFETY_AUTO_TEXT_OCR, false"));
    assert(source.includes("!fastMode || runtime.autoTextOcr"));
});

test("fast local vision can skip NSFWJS fallback", () => {
    const source = fs.readFileSync(path.join(ROOT, "modules", "stickerSafetyGuard.js"), "utf8");
    assert(source.includes("local-vision-fast-clean"));
    assert(source.includes("STICKER_SAFETY_AUTO_NSFWJS_FALLBACK, false"));
});
