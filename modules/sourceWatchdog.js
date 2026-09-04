"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const DEFAULT_ENTRIES = ["index.js", ".env", "modules"]

function isEnabled(value, fallback = false) {
    const clean = String(value ?? "").trim()
    if (!clean) return fallback
    return /^(1|true|yes|on)$/i.test(clean)
}

function boundedSeconds(value, fallback, minimum = 0.25, maximum = 60) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(maximum, Math.max(minimum, parsed))
}

function normalizeRelativePath(rootDir, absolutePath) {
    return path.relative(rootDir, absolutePath).split(path.sep).join("/")
}

function addFileToSnapshot(snapshot, rootDir, absolutePath) {
    try {
        const stat = fs.lstatSync(absolutePath)
        if (!stat.isFile() || stat.isSymbolicLink()) return
        snapshot.set(normalizeRelativePath(rootDir, absolutePath), `${stat.size}:${stat.mtimeMs}`)
    } catch (error) {
        if (error?.code !== "ENOENT") throw error
    }
}

function walkDirectory(snapshot, rootDir, directoryPath) {
    let entries
    try {
        entries = fs.readdirSync(directoryPath, { withFileTypes: true })
    } catch (error) {
        if (error?.code === "ENOENT") return
        throw error
    }

    for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const absolutePath = path.join(directoryPath, entry.name)
        if (entry.isDirectory()) {
            walkDirectory(snapshot, rootDir, absolutePath)
        } else if (entry.isFile()) {
            addFileToSnapshot(snapshot, rootDir, absolutePath)
        }
    }
}

function snapshotSourceTree(rootDir, watchedEntries = DEFAULT_ENTRIES) {
    const resolvedRoot = path.resolve(rootDir)
    const snapshot = new Map()

    for (const entry of watchedEntries) {
        const absolutePath = path.resolve(resolvedRoot, entry)
        const relativePath = path.relative(resolvedRoot, absolutePath)
        if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) continue

        try {
            const stat = fs.lstatSync(absolutePath)
            if (stat.isSymbolicLink()) continue
            if (stat.isDirectory()) walkDirectory(snapshot, resolvedRoot, absolutePath)
            else if (stat.isFile()) addFileToSnapshot(snapshot, resolvedRoot, absolutePath)
        } catch (error) {
            if (error?.code !== "ENOENT") throw error
        }
    }

    return snapshot
}

function diffSnapshots(previous, current) {
    const changed = new Set()
    for (const [filePath, signature] of current) {
        if (previous.get(filePath) !== signature) changed.add(filePath)
    }
    for (const filePath of previous.keys()) {
        if (!current.has(filePath)) changed.add(filePath)
    }
    return [...changed].sort()
}

function validateJavaScriptChanges(rootDir, changedPaths) {
    const resolvedRoot = path.resolve(rootDir)
    for (const relativePath of changedPaths) {
        if (!/\.(?:c?js)$/i.test(relativePath)) continue
        const absolutePath = path.resolve(resolvedRoot, relativePath)
        const resolvedRelative = path.relative(resolvedRoot, absolutePath)
        if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
            throw new Error(`Path source keluar dari project: ${relativePath}`)
        }
        if (!fs.existsSync(absolutePath)) continue
        new vm.Script(fs.readFileSync(absolutePath, "utf8"), { filename: relativePath })
    }
}

function startSourceWatchdog(options = {}) {
    const env = options.env || process.env
    const enabled = options.enabled ?? isEnabled(env.INTERNAL_SOURCE_WATCH_ENABLED, false)
    if (!enabled) return { enabled: false, stop() {} }

    const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."))
    const watchedEntries = options.watchedEntries || DEFAULT_ENTRIES
    const intervalMs = options.intervalMs ?? boundedSeconds(env.INTERNAL_SOURCE_WATCH_INTERVAL, 2) * 1000
    const debounceMs = options.debounceMs ?? boundedSeconds(env.INTERNAL_SOURCE_WATCH_DEBOUNCE, 2) * 1000
    const logger = options.logger || console
    const onChange = typeof options.onChange === "function"
        ? options.onChange
        : () => process.kill(process.pid, "SIGINT")

    let stopped = false
    let snapshot = snapshotSourceTree(rootDir, watchedEntries)
    let pendingPaths = new Set()
    let lastChangeAt = 0
    let timer = null

    function stop() {
        if (stopped) return
        stopped = true
        if (timer) clearInterval(timer)
        timer = null
    }

    function poll() {
        if (stopped) return

        let nextSnapshot
        try {
            nextSnapshot = snapshotSourceTree(rootDir, watchedEntries)
        } catch (error) {
            logger.log(`[SOURCE WATCH] Gagal scan source: ${error.message}`)
            return
        }

        const changedPaths = diffSnapshots(snapshot, nextSnapshot)
        snapshot = nextSnapshot
        if (changedPaths.length) {
            for (const changedPath of changedPaths) pendingPaths.add(changedPath)
            lastChangeAt = Date.now()
            return
        }

        if (!pendingPaths.size || Date.now() - lastChangeAt < debounceMs) return
        const stableChanges = [...pendingPaths].sort()
        pendingPaths = new Set()

        try {
            validateJavaScriptChanges(rootDir, stableChanges)
        } catch (error) {
            logger.log(`[SOURCE WATCH] Syntax source belum valid; proses lama tetap berjalan: ${error.message}`)
            return
        }

        stop()
        Promise.resolve(onChange({ paths: stableChanges, rootDir })).catch(error => {
            logger.log(`[SOURCE WATCH] Gagal meminta restart: ${error.message}`)
        })
    }

    timer = setInterval(poll, Math.max(25, Number(intervalMs) || 2000))
    timer.unref?.()
    logger.log(`[SOURCE WATCH] Polling internal aktif (${intervalMs}ms, debounce ${debounceMs}ms).`)

    return { enabled: true, stop, poll }
}

module.exports = {
    DEFAULT_ENTRIES,
    diffSnapshots,
    snapshotSourceTree,
    startSourceWatchdog,
    validateJavaScriptChanges,
}
