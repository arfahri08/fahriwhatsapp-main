"use strict";

const fs = require("fs");
const path = require("path");
let pngjs = null;

function getPngJs() {
    if (!pngjs) pngjs = require("pngjs");
    return pngjs;
}

const ROOT_DIR = path.join(__dirname, "..");
const NUDENET_MODEL_PATH = path.join(ROOT_DIR, "data", "models", "nudenet", "320n.onnx");
const VIT_MODEL_DIR = path.join(ROOT_DIR, "data", "models", "AdamCodd", "vit-base-nsfw-detector");
const VIT_MODEL_PATH = path.join(VIT_MODEL_DIR, "onnx", "model_quantized.onnx");
const VIT_CONFIG_PATH = path.join(VIT_MODEL_DIR, "config.json");
const VIT_PREPROCESSOR_PATH = path.join(VIT_MODEL_DIR, "preprocessor_config.json");

const NUDENET_LABELS = [
    "FEMALE_GENITALIA_COVERED",
    "FACE_FEMALE",
    "BUTTOCKS_EXPOSED",
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_BREAST_EXPOSED",
    "ANUS_EXPOSED",
    "FEET_EXPOSED",
    "BELLY_COVERED",
    "FEET_COVERED",
    "ARMPITS_COVERED",
    "ARMPITS_EXPOSED",
    "FACE_MALE",
    "BELLY_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "ANUS_COVERED",
    "FEMALE_BREAST_COVERED",
    "BUTTOCKS_COVERED",
];

const EXPLICIT_CLASS_THRESHOLDS = Object.freeze({
    FEMALE_GENITALIA_EXPOSED: 0.16,
    MALE_GENITALIA_EXPOSED: 0.16,
    ANUS_EXPOSED: 0.16,
    FEMALE_BREAST_EXPOSED: 0.18,
    BUTTOCKS_EXPOSED: 0.22,
    MALE_BREAST_EXPOSED: 0.42,
});

let ortRuntime = null;
let ortLoadError = null;
let nudeNetSession = null;
let nudeNetSessionPromise = null;
let vitSession = null;
let vitSessionPromise = null;
let vitMetadata = null;
let disposed = false;

const runtimeState = {
    nudeNet: "LAZY",
    nudeNetDetail: "",
    vit: "LAZY",
    vitDetail: "",
    backend: "wasm",
    lastRunAt: 0,
    lastDurationMs: 0,
    lastResult: "never",
    lastReason: "",
    lastNudeNetFrames: 0,
    lastVitFrames: 0,
};

function parseBool(value, fallback = false) {
    const clean = String(value ?? "").trim();
    if (!clean) return fallback;
    if (/^(1|true|yes|on|aktif|enabled)$/i.test(clean)) return true;
    if (/^(0|false|no|off|mati|disabled)$/i.test(clean)) return false;
    return fallback;
}

function parseNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
}

function getConfig() {
    return {
        enabled: parseBool(process.env.STICKER_LOCAL_VISION_ENABLED, true),
        nudeNetEnabled: parseBool(process.env.STICKER_NUDENET_ENABLED, true),
        vitEnabled: parseBool(process.env.STICKER_VIT_NSFW_ENABLED, true),
        nudeNetModelPath: String(process.env.STICKER_NUDENET_MODEL_PATH || NUDENET_MODEL_PATH).trim(),
        vitModelPath: String(process.env.STICKER_VIT_MODEL_PATH || VIT_MODEL_PATH).trim(),
        nudeNetInputSize: Math.max(160, Math.min(640, Math.floor(parseNumber(process.env.STICKER_NUDENET_INPUT_SIZE, 320)))),
        vitInputSize: Math.max(224, Math.min(512, Math.floor(parseNumber(process.env.STICKER_VIT_INPUT_SIZE, 384)))),
        nudeNetMaxFrames: Math.max(1, Math.min(9, Math.floor(parseNumber(process.env.STICKER_NUDENET_MAX_FRAMES, 7)))),
        vitMaxFrames: Math.max(1, Math.min(4, Math.floor(parseNumber(process.env.STICKER_VIT_MAX_FRAMES, 3)))),
        nudeNetCandidateThreshold: clamp(parseNumber(process.env.STICKER_NUDENET_CANDIDATE_THRESHOLD, 0.12), 0.05, 0.95),
        nudeNetNmsThreshold: clamp(parseNumber(process.env.STICKER_NUDENET_NMS_THRESHOLD, 0.45), 0.05, 0.95),
        vitHardThreshold: clamp(parseNumber(process.env.STICKER_VIT_HARD_THRESHOLD, 0.72), 0.05, 0.99),
        vitFrameThreshold: clamp(parseNumber(process.env.STICKER_VIT_FRAME_THRESHOLD, 0.56), 0.05, 0.99),
        vitConsensusThreshold: clamp(parseNumber(process.env.STICKER_VIT_CONSENSUS_THRESHOLD, 0.50), 0.05, 0.99),
        wasmThreads: Math.max(1, Math.min(2, Math.floor(parseNumber(process.env.STICKER_ONNX_WASM_THREADS, 1)))),
        debug: parseBool(process.env.STICKER_LOCAL_VISION_DEBUG, false),
    };
}

function shortError(error) {
    return String(error?.message || error || "").replace(/\s+/g, " ").trim().slice(0, 400);
}

function getOrtRuntime() {
    if (ortRuntime) return ortRuntime;
    if (ortLoadError) throw ortLoadError;
    try {
        try {
            ortRuntime = require("onnxruntime-web/wasm");
        } catch {
            ortRuntime = require("onnxruntime-web");
        }
        const config = getConfig();
        if (ortRuntime?.env?.wasm) {
            ortRuntime.env.wasm.numThreads = config.wasmThreads;
            ortRuntime.env.wasm.proxy = false;
            ortRuntime.env.wasm.simd = true;
        }
        return ortRuntime;
    } catch (error) {
        ortLoadError = new Error(`onnxruntime-web tidak tersedia: ${shortError(error)}`);
        throw ortLoadError;
    }
}

function readJson(filePath, fallback = {}) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return fallback;
    }
}

function getVitMetadata() {
    if (vitMetadata) return vitMetadata;
    const config = readJson(VIT_CONFIG_PATH, {});
    const preprocessor = readJson(VIT_PREPROCESSOR_PATH, {});
    const id2label = config.id2label && typeof config.id2label === "object"
        ? config.id2label
        : { 0: "sfw", 1: "nsfw" };
    vitMetadata = {
        id2label,
        mean: Array.isArray(preprocessor.image_mean) ? preprocessor.image_mean : [0.5, 0.5, 0.5],
        std: Array.isArray(preprocessor.image_std) ? preprocessor.image_std : [0.5, 0.5, 0.5],
        size: Number(preprocessor?.size?.height || config.image_size || getConfig().vitInputSize),
    };
    return vitMetadata;
}

async function createSession(modelPath, label) {
    if (!fs.existsSync(modelPath)) throw new Error(`${label} model tidak ditemukan: ${modelPath}`);
    const ort = getOrtRuntime();
    const bytes = await fs.promises.readFile(modelPath);
    const modelData = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return ort.InferenceSession.create(modelData, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
        enableCpuMemArena: true,
        enableMemPattern: true,
        executionMode: "sequential",
    });
}

async function getNudeNetSession() {
    if (disposed) throw new Error("local vision disposed");
    if (nudeNetSession) return nudeNetSession;
    if (nudeNetSessionPromise) return nudeNetSessionPromise;
    const config = getConfig();
    runtimeState.nudeNet = "LOADING";
    nudeNetSessionPromise = createSession(config.nudeNetModelPath, "NudeNet")
        .then(session => {
            nudeNetSession = session;
            runtimeState.nudeNet = "READY";
            runtimeState.nudeNetDetail = `${path.basename(config.nudeNetModelPath)} / ${session.inputNames?.[0] || "input"}`;
            return session;
        })
        .catch(error => {
            runtimeState.nudeNet = "ERROR";
            runtimeState.nudeNetDetail = shortError(error);
            nudeNetSessionPromise = null;
            throw error;
        });
    return nudeNetSessionPromise;
}

async function getVitSession() {
    if (disposed) throw new Error("local vision disposed");
    if (vitSession) return vitSession;
    if (vitSessionPromise) return vitSessionPromise;
    const config = getConfig();
    runtimeState.vit = "LOADING";
    vitSessionPromise = createSession(config.vitModelPath, "ViT NSFW")
        .then(session => {
            vitSession = session;
            runtimeState.vit = "READY";
            runtimeState.vitDetail = `${path.basename(config.vitModelPath)} / ${session.inputNames?.[0] || "pixel_values"}`;
            return session;
        })
        .catch(error => {
            runtimeState.vit = "ERROR";
            runtimeState.vitDetail = shortError(error);
            vitSessionPromise = null;
            throw error;
        });
    return vitSessionPromise;
}

function decodePng(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new Error("frame PNG harus Buffer");
    const { PNG } = getPngJs();
    return PNG.sync.read(buffer);
}

function compositePixel(source, x, y, background = 255) {
    if (x < 0 || y < 0 || x >= source.width || y >= source.height) {
        return [background, background, background];
    }
    const index = ((source.width * y) + x) << 2;
    const alpha = source.data[index + 3] / 255;
    return [
        Math.round((source.data[index] * alpha) + (background * (1 - alpha))),
        Math.round((source.data[index + 1] * alpha) + (background * (1 - alpha))),
        Math.round((source.data[index + 2] * alpha) + (background * (1 - alpha))),
    ];
}

function preprocessNudeNetPng(buffer, inputSize = getConfig().nudeNetInputSize) {
    const source = decodePng(buffer);
    const size = Math.max(1, Math.floor(inputSize));
    const maxSize = Math.max(source.width, source.height);
    const data = new Float32Array(3 * size * size);
    const plane = size * size;

    for (let y = 0; y < size; y += 1) {
        const paddedY = Math.min(maxSize - 1, Math.floor((y + 0.5) * maxSize / size));
        for (let x = 0; x < size; x += 1) {
            const paddedX = Math.min(maxSize - 1, Math.floor((x + 0.5) * maxSize / size));
            const [r, g, b] = paddedX < source.width && paddedY < source.height
                ? compositePixel(source, paddedX, paddedY, 0)
                : [0, 0, 0];
            const target = (y * size) + x;
            data[target] = r / 255;
            data[plane + target] = g / 255;
            data[(2 * plane) + target] = b / 255;
        }
    }

    return {
        data,
        dims: [1, 3, size, size],
        originalWidth: source.width,
        originalHeight: source.height,
        paddedSize: maxSize,
        modelSize: size,
    };
}

function preprocessVitPng(buffer, inputSize = getConfig().vitInputSize) {
    const source = decodePng(buffer);
    const metadata = getVitMetadata();
    const size = Math.max(1, Math.floor(inputSize || metadata.size));
    const data = new Float32Array(3 * size * size);
    const plane = size * size;

    for (let y = 0; y < size; y += 1) {
        const sourceY = Math.min(source.height - 1, Math.floor((y + 0.5) * source.height / size));
        for (let x = 0; x < size; x += 1) {
            const sourceX = Math.min(source.width - 1, Math.floor((x + 0.5) * source.width / size));
            const rgb = compositePixel(source, sourceX, sourceY, 255);
            const target = (y * size) + x;
            for (let channel = 0; channel < 3; channel += 1) {
                const normalized = ((rgb[channel] / 255) - Number(metadata.mean[channel] ?? 0.5))
                    / Number(metadata.std[channel] || 0.5);
                data[(channel * plane) + target] = normalized;
            }
        }
    }

    return { data, dims: [1, 3, size, size], originalWidth: source.width, originalHeight: source.height };
}

function softmax(values) {
    const items = Array.from(values || [], Number);
    if (!items.length) return [];
    const max = Math.max(...items);
    const exp = items.map(value => Math.exp(value - max));
    const sum = exp.reduce((total, value) => total + value, 0) || 1;
    return exp.map(value => value / sum);
}

function intersectionOverUnion(a, b) {
    const ax2 = a[0] + a[2];
    const ay2 = a[1] + a[3];
    const bx2 = b[0] + b[2];
    const by2 = b[1] + b[3];
    const intersectionWidth = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
    const intersectionHeight = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
    const intersection = intersectionWidth * intersectionHeight;
    const union = (a[2] * a[3]) + (b[2] * b[3]) - intersection;
    return union > 0 ? intersection / union : 0;
}

function nonMaxSuppression(detections, iouThreshold = getConfig().nudeNetNmsThreshold, maxResults = 80) {
    const pending = [...(detections || [])].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    const selected = [];
    while (pending.length && selected.length < maxResults) {
        const candidate = pending.shift();
        selected.push(candidate);
        for (let index = pending.length - 1; index >= 0; index -= 1) {
            const sameClass = pending[index].classId === candidate.classId;
            if (sameClass && intersectionOverUnion(candidate.box, pending[index].box) > iouThreshold) {
                pending.splice(index, 1);
            }
        }
    }
    return selected;
}

function parseNudeNetOutput(outputTensor, metadata, options = {}) {
    const dims = Array.from(outputTensor?.dims || []);
    const data = outputTensor?.data;
    if (!data || dims.length < 2) throw new Error(`output NudeNet tidak valid: ${JSON.stringify(dims)}`);

    const featureCount = 4 + NUDENET_LABELS.length;
    let rows = 0;
    let valueAt = null;

    if (dims.length === 3 && dims[1] === featureCount) {
        rows = dims[2];
        valueAt = (row, feature) => Number(data[(feature * rows) + row] || 0);
    } else if (dims.length === 3 && dims[2] === featureCount) {
        rows = dims[1];
        valueAt = (row, feature) => Number(data[(row * featureCount) + feature] || 0);
    } else if (dims.length === 2 && dims[0] === featureCount) {
        rows = dims[1];
        valueAt = (row, feature) => Number(data[(feature * rows) + row] || 0);
    } else if (dims.length === 2 && dims[1] === featureCount) {
        rows = dims[0];
        valueAt = (row, feature) => Number(data[(row * featureCount) + feature] || 0);
    } else {
        throw new Error(`shape output NudeNet tidak dikenali: ${JSON.stringify(dims)}`);
    }

    const threshold = Number(options.candidateThreshold ?? getConfig().nudeNetCandidateThreshold);
    const modelSize = Number(metadata.modelSize || 320);
    const scale = Number(metadata.paddedSize || Math.max(metadata.originalWidth, metadata.originalHeight)) / modelSize;
    const detections = [];

    for (let row = 0; row < rows; row += 1) {
        let classId = 0;
        let score = -Infinity;
        for (let index = 0; index < NUDENET_LABELS.length; index += 1) {
            const candidate = valueAt(row, 4 + index);
            if (candidate > score) {
                score = candidate;
                classId = index;
            }
        }
        if (!Number.isFinite(score) || score < threshold) continue;

        const centerX = valueAt(row, 0) * scale;
        const centerY = valueAt(row, 1) * scale;
        const width = valueAt(row, 2) * scale;
        const height = valueAt(row, 3) * scale;
        const left = clamp(centerX - (width / 2), 0, metadata.originalWidth);
        const top = clamp(centerY - (height / 2), 0, metadata.originalHeight);
        const clippedWidth = clamp(width, 0, metadata.originalWidth - left);
        const clippedHeight = clamp(height, 0, metadata.originalHeight - top);
        if (clippedWidth <= 0 || clippedHeight <= 0) continue;

        detections.push({
            class: NUDENET_LABELS[classId],
            classId,
            score,
            box: [Math.round(left), Math.round(top), Math.round(clippedWidth), Math.round(clippedHeight)],
        });
    }

    return nonMaxSuppression(detections, options.nmsThreshold ?? getConfig().nudeNetNmsThreshold);
}

function evaluateNudeNetDetections(detections = []) {
    const explicit = [];
    for (const detection of detections || []) {
        const threshold = EXPLICIT_CLASS_THRESHOLDS[detection.class];
        if (threshold !== undefined && Number(detection.score || 0) >= threshold) explicit.push(detection);
    }
    explicit.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

    if (explicit.length) {
        const strongest = explicit[0];
        const genital = /GENITALIA|ANUS/.test(strongest.class);
        const category = genital ? "porn" : "nudity";
        return {
            violation: true,
            category,
            confidence: Number(strongest.score || 0),
            reason: `nudenet:${strongest.class.toLowerCase()}`,
            strongest,
            explicit,
        };
    }

    return {
        violation: false,
        category: null,
        confidence: Math.max(0, ...(detections || []).map(item => Number(item.score || 0))),
        reason: "nudenet-no-explicit-class",
        strongest: detections?.[0] || null,
        explicit: [],
    };
}

function selectEvenFrameIndexes(total, maxFrames) {
    const count = Math.max(0, Math.floor(Number(total) || 0));
    const max = Math.max(1, Math.floor(Number(maxFrames) || 1));
    if (count <= max) return Array.from({ length: count }, (_, index) => index);
    const indexes = new Set();
    for (let index = 0; index < max; index += 1) {
        indexes.add(Math.round(index * (count - 1) / (max - 1)));
    }
    return [...indexes].sort((a, b) => a - b);
}

async function classifyNudeNetFrame(frame, frameIndex = 0) {
    const config = getConfig();
    const session = await getNudeNetSession();
    const ort = getOrtRuntime();
    const prepared = preprocessNudeNetPng(frame?.buffer || frame, config.nudeNetInputSize);
    const inputName = session.inputNames?.[0] || "images";
    const tensor = new ort.Tensor("float32", prepared.data, prepared.dims);
    const outputMap = await session.run({ [inputName]: tensor });
    const outputName = session.outputNames?.[0] || Object.keys(outputMap)[0];
    const detections = parseNudeNetOutput(outputMap[outputName], prepared, {
        candidateThreshold: config.nudeNetCandidateThreshold,
        nmsThreshold: config.nudeNetNmsThreshold,
    });
    return {
        frameIndex,
        timestamp: frame?.timestamp ?? null,
        detections,
        decision: evaluateNudeNetDetections(detections),
    };
}

async function classifyVitFrame(frame, frameIndex = 0) {
    const config = getConfig();
    const session = await getVitSession();
    const ort = getOrtRuntime();
    const prepared = preprocessVitPng(frame?.buffer || frame, config.vitInputSize);
    const inputName = session.inputNames?.[0] || "pixel_values";
    const tensor = new ort.Tensor("float32", prepared.data, prepared.dims);
    const outputMap = await session.run({ [inputName]: tensor });
    const outputName = session.outputNames?.[0] || Object.keys(outputMap)[0];
    const logits = Array.from(outputMap[outputName]?.data || [], Number);
    const probabilities = softmax(logits);
    const metadata = getVitMetadata();
    let nsfwIndex = 1;
    for (const [key, label] of Object.entries(metadata.id2label || {})) {
        if (String(label).toLowerCase() === "nsfw") nsfwIndex = Number(key);
    }
    return {
        frameIndex,
        timestamp: frame?.timestamp ?? null,
        logits,
        probabilities,
        nsfw: Number(probabilities[nsfwIndex] || 0),
    };
}

async function inspectNudeNetFrames(frames = [], options = {}) {
    const config = getConfig();
    const result = {
        engine: "nudenet-320n",
        available: false,
        violation: false,
        category: null,
        confidence: 0,
        reason: "disabled",
        frames: [],
        detections: [],
        error: "",
    };
    if (!config.enabled || !config.nudeNetEnabled || options.enabled === false) return result;

    try {
        const indexes = selectEvenFrameIndexes(frames.length, options.maxFrames || config.nudeNetMaxFrames);
        for (const index of indexes) {
            const frameResult = await classifyNudeNetFrame(frames[index], index);
            result.frames.push(frameResult);
            for (const detection of frameResult.detections) {
                result.detections.push({ ...detection, frameIndex: index, timestamp: frames[index]?.timestamp ?? null });
            }
        }
        result.available = true;
        const decision = evaluateNudeNetDetections(result.detections);
        Object.assign(result, decision);
        return result;
    } catch (error) {
        result.error = shortError(error);
        result.reason = "nudenet-error";
        return result;
    }
}

async function inspectVitFrames(frames = [], options = {}) {
    const config = getConfig();
    const result = {
        engine: "vit-nsfw-onnx",
        available: false,
        violation: false,
        category: null,
        confidence: 0,
        reason: "disabled",
        frames: [],
        error: "",
    };
    if (!config.enabled || !config.vitEnabled || options.enabled === false) return result;

    try {
        const indexes = selectEvenFrameIndexes(frames.length, options.maxFrames || config.vitMaxFrames);
        for (const index of indexes) result.frames.push(await classifyVitFrame(frames[index], index));
        result.available = true;
        const scores = result.frames.map(item => Number(item.nsfw || 0));
        const maxScore = Math.max(0, ...scores);
        const consensusHits = scores.filter(score => score >= config.vitConsensusThreshold).length;
        result.confidence = maxScore;
        if (maxScore >= config.vitHardThreshold) {
            result.violation = true;
            result.category = "porn";
            result.reason = "vit-hard-threshold";
        } else if (maxScore >= config.vitFrameThreshold && (scores.length === 1 || consensusHits >= 2)) {
            result.violation = true;
            result.category = "porn";
            result.reason = "vit-frame-consensus";
        } else {
            result.reason = "vit-below-threshold";
        }
        return result;
    } catch (error) {
        result.error = shortError(error);
        result.reason = "vit-error";
        return result;
    }
}

async function inspectFrames(frames = [], options = {}) {
    const startedAt = Date.now();
    const result = {
        available: false,
        violation: false,
        category: null,
        confidence: 0,
        reason: "no-engine",
        nudeNet: null,
        vit: null,
        errors: [],
    };
    if (!frames.length) {
        result.reason = "no-frames";
        return result;
    }

    result.nudeNet = await inspectNudeNetFrames(frames, options);
    result.available = result.available || result.nudeNet.available;
    if (result.nudeNet.error) result.errors.push(result.nudeNet.error);
    if (result.nudeNet.violation) {
        Object.assign(result, {
            violation: true,
            category: result.nudeNet.category,
            confidence: result.nudeNet.confidence,
            reason: result.nudeNet.reason,
        });
    } else {
        result.vit = await inspectVitFrames(frames, options);
        result.available = result.available || result.vit.available;
        if (result.vit.error) result.errors.push(result.vit.error);
        if (result.vit.violation) {
            Object.assign(result, {
                violation: true,
                category: result.vit.category,
                confidence: result.vit.confidence,
                reason: result.vit.reason,
            });
        } else {
            result.confidence = Math.max(
                Number(result.nudeNet?.confidence || 0),
                Number(result.vit?.confidence || 0)
            );
            result.reason = result.available ? "local-vision-clean" : "local-vision-unavailable";
        }
    }

    runtimeState.lastRunAt = Date.now();
    runtimeState.lastDurationMs = Date.now() - startedAt;
    runtimeState.lastResult = result.violation ? "violation" : result.available ? "clean" : "error";
    runtimeState.lastReason = result.reason;
    runtimeState.lastNudeNetFrames = result.nudeNet?.frames?.length || 0;
    runtimeState.lastVitFrames = result.vit?.frames?.length || 0;
    return result;
}

async function warmup() {
    const config = getConfig();
    const results = {};
    if (config.nudeNetEnabled) {
        try {
            await getNudeNetSession();
            results.nudeNet = "READY";
        } catch (error) {
            results.nudeNet = `ERROR: ${shortError(error)}`;
        }
    }
    if (config.vitEnabled) {
        try {
            await getVitSession();
            results.vit = "READY";
        } catch (error) {
            results.vit = `ERROR: ${shortError(error)}`;
        }
    }
    return results;
}

function getHealth() {
    const config = getConfig();
    let ort = "LAZY";
    try {
        require.resolve("onnxruntime-web");
        ort = ortLoadError ? `ERROR (${shortError(ortLoadError)})` : "INSTALLED";
    } catch {
        ort = "MISSING";
    }
    const fileStatus = filePath => {
        try {
            const stats = fs.statSync(filePath);
            return `READY (${Math.round(stats.size / 1024 / 1024)}MB)`;
        } catch {
            return "MISSING";
        }
    };
    return {
        enabled: config.enabled,
        backend: runtimeState.backend,
        onnxRuntime: ort,
        nudeNet: runtimeState.nudeNet,
        nudeNetDetail: runtimeState.nudeNetDetail,
        nudeNetModel: fileStatus(config.nudeNetModelPath),
        vit: runtimeState.vit,
        vitDetail: runtimeState.vitDetail,
        vitModel: fileStatus(config.vitModelPath),
        lastRunAt: runtimeState.lastRunAt,
        lastDurationMs: runtimeState.lastDurationMs,
        lastResult: runtimeState.lastResult,
        lastReason: runtimeState.lastReason,
        lastNudeNetFrames: runtimeState.lastNudeNetFrames,
        lastVitFrames: runtimeState.lastVitFrames,
    };
}

async function dispose() {
    disposed = true;
    for (const session of [nudeNetSession, vitSession]) {
        try {
            if (session && typeof session.release === "function") await session.release();
        } catch {}
    }
    nudeNetSession = null;
    nudeNetSessionPromise = null;
    vitSession = null;
    vitSessionPromise = null;
    ortRuntime = null;
    ortLoadError = null;
    runtimeState.nudeNet = "LAZY";
    runtimeState.vit = "LAZY";
    disposed = false;
}

module.exports = {
    NUDENET_LABELS,
    EXPLICIT_CLASS_THRESHOLDS,
    NUDENET_MODEL_PATH,
    VIT_MODEL_PATH,
    preprocessNudeNetPng,
    preprocessVitPng,
    parseNudeNetOutput,
    evaluateNudeNetDetections,
    nonMaxSuppression,
    intersectionOverUnion,
    selectEvenFrameIndexes,
    softmax,
    classifyNudeNetFrame,
    classifyVitFrame,
    inspectNudeNetFrames,
    inspectVitFrames,
    inspectFrames,
    warmup,
    getHealth,
    dispose,
};
