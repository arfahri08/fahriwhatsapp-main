"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vision = require("../modules/localNsfwVision");

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

test("NudeNet labels match 18 detector classes", () => {
    assert.strictEqual(vision.NUDENET_LABELS.length, 18);
    assert(vision.NUDENET_LABELS.includes("FEMALE_BREAST_EXPOSED"));
    assert(vision.NUDENET_LABELS.includes("MALE_GENITALIA_EXPOSED"));
});

test("parse transposed YOLOv8 output [1,22,N]", () => {
    const features = 4 + vision.NUDENET_LABELS.length;
    const rows = 2;
    const data = new Float32Array(features * rows);
    const set = (row, feature, value) => { data[(feature * rows) + row] = value; };
    set(0, 0, 160); set(0, 1, 160); set(0, 2, 100); set(0, 3, 120);
    set(0, 4 + vision.NUDENET_LABELS.indexOf("FEMALE_BREAST_EXPOSED"), 0.91);
    set(1, 0, 20); set(1, 1, 20); set(1, 2, 10); set(1, 3, 10);
    set(1, 4 + vision.NUDENET_LABELS.indexOf("FACE_MALE"), 0.95);
    const detections = vision.parseNudeNetOutput({ dims: [1, features, rows], data }, {
        modelSize: 320,
        paddedSize: 320,
        originalWidth: 320,
        originalHeight: 320,
    });
    assert.strictEqual(detections.length, 2);
    assert.strictEqual(detections[0].class, "FACE_MALE");
    assert.strictEqual(detections[1].class, "FEMALE_BREAST_EXPOSED");
});

test("explicit NudeNet class becomes violation", () => {
    const decision = vision.evaluateNudeNetDetections([
        { class: "FEMALE_GENITALIA_EXPOSED", classId: 4, score: 0.70, box: [1, 2, 30, 40] },
    ]);
    assert.strictEqual(decision.violation, true);
    assert.strictEqual(decision.category, "porn");
});

test("covered/non-explicit class stays clean", () => {
    const decision = vision.evaluateNudeNetDetections([
        { class: "FEMALE_GENITALIA_COVERED", classId: 0, score: 0.99, box: [1, 2, 30, 40] },
    ]);
    assert.strictEqual(decision.violation, false);
});

test("NMS removes overlapping same-class box", () => {
    const selected = vision.nonMaxSuppression([
        { classId: 3, score: 0.90, box: [0, 0, 100, 100] },
        { classId: 3, score: 0.80, box: [5, 5, 100, 100] },
        { classId: 4, score: 0.70, box: [5, 5, 100, 100] },
    ], 0.45);
    assert.strictEqual(selected.length, 2);
    assert.strictEqual(selected[0].score, 0.90);
});

test("frame sampling includes beginning and end", () => {
    assert.deepStrictEqual(vision.selectEvenFrameIndexes(75, 7), [0, 12, 25, 37, 49, 62, 74]);
});

test("softmax returns normalized probabilities", () => {
    const values = vision.softmax([0, 1]);
    assert(Math.abs(values.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert(values[1] > values[0]);
});

async function smokeModel() {
    if (!process.argv.includes("--smoke-model")) return;
    process.env.STICKER_VIT_NSFW_ENABLED = "false";
    const model = vision.NUDENET_MODEL_PATH;
    assert(fs.existsSync(model), `NudeNet model tidak ditemukan: ${model}`);
    assert(fs.statSync(model).size > 5 * 1024 * 1024, "NudeNet model terlalu kecil/rusak");
    const warmup = await vision.warmup();
    assert.strictEqual(warmup.nudeNet, "READY", JSON.stringify(warmup));
    const { PNG } = require("pngjs");
    const png = new PNG({ width: 320, height: 320 });
    png.data.fill(255);
    const blankFrame = PNG.sync.write(png);
    const inference = await vision.inspectNudeNetFrames([{ buffer: blankFrame, timestamp: 0 }], { maxFrames: 1 });
    assert.strictEqual(inference.available, true, inference.error || JSON.stringify(inference));
    assert.strictEqual(inference.frames.length, 1);
    console.log("ok - NudeNet ONNX WASM model loaded and inference executed");
    await vision.dispose();
}

smokeModel().catch(error => {
    console.error("not ok - NudeNet ONNX WASM model loaded");
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
