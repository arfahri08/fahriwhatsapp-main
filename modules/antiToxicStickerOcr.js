"use strict"

const crypto = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFile, spawnSync } = require("child_process")

const PIPELINE_VERSION = "anti-toxic-sticker-ocr-v3"
const resultCache = new Map()
const inFlightScans = new Map()
const scanQueue = []

let activeScans = 0
let debugOverride = null
let sharpModule = null
let sharpLoadAttempted = false
let sharpLoadError = ""
let tesseractModule = null
let tesseractLoadAttempted = false
let tesseractLoadError = ""
let worker = null
let workerPromise = null
let workerResetPromise = null
let workerStatus = "LAZY"
let workerError = ""
let ffmpegProbe = null
let tesseractCliProbe = null
let pngjsModule = null
let pngjsLoadAttempted = false
let pngjsLoadError = ""
let lastScan = {
    time: null,
    result: "belum ada",
    durationMs: null,
    error: "",
}

function parseBool(value, fallback = false) {
    if (value == null || value === "") return fallback
    const clean = String(value).trim().toLowerCase()
    if (["1", "true", "yes", "on", "enabled", "aktif"].includes(clean)) return true
    if (["0", "false", "no", "off", "disabled", "mati"].includes(clean)) return false
    return fallback
}

function parsePositiveInt(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback
    return Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
}

function getRuntimeConfig() {
    return {
        enabled: parseBool(process.env.ANTI_TOXIC_STICKER_OCR, true),
        debug: debugOverride == null
            ? parseBool(process.env.ANTI_TOXIC_STICKER_OCR_DEBUG, false)
            : debugOverride,
        maxBytes: parsePositiveInt(process.env.ANTI_TOXIC_STICKER_OCR_MAX_BYTES, 3 * 1024 * 1024, 1024),
        maxCandidates: parsePositiveInt(process.env.ANTI_TOXIC_STICKER_OCR_MAX_CANDIDATES, 12, 8, 24),
        maxFrames: parsePositiveInt(process.env.ANTI_TOXIC_STICKER_OCR_MAX_FRAMES, 5, 1, 8),
        timeoutMs: parsePositiveInt(process.env.ANTI_TOXIC_STICKER_OCR_TIMEOUT_MS, 45000, 30000, 120000),
        cacheLimit: parsePositiveInt(process.env.ANTI_TOXIC_STICKER_OCR_CACHE_LIMIT, 300, 1, 2000),
        cacheTtlMs: parsePositiveInt(process.env.ANTI_TOXIC_STICKER_OCR_CACHE_TTL_MS, 24 * 60 * 60 * 1000, 1000),
        errorCacheTtlMs: parsePositiveInt(process.env.ANTI_TOXIC_STICKER_OCR_ERROR_CACHE_TTL_MS, 60 * 1000, 1000),
        queueMax: parsePositiveInt(process.env.ANTI_TOXIC_STICKER_OCR_QUEUE_MAX, 4, 1, 20),
        concurrency: 1,
        ffmpegBin: String(process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg").trim() || "ffmpeg",
        ffprobeBin: String(process.env.FFPROBE_BIN || "ffprobe").trim() || "ffprobe",
        mediumConfidence: parsePositiveInt(process.env.ANTI_TOXIC_STICKER_OCR_MEDIUM_CONFIDENCE, 25, 1, 100),
        exactShortConfidence: parsePositiveInt(process.env.ANTI_TOXIC_STICKER_OCR_EXACT_SHORT_CONFIDENCE, 10, 0, 100),
        maxPasses: parsePositiveInt(process.env.ANTI_TOXIC_STICKER_OCR_MAX_PASSES, 14, 1, 40),
        pngjsEnabled: parseBool(process.env.ANTI_TOXIC_STICKER_OCR_PNGJS, true),
        cliEnabled: parseBool(process.env.ANTI_TOXIC_STICKER_OCR_CLI_FALLBACK, true),
        tesseractBin: String(process.env.TESSERACT_BIN || "tesseract").trim() || "tesseract",
        cliTimeoutMs: parsePositiveInt(process.env.ANTI_TOXIC_STICKER_OCR_CLI_TIMEOUT_MS, 12000, 1000, 60000),
    }
}

function shortError(error) {
    return String(error?.message || error || "unknown").replace(/\s+/g, " ").trim().slice(0, 300)
}

function makeOcrError(code, message) {
    const error = new Error(message || code)
    error.code = code
    return error
}

function isAntiToxicStickerOcrEnabled() {
    return getRuntimeConfig().enabled
}

function isDebugEnabled() {
    return getRuntimeConfig().debug
}

function debugLog(message, details = {}) {
    if (!isDebugEnabled()) return
    const safe = []
    for (const [key, value] of Object.entries(details)) {
        if (value == null || value === "") continue
        safe.push(`${key}=${String(value).replace(/\s+/g, " ").slice(0, 120)}`)
    }
    console.log(`[ANTI TOXIC OCR] ${message}${safe.length ? ` ${safe.join(" ")}` : ""}`)
}

function logFailure(error) {
    console.log(`[ANTI TOXIC OCR] Failed: ${shortError(error)}`)
}

function unwrapMessage(message) {
    let current = message || {}
    for (let index = 0; index < 8; index += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message
        else break
    }
    return current || {}
}

function extractStickerMessage(msgOrMessage) {
    const message = msgOrMessage?.message || msgOrMessage || {}
    return unwrapMessage(message).stickerMessage || null
}

function getContextInfo(message) {
    const current = unwrapMessage(message || {})
    return current.extendedTextMessage?.contextInfo
        || current.imageMessage?.contextInfo
        || current.videoMessage?.contextInfo
        || current.documentMessage?.contextInfo
        || current.stickerMessage?.contextInfo
        || null
}

function getQuotedStickerMessage(msg) {
    const contextInfo = getContextInfo(msg?.message)
    const quotedMessage = contextInfo?.quotedMessage
    const stickerMessage = extractStickerMessage(quotedMessage)
    if (!quotedMessage || !stickerMessage) return null
    return {
        key: {
            remoteJid: msg?.key?.remoteJid,
            id: contextInfo?.stanzaId || `ocr-test-${Date.now()}`,
            participant: contextInfo?.participant || msg?.key?.participant,
            fromMe: false,
        },
        message: quotedMessage,
        stickerMessage,
    }
}

function normalizeDownloadableMedia(media) {
    if (!media || typeof media !== "object") return media
    const normalized = { ...media }
    if (normalized.mediaKey && normalized.directPath) delete normalized.url
    return normalized
}

async function downloadStickerBuffer(stickerMessage, options = {}) {
    if (Buffer.isBuffer(options.buffer)) return options.buffer
    if (!stickerMessage) throw makeOcrError("unsupported_media", "stickerMessage tidak ditemukan")

    const mime = String(stickerMessage.mimetype || "image/webp").toLowerCase()
    if (mime && !/^image\/(webp|png|jpe?g|gif)$/.test(mime)) {
        throw makeOcrError("unsupported_media", `MIME sticker tidak didukung: ${mime}`)
    }

    let downloader = options.downloadContentFromMessage
    if (typeof downloader !== "function") {
        try {
            ({ downloadContentFromMessage: downloader } = require("@whiskeysockets/baileys"))
        } catch (error) {
            throw makeOcrError("download_failed", shortError(error))
        }
    }

    const stream = await downloader(normalizeDownloadableMedia(stickerMessage), "sticker")
    const chunks = []
    let totalBytes = 0
    const maxBytes = Number(options.maxBytes || getRuntimeConfig().maxBytes)
    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        totalBytes += buffer.length
        if (totalBytes > maxBytes) throw makeOcrError("too_large", `sticker melebihi ${maxBytes} bytes`)
        chunks.push(buffer)
    }
    if (!chunks.length) throw makeOcrError("download_failed", "buffer sticker kosong")
    return Buffer.concat(chunks, totalBytes)
}

function getSharp(options = {}) {
    if (options.sharp) return options.sharp
    if (sharpLoadAttempted) return sharpModule
    sharpLoadAttempted = true
    try {
        sharpModule = require("sharp")
        sharpLoadError = ""
    } catch (error) {
        sharpModule = null
        sharpLoadError = shortError(error)
    }
    return sharpModule
}


function getPngJs() {
    if (pngjsLoadAttempted) return pngjsModule
    pngjsLoadAttempted = true
    try {
        pngjsModule = require("pngjs")
        pngjsLoadError = ""
    } catch (error) {
        pngjsModule = null
        pngjsLoadError = shortError(error)
    }
    return pngjsModule
}

function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(Number(value) || 0)))
}

function getOtsuThreshold(values) {
    const histogram = new Array(256).fill(0)
    for (const value of values) histogram[clampByte(value)] += 1
    const total = values.length || 1
    let sum = 0
    for (let index = 0; index < 256; index += 1) sum += index * histogram[index]
    let sumBackground = 0
    let weightBackground = 0
    let bestVariance = -1
    let bestThreshold = 150
    for (let threshold = 0; threshold < 256; threshold += 1) {
        weightBackground += histogram[threshold]
        if (!weightBackground) continue
        const weightForeground = total - weightBackground
        if (!weightForeground) break
        sumBackground += threshold * histogram[threshold]
        const meanBackground = sumBackground / weightBackground
        const meanForeground = (sum - sumBackground) / weightForeground
        const variance = weightBackground * weightForeground * ((meanBackground - meanForeground) ** 2)
        if (variance > bestVariance) {
            bestVariance = variance
            bestThreshold = threshold
        }
    }
    return bestThreshold
}

function dilateBinary(values, width, height) {
    const output = values.slice()
    for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
            const index = y * width + x
            if (values[index] < 128) continue
            let nearInk = false
            for (let dy = -1; dy <= 1 && !nearInk; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    if (values[(y + dy) * width + (x + dx)] < 128) {
                        nearInk = true
                        break
                    }
                }
            }
            if (nearInk) output[index] = 0
        }
    }
    return output
}

function renderPngJsVariant(frameBuffer, variant = {}) {
    const pngjs = getPngJs()
    if (!pngjs?.PNG?.sync) throw makeOcrError("preprocessing_failed", pngjsLoadError || "pngjs tidak tersedia")
    const source = pngjs.PNG.sync.read(frameBuffer)
    const background = variant.background === "black" ? 0 : 255
    const gray = new Array(source.width * source.height)
    let minX = source.width
    let minY = source.height
    let maxX = -1
    let maxY = -1

    for (let y = 0; y < source.height; y += 1) {
        for (let x = 0; x < source.width; x += 1) {
            const srcIndex = (y * source.width + x) * 4
            const alpha = Number(source.data[srcIndex + 3] || 0) / 255
            const red = source.data[srcIndex] * alpha + background * (1 - alpha)
            const green = source.data[srcIndex + 1] * alpha + background * (1 - alpha)
            const blue = source.data[srcIndex + 2] * alpha + background * (1 - alpha)
            const luminance = clampByte(0.299 * red + 0.587 * green + 0.114 * blue)
            gray[y * source.width + x] = luminance
            const differs = background === 255 ? luminance < 242 : luminance > 13
            if (differs) {
                minX = Math.min(minX, x)
                minY = Math.min(minY, y)
                maxX = Math.max(maxX, x)
                maxY = Math.max(maxY, y)
            }
        }
    }

    if (maxX < minX || maxY < minY) {
        minX = 0
        minY = 0
        maxX = source.width - 1
        maxY = source.height - 1
    }

    const sourcePadding = Math.max(2, Math.round(Math.min(source.width, source.height) * 0.025))
    minX = Math.max(0, minX - sourcePadding)
    minY = Math.max(0, minY - sourcePadding)
    maxX = Math.min(source.width - 1, maxX + sourcePadding)
    maxY = Math.min(source.height - 1, maxY + sourcePadding)

    const cropWidth = Math.max(1, maxX - minX + 1)
    const cropHeight = Math.max(1, maxY - minY + 1)
    const requestedScale = Math.max(2, Number(variant.scale || 5))
    const maxSafeScale = Math.min(1800 / cropWidth, 1800 / cropHeight)
    const scale = Math.max(1, Math.min(requestedScale, maxSafeScale))
    const contentWidth = Math.max(1, Math.round(cropWidth * scale))
    const contentHeight = Math.max(1, Math.round(cropHeight * scale))
    const padding = Math.max(48, Math.round(Math.min(contentWidth, contentHeight) * 0.12))
    const outputWidth = contentWidth + padding * 2
    const outputHeight = contentHeight + padding * 2

    let transformed = gray
    if (variant.mode && variant.mode !== "gray") {
        const thresholdBase = getOtsuThreshold(gray)
        const threshold = clampByte(thresholdBase + Number(variant.thresholdOffset || 0))
        transformed = gray.map(value => {
            const isInk = background === 255 ? value <= threshold : value >= threshold
            return isInk ? 0 : 255
        })
        if (variant.dilate) transformed = dilateBinary(transformed, source.width, source.height)
    } else if (background === 0) {
        transformed = gray.map(value => 255 - value)
    }

    const output = new pngjs.PNG({ width: outputWidth, height: outputHeight })
    output.data.fill(255)
    for (let targetY = 0; targetY < contentHeight; targetY += 1) {
        const sourceY = Math.min(maxY, minY + Math.floor(targetY / scale))
        for (let targetX = 0; targetX < contentWidth; targetX += 1) {
            const sourceX = Math.min(maxX, minX + Math.floor(targetX / scale))
            const value = transformed[sourceY * source.width + sourceX]
            const dstIndex = ((targetY + padding) * outputWidth + targetX + padding) * 4
            output.data[dstIndex] = value
            output.data[dstIndex + 1] = value
            output.data[dstIndex + 2] = value
            output.data[dstIndex + 3] = 255
        }
    }
    return pngjs.PNG.sync.write(output)
}

function buildPngJsCandidates(frames, options = {}) {
    const config = { ...getRuntimeConfig(), ...options }
    if (!config.pngjsEnabled || !getPngJs()) return []
    const variants = [
        { name: "pngjs-white-otsu", background: "white", mode: "threshold", scale: 6 },
        { name: "pngjs-white-otsu-low", background: "white", mode: "threshold", thresholdOffset: -28, scale: 6 },
        { name: "pngjs-white-otsu-high", background: "white", mode: "threshold", thresholdOffset: 28, scale: 6 },
        { name: "pngjs-white-dilate", background: "white", mode: "threshold", dilate: true, scale: 6 },
        { name: "pngjs-black-otsu", background: "black", mode: "threshold", scale: 6 },
        { name: "pngjs-white-gray", background: "white", mode: "gray", scale: 5 },
    ]
    const candidates = []
    for (const frame of frames) {
        for (const variant of variants) {
            if (candidates.length >= config.maxCandidates) return candidates
            try {
                const buffer = renderPngJsVariant(frame.buffer, variant)
                if (!buffer?.length) continue
                candidates.push({ ...frame, buffer, candidate: variant.name })
            } catch (error) {
                debugLog("pngjs preprocessing failed", {
                    frame: frame.frameIndex,
                    candidate: variant.name,
                    error: shortError(error),
                })
            }
        }
    }
    return candidates
}

function getTesseract() {
    if (tesseractLoadAttempted) return tesseractModule
    tesseractLoadAttempted = true
    try {
        tesseractModule = require("tesseract.js")
        tesseractLoadError = ""
    } catch (error) {
        tesseractModule = null
        tesseractLoadError = shortError(error)
    }
    return tesseractModule
}

function pickFrameIndexes(pageCount, maxFrames) {
    const pages = Math.max(1, Math.floor(Number(pageCount) || 1))
    const count = Math.min(pages, Math.max(1, maxFrames))
    if (count === 1) return [0]
    const indexes = []
    for (let index = 0; index < count; index += 1) {
        indexes.push(Math.round((pages - 1) * (index / (count - 1))))
    }
    return [...new Set(indexes)]
}

function execFileWithTimeout(command, args, timeoutMs, missingCode = "ffmpeg_missing") {
    return new Promise((resolve, reject) => {
        execFile(command, args, {
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => {
            if (error) {
                reject(makeOcrError(
                    error.code === "ENOENT" ? missingCode : "conversion_failed",
                    shortError(stderr || error)
                ))
                return
            }
            resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") })
        })
    })
}

async function extractFramesWithFfmpeg(buffer, stickerMessage, config) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anti-toxic-ocr-"))
    const inputPath = path.join(tempRoot, "sticker.webp")
    const outputPaths = []
    try {
        fs.writeFileSync(inputPath, buffer)
        let duration = 0
        try {
            const probe = await execFileWithTimeout(config.ffprobeBin, [
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                inputPath,
            ], Math.min(config.timeoutMs, 7000))
            duration = Number(probe.stdout.trim()) || 0
        } catch {}

        const animated = Boolean(stickerMessage?.isAnimated)
        if (animated && duration > 0.05) {
            const positions = pickFrameIndexes(1001, config.maxFrames).map(index => (
                Math.max(0, Math.min(duration - 0.01, duration * (index / 1000)))
            ))
            for (let index = 0; index < positions.length; index += 1) {
                const outputPath = path.join(tempRoot, `frame-${String(index).padStart(2, "0")}.png`)
                await execFileWithTimeout(config.ffmpegBin, [
                    "-hide_banner", "-loglevel", "error",
                    "-ss", String(positions[index]),
                    "-i", inputPath,
                    "-frames:v", "1",
                    "-y", outputPath,
                ], config.timeoutMs)
                if (fs.existsSync(outputPath)) outputPaths.push(outputPath)
            }
        } else {
            const outputPattern = path.join(tempRoot, "frame-%02d.png")
            const args = ["-hide_banner", "-loglevel", "error", "-i", inputPath]
            if (animated) args.push("-vf", "fps=5")
            args.push("-frames:v", String(animated ? config.maxFrames : 1), "-y", outputPattern)
            await execFileWithTimeout(config.ffmpegBin, args, config.timeoutMs)
            outputPaths.push(...fs.readdirSync(tempRoot)
                .filter(name => /^frame-\d+\.png$/i.test(name))
                .sort()
                .map(name => path.join(tempRoot, name)))
        }

        const frames = outputPaths.slice(0, config.maxFrames).map((filePath, index) => ({
            buffer: fs.readFileSync(filePath),
            frameIndex: index,
            pageCount: outputPaths.length,
            source: "ffmpeg",
        }))
        if (!frames.length) throw makeOcrError("conversion_failed", "ffmpeg tidak menghasilkan frame")
        return { frames, animated, source: "ffmpeg" }
    } finally {
        try {
            const resolved = path.resolve(tempRoot)
            const base = path.resolve(os.tmpdir())
            if (resolved.startsWith(base + path.sep)) fs.rmSync(resolved, { recursive: true, force: true })
        } catch {}
    }
}

async function extractAnimatedStickerFrames(buffer, stickerMessage = {}, options = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw makeOcrError("unsupported_media", "buffer sticker kosong")
    const config = { ...getRuntimeConfig(), ...options }
    const sharp = getSharp(options)
    if (!sharp) return extractFramesWithFfmpeg(buffer, stickerMessage, config)

    try {
        let metadata
        try {
            metadata = await sharp(buffer, { animated: true, pages: -1 }).metadata()
        } catch {
            metadata = await sharp(buffer, { animated: false }).metadata()
        }
        const pageCount = Math.max(1, Number(metadata?.pages || 1))
        const animated = Boolean(stickerMessage?.isAnimated || pageCount > 1)
        const indexes = pickFrameIndexes(pageCount, animated ? config.maxFrames : 1)
        const frames = []
        for (const frameIndex of indexes) {
            let rendered
            try {
                rendered = await sharp(buffer, {
                    animated: pageCount > 1,
                    page: frameIndex,
                    pages: 1,
                }).png().toBuffer()
            } catch {
                rendered = await sharp(buffer, { animated: false }).png().toBuffer()
            }
            if (rendered?.length) {
                frames.push({ buffer: rendered, frameIndex, pageCount, source: "sharp" })
            }
        }
        if (!frames.length) throw makeOcrError("conversion_failed", "sharp tidak menghasilkan frame")
        return { frames, animated, source: "sharp" }
    } catch (error) {
        debugLog("sharp frame extraction failed", { error: shortError(error) })
        try {
            return await extractFramesWithFfmpeg(buffer, stickerMessage, config)
        } catch (fallbackError) {
            throw makeOcrError(fallbackError.code || "conversion_failed", shortError(fallbackError))
        }
    }
}

async function renderPreprocessVariant(frame, variant, sharp) {
    if (variant.name === "original") return frame.buffer
    let pipeline = sharp(frame.buffer, { animated: false })
    const metadata = await pipeline.metadata()
    const width = Math.min(2048, Math.max(1000, Number(metadata?.width || 256) * (variant.scale || 4)))

    if (variant.trim) {
        pipeline = pipeline.trim({ background: variant.background || "#ffffff" })
    }
    if (variant.background) pipeline = pipeline.flatten({ background: variant.background })
    pipeline = pipeline.resize({ width, fit: "inside", withoutEnlargement: false })
    if (variant.grayscale) pipeline = pipeline.grayscale()
    if (variant.normalize) pipeline = pipeline.normalize()
    if (variant.linear) pipeline = pipeline.linear(variant.linear[0], variant.linear[1])
    if (variant.sharpen) pipeline = pipeline.sharpen(1, 0.8, 1.2)
    if (variant.negate) pipeline = pipeline.negate()
    if (variant.threshold) pipeline = pipeline.threshold(variant.threshold)
    return pipeline.png().toBuffer()
}

async function preprocessStickerCandidates(frameInput, options = {}) {
    const config = { ...getRuntimeConfig(), ...options }
    const frames = Array.isArray(frameInput) ? frameInput : frameInput?.frames || []
    if (!frames.length) return []

    const candidates = []
    const seenHashes = new Set()
    const pushCandidate = candidate => {
        if (!candidate?.buffer?.length || candidates.length >= config.maxCandidates) return
        const hash = crypto.createHash("sha1").update(candidate.buffer).digest("hex")
        if (seenHashes.has(hash)) return
        seenHashes.add(hash)
        candidates.push(candidate)
    }

    // Pure-JS PNG preprocessing is the primary Termux-safe path. It avoids relying
    // on optional native sharp binaries, which frequently fail to load on Android.
    for (const candidate of buildPngJsCandidates(frames, config)) pushCandidate(candidate)

    const sharp = getSharp(options)
    if (sharp && candidates.length < config.maxCandidates) {
        const variants = [
            { name: "sharp-white-upscale", background: "#ffffff", scale: 5, grayscale: true, normalize: true, sharpen: true },
            { name: "sharp-black-upscale", background: "#000000", scale: 5, grayscale: true, normalize: true, sharpen: true, negate: true },
            { name: "sharp-white-threshold", background: "#ffffff", scale: 5, grayscale: true, normalize: true, sharpen: true, threshold: 150 },
            { name: "sharp-white-threshold-high", background: "#ffffff", scale: 5, grayscale: true, normalize: true, sharpen: true, threshold: 195 },
            { name: "sharp-trimmed", background: "#ffffff", scale: 5, grayscale: true, normalize: true, sharpen: true, trim: true },
        ]
        for (const frame of frames) {
            for (const variant of variants) {
                if (candidates.length >= config.maxCandidates) break
                try {
                    const rendered = await renderPreprocessVariant(frame, variant, sharp)
                    pushCandidate({ ...frame, buffer: rendered, candidate: variant.name })
                } catch (error) {
                    debugLog("sharp preprocessing candidate failed", {
                        candidate: variant.name,
                        frame: frame.frameIndex,
                        error: shortError(error),
                    })
                }
            }
        }
    }

    // Last-resort originals are still useful for already-clean PNG frames.
    for (const frame of frames) {
        if (candidates.length >= config.maxCandidates) break
        pushCandidate({ ...frame, candidate: `${frame.source || "frame"}-original` })
    }
    return candidates
}

function normalizeBasic(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim()
}

function addCandidate(output, value, maxCandidates) {
    const clean = String(value || "").trim()
    if (!clean || clean.length > 80 || output.includes(clean) || output.length >= maxCandidates) return
    output.push(clean)
}

function makeConfusionVariant(value, mapLetterL = false) {
    return String(value || "").replace(/[10|!54l]/g, char => {
        if (char === "1" || char === "|" || char === "!") return "i"
        if (char === "0") return "o"
        if (char === "5") return "s"
        if (char === "4") return "a"
        if (char === "l" && mapLetterL) return "i"
        return char
    })
}

function normalizeOcrCandidates(rawText, options = {}) {
    const maxCandidates = parsePositiveInt(options.maxCandidates, 20, 1, 60)
    const includeLetterLVariant = options.includeLetterLVariant !== false
    const normalized = normalizeBasic(rawText)
    if (!normalized) return []

    const output = []
    const tokens = normalized.match(/[\p{L}\p{N}|!]+/gu) || []
    for (const token of tokens) {
        addCandidate(output, token, maxCandidates)
        addCandidate(output, makeConfusionVariant(token, false), maxCandidates)
        if (includeLetterLVariant && token.length <= 8) addCandidate(output, makeConfusionVariant(token, true), maxCandidates)
    }

    const compact = normalized.replace(/[^\p{L}\p{N}|!]+/gu, "")
    addCandidate(output, compact, maxCandidates)
    addCandidate(output, makeConfusionVariant(compact, false), maxCandidates)
    if (includeLetterLVariant && compact.length <= 12) addCandidate(output, makeConfusionVariant(compact, true), maxCandidates)

    return output
}

function normalizeWordlistEntry(value) {
    return normalizeBasic(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

function matchOcrCandidatesAgainstWordlist(candidates, toxicWords) {
    const words = Array.isArray(toxicWords) ? toxicWords : []
    const wordSet = new Set(words.map(normalizeWordlistEntry).filter(Boolean))
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const normalized = normalizeWordlistEntry(candidate)
        if (!normalized || normalized.includes(" ")) continue
        if (wordSet.has(normalized)) {
            return { matched: true, word: normalized, candidate: normalized }
        }
    }
    return { matched: false, word: null, candidate: null }
}

function getLocalTessdataOptions() {
    const configured = String(process.env.ANTI_TOXIC_STICKER_OCR_LANG_PATH || "").trim()
    const projectRoot = path.resolve(__dirname, "..")
    const candidates = [configured, projectRoot].filter(Boolean)
    for (const directory of candidates) {
        const resolved = path.resolve(directory)
        if (fs.existsSync(path.join(resolved, "eng.traineddata"))) {
            return { langPath: resolved, gzip: false }
        }
        if (fs.existsSync(path.join(resolved, "eng.traineddata.gz"))) {
            return { langPath: resolved, gzip: true }
        }
    }
    return {}
}

async function getWorker() {
    if (workerResetPromise) await workerResetPromise
    if (worker) return worker
    if (workerPromise) return workerPromise
    const tesseract = getTesseract()
    if (!tesseract?.createWorker) throw makeOcrError("worker_init_failed", tesseractLoadError || "tesseract.js tidak tersedia")

    workerStatus = "INITIALIZING"
    workerPromise = tesseract.createWorker("eng", tesseract.OEM?.LSTM_ONLY ?? 1, {
        ...getLocalTessdataOptions(),
        logger: event => {
            if (isDebugEnabled() && event?.status === "recognizing text") {
                debugLog("worker progress", { progress: Math.round(Number(event.progress || 0) * 100) })
            }
        },
    }).then(created => {
        worker = created
        workerStatus = "READY"
        workerError = ""
        return worker
    }).catch(error => {
        workerStatus = "ERROR"
        workerError = shortError(error)
        workerPromise = null
        throw makeOcrError("worker_init_failed", workerError)
    })
    return workerPromise
}

async function resetWorker() {
    if (workerResetPromise) return workerResetPromise
    const pending = workerPromise
    let current = worker
    worker = null
    workerPromise = null
    workerResetPromise = (async () => {
        if (!current && pending) {
            try {
                current = await pending
            } catch {}
        }
        if (current?.terminate) {
            try {
                await current.terminate()
            } catch {}
        }
        if (worker === current) worker = null
        if (workerStatus !== "ERROR") workerStatus = "LAZY"
    })().finally(() => {
        workerResetPromise = null
    })
    return workerResetPromise
}

function withTimeout(promise, timeoutMs, code = "ocr_timeout") {
    return new Promise((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            resetWorker().catch(() => {})
            reject(makeOcrError(code, `OCR timeout setelah ${timeoutMs} ms`))
        }, timeoutMs)
        Promise.resolve(promise).then(value => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(value)
        }, error => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(error)
        })
    })
}

async function recognizeCandidate(candidate, options = {}) {
    if (!candidate?.buffer?.length) throw makeOcrError("preprocessing_failed", "candidate kosong")
    if (typeof options.recognizer === "function") {
        const result = await withTimeout(
            options.recognizer(candidate, options),
            Math.max(100, Number(options.timeoutMs || getRuntimeConfig().timeoutMs)),
            "ocr_timeout"
        )
        return {
            text: String(result?.text || result?.data?.text || "").slice(0, 300),
            confidence: Number(result?.confidence ?? result?.data?.confidence ?? 0) || 0,
            psm: options.psm || "mock",
        }
    }

    const tesseract = getTesseract()
    const activeWorker = await getWorker()
    const psm = options.psm || tesseract.PSM?.SINGLE_WORD || "8"
    await activeWorker.setParameters({
        tessedit_pageseg_mode: psm,
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789|!.-",
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
        tessedit_do_invert: "1",
    })
    const result = await withTimeout(
        activeWorker.recognize(candidate.buffer),
        Math.max(500, Number(options.timeoutMs || getRuntimeConfig().timeoutMs)),
        "ocr_timeout"
    )
    return {
        text: String(result?.data?.text || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300),
        confidence: Number(result?.data?.confidence || 0) || 0,
        psm,
    }
}


function parseTesseractTsv(stdout) {
    const words = []
    const confidences = []
    const lines = String(stdout || "").split(/\r?\n/)
    for (let index = 1; index < lines.length; index += 1) {
        const columns = lines[index].split("\t")
        if (columns.length < 12) continue
        const confidence = Number(columns[10])
        const text = String(columns.slice(11).join("\t") || "").trim()
        if (!text) continue
        words.push(text)
        if (Number.isFinite(confidence) && confidence >= 0) confidences.push(confidence)
    }
    return {
        text: words.join(" ").replace(/\s+/g, " ").trim().slice(0, 300),
        confidence: confidences.length ? Math.max(...confidences) : 0,
    }
}

async function recognizeCandidateWithCli(candidate, options = {}) {
    if (!candidate?.buffer?.length) throw makeOcrError("preprocessing_failed", "candidate kosong")
    const config = { ...getRuntimeConfig(), ...(options.runtime || {}) }
    if (!config.cliEnabled) throw makeOcrError("cli_disabled", "Tesseract CLI fallback nonaktif")
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anti-toxic-tesseract-cli-"))
    const inputPath = path.join(tempRoot, "candidate.png")
    try {
        fs.writeFileSync(inputPath, candidate.buffer)
        const psm = String(options.psm || "8")
        const result = await execFileWithTimeout(config.tesseractBin, [
            inputPath,
            "stdout",
            "-l", "eng",
            "--psm", psm,
            "-c", "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789|!.-",
            "-c", "preserve_interword_spaces=1",
            "tsv",
        ], Math.min(config.cliTimeoutMs, Number(options.timeoutMs || config.cliTimeoutMs)), "tesseract_cli_missing")
        const parsed = parseTesseractTsv(result.stdout)
        return { ...parsed, psm, engine: "tesseract-cli" }
    } finally {
        try {
            const resolved = path.resolve(tempRoot)
            const base = path.resolve(os.tmpdir())
            if (resolved.startsWith(base + path.sep)) fs.rmSync(resolved, { recursive: true, force: true })
        } catch {}
    }
}

function getRecognitionPlan(candidates, psmModes, maxPasses) {
    const plan = []
    const append = (psm, limit) => {
        for (const candidate of candidates.slice(0, limit)) {
            if (plan.length >= maxPasses) return
            plan.push({ candidate, psm })
        }
    }
    append(psmModes[0] || "8", Math.min(8, candidates.length))
    append(psmModes[1] || "7", Math.min(4, candidates.length))
    append(psmModes[2] || "11", Math.min(2, candidates.length))
    return plan.slice(0, maxPasses)
}

function evaluateOcrObservation(observation, raw, normalized, nonAmbiguousCandidates, toxicWords, votes, config) {
    const match = matchOcrCandidatesAgainstWordlist(normalized, toxicWords)
    if (!match.matched) return { accepted: false, match }
    const count = Number(votes.get(match.word) || 0) + 1
    votes.set(match.word, count)
    const confidence = Number(observation.confidence || 0)
    const compactRaw = normalizeBasic(raw).replace(/[^\p{L}\p{N}|!]+/gu, "")
    const letterLOnlyMatch = !nonAmbiguousCandidates.includes(match.word) && compactRaw.includes("l")
    const exactRaw = compactRaw === match.word || makeConfusionVariant(compactRaw, false) === match.word
    const shortWord = match.word.length <= 4
    const accepted = letterLOnlyMatch
        ? count >= 2
        : shortWord && exactRaw
            ? confidence >= config.exactShortConfidence || count >= 2
            : confidence >= config.mediumConfidence || count >= 2
    return { accepted, match, count, confidence, exactRaw, shortWord, letterLOnlyMatch }
}

function hashWords(words) {
    const normalized = [...new Set((Array.isArray(words) ? words : []).map(normalizeWordlistEntry).filter(Boolean))].sort()
    return crypto.createHash("sha256").update(normalized.join("\n"), "utf8").digest("hex").slice(0, 16)
}

function mediaIdentity(stickerMessage, buffer) {
    const binary = stickerMessage?.fileSha256 || stickerMessage?.fileEncSha256
    if (binary) {
        try {
            return Buffer.from(binary).toString("base64")
        } catch {}
    }
    if (Buffer.isBuffer(buffer)) return crypto.createHash("sha256").update(buffer).digest("hex")
    return ""
}

function makeCacheKey(stickerMessage, buffer, toxicWords) {
    const mediaHash = mediaIdentity(stickerMessage, buffer)
    if (!mediaHash) return ""
    return `${PIPELINE_VERSION}:${mediaHash}:${hashWords(toxicWords)}`
}

function pruneCache(now = Date.now()) {
    const config = getRuntimeConfig()
    for (const [key, entry] of resultCache) {
        if (!entry || Number(entry.expiresAt || 0) <= now) resultCache.delete(key)
    }
    while (resultCache.size > config.cacheLimit) {
        const oldest = resultCache.keys().next().value
        if (!oldest) break
        resultCache.delete(oldest)
    }
}

function rememberCache(key, result, now = Date.now()) {
    if (!key) return
    const config = getRuntimeConfig()
    const isError = result?.status === "error"
    const entry = {
        result: {
            ...result,
            rawTexts: (result.rawTexts || []).slice(0, 8),
            normalizedCandidates: (result.normalizedCandidates || []).slice(0, 30),
        },
        expiresAt: now + (isError ? config.errorCacheTtlMs : config.cacheTtlMs),
    }
    resultCache.delete(key)
    resultCache.set(key, entry)
    pruneCache(now)
}

function getCachedResult(key, now = Date.now()) {
    pruneCache(now)
    const entry = key ? resultCache.get(key) : null
    if (!entry) return null
    return { ...entry.result, cacheHit: true, reason: "cache_hit" }
}

function updateLastScan(result) {
    lastScan = {
        time: Date.now(),
        result: result?.status || result?.result || "error",
        durationMs: Number(result?.durationMs || 0),
        error: result?.status === "error" ? shortError(result.error || result.reason) : "",
    }
}

function enqueueScan(task) {
    const config = getRuntimeConfig()
    if (scanQueue.length >= config.queueMax) {
        return Promise.resolve({
            status: "error",
            result: "error",
            reason: "queue_full",
            error: "queue OCR penuh",
            durationMs: 0,
        })
    }
    return new Promise(resolve => {
        scanQueue.push({ task, resolve })
        drainQueue()
    })
}

function drainQueue() {
    if (activeScans >= 1 || scanQueue.length === 0) return
    const item = scanQueue.shift()
    activeScans += 1
    Promise.resolve()
        .then(item.task)
        .then(item.resolve, error => item.resolve({
            status: "error",
            result: "error",
            reason: error?.code || "ocr_error",
            error: shortError(error),
            durationMs: 0,
        }))
        .finally(() => {
            activeScans -= 1
            drainQueue()
        })
}

function getPsmModes(options = {}) {
    if (Array.isArray(options.psmModes) && options.psmModes.length) return options.psmModes
    const tesseract = getTesseract()
    return [
        tesseract?.PSM?.SINGLE_WORD || "8",
        tesseract?.PSM?.SINGLE_LINE || "7",
        tesseract?.PSM?.SPARSE_TEXT || "11",
    ]
}

async function runScan(msg, options, initialKey) {
    const startedAt = Date.now()
    const config = { ...getRuntimeConfig(), ...(options.runtime || {}) }
    const stickerMessage = options.stickerMessage || extractStickerMessage(msg)
    const toxicWords = Array.isArray(options.toxicWords) ? options.toxicWords : []
    let cacheKey = initialKey
    let buffer = Buffer.isBuffer(options.buffer) ? options.buffer : null

    const baseResult = {
        pipelineVersion: PIPELINE_VERSION,
        status: "error",
        result: "error",
        reason: "ocr_error",
        matchedWord: null,
        rawTexts: [],
        normalizedCandidates: [],
        bytes: 0,
        frames: 0,
        candidates: 0,
        passes: 0,
        animated: Boolean(stickerMessage?.isAnimated),
        engine: workerStatus,
        engines: [],
        cacheHit: false,
    }

    try {
        if (!config.enabled) throw makeOcrError("disabled", "OCR sticker Anti Kasar nonaktif")
        if (!stickerMessage && !buffer) throw makeOcrError("unsupported_media", "pesan bukan sticker")
        debugLog("sticker detected", {
            message: msg?.key?.id,
            animated: Boolean(stickerMessage?.isAnimated),
        })

        buffer = buffer || await downloadStickerBuffer(stickerMessage, {
            ...options,
            maxBytes: config.maxBytes,
        })
        if (!buffer?.length) throw makeOcrError("download_failed", "buffer sticker kosong")
        if (buffer.length > config.maxBytes) throw makeOcrError("too_large", `sticker melebihi ${config.maxBytes} bytes`)
        baseResult.bytes = buffer.length
        debugLog(`media downloaded bytes=${buffer.length}`)

        cacheKey = cacheKey || makeCacheKey(stickerMessage, buffer, toxicWords)
        if (!options.ignoreCache) {
            const cached = getCachedResult(cacheKey)
            if (cached) return cached
        }

        const frameSet = options.frames
            ? { frames: options.frames, animated: Boolean(stickerMessage?.isAnimated || options.frames.length > 1), source: "injected" }
            : await extractAnimatedStickerFrames(buffer, stickerMessage, {
                ...config,
                ...options,
            })
        baseResult.frames = frameSet.frames.length
        baseResult.animated = frameSet.animated
        debugLog(`frames=${frameSet.frames.length}`, { source: frameSet.source })

        const candidates = await preprocessStickerCandidates(frameSet.frames, {
            ...config,
            ...options,
        })
        if (!candidates.length) throw makeOcrError("preprocessing_failed", "tidak ada candidate OCR")
        baseResult.candidates = candidates.length
        debugLog(`candidates=${candidates.length}`)

        const votes = new Map()
        const psmModes = getPsmModes(options)
        const plan = getRecognitionPlan(candidates, psmModes, config.maxPasses)
        let jsEngineError = null
        let cliEngineError = null

        const processObservation = (observation, candidate, psm, engineName) => {
            baseResult.passes += 1
            if (!baseResult.engines.includes(engineName)) baseResult.engines.push(engineName)
            const raw = String(observation?.text || "").trim()
            if (!raw) return null
            if (!baseResult.rawTexts.includes(raw)) baseResult.rawTexts.push(raw.slice(0, 300))
            const normalized = normalizeOcrCandidates(raw, { maxCandidates: config.maxCandidates * 3 })
            const nonAmbiguousCandidates = normalizeOcrCandidates(raw, {
                maxCandidates: config.maxCandidates * 3,
                includeLetterLVariant: false,
            })
            for (const value of normalized) {
                if (!baseResult.normalizedCandidates.includes(value)) baseResult.normalizedCandidates.push(value)
            }
            const decision = evaluateOcrObservation(
                observation,
                raw,
                normalized,
                nonAmbiguousCandidates,
                toxicWords,
                votes,
                config
            )
            debugLog("OCR observation", {
                engine: engineName,
                frame: candidate.frameIndex,
                candidate: candidate.candidate,
                psm,
                confidence: Math.round(Number(observation?.confidence || 0)),
                raw: raw.slice(0, 80),
                normalized: decision.match?.candidate || normalized.slice(0, 4).join(","),
                votes: decision.count,
                accepted: decision.accepted,
            })
            if (!decision.accepted) return null
            return {
                ...baseResult,
                status: "toxic",
                result: "toxic",
                reason: "toxic",
                matchedWord: decision.match.word,
                matchedCandidate: decision.match.candidate,
                confidence: decision.confidence,
                engine: engineName,
                engines: [...baseResult.engines],
                durationMs: Date.now() - startedAt,
            }
        }

        // Primary engine: reusable Tesseract.js worker. The pass plan is bounded
        // and prioritises SINGLE_WORD before slower line/sparse modes.
        for (const step of plan) {
            const remaining = config.timeoutMs - (Date.now() - startedAt)
            if (remaining <= 750) break
            try {
                const observation = await recognizeCandidate(step.candidate, {
                    ...options,
                    psm: step.psm,
                    timeoutMs: Math.min(remaining, 9000),
                })
                const matched = processObservation(observation, step.candidate, step.psm, "tesseract.js")
                if (matched) {
                    debugLog(`normalized=${matched.matchedCandidate}`)
                    debugLog(`match=${matched.matchedWord}`)
                    debugLog("handled=true", { durationMs: matched.durationMs, engine: matched.engine })
                    rememberCache(cacheKey, matched)
                    updateLastScan(matched)
                    return matched
                }
            } catch (error) {
                jsEngineError = error
                debugLog("tesseract.js pass failed", {
                    candidate: step.candidate.candidate,
                    psm: step.psm,
                    error: shortError(error),
                })
                if (["worker_init_failed", "ocr_timeout"].includes(error?.code)) break
            }
        }

        // Secondary engine: native Tesseract CLI when installed in Termux.
        // It is deliberately bounded to the strongest candidates and never required.
        if (config.cliEnabled) {
            const cliPlan = getRecognitionPlan(candidates.slice(0, 4), psmModes.slice(0, 2), Math.min(6, config.maxPasses))
            for (const step of cliPlan) {
                const remaining = config.timeoutMs - (Date.now() - startedAt)
                if (remaining <= 1000) break
                try {
                    const observation = await recognizeCandidateWithCli(step.candidate, {
                        ...options,
                        runtime: config,
                        psm: step.psm,
                        timeoutMs: Math.min(remaining, config.cliTimeoutMs),
                    })
                    const matched = processObservation(observation, step.candidate, step.psm, "tesseract-cli")
                    if (matched) {
                        debugLog(`normalized=${matched.matchedCandidate}`)
                        debugLog(`match=${matched.matchedWord}`)
                        debugLog("handled=true", { durationMs: matched.durationMs, engine: matched.engine })
                        rememberCache(cacheKey, matched)
                        updateLastScan(matched)
                        return matched
                    }
                } catch (error) {
                    cliEngineError = error
                    debugLog("tesseract CLI pass failed", {
                        candidate: step.candidate.candidate,
                        psm: step.psm,
                        error: shortError(error),
                    })
                    if (["tesseract_cli_missing", "ENOENT"].includes(error?.code) || /ENOENT|not found/i.test(shortError(error))) break
                }
            }
        }

        if (!baseResult.rawTexts.length && jsEngineError && cliEngineError) {
            throw makeOcrError(
                jsEngineError.code || cliEngineError.code || "ocr_error",
                `Tesseract.js: ${shortError(jsEngineError)}; CLI: ${shortError(cliEngineError)}`
            )
        }

        const result = {
            ...baseResult,
            status: "clean",
            result: "clean",
            reason: baseResult.rawTexts.length ? "clean" : "ocr_empty",
            engine: baseResult.engines.length ? baseResult.engines.join("+") : workerStatus,
            engines: [...baseResult.engines],
            durationMs: Date.now() - startedAt,
        }
        rememberCache(cacheKey, result)
        updateLastScan(result)
        debugLog("handled=true", { result: "clean", durationMs: result.durationMs })
        return result
    } catch (error) {
        const result = {
            ...baseResult,
            status: "error",
            result: "error",
            reason: error?.code || "ocr_error",
            error: shortError(error),
            engine: workerStatus,
            durationMs: Date.now() - startedAt,
        }
        if (cacheKey) rememberCache(cacheKey, result)
        updateLastScan(result)
        if (error?.code === "download_failed") {
            console.log(`[ANTI TOXIC OCR] Sticker download failed: ${shortError(error)}`)
        } else {
            logFailure(error)
        }
        return result
    }
}

async function scanStickerForToxicWords(msg, options = {}) {
    const stickerMessage = options.stickerMessage || extractStickerMessage(msg)
    const toxicWords = Array.isArray(options.toxicWords) ? options.toxicWords : []
    const initialKey = makeCacheKey(stickerMessage, options.buffer, toxicWords)
    if (!options.ignoreCache) {
        const cached = getCachedResult(initialKey)
        if (cached) return cached
    }
    if (initialKey && inFlightScans.has(initialKey)) {
        const result = await inFlightScans.get(initialKey)
        return { ...result, duplicate: true, reason: "duplicate" }
    }

    const promise = enqueueScan(() => runScan(msg, options, initialKey))
    if (initialKey) inFlightScans.set(initialKey, promise)
    try {
        return await promise
    } finally {
        if (initialKey && inFlightScans.get(initialKey) === promise) inFlightScans.delete(initialKey)
    }
}

function clearAntiToxicStickerOcrCache() {
    const removed = resultCache.size
    resultCache.clear()
    return removed
}

function probeFfmpeg(force = false) {
    if (ffmpegProbe && !force) return ffmpegProbe
    const config = getRuntimeConfig()
    try {
        const result = spawnSync(config.ffmpegBin, ["-version"], {
            encoding: "utf8",
            timeout: 3000,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        })
        ffmpegProbe = {
            ready: result.status === 0,
            detail: result.status === 0 ? "READY" : "NOT FOUND",
        }
    } catch {
        ffmpegProbe = { ready: false, detail: "NOT FOUND" }
    }
    return ffmpegProbe
}


function probeTesseractCli(force = false) {
    if (tesseractCliProbe && !force) return tesseractCliProbe
    const config = getRuntimeConfig()
    if (!config.cliEnabled) {
        tesseractCliProbe = { ready: false, detail: "OFF" }
        return tesseractCliProbe
    }
    try {
        const result = spawnSync(config.tesseractBin, ["--version"], {
            encoding: "utf8",
            timeout: 3000,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        })
        tesseractCliProbe = {
            ready: result.status === 0,
            detail: result.status === 0 ? "READY" : "NOT FOUND",
        }
    } catch {
        tesseractCliProbe = { ready: false, detail: "NOT FOUND" }
    }
    return tesseractCliProbe
}

function dependencyResolvable(name) {
    try {
        require.resolve(name)
        return true
    } catch {
        return false
    }
}

function getAntiToxicStickerOcrHealth(options = {}) {
    const config = getRuntimeConfig()
    if (options.probeDependencies) {
        getSharp(options)
        getTesseract()
        getPngJs()
        probeFfmpeg()
        probeTesseractCli()
    }
    const tesseractInstalled = dependencyResolvable("tesseract.js") && !tesseractLoadError
    const sharpInstalled = dependencyResolvable("sharp")
    const pngjsInstalled = dependencyResolvable("pngjs") && !pngjsLoadError
    const ffmpeg = ffmpegProbe || { ready: false, detail: "NOT CHECKED" }
    const cli = tesseractCliProbe || { ready: false, detail: "NOT CHECKED" }
    const imageEngineReady = Boolean(pngjsInstalled || sharpModule || (!sharpLoadAttempted && sharpInstalled) || ffmpeg.ready)
    const words = Array.isArray(options.toxicWords) ? options.toxicWords : []
    const normalizedWords = words.map(normalizeWordlistEntry)
    const staticStatus = config.enabled && tesseractInstalled && imageEngineReady ? "READY" : "DEGRADED"
    const animatedStatus = staticStatus === "READY" && (sharpModule || ffmpeg.ready) ? "READY" : "DEGRADED"
    let engine = "READY"
    if (!config.enabled) engine = "OFF"
    else if (!tesseractInstalled || workerStatus === "ERROR") engine = "ERROR"
    else if (!imageEngineReady) engine = "DEGRADED"

    pruneCache()
    return {
        enabled: config.enabled,
        scope: "Group Anti Kasar",
        engine,
        worker: workerStatus,
        workerError,
        tesseract: tesseractInstalled ? (workerStatus === "READY" ? "READY" : "LAZY / NOT INITIALIZED") : "ERROR",
        tesseractCli: cli.detail,
        pngjs: pngjsInstalled ? "READY" : `ERROR${pngjsLoadError ? ` (${pngjsLoadError})` : ""}`,
        sharp: sharpModule ? "READY" : sharpLoadAttempted ? `FALLBACK${sharpLoadError ? ` (${sharpLoadError})` : ""}` : sharpInstalled ? "LAZY" : "FALLBACK",
        ffmpeg: ffmpeg.detail,
        staticSticker: staticStatus,
        animatedSticker: animatedStatus,
        wordCount: words.length,
        containsTai: normalizedWords.includes("tai"),
        cacheEntries: resultCache.size,
        cacheLimit: config.cacheLimit,
        cacheVersion: PIPELINE_VERSION,
        queue: scanQueue.length,
        active: activeScans,
        concurrency: config.concurrency,
        maxBytes: config.maxBytes,
        maxFrames: config.maxFrames,
        maxCandidates: config.maxCandidates,
        maxPasses: config.maxPasses,
        timeoutMs: config.timeoutMs,
        cliEnabled: config.cliEnabled,
        debug: config.debug,
        lastScan: { ...lastScan },
    }
}

function formatBytes(value) {
    const bytes = Number(value || 0)
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatLastScan(value) {
    if (!value) return "belum ada"
    try {
        return new Date(value).toLocaleString("id-ID", {
            timeZone: process.env.TZ || "Asia/Jakarta",
            hour12: false,
        })
    } catch {
        return "UNKNOWN"
    }
}

function getStatusText(health) {
    return [
        "🔎 *ANTI KASAR STICKER OCR*",
        "",
        `Status: ${health.enabled ? "ON" : "OFF"}`,
        `Scope: ${health.scope}`,
        `Engine: ${health.engine}`,
        `Tesseract.js: ${health.tesseract}`,
        `Tesseract CLI: ${health.tesseractCli}`,
        `PNGJS Preprocess: ${health.pngjs}`,
        `Sharp: ${health.sharp}`,
        `FFmpeg: ${health.ffmpeg}`,
        `Static Sticker: ${health.staticSticker}`,
        `Animated Sticker: ${health.animatedSticker}`,
        "",
        "Wordlist:",
        `- Loaded words: ${health.wordCount}`,
        `- Contains tai: ${health.containsTai ? "YES" : "NO"}`,
        "",
        "Cache:",
        `- Entries: ${health.cacheEntries}/${health.cacheLimit}`,
        `- Version: ${health.cacheVersion}`,
        "",
        "Settings:",
        `- Max bytes: ${health.maxBytes}`,
        `- Max frames: ${health.maxFrames}`,
        `- Max candidates: ${health.maxCandidates}`,
        `- Max OCR passes: ${health.maxPasses}`,
        `- Timeout: ${health.timeoutMs} ms`,
        `- CLI fallback: ${health.cliEnabled ? "ON" : "OFF"}`,
        `- Debug: ${health.debug ? "ON" : "OFF"}`,
        `- Queue: ${health.queue} waiting / ${health.active} active`,
        "",
        "Last scan:",
        `- Time: ${formatLastScan(health.lastScan.time)}`,
        `- Result: ${health.lastScan.result}`,
        `- Duration: ${health.lastScan.durationMs == null ? "-" : `${health.lastScan.durationMs} ms`}`,
        `- Error: ${health.lastScan.error || "-"}`,
    ].join("\n")
}

function getDiagnosticText(result) {
    const raw = (result.rawTexts || []).slice(0, 5).join(" | ") || "-"
    const normalized = (result.normalizedCandidates || []).slice(0, 12).join("\n") || "-"
    let verdict = "❌ NO TOXIC WORD DETECTED"
    if (result.status === "toxic") verdict = "✅ TOXIC WORD DETECTED"
    else if (result.status === "error") verdict = `⚠️ OCR FAILED\nReason: ${result.reason || result.error || "unknown"}`
    return [
        "🔎 *ANTI KASAR STICKER OCR TEST*",
        "",
        `Media: Sticker ${result.animated ? "Animated" : "Static"}`,
        `Bytes: ${formatBytes(result.bytes)}`,
        `Frames: ${result.frames}`,
        `Candidates: ${result.candidates}`,
        `OCR Engine: ${result.engine || "UNKNOWN"}`,
        "",
        "Raw OCR:",
        raw.slice(0, 500),
        "",
        "Normalized candidates:",
        normalized,
        "",
        `Matched word: ${result.matchedWord || "-"}`,
        "",
        "Result:",
        verdict,
    ].join("\n")
}

async function handleAntiToxicStickerOcrCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    if (!/^\.(kasarocr|antitoxicocr)(?:\s|$)/i.test(text)) return false
    if (context.isGroup || String(context.from || msg?.key?.remoteJid || "").endsWith("@g.us")) return true

    const from = context.from || msg?.key?.remoteJid
    if (!context.isOwner) {
        await sock.sendMessage(from, { text: "Akses Ditolak" })
        return true
    }

    const parts = text.split(/\s+/)
    const action = String(parts[1] || "status").toLowerCase()
    const toxicWords = typeof context.getToxicWords === "function"
        ? context.getToxicWords()
        : (Array.isArray(context.toxicWords) ? context.toxicWords : [])

    if (action === "status") {
        const health = getAntiToxicStickerOcrHealth({ toxicWords, probeDependencies: true })
        await sock.sendMessage(from, { text: getStatusText(health) })
        return true
    }

    if (action === "debug" && /^(on|off)$/i.test(parts[2] || "")) {
        debugOverride = String(parts[2]).toLowerCase() === "on"
        await sock.sendMessage(from, { text: `Debug Anti Kasar Sticker OCR: ${debugOverride ? "ON" : "OFF"}` })
        return true
    }

    if (action === "clearcache") {
        const removed = clearAntiToxicStickerOcrCache()
        await sock.sendMessage(from, { text: `Cache Anti Kasar Sticker OCR dibersihkan: ${removed} entries.` })
        return true
    }

    if (action === "test") {
        const quoted = getQuotedStickerMessage(msg)
        if (!quoted) {
            await sock.sendMessage(from, { text: "Reply sticker melalui private chat, lalu kirim .kasarocr test" })
            return true
        }
        const result = await scanStickerForToxicWords(quoted, {
            stickerMessage: quoted.stickerMessage,
            toxicWords,
            ignoreCache: true,
        })
        await sock.sendMessage(from, { text: getDiagnosticText(result) }, { quoted: msg })
        return true
    }

    await sock.sendMessage(from, {
        text: [
            "🔎 *ANTI KASAR STICKER OCR*",
            "",
            ".kasarocr status",
            ".kasarocr test (reply sticker)",
            ".kasarocr debug on/off",
            ".kasarocr clearcache",
            "",
            "Alias: .antitoxicocr",
        ].join("\n"),
    })
    return true
}

async function disposeAntiToxicStickerOcr() {
    resultCache.clear()
    inFlightScans.clear()
    const pending = scanQueue.splice(0, scanQueue.length)
    for (const item of pending) {
        item.resolve({
            status: "error",
            result: "error",
            reason: "disposed",
            error: "OCR disposed",
            durationMs: 0,
        })
    }
    debugOverride = null
    await resetWorker()
    return true
}

module.exports = {
    isAntiToxicStickerOcrEnabled,
    scanStickerForToxicWords,
    preprocessStickerCandidates,
    extractAnimatedStickerFrames,
    recognizeCandidate,
    normalizeOcrCandidates,
    matchOcrCandidatesAgainstWordlist,
    getAntiToxicStickerOcrHealth,
    clearAntiToxicStickerOcrCache,
    handleAntiToxicStickerOcrCommand,
    disposeAntiToxicStickerOcr,
    extractStickerMessage,
    getQuotedStickerMessage,
    PIPELINE_VERSION,
}
