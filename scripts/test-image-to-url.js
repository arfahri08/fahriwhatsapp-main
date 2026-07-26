"use strict"

const assert = require("assert")
const imageToUrl = require("../modules/imageToUrl")

assert.strictEqual(
    imageToUrl.normalizeAceImgUrl("https://cdn.aceimg.com/abc12345.jpg"),
    "https://cdn.aceimg.com/abc12345.jpg"
)
assert.strictEqual(
    imageToUrl.normalizeAceImgUrl("https://aceimg.com/upload/?f=abc12345.png"),
    "https://cdn.aceimg.com/abc12345.png"
)
assert.strictEqual(
    imageToUrl.extractAceImgUrl({ data: { url: "https://cdn.aceimg.com/xyz98765.webp" } }),
    "https://cdn.aceimg.com/xyz98765.webp"
)
assert.strictEqual(
    imageToUrl.extractAceImgUrl({ success: true, filename: "file7788.mp4" }),
    "https://cdn.aceimg.com/file7788.mp4"
)
assert.strictEqual(
    imageToUrl.extractAceImgUrl({ result: { path: "nested123.jpg" } }),
    "https://cdn.aceimg.com/nested123.jpg"
)
assert.ok(imageToUrl.buildAceImgEndpoints().includes("https://aceimg.com/api/upload"))

console.log("PASS test-image-to-url")
