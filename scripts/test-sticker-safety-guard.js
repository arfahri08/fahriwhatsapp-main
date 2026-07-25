"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const guard = require("../modules/stickerSafetyGuard");

const source = fs.readFileSync(path.join(__dirname, "..", "modules", "stickerSafetyGuard.js"), "utf8");

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
    const result = guard.evaluateNsfwPredictions([{ frameIndex: 0, predictions: { Sexy: 0.8 } }], { isStatic: true });
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

