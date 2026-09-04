"use strict"

const assert = require("assert")
const web = require("../modules/webToZip")

async function assertRejectsIp(url) {
    await assert.rejects(() => web.validateTargetUrl(url, async () => [{ address: "8.8.8.8", family: 4 }]), /private|metadata/i)
}

async function run() {
    for (const url of [
        "http://localhost", "http://127.0.0.1", "http://10.1.2.3", "http://172.16.0.1", "http://172.31.255.255",
        "http://192.168.1.1", "http://169.254.169.254", "http://[::1]", "http://[fc00::1]", "http://[fd12::1]", "http://[fe80::1]",
    ]) await assertRejectsIp(url)
    for (const scheme of ["file:///etc/passwd", "ftp://example.com", "data:text/plain,x", "javascript:alert(1)"]) {
        await assert.rejects(() => web.validateTargetUrl(scheme), /http|URL/i)
    }

    let fetches = 0
    await assert.rejects(() => web.safeFetch("https://public.example", {
        resolver: async hostname => [{ address: hostname === "public.example" ? "8.8.8.8" : "10.0.0.1", family: 4 }],
        fetchOnce: async () => {
            fetches += 1
            return { redirect: "http://internal.example/secret", headers: {}, body: Buffer.alloc(0) }
        },
    }), /private|metadata/i, "redirect public ke private wajib ditolak")
    assert.strictEqual(fetches, 1)

    const resolver = async () => [{ address: "8.8.8.8", family: 4 }]
    const tooMany = web.createWebToZipService({
        resolver,
        maxAssets: 1,
        fetchOnce: async validation => ({ headers: { "content-type": "text/html" }, body: Buffer.from('<img src="/a.png"><script src="/b.js"></script>') }),
    })
    await assert.rejects(() => tooMany.snapshotToZip("https://example.com"), /Asset count/)

    const sizeLimited = web.createWebToZipService({
        resolver,
        maxTotalBytes: 100,
        maxAssetBytes: 100,
        fetchOnce: async validation => validation.url.pathname === "/"
            ? { headers: { "content-type": "text/html" }, body: Buffer.from(`<img src="/large.png">${"x".repeat(60)}`) }
            : { headers: { "content-type": "image/png" }, body: Buffer.alloc(80) },
    })
    await assert.rejects(() => sizeLimited.snapshotToZip("https://example.com/"), /Total snapshot|batas/)

    const timeoutService = web.createWebToZipService({ resolver, timeoutMs: 5, fetchOnce: async () => { throw new Error("Request timeout") } })
    await assert.rejects(() => timeoutService.snapshotToZip("https://example.com"), /timeout/)

    const okay = web.createWebToZipService({
        resolver,
        fetchOnce: async validation => validation.url.pathname === "/"
            ? { headers: { "content-type": "text/html" }, body: Buffer.from('<html><img src="/a.png"></html>') }
            : { headers: { "content-type": "image/png" }, body: Buffer.from("PNG") },
    })
    const result = await okay.snapshotToZip("https://example.com/")
    assert.strictEqual(result.zip.readUInt32LE(0), 0x04034b50)
    assert.strictEqual(result.assetCount, 1)
    console.log("PASS test-web-to-zip-security")
}

run().catch(error => { console.error(error); process.exitCode = 1 })
