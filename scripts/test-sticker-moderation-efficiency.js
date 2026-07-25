"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ocr = require("../modules/antiToxicStickerOcr");

const ROOT = path.join(__dirname, "..");

function ok(name) {
    console.log(`ok - ${name}`);
}

async function main() {
    const indexSource = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
    const ocrSource = fs.readFileSync(path.join(ROOT, "modules", "antiToxicStickerOcr.js"), "utf8");

    assert(indexSource.includes("stickerSafetyGuardBackground"));
    assert(indexSource.includes("antiToxicStickerBackground"));
    assert(indexSource.includes("if (isStickerMediaMessage) return"));
    ok("sticker moderation no longer blocks main router");

    assert(ocrSource.includes("extractFramesWithImageMagick"));
    assert(ocrSource.includes("animatedFfmpegFallback"));
    assert(ocrSource.includes("ANTI_TOXIC_STICKER_OCR_ANIMATED_FFMPEG_FALLBACK, false"));
    ok("animated OCR uses ImageMagick and avoids broken FFmpeg fallback by default");

    assert.strictEqual(ocr.PIPELINE_VERSION, "anti-toxic-sticker-ocr-v4-fast");
    ok("OCR cache pipeline version changed");

    const samples = process.argv.slice(2).filter(file => fs.existsSync(file));
    for (const file of samples) {
        const result = await ocr.extractAnimatedStickerFrames(
            fs.readFileSync(file),
            { isAnimated: true },
            { disableSharp: true, maxFrames: 3, imageMagickTimeoutMs: 30000 }
        );
        assert.strictEqual(result.source, "imagemagick");
        assert(result.frames.length >= 1 && result.frames.length <= 3);
        assert(result.frames[0].pageCount >= result.frames.length);
        ok(`ImageMagick decoded ${path.basename(file)}: ${result.frames.length}/${result.frames[0].pageCount} sampled frames`);
    }
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
