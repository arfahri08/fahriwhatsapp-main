"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")
const dns = require("dns")
const net = require("net")
const http = require("http")
const https = require("https")
const crypto = require("crypto")

const MAX_TOTAL_BYTES = 25 * 1024 * 1024
const MAX_ASSET_BYTES = 10 * 1024 * 1024
const MAX_ASSETS = 100
const MAX_REDIRECTS = 3
const REQUEST_TIMEOUT_MS = 12_000
const MAX_PENDING_JOBS = 5

let activeJobs = 0
const pendingJobs = []

function ipv4Parts(value) {
    const parts = String(value || "").split(".").map(Number)
    return parts.length === 4 && parts.every(item => Number.isInteger(item) && item >= 0 && item <= 255) ? parts : null
}

function expandIpv6(value) {
    let input = String(value || "").toLowerCase().split("%")[0]
    if (!input || net.isIP(input) !== 6) return null
    const mapped = input.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) {
        const parts = ipv4Parts(mapped[2])
        if (!parts) return null
        input = `${mapped[1]}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`
    }
    const halves = input.split("::")
    if (halves.length > 2) return null
    const left = halves[0] ? halves[0].split(":") : []
    const right = halves[1] ? halves[1].split(":") : []
    const missing = 8 - left.length - right.length
    const groups = halves.length === 2 ? [...left, ...Array(Math.max(0, missing)).fill("0"), ...right] : left
    if (groups.length !== 8) return null
    return groups.map(group => Number.parseInt(group || "0", 16))
}

function isPrivateIp(address) {
    const value = String(address || "").trim().toLowerCase().split("%")[0]
    if (net.isIP(value) === 4) {
        const parts = ipv4Parts(value)
        if (!parts) return true
        const [a, b, c] = parts
        return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
            || (a === 203 && b === 0 && c === 113)
            || a >= 224 || value === "100.100.100.200"
    }
    if (net.isIP(value) === 6) {
        const groups = expandIpv6(value)
        if (!groups) return true
        if (groups.every(item => item === 0) || groups.slice(0, 7).every(item => item === 0) && groups[7] === 1) return true
        if ((groups[0] & 0xfe00) === 0xfc00) return true // fc00::/7
        if ((groups[0] & 0xffc0) === 0xfe80) return true // fe80::/10
        if (groups[0] === 0xff00 || (groups[0] & 0xff00) === 0xff00) return true
        if (groups.slice(0, 5).every(item => item === 0) && groups[5] === 0xffff) {
            const mapped = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`
            return isPrivateIp(mapped)
        }
        return false
    }
    return true
}

async function defaultResolver(hostname) {
    return dns.promises.lookup(hostname, { all: true, verbatim: true })
}

async function validateTargetUrl(input, resolver = defaultResolver) {
    let url
    try { url = input instanceof URL ? new URL(input.href) : new URL(String(input || "")) } catch { throw new Error("URL tidak valid") }
    if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Hanya URL http/https yang diizinkan")
    if (url.username || url.password) throw new Error("URL dengan credential tidak diizinkan")
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "metadata.google.internal") throw new Error("Hostname private/metadata ditolak")
    let records
    if (net.isIP(hostname)) records = [{ address: hostname, family: net.isIP(hostname) }]
    else records = await resolver(hostname)
    const normalized = (Array.isArray(records) ? records : [records]).map(item => typeof item === "string" ? { address: item, family: net.isIP(item) } : item).filter(item => item?.address)
    if (!normalized.length) throw new Error("DNS tidak menghasilkan alamat")
    if (normalized.some(item => isPrivateIp(item.address))) throw new Error("Target DNS mengarah ke IP private/metadata")
    return { url, addresses: normalized }
}

function pinnedLookup(record) {
    return (_hostname, options, callback) => {
        const family = Number(record.family || net.isIP(record.address))
        if (options?.all) callback(null, [{ address: record.address, family }])
        else callback(null, record.address, family)
    }
}

function fetchOnce(validation, options = {}) {
    const url = validation.url
    const maxBytes = Number(options.maxBytes || MAX_ASSET_BYTES)
    const timeoutMs = Number(options.timeoutMs || REQUEST_TIMEOUT_MS)
    const transport = url.protocol === "https:" ? https : http
    const record = validation.addresses[0]
    return new Promise((resolve, reject) => {
        const request = transport.request(url, {
            method: "GET",
            headers: { "user-agent": "UserbotWebSnapshot/1.0", accept: "text/html,text/css,application/javascript,image/*,*/*;q=0.2" },
            lookup: pinnedLookup(record),
            servername: url.hostname,
            agent: false,
        }, response => {
            const status = Number(response.statusCode || 0)
            const location = response.headers.location
            if (status >= 300 && status < 400 && location) {
                response.resume()
                resolve({ status, headers: response.headers, redirect: new URL(location, url).href, body: Buffer.alloc(0) })
                return
            }
            if (status < 200 || status >= 300) {
                response.resume()
                reject(new Error(`HTTP ${status}`))
                return
            }
            const contentLength = Number(response.headers["content-length"] || 0)
            if (contentLength > maxBytes) {
                response.destroy(new Error("Response melebihi batas ukuran"))
                return
            }
            const chunks = []
            let bytes = 0
            response.on("data", chunk => {
                bytes += chunk.length
                if (bytes > maxBytes) response.destroy(new Error("Response melebihi batas ukuran"))
                else chunks.push(chunk)
            })
            response.on("end", () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks) }))
            response.on("error", reject)
        })
        request.setTimeout(timeoutMs, () => request.destroy(new Error("Request timeout")))
        request.on("error", reject)
        request.end()
    })
}

async function safeFetch(input, options = {}) {
    const resolver = options.resolver || defaultResolver
    const requestOnce = options.fetchOnce || fetchOnce
    let current = String(input || "")
    for (let redirects = 0; redirects <= Number(options.maxRedirects ?? MAX_REDIRECTS); redirects += 1) {
        const validation = await validateTargetUrl(current, resolver)
        const response = await requestOnce(validation, options)
        if (!response.redirect) return { ...response, finalUrl: validation.url.href }
        if (redirects >= Number(options.maxRedirects ?? MAX_REDIRECTS)) throw new Error("Redirect melebihi batas")
        current = response.redirect
    }
    throw new Error("Redirect melebihi batas")
}

function crc32(buffer) {
    let crc = 0xffffffff
    for (const byte of buffer) {
        crc ^= byte
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear())
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    }
}

function createZip(entries = []) {
    const locals = []
    const centrals = []
    let offset = 0
    const stamp = dosDateTime()
    for (const entry of entries) {
        const name = Buffer.from(String(entry.name || "file.bin").replace(/\\/g, "/"), "utf8")
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || "")
        const checksum = crc32(data)
        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6)
        local.writeUInt16LE(0, 8); local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12)
        local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22)
        local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28)
        locals.push(local, name, data)
        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8)
        central.writeUInt16LE(0, 10); central.writeUInt16LE(stamp.time, 12); central.writeUInt16LE(stamp.date, 14)
        central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24)
        central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42)
        centrals.push(central, name)
        offset += local.length + name.length + data.length
    }
    const centralData = Buffer.concat(centrals)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16)
    return Buffer.concat([...locals, centralData, end])
}

function safeAssetName(assetUrl, index) {
    const url = new URL(assetUrl)
    const raw = decodeURIComponent(url.pathname.split("/").pop() || `asset-${index}`).replace(/[^a-z0-9._-]/gi, "_").slice(-80)
    const digest = crypto.createHash("sha1").update(assetUrl).digest("hex").slice(0, 10)
    return `assets/${String(index + 1).padStart(3, "0")}-${digest}-${raw || "asset.bin"}`
}

function collectAssetReferences(html, pageUrl) {
    const found = []
    const regex = /(<(?:link|script|img)\b[^>]*?\b(?:href|src)\s*=\s*)(["'])([^"'#]+)\2/gi
    let match
    while ((match = regex.exec(html))) {
        try {
            const url = new URL(match[3], pageUrl)
            if (!new Set(["http:", "https:"]).has(url.protocol)) continue
            found.push({ original: match[3], url: url.href })
        } catch {}
    }
    const seen = new Set()
    return found.filter(item => !seen.has(item.url) && seen.add(item.url))
}

function createWebToZipService(options = {}) {
    const limits = {
        maxTotalBytes: Number(options.maxTotalBytes || MAX_TOTAL_BYTES),
        maxAssetBytes: Number(options.maxAssetBytes || MAX_ASSET_BYTES),
        maxAssets: Number(options.maxAssets || MAX_ASSETS),
        maxRedirects: Number(options.maxRedirects ?? MAX_REDIRECTS),
        timeoutMs: Number(options.timeoutMs || REQUEST_TIMEOUT_MS),
    }
    const fetchOptions = { resolver: options.resolver, fetchOnce: options.fetchOnce, maxRedirects: limits.maxRedirects, timeoutMs: limits.timeoutMs }
    return {
        limits,
        async snapshotToZip(inputUrl) {
            const page = await safeFetch(inputUrl, { ...fetchOptions, maxBytes: Math.min(limits.maxAssetBytes, limits.maxTotalBytes) })
            let totalBytes = page.body.length
            if (totalBytes > limits.maxTotalBytes) throw new Error("HTML melebihi batas total")
            const contentType = String(page.headers?.["content-type"] || "")
            if (!/text\/html|application\/xhtml/i.test(contentType) && !/^\s*</.test(page.body.toString("utf8", 0, 100))) throw new Error("Target bukan dokumen HTML")
            const pageUrl = new URL(page.finalUrl)
            let html = page.body.toString("utf8")
            const references = collectAssetReferences(html, pageUrl)
                .filter(item => new URL(item.url).origin === pageUrl.origin)
            if (references.length > limits.maxAssets) throw new Error(`Asset count melebihi ${limits.maxAssets}`)
            const entries = []
            for (let index = 0; index < references.length; index += 1) {
                const reference = references[index]
                const remaining = limits.maxTotalBytes - totalBytes
                if (remaining <= 0) throw new Error("Total snapshot melebihi batas")
                const asset = await safeFetch(reference.url, { ...fetchOptions, maxBytes: Math.min(limits.maxAssetBytes, remaining) })
                if (new URL(asset.finalUrl).origin !== pageUrl.origin) throw new Error("Redirect asset keluar dari same-origin")
                totalBytes += asset.body.length
                if (totalBytes > limits.maxTotalBytes) throw new Error("Total snapshot melebihi batas")
                const localName = safeAssetName(asset.finalUrl, index)
                entries.push({ name: localName, data: asset.body })
                html = html.split(reference.original).join(localName)
            }
            const notice = "Static snapshot only. Server-side/backend functionality, login, forms, and JavaScript execution are not included.\n"
            entries.unshift({ name: "index.html", data: Buffer.from(html, "utf8") }, { name: "SNAPSHOT-NOTICE.txt", data: Buffer.from(notice, "utf8") })
            return { zip: createZip(entries), assetCount: entries.length - 2, totalBytes, finalUrl: page.finalUrl }
        },
    }
}

function enqueueJob(task) {
    if (activeJobs + pendingJobs.length >= MAX_PENDING_JOBS + 1) return Promise.reject(new Error("Antrean web2zip penuh"))
    return new Promise((resolve, reject) => {
        pendingJobs.push({ task, resolve, reject })
        void drainJobs()
    })
}

async function drainJobs() {
    if (activeJobs >= 1) return
    const item = pendingJobs.shift()
    if (!item) return
    activeJobs += 1
    try { item.resolve(await item.task()) } catch (error) { item.reject(error) }
    finally { activeJobs -= 1; void drainJobs() }
}

const defaultService = createWebToZipService()

async function handleWebToZip(sock, msg, context = {}) {
    const match = /^\.web2zip(?:\s+([^\s]+))?$/i.exec(String(context.text || "").trim())
    if (!match) return false
    if (context.isGroup) return true
    if (!match[1]) {
        await sock.sendMessage(context.from, { text: "Format: .web2zip https://example.com" }, { quoted: msg })
        return true
    }
    let tempDir = ""
    try {
        const result = await enqueueJob(() => defaultService.snapshotToZip(match[1]))
        tempDir = fs.mkdtempSync(path.join(path.resolve(context.tempDir || os.tmpdir()), "wa-web2zip-"))
        const file = path.join(tempDir, "static-snapshot.zip")
        fs.writeFileSync(file, result.zip, { mode: 0o600 })
        await sock.sendMessage(context.from, {
            document: fs.readFileSync(file),
            mimetype: "application/zip",
            fileName: "static-snapshot.zip",
            caption: `Static snapshot; server-side/backend functionality tidak termasuk.\nAsset: ${result.assetCount}; bytes source: ${result.totalBytes}.`,
        }, { quoted: msg })
    } catch (error) {
        await sock.sendMessage(context.from, { text: `Web-to-ZIP ditolak/gagal: ${String(error?.message || error).slice(0, 220)}` }, { quoted: msg })
    } finally {
        if (tempDir) {
            const resolved = path.resolve(tempDir)
            const base = path.resolve(context.tempDir || os.tmpdir())
            if (resolved.startsWith(`${base}${path.sep}`) && path.basename(resolved).startsWith("wa-web2zip-")) {
                try { fs.rmSync(resolved, { recursive: true, force: false }) } catch {}
            }
        }
    }
    return true
}

module.exports = {
    MAX_ASSETS,
    MAX_ASSET_BYTES,
    MAX_REDIRECTS,
    MAX_TOTAL_BYTES,
    REQUEST_TIMEOUT_MS,
    collectAssetReferences,
    createWebToZipService,
    createZip,
    fetchOnce,
    handleWebToZip,
    isPrivateIp,
    safeFetch,
    validateTargetUrl,
}
