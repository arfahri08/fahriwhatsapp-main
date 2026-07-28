"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const localVision = require("../modules/localNsfwVision")
const ocr = require("../modules/antiToxicStickerOcr")
const stickerGuard = require("../modules/stickerSafetyGuard")

const root = path.join(__dirname, "..")
const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8")
const antiSource = fs.readFileSync(path.join(root, "modules", "antiToxic.js"), "utf8")
const localSource = fs.readFileSync(path.join(root, "modules", "localNsfwVision.js"), "utf8")

// Userbot messages typed manually in a group have fromMe=true and must still be moderated.
assert(indexSource.includes("isMe && (itemIsGroup || isAntiToxicWarnOwnerEnabled())"))
assert(indexSource.includes("isMe && (isGroup || isAntiToxicWarnOwnerEnabled())"))
assert(antiSource.includes("ANTI_TOXIC_WARN_OWNER_GROUP_MESSAGES"))
assert(antiSource.includes("shouldWarnOwnerMessage(msg)"))

// Weak animal-like NudeNet candidates no longer pass the low historical thresholds.
assert.strictEqual(localVision.evaluateNudeNetDetections([
    { class: "FEMALE_BREAST_EXPOSED", score: 0.30, frameIndex: 0 },
]).violation, false)
assert.strictEqual(localVision.evaluateNudeNetDetections([
    { class: "BUTTOCKS_EXPOSED", score: 0.35, frameIndex: 0 },
]).violation, false)

const repeated = localVision.evaluateNudeNetDetections([
    { class: "FEMALE_BREAST_EXPOSED", score: 0.55, frameIndex: 0 },
    { class: "FEMALE_BREAST_EXPOSED", score: 0.53, frameIndex: 1 },
])
assert.strictEqual(repeated.violation, true)
assert.strictEqual(repeated.frameHits, 2)
assert(localVision.NUDENET_STRONG_SINGLE_FRAME >= 0.70)
assert(localVision.NUDENET_VIT_CONFIRM_THRESHOLD >= 0.56)
assert(localSource.includes("nudenet-ambiguous-vetoed-by-vit"))
assert.strictEqual(stickerGuard.NSFW_PIPELINE_VERSION, "sticker-nsfw-v7-false-positive-guard")

// Every sampled frame receives multiple PSM strategies before the plan spends
// its whole budget on extra preprocessing variants.
const frames = [0, 1, 2, 3].map(frameIndex => ({ frameIndex, candidate: `frame-${frameIndex}` }))
const plan = ocr.getRecognitionPlan(frames, ["8", "7", "11", "12"], 16)
assert.strictEqual(plan.length, 16)
for (const frameIndex of [0, 1, 2, 3]) {
    const modes = plan.filter(item => item.candidate.frameIndex === frameIndex).map(item => item.psm)
    assert.deepStrictEqual(modes, ["8", "7", "11", "12"])
}
assert.strictEqual(ocr.PIPELINE_VERSION, "anti-toxic-sticker-ocr-v5.3-balanced-psm")

console.log("MODERATION RELIABILITY V1: PASS")
console.log("- fromMe/manual userbot messages in groups are moderated")
console.log("- weak cat/animal-like NSFW candidates are rejected")
console.log("- ambiguous nudity needs stronger or cross-model evidence")
console.log("- OCR rotates word/line/sparse modes across all sampled frames")
