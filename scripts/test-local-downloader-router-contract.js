const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..");
const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8");

assert(indexSource.includes('require.resolve("./modules/localDownloader.js")'), "index harus resolve explicit localDownloader.js");
assert(indexSource.includes("function resolveLocalDownloaderHandler()"), "resolver export downloader hilang");
assert(indexSource.includes("delete require.cache[localDownloaderModulePath]"), "stale module reload guard hilang");
assert(indexSource.includes("getLocalDownloaderExportDiagnostic"), "diagnostic export downloader hilang");
assert(!indexSource.includes("() => localDownloader.handleLocalDownload(sock, from, text"), "router masih memanggil property langsung");
assert(indexSource.includes("() => localDownloadHandler(sock, from, text"), "router tidak memakai resolved handler");

const mod = require(path.join(root, "modules", "localDownloader.js"));
assert.strictEqual(typeof mod.handleLocalDownload, "function", "localDownloader.js harus export handleLocalDownload function");
assert.strictEqual(mod.detectPlatform("https://www.instagram.com/p/ABC123/"), "instagram", "Instagram harus masuk local downloader");
assert.strictEqual(mod.detectPlatform("https://www.facebook.com/reel/123456/"), "facebook", "Facebook harus masuk local downloader");

const extended = require(path.join(root, "modules", "extendedDownloader.js"));
assert.strictEqual(typeof extended.handleExtendedDownload, "function", "extended downloader export hilang");

console.log("PASS test-local-downloader-router-contract");
