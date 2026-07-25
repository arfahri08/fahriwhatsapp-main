"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const guard = require("../modules/stickerSafetyGuard");

async function inspectSample(filePath, expectedFrames) {
    const absolute = path.resolve(filePath);
    assert(fs.existsSync(absolute), `sample tidak ditemukan: ${absolute}`);
    const frameSet = await guard.extractStickerFrames(
        fs.readFileSync(absolute),
        { isAnimated: true },
        { maxFrames: 9 }
    );
    try {
        assert.strictEqual(frameSet.decoder, "imagemagick");
        assert.strictEqual(frameSet.sourceFrameCount, expectedFrames);
        assert(frameSet.frames.length > 0 && frameSet.frames.length <= 9);
        assert.strictEqual(frameSet.sampleIndices[0], 0);
        assert.strictEqual(frameSet.sampleIndices.at(-1), expectedFrames - 1);
        console.log(`ok - ${path.basename(absolute)}: ${expectedFrames} source frames -> ${frameSet.frames.length} samples`);
    } finally {
        await fs.promises.rm(frameSet.tempDir, { recursive: true, force: true });
    }
}

async function main() {
    const samples = process.argv.slice(2);
    if (samples.length === 0) {
        console.log("skip - berikan sample: node scripts/test-sticker-decoder.js <file:frames> ...");
        return;
    }
    for (const item of samples) {
        const match = /^(.*):(\d+)$/.exec(item);
        assert(match, `format sample salah: ${item}`);
        await inspectSample(match[1], Number(match[2]));
    }
}

main().catch(error => {
    console.error("not ok - sticker decoder");
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
