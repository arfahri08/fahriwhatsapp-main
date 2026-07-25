"use strict"

const fs = require("fs")
const path = require("path")
const DEFAULT_SAFE_WORDS = require("./antiToxicSafeWordCorpus")

const MATCHER_VERSION = "v2"
const SAFE_WORDS_FILE = path.join(__dirname, "..", "data", "antiToxicSafeWords.json")
const ALLOWED_CLITICS = ["nya", "lah", "kah", "mu", "ku"]
const LEET_CHOICES = new Map(Object.entries({
    "0": ["o"],
    "1": ["i", "l"],
    "3": ["e"],
    "4": ["a"],
    "5": ["s"],
    "6": ["g"],
    "7": ["t"],
    "8": ["b"],
    "9": ["g"],
    "@": ["a"],
    "$": ["s"],
    "!": ["i"],
    "|": ["i", "l"],
}))

let safeWordState = null
let safeWordSet = new Set()
let lastRegression = {
    status: "NOT RUN",
    tested: 0,
    safe: 0,
    falsePositive: 0,
    failed: [],
    testedAt: null,
}
let legacyCollisions = []

function normalizeToken(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim()
}

function normalizeSafeWord(value) {
    const normalized = normalizeToken(value).replace(/_/g, " ").replace(/\s+/g, " ").trim()
    if (!normalized || normalized.includes(" ")) return ""
    if (!/^[\p{L}\p{N}]+$/u.test(normalized)) return ""
    return normalized
}

function normalizeToxicEntry(value) {
    return normalizeToken(value)
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
}

function uniqueSafeWords(words) {
    return [...new Set((Array.isArray(words) ? words : [])
        .map(normalizeSafeWord)
        .filter(Boolean))]
}

function cloneDefaultSafeState() {
    return {
        version: 1,
        words: uniqueSafeWords(DEFAULT_SAFE_WORDS),
        updatedAt: 0,
    }
}

function normalizeSafeState(value) {
    return {
        version: 1,
        words: uniqueSafeWords(value?.words),
        updatedAt: Math.max(0, Number(value?.updatedAt || 0) || 0),
    }
}

function writeSafeStateAtomic(state, filePath = SAFE_WORDS_FILE) {
    const normalized = normalizeSafeState(state)
    const directory = path.dirname(filePath)
    const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
    fs.mkdirSync(directory, { recursive: true })
    try {
        const serialized = `${JSON.stringify(normalized, null, 2)}\n`
        JSON.parse(serialized)
        fs.writeFileSync(temporary, serialized, "utf8")
        fs.renameSync(temporary, filePath)
    } finally {
        try {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
        } catch {}
    }
    return normalized
}

function loadSafeWordState(options = {}) {
    if (safeWordState && !options.force) return safeWordState
    const filePath = path.resolve(options.filePath || SAFE_WORDS_FILE)
    try {
        if (!fs.existsSync(filePath)) {
            safeWordState = writeSafeStateAtomic(cloneDefaultSafeState(), filePath)
        } else {
            safeWordState = normalizeSafeState(JSON.parse(fs.readFileSync(filePath, "utf8")))
        }
    } catch (error) {
        try {
            if (fs.existsSync(filePath)) {
                fs.renameSync(filePath, path.join(
                    path.dirname(filePath),
                    `antiToxicSafeWords.corrupt.${Date.now()}.json`
                ))
            }
        } catch {}
        try {
            safeWordState = writeSafeStateAtomic(cloneDefaultSafeState(), filePath)
        } catch {
            safeWordState = cloneDefaultSafeState()
        }
    }
    safeWordSet = new Set(safeWordState.words)
    return safeWordState
}

function saveSafeWordState(state, options = {}) {
    safeWordState = writeSafeStateAtomic(state, path.resolve(options.filePath || SAFE_WORDS_FILE))
    safeWordSet = new Set(safeWordState.words)
    return safeWordState
}

function tokenizeForAntiToxic(text) {
    const normalized = normalizeToken(text)
    const matches = normalized.match(/[\p{L}\p{N}@#$!|]+/gu) || []
    return matches.map((raw, index) => ({
        raw,
        normalized: raw,
        index,
    }))
}

function compactCandidate(value) {
    return normalizeToken(value).replace(/[^\p{L}\p{N}]+/gu, "")
}

function normalizeCandidate(value) {
    const compact = compactCandidate(value)
    if (compact.length <= 3) return compact
    return compact.replace(/([\p{L}\p{N}])\1+/gu, "$1")
}

function buildCanonicalCandidates(value, options = {}) {
    const maxCandidates = Math.max(1, Number(options.maxCandidates || 12))
    const raw = normalizeToken(value)
    let candidates = [""]
    for (const char of raw) {
        const choices = LEET_CHOICES.get(char)
            || (/^[\p{L}\p{N}]$/u.test(char) ? [char] : [])
        if (!choices.length) continue
        const next = []
        for (const prefix of candidates) {
            for (const choice of choices) {
                next.push(`${prefix}${choice}`)
                if (next.length >= maxCandidates) break
            }
            if (next.length >= maxCandidates) break
        }
        candidates = next.length ? next : candidates
    }
    const output = []
    for (const candidate of [raw, ...candidates]) {
        const compact = compactCandidate(candidate)
        const collapsed = normalizeCandidate(candidate)
        if (compact && !output.includes(compact)) output.push(compact)
        if (collapsed && !output.includes(collapsed)) output.push(collapsed)
        if (output.length >= maxCandidates) break
    }
    return output.slice(0, maxCandidates)
}

function stripAllowedClitic(token) {
    const normalized = compactCandidate(token)
    for (const suffix of ALLOWED_CLITICS) {
        if (normalized.length > suffix.length + 2 && normalized.endsWith(suffix)) {
            return {
                stem: normalized.slice(0, -suffix.length),
                clitic: suffix,
            }
        }
    }
    return { stem: normalized, clitic: "" }
}

function levenshteinDistance(left, right) {
    const a = String(left || "")
    const b = String(right || "")
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
    const current = new Array(b.length + 1)
    for (let i = 1; i <= a.length; i += 1) {
        current[0] = i
        for (let j = 1; j <= b.length; j += 1) {
            current[j] = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            )
        }
        for (let j = 0; j <= b.length; j += 1) previous[j] = current[j]
    }
    return previous[b.length]
}

function calculateSimilarity(left, right) {
    const a = String(left || "")
    const b = String(right || "")
    const denominator = Math.max(a.length, b.length, 1)
    return 1 - (levenshteinDistance(a, b) / denominator)
}

function getDynamicFuzzyPolicy(toxicWord) {
    const length = normalizeCandidate(toxicWord).length
    if (length <= 4) {
        return {
            enabled: false,
            maxDistance: 0,
            requireSameLength: true,
            maxLengthDifference: 0,
            minimumSimilarity: 1,
            requireSameEdges: true,
        }
    }
    if (length <= 6) {
        return {
            enabled: true,
            maxDistance: 1,
            requireSameLength: true,
            maxLengthDifference: 0,
            minimumSimilarity: 0.90,
            requireSameEdges: true,
        }
    }
    return {
        enabled: true,
        maxDistance: 1,
        requireSameLength: false,
        maxLengthDifference: 1,
        minimumSimilarity: 0.90,
        requireSameEdges: false,
    }
}

function getSafeSet(options = {}) {
    if (options.safeWords instanceof Set) return options.safeWords
    if (Array.isArray(options.safeWords)) return new Set(uniqueSafeWords(options.safeWords))
    loadSafeWordState()
    return safeWordSet
}

function isExactSafeWord(token, options = {}) {
    return getSafeSet(options).has(normalizeSafeWord(token))
}

function buildToxicEntries(options = {}) {
    const safeSet = getSafeSet(options)
    const entries = []
    const seen = new Set()
    for (const word of Array.isArray(options.toxicWords) ? options.toxicWords : []) {
        const normalized = normalizeToxicEntry(word)
        if (!normalized) continue
        const key = `${normalized}|${normalized}`
        if (seen.has(key)) continue
        seen.add(key)
        entries.push({ word: normalized, input: normalized, alias: null })
    }
    for (const group of Array.isArray(options.aliasGroups) ? options.aliasGroups : []) {
        const canonical = normalizeToxicEntry(group?.word)
        if (!canonical) continue
        for (const alias of Array.isArray(group?.aliases) ? group.aliases : []) {
            const normalized = normalizeToxicEntry(alias)
            if (!normalized) continue
            const key = `${canonical}|${normalized}`
            if (seen.has(key)) continue
            seen.add(key)
            entries.push({ word: canonical, input: normalized, alias: normalized })
        }
    }
    // Corpus regression dapat mendeklasifikasi overlap legacy tanpa menghapus
    // entry dari kataKasar.json. Command add tetap menolak toxic exact baru.
    return entries.filter(entry => !safeSet.has(entry.input))
}

function isExactToxicWord(token, options = {}) {
    const normalized = normalizeCandidate(token)
    return buildToxicEntries(options).find(entry => entry.input === normalized) || null
}

function findStrictFuzzyMatch(candidate, entries, options = {}) {
    const safeSet = getSafeSet(options)
    if (safeSet.has(candidate)) return null
    for (const entry of entries) {
        const target = entry.input
        const policy = getDynamicFuzzyPolicy(target)
        if (!policy.enabled) continue
        if (policy.requireSameLength && candidate.length !== target.length) continue
        if (Math.abs(candidate.length - target.length) > policy.maxLengthDifference) continue
        if (policy.requireSameEdges && (
            candidate[0] !== target[0]
            || candidate[candidate.length - 1] !== target[target.length - 1]
        )) continue
        const distance = levenshteinDistance(candidate, target)
        if (distance > policy.maxDistance) continue
        const similarity = calculateSimilarity(candidate, target)
        if (similarity < policy.minimumSimilarity) continue
        return { entry, distance, similarity, policy }
    }
    return null
}

function makeMatch(entry, details = {}) {
    return {
        word: entry.word,
        matchedInput: details.matchedInput || entry.input,
        matchedNormalizedInput: details.normalizedInput || entry.input,
        matchedAlias: entry.alias,
        matchedTokens: [entry.input],
        detectionVariant: details.detectionVariant || (entry.alias ? "alias" : "exact"),
        distance: details.distance ?? 0,
        similarity: details.similarity ?? 1,
        tokenIndex: details.tokenIndex,
        safeTokenSkipped: false,
    }
}

function inspectToken(token, options = {}) {
    const safeSet = getSafeSet(options)
    const entries = buildToxicEntries(options).filter(entry => !entry.input.includes(" "))
    const candidates = buildCanonicalCandidates(token.normalized, options)

    for (const candidate of candidates) {
        const exact = entries.find(entry => entry.input === candidate)
        if (exact) {
            return {
                match: makeMatch(exact, {
                    matchedInput: token.raw,
                    normalizedInput: candidate,
                    tokenIndex: token.index,
                    detectionVariant: exact.alias ? "alias" : candidate === token.normalized ? "exact" : "canonical",
                }),
                exactToxic: true,
                exactSafe: false,
                fuzzySkipped: "",
                candidates,
            }
        }
    }

    const exactSafe = safeSet.has(normalizeSafeWord(token.normalized))
    if (exactSafe) {
        return {
            match: null,
            exactToxic: false,
            exactSafe: true,
            fuzzySkipped: "SAFE TOKEN",
            candidates,
        }
    }

    for (const candidate of candidates) {
        const stripped = stripAllowedClitic(candidate)
        if (!stripped.clitic) continue
        const exactStem = entries.find(entry => entry.input === stripped.stem)
        if (exactStem) {
            return {
                match: makeMatch(exactStem, {
                    matchedInput: token.raw,
                    normalizedInput: stripped.stem,
                    tokenIndex: token.index,
                    detectionVariant: "clitic",
                }),
                exactToxic: false,
                exactSafe: false,
                fuzzySkipped: "",
                candidates,
            }
        }
    }

    if (options.variantMatchEnabled !== false) {
        for (const candidate of candidates) {
            const fuzzy = findStrictFuzzyMatch(candidate, entries, options)
            if (!fuzzy) continue
            return {
                match: makeMatch(fuzzy.entry, {
                    matchedInput: token.raw,
                    normalizedInput: candidate,
                    tokenIndex: token.index,
                    detectionVariant: "strict-fuzzy",
                    distance: fuzzy.distance,
                    similarity: fuzzy.similarity,
                }),
                exactToxic: false,
                exactSafe: false,
                fuzzySkipped: "",
                candidates,
            }
        }
    }

    return {
        match: null,
        exactToxic: false,
        exactSafe: false,
        fuzzySkipped: options.variantMatchEnabled === false ? "DISABLED" : "NO STRICT MATCH",
        candidates,
    }
}

function getFragmentedCandidates(tokens, options = {}) {
    const maxParts = Math.max(2, Number(options.maxFragmentedParts || 8))
    const output = []
    for (let start = 0; start < tokens.length; start += 1) {
        let combined = ""
        for (let offset = 0; offset < maxParts && start + offset < tokens.length; offset += 1) {
            const token = tokens[start + offset]
            if (!token.normalized || token.normalized.length > 2) break
            combined += token.normalized
            if (offset < 1) continue
            output.push({
                raw: tokens.slice(start, start + offset + 1).map(item => item.raw).join(" "),
                normalized: combined,
                index: start,
                fragmented: true,
            })
        }
    }
    return output.sort((left, right) => right.normalized.length - left.normalized.length)
}

function findToxicMatch(text, options = {}) {
    const tokens = tokenizeForAntiToxic(text)
    if (!text || !tokens.length) return { word: null, tokens: [] }

    const tokenValues = tokens.map(item => normalizeCandidate(item.normalized))
    const phraseEntries = buildToxicEntries(options).filter(entry => entry.input.includes(" "))
    for (const entry of phraseEntries) {
        const phraseTokens = entry.input.split(" ").map(normalizeCandidate).filter(Boolean)
        for (let index = 0; index + phraseTokens.length <= tokenValues.length; index += 1) {
            if (!phraseTokens.every((value, offset) => tokenValues[index + offset] === value)) continue
            return {
                ...makeMatch(entry, {
                    matchedInput: tokens.slice(index, index + phraseTokens.length).map(item => item.raw).join(" "),
                    normalizedInput: entry.input,
                    tokenIndex: index,
                    detectionVariant: entry.alias ? "alias" : "exact-phrase",
                }),
                matchedTokens: phraseTokens,
                tokens: tokens.map(item => item.raw),
            }
        }
    }

    for (const token of tokens) {
        const result = inspectToken(token, options)
        if (result.match) return { ...result.match, tokens: tokens.map(item => item.raw) }
    }

    for (const token of getFragmentedCandidates(tokens, options)) {
        const result = inspectToken(token, { ...options, variantMatchEnabled: false })
        if (result.match) {
            return {
                ...result.match,
                detectionVariant: "fragmented",
                tokens: tokens.map(item => item.raw),
            }
        }
    }

    return { word: null, tokens: tokens.map(item => item.raw), matchedTokens: [] }
}

function scanTextForToxicWords(text, options = {}) {
    return findToxicMatch(text, options)
}

function inspectText(text, options = {}) {
    const tokens = tokenizeForAntiToxic(text)
    const inspections = tokens.map(token => ({ token: token.raw, ...inspectToken(token, options) }))
    const match = findToxicMatch(text, options)
    return { text: String(text || ""), tokens: inspections, match }
}

function testSafeWordCorpus(options = {}) {
    const words = Array.isArray(options.corpus) ? uniqueSafeWords(options.corpus) : [...getSafeSet(options)]
    const failed = []
    for (const word of words) {
        const match = findToxicMatch(word, options)
        if (match.word) failed.push({ safeWord: word, matchedWord: match.word, matchType: match.detectionVariant })
    }
    lastRegression = {
        status: failed.length ? "FAIL" : "PASS",
        tested: words.length,
        safe: words.length - failed.length,
        falsePositive: failed.length,
        failed,
        testedAt: Date.now(),
    }
    return { ...lastRegression }
}

function analyzeLegacyCollisions(options = {}) {
    const safeWords = Array.isArray(options.corpus) ? uniqueSafeWords(options.corpus) : [...getSafeSet(options)]
    const toxicWords = [...new Set((Array.isArray(options.toxicWords) ? options.toxicWords : []).map(normalizeSafeWord).filter(Boolean))]
    const legacyFuzzyWords = new Set((Array.isArray(options.legacyFuzzyWords) ? options.legacyFuzzyWords : []).map(normalizeSafeWord))
    const collisions = []
    for (const safe of safeWords) {
        for (const toxic of toxicWords) {
            if (safe === toxic) {
                collisions.push({ safeToken: safe, toxicCandidate: toxic, distance: 0, similarity: 1, type: "legacy-exact-overlap" })
                continue
            }
            if (!legacyFuzzyWords.has(toxic)) continue
            if (safe[0] !== toxic[0] || toxic.length < 5 || safe.length < 4) continue
            if (Math.abs(safe.length - toxic.length) > 1) continue
            const distance = levenshteinDistance(safe, toxic)
            if (distance > 1) continue
            collisions.push({
                safeToken: safe,
                toxicCandidate: toxic,
                distance,
                similarity: calculateSimilarity(safe, toxic),
                type: "legacy-fuzzy",
            })
        }
    }
    legacyCollisions = collisions
    return collisions
}

function initializeMatcher(options = {}) {
    loadSafeWordState({ force: Boolean(options.force) })
    const regression = testSafeWordCorpus({ ...options, safeWords: safeWordSet, corpus: [...safeWordSet] })
    analyzeLegacyCollisions({ ...options, corpus: [...safeWordSet] })
    return regression
}

function getMatcherHealth(options = {}) {
    const state = loadSafeWordState()
    const toxicWords = Array.isArray(options.toxicWords) ? options.toxicWords : []
    const overlaps = state.words.filter(word => toxicWords.map(normalizeSafeWord).includes(word))
    return {
        mode: "STRICT",
        version: MATCHER_VERSION,
        safeWords: state.words.length,
        toxicWords: toxicWords.length,
        store: "READY",
        shortWordFuzzy: "OFF",
        minimumSimilarity: 0.90,
        tokenScopedSafeCheck: true,
        regression: { ...lastRegression },
        legacyCollisions: [...legacyCollisions],
        legacyOverlaps: overlaps,
        updatedAt: state.updatedAt,
    }
}

function maskCollisionLines(collisions) {
    if (!collisions.length) return ["Tidak ada collision legacy yang tercatat."]
    return collisions.slice(0, 30).map((item, index) => (
        `${index + 1}. ${item.safeToken} → ${item.toxicCandidate} | distance=${item.distance} | similarity=${item.similarity.toFixed(3)} | ${item.type}`
    ))
}

async function handleAntiToxicSafeMatcherCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    if (!/^\.(kasarsafe|antitoxicsafe|safeword)(?:\s|$)/i.test(text)) return false
    if (context.isGroup || String(context.from || msg?.key?.remoteJid || "").endsWith("@g.us")) return true
    const from = context.from || msg?.key?.remoteJid
    if (!context.isOwner) {
        await sock.sendMessage(from, { text: "Akses Ditolak" })
        return true
    }

    const options = typeof context.getMatcherOptions === "function" ? context.getMatcherOptions() : (context.matcherOptions || {})
    const parts = text.split(/\s+/)
    const action = String(parts[1] || "status").toLowerCase()
    const argument = text.replace(/^\.(kasarsafe|antitoxicsafe|safeword)\s*/i, "").replace(/^\S+\s*/i, "").trim().replace(/^(["'])(.*)\1$/, "$2")
    const state = loadSafeWordState()

    if (action === "status") {
        const health = getMatcherHealth(options)
        await sock.sendMessage(from, { text: [
            "🛡️ *ANTI KASAR SAFE MATCHER*",
            "",
            `Safe Words: ${health.safeWords}`,
            `Toxic Words: ${health.toxicWords}`,
            `Fuzzy Matching: ${health.mode}`,
            `Short Word Fuzzy: ${health.shortWordFuzzy}`,
            `Minimum Similarity: ${health.minimumSimilarity.toFixed(2)}`,
            `Token-Scoped Safe Check: ${health.tokenScopedSafeCheck ? "ON" : "OFF"}`,
            `Matcher Version: ${health.version}`,
            "",
            "Last Corpus Test:",
            `Safe: ${health.regression.safe}`,
            `False Positive: ${health.regression.falsePositive}`,
            `Failed: ${health.regression.failed.length}`,
        ].join("\n") })
        return true
    }

    if (action === "list") {
        const lines = state.words.map((word, index) => `${index + 1}. ${word}`)
        await sock.sendMessage(from, { text: `🛡️ *SAFE WORDS (${state.words.length})*\n\n${lines.join("\n")}` })
        return true
    }

    if (action === "test") {
        if (!argument) {
            await sock.sendMessage(from, { text: "Format: .kasarsafe test <teks>" })
            return true
        }
        const inspected = inspectText(argument, options)
        const first = inspected.tokens[0] || {}
        await sock.sendMessage(from, { text: [
            "🧪 *ANTI KASAR MATCH TEST*",
            "",
            `Input: ${argument.slice(0, 500)}`,
            `Token: ${first.token || "-"}`,
            `Exact Toxic: ${first.exactToxic ? "YES" : "NO"}`,
            `Exact Safe: ${first.exactSafe ? "YES" : "NO"}`,
            `Fuzzy Skipped: ${first.fuzzySkipped || "NO"}`,
            `Result: ${inspected.match.word ? "TOXIC" : "CLEAN"}`,
            ...(inspected.match.word ? [
                `Matched: ${inspected.match.word}`,
                `Match Type: ${inspected.match.detectionVariant}`,
            ] : []),
        ].join("\n") })
        return true
    }

    if (action === "add") {
        const word = normalizeSafeWord(argument)
        if (!word) {
            await sock.sendMessage(from, { text: "Safe word harus satu token valid tanpa underscore." })
            return true
        }
        const rawToxic = new Set((options.toxicWords || []).map(normalizeSafeWord))
        if (rawToxic.has(word)) {
            await sock.sendMessage(from, { text: "Kata tersebut ada di toxic wordlist dan tidak boleh ditambahkan sebagai safe word." })
            return true
        }
        const words = uniqueSafeWords([...state.words, word])
        saveSafeWordState({ version: 1, words, updatedAt: Date.now() })
        initializeMatcher({ ...options, force: true })
        await sock.sendMessage(from, { text: `Safe word ditambahkan: ${word}` })
        return true
    }

    if (action === "del") {
        const word = normalizeSafeWord(argument)
        const words = state.words.filter(item => item !== word)
        saveSafeWordState({ version: 1, words, updatedAt: Date.now() })
        initializeMatcher({ ...options, force: true })
        await sock.sendMessage(from, { text: `Safe word dihapus: ${word || "-"}` })
        return true
    }

    if (action === "reload") {
        loadSafeWordState({ force: true })
        const regression = initializeMatcher({ ...options, force: true })
        await sock.sendMessage(from, { text: `Safe-word store dimuat ulang. Regression: ${regression.status} (${regression.tested} kata).` })
        return true
    }

    if (action === "collisions") {
        const collisions = analyzeLegacyCollisions({ ...options, corpus: state.words })
        await sock.sendMessage(from, { text: [
            "🛡️ *LEGACY FUZZY COLLISIONS*",
            "",
            ...maskCollisionLines(collisions),
            "",
            `Matcher v2 regression: ${lastRegression.status}`,
        ].join("\n") })
        return true
    }

    await sock.sendMessage(from, { text: [
        "🛡️ *ANTI KASAR SAFE MATCHER*",
        "",
        ".kasarsafe status",
        ".kasarsafe list",
        ".kasarsafe test <teks>",
        ".kasarsafe add <kata>",
        ".kasarsafe del <kata>",
        ".kasarsafe reload",
        ".kasarsafe collisions",
    ].join("\n") })
    return true
}

module.exports = {
    normalizeToken,
    tokenizeForAntiToxic,
    buildCanonicalCandidates,
    isExactToxicWord,
    isExactSafeWord,
    stripAllowedClitic,
    getDynamicFuzzyPolicy,
    calculateSimilarity,
    findToxicMatch,
    scanTextForToxicWords,
    testSafeWordCorpus,
    getMatcherHealth,
    loadSafeWordState,
    saveSafeWordState,
    initializeMatcher,
    analyzeLegacyCollisions,
    inspectText,
    handleAntiToxicSafeMatcherCommand,
    MATCHER_VERSION,
    SAFE_WORDS_FILE,
}
