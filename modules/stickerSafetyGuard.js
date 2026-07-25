"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

let tf = null;
let nsfwjs = null;
let sharp = null;
let sharpLoadError = null;
let sharpLoadAttempted = false;
let downloadContentFromMessage = null;
let pngjs = null;
let tfBackendName = "unknown";

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_PATH = path.join(DATA_DIR, "stickerSafetyGuard.json");
const WORDS_PATH = path.join(DATA_DIR, "stickerBadWords.json");
const CACHE_DIR = path.join(DATA_DIR, "sticker-safety-cache");
const RESULT_CACHE_PATH = path.join(CACHE_DIR, "results.json");
const TESSERACT_CACHE_DIR = path.join(DATA_DIR, "tesseract-cache");
const TMP_ROOT = path.join(__dirname, "..", "tmp", "sticker-safety");

const DEFAULT_STATE = {
    version: 1,
    global: {
        enabled: true,
        textEnabled: true,
        nsfwEnabled: true,
        debug: false,
        scanFromMe: true,
        warnFromMe: true,
    },
    groups: {},
};

const DEFAULT_WORD_STATE = {
    version: 1,
    words: [],
    updatedAt: 0,
};

const CATEGORY_NAMES = ["Porn", "Hentai", "Sexy", "Neutral", "Drawing"];
const recentMessageIds = new Map();
const recentStickerHashes = new Map();
const MESSAGE_DEDUPE_TTL_MS = 2 * 60 * 1000;
const HASH_DEDUPE_TTL_MS = 30 * 1000;
const NSFW_PIPELINE_VERSION = "sticker-nsfw-v3";

let stateCache = null;
let wordCache = null;
let resultCache = null;

let ocrWorkerPromise = null;
let ocrWorker = null;
let ocrStatus = "MISSING";
let ocrDetail = "";
let ocrLangsActive = "";

let nsfwModelPromise = null;
let nsfwModel = null;
let nsfwStatus = "MISSING";
let nsfwDetail = "";
let nsfwRuntimeStats = {
    lastScanAt: 0,
    lastResult: "never",
    lastCategory: null,
    lastConfidence: 0,
    lastFrames: 0,
    lastRegions: 0,
    lastDurationMs: 0,
    lastReason: "",
};

let activeJobs = 0;
const queue = [];
let disposed = false;

function parseBool(value, fallback = false) {
    const clean = String(value ?? "").trim();
    if (!clean) return fallback;
    if (/^(1|true|yes|on|aktif|enabled|enable)$/i.test(clean)) return true;
    if (/^(0|false|no|off|mati|disabled|disable)$/i.test(clean)) return false;
    return fallback;
}

function parseNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function getRuntimeConfig() {
    const pornThreshold = clampProbability(process.env.STICKER_NSFW_PORN_THRESHOLD, 0.55);
    const hentaiThreshold = clampProbability(process.env.STICKER_NSFW_HENTAI_THRESHOLD, 0.45);
    const sexyThreshold = clampProbability(process.env.STICKER_NSFW_SEXY_THRESHOLD, 0.72);
    return {
        maxFrames: Math.max(1, Math.min(12, Math.floor(parseNumber(process.env.STICKER_SAFETY_MAX_FRAMES, 9)))),
        maxFileBytes: Math.max(1, parseNumber(process.env.STICKER_SAFETY_MAX_FILE_MB, 8) * 1024 * 1024),
        ffmpegTimeoutMs: Math.max(1000, parseNumber(process.env.STICKER_SAFETY_FFMPEG_TIMEOUT_MS, 25000)),
        ffmpegBin: String(process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg").trim() || "ffmpeg",
        ffprobeBin: String(process.env.FFPROBE_BIN || "ffprobe").trim() || "ffprobe",
        ocrScale: Math.max(1, Math.min(5, Math.floor(parseNumber(process.env.STICKER_OCR_SCALE, 3)))),
        ocrVariants: Math.max(1, Math.min(3, Math.floor(parseNumber(process.env.STICKER_OCR_VARIANTS, 2)))),
        ocrLangs: String(process.env.STICKER_OCR_LANGS || "ind+eng").trim() || "eng",
        nsfwModelName: normalizeModelName(process.env.STICKER_NSFW_MODEL || "MobileNetV2Mid"),
        nsfwPornThreshold: pornThreshold,
        nsfwHentaiThreshold: hentaiThreshold,
        nsfwSexyThreshold: sexyThreshold,
        nsfwHardThreshold: clampProbability(process.env.STICKER_NSFW_HARD_THRESHOLD, 0.85),
        nsfwCombinedThreshold: clampProbability(process.env.STICKER_NSFW_COMBINED_THRESHOLD, 0.62),
        nsfwTopMeanThreshold: clampProbability(process.env.STICKER_NSFW_TOP_MEAN_THRESHOLD, 0.55),
        nsfwCropTriggerThreshold: clampProbability(process.env.STICKER_NSFW_CROP_TRIGGER_THRESHOLD, 0.16),
        nsfwMaxRegions: Math.max(1, Math.min(5, Math.floor(parseNumber(process.env.STICKER_NSFW_MAX_REGIONS, 4)))),
        nsfwCropFrameCount: Math.max(1, Math.min(4, Math.floor(parseNumber(process.env.STICKER_NSFW_CROP_FRAME_COUNT, 3)))),
        nsfwRequireMultipleFrames: parseBool(process.env.STICKER_NSFW_REQUIRE_MULTIPLE_FRAMES, false),
        action: String(process.env.STICKER_SAFETY_ACTION || "warn").trim().toLowerCase(),
        cacheTtlMs: Math.max(1, parseNumber(process.env.STICKER_SAFETY_CACHE_TTL_HOURS, 168)) * 60 * 60 * 1000,
        cacheMax: Math.max(1, Math.floor(parseNumber(process.env.STICKER_SAFETY_CACHE_MAX, 1000))),
        concurrency: Math.max(1, Math.floor(parseNumber(process.env.STICKER_SAFETY_CONCURRENCY, 1))),
        queueMax: Math.max(0, Math.floor(parseNumber(process.env.STICKER_SAFETY_QUEUE_MAX, 20))),
        timeoutMs: Math.max(10000, parseNumber(process.env.STICKER_SAFETY_TIMEOUT_MS, 90000)),
        legacyFallback: parseBool(process.env.STICKER_SAFETY_LEGACY_FALLBACK, false),
    };
}

function clampProbability(value, fallback) {
    const number = parseNumber(value, fallback);
    return Math.max(0, Math.min(1, number));
}

function normalizeModelName(value) {
    const clean = String(value || "").trim();
    if (/^mobilenetv2mid$/i.test(clean)) return "MobileNetV2Mid";
    return "MobileNetV2";
}

function getTensorflow() {
    if (tf) return tf;
    try {
        tf = require("@tensorflow/tfjs-node");
        tfBackendName = "tensorflow-node";
    } catch {
        tf = require("@tensorflow/tfjs");
        tfBackendName = "tensorflow-js";
    }
    if (typeof tf.enableProdMode === "function") tf.enableProdMode();
    return tf;
}

function getPngJs() {
    if (!pngjs) pngjs = require("pngjs");
    return pngjs;
}

function getNsfwJs() {
    if (!nsfwjs) nsfwjs = require("nsfwjs");
    return nsfwjs;
}

function getBaileysDownloadContent() {
    if (!downloadContentFromMessage) {
        ({ downloadContentFromMessage } = require("@whiskeysockets/baileys"));
    }
    return downloadContentFromMessage;
}

function getSharp() {
    if (sharpLoadAttempted) return sharp;
    sharpLoadAttempted = true;
    try {
        sharp = require("sharp");
    } catch (error) {
        sharpLoadError = error;
        sharp = null;
    }
    return sharp;
}

function ensureDirs() {
    for (const dir of [DATA_DIR, CACHE_DIR, TESSERACT_CACHE_DIR, TMP_ROOT]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function safeStringify(value, space = 2) {
    return JSON.stringify(value, (key, item) => {
        if (typeof item === "bigint") return item.toString();
        if (Buffer.isBuffer(item)) return { type: "Buffer", length: item.length };
        return item;
    }, space);
}

function atomicWriteJson(filePath, value) {
    ensureDirs();
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, `${safeStringify(value, 2)}\n`);
    fs.renameSync(tmpPath, filePath);
}

function backupCorruptFile(filePath, label) {
    try {
        if (!fs.existsSync(filePath)) return;
        const backupPath = path.join(
            path.dirname(filePath),
            `${path.basename(filePath, ".json")}.corrupt.${Date.now()}.json`
        );
        fs.renameSync(filePath, backupPath);
        console.log(`[STICKER SAFETY] ${label} corrupt, backup: ${path.basename(backupPath)}`);
    } catch (error) {
        console.log(`[STICKER SAFETY] gagal backup ${label}: ${shortError(error)}`);
    }
}

function normalizeState(raw) {
    const base = raw && typeof raw === "object" ? raw : {};
    return {
        version: 1,
        global: {
            ...DEFAULT_STATE.global,
            ...(base.global && typeof base.global === "object" ? base.global : {}),
        },
        groups: base.groups && typeof base.groups === "object" ? base.groups : {},
    };
}

function loadState() {
    if (stateCache) return stateCache;
    ensureDirs();
    try {
        if (!fs.existsSync(STATE_PATH)) atomicWriteJson(STATE_PATH, DEFAULT_STATE);
        stateCache = normalizeState(JSON.parse(fs.readFileSync(STATE_PATH, "utf8") || "{}"));
    } catch (error) {
        backupCorruptFile(STATE_PATH, "state");
        stateCache = normalizeState(DEFAULT_STATE);
        saveState(stateCache);
    }
    return stateCache;
}

function saveState(state = stateCache) {
    stateCache = normalizeState(state);
    atomicWriteJson(STATE_PATH, stateCache);
    return stateCache;
}

function normalizeWordState(raw) {
    const words = Array.isArray(raw?.words)
        ? raw.words.map(item => String(item || "").trim().toLowerCase()).filter(Boolean)
        : [];
    return {
        version: 1,
        words: [...new Set(words)].sort((a, b) => a.localeCompare(b)),
        updatedAt: Number(raw?.updatedAt || 0),
    };
}

function loadWordState() {
    if (wordCache) return wordCache;
    ensureDirs();
    try {
        if (!fs.existsSync(WORDS_PATH)) atomicWriteJson(WORDS_PATH, DEFAULT_WORD_STATE);
        wordCache = normalizeWordState(JSON.parse(fs.readFileSync(WORDS_PATH, "utf8") || "{}"));
    } catch (error) {
        backupCorruptFile(WORDS_PATH, "word list");
        wordCache = normalizeWordState(DEFAULT_WORD_STATE);
        saveWordState(wordCache);
    }
    return wordCache;
}

function saveWordState(state = wordCache) {
    wordCache = normalizeWordState({
        ...state,
        updatedAt: Date.now(),
    });
    atomicWriteJson(WORDS_PATH, wordCache);
    return wordCache;
}

function loadResultCache() {
    if (resultCache) return resultCache;
    ensureDirs();
    try {
        if (!fs.existsSync(RESULT_CACHE_PATH)) atomicWriteJson(RESULT_CACHE_PATH, {});
        const parsed = JSON.parse(fs.readFileSync(RESULT_CACHE_PATH, "utf8") || "{}");
        resultCache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        backupCorruptFile(RESULT_CACHE_PATH, "result cache");
        resultCache = {};
        saveResultCache();
    }
    return resultCache;
}

function saveResultCache() {
    pruneResultCache();
    atomicWriteJson(RESULT_CACHE_PATH, resultCache || {});
}

function pruneResultCache(now = Date.now()) {
    const config = getRuntimeConfig();
    const cache = resultCache || {};
    for (const [hash, item] of Object.entries(cache)) {
        if (!item?.expiresAt || item.expiresAt <= now) delete cache[hash];
    }

    const entries = Object.entries(cache);
    if (entries.length > config.cacheMax) {
        entries
            .sort((a, b) => Number(a[1]?.createdAt || 0) - Number(b[1]?.createdAt || 0))
            .slice(0, entries.length - config.cacheMax)
            .forEach(([hash]) => delete cache[hash]);
    }
}

function getCacheRecord(hash) {
    const cache = loadResultCache();
    const item = cache[hash];
    if (!item) return null;
    if (!item.expiresAt || item.expiresAt <= Date.now()) {
        delete cache[hash];
        saveResultCache();
        return null;
    }
    return item;
}

function setCacheRecord(hash, value) {
    const config = getRuntimeConfig();
    const now = Date.now();
    const cache = loadResultCache();
    cache[hash] = {
        ...value,
        createdAt: now,
        expiresAt: now + config.cacheTtlMs,
    };
    resultCache = cache;
    saveResultCache();
}

function shortError(error) {
    return String(error?.message || error || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function isGroupJid(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@g.us");
}

function normalizeJid(value) {
    return String(value || "").trim().toLowerCase();
}

function getSenderJid(msg) {
    const remoteJid = msg?.key?.remoteJid || "";
    if (isGroupJid(remoteJid)) return msg?.key?.participant || msg?.participant || remoteJid;
    return msg?.key?.participant || msg?.participant || remoteJid;
}

function getJidLabel(jid) {
    return String(jid || "").split("@")[0].split(":")[0].split("_")[0] || "user";
}

function unique(items) {
    return [...new Set((items || []).filter(Boolean))];
}

function getEffectiveConfig(groupJid = "", context = {}) {
    const state = loadState();
    const jid = normalizeJid(groupJid);
    const groupConfig = isGroupJid(jid) && state.groups[jid] && typeof state.groups[jid] === "object"
        ? state.groups[jid]
        : {};
    const merged = {
        ...DEFAULT_STATE.global,
        ...(state.global || {}),
        ...groupConfig,
    };

    const groupRemoteControl = context.groupRemoteControl;
    if (isGroupJid(jid) && groupRemoteControl?.isGroupFeatureEnabled) {
        if (!groupRemoteControl.isGroupFeatureEnabled(jid, "stickerSafety")) merged.enabled = false;
        if (!groupRemoteControl.isGroupFeatureEnabled(jid, "stickerText")) merged.textEnabled = false;
        if (!groupRemoteControl.isGroupFeatureEnabled(jid, "stickerNsfw")) merged.nsfwEnabled = false;
    }

    return {
        enabled: merged.enabled !== false,
        textEnabled: merged.textEnabled !== false,
        nsfwEnabled: merged.nsfwEnabled !== false,
        debug: merged.debug === true,
        scanFromMe: merged.scanFromMe !== false,
        warnFromMe: merged.warnFromMe !== false,
        isGroupCustom: Boolean(groupConfig && Object.keys(groupConfig).length),
    };
}

function unwrapMessage(message) {
    let current = message || {};
    for (let i = 0; i < 8; i += 1) {
        if (current?.ephemeralMessage?.message) current = current.ephemeralMessage.message;
        else if (current?.viewOnceMessage?.message) current = current.viewOnceMessage.message;
        else if (current?.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
        else if (current?.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message;
        else if (current?.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
        else break;
    }
    return current || {};
}

function extractStickerMessage(msgOrMessage) {
    const message = msgOrMessage?.message ? msgOrMessage.message : msgOrMessage;
    return unwrapMessage(message)?.stickerMessage || null;
}

function isStickerMessage(msgOrMessage) {
    return Boolean(extractStickerMessage(msgOrMessage));
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
    const next = { ...media };
    for (const key of ["mediaKey", "fileSha256", "fileEncSha256", "jpegThumbnail"]) {
        if (next[key]) next[key] = reviveBuffer(next[key]);
    }
    return next;
}

function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

async function downloadStickerBuffer(stickerMessage, options = {}) {
    const config = getRuntimeConfig();
    return withTimeout((async () => {
            const stream = await getBaileysDownloadContent()(
            normalizeDownloadableMedia(stickerMessage),
            "sticker"
        );
        const chunks = [];
        let total = 0;
        for await (const chunk of stream) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buffer.length;
            if (total > config.maxFileBytes) {
                throw new Error(`sticker lebih besar dari batas ${Math.round(config.maxFileBytes / 1024 / 1024)}MB`);
            }
            chunks.push(buffer);
        }
        return Buffer.concat(chunks);
    })(), options.timeoutMs || config.timeoutMs, "Sticker download");
}

function sha256(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

function execFileWithTimeout(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        let done = false;
        const child = execFile(command, args, {
            windowsHide: true,
            maxBuffer: options.maxBuffer || 1024 * 1024,
        }, (error, stdout, stderr) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (error) {
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });

        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            try {
                child.kill("SIGKILL");
            } catch {}
            reject(new Error(`${command} timeout`));
        }, options.timeoutMs || getRuntimeConfig().ffmpegTimeoutMs);
        if (typeof timer.unref === "function") timer.unref();
    });
}

async function fileExists(filePath) {
    try {
        await fs.promises.access(filePath, fs.constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function buildEvenSampleTimestamps(durationSeconds, maxFrames) {
    const duration = Number(durationSeconds);
    const count = Math.max(1, Math.floor(Number(maxFrames) || 1));
    if (!Number.isFinite(duration) || duration <= 0 || count === 1) return [0];
    const safeEnd = Math.max(0, duration - Math.min(0.04, duration / 20));
    return Array.from({ length: count }, (_, index) => {
        const ratio = count === 1 ? 0 : index / (count - 1);
        return Number((safeEnd * ratio).toFixed(3));
    });
}

async function probeMediaDuration(inputPath, config = getRuntimeConfig()) {
    try {
        const { stdout } = await execFileWithTimeout(config.ffprobeBin, [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            inputPath,
        ], { timeoutMs: Math.min(config.ffmpegTimeoutMs, 12000) });
        const duration = Number(String(stdout || "").trim());
        return Number.isFinite(duration) && duration > 0 ? duration : 0;
    } catch {
        return 0;
    }
}

async function extractFrameAtTimestamp(inputPath, outputPath, timestamp, config) {
    await execFileWithTimeout(config.ffmpegBin, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-ss", String(Math.max(0, Number(timestamp) || 0)),
        "-i", inputPath,
        "-frames:v", "1",
        "-vf", "scale='min(640,iw)':-1:flags=lanczos",
        outputPath,
    ], { timeoutMs: config.ffmpegTimeoutMs });
}

async function extractSequentialFrames(inputPath, outputPattern, maxFrames, config) {
    await execFileWithTimeout(config.ffmpegBin, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", inputPath,
        "-vf", "fps=4,scale='min(640,iw)':-1:flags=lanczos",
        "-frames:v", String(maxFrames),
        outputPattern,
    ], { timeoutMs: config.ffmpegTimeoutMs });
}

async function extractStickerFrames(buffer, stickerMessage = {}, options = {}) {
    ensureDirs();
    const config = getRuntimeConfig();
    const maxFrames = Math.max(1, Math.min(config.maxFrames, Number(options.maxFrames || config.maxFrames)));
    const tempDir = await fs.promises.mkdtemp(path.join(TMP_ROOT, "job-"));
    const inputPath = path.join(tempDir, "sticker.webp");
    const outputPattern = path.join(tempDir, "frame_%03d.png");
    await fs.promises.writeFile(inputPath, buffer);

    const animated = Boolean(stickerMessage?.isAnimated);
    let duration = 0;
    let sampleTimestamps = [0];
    try {
        if (animated) {
            duration = await probeMediaDuration(inputPath, config);
            sampleTimestamps = buildEvenSampleTimestamps(duration, maxFrames);
            if (duration > 0) {
                for (let index = 0; index < sampleTimestamps.length; index += 1) {
                    const outputPath = path.join(tempDir, `frame_${String(index + 1).padStart(3, "0")}.png`);
                    await extractFrameAtTimestamp(inputPath, outputPath, sampleTimestamps[index], config);
                }
            } else {
                await extractSequentialFrames(inputPath, outputPattern, maxFrames, config);
            }
        } else {
            await extractFrameAtTimestamp(inputPath, path.join(tempDir, "frame_001.png"), 0, config);
        }
    } catch (error) {
        const sharpRuntime = getSharp();
        if (!sharpRuntime) throw new Error(`ffmpeg gagal ekstrak frame dan sharp tidak tersedia: ${shortError(error)}`);
        const fallbackPath = path.join(tempDir, "frame_001.png");
        await sharpRuntime(buffer, { animated: false })
            .flatten({ background: "#ffffff" })
            .png()
            .toFile(fallbackPath);
        duration = 0;
        sampleTimestamps = [0];
    }

    const files = (await fs.promises.readdir(tempDir))
        .filter(name => /^frame_\d+\.png$/i.test(name))
        .sort()
        .slice(0, maxFrames);

    const frames = [];
    for (let i = 0; i < files.length; i += 1) {
        const filePath = path.join(tempDir, files[i]);
        frames.push({
            index: i,
            path: filePath,
            buffer: await fs.promises.readFile(filePath),
            timestamp: sampleTimestamps[i] ?? null,
        });
    }

    if (!frames.length) throw new Error("frame sticker kosong");

    return {
        type: animated ? "animated" : "static",
        animated,
        duration,
        sampleTimestamps,
        tempDir,
        frames,
    };
}

async function preprocessFrameForOcr(frame, options = {}) {
    const config = getRuntimeConfig();
    const variants = [];
    const inputBuffer = Buffer.isBuffer(frame) ? frame : frame?.buffer;
    if (!inputBuffer) return variants;

    const maxVariants = Math.max(1, Math.min(3, Number(options.variants || config.ocrVariants)));
    const scale = Math.max(1, Math.min(5, Number(options.scale || config.ocrScale)));

    const sharpRuntime = getSharp();
    if (sharpRuntime) {
        variants.push(await sharpRuntime(inputBuffer)
            .flatten({ background: "#ffffff" })
            .resize({ width: Math.round(512 * scale), withoutEnlargement: false, fit: "inside" })
            .grayscale()
            .sharpen()
            .png()
            .toBuffer());

        if (maxVariants >= 2) {
            variants.push(await sharpRuntime(inputBuffer)
                .flatten({ background: "#000000" })
                .resize({ width: Math.round(512 * scale), withoutEnlargement: false, fit: "inside" })
                .grayscale()
                .linear(1.6, -40)
                .threshold(150)
                .png()
                .toBuffer());
        }

        if (maxVariants >= 3) {
            variants.push(await sharpRuntime(inputBuffer)
                .flatten({ background: "#ffffff" })
                .resize({ width: Math.round(512 * scale), withoutEnlargement: false, fit: "inside" })
                .negate()
                .grayscale()
                .threshold(120)
                .png()
                .toBuffer());
        }
        return variants.slice(0, maxVariants);
    }

    if (frame?.path) {
        const tempDir = path.dirname(frame.path);
        const out1 = path.join(tempDir, `ocr_${frame.index || 0}_1.png`);
        await execFileWithTimeout(config.ffmpegBin, [
            "-y", "-hide_banner", "-loglevel", "error",
            "-i", frame.path,
            "-vf", `scale=iw*${scale}:ih*${scale},format=gray,unsharp=5:5:1.0`,
            out1,
        ], { timeoutMs: config.ffmpegTimeoutMs });
        variants.push(await fs.promises.readFile(out1));

        if (maxVariants >= 2) {
            const out2 = path.join(tempDir, `ocr_${frame.index || 0}_2.png`);
            await execFileWithTimeout(config.ffmpegBin, [
                "-y", "-hide_banner", "-loglevel", "error",
                "-i", frame.path,
                "-vf", `scale=iw*${scale}:ih*${scale},format=gray,eq=contrast=1.8:brightness=-0.05,threshold`,
                out2,
            ], { timeoutMs: config.ffmpegTimeoutMs });
            variants.push(await fs.promises.readFile(out2));
        }
        return variants.slice(0, maxVariants);
    }

    return [inputBuffer];
}

async function getOcrWorker() {
    if (ocrWorker) return ocrWorker;
    if (ocrWorkerPromise) return ocrWorkerPromise;

    const { createWorker, OEM, PSM } = require("tesseract.js");
    const config = getRuntimeConfig();
    ocrStatus = "LOADING";
    ocrDetail = "";
    ocrWorkerPromise = (async () => {
        try {
            ocrLangsActive = config.ocrLangs;
            const worker = await createWorker(config.ocrLangs, OEM.LSTM_ONLY, {
                cachePath: TESSERACT_CACHE_DIR,
                gzip: true,
                logger: () => {},
            }, {
                tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
            });
            ocrWorker = worker;
            ocrStatus = "READY";
            return worker;
        } catch (error) {
            console.log(`[STICKER SAFETY] OCR unavailable: ${shortError(error)}`);
            if (String(config.ocrLangs).toLowerCase() !== "eng") {
                try {
                    ocrLangsActive = "eng";
                    const worker = await createWorker("eng", OEM.LSTM_ONLY, {
                        cachePath: TESSERACT_CACHE_DIR,
                        gzip: true,
                        logger: () => {},
                    }, {
                        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
                    });
                    ocrWorker = worker;
                    ocrStatus = "READY";
                    ocrDetail = "fallback eng";
                    return worker;
                } catch (fallbackError) {
                    ocrStatus = "ERROR";
                    ocrDetail = shortError(fallbackError);
                    throw fallbackError;
                }
            }
            ocrStatus = "ERROR";
            ocrDetail = shortError(error);
            throw error;
        }
    })();

    return ocrWorkerPromise;
}

function normalizeOcrText(text) {
    const raw = String(text || "");
    const normalizedText = raw
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[\r\n]+/g, " ")
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .replace(/(.)\1{2,}/g, "$1$1")
        .replace(/\s+/g, " ")
        .trim();

    const leetNormalizedText = normalizedText
        .replace(/0/g, "o")
        .replace(/1/g, "i")
        .replace(/3/g, "e")
        .replace(/4/g, "a")
        .replace(/5/g, "s")
        .replace(/7/g, "t")
        .replace(/8/g, "b")
        .replace(/\s+/g, " ")
        .trim();

    return {
        rawText: raw,
        normalizedText,
        leetNormalizedText,
    };
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeWord(value) {
    return normalizeOcrText(value).normalizedText;
}

function makeFlexibleWordRegex(word) {
    const normalized = normalizeWord(word);
    if (!normalized) return null;
    const parts = normalized.split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
        return new RegExp(`(^|\\s)${parts.map(escapeRegex).join("\\s+")}(?=\\s|$)`, "i");
    }
    if (normalized.length >= 3) {
        return new RegExp(`(^|\\s)${normalized.split("").map(escapeRegex).join("\\s*")}(?=\\s|$)`, "i");
    }
    return new RegExp(`(^|\\s)${escapeRegex(normalized)}(?=\\s|$)`, "i");
}

function maskWord(word) {
    const clean = String(word || "").trim();
    if (!clean) return "-";
    if (clean.length <= 1) return "*";
    if (clean.length <= 3) return `${clean[0]}${"*".repeat(clean.length - 1)}`;
    return `${clean[0]}${"*".repeat(Math.min(6, clean.length - 2))}${clean[clean.length - 1]}`;
}

function findStickerBadWords(textOrNormalized, words = loadWordState().words) {
    const normalized = typeof textOrNormalized === "object" && textOrNormalized
        ? textOrNormalized
        : normalizeOcrText(textOrNormalized);
    const candidates = unique([normalized.normalizedText, normalized.leetNormalizedText]);
    const matches = [];

    for (const word of words || []) {
        const regex = makeFlexibleWordRegex(word);
        if (!regex) continue;
        const matched = candidates.some(text => regex.test(` ${text} `));
        if (matched) {
            matches.push({
                word,
                masked: maskWord(word),
            });
        }
    }

    return matches;
}

async function inspectStickerText(frames, options = {}) {
    const config = getRuntimeConfig();
    const output = {
        available: true,
        text: "",
        normalizedText: "",
        leetNormalizedText: "",
        badWords: [],
        frameTexts: [],
        error: "",
    };

    try {
        const worker = await getOcrWorker();
        const texts = [];
        for (const frame of frames || []) {
            let variants = [];
            try {
                variants = await preprocessFrameForOcr(frame, config);
            } catch (error) {
                console.log(`[STICKER SAFETY] OCR preprocess unavailable: ${shortError(error)}`);
                variants = [frame.buffer].filter(Boolean);
            }

            for (let variantIndex = 0; variantIndex < Math.min(variants.length, config.ocrVariants); variantIndex += 1) {
                try {
                    const result = await worker.recognize(variants[variantIndex]);
                    const text = String(result?.data?.text || "").trim();
                    if (text) {
                        texts.push(text);
                        output.frameTexts.push({
                            frameIndex: frame.index || 0,
                            variantIndex,
                            text,
                        });
                    }
                } catch (error) {
                    console.log(`[STICKER SAFETY] OCR unavailable: ${shortError(error)}`);
                }
            }
        }

        output.text = unique(texts).join(" ");
        const normalized = normalizeOcrText(output.text);
        output.normalizedText = normalized.normalizedText;
        output.leetNormalizedText = normalized.leetNormalizedText;
        output.badWords = findStickerBadWords(normalized);
        return output;
    } catch (error) {
        output.available = false;
        output.error = shortError(error);
        console.log(`[STICKER SAFETY] OCR unavailable: ${output.error}`);
        return output;
    }
}

async function getNsfwModel() {
    if (nsfwModel) return nsfwModel;
    if (nsfwModelPromise) return nsfwModelPromise;

    const config = getRuntimeConfig();
    nsfwStatus = "LOADING";
    nsfwDetail = "";
    nsfwModelPromise = (async () => {
        try {
            const tfRuntime = getTensorflow();
            const nsfwRuntime = getNsfwJs();
            await tfRuntime.ready();
            nsfwModel = await nsfwRuntime.load(config.nsfwModelName);
            nsfwStatus = "READY";
            nsfwDetail = `${config.nsfwModelName} / ${tfBackendName}`;
            return nsfwModel;
        } catch (error) {
            nsfwStatus = "ERROR";
            nsfwDetail = shortError(error);
            nsfwModel = null;
            nsfwModelPromise = null;
            console.log(`[STICKER SAFETY] NSFW model unavailable: ${nsfwDetail}`);
            throw error;
        }
    })();
    return nsfwModelPromise;
}

function getNsfwInputSize() {
    return getRuntimeConfig().nsfwModelName === "MobileNetV2Mid" ? 299 : 224;
}

async function imageBufferToTensor(imageBuffer) {
    const tfRuntime = getTensorflow();
    const size = getNsfwInputSize();
    const sharpRuntime = getSharp();
    if (sharpRuntime) {
        const raw = await sharpRuntime(imageBuffer)
            .resize({ width: size, height: size, fit: "fill" })
            .flatten({ background: "#ffffff" })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        return tfRuntime.tensor3d(new Uint8Array(raw.data), [raw.info.height, raw.info.width, raw.info.channels], "int32");
    }

    const { PNG } = getPngJs();
    const png = PNG.sync.read(imageBuffer);
    const rgb = new Uint8Array(png.width * png.height * 3);
    for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
        const alpha = png.data[i + 3] / 255;
        rgb[j] = Math.round(png.data[i] * alpha + 255 * (1 - alpha));
        rgb[j + 1] = Math.round(png.data[i + 1] * alpha + 255 * (1 - alpha));
        rgb[j + 2] = Math.round(png.data[i + 2] * alpha + 255 * (1 - alpha));
    }
    const tensor = tfRuntime.tensor3d(rgb, [png.height, png.width, 3], "int32");
    if (png.width === size && png.height === size) return tensor;
    const resized = tfRuntime.image.resizeBilinear(tensor, [size, size]);
    tensor.dispose();
    return resized;
}

function cropPngBuffer(imageBuffer, crop) {
    const { PNG } = getPngJs();
    const source = PNG.sync.read(imageBuffer);
    const left = Math.max(0, Math.min(source.width - 1, Math.floor(crop.left * source.width)));
    const top = Math.max(0, Math.min(source.height - 1, Math.floor(crop.top * source.height)));
    const right = Math.max(left + 1, Math.min(source.width, Math.ceil(crop.right * source.width)));
    const bottom = Math.max(top + 1, Math.min(source.height, Math.ceil(crop.bottom * source.height)));
    const width = right - left;
    const height = bottom - top;
    const output = new PNG({ width, height });
    PNG.bitblt(source, output, left, top, width, height, 0, 0);
    return PNG.sync.write(output);
}

function flipPngBuffer(imageBuffer) {
    const { PNG } = getPngJs();
    const source = PNG.sync.read(imageBuffer);
    const output = new PNG({ width: source.width, height: source.height });
    for (let y = 0; y < source.height; y += 1) {
        for (let x = 0; x < source.width; x += 1) {
            const srcIdx = ((source.width * y) + x) << 2;
            const dstIdx = ((source.width * y) + (source.width - 1 - x)) << 2;
            output.data[dstIdx] = source.data[srcIdx];
            output.data[dstIdx + 1] = source.data[srcIdx + 1];
            output.data[dstIdx + 2] = source.data[srcIdx + 2];
            output.data[dstIdx + 3] = source.data[srcIdx + 3];
        }
    }
    return PNG.sync.write(output);
}

function buildAugmentedFrameVariants(frame, options = {}) {
    const buffer = frame?.buffer || frame;
    if (!Buffer.isBuffer(buffer)) return [];
    const variants = [];
    const addVariant = (name, variantBuffer) => {
        if (!Buffer.isBuffer(variantBuffer) || !variantBuffer.length) return;
        variants.push({
            frameIndex: frame?.frameIndex ?? options.frameIndex ?? 0,
            timestamp: frame?.timestamp ?? null,
            region: name,
            buffer: variantBuffer,
        });
    };

    try { addVariant("flip", flipPngBuffer(buffer)); } catch {}
    try { addVariant("center-zoom", cropPngBuffer(buffer, { left: 0.08, top: 0.08, right: 0.92, bottom: 0.92 })); } catch {}
    try { addVariant("mid-body", cropPngBuffer(buffer, { left: 0.15, top: 0.10, right: 0.85, bottom: 0.95 })); } catch {}
    try { addVariant("lower-body", cropPngBuffer(buffer, { left: 0.05, top: 0.30, right: 0.95, bottom: 1.00 })); } catch {}
    return variants;
}

function computeSkinExposure(imageBuffer) {
    const { PNG } = getPngJs();
    const source = PNG.sync.read(imageBuffer);
    let solidPixels = 0;
    let skinPixels = 0;
    const rowHits = new Set();
    const colHits = new Set();
    for (let y = 0; y < source.height; y += 1) {
        for (let x = 0; x < source.width; x += 1) {
            const idx = ((source.width * y) + x) << 2;
            const r = source.data[idx];
            const g = source.data[idx + 1];
            const b = source.data[idx + 2];
            const a = source.data[idx + 3];
            if (a < 30) continue;
            solidPixels += 1;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const cb = (-0.168736 * r) - (0.331264 * g) + (0.5 * b) + 128;
            const cr = (0.5 * r) - (0.418688 * g) - (0.081312 * b) + 128;
            const rgbRule = r > 95 && g > 40 && b > 20 && (max - min) > 15 && Math.abs(r - g) > 12 && r >= g && r > b;
            const ycbcrRule = cb >= 77 && cb <= 135 && cr >= 133 && cr <= 180 && r > g && r > b;
            const lightRule = r > 145 && g > 110 && b > 90 && r > g && g > b;
            if (rgbRule || ycbcrRule || lightRule) {
                skinPixels += 1;
                rowHits.add(y);
                colHits.add(x);
            }
        }
    }
    const ratio = solidPixels ? skinPixels / solidPixels : 0;
    return {
        ratio,
        rowCoverage: source.height ? rowHits.size / source.height : 0,
        colCoverage: source.width ? colHits.size / source.width : 0,
        width: source.width,
        height: source.height,
    };
}

function pickDominantCategory(predictions = {}) {
    const porn = Number(predictions.Porn || 0);
    const hentai = Number(predictions.Hentai || 0);
    const sexy = Number(predictions.Sexy || 0);
    if (porn >= hentai && porn >= sexy) return "porn";
    if (hentai >= porn && hentai >= sexy) return "hentai";
    return "nudity";
}

function buildNsfwRegions(frame, maxRegions = getRuntimeConfig().nsfwMaxRegions) {
    const buffer = frame?.buffer || frame;
    if (!Buffer.isBuffer(buffer)) return [];
    const definitions = [
        { name: "center", left: 0.10, top: 0.10, right: 0.90, bottom: 0.90 },
        { name: "top", left: 0.00, top: 0.00, right: 1.00, bottom: 0.62 },
        { name: "bottom", left: 0.00, top: 0.38, right: 1.00, bottom: 1.00 },
        { name: "left", left: 0.00, top: 0.00, right: 0.62, bottom: 1.00 },
        { name: "right", left: 0.38, top: 0.00, right: 1.00, bottom: 1.00 },
    ].slice(0, Math.max(0, Number(maxRegions) || 0));
    const regions = [];
    for (const definition of definitions) {
        try {
            regions.push({ name: definition.name, buffer: cropPngBuffer(buffer, definition) });
        } catch {}
    }
    return regions;
}

function predictionsToMap(predictions = []) {
    const map = {};
    for (const name of CATEGORY_NAMES) map[name] = 0;
    for (const item of predictions || []) {
        const className = String(item.className || item.label || "").trim();
        const probability = Number(item.probability ?? item.score ?? 0);
        const known = CATEGORY_NAMES.find(name => name.toLowerCase() === className.toLowerCase());
        if (known) map[known] = probability;
    }
    return map;
}

async function classifyNsfwFrame(frame, frameIndex = 0, region = "full") {
    let tensor = null;
    try {
        const model = await getNsfwModel();
        tensor = await imageBufferToTensor(frame?.buffer || frame);
        const predictions = await model.classify(tensor, 5);
        return {
            frameIndex,
            region,
            timestamp: frame?.timestamp ?? null,
            predictions: predictionsToMap(predictions),
            raw: predictions,
        };
    } finally {
        if (tensor && typeof tensor.dispose === "function") tensor.dispose();
    }
}

function getUnsafeScore(predictions = {}) {
    const porn = Number(predictions.Porn || 0);
    const hentai = Number(predictions.Hentai || 0);
    const sexy = Number(predictions.Sexy || 0);
    return Math.min(1, porn + hentai + (sexy * 0.55));
}

function maxByScore(frameResults, scoreFn) {
    let best = null;
    for (const result of frameResults || []) {
        const score = Number(scoreFn(result) || 0);
        if (!best || score > best.score) best = { score, result };
    }
    return best || { score: 0, result: null };
}

function maxByCategory(frameResults, category) {
    return maxByScore(frameResults, result => Number(result?.predictions?.[category] || 0));
}

function countDistinctFrameHits(frameResults, predicate) {
    return new Set((frameResults || []).filter(predicate).map(item => Number(item.frameIndex || 0))).size;
}

function topMean(frameResults, scoreFn, count = 2) {
    const byFrame = new Map();
    for (const item of frameResults || []) {
        const frameIndex = Number(item.frameIndex || 0);
        const score = Number(scoreFn(item) || 0);
        byFrame.set(frameIndex, Math.max(byFrame.get(frameIndex) || 0, score));
    }
    const scores = [...byFrame.values()].sort((a, b) => b - a).slice(0, Math.max(1, count));
    return scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
}

function buildNsfwDecision(category, evidence, reason) {
    return {
        violation: true,
        category,
        confidence: Number(evidence?.score || 0),
        frameIndex: Number(evidence?.result?.frameIndex || 0),
        region: evidence?.result?.region || "full",
        predictions: evidence?.result?.predictions || {},
        reason,
    };
}

function evaluateNsfwPredictions(frameResults = [], options = {}) {
    const config = getRuntimeConfig();
    const distinctFrames = new Set((frameResults || []).map(item => Number(item.frameIndex || 0))).size;
    const isStatic = Boolean(options.isStatic || distinctFrames <= 1);
    const pornMax = maxByCategory(frameResults, "Porn");
    const hentaiMax = maxByCategory(frameResults, "Hentai");
    const sexyMax = maxByCategory(frameResults, "Sexy");
    const combinedMax = maxByScore(frameResults, item => (
        Number(item?.predictions?.Porn || 0) + Number(item?.predictions?.Hentai || 0)
    ));

    const pornHits = countDistinctFrameHits(frameResults, item => Number(item?.predictions?.Porn || 0) >= config.nsfwPornThreshold);
    const hentaiHits = countDistinctFrameHits(frameResults, item => Number(item?.predictions?.Hentai || 0) >= config.nsfwHentaiThreshold);
    const sexyHits = countDistinctFrameHits(frameResults, item => Number(item?.predictions?.Sexy || 0) >= config.nsfwSexyThreshold);
    const combinedHits = countDistinctFrameHits(frameResults, item => (
        Number(item?.predictions?.Porn || 0) + Number(item?.predictions?.Hentai || 0)
    ) >= config.nsfwCombinedThreshold);

    const pornMean = topMean(frameResults, item => Number(item?.predictions?.Porn || 0), 2);
    const hentaiMean = topMean(frameResults, item => Number(item?.predictions?.Hentai || 0), 2);
    const combinedMean = topMean(frameResults, item => (
        Number(item?.predictions?.Porn || 0) + Number(item?.predictions?.Hentai || 0)
    ), 2);
    const sexyMean = topMean(frameResults, item => Number(item?.predictions?.Sexy || 0), 2);

    if (pornMax.score >= config.nsfwHardThreshold) return buildNsfwDecision("porn", pornMax, "porn-hard");
    if (hentaiMax.score >= config.nsfwHardThreshold) return buildNsfwDecision("hentai", hentaiMax, "hentai-hard");

    if (isStatic) {
        if (pornMax.score >= config.nsfwPornThreshold) return buildNsfwDecision("porn", pornMax, "porn-static-threshold");
        if (hentaiMax.score >= config.nsfwHentaiThreshold) return buildNsfwDecision("hentai", hentaiMax, "hentai-static-threshold");
        if (combinedMax.score >= config.nsfwCombinedThreshold) return buildNsfwDecision("explicit", combinedMax, "combined-static-threshold");
        if (sexyMax.score >= config.nsfwSexyThreshold) return buildNsfwDecision("nudity", sexyMax, "sexy-static-threshold");
        if ((Number(hentaiMax.score || 0) >= 0.28 && Number(sexyMax.score || 0) >= 0.34) || hentaiMean >= 0.32) {
            return buildNsfwDecision("hentai", hentaiMax.score >= sexyMax.score ? hentaiMax : sexyMax, "hentai-sexy-fusion");
        }
        if ((Number(pornMax.score || 0) >= 0.24 && Number(sexyMax.score || 0) >= 0.30) || (Number(combinedMax.score || 0) >= 0.38 && Number(sexyMax.score || 0) >= 0.24)) {
            return buildNsfwDecision("porn", pornMax.score >= sexyMax.score ? pornMax : combinedMax, "porn-sexy-fusion");
        }
        if (combinedMean >= 0.40 || sexyMean >= 0.48) {
            const candidate = combinedMax.score >= sexyMax.score ? combinedMax : sexyMax;
            return buildNsfwDecision(pickDominantCategory(candidate.result?.predictions || {}), candidate, "static-soft-consensus");
        }
    } else {
        if (pornHits >= 2 || pornMean >= config.nsfwTopMeanThreshold) return buildNsfwDecision("porn", pornMax, "porn-temporal-consensus");
        if (hentaiHits >= 2 || hentaiMean >= config.nsfwTopMeanThreshold) return buildNsfwDecision("hentai", hentaiMax, "hentai-temporal-consensus");
        if (combinedHits >= 2 || combinedMean >= config.nsfwCombinedThreshold) return buildNsfwDecision("explicit", combinedMax, "combined-temporal-consensus");
        if ((!config.nsfwRequireMultipleFrames || sexyHits >= 2 || sexyMean >= 0.45) && sexyMax.score >= 0.56) {
            return buildNsfwDecision("nudity", sexyMax, "sexy-temporal-consensus");
        }
        if ((pornHits >= 1 && sexyHits >= 1) || (hentaiHits >= 1 && sexyHits >= 1)) {
            const candidate = hentaiMax.score >= pornMax.score ? hentaiMax : pornMax;
            return buildNsfwDecision(pickDominantCategory(candidate.result?.predictions || {}), candidate, "temporal-fusion");
        }
    }

    const confidence = Math.max(pornMax.score, hentaiMax.score, sexyMax.score, combinedMax.score);
    const best = [pornMax, hentaiMax, sexyMax, combinedMax].sort((a, b) => b.score - a.score)[0];
    return {
        violation: false,
        category: null,
        confidence,
        frameIndex: Number(best?.result?.frameIndex || 0),
        region: best?.result?.region || "full",
        predictions: best?.result?.predictions || {},
        reason: "below-threshold",
    };
}

function evaluateExposureHeuristics(frameResults = [], sourceFrames = [], options = {}) {
    const byFrame = new Map();
    for (const item of frameResults || []) {
        const frameIndex = Number(item.frameIndex || 0);
        const score = getUnsafeScore(item?.predictions || {});
        const prev = byFrame.get(frameIndex);
        if (!prev || score > prev.score) byFrame.set(frameIndex, { score, item });
    }

    let best = null;
    for (let index = 0; index < (sourceFrames || []).length; index += 1) {
        const frame = sourceFrames[index];
        const buffer = frame?.buffer || frame;
        if (!Buffer.isBuffer(buffer)) continue;
        let exposure;
        try {
            exposure = computeSkinExposure(buffer);
        } catch {
            continue;
        }
        const evidence = byFrame.get(index)?.item || null;
        const predictions = evidence?.predictions || {};
        const porn = Number(predictions.Porn || 0);
        const hentai = Number(predictions.Hentai || 0);
        const sexy = Number(predictions.Sexy || 0);
        const unsafe = getUnsafeScore(predictions);

        const strongExposure = exposure.ratio >= 0.42 && exposure.rowCoverage >= 0.45 && exposure.colCoverage >= 0.35;
        const mediumExposure = exposure.ratio >= 0.34 && exposure.rowCoverage >= 0.40 && exposure.colCoverage >= 0.28;
        const aiHint = unsafe >= 0.16 || porn >= 0.14 || hentai >= 0.14 || sexy >= 0.18;
        const strongerAiHint = unsafe >= 0.26 || porn >= 0.22 || hentai >= 0.20 || sexy >= 0.24;

        if (!((strongExposure && aiHint) || (mediumExposure && strongerAiHint))) continue;

        const category = hentai >= porn && hentai >= sexy ? "hentai" : (porn >= hentai && porn >= sexy ? "porn" : "nudity");
        const confidence = Math.max(unsafe, sexy, porn, hentai, Math.min(0.95, exposure.ratio));
        const candidate = {
            violation: true,
            category,
            confidence,
            frameIndex: index,
            region: "full",
            predictions,
            reason: strongExposure ? "skin-heavy-with-ai-signal" : "skin-exposure-backstop",
        };
        if (!best || confidence > best.confidence) best = candidate;
    }
    return best || null;
}
function rankSuspiciousFrames(frameResults = []) {
    const byFrame = new Map();
    for (const item of frameResults) {
        const score = getUnsafeScore(item?.predictions || {});
        const frameIndex = Number(item.frameIndex || 0);
        if (!byFrame.has(frameIndex) || score > byFrame.get(frameIndex).score) {
            byFrame.set(frameIndex, { frameIndex, score });
        }
    }
    return [...byFrame.values()].sort((a, b) => b.score - a.score);
}

async function inspectStickerNsfw(frames, options = {}) {
    const startedAt = Date.now();
    const config = getRuntimeConfig();
    const result = {
        available: true,
        frames: [],
        primaryFrames: 0,
        regionScans: 0,
        violation: false,
        category: null,
        confidence: 0,
        frameIndex: 0,
        region: "full",
        predictions: {},
        reason: "",
        pipelineVersion: NSFW_PIPELINE_VERSION,
        error: "",
    };

    try {
        for (let index = 0; index < (frames || []).length; index += 1) {
            try {
                result.frames.push(await classifyNsfwFrame(frames[index], index, "full"));
                result.primaryFrames += 1;
            } catch (error) {
                console.log(`[STICKER SAFETY] NSFW primary frame failed: ${shortError(error)}`);
            }
        }

        let decision = evaluateNsfwPredictions(result.frames, options);
        if (!decision.violation) {
            const rankedFrames = rankSuspiciousFrames(result.frames);
            let suspiciousFrames = rankedFrames
                .filter(item => item.score >= config.nsfwCropTriggerThreshold)
                .slice(0, config.nsfwCropFrameCount);
            if (!suspiciousFrames.length && rankedFrames.length) {
                suspiciousFrames = rankedFrames.slice(0, options.isStatic ? 1 : config.nsfwCropFrameCount);
            }
            for (const suspicious of suspiciousFrames) {
                const sourceFrame = frames[suspicious.frameIndex];
                for (const variant of buildAugmentedFrameVariants({
                    buffer: sourceFrame?.buffer || sourceFrame,
                    timestamp: sourceFrame?.timestamp,
                    frameIndex: suspicious.frameIndex,
                })) {
                    try {
                        result.frames.push(await classifyNsfwFrame({
                            buffer: variant.buffer,
                            timestamp: variant.timestamp,
                        }, suspicious.frameIndex, variant.region));
                        result.regionScans += 1;
                    } catch (error) {
                        console.log(`[STICKER SAFETY] NSFW augment failed: ${shortError(error)}`);
                    }
                }
                for (const region of buildNsfwRegions(sourceFrame, config.nsfwMaxRegions)) {
                    try {
                        result.frames.push(await classifyNsfwFrame({
                            buffer: region.buffer,
                            timestamp: sourceFrame?.timestamp,
                        }, suspicious.frameIndex, region.name));
                        result.regionScans += 1;
                    } catch (error) {
                        console.log(`[STICKER SAFETY] NSFW crop failed: ${shortError(error)}`);
                    }
                }
            }
            decision = evaluateNsfwPredictions(result.frames, options);
        }

        if (!decision.violation) {
            const exposureDecision = evaluateExposureHeuristics(result.frames, frames, options);
            if (exposureDecision?.violation) decision = exposureDecision;
        }

        Object.assign(result, decision);
        nsfwRuntimeStats = {
            lastScanAt: Date.now(),
            lastResult: decision.violation ? "violation" : "clean",
            lastCategory: decision.category || null,
            lastConfidence: Number(decision.confidence || 0),
            lastFrames: result.primaryFrames,
            lastRegions: result.regionScans,
            lastDurationMs: Date.now() - startedAt,
            lastReason: decision.reason || "",
        };
        return result;
    } catch (error) {
        result.available = false;
        result.error = shortError(error);
        nsfwRuntimeStats = {
            lastScanAt: Date.now(),
            lastResult: "error",
            lastCategory: null,
            lastConfidence: 0,
            lastFrames: result.primaryFrames,
            lastRegions: result.regionScans,
            lastDurationMs: Date.now() - startedAt,
            lastReason: result.error,
        };
        console.log(`[STICKER SAFETY] NSFW model unavailable: ${result.error}`);
        return result;
    }
}
async function warmupNsfwModel() {
    await getNsfwModel();
    return getStickerSafetyHealth();
}

function clearStickerSafetyCache() {
    resultCache = {};
    saveResultCache();
    recentMessageIds.clear();
    recentStickerHashes.clear();
    return true;
}

async function inspectSticker(sock, msg, options = {}) {
    const stickerMessage = options.stickerMessage || extractStickerMessage(msg);
    if (!stickerMessage && !options.buffer) {
        return { inspected: false, reason: "not-sticker" };
    }

    const effective = options.config || getEffectiveConfig(msg?.key?.remoteJid, options);
    const runtime = getRuntimeConfig();
    let frameSet = null;

    try {
        const buffer = options.buffer || await downloadStickerBuffer(stickerMessage, { timeoutMs: runtime.timeoutMs });
        if (!buffer?.length) return { inspected: false, reason: "empty-buffer" };
        if (buffer.length > runtime.maxFileBytes) {
            console.log("[STICKER SAFETY] sticker dilewati karena terlalu besar", {
                id: msg?.key?.id,
                size: buffer.length,
            });
            return { inspected: false, reason: "too-large", size: buffer.length };
        }

        const hash = sha256(buffer);
        const cacheKey = `${NSFW_PIPELINE_VERSION}:${hash}`;
        const cached = !options.ignoreCache ? getCacheRecord(cacheKey) : null;
        if (cached) {
            return {
                inspected: true,
                fromCache: true,
                hash,
                ...cached.result,
            };
        }

        frameSet = await extractStickerFrames(buffer, stickerMessage, runtime);
        const frames = frameSet.frames || [];

        const [ocr, nsfw] = await Promise.all([
            effective.textEnabled
                ? inspectStickerText(frames, runtime).catch(error => ({
                    available: false,
                    error: shortError(error),
                    badWords: [],
                    text: "",
                }))
                : Promise.resolve({ available: false, disabled: true, badWords: [], text: "" }),
            effective.nsfwEnabled
                ? inspectStickerNsfw(frames, { isStatic: frameSet.type === "static" }).catch(error => ({
                    available: false,
                    error: shortError(error),
                    violation: false,
                    category: null,
                    confidence: 0,
                    frames: [],
                }))
                : Promise.resolve({ available: false, disabled: true, violation: false, category: null, confidence: 0, frames: [] }),
        ]);

        const textViolation = Boolean(effective.textEnabled && ocr?.badWords?.length);
        const nsfwViolation = Boolean(effective.nsfwEnabled && nsfw?.violation);
        const violationType = nsfwViolation ? "nsfw" : textViolation ? "text" : null;
        const result = {
            type: frameSet.type,
            frames: frames.length,
            ocr,
            nsfw,
            violation: Boolean(violationType),
            violationType,
        };

        setCacheRecord(cacheKey, {
            result: {
                type: result.type,
                frames: result.frames,
                ocr: {
                    available: ocr.available,
                    text: ocr.text || "",
                    normalizedText: ocr.normalizedText || "",
                    leetNormalizedText: ocr.leetNormalizedText || "",
                    badWords: ocr.badWords || [],
                    error: ocr.error || "",
                },
                nsfw: {
                    available: nsfw.available,
                    violation: nsfw.violation,
                    category: nsfw.category,
                    confidence: nsfw.confidence,
                    frameIndex: nsfw.frameIndex,
                    predictions: nsfw.predictions || {},
                    frames: (nsfw.frames || []).map(item => ({
                        frameIndex: item.frameIndex,
                        region: item.region || "full",
                        timestamp: item.timestamp ?? null,
                        predictions: item.predictions,
                    })),
                    primaryFrames: nsfw.primaryFrames || 0,
                    regionScans: nsfw.regionScans || 0,
                    region: nsfw.region || "full",
                    reason: nsfw.reason || "",
                    pipelineVersion: nsfw.pipelineVersion || NSFW_PIPELINE_VERSION,
                    error: nsfw.error || "",
                },
                violation: result.violation,
                violationType: result.violationType,
            },
        });

        return {
            inspected: true,
            hash,
            ...result,
        };
    } finally {
        if (frameSet?.tempDir) {
            await fs.promises.rm(frameSet.tempDir, { recursive: true, force: true }).catch(() => {});
        }
    }
}

function pruneRecentMaps(now = Date.now()) {
    for (const [key, ts] of recentMessageIds) {
        if (now - ts > MESSAGE_DEDUPE_TTL_MS) recentMessageIds.delete(key);
    }
    for (const [key, ts] of recentStickerHashes) {
        if (now - ts > HASH_DEDUPE_TTL_MS) recentStickerHashes.delete(key);
    }
}

function enqueueStickerJob(job, options = {}) {
    const config = getRuntimeConfig();
    if (disposed) return Promise.resolve({ inspected: false, reason: "disposed" });
    if (queue.length >= config.queueMax) {
        console.log("[STICKER SAFETY] queue penuh, sticker dilewati.");
        return Promise.resolve({ inspected: false, reason: "queue-full" });
    }

    return new Promise(resolve => {
        queue.push({ job, resolve, options, createdAt: Date.now() });
        runQueue();
    });
}

function runQueue() {
    const config = getRuntimeConfig();
    while (activeJobs < config.concurrency && queue.length) {
        const item = queue.shift();
        activeJobs += 1;
        withTimeout(Promise.resolve().then(item.job), config.timeoutMs, "Sticker Safety job")
            .then(result => item.resolve(result))
            .catch(error => {
                console.log(`[STICKER SAFETY] job error: ${shortError(error)}`);
                item.resolve({ inspected: false, reason: "error", error: shortError(error) });
            })
            .finally(() => {
                activeJobs = Math.max(0, activeJobs - 1);
                runQueue();
            });
    }
}

function buildMentionJid(senderJid) {
    const clean = String(senderJid || "").trim();
    return clean.includes("@") ? clean : "";
}

function buildStickerTextWarning(msg, result, options = {}) {
    const isGroup = isGroupJid(msg?.key?.remoteJid);
    const senderJid = options.senderJid || getSenderJid(msg);
    const word = result?.ocr?.badWords?.[0]?.masked || "-";
    const text = isGroup
        ? `🧾 *PERINGATAN TEKS STIKER*\n\n@${getJidLabel(senderJid)}, stiker yang kamu kirim terdeteksi mengandung tulisan tidak pantas.\n\nKata terdeteksi: \`${word}\`\n\nHarap gunakan stiker yang lebih sopan dan sesuai untuk grup ini.`
        : `🧾 *PERINGATAN TEKS STIKER*\n\nStiker yang kamu kirim terdeteksi mengandung tulisan tidak pantas.\n\nKata terdeteksi: \`${word}\`\n\nHarap gunakan stiker yang lebih sopan.`;
    const outbound = { text };
    if (isGroup) outbound.mentions = [buildMentionJid(senderJid)].filter(Boolean);
    return outbound;
}

function buildStickerNsfwWarning(msg, result, options = {}) {
    const isGroup = isGroupJid(msg?.key?.remoteJid);
    const senderJid = options.senderJid || getSenderJid(msg);
    const category = result?.nsfw?.category || "porn";
    const nudityCategory = ["nudity", "suggestive"].includes(category);
    const title = nudityCategory
        ? "⚠️ *PERINGATAN KETELANJANGAN STIKER*"
        : "🔞 *PERINGATAN KONTEN STIKER*";
    const body = nudityCategory
        ? (isGroup
            ? `@${getJidLabel(senderJid)}, stiker yang kamu kirim terdeteksi mengandung ketelanjangan atau visual seksual yang tidak pantas.`
            : "Stiker yang kamu kirim terdeteksi mengandung ketelanjangan atau visual seksual yang tidak pantas.")
        : (isGroup
            ? `@${getJidLabel(senderJid)}, stiker yang kamu kirim terdeteksi mengandung konten dewasa atau pornografi.\n\nKonten seperti ini tidak sesuai untuk dikirim di grup.`
            : "Stiker yang kamu kirim terdeteksi mengandung konten dewasa atau pornografi.\n\nHarap jangan mengirim konten seperti ini.");
    const outbound = { text: `${title}\n\n${body}` };
    if (isGroup) outbound.mentions = [buildMentionJid(senderJid)].filter(Boolean);
    return outbound;
}

async function sendStickerWarning(sock, msg, result, context = {}) {
    const from = context.from || msg?.key?.remoteJid;
    const senderJid = context.senderJid || context.sender || getSenderJid(msg);
    const outbound = result.violationType === "nsfw"
        ? buildStickerNsfwWarning(msg, result, { senderJid })
        : buildStickerTextWarning(msg, result, { senderJid });
    await sock.sendMessage(from, outbound, { quoted: msg });
    return true;
}

async function maybeDeleteSticker(sock, msg, result) {
    const config = getRuntimeConfig();
    if (config.action !== "warn_delete") return false;
    const nsfw = result?.nsfw || {};
    if (!["porn", "hentai"].includes(nsfw.category)) return false;
    if (Number(nsfw.confidence || 0) < config.nsfwHardThreshold) return false;
    try {
        await sock.sendMessage(msg.key.remoteJid, { delete: msg.key });
        return true;
    } catch (error) {
        console.log(`[STICKER SAFETY] gagal delete sticker: ${shortError(error)}`);
        return false;
    }
}

async function handleStickerSafety(sock, msg, context = {}) {
    if (!isStickerMessage(msg)) return { inspected: false, reason: "not-sticker" };

    const from = context.from || msg?.key?.remoteJid || "";
    const effective = getEffectiveConfig(from, context);
    if (msg?.key?.fromMe && effective.scanFromMe === false) {
        return { inspected: false, reason: "from-me-disabled" };
    }
    if (!effective.enabled || (!effective.textEnabled && !effective.nsfwEnabled)) {
        return { inspected: false, reason: "disabled" };
    }

    const messageId = msg?.key?.id;
    pruneRecentMaps();
    if (messageId && recentMessageIds.has(messageId)) return { inspected: false, reason: "duplicate-message" };
    if (messageId) recentMessageIds.set(messageId, Date.now());

    return enqueueStickerJob(async () => {
        const result = await inspectSticker(sock, msg, {
            ...context,
            config: effective,
        });
        if (result.hash) {
            if (recentStickerHashes.has(result.hash) && result.fromCache && !result.violation) {
                return { ...result, warned: false };
            }
            recentStickerHashes.set(result.hash, Date.now());
        }
        if (!result.violation) return { ...result, warned: false };
        if (msg?.key?.fromMe && effective.warnFromMe === false) {
            return { ...result, warned: false, skippedWarning: "from-me-disabled" };
        }
        await sendStickerWarning(sock, msg, result, context);
        await maybeDeleteSticker(sock, msg, result);
        return { ...result, warned: true };
    });
}

function getContextInfo(msg) {
    const message = unwrapMessage(msg?.message || {});
    return message?.extendedTextMessage?.contextInfo
        || message?.imageMessage?.contextInfo
        || message?.videoMessage?.contextInfo
        || message?.stickerMessage?.contextInfo
        || {};
}

function getQuotedStickerMessage(msg) {
    const contextInfo = getContextInfo(msg);
    const quotedMessage = contextInfo?.quotedMessage;
    if (!quotedMessage || !extractStickerMessage(quotedMessage)) return null;
    return {
        key: {
            remoteJid: msg?.key?.remoteJid,
            id: contextInfo.stanzaId,
            participant: contextInfo.participant,
            fromMe: false,
        },
        message: quotedMessage,
        pushName: msg?.pushName || "",
    };
}

function getCommandRoot(text) {
    return String(text || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
}

function isStickerGuardCommand(text) {
    const root = getCommandRoot(text);
    return [".stikerguard", ".stickersafety", ".stickerguard", ".guardscan"].includes(root);
}

function isStickerWordCommand(text) {
    const root = getCommandRoot(text);
    return [".stikerword", ".stickerword"].includes(root);
}

function splitCommand(text) {
    return String(text || "").trim().split(/\s+/).filter(Boolean);
}

function setGroupConfig(groupJid, patch, updatedBy) {
    const jid = normalizeJid(groupJid);
    if (!isGroupJid(jid)) return null;
    const state = loadState();
    const current = state.groups[jid] || {};
    state.groups[jid] = {
        enabled: current.enabled,
        textEnabled: current.textEnabled,
        nsfwEnabled: current.nsfwEnabled,
        ...current,
        ...patch,
        updatedAt: Date.now(),
        updatedBy: normalizeJid(updatedBy),
    };
    saveState(state);
    return state.groups[jid];
}

function setGlobalConfig(patch) {
    const state = loadState();
    state.global = {
        ...DEFAULT_STATE.global,
        ...(state.global || {}),
        ...patch,
    };
    saveState(state);
    return state.global;
}

async function isGroupAdmin(sock, groupJid, senderJid) {
    if (!isGroupJid(groupJid) || !senderJid || typeof sock?.groupMetadata !== "function") return false;
    try {
        const metadata = await sock.groupMetadata(groupJid);
        const senderNumber = getJidLabel(senderJid);
        const participant = (metadata?.participants || []).find(item => getJidLabel(item.id) === senderNumber);
        return Boolean(participant?.admin);
    } catch {
        return false;
    }
}

function formatStatus(groupJid = "", context = {}) {
    const config = getEffectiveConfig(groupJid, context);
    const health = getStickerSafetyHealth();
    return [
        "🛡️ *Sticker Safety Guard*",
        "",
        `Scope: ${isGroupJid(groupJid) ? groupJid : "global (group + private)"}`,
        `Guard: ${config.enabled ? "ON" : "OFF"}`,
        `Text OCR: ${config.textEnabled ? "ON" : "OFF"}`,
        `NSFW/Nudity AI: ${config.nsfwEnabled ? "ON" : "OFF"}`,
        `Debug: ${config.debug ? "ON" : "OFF"}`,
        "",
        `OCR: ${health.ocr}`,
        `NSFW AI: ${health.nsfw}`,
        `NSFW Pipeline: ${health.nsfwPipelineVersion}`,
        `Tensor Backend: ${health.tensorBackend}`,
        `Frame Sampling: ${health.maxFrames} evenly distributed`,
        `Crop Regions: up to ${health.maxRegions}`,
        `Queue: ${health.queue}`,
        `Cache: ${health.cache}`,
        `Last NSFW Scan: ${health.lastNsfwResult} (${Math.round(Number(health.lastNsfwConfidence || 0) * 100)}%)`,
        "Legacy Sticker NSFW: OFF",
    ].join("\n");
}

function formatHelp() {
    return [
        "🛡️ *Sticker Safety Guard*",
        "",
        ".stikerguard status",
        ".stikerguard on",
        ".stikerguard off",
        ".stikerguard text on/off",
        ".stikerguard nsfw on/off",
        ".stikerguard debug on/off",
        ".stikerguard scan — reply sticker untuk diagnosa",
        ".guardscan — alias cepat untuk scan sticker yang direply",
        ".stikerguard warmup — muat model NSFW",
        ".stikerguard clearcache — hapus cache hasil lama",
        "",
        "Remote group owner:",
        ".stikerguard set <id_grup> on/off",
        ".stikerguard set <id_grup> text on/off",
        ".stikerguard set <id_grup> nsfw on/off",
        ".stikerguard status <id_grup>",
        "",
        ".stikerword add <kata>",
        ".stikerword del <kata>",
        ".stikerword list",
        ".stikerword reload",
        "",
        "NSFW/Nudity aktif untuk sticker statis dan animasi di group maupun private chat.",
        "Sticker Safety Guard terpisah dari Anti Kasar biasa.",
    ].join("\n");
}

function formatScanResult(result) {
    const frames = result?.nsfw?.frames || [];
    const latestPredictions = result?.nsfw?.predictions || frames[0]?.predictions || {};
    const percent = value => `${Math.round(Number(value || 0) * 100)}%`;
    return [
        "🧪 STICKER SAFETY SCAN",
        "",
        `Type: ${result?.type || "-"}`,
        `Primary Frames: ${result?.nsfw?.primaryFrames ?? result?.frames ?? 0}`,
        `Crop Regions: ${result?.nsfw?.regionScans ?? 0}`,
        `Pipeline: ${result?.nsfw?.pipelineVersion || NSFW_PIPELINE_VERSION}`,
        "",
        "OCR:",
        `Text: "${String(result?.ocr?.text || "").slice(0, 700)}"`,
        `Matched Words: ${(result?.ocr?.badWords || []).length}`,
        "",
        "NSFW/Nudity:",
        `Porn: ${percent(latestPredictions.Porn)}`,
        `Hentai: ${percent(latestPredictions.Hentai)}`,
        `Sexy/Nudity: ${percent(latestPredictions.Sexy)}`,
        `Neutral: ${percent(latestPredictions.Neutral)}`,
        `Drawing: ${percent(latestPredictions.Drawing)}`,
        `Evidence Frame: ${result?.nsfw?.frameIndex ?? 0}`,
        `Evidence Region: ${result?.nsfw?.region || "full"}`,
        `Reason: ${result?.nsfw?.reason || "-"}`,
        "",
        `Decision: ${result?.violation ? `${String(result.violationType || "").toUpperCase()} VIOLATION` : "SAFE / NO VIOLATION"}`,
        `Category: ${result?.nsfw?.category || result?.violationType || "-"}`,
    ].join("\n");
}

async function handleStickerWordCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim();
    if (!isStickerWordCommand(text)) return false;
    const from = context.from || msg?.key?.remoteJid;
    if (context.isGroup) {
        await sock.sendMessage(from, { text: "Command .stikerword hanya lewat private owner." });
        return true;
    }
    if (!context.canControlOwner && !context.isOwner) {
        await sock.sendMessage(from, { text: "Akses Ditolak" });
        return true;
    }

    const parts = splitCommand(text);
    const action = String(parts[1] || "").toLowerCase();
    const arg = parts.slice(2).join(" ").trim().toLowerCase();
    const state = loadWordState();

    if (action === "add" && arg) {
        state.words = unique([...state.words, arg]).sort((a, b) => a.localeCompare(b));
        saveWordState(state);
        await sock.sendMessage(from, { text: `Kata OCR stiker ditambah: ${maskWord(arg)}` });
        return true;
    }

    if (action === "del" && arg) {
        state.words = state.words.filter(word => word !== arg);
        saveWordState(state);
        await sock.sendMessage(from, { text: `Kata OCR stiker dihapus: ${maskWord(arg)}` });
        return true;
    }

    if (action === "list") {
        const words = state.words.map((word, index) => `${index + 1}. ${maskWord(word)}`);
        await sock.sendMessage(from, { text: words.length ? `Daftar kata OCR stiker:\n\n${words.join("\n")}` : "Daftar kata OCR stiker kosong." });
        return true;
    }

    if (action === "reload") {
        wordCache = null;
        loadWordState();
        await sock.sendMessage(from, { text: "Daftar kata OCR stiker direload." });
        return true;
    }

    await sock.sendMessage(from, { text: "Format: .stikerword add/del/list/reload" });
    return true;
}

async function handleStickerSafetyCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim();
    if (await handleStickerWordCommand(sock, msg, context)) return true;
    if (!isStickerGuardCommand(text)) return false;

    const from = context.from || msg?.key?.remoteJid;
    const isGroup = Boolean(context.isGroup || isGroupJid(from));
    const senderJid = context.senderJid || context.sender || getSenderJid(msg);
    const isOwner = Boolean(context.canControlOwner || context.isOwner);
    const isAdmin = isGroup ? await isGroupAdmin(sock, from, senderJid) : false;
    const parts = splitCommand(text);
    const root = getCommandRoot(text);
    const action = root === ".guardscan" ? "scan" : String(parts[1] || "help").toLowerCase();

    if (!isOwner && !isAdmin) {
        await sock.sendMessage(from, { text: "Akses Ditolak" });
        return true;
    }

    if (action === "help") {
        await sock.sendMessage(from, { text: formatHelp() });
        return true;
    }

    if (action === "scan") {
        if (!isOwner) {
            await sock.sendMessage(from, { text: "Scan detail hanya untuk owner." });
            return true;
        }
        const quoted = getQuotedStickerMessage(msg);
        if (!quoted) {
            await sock.sendMessage(from, { text: "Reply stiker lalu ketik .stikerguard scan" });
            return true;
        }
        const result = await enqueueStickerJob(() => inspectSticker(sock, quoted, {
            ...context,
            ignoreCache: false,
            config: { enabled: true, textEnabled: true, nsfwEnabled: true, debug: true },
        }));
        await sock.sendMessage(from, { text: formatScanResult(result) });
        return true;
    }

    if (action === "warmup") {
        if (!isOwner) {
            await sock.sendMessage(from, { text: "Warmup model hanya untuk owner." });
            return true;
        }
        try {
            const health = await warmupNsfwModel();
            await sock.sendMessage(from, { text: `NSFW model READY.\n${health.nsfwDetail || health.nsfw}` });
        } catch (error) {
            await sock.sendMessage(from, { text: `NSFW model gagal dimuat: ${shortError(error)}` });
        }
        return true;
    }

    if (action === "clearcache") {
        if (!isOwner) {
            await sock.sendMessage(from, { text: "Clear cache hanya untuk owner." });
            return true;
        }
        clearStickerSafetyCache();
        await sock.sendMessage(from, { text: `Cache Sticker Safety dibersihkan. Pipeline aktif: ${NSFW_PIPELINE_VERSION}` });
        return true;
    }

    if (action === "status") {
        const target = isOwner && parts[2] && isGroupJid(parts[2]) ? parts[2] : isGroup ? from : "";
        await sock.sendMessage(from, { text: formatStatus(target, context) });
        return true;
    }

    if (action === "set") {
        if (!isOwner) {
            await sock.sendMessage(from, { text: "Remote set hanya untuk owner." });
            return true;
        }
        const groupJid = parts[2];
        if (!isGroupJid(groupJid)) {
            await sock.sendMessage(from, { text: "Format: .stikerguard set <id_grup> on/off/text/nsfw" });
            return true;
        }
        const key = String(parts[3] || "").toLowerCase();
        const value = String(parts[4] || "").toLowerCase();
        const patch = parseConfigPatch(key, value);
        if (!patch) {
            await sock.sendMessage(from, { text: "Format: .stikerguard set <id_grup> on/off | text on/off | nsfw on/off" });
            return true;
        }
        setGroupConfig(groupJid, patch, senderJid);
        await sock.sendMessage(from, { text: `Sticker Safety Guard untuk ${groupJid} diperbarui.\n${formatStatus(groupJid, context)}` });
        return true;
    }

    const patch = parseConfigPatch(action, String(parts[2] || "").toLowerCase());
    if (patch) {
        if (Object.prototype.hasOwnProperty.call(patch, "debug") && !isOwner) {
            await sock.sendMessage(from, { text: "Debug Sticker Safety Guard hanya untuk owner." });
            return true;
        }
        if (isGroup) setGroupConfig(from, patch, senderJid);
        else if (isOwner) setGlobalConfig(patch);
        await sock.sendMessage(from, { text: formatStatus(isGroup ? from : "", context) });
        return true;
    }

    await sock.sendMessage(from, { text: formatHelp() });
    return true;
}

function parseConfigPatch(action, value) {
    const directToggle = parseToggle(action);
    if (directToggle !== null) return { enabled: directToggle };
    const toggle = parseToggle(value);
    if (toggle === null) return null;
    if (action === "text") return { textEnabled: toggle };
    if (action === "nsfw") return { nsfwEnabled: toggle };
    if (action === "debug") return { debug: toggle };
    return null;
}

function parseToggle(value) {
    const clean = String(value || "").trim().toLowerCase();
    if (["on", "true", "1", "aktif", "enable", "enabled"].includes(clean)) return true;
    if (["off", "false", "0", "mati", "disable", "disabled"].includes(clean)) return false;
    return null;
}

async function cleanupStickerSafety() {
    ensureDirs();
    try {
        const entries = await fs.promises.readdir(TMP_ROOT, { withFileTypes: true });
        await Promise.all(entries.map(entry => {
            const target = path.join(TMP_ROOT, entry.name);
            if (entry.name === ".gitkeep") return Promise.resolve();
            return fs.promises.rm(target, { recursive: true, force: true });
        }));
    } catch {}
}

async function disposeStickerSafety() {
    disposed = true;
    queue.splice(0, queue.length).forEach(item => item.resolve({ inspected: false, reason: "disposed" }));
    try {
        if (ocrWorker && typeof ocrWorker.terminate === "function") await ocrWorker.terminate();
    } catch {}
    ocrWorker = null;
    ocrWorkerPromise = null;
    ocrStatus = "MISSING";
    try {
        if (nsfwModel && typeof nsfwModel.dispose === "function") nsfwModel.dispose();
    } catch {}
    nsfwModel = null;
    nsfwModelPromise = null;
    nsfwStatus = "MISSING";
    if (stateCache) saveState(stateCache);
    if (resultCache) saveResultCache();
    await cleanupStickerSafety();
    disposed = false;
}

function getStickerSafetyHealth() {
    let cacheCount = "UNKNOWN";
    try {
        cacheCount = Object.keys(loadResultCache()).length;
    } catch {}
    const effective = getEffectiveConfig("");
    const runtime = getRuntimeConfig();
    return {
        enabled: effective.enabled,
        textEnabled: effective.textEnabled,
        nsfwEnabled: effective.nsfwEnabled,
        scope: "GROUP + PRIVATE",
        ocr: ocrStatus === "READY" && ocrDetail ? `READY (${ocrDetail})` : ocrStatus,
        ocrLangs: ocrLangsActive || runtime.ocrLangs,
        nsfw: nsfwStatus,
        nsfwModel: runtime.nsfwModelName,
        nsfwDetail,
        nsfwPipelineVersion: NSFW_PIPELINE_VERSION,
        tensorBackend: tfBackendName,
        maxFrames: runtime.maxFrames,
        maxRegions: runtime.nsfwMaxRegions,
        thresholds: {
            porn: runtime.nsfwPornThreshold,
            hentai: runtime.nsfwHentaiThreshold,
            nudity: runtime.nsfwSexyThreshold,
            hard: runtime.nsfwHardThreshold,
        },
        queue: `${activeJobs}/${queue.length}`,
        queueActive: activeJobs,
        queuePending: queue.length,
        cache: cacheCount,
        legacyStickerNsfw: "OFF",
        sharp: !sharpLoadAttempted ? "LAZY" : sharp ? "READY" : `MISSING${sharpLoadError ? ` (${shortError(sharpLoadError)})` : ""}`,
        lastNsfwAt: nsfwRuntimeStats.lastScanAt,
        lastNsfwResult: nsfwRuntimeStats.lastResult,
        lastNsfwCategory: nsfwRuntimeStats.lastCategory,
        lastNsfwConfidence: nsfwRuntimeStats.lastConfidence,
        lastNsfwFrames: nsfwRuntimeStats.lastFrames,
        lastNsfwRegions: nsfwRuntimeStats.lastRegions,
        lastNsfwDurationMs: nsfwRuntimeStats.lastDurationMs,
        lastNsfwReason: nsfwRuntimeStats.lastReason,
    };
}

module.exports = {
    handleStickerSafety,
    handleStickerSafetyCommand,
    isStickerMessage,
    extractStickerMessage,
    downloadStickerBuffer,
    inspectSticker,
    inspectStickerText,
    inspectStickerNsfw,
    extractStickerFrames,
    buildEvenSampleTimestamps,
    probeMediaDuration,
    preprocessFrameForOcr,
    normalizeOcrText,
    findStickerBadWords,
    classifyNsfwFrame,
    buildNsfwRegions,
    getUnsafeScore,
    evaluateNsfwPredictions,
    buildStickerTextWarning,
    buildStickerNsfwWarning,
    getEffectiveConfig,
    loadState,
    saveState,
    cleanupStickerSafety,
    disposeStickerSafety,
    getStickerSafetyHealth,
    warmupNsfwModel,
    clearStickerSafetyCache,
    NSFW_PIPELINE_VERSION,
};
