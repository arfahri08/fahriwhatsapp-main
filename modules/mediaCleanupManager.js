const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "mediaCleanupState.json");

const DEFAULT_MAX_AGE_HOURS = 48;
const DEFAULT_SCAN_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_POSTPONE_HOURS = 24;
const DEFAULT_BATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DIR_NAMES = ["downloads", "downloaded", "media", "viewonce", "view_once", "temp"];

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".3gp"]);
const VIEW_ONCE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".mkv", ".webm", ".3gp"]);
const MEDIA_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...VIEW_ONCE_EXTENSIONS]);
const NEVER_DELETE_EXTENSIONS = new Set([
    ".json",
    ".js",
    ".env",
    ".db",
    ".sqlite",
    ".session",
    ".auth",
    ".txt",
    ".log",
    ".pdf",
    ".doc",
    ".docx",
    ".zip",
]);
const PROTECTED_DIR_NAMES = new Set([
    "auth",
    "data",
    "modules",
    "node_modules",
    ".git",
    ".vscode",
]);

let cleanupInterval = null;
let activeSock = null;
let activeOptions = {};
let scanInProgress = false;

function logCleanupError(stage, error, extra = {}) {
    console.log("[MEDIA CLEANUP ERROR]", {
        stage,
        errorMessage: error?.message,
        stack: error?.stack,
        ...extra,
    });
}

function normalizeJid(value) {
    const clean = String(value || "").trim();
    if (!clean || clean === "status@broadcast") return null;

    if (clean.includes("@")) {
        const [rawUser, rawServer] = clean.split("@");
        const user = String(rawUser || "").split(":")[0].split("_")[0].replace(/[^0-9]/g, "");
        const server = String(rawServer || "").toLowerCase();
        if (!user || !server) return null;
        return `${user}@${server}`;
    }

    const number = clean.replace(/[^0-9]/g, "");
    return number ? `${number}@s.whatsapp.net` : null;
}

function getJidNumber(value) {
    return String(value || "").split("@")[0].split(":")[0].split("_")[0].replace(/[^0-9]/g, "");
}

function isSameUser(a, b) {
    const numberA = getJidNumber(a);
    const numberB = getJidNumber(b);
    return Boolean(numberA && numberB && numberA === numberB);
}

function collectOwnerJids(options = {}) {
    const ownerJids = [
        options.ownerJid,
        ...(Array.isArray(options.ownerJids) ? options.ownerJids : []),
    ]
        .map(normalizeJid)
        .filter(Boolean);

    return [...new Set(ownerJids)];
}

function getPrimaryOwnerJid(options = {}, msg = null) {
    const ownerJids = collectOwnerJids(options);
    if (ownerJids[0]) return ownerJids[0];

    const from = msg?.key?.remoteJid;
    if (from && !String(from).endsWith("@g.us")) return normalizeJid(from);
    return null;
}

function isOwnerMessage(msg, ownerJids = []) {
    if (msg?.key?.fromMe === true) return true;

    const owners = (ownerJids || []).map(normalizeJid).filter(Boolean);
    if (owners.length === 0) return false;

    const from = msg?.key?.remoteJid;
    const sender = msg?.key?.participant || msg?.participant || from;

    return owners.some(ownerJid => isSameUser(ownerJid, sender) || isSameUser(ownerJid, from));
}

function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return "0 B";

    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = value;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }

    const decimals = unitIndex === 0 ? 0 : 2;
    return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatAge(ms) {
    const value = Number(ms || 0);
    if (!Number.isFinite(value) || value <= 0) return "0 jam";

    const hours = Math.floor(value / (60 * 60 * 1000));
    if (hours >= 48) {
        const days = Math.floor(hours / 24);
        return `${days} hari`;
    }
    return `${hours} jam`;
}

function envEnabledDefault() {
    return String(process.env.MEDIA_CLEANUP_ENABLED || "true").trim().toLowerCase() !== "false";
}

function createDefaultState() {
    return {
        version: 1,
        enabled: envEnabledDefault(),
        batches: [],
        lastScanAt: null,
        updatedAt: Date.now(),
    };
}

function ensureStateFile() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(STATE_FILE)) {
        fs.writeFileSync(STATE_FILE, JSON.stringify(createDefaultState(), null, 2));
    }
}

function normalizeState(state) {
    const clean = state && typeof state === "object" ? state : createDefaultState();
    if (typeof clean.enabled !== "boolean") clean.enabled = envEnabledDefault();
    if (!Array.isArray(clean.batches)) clean.batches = [];
    clean.version = clean.version || 1;
    clean.updatedAt = clean.updatedAt || Date.now();
    return clean;
}

function loadState() {
    ensureStateFile();
    try {
        return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
    } catch (error) {
        logCleanupError("load-state", error);
        return createDefaultState();
    }
}

function saveState(state) {
    ensureStateFile();
    const clean = normalizeState(state);
    clean.updatedAt = Date.now();

    const tempFile = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(clean, null, 2));
    fs.renameSync(tempFile, STATE_FILE);
    return clean;
}

function normalizeResolvedPath(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(parent, child) {
    const parentResolved = normalizeResolvedPath(parent);
    const childResolved = normalizeResolvedPath(child);
    const relative = path.relative(parentResolved, childResolved);
    return Boolean(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isSameOrInside(parent, child) {
    const parentResolved = normalizeResolvedPath(parent);
    const childResolved = normalizeResolvedPath(child);
    return parentResolved === childResolved || isPathInside(parentResolved, childResolved);
}

function normalizePosixLike(filePath) {
    return path.resolve(filePath).replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function isExternalStoragePath(filePath) {
    const normalized = normalizePosixLike(filePath);
    return normalized === "/sdcard" ||
        normalized.startsWith("/sdcard/") ||
        normalized === "/storage/emulated/0" ||
        normalized.startsWith("/storage/emulated/0/");
}

function isDangerousDirectory(dir) {
    const resolved = path.resolve(dir);
    const parsedRoot = path.parse(resolved).root;
    if (normalizeResolvedPath(resolved) === normalizeResolvedPath(parsedRoot)) return true;
    if (normalizeResolvedPath(resolved) === normalizeResolvedPath(PROJECT_ROOT)) return true;
    if (normalizeResolvedPath(resolved) === normalizeResolvedPath(os.tmpdir())) return true;

    const normalized = normalizePosixLike(resolved);
    if (["/", "/storage", "/storage/emulated", "/storage/emulated/0", "/sdcard"].includes(normalized)) {
        return true;
    }

    const baseName = path.basename(resolved).toLowerCase();
    if (PROTECTED_DIR_NAMES.has(baseName)) return true;

    for (const protectedName of PROTECTED_DIR_NAMES) {
        const protectedPath = path.join(PROJECT_ROOT, protectedName);
        if (isSameOrInside(protectedPath, resolved)) return true;
    }

    return false;
}

function isSafeExternalMediaDir(dir) {
    if (!isExternalStoragePath(dir)) return true;
    const baseName = path.basename(path.resolve(dir)).toLowerCase();
    return /userbot|fahri|viewonce|view_once|cleanmedia|baileys/.test(baseName);
}

function safeRealPath(dir) {
    try {
        return fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
    } catch {
        return path.resolve(dir);
    }
}

function addAllowedEntry(entries, seen, rawDir, category, source) {
    if (!rawDir) return;

    const resolved = path.resolve(rawDir);
    let stat = null;
    try {
        stat = fs.lstatSync(resolved);
    } catch {
        return;
    }

    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    if (isDangerousDirectory(resolved)) return;
    if (!isSafeExternalMediaDir(resolved)) return;

    const insideProject = isSameOrInside(PROJECT_ROOT, resolved);
    const insideTemp = isSameOrInside(os.tmpdir(), resolved);
    if (source !== "module" && !insideProject) return;
    if (source === "module" && !insideProject && !insideTemp && isExternalStoragePath(resolved)) return;

    const realPath = safeRealPath(resolved);
    const key = normalizeResolvedPath(realPath);
    if (seen.has(key)) return;
    seen.add(key);

    entries.push({
        path: realPath,
        category: category || inferCategoryFromDir(realPath),
        source,
    });
}

function splitDirConfig(value) {
    return String(value || "")
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
}

function inferCategoryFromDir(dir) {
    const normalized = path.basename(path.resolve(dir)).toLowerCase();
    const full = normalizePosixLike(dir);
    if (/view.?once|brankas.?vo|(^|[/_-])vo($|[/_-])/.test(full)) return "viewOnce";
    if (/download|temp|tmp|userbot-fahri-downloads/.test(normalized)) return "videoDownloader";
    return "auto";
}

function getModuleMediaDirs() {
    const entries = [];

    try {
        const localDownloader = require("./localDownloader");
        const dirs = typeof localDownloader.getMediaDirs === "function"
            ? localDownloader.getMediaDirs()
            : [localDownloader.MEDIA_DIR].filter(Boolean);

        for (const dir of dirs || []) {
            entries.push({ dir, category: "videoDownloader", source: "module" });
        }
    } catch (error) {
        logCleanupError("read-local-downloader-dirs", error);
    }

    try {
        const viewonce = require("./viewonce");
        const dirs = typeof viewonce.getMediaDirs === "function"
            ? viewonce.getMediaDirs()
            : [viewonce.MEDIA_DIR].filter(Boolean);

        for (const dir of dirs || []) {
            entries.push({ dir, category: "viewOnce", source: "module" });
        }
    } catch (error) {
        logCleanupError("read-viewonce-dirs", error);
    }

    return entries;
}

function getAllowedDirEntries(options = {}) {
    const entries = [];
    const seen = new Set();

    for (const item of getModuleMediaDirs()) {
        addAllowedEntry(entries, seen, item.dir, item.category, item.source);
    }

    const optionDirs = [
        ...(Array.isArray(options.allowedDirs) ? options.allowedDirs : []),
        ...(Array.isArray(options.mediaDirs) ? options.mediaDirs : []),
    ];
    for (const dir of optionDirs) {
        addAllowedEntry(entries, seen, dir, inferCategoryFromDir(dir), "option");
    }

    const configuredNames = process.env.MEDIA_CLEANUP_DIRS
        ? splitDirConfig(process.env.MEDIA_CLEANUP_DIRS)
        : DEFAULT_DIR_NAMES;

    for (const item of configuredNames) {
        const target = path.isAbsolute(item) ? item : path.join(PROJECT_ROOT, item);
        addAllowedEntry(entries, seen, target, inferCategoryFromDir(target), "env");
    }

    return entries;
}

function getAllowedDirs(options = {}) {
    return getAllowedDirEntries(options).map(entry => entry.path);
}

function isAllowedMediaFile(filePath) {
    const ext = path.extname(String(filePath || "")).toLowerCase();
    if (!ext || NEVER_DELETE_EXTENSIONS.has(ext)) return false;
    return MEDIA_EXTENSIONS.has(ext);
}

function isAllowedMediaFileForCategory(filePath, category) {
    if (!isAllowedMediaFile(filePath)) return false;

    const ext = path.extname(String(filePath || "")).toLowerCase();
    if (category === "videoDownloader") return VIDEO_EXTENSIONS.has(ext);
    if (category === "viewOnce") return VIEW_ONCE_EXTENSIONS.has(ext);
    return MEDIA_EXTENSIONS.has(ext);
}

function isPathInsideAllowedDirs(filePath, allowedDirs) {
    const resolvedFile = path.resolve(filePath);
    return (allowedDirs || []).some(dir => {
        const resolvedDir = path.resolve(dir);
        return normalizeResolvedPath(resolvedFile) === normalizeResolvedPath(resolvedDir) ||
            isSameOrInside(resolvedDir, resolvedFile);
    });
}

function categoryForFile(filePath, dirCategory) {
    if (dirCategory === "videoDownloader" || dirCategory === "viewOnce") return dirCategory;

    const ext = path.extname(filePath).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return "viewOnce";
    return "videoDownloader";
}

async function scanDirectoryRecursive(dir, options = {}) {
    const resolvedDir = path.resolve(dir);
    const allowedDirs = options.allowedDirs || [resolvedDir];
    const now = Number(options.now || Date.now());
    const maxAgeHours = Number(options.maxAgeHours || process.env.MEDIA_CLEANUP_MAX_AGE_HOURS || DEFAULT_MAX_AGE_HOURS);
    const maxAgeMs = Math.max(1, maxAgeHours) * 60 * 60 * 1000;
    const maxDepth = Number(options.maxDepth || 8);
    const files = [];

    if (!isPathInsideAllowedDirs(path.join(resolvedDir, "__probe__"), [resolvedDir])) return files;

    async function walk(currentDir, depth) {
        if (depth > maxDepth) return;

        let entries = [];
        try {
            entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        } catch (error) {
            logCleanupError("scan-read-dir", error, { dir: currentDir });
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (!isPathInsideAllowedDirs(fullPath, allowedDirs)) continue;
            if (entry.isSymbolicLink()) continue;

            if (entry.isDirectory()) {
                if (PROTECTED_DIR_NAMES.has(entry.name.toLowerCase())) continue;
                await walk(fullPath, depth + 1);
                continue;
            }

            if (!entry.isFile()) continue;

            const category = categoryForFile(fullPath, options.category || "auto");
            if (!isAllowedMediaFileForCategory(fullPath, category)) continue;

            let stat = null;
            try {
                stat = await fs.promises.lstat(fullPath);
            } catch (error) {
                logCleanupError("scan-stat-file", error, { filePath: fullPath });
                continue;
            }

            if (!stat.isFile() || stat.isSymbolicLink()) continue;

            const ageMs = now - stat.mtimeMs;
            if (ageMs < maxAgeMs) continue;

            files.push({
                path: path.resolve(fullPath),
                name: path.basename(fullPath),
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                ageHours: Number((ageMs / (60 * 60 * 1000)).toFixed(1)),
                category,
            });
        }
    }

    await walk(resolvedDir, 0);
    return files;
}

function formatDateForId(date) {
    const pad = value => String(value).padStart(2, "0");
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        "_",
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join("");
}

function createCleanupBatch(files, options = {}) {
    const now = Date.now();
    const cleanFiles = (files || []).map(file => ({
        path: path.resolve(file.path),
        name: path.basename(file.name || file.path),
        size: Number(file.size || 0),
        mtimeMs: Number(file.mtimeMs || 0),
        ageHours: Number(file.ageHours || 0),
        category: file.category || "auto",
    }));

    const totalSize = cleanFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
    const random = crypto.randomBytes(3).toString("hex");

    return {
        id: `cleanup_${formatDateForId(new Date(now))}_${random}`,
        createdAt: now,
        status: "pending",
        files: cleanFiles,
        totalSize,
        totalFiles: cleanFiles.length,
        maxAgeHours: Number(options.maxAgeHours || process.env.MEDIA_CLEANUP_MAX_AGE_HOURS || DEFAULT_MAX_AGE_HOURS),
        expiresAt: now + DEFAULT_BATCH_TTL_MS,
        postponedUntil: null,
        canceledUntil: null,
        lastNotifiedAt: null,
    };
}

function fileIdentity(file) {
    const resolved = normalizeResolvedPath(file?.path || "");
    return `${resolved}|${Number(file?.size || 0)}|${Math.round(Number(file?.mtimeMs || 0))}`;
}

function refreshBatchStatuses(state, now = Date.now()) {
    let changed = false;

    for (const batch of state.batches || []) {
        if (batch.status === "postponed" && batch.postponedUntil && batch.postponedUntil <= now) {
            batch.status = "pending";
            batch.lastNotifiedAt = null;
            changed = true;
        }
    }

    return changed;
}

function getLatestPendingBatch(includePostponed = false) {
    const state = loadState();
    if (refreshBatchStatuses(state)) saveState(state);

    const now = Date.now();
    const batches = (state.batches || [])
        .filter(batch => {
            if (batch.status === "pending") {
                return !batch.postponedUntil || batch.postponedUntil <= now;
            }
            return includePostponed && batch.status === "postponed";
        })
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

    return batches[0] || null;
}

function getSuppressedIdentities(state, now = Date.now()) {
    const identities = new Set();

    for (const batch of state.batches || []) {
        const suppress =
            batch.status === "pending" ||
            (batch.status === "postponed" && batch.postponedUntil && batch.postponedUntil > now) ||
            (batch.status === "canceled" && batch.canceledUntil && batch.canceledUntil > now);

        if (!suppress) continue;
        for (const file of batch.files || []) identities.add(fileIdentity(file));
    }

    return identities;
}

function dedupeFiles(files) {
    const seen = new Set();
    const result = [];

    for (const file of files || []) {
        const identity = fileIdentity(file);
        if (seen.has(identity)) continue;
        seen.add(identity);
        result.push(file);
    }

    return result;
}

function categoryCounts(files = []) {
    return files.reduce((counts, file) => {
        const category = file.category === "viewOnce" ? "viewOnce" : "videoDownloader";
        counts[category] = (counts[category] || 0) + 1;
        return counts;
    }, { videoDownloader: 0, viewOnce: 0 });
}

function buildApprovalText(batch) {
    const counts = categoryCounts(batch.files);
    const examples = (batch.files || []).slice(0, 3);
    const hiddenCount = Math.max(0, Number(batch.totalFiles || 0) - examples.length);
    const ageHours = Number(batch.maxAgeHours || DEFAULT_MAX_AGE_HOURS);
    const ageLabel = formatAge(ageHours * 60 * 60 * 1000);

    const exampleLines = examples.map((file, index) => (
        `${index + 1}. ${path.basename(file.name || file.path)} — ${formatBytes(file.size)}`
    ));
    if (hiddenCount > 0) exampleLines.push(`...dan ${hiddenCount} file lainnya`);

    return [
        "🧹 *Media Cleanup Reminder*",
        "",
        `Ditemukan media lama yang sudah lebih dari *${ageLabel}*.`,
        "",
        `📁 Total file: ${batch.totalFiles}`,
        `📦 Total ukuran: ${formatBytes(batch.totalSize)}`,
        `🕒 Umur minimal: ${ageHours} jam`,
        "",
        "Kategori:",
        `• Video downloader: ${counts.videoDownloader || 0} file`,
        `• View once: ${counts.viewOnce || 0} file`,
        "",
        "Contoh file:",
        ...(exampleLines.length ? exampleLines : ["-"]),
        "",
        "Pilih tindakan:",
        "1️⃣ DELETE sekarang",
        "2️⃣ TUNDA 24 jam",
        "3️⃣ BATAL",
        "",
        "Balas angka *1*, *2*, atau *3* di chat ini.",
    ].join("\n");
}

function markBatchNotified(batchId, notifiedAt = Date.now()) {
    const state = loadState();
    const batch = (state.batches || []).find(item => item.id === batchId);
    if (!batch) return;

    batch.lastNotifiedAt = notifiedAt;
    saveState(state);
}

async function sendCleanupApproval(sock, ownerJid, batch) {
    if (!sock || !ownerJid || !batch) return false;

    await sock.sendMessage(ownerJid, { text: buildApprovalText(batch) });
    markBatchNotified(batch.id);
    batch.lastNotifiedAt = Date.now();

    console.log("[MEDIA CLEANUP]", {
        stage: "approval-sent",
        ownerJid,
        batchId: batch.id,
        totalFiles: batch.totalFiles,
        totalSize: batch.totalSize,
    });

    return true;
}

async function deleteBatchFiles(batch, allowedDirs) {
    const result = {
        batchId: batch?.id,
        deletedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        freedBytes: 0,
    };

    for (const file of batch?.files || []) {
        const filePath = path.resolve(file.path || "");
        const category = file.category || "auto";

        try {
            if (!isPathInsideAllowedDirs(filePath, allowedDirs)) {
                result.skippedCount += 1;
                continue;
            }

            if (!isAllowedMediaFileForCategory(filePath, category)) {
                result.skippedCount += 1;
                continue;
            }

            let stat = null;
            try {
                stat = await fs.promises.lstat(filePath);
            } catch (error) {
                if (error?.code === "ENOENT") {
                    result.skippedCount += 1;
                    continue;
                }
                throw error;
            }

            if (!stat.isFile() || stat.isSymbolicLink()) {
                result.skippedCount += 1;
                continue;
            }

            await fs.promises.unlink(filePath);
            result.deletedCount += 1;
            result.freedBytes += stat.size;
        } catch (error) {
            result.failedCount += 1;
            logCleanupError("delete-file", error, { filePath });
        }
    }

    const state = loadState();
    const savedBatch = (state.batches || []).find(item => item.id === batch.id);
    if (savedBatch) {
        savedBatch.status = result.failedCount > 0 ? "failed" : "deleted";
        savedBatch.deletedAt = Date.now();
        savedBatch.deleteResult = result;
        saveState(state);
    }

    console.log("[MEDIA CLEANUP]", {
        stage: "delete-complete",
        batchId: batch.id,
        deletedCount: result.deletedCount,
        skippedCount: result.skippedCount,
        failedCount: result.failedCount,
        freedBytes: result.freedBytes,
    });

    return result;
}

function postponeBatch(batchId, hours) {
    const state = loadState();
    const batch = (state.batches || []).find(item => item.id === batchId);
    if (!batch) return null;

    batch.status = "postponed";
    batch.postponedUntil = Date.now() + Math.max(1, Number(hours || DEFAULT_POSTPONE_HOURS)) * 60 * 60 * 1000;
    batch.lastNotifiedAt = null;
    saveState(state);
    return batch;
}

function cancelBatch(batchId) {
    const state = loadState();
    const batch = (state.batches || []).find(item => item.id === batchId);
    if (!batch) return null;

    const hours = Number(process.env.MEDIA_CLEANUP_POSTPONE_HOURS || DEFAULT_POSTPONE_HOURS);
    batch.status = "canceled";
    batch.canceledUntil = Date.now() + Math.max(1, hours) * 60 * 60 * 1000;
    saveState(state);
    return batch;
}

function pruneOldBatches(state) {
    const activeStatuses = new Set(["pending", "postponed"]);
    const active = [];
    const inactive = [];

    for (const batch of state.batches || []) {
        if (activeStatuses.has(batch.status)) active.push(batch);
        else inactive.push(batch);
    }

    inactive.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    state.batches = [...active, ...inactive.slice(0, 50)];
}

async function scanNow(sock, options = {}) {
    if (scanInProgress) {
        return { skipped: true, reason: "scan-in-progress" };
    }

    scanInProgress = true;
    try {
        const manual = options.manual === true;
        const state = loadState();
        const now = Date.now();
        const maxAgeHours = Number(options.maxAgeHours || process.env.MEDIA_CLEANUP_MAX_AGE_HOURS || DEFAULT_MAX_AGE_HOURS);

        refreshBatchStatuses(state, now);

        if (!manual && state.enabled === false) {
            saveState(state);
            return { skipped: true, reason: "disabled" };
        }

        const allowedEntries = getAllowedDirEntries(options);
        const allowedDirs = allowedEntries.map(entry => entry.path);
        const rawFiles = [];

        for (const entry of allowedEntries) {
            const files = await scanDirectoryRecursive(entry.path, {
                allowedDirs,
                category: entry.category,
                maxAgeHours,
                now,
            });
            rawFiles.push(...files);
        }

        const suppressed = getSuppressedIdentities(state, now);
        const files = dedupeFiles(rawFiles).filter(file => !suppressed.has(fileIdentity(file)));
        const totalSize = files.reduce((sum, file) => sum + Number(file.size || 0), 0);

        state.lastScanAt = now;

        console.log("[MEDIA CLEANUP]", {
            stage: "scan-complete",
            filesFound: files.length,
            totalSize,
            allowedDirs,
        });

        let batchToNotify = null;
        if (files.length > 0) {
            batchToNotify = createCleanupBatch(files, { maxAgeHours });
            state.batches.push(batchToNotify);
        } else {
            const pending = (state.batches || [])
                .filter(batch => batch.status === "pending")
                .filter(batch => !batch.postponedUntil || batch.postponedUntil <= now)
                .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0];

            if (pending && (manual || !pending.lastNotifiedAt)) batchToNotify = pending;
        }

        pruneOldBatches(state);
        saveState(state);

        const ownerJid = getPrimaryOwnerJid(options);
        const shouldNotify = Boolean(sock && ownerJid && batchToNotify && options.notify !== false);
        if (shouldNotify) {
            try {
                await sendCleanupApproval(sock, ownerJid, batchToNotify);
            } catch (error) {
                logCleanupError("send-approval", error, { ownerJid, batchId: batchToNotify.id });
            }
        }

        return {
            filesFound: files.length,
            totalSize,
            allowedDirs,
            batch: batchToNotify,
        };
    } catch (error) {
        logCleanupError("scan-now", error);
        throw error;
    } finally {
        scanInProgress = false;
    }
}

function getDeleteSummaryText(result) {
    return [
        "✅ *Media Cleanup selesai*",
        "",
        `🗑️ Terhapus: ${result.deletedCount} file`,
        `⏭️ Dilewati: ${result.skippedCount} file`,
        `📦 Storage dibersihkan: ${formatBytes(result.freedBytes)}`,
        result.failedCount > 0 ? "" : null,
        result.failedCount > 0 ? "⚠️ Gagal hapus beberapa file.\nCek log terminal untuk detail." : null,
    ].filter(line => line !== null).join("\n");
}

function getStatusText(options = {}) {
    const state = loadState();
    if (refreshBatchStatuses(state)) saveState(state);

    const pendingBatches = (state.batches || []).filter(batch => ["pending", "postponed"].includes(batch.status));
    const totalFiles = pendingBatches.reduce((sum, batch) => sum + Number(batch.totalFiles || batch.files?.length || 0), 0);
    const totalSize = pendingBatches.reduce((sum, batch) => sum + Number(batch.totalSize || 0), 0);
    const thresholdHours = Number(options.maxAgeHours || process.env.MEDIA_CLEANUP_MAX_AGE_HOURS || DEFAULT_MAX_AGE_HOURS);

    return [
        "📦 *Media Cleanup Status*",
        "",
        `Status auto scan: ${state.enabled ? "aktif" : "mati"}`,
        `Threshold: ${thresholdHours} jam`,
        `Pending batch: ${pendingBatches.length}`,
        `Total file pending: ${totalFiles}`,
        `Total ukuran pending: ${formatBytes(totalSize)}`,
    ].join("\n");
}

function getHelpText() {
    return [
        "📦 *Media Cleanup / Storage Cleaner*",
        "",
        "Owner commands:",
        "• *.cleanmedia scan* — cek media lama sekarang",
        "• *.cleanmedia status* — lihat status cleanup",
        "• *.cleanmedia delete* — hapus batch pending terbaru",
        "• *.cleanmedia tunda* — tunda cleanup 24 jam",
        "• *.cleanmedia batal* — batalkan batch pending terbaru",
        "• *.cleanmedia on* — aktifkan auto scan",
        "• *.cleanmedia off* — matikan auto scan",
        "",
        "Saat ada reminder, balas angka *1*, *2*, atau *3* di PM owner.",
    ].join("\n");
}

async function handleBatchAction(sock, replyJid, action, batch, options = {}) {
    if (!batch) {
        await sock.sendMessage(replyJid, { text: "Tidak ada batch media cleanup yang pending." });
        return true;
    }

    if (action === "1" || action === "delete") {
        const allowedDirs = getAllowedDirs(options);
        const result = await deleteBatchFiles(batch, allowedDirs);
        await sock.sendMessage(replyJid, { text: getDeleteSummaryText(result) });
        return true;
    }

    if (action === "2" || action === "tunda") {
        const hours = Number(options.postponeHours || process.env.MEDIA_CLEANUP_POSTPONE_HOURS || DEFAULT_POSTPONE_HOURS);
        postponeBatch(batch.id, hours);
        await sock.sendMessage(replyJid, { text: `⏳ Media cleanup ditunda ${hours} jam.` });
        return true;
    }

    if (action === "3" || action === "batal") {
        cancelBatch(batch.id);
        await sock.sendMessage(replyJid, { text: "❌ Media cleanup dibatalkan. File tidak dihapus." });
        return true;
    }

    return false;
}

async function handleCleanupCommand(sock, msg, text, options = {}) {
    const rawText = String(text || "").trim();
    if (!rawText) return false;

    const from = msg?.key?.remoteJid;
    if (!from) return false;

    const lowerText = rawText.toLowerCase();
    const isCommand = lowerText === ".cleanmedia" || lowerText.startsWith(".cleanmedia ");
    const isNumericAction = /^[123]$/.test(rawText);

    if (!isCommand && !isNumericAction) return false;

    const ownerJids = collectOwnerJids(options);
    const ownerJid = getPrimaryOwnerJid(options, msg);
    const ownerMessage = isOwnerMessage(msg, ownerJids);
    const isGroup = String(from).endsWith("@g.us");

    if (isNumericAction) {
        const pendingBatch = getLatestPendingBatch();
        if (!pendingBatch || isGroup) return false;

        if (!ownerMessage) {
            await sock.sendMessage(from, { text: "Akses Ditolak" });
            return true;
        }

        return handleBatchAction(sock, from, rawText, pendingBatch, options);
    }

    if (!ownerMessage) {
        await sock.sendMessage(from, { text: "Akses Ditolak" });
        return true;
    }

    const subCommand = lowerText.replace(".cleanmedia", "").trim() || "help";

    if (subCommand === "help") {
        await sock.sendMessage(from, { text: getHelpText() });
        return true;
    }

    if (subCommand === "status") {
        await sock.sendMessage(from, { text: getStatusText(options) });
        return true;
    }

    if (subCommand === "scan") {
        const result = await scanNow(sock, {
            ...options,
            ownerJid,
            manual: true,
            notify: true,
        });

        if (!result.batch) {
            await sock.sendMessage(from, { text: "✅ Tidak ada media lama yang perlu dibersihkan." });
        } else if (from !== ownerJid) {
            await sock.sendMessage(from, { text: "✅ Panel approval media cleanup sudah dikirim ke PM owner." });
        }
        return true;
    }

    if (subCommand === "delete") {
        return handleBatchAction(sock, from, "delete", getLatestPendingBatch(true), options);
    }

    if (subCommand === "tunda") {
        return handleBatchAction(sock, from, "tunda", getLatestPendingBatch(true), options);
    }

    if (subCommand === "batal") {
        return handleBatchAction(sock, from, "batal", getLatestPendingBatch(true), options);
    }

    if (subCommand === "on") {
        const state = loadState();
        state.enabled = true;
        saveState(state);
        await sock.sendMessage(from, { text: "✅ Auto scan media cleanup diaktifkan." });
        return true;
    }

    if (subCommand === "off") {
        const state = loadState();
        state.enabled = false;
        saveState(state);
        await sock.sendMessage(from, { text: "✅ Auto scan media cleanup dimatikan." });
        return true;
    }

    await sock.sendMessage(from, { text: getHelpText() });
    return true;
}

function dispose() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
    activeSock = null;
    activeOptions = {};
}

async function init(sock, options = {}) {
    try {
        activeSock = sock;
        activeOptions = { ...options };

        if (cleanupInterval) {
            clearInterval(cleanupInterval);
            cleanupInterval = null;
        }

        const state = loadState();
        if (String(process.env.MEDIA_CLEANUP_ENABLED || "").trim().toLowerCase() === "false") {
            state.enabled = false;
            saveState(state);
        }

        const scanIntervalMs = Number(options.scanIntervalMs || process.env.MEDIA_CLEANUP_SCAN_INTERVAL_MS || DEFAULT_SCAN_INTERVAL_MS);
        cleanupInterval = setInterval(() => {
            scanNow(activeSock, {
                ...activeOptions,
                manual: false,
                notify: true,
            }).catch(error => logCleanupError("auto-scan", error));
        }, Math.max(60 * 1000, scanIntervalMs));

        if (typeof cleanupInterval.unref === "function") cleanupInterval.unref();

        if (state.enabled) {
            scanNow(sock, {
                ...options,
                manual: false,
                notify: true,
            }).catch(error => logCleanupError("initial-scan", error));
        }
    } catch (error) {
        logCleanupError("init", error);
    }

    return { dispose };
}

module.exports = {
    init,
    handleCleanupCommand,
    scanNow,
    dispose,
};
