"use strict"

const fs = require("fs")
const path = require("path")

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value))
}

function isObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function createAtomicJsonStore(options = {}) {
    const envPath = options.envName ? process.env[options.envName] : ""
    const filePath = path.resolve(envPath || options.filePath)
    const label = String(options.label || path.basename(filePath)).slice(0, 80)
    const makeDefault = typeof options.defaultState === "function"
        ? options.defaultState
        : () => clone(options.defaultState || {})
    let cache = null

    function normalize(value) {
        const source = isObject(value) ? value : {}
        const defaults = isObject(makeDefault()) ? makeDefault() : {}
        return { ...defaults, ...source }
    }

    function load(loadOptions = {}) {
        if (cache && loadOptions.force !== true) return cache
        try {
            cache = normalize(JSON.parse(fs.readFileSync(filePath, "utf8")))
        } catch (error) {
            if (error?.code !== "ENOENT") {
                console.log(`[${label}] State gagal dibaca; memakai default aman: ${String(error?.message || error).slice(0, 180)}`)
            }
            cache = normalize(makeDefault())
        }
        return cache
    }

    function save(nextState = cache || makeDefault()) {
        const normalized = normalize(nextState)
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        const tempFile = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
        let descriptor = null
        try {
            descriptor = fs.openSync(tempFile, "w", 0o600)
            fs.writeFileSync(descriptor, `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
            fs.fsyncSync(descriptor)
            fs.closeSync(descriptor)
            descriptor = null
            fs.renameSync(tempFile, filePath)
        } catch (error) {
            try { if (descriptor !== null) fs.closeSync(descriptor) } catch {}
            try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile) } catch {}
            throw error
        }
        cache = normalized
        return clone(normalized)
    }

    function update(mutator) {
        if (typeof mutator !== "function") return clone(load())
        const current = clone(load())
        const result = mutator(current)
        return save(isObject(result) ? result : current)
    }

    function snapshot() {
        return clone(load())
    }

    function reload() {
        cache = null
        return snapshot()
    }

    function resetCache() {
        cache = null
    }

    return {
        filePath,
        load,
        reload,
        resetCache,
        save,
        snapshot,
        update,
    }
}

module.exports = {
    clone,
    createAtomicJsonStore,
    isObject,
}
