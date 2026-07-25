const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const { PNG } = require("pngjs");
const tf = require("@tensorflow/tfjs");
const nsfwjs = require("nsfwjs");

let sharp = null;
let sharpLoadError = null;
try {
    sharp = require("sharp");
} catch (error) {
    sharpLoadError = error;
}

const nsfwCache = new Map();
let classifierWarningShown = false;
let sharpWarningShown = false;
let localClassifier = null;
let localClassifierLoadAttempted = false;
let localClassifierWarningShown = false;

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const LOCAL_SCAN_SIZE = 192;
const DEFAULT_AI_IMAGE_SIZE = 224;
let nsfwAiModelPromise = null;

function parseNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function parseBoolean(value, fallback = false) {
    const clean = String(value ?? "").trim();
    if (!clean) return fallback;
    return /^(1|true|yes|on)$/i.test(clean);
}

function getConfig() {
    return {
        enabled: parseBoolean(process.env.ANTI_NSFW_STICKER_ENABLED, true),
        mode: String(process.env.ANTI_NSFW_STICKER_MODE || "ai").trim().toLowerCase(),
        threshold: parseNumber(process.env.ANTI_NSFW_STICKER_THRESHOLD, 0.50),
        warnThreshold: parseNumber(process.env.ANTI_NSFW_STICKER_WARN_THRESHOLD, 0.35),
        timeoutMs: parseNumber(process.env.ANTI_NSFW_STICKER_TIMEOUT_MS, 15000),
        maxBytes: parseNumber(process.env.ANTI_NSFW_STICKER_MAX_BYTES, DEFAULT_MAX_BYTES),
        cacheLimit: Math.max(0, parseNumber(process.env.ANTI_NSFW_STICKER_CACHE_LIMIT, 300)),
        debug: parseBoolean(process.env.ANTI_NSFW_STICKER_DEBUG, false),
        ownerReport: parseBoolean(process.env.ANTI_NSFW_STICKER_OWNER_REPORT, true),
        action: String(process.env.ANTI_NSFW_STICKER_ACTION || "warn").trim().toLowerCase(),
        warnFromMe: parseBoolean(process.env.ANTI_NSFW_STICKER_WARN_FROM_ME || process.env.ANTI_NSFW_STICKER_TEST_FROM_ME, false),
        maxFrames: Math.max(1, parseNumber(process.env.ANTI_NSFW_STICKER_MAX_FRAMES, 16)),
        localScanSize: Math.max(64, Math.min(384, parseNumber(process.env.ANTI_NSFW_STICKER_LOCAL_SCAN_SIZE, LOCAL_SCAN_SIZE))),
        aiModel: String(process.env.ANTI_NSFW_STICKER_AI_MODEL || process.env.ANTI_NSFW_STICKER_MODEL || "").trim(),
        aiImageSize: Math.max(224, Math.min(768, parseNumber(process.env.ANTI_NSFW_STICKER_AI_IMAGE_SIZE, DEFAULT_AI_IMAGE_SIZE))),
    };
}

function isEnabled() {
    return getConfig().enabled;
}

function isDebugEnabled() {
    return getConfig().debug;
}

function isGroupJid(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@g.us");
}

function isStatusJid(jid) {
    return String(jid || "").trim().toLowerCase() === "status@broadcast";
}

function isNewsletterJid(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@newsletter");
}

function getSenderJid(msg) {
    const remoteJid = msg?.key?.remoteJid || "";
    if (isGroupJid(remoteJid)) return msg?.key?.participant || msg?.participant || remoteJid;
    return msg?.key?.participant || msg?.participant || remoteJid;
}

function getJidLabel(jid) {
    return String(jid || "").split("@")[0].split(":")[0].split("_")[0] || "-";
}

function unwrapMediaMessage(message) {
    let current = message || {};

    for (let i = 0; i < 6; i += 1) {
        if (current?.ephemeralMessage?.message) current = current.ephemeralMessage.message;
        else if (current?.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
        else break;
    }

    return current || {};
}

function getStickerMessage(msg) {
    const message = unwrapMediaMessage(msg?.message || {});
    return message?.stickerMessage || null;
}

function reviveBuffer(value) {
    if (!value || Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (Array.isArray(value)) return Buffer.from(value);
    if (value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
    return value;
}

function normalizeDownloadableMedia(media) {
    if (!media || typeof media !== "object") return media;
    for (const key of ["mediaKey", "fileSha256", "fileEncSha256", "jpegThumbnail"]) {
        if (media[key]) media[key] = reviveBuffer(media[key]);
    }
    return media;
}

function getBinaryKeyPart(value) {
    const revived = reviveBuffer(value);
    if (Buffer.isBuffer(revived)) return revived.toString("base64");
    return String(revived || "").trim();
}

function getCacheKey(msg, stickerMessage) {
    const fileSha = getBinaryKeyPart(stickerMessage?.fileSha256);
    if (fileSha) return `fileSha256:${fileSha}`;

    const fileEncSha = getBinaryKeyPart(stickerMessage?.fileEncSha256);
    if (fileEncSha) return `fileEncSha256:${fileEncSha}`;

    const remoteJid = String(msg?.key?.remoteJid || "").trim();
    const id = String(msg?.key?.id || "").trim();
    return remoteJid && id ? `message:${remoteJid}:${id}` : "";
}

function pruneCache(limit = getConfig().cacheLimit) {
    if (limit <= 0) {
        nsfwCache.clear();
        return;
    }

    while (nsfwCache.size > limit) {
        const oldestKey = nsfwCache.keys().next().value;
        if (!oldestKey) break;
        nsfwCache.delete(oldestKey);
    }
}

function rememberCache(key, value) {
    if (!key) return;
    if (nsfwCache.has(key)) nsfwCache.delete(key);
    nsfwCache.set(key, value);
    pruneCache();
}

function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label || "operation"} timeout after ${timeoutMs}ms`)), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
    });

    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function debugLog(stage, details = {}) {
    if (!isDebugEnabled()) return;
    console.log("[ANTI-NSFW]", {
        stage,
        id: details.id,
        remoteJid: details.remoteJid,
        senderJid: details.senderJid,
        score: details.score,
        label: details.label,
        reason: details.reason,
        frameIndex: details.frameIndex,
        pageCount: details.pageCount,
        durationMs: details.durationMs,
        action: details.action,
        errorStatus: details.errorStatus || details.error?.response?.status,
        errorDetail: details.errorDetail,
        error: details.error?.message || details.errorMessage,
    });
}

function auditLog(stage, details = {}) {
    console.log("[ANTI-NSFW AUDIT]", {
        stage,
        id: details.id,
        remoteJid: details.remoteJid,
        remoteJidAlt: details.remoteJidAlt,
        participant: details.participant,
        fromMe: details.fromMe,
        senderJid: details.senderJid,
        enabled: details.enabled,
        mode: details.mode,
        threshold: details.threshold,
        warnThreshold: details.warnThreshold,
        maxFrames: details.maxFrames,
        warnFromMe: details.warnFromMe,
        hasSticker: details.hasSticker,
        messageTypes: details.messageTypes,
        stickerBytes: details.stickerBytes,
        frameCount: details.frameCount,
        cacheHit: details.cacheHit,
        reason: details.reason,
        error: details.error?.message || details.errorMessage,
    });
}

function warnOnce(message, details = {}) {
    console.log(message, details);
}

function execFileWithTimeout(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile(command, args, {
            timeout: options.timeoutMs || getConfig().timeoutMs,
            maxBuffer: options.maxBuffer || 1024 * 1024,
            windowsHide: true,
        }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });

        child.on("error", reject);
    });
}

async function removeDirQuietly(dir) {
    if (!dir) return;
    try {
        await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
        // ignore temp cleanup errors
    }
}

async function downloadStickerBuffer(stickerMessage, options = {}) {
    const config = getConfig();

    return withTimeout(
        (async () => {
            const stream = await downloadContentFromMessage(
                normalizeDownloadableMedia(stickerMessage),
                "sticker"
            );
            const chunks = [];
            let total = 0;

            for await (const chunk of stream) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += buffer.length;
                if (config.maxBytes > 0 && total > config.maxBytes) {
                    throw new Error(`sticker lebih besar dari batas ${config.maxBytes} bytes`);
                }
                chunks.push(buffer);
            }

            return chunks.length ? Buffer.concat(chunks, total) : null;
        })(),
        options.timeoutMs || config.timeoutMs,
        "anti-nsfw sticker download"
    ).catch(error => {
        debugLog("download-failed", { ...options.meta, error });
        return null;
    });
}

function getUniqueNumbers(values) {
    const result = [];
    const seen = new Set();

    for (const value of values) {
        const number = Number(value);
        if (!Number.isFinite(number)) continue;

        const safeNumber = Math.max(0, Math.floor(number));
        if (seen.has(safeNumber)) continue;

        seen.add(safeNumber);
        result.push(safeNumber);
    }

    return result;
}

function pickFrameIndexes(pageCount, maxFrames) {
    const totalPages = Math.max(1, Math.floor(Number(pageCount) || 1));
    const frameLimit = Math.max(1, Math.min(totalPages, Math.floor(Number(maxFrames) || 1)));
    const evenlySpaced = [];

    for (let i = 0; i < frameLimit; i += 1) {
        const ratio = frameLimit === 1 ? 0 : i / (frameLimit - 1);
        evenlySpaced.push(Math.round((totalPages - 1) * ratio));
    }

    const preferred = getUniqueNumbers([
        ...evenlySpaced,
        0,
        Math.floor(totalPages / 4),
        Math.floor(totalPages / 3),
        Math.floor(totalPages / 2),
        Math.floor((totalPages * 2) / 3),
        Math.floor((totalPages * 3) / 4),
        totalPages - 1,
    ]).filter(index => index < totalPages);

    for (let index = 0; preferred.length < frameLimit && index < totalPages; index += 1) {
        if (!preferred.includes(index)) preferred.push(index);
    }

    return preferred.slice(0, frameLimit);
}

async function getStickerMetadata(buffer) {
    try {
        return await sharp(buffer, { animated: true, pages: -1 }).metadata();
    } catch (error) {
        debugLog("metadata-animated-failed", { error });
    }

    try {
        return await sharp(buffer, { animated: false }).metadata();
    } catch (error) {
        debugLog("metadata-static-failed", { error });
        return {};
    }
}

async function renderStickerFrameToImageBuffer(buffer, frameIndex, pageCount) {
    try {
        return await sharp(buffer, {
            animated: pageCount > 1,
            page: frameIndex,
            pages: 1,
        })
            .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
            .flatten({ background: "#ffffff" })
            .png()
            .toBuffer();
    } catch (error) {
        debugLog("convert-frame-failed", { error, frameIndex, pageCount });
        return null;
    }
}

async function convertStickerToImageBuffers(buffer, options = {}) {
    if (!buffer?.length) return [];

    if (!sharp) {
        if (!sharpWarningShown) {
            sharpWarningShown = true;
            warnOnce("[ANTI-NSFW] sharp gagal diload, pakai fallback ffmpeg untuk sticker.", {
                error: sharpLoadError?.message || "sharp tidak tersedia",
            });
        }
        return convertStickerToImageBuffersWithFfmpeg(buffer, options);
    }

    const config = getConfig();
    const metadata = await getStickerMetadata(buffer);
    const pageCount = Math.max(1, Number(metadata?.pages || 1));
    const frameIndexes = pickFrameIndexes(pageCount, options.maxFrames || config.maxFrames);
    const images = [];

    for (const frameIndex of frameIndexes) {
        const imageBuffer = await renderStickerFrameToImageBuffer(buffer, frameIndex, pageCount);
        if (!imageBuffer?.length) continue;

        images.push({
            imageBuffer,
            frameIndex,
            pageCount,
        });
    }

    return images;
}

async function convertStickerToImageBuffersWithFfmpeg(buffer, options = {}) {
    const config = getConfig();
    const maxFrames = Math.max(1, Number(options.maxFrames || config.maxFrames || 12));
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "anti-nsfw-sticker-"));
    const inputPath = path.join(tempDir, "input.webp");
    const outputPattern = path.join(tempDir, "frame-%04d.png");

    try {
        await fs.promises.writeFile(inputPath, buffer);

        const maxExtractedFrames = Math.max(maxFrames, 48);
        const args = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            inputPath,
            "-vf",
            "fps=10,scale=768:-2:force_original_aspect_ratio=decrease",
            "-frames:v",
            String(maxExtractedFrames),
            outputPattern,
        ];

        try {
            await execFileWithTimeout(process.env.FFMPEG_PATH || "ffmpeg", args, {
                timeoutMs: Math.max(config.timeoutMs, 20000),
            });
        } catch (error) {
            debugLog("ffmpeg-animated-failed", {
                error,
                errorMessage: error?.stderr || error.message,
            });
            await execFileWithTimeout(process.env.FFMPEG_PATH || "ffmpeg", [
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                inputPath,
                "-frames:v",
                "1",
                path.join(tempDir, "frame-0001.png"),
            ], {
                timeoutMs: Math.max(config.timeoutMs, 20000),
            });
        }

        const frameFiles = (await fs.promises.readdir(tempDir))
            .filter(name => /^frame-\d+\.png$/i.test(name))
            .sort();
        if (!frameFiles.length) return [];

        const selectedIndexes = pickFrameIndexes(frameFiles.length, maxFrames);
        const images = [];
        for (const index of selectedIndexes) {
            const fileName = frameFiles[index];
            if (!fileName) continue;
            const imageBuffer = await fs.promises.readFile(path.join(tempDir, fileName));
            images.push({
                imageBuffer,
                frameIndex: index,
                pageCount: frameFiles.length,
            });
        }

        return images;
    } catch (error) {
        debugLog("ffmpeg-convert-failed", {
            error,
            errorMessage: error?.stderr || error.message,
        });
        return [];
    } finally {
        await removeDirQuietly(tempDir);
    }
}

async function convertStickerToImageBuffer(buffer) {
    const images = await convertStickerToImageBuffers(buffer, { maxFrames: 1 });
    return images[0]?.imageBuffer || null;
}

function clampScore(value, fallback = 0) {
    const score = Number(value);
    if (!Number.isFinite(score)) return fallback;
    return Math.max(0, Math.min(1, score));
}

function emptyClassification(label = "safe", raw = {}) {
    return {
        isNsfw: false,
        score: 0,
        label,
        reason: raw?.reason || "",
        raw,
    };
}

function loadLocalClassifier() {
    if (localClassifierLoadAttempted) return localClassifier;
    localClassifierLoadAttempted = true;

    const classifierPath = String(process.env.ANTI_NSFW_STICKER_LOCAL_CLASSIFIER || "").trim();
    if (!classifierPath) {
        if (!localClassifierWarningShown) {
            localClassifierWarningShown = true;
            console.log("[ANTI-NSFW] Mode local dipilih, tetapi ANTI_NSFW_STICKER_LOCAL_CLASSIFIER belum diisi.");
        }
        return null;
    }

    try {
        const resolvedPath = path.isAbsolute(classifierPath)
            ? classifierPath
            : path.join(process.cwd(), classifierPath);
        localClassifier = require(resolvedPath);
    } catch (error) {
        localClassifier = null;
        if (!localClassifierWarningShown) {
            localClassifierWarningShown = true;
            console.log("[ANTI-NSFW] Gagal load local classifier.", {
                classifierPath,
                error: error.message,
            });
        }
    }

    return localClassifier;
}

function getHueSaturationValue(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const delta = max - min;
    let hue = 0;

    if (delta > 0) {
        if (max === rn) hue = 60 * (((gn - bn) / delta) % 6);
        else if (max === gn) hue = 60 * (((bn - rn) / delta) + 2);
        else hue = 60 * (((rn - gn) / delta) + 4);
    }

    if (hue < 0) hue += 360;

    return {
        hue,
        saturation: max === 0 ? 0 : delta / max,
        value: max,
    };
}

function isLikelySkinPixel(r, g, b, a) {
    if (a < 45) return false;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    const { hue, saturation, value } = getHueSaturationValue(r, g, b);
    const warmHue = hue <= 58 || hue >= 330;
    const notGray = max - min > 10 || saturation > 0.12;
    const notOverSaturatedRed = !(r > 170 && g < 80 && b < 80 && saturation > 0.72);

    const rgbLightSkin = r > 95 && g > 40 && b > 20 && max - min > 15 && Math.abs(r - g) > 10 && r > g && r > b;
    const ycbcrSkin = y > 28 && cb >= 76 && cb <= 145 && cr >= 128 && cr <= 188;
    const hsvSkin = warmHue && saturation >= 0.10 && saturation <= 0.78 && value >= 0.12 && r >= b * 0.78 && g >= b * 0.48;
    const darkSkin = y >= 22 && y <= 165 && cr >= 132 && cr <= 195 && cb >= 82 && cb <= 155 && warmHue && saturation >= 0.16;

    return notGray && notOverSaturatedRed && (rgbLightSkin || ycbcrSkin || hsvSkin || darkSkin);
}

function normalizeRange(value, low, high) {
    if (high <= low) return 0;
    return clampScore((value - low) / (high - low));
}

function analyzeSkinMask(mask, width, height) {
    const visited = new Uint8Array(mask.length);
    const stack = [];
    let largest = {
        count: 0,
        minX: 0,
        minY: 0,
        maxX: 0,
        maxY: 0,
    };

    for (let start = 0; start < mask.length; start += 1) {
        if (!mask[start] || visited[start]) continue;

        visited[start] = 1;
        stack.push(start);

        let count = 0;
        let minX = width;
        let minY = height;
        let maxX = 0;
        let maxY = 0;

        while (stack.length) {
            const index = stack.pop();
            const x = index % width;
            const y = Math.floor(index / width);

            count += 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            const neighbors = [
                x > 0 ? index - 1 : -1,
                x < width - 1 ? index + 1 : -1,
                y > 0 ? index - width : -1,
                y < height - 1 ? index + width : -1,
            ];

            for (const next of neighbors) {
                if (next < 0 || !mask[next] || visited[next]) continue;
                visited[next] = 1;
                stack.push(next);
            }
        }

        if (count > largest.count) {
            largest = { count, minX, minY, maxX, maxY };
        }
    }

    const boxWidth = Math.max(0, largest.maxX - largest.minX + 1);
    const boxHeight = Math.max(0, largest.maxY - largest.minY + 1);
    const boxArea = boxWidth * boxHeight;

    return {
        largestSkinCount: largest.count,
        largestBoxArea: boxArea,
        largestBoxFill: boxArea > 0 ? largest.count / boxArea : 0,
        largestBoxAspect: boxHeight > 0 ? boxWidth / boxHeight : 0,
    };
}

async function analyzeImageSkinExposure(imageBuffer, config = getConfig()) {
    const { data, info } = await getRgbaPixelsForAnalysis(imageBuffer, config);
    const width = info.width;
    const height = info.height;
    const mask = new Uint8Array(width * height);
    const centerMinX = Math.floor(width * 0.16);
    const centerMaxX = Math.ceil(width * 0.84);
    const centerMinY = Math.floor(height * 0.12);
    const centerMaxY = Math.ceil(height * 0.92);
    let opaqueCount = 0;
    let skinCount = 0;
    let centerOpaqueCount = 0;
    let centerSkinCount = 0;

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const pixelIndex = y * width + x;
            const dataIndex = pixelIndex * 4;
            const r = data[dataIndex];
            const g = data[dataIndex + 1];
            const b = data[dataIndex + 2];
            const a = data[dataIndex + 3];
            const isOpaque = a >= 45;
            const isCenter = x >= centerMinX && x <= centerMaxX && y >= centerMinY && y <= centerMaxY;

            if (!isOpaque) continue;

            opaqueCount += 1;
            if (isCenter) centerOpaqueCount += 1;

            if (!isLikelySkinPixel(r, g, b, a)) continue;

            skinCount += 1;
            mask[pixelIndex] = 1;
            if (isCenter) centerSkinCount += 1;
        }
    }

    const component = analyzeSkinMask(mask, width, height);
    return {
        width,
        height,
        opaqueCount,
        skinCount,
        skinRatio: opaqueCount > 0 ? skinCount / opaqueCount : 0,
        centerSkinRatio: centerOpaqueCount > 0 ? centerSkinCount / centerOpaqueCount : 0,
        largestSkinRatio: opaqueCount > 0 ? component.largestSkinCount / opaqueCount : 0,
        largestBoxRatio: opaqueCount > 0 ? component.largestBoxArea / opaqueCount : 0,
        largestBoxFill: component.largestBoxFill,
        largestBoxAspect: component.largestBoxAspect,
    };
}

async function getRgbaPixelsForAnalysis(imageBuffer, config = getConfig()) {
    if (sharp) {
        const scanSize = config.localScanSize || LOCAL_SCAN_SIZE;
        return sharp(imageBuffer)
            .resize({ width: scanSize, height: scanSize, fit: "inside", withoutEnlargement: true })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
    }

    const png = PNG.sync.read(imageBuffer);
    return {
        data: png.data,
        info: {
            width: png.width,
            height: png.height,
            channels: 4,
        },
    };
}

function classifyNsfwWithHeuristicStats(stats, config = getConfig()) {
    if (!stats || stats.opaqueCount < 80) return emptyClassification("safe", { reason: "gambar terlalu kecil/transparan" });

    const exposureScore = normalizeRange(stats.skinRatio, 0.24, 0.58);
    const clusterScore = normalizeRange(stats.largestSkinRatio, 0.16, 0.44);
    const centerScore = normalizeRange(stats.centerSkinRatio, 0.26, 0.62);
    const bodyShapeScore = stats.largestBoxRatio >= 0.24 && stats.largestBoxFill >= 0.34 ? 0.12 : 0;
    const balancedAspectScore = stats.largestBoxAspect >= 0.25 && stats.largestBoxAspect <= 2.6 ? 0.06 : 0;
    let score = clampScore(
        0.07
        + exposureScore * 0.38
        + clusterScore * 0.34
        + centerScore * 0.18
        + bodyShapeScore
        + balancedAspectScore
    );

    if (stats.skinRatio < 0.20 || stats.largestSkinRatio < 0.12) score = Math.min(score, 0.58);
    if (stats.skinRatio >= 0.48 && stats.largestSkinRatio >= 0.30) score = Math.max(score, 0.86);
    if (stats.skinRatio >= 0.36 && stats.largestSkinRatio >= 0.24 && stats.centerSkinRatio >= 0.34) score = Math.max(score, 0.78);

    const isNsfw = score >= config.threshold;
    const label = isNsfw
        ? "indikasi-ketelanjangan"
        : score >= config.warnThreshold
            ? "review-konten-sensitif"
            : "safe";
    const reason = isNsfw
        ? "area tubuh/kulit tampak dominan pada stiker"
        : score >= config.warnThreshold
            ? "area kulit cukup besar, perlu review"
            : "tidak ada indikasi kuat konten dewasa";

    return {
        isNsfw,
        score,
        label,
        reason,
        raw: stats,
    };
}

async function classifyNsfwWithHeuristic(imageBuffer, config = getConfig()) {
    if (!imageBuffer?.length) return emptyClassification("empty-image", { mode: config.mode });

    try {
        const stats = await analyzeImageSkinExposure(imageBuffer, config);
        return classifyNsfwWithHeuristicStats(stats, config);
    } catch (error) {
        debugLog("classify-heuristic-failed", { error });
        return emptyClassification("heuristic-error", {
            mode: config.mode,
            error: error.message,
        });
    }
}

async function loadNsfwAiModel(config = getConfig()) {
    if (!nsfwAiModelPromise) {
        nsfwAiModelPromise = (async () => {
            await tf.ready();
            const modelUrl = config.aiModel || undefined;
            return nsfwjs.load(modelUrl, {
                size: config.aiImageSize || DEFAULT_AI_IMAGE_SIZE,
            });
        })();
    }

    return nsfwAiModelPromise;
}

async function getRgbPixelsForAi(imageBuffer, config = getConfig()) {
    if (sharp) {
        const size = config.aiImageSize || DEFAULT_AI_IMAGE_SIZE;
        return sharp(imageBuffer)
            .resize({ width: size, height: size, fit: "fill" })
            .flatten({ background: "#ffffff" })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
    }

    const png = PNG.sync.read(imageBuffer);
    const size = config.aiImageSize || DEFAULT_AI_IMAGE_SIZE;
    const rgb = resizePngRgbaToRgbSquare(png, size);

    return {
        data: rgb,
        info: {
            width: size,
            height: size,
            channels: 3,
        },
    };
}

function resizePngRgbaToRgbSquare(png, size) {
    const output = Buffer.alloc(size * size * 3);
    const sourceWidth = png.width;
    const sourceHeight = png.height;

    for (let y = 0; y < size; y += 1) {
        const sourceY = Math.min(sourceHeight - 1, Math.floor((y / size) * sourceHeight));
        for (let x = 0; x < size; x += 1) {
            const sourceX = Math.min(sourceWidth - 1, Math.floor((x / size) * sourceWidth));
            const source = (sourceY * sourceWidth + sourceX) * 4;
            const target = (y * size + x) * 3;
            const alpha = png.data[source + 3] / 255;

            output[target] = Math.round(png.data[source] * alpha + 255 * (1 - alpha));
            output[target + 1] = Math.round(png.data[source + 1] * alpha + 255 * (1 - alpha));
            output[target + 2] = Math.round(png.data[source + 2] * alpha + 255 * (1 - alpha));
        }
    }

    return output;
}

function getScoreForLabels(results, matchers) {
    let score = 0;
    for (const item of Array.isArray(results) ? results : []) {
        const label = String(item?.label || item?.className || "").trim().toLowerCase();
        if (!label || !matchers.some(matcher => matcher.test(label))) continue;
        score = Math.max(score, clampScore(item?.score ?? item?.probability));
    }
    return score;
}

function normalizeAiClassification(results, config = getConfig()) {
    const nsfwScore = getScoreForLabels(results, [/porn/, /hentai/, /sexy/, /nsfw/, /explicit/, /adult/, /unsafe/]);
    const sfwScore = getScoreForLabels(results, [/neutral/, /drawing/, /^sfw$/, /safe/]);
    const top = Array.isArray(results) && results.length ? results[0] : null;
    const score = nsfwScore > 0 ? nsfwScore : Math.max(0, 1 - sfwScore);
    const isNsfw = score >= config.threshold;
    const label = isNsfw
        ? "ai-nsfw"
        : score >= config.warnThreshold
            ? "ai-review"
            : "safe";
    const reason = isNsfw
        ? "model AI lokal mendeteksi indikasi konten dewasa/NSFW"
        : score >= config.warnThreshold
            ? "model AI lokal memberi skor sensitif menengah"
            : "model AI lokal menilai stiker aman";

    return {
        isNsfw,
        score,
        label,
        reason,
        raw: {
            model: config.aiModel || "nsfwjs-default",
            topLabel: top?.label || top?.className || null,
            topScore: top?.score ?? top?.probability ?? null,
            results,
        },
    };
}

async function classifyNsfwWithAi(imageBuffer, config = getConfig()) {
    if (!imageBuffer?.length) return emptyClassification("empty-image", { mode: config.mode });

    try {
        const { data, info } = await getRgbPixelsForAi(imageBuffer, config);
        const model = await withTimeout(
            loadNsfwAiModel(config),
            Math.max(config.timeoutMs, 30000),
            "anti-nsfw local AI model load"
        );
        const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, info.channels], "int32");
        try {
            const results = await withTimeout(
                model.classify(tensor),
                Math.max(config.timeoutMs, 30000),
                "anti-nsfw local AI classifier"
            );
            return normalizeAiClassification(results, config);
        } finally {
            tensor.dispose();
        }
    } catch (error) {
        debugLog("classify-ai-failed-fallback-heuristic", { error });
        const fallback = await classifyNsfwWithHeuristic(imageBuffer, config);
        return {
            ...fallback,
            label: fallback.label === "safe" ? "ai-fallback-safe" : `ai-fallback-${fallback.label}`,
            reason: fallback.reason || "model AI lokal gagal, memakai fallback heuristic",
            raw: {
                aiError: error.message,
                fallback: fallback.raw,
            },
        };
    }
}

async function classifyNsfw(imageBuffer) {
    const config = getConfig();

    if (config.mode === "disabled") {
        return emptyClassification("disabled", { mode: config.mode });
    }

    if (config.mode === "placeholder") {
        if (!classifierWarningShown) {
            classifierWarningShown = true;
            console.log("[ANTI-NSFW] Classifier belum dipasang. Set ANTI_NSFW_STICKER_MODE=local setelah model tersedia.");
        }
        return emptyClassification("placeholder", { mode: config.mode });
    }

    if (["ai", "ml", "tfjs", "nsfwjs", "local-ai", "local_ai"].includes(config.mode)) {
        return classifyNsfwWithAi(imageBuffer, config);
    }

    if (["heuristic", "offline", "free", "local-heuristic", "local_heuristic"].includes(config.mode)) {
        return classifyNsfwWithHeuristic(imageBuffer, config);
    }

    if (config.mode === "local") {
        const classifier = loadLocalClassifier();
        if (!classifier) return emptyClassification("local-unavailable", { mode: config.mode });

        try {
            const classifyFn = typeof classifier === "function"
                ? classifier
                : classifier.classifyNsfw || classifier.classify || classifier.predict;
            if (typeof classifyFn !== "function") {
                throw new Error("local classifier tidak mengekspor fungsi classify");
            }

            const result = await withTimeout(
                Promise.resolve(classifyFn(imageBuffer, config)),
                config.timeoutMs,
                "anti-nsfw local classifier"
            );
            const score = Math.max(0, Math.min(1, Number(result?.score || 0)));
            const label = String(result?.label || (score >= config.threshold ? "nsfw" : "safe")).trim() || "unknown";
            return {
                isNsfw: Boolean(result?.isNsfw ?? score >= config.threshold),
                score,
                label,
                raw: result || {},
            };
        } catch (error) {
            debugLog("classify-local-failed", { error });
            return emptyClassification("local-error", { mode: config.mode, error: error.message });
        }
    }

    if (!classifierWarningShown) {
        classifierWarningShown = true;
        console.log("[ANTI-NSFW] Mode classifier tidak dikenal, fitur anti-NSFW sticker dilewati.", {
            mode: config.mode,
        });
    }
    return emptyClassification("unknown-mode", { mode: config.mode });
}

function getOwnerJids(sock, ownerJids = []) {
    const envOwners = [
        process.env.ANTI_NSFW_STICKER_OWNER_JIDS,
        process.env.OWNER_JID,
        process.env.ACTIVE_NOTIFY_JIDS,
    ]
        .filter(Boolean)
        .join(",")
        .split(",")
        .map(item => String(item || "").trim())
        .filter(Boolean);

    const botId = sock?.user?.id || sock?.authState?.creds?.me?.id || "";
    const botNumber = String(botId).split(":")[0].replace(/[^0-9]/g, "");
    const botJid = botNumber ? `${botNumber}@s.whatsapp.net` : null;

    return [...new Set([...ownerJids, ...envOwners, botJid]
        .map(normalizeOwnerJid)
        .filter(Boolean))];
}

function normalizeOwnerJid(value) {
    const clean = String(value || "").trim();
    if (!clean) return null;
    if (clean.endsWith("@s.whatsapp.net")) return clean;

    const number = clean.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
    return number ? `${number}@s.whatsapp.net` : null;
}

function getTimestampText(timestamp) {
    const raw = Number(timestamp || 0);
    const ms = raw > 1000000000000 ? raw : raw * 1000;
    if (!Number.isFinite(ms) || ms <= 0) return new Date().toLocaleString("id-ID", { hour12: false });

    try {
        return new Date(ms).toLocaleString("id-ID", {
            timeZone: process.env.TZ || "Asia/Jakarta",
            hour12: false,
        });
    } catch {
        return new Date(ms).toISOString();
    }
}

async function sendOwnerReport(sock, msg, classification, options = {}, level = "detected") {
    const ownerJids = getOwnerJids(sock, options.ownerJids || []);
    if (!ownerJids.length) return false;

    const remoteJid = msg?.key?.remoteJid || "";
    const senderJid = getSenderJid(msg);
    const lines = [
        level === "warning" ? "*ANTI-NSFW STICKER REVIEW*" : "*ANTI-NSFW STICKER TERDETEKSI*",
        `Pengirim: ${getJidLabel(senderJid)} (${senderJid || "-"})`,
        `Lokasi: ${isGroupJid(remoteJid) ? `Grup ${getJidLabel(remoteJid)}` : `Chat ${getJidLabel(remoteJid)}`}`,
        `Message ID: ${msg?.key?.id || "-"}`,
        `Score: ${Number(classification?.score || 0).toFixed(3)}`,
        `Label: ${classification?.label || "-"}`,
        `Alasan: ${classification?.reason || "-"}`,
        `Waktu: ${getTimestampText(msg?.messageTimestamp)}`,
    ];

    let sent = false;
    for (const ownerJid of ownerJids) {
        try {
            await sock.sendMessage(ownerJid, { text: lines.join("\n") });
            sent = true;
        } catch (error) {
            console.log("[ANTI-NSFW] Gagal kirim report owner.", {
                ownerJid,
                error: error.message,
            });
        }
    }

    return sent;
}

async function sendChatWarning(sock, msg, classification) {
    const remoteJid = msg?.key?.remoteJid || "";
    const senderJid = getSenderJid(msg);
    const mentions = isGroupJid(remoteJid) && senderJid ? [senderJid] : [];
    const mentionPrefix = mentions.length ? `@${getJidLabel(senderJid)} ` : "";
    const detectedLabel = String(classification?.label || "konten dewasa").replace(/[_-]+/g, " ");
    const reason = String(classification?.reason || "").trim();
    const reasonText = reason ? `\nTerdeteksi: ${reason}` : "";

    await sock.sendMessage(remoteJid, {
        text:
            `*ANTI-NSFW STICKER*\n` +
            `${mentionPrefix}stiker ini terindikasi memuat *${detectedLabel}*.${reasonText}\n\n` +
            "Ruang chat bukan tempat lempar konten 18+. Tolong hentikan pengiriman gambar/stiker bernuansa pornografi atau ketelanjangan.\n\n" +
            "Catatan hukum singkat: UU ITE Pasal 27 ayat (1) melarang penyebaran/transmisi dokumen elektronik bermuatan melanggar kesusilaan untuk diketahui umum; sanksinya dirujuk di Pasal 45 ayat (1).\n\n" +
            "Jaga grup tetap aman, sopan, dan nyaman buat semua.",
        mentions,
    }, { quoted: msg });

    debugLog("warning-sent", {
        id: msg?.key?.id,
        remoteJid,
        senderJid,
        score: classification?.score,
        label: classification?.label,
        reason: classification?.reason,
    });
    return true;
}

async function deleteStickerMessage(sock, msg) {
    const remoteJid = msg?.key?.remoteJid || "";
    if (!remoteJid || !msg?.key?.id) return false;

    try {
        await sock.sendMessage(remoteJid, { delete: msg.key });
        return true;
    } catch (error) {
        console.log("[ANTI-NSFW] Gagal hapus sticker NSFW.", {
            id: msg?.key?.id,
            remoteJid,
            error: error.message,
        });
        return false;
    }
}

function shouldWarn(action) {
    return action === "warn" || action === "warn_delete";
}

function shouldReport(action) {
    return action === "report";
}

function shouldDelete(action) {
    return action === "delete" || action === "warn_delete";
}

async function handleNsfwSticker(sock, msg, options = {}) {
    const config = getConfig();
    const stickerMessage = getStickerMessage(msg);
    const remoteJid = msg?.key?.remoteJid || "";
    const senderJid = getSenderJid(msg);
    const auditBase = {
        id: msg?.key?.id,
        remoteJid,
        remoteJidAlt: msg?.key?.remoteJidAlt,
        participant: msg?.key?.participant || msg?.participant,
        fromMe: Boolean(msg?.key?.fromMe),
        senderJid,
        enabled: config.enabled,
        mode: config.mode,
        threshold: config.threshold,
        warnThreshold: config.warnThreshold,
        maxFrames: config.maxFrames,
        warnFromMe: config.warnFromMe,
        hasSticker: Boolean(stickerMessage),
        messageTypes: Object.keys(msg?.message || {}),
    };

    if (stickerMessage || auditBase.messageTypes.includes("stickerMessage")) {
        auditLog("enter", auditBase);
    }

    if (!config.enabled) {
        if (stickerMessage) auditLog("skip", { ...auditBase, reason: "disabled" });
        return false;
    }
    if (!sock || !msg?.message || !msg?.key?.id) {
        if (stickerMessage) auditLog("skip", { ...auditBase, reason: "invalid-message" });
        return false;
    }
    if (msg.key.fromMe && !config.warnFromMe) {
        if (stickerMessage) auditLog("skip", { ...auditBase, reason: "from-me" });
        return false;
    }

    if (!remoteJid || isStatusJid(remoteJid) || isNewsletterJid(remoteJid)) {
        if (stickerMessage) auditLog("skip", { ...auditBase, reason: "unsupported-chat" });
        return false;
    }

    if (!stickerMessage) return false;

    const startedAt = Date.now();
    const cacheKey = getCacheKey(msg, stickerMessage);
    let classification = cacheKey ? nsfwCache.get(cacheKey) : null;

    if (!classification) {
        const hasLocalClassifierPath = Boolean(String(process.env.ANTI_NSFW_STICKER_LOCAL_CLASSIFIER || "").trim());
        if (config.mode === "disabled" || config.mode === "placeholder" || (config.mode === "local" && !hasLocalClassifierPath)) {
            classification = await classifyNsfw(null);
            rememberCache(cacheKey, classification);
            debugLog("classifier-unavailable-skip-media", {
                id: msg.key.id,
                remoteJid,
                senderJid,
                score: classification.score,
                label: classification.label,
                durationMs: Date.now() - startedAt,
            });
            return false;
        }

        const stickerBuffer = await downloadStickerBuffer(stickerMessage, {
            timeoutMs: config.timeoutMs,
            meta: { id: msg.key.id, remoteJid, senderJid },
        });
        if (!stickerBuffer?.length) {
            auditLog("skip", { ...auditBase, reason: "download-empty" });
            return false;
        }

        const imageCandidates = await convertStickerToImageBuffers(stickerBuffer, {
            maxFrames: config.maxFrames,
        });
        auditLog("decoded", {
            ...auditBase,
            stickerBytes: stickerBuffer.length,
            frameCount: imageCandidates.length,
        });
        if (!imageCandidates.length) {
            auditLog("skip", { ...auditBase, stickerBytes: stickerBuffer.length, reason: "no-decodable-frame" });
            return false;
        }

        let bestClassification = null;
        for (const candidate of imageCandidates) {
            const frameClassification = await classifyNsfw(candidate.imageBuffer);
            const enrichedClassification = {
                ...frameClassification,
                frameIndex: candidate.frameIndex,
                pageCount: candidate.pageCount,
            };

            debugLog("classified-frame", {
                id: msg.key.id,
                remoteJid,
                senderJid,
                score: enrichedClassification.score,
                label: enrichedClassification.label,
                reason: enrichedClassification.reason,
                frameIndex: enrichedClassification.frameIndex,
                pageCount: enrichedClassification.pageCount,
                durationMs: Date.now() - startedAt,
            });

            if (
                !bestClassification
                || Number(enrichedClassification.score || 0) > Number(bestClassification.score || 0)
                || enrichedClassification.isNsfw === true
            ) {
                bestClassification = enrichedClassification;
            }

            if (enrichedClassification.isNsfw === true || Number(enrichedClassification.score || 0) >= config.threshold) {
                break;
            }
        }

        classification = bestClassification || emptyClassification("no-frame-classified");
        rememberCache(cacheKey, classification);
    } else {
        auditLog("cache-hit", { ...auditBase, cacheHit: true });
    }

    debugLog("classified", {
        id: msg.key.id,
        remoteJid,
        senderJid,
        score: classification.score,
        label: classification.label,
        reason: classification.reason,
        frameIndex: classification.frameIndex,
        pageCount: classification.pageCount,
        durationMs: Date.now() - startedAt,
    });

    const score = Number(classification.score || 0);
    const action = ["warn", "report", "delete", "warn_delete"].includes(config.action)
        ? config.action
        : "warn";

    if (score >= config.threshold || classification.isNsfw === true) {
        let acted = false;

        if (shouldWarn(action)) {
            acted = await sendChatWarning(sock, msg, classification).catch(error => {
                console.log("[ANTI-NSFW] Gagal kirim warning chat.", {
                    id: msg.key.id,
                    remoteJid,
                    error: error.message,
                });
                return false;
            }) || acted;
        }

        if (config.ownerReport || shouldReport(action)) {
            acted = await sendOwnerReport(sock, msg, classification, options, "detected") || acted;
        }

        if (shouldDelete(action)) {
            acted = await deleteStickerMessage(sock, msg) || acted;
        }

        console.log("[ANTI-NSFW] Sticker terdeteksi.", {
            id: msg.key.id,
            remoteJid,
            senderJid,
            score,
            label: classification.label,
            reason: classification.reason,
            frameIndex: classification.frameIndex,
            pageCount: classification.pageCount,
            action,
            durationMs: Date.now() - startedAt,
        });
        return acted;
    }

    if (score >= config.warnThreshold) {
        let acted = false;
        if (shouldWarn(action)) {
            acted = await sendChatWarning(sock, msg, classification).catch(error => {
                console.log("[ANTI-NSFW] Gagal kirim warning review chat.", {
                    id: msg.key.id,
                    remoteJid,
                    error: error.message,
                });
                return false;
            }) || acted;
        }
        if (config.ownerReport) {
            acted = await sendOwnerReport(sock, msg, classification, options, "warning") || acted;
        }
        debugLog("near-threshold", {
            id: msg.key.id,
            remoteJid,
            senderJid,
            score,
            label: classification.label,
            reason: classification.reason,
            frameIndex: classification.frameIndex,
            pageCount: classification.pageCount,
            durationMs: Date.now() - startedAt,
        });
        return acted;
    }

    return false;
}

module.exports = {
    isEnabled,
    isDebugEnabled,
    isGroupJid,
    isStatusJid,
    getSenderJid,
    getJidLabel,
    unwrapMediaMessage,
    getStickerMessage,
    getCacheKey,
    downloadStickerBuffer,
    convertStickerToImageBuffer,
    convertStickerToImageBuffers,
    classifyNsfw,
    handleNsfwSticker,
};
