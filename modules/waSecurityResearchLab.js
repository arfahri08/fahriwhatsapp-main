"use strict"

const fs = require("fs")
const path = require("path")

const BUILD = "WA-SECURITY-RESEARCH-LAB-2026-08-11.5"
const DEFAULT_STATE_PATH = path.join(__dirname, "..", "data", "waSecurityResearch.json")
const MAX_SAFE_TEXT = 4000
const MAX_SAFE_UNICODE_MARKS = 64
const MAX_SOURCE_SCAN = 50000
const TARGET_RE = /^(?:\+?62|0)\d{7,15}$/

// Defensive-only research guard. It deliberately contains no exploit payload
// generator and exposes no bypass switch. The goal is to let the owner inspect
// suspicious source/payload characteristics while blocking obviously abusive
// outbound structures before they reach Baileys.
const LIMITS = Object.freeze({
    maxDepth: 40,
    maxNodes: 6000,
    maxArrayLength: 2000,
    maxSingleStringChars: 60000,
    maxTotalStringChars: 200000,
    maxApproxBytes: 512 * 1024,
    maxMentions: 1000,
    maxInvisibleChars: 8000,
    maxRepeatedRun: 4096,
    burstWindowMs: 10000,
    maxBurstPerTarget: 50,
})

const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const recentOutboundByTarget = new Map()
const researchWizardByOwner = new Map()
const WIZARD_TTL_MS = 5 * 60 * 1000

const CATEGORY_INFO = Object.freeze({
    virtex: {
        title: "Oversized / rendering-stress text (virtex)",
        working: "Biasanya mengandalkan teks sangat besar, pengulangan karakter/Unicode, atau kombinasi karakter tak terlihat yang membuat parser/rendering client bekerja jauh lebih berat dari pesan normal.",
        safeStudy: "Ukur panjang karakter/byte, rasio zero-width/bidi, run karakter berulang, waktu encode/decode, dan memory usage pada mock/local object. Jangan kirim payload ke akun orang lain.",
        mitigation: "Batasi ukuran string, zero-width/bidi density, repeated-run, dan total payload sebelum send/relay.",
    },
    crash: {
        title: "Crafted crash / malformed message structure",
        working: "Biasanya memakai struktur pesan yang sangat besar, terlalu dalam, tidak lazim, atau kombinasi field/proto yang memicu edge case parser/client. Sebagian script juga mengulang pengiriman untuk memperbesar dampak.",
        safeStudy: "Inspeksi object tree, depth, node count, encoded size, dan API Baileys yang dipakai menggunakan mock socket. Laporkan minimal reproducer yang sudah diperkecil tanpa blast.",
        mitigation: "Block object yang terlalu dalam/besar dan batasi outbound burst. Jangan meneruskan object mentah yang tidak dipercaya ke relayMessage.",
    },
    bug: {
        title: "Protocol / client edge-case message",
        working: "Istilah 'bug WA' pada script pihak ketiga biasanya berarti pesan yang sengaja membentuk kombinasi message node/proto tidak normal untuk memicu bug client tertentu.",
        safeStudy: "Catat message type, field yang ada, ukuran encoded, versi Baileys/client, stack/error, dan apakah reproduksi tetap terjadi setelah field yang tidak penting dihapus.",
        mitigation: "Schema/size validation, bounded nesting, safe defaults, dan jangan menerima raw proto dari user untuk diteruskan begitu saja.",
    },
    invisible: {
        title: "Invisible / zero-width payload",
        working: "Menggunakan banyak karakter zero-width, bidi/control, atau konten yang secara visual tampak kecil tetapi ukuran sebenarnya besar.",
        safeStudy: "Bandingkan visible length dengan code-point/byte length serta hitung zero-width/control characters secara lokal.",
        mitigation: "Tolak density dan jumlah karakter invisible/control yang tidak wajar.",
    },
    quota: {
        title: "Bandwidth / quota drain",
        working: "Bukan satu bug proto spesifik; pola umumnya adalah membuat target menerima transfer/pesan besar atau berulang sehingga konsumsi data, CPU, atau storage meningkat.",
        safeStudy: "Gunakan mock transport dan hitung estimasi bytes × repeat count. Jangan melakukan transfer aktual ke target real.",
        mitigation: "Rate limit, byte budget, max media size, bounded queue, dan cancel control.",
    },
    spam: {
        title: "Repeated target messaging / flood",
        working: "Loop atau queue mengirim pesan/request berulang ke target yang sama dalam waktu singkat.",
        safeStudy: "Ganti transport dengan mock lalu ukur intended send count, interval, retry policy, dan dedupe behavior.",
        mitigation: "Per-target burst limit, concurrency 1, delay, dedupe, stop control, dan no ambiguous auto-retry.",
    },
})

function normalizeCategory(value) {
    const raw = String(value || "").trim().toLowerCase()
    if (["virtex", "text"].includes(raw)) return "virtex"
    if (["crash", "freeze", "dozer", "bulldozer"].includes(raw)) return "crash"
    if (["bug", "bugwa", "proto", "protocol"].includes(raw)) return "bug"
    if (["invis", "invisible", "zerowidth", "zero-width"].includes(raw)) return "invisible"
    if (["quota", "kuota", "bandwidth"].includes(raw)) return "quota"
    if (["spam", "flood", "nglspam"].includes(raw)) return "spam"
    return ""
}



function normalizeNumber(value) {
    let digits = String(value || "").replace(/\D/g, "")
    if (digits.startsWith("0")) digits = `62${digits.slice(1)}`
    if (!digits.startsWith("62")) return ""
    return digits
}

function toJid(value) {
    const digits = normalizeNumber(value)
    return digits ? `${digits}@s.whatsapp.net` : ""
}

function statePath() {
    return process.env.WA_SECURITY_RESEARCH_STATE_PATH || DEFAULT_STATE_PATH
}

function loadState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8"))
        return {
            targetJid: typeof parsed?.targetJid === "string" ? parsed.targetJid : "",
            lastProbe: parsed?.lastProbe && typeof parsed.lastProbe === "object" ? parsed.lastProbe : null,
        }
    } catch {
        return { targetJid: "", lastProbe: null }
    }
}

function saveState(state) {
    const file = statePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temp, file)
}

function safeJsonSize(value) {
    try { return Buffer.byteLength(JSON.stringify(value), "utf8") } catch { return -1 }
}

function objectMetrics(root) {
    let nodes = 0
    let strings = 0
    let stringBytes = 0
    let maxDepth = 0
    const seen = new Set()
    function walk(value, depth) {
        maxDepth = Math.max(maxDepth, depth)
        if (value == null) return
        if (typeof value === "string") {
            strings += 1
            stringBytes += Buffer.byteLength(value, "utf8")
            return
        }
        if (typeof value !== "object") return
        if (seen.has(value)) return
        seen.add(value)
        nodes += 1
        if (Array.isArray(value)) {
            for (const item of value) walk(item, depth + 1)
        } else {
            for (const item of Object.values(value)) walk(item, depth + 1)
        }
    }
    walk(root, 0)
    return { nodes, strings, stringBytes, maxDepth, jsonBytes: safeJsonSize(root) }
}

function buildSafeProbe(kind, arg) {
    const key = String(kind || "baseline").toLowerCase()
    if (key === "baseline") return { text: "WA research baseline probe — pesan normal single-shot." }
    if (key === "text") {
        const requested = Math.max(1, Math.min(MAX_SAFE_TEXT, Number.parseInt(arg, 10) || 1000))
        return { text: `WA research bounded text probe (${requested} chars)\n${"A".repeat(Math.max(0, requested - 48))}`.slice(0, MAX_SAFE_TEXT) }
    }
    if (key === "unicode") {
        const count = Math.max(1, Math.min(MAX_SAFE_UNICODE_MARKS, Number.parseInt(arg, 10) || 8))
        return { text: `WA research unicode probe count=${count}: [${"\u200B".repeat(count)}] END` }
    }
    if (key === "context") {
        return {
            text: "WA research contextInfo probe — bounded metadata.",
            contextInfo: {
                externalAdReply: {
                    title: "WA Security Research",
                    body: "Safe bounded probe",
                    sourceUrl: "https://github.com/WhiskeySockets/Baileys",
                    mediaType: 1,
                    renderLargerThumbnail: false,
                },
            },
        }
    }
    throw new Error("Probe tidak dikenal. Gunakan baseline, text <1-4000>, unicode <1-64>, atau context.")
}

function formatMetrics(metrics) {
    return `jsonBytes=${metrics.jsonBytes}, stringBytes=${metrics.stringBytes}, nodes=${metrics.nodes}, depth=${metrics.maxDepth}`
}

function maskJid(jid) {
    const digits = String(jid || "").replace(/@.*/, "")
    if (digits.length < 7) return digits || "-"
    return `${digits.slice(0, 4)}***${digits.slice(-3)}`
}

function formatLastProbe(probe) {
    if (!probe) return "Belum ada live probe."
    return [
        `Jenis: ${probe.kind}`,
        `Target: ${probe.targetMasked || "-"}`,
        `Waktu: ${probe.at || "-"}`,
        `Durasi: ${probe.durationMs ?? "-"} ms`,
        `Metrics: ${probe.metrics ? formatMetrics(probe.metrics) : "-"}`,
        `Result: ${probe.ok ? "SUCCESS" : "FAILED"}`,
        probe.messageId ? `Message ID: ${probe.messageId}` : "",
        probe.error ? `Error: ${probe.error}` : "",
    ].filter(Boolean).join("\n")
}

function countRepeatedRun(text) {
    let best = 0
    let run = 0
    let previous = ""
    for (const ch of String(text || "")) {
        if (ch === previous) run += 1
        else {
            previous = ch
            run = 1
        }
        if (run > best) best = run
        if (best > LIMITS.maxRepeatedRun) break
    }
    return best
}

function safeObjectSummary(root) {
    const metrics = {
        depth: 0,
        nodes: 0,
        maxArrayLength: 0,
        totalStringChars: 0,
        maxSingleStringChars: 0,
        invisibleChars: 0,
        controlChars: 0,
        maxRepeatedRun: 0,
        mentions: 0,
        approxBytes: 0,
        keys: new Set(),
    }
    const seen = new Set()

    function visit(value, depth, keyName = "") {
        metrics.depth = Math.max(metrics.depth, depth)
        metrics.nodes += 1
        if (keyName) metrics.keys.add(String(keyName).slice(0, 80))
        if (metrics.nodes > LIMITS.maxNodes * 2) return

        if (value == null) return
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
            // Media/binary itself is governed by the project's dedicated media limits;
            // do not stringify it into memory here.
            metrics.approxBytes += 32
            return
        }
        const type = typeof value
        if (type === "string") {
            const length = value.length
            metrics.totalStringChars += length
            metrics.maxSingleStringChars = Math.max(metrics.maxSingleStringChars, length)
            metrics.invisibleChars += (value.match(ZERO_WIDTH_RE) || []).length
            metrics.controlChars += (value.match(CONTROL_RE) || []).length
            metrics.maxRepeatedRun = Math.max(metrics.maxRepeatedRun, countRepeatedRun(value))
            metrics.approxBytes += Buffer.byteLength(value, "utf8")
            return
        }
        if (type === "number" || type === "boolean" || type === "bigint") {
            metrics.approxBytes += 16
            return
        }
        if (type !== "object") return
        if (seen.has(value)) return
        seen.add(value)

        if (Array.isArray(value)) {
            metrics.maxArrayLength = Math.max(metrics.maxArrayLength, value.length)
            if (/mention/i.test(keyName)) metrics.mentions += value.length
            for (const item of value.slice(0, LIMITS.maxArrayLength + 50)) visit(item, depth + 1, keyName)
            return
        }

        for (const [key, child] of Object.entries(value)) {
            metrics.approxBytes += Buffer.byteLength(String(key), "utf8") + 4
            visit(child, depth + 1, key)
        }
    }

    visit(root, 1)
    metrics.keys = [...metrics.keys].sort()
    return metrics
}

function analyzePayload(payload) {
    const metrics = safeObjectSummary(payload)
    const reasons = []
    if (metrics.depth > LIMITS.maxDepth) reasons.push(`depth>${LIMITS.maxDepth}`)
    if (metrics.nodes > LIMITS.maxNodes) reasons.push(`nodes>${LIMITS.maxNodes}`)
    if (metrics.maxArrayLength > LIMITS.maxArrayLength) reasons.push(`array>${LIMITS.maxArrayLength}`)
    if (metrics.maxSingleStringChars > LIMITS.maxSingleStringChars) reasons.push(`single-string>${LIMITS.maxSingleStringChars}`)
    if (metrics.totalStringChars > LIMITS.maxTotalStringChars) reasons.push(`total-string>${LIMITS.maxTotalStringChars}`)
    if (metrics.approxBytes > LIMITS.maxApproxBytes) reasons.push(`approx-bytes>${LIMITS.maxApproxBytes}`)
    if (metrics.mentions > LIMITS.maxMentions) reasons.push(`mentions>${LIMITS.maxMentions}`)
    if (metrics.invisibleChars > LIMITS.maxInvisibleChars) reasons.push(`invisible>${LIMITS.maxInvisibleChars}`)
    if (metrics.maxRepeatedRun > LIMITS.maxRepeatedRun) reasons.push(`repeat-run>${LIMITS.maxRepeatedRun}`)
    const invisibleDensity = metrics.totalStringChars ? metrics.invisibleChars / metrics.totalStringChars : 0
    if (metrics.totalStringChars > 2000 && invisibleDensity > 0.35) reasons.push("high-invisible-density")
    return {
        safe: reasons.length === 0,
        blocked: reasons.length > 0,
        reasons,
        metrics: {
            ...metrics,
            invisibleDensity: Number(invisibleDensity.toFixed(4)),
        },
    }
}

function pruneBurst(now = Date.now()) {
    for (const [jid, values] of recentOutboundByTarget) {
        const kept = values.filter(ts => now - ts <= LIMITS.burstWindowMs)
        if (kept.length) recentOutboundByTarget.set(jid, kept)
        else recentOutboundByTarget.delete(jid)
    }
}

function claimOutboundTarget(jid, now = Date.now()) {
    pruneBurst(now)
    const key = String(jid || "").trim().toLowerCase() || "unknown"
    const values = recentOutboundByTarget.get(key) || []
    values.push(now)
    recentOutboundByTarget.set(key, values)
    return {
        count: values.length,
        blocked: values.length > LIMITS.maxBurstPerTarget,
    }
}

function makeBlockedError(kind, jid, analysis, burst) {
    const reasons = [...(analysis?.reasons || [])]
    if (burst?.blocked) reasons.push(`burst>${LIMITS.maxBurstPerTarget}/${LIMITS.burstWindowMs}ms`)
    const error = new Error(`Outbound WhatsApp payload diblokir oleh Security Research Guard: ${reasons.join(", ")}`)
    error.code = "WA_PAYLOAD_BLOCKED"
    error.kind = kind
    error.targetJid = String(jid || "")
    error.reasons = reasons
    error.metrics = analysis?.metrics || {}
    return error
}

function inspectAndBlock(kind, jid, payload) {
    const analysis = analyzePayload(payload)
    const burst = claimOutboundTarget(jid)
    if (analysis.blocked || burst.blocked) {
        const error = makeBlockedError(kind, jid, analysis, burst)
        console.log("[WA SECURITY GUARD] BLOCK", {
            build: BUILD,
            kind,
            targetJid: String(jid || "").slice(0, 96),
            reasons: error.reasons,
            metrics: error.metrics,
            burstCount: burst.count,
        })
        throw error
    }
    return analysis
}

function installOutboundSafetyGuard(sock) {
    if (!sock || sock.__waSecurityResearchGuardInstalled) return false

    if (typeof sock.sendMessage === "function") {
        const originalSendMessage = sock.sendMessage.bind(sock)
        sock.sendMessage = async function guardedSendMessage(jid, content, options = {}) {
            inspectAndBlock("sendMessage", jid, { content, options })
            return originalSendMessage(jid, content, options)
        }
    }

    if (typeof sock.relayMessage === "function") {
        const originalRelayMessage = sock.relayMessage.bind(sock)
        sock.relayMessage = async function guardedRelayMessage(jid, message, options = {}) {
            inspectAndBlock("relayMessage", jid, { message, options })
            return originalRelayMessage(jid, message, options)
        }
    }

    sock.__waSecurityResearchGuardInstalled = true
    console.log(`[WA SECURITY GUARD] ${BUILD} active; defensive outbound block has no chat bypass.`)
    return true
}

function extractQuotedText(msg) {
    const q = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage
        || msg?.message?.imageMessage?.contextInfo?.quotedMessage
        || msg?.message?.videoMessage?.contextInfo?.quotedMessage
        || null
    if (!q || typeof q !== "object") return ""
    return String(
        q.conversation
        || q.extendedTextMessage?.text
        || q.imageMessage?.caption
        || q.videoMessage?.caption
        || q.documentMessage?.caption
        || ""
    )
}

function analyzeSourceText(source) {
    const raw = String(source || "")
    const text = raw.slice(0, MAX_SOURCE_SCAN)
    const findings = []
    const checks = [
        ["relay-message", /\brelayMessage\s*\(/g],
        ["send-message", /\bsendMessage\s*\(/g],
        ["loop", /\b(for|while)\s*\(/g],
        ["repeat-builder", /\.repeat\s*\(/g],
        ["proto-builder", /\bproto\.|generateWAMessageFromContent|generateWAMessageContent/g],
        ["interactive", /interactiveMessage|nativeFlowMessage|paramsJson/g],
        ["view-once-envelope", /viewOnceMessage/g],
        ["status-broadcast", /status@broadcast|@newsletter/g],
        ["large-buffer-allocation", /Buffer\.alloc\s*\(/g],
    ]
    for (const [name, regex] of checks) {
        const matches = text.match(regex)
        if (matches?.length) findings.push({ name, count: matches.length })
    }
    const literalInvisible = (text.match(/\\u200[b-f]|\\u202[ae]|\\u206[0-f]|\\ufeff/gi) || []).length
    if (literalInvisible) findings.push({ name: "unicode-control-literal", count: literalInvisible })
    const risk = findings.reduce((score, item) => score + Math.min(item.count, 10), 0)
    return {
        chars: text.length,
        lines: text ? text.split(/\r?\n/).length : 0,
        findings,
        risk: risk >= 12 ? "HIGH-REVIEW" : risk >= 5 ? "REVIEW" : "LOW",
    }
}

function formatSourceScan(result) {
    const lines = [
        "🔬 *WA SECURITY SOURCE SCAN*",
        `Build: ${BUILD}`,
        `Chars: ${result.chars}`,
        `Lines: ${result.lines}`,
        `Risk triage: ${result.risk}`,
        "",
    ]
    if (!result.findings.length) lines.push("Tidak ada signature struktural yang dikenali oleh scanner statis sederhana.")
    else for (const item of result.findings) lines.push(`- ${item.name}: ${item.count}`)
    lines.push("", "Scanner ini hanya triage. Temuan bukan bukti exploit dan tidak mengeksekusi source.")
    return lines.join("\n")
}

function buildExplain(category) {
    const key = normalizeCategory(category)
    if (!key) return "Kategori tersedia: virtex, crash, bug, invisible, quota, spam."
    const info = CATEGORY_INFO[key]
    return [
        `🧪 *${info.title}*`,
        "",
        `Cara kerja tingkat tinggi: ${info.working}`,
        "",
        `Cara uji aman: ${info.safeStudy}`,
        "",
        `Mitigasi: ${info.mitigation}`,
        "",
        "Lab ini sengaja tidak menyediakan payload exploit atau pengiriman ke target real.",
    ].join("\n")
}

function buildSimulation(category) {
    const key = normalizeCategory(category)
    if (!key) return "Kategori tersedia: virtex, crash, bug, invisible, quota, spam."
    const examples = {
        virtex: { intendedTransport: "mock", conceptualSize: "very-large-text", repeat: 1 },
        crash: { intendedTransport: "mock", conceptualShape: "deep-or-oversized-object", repeat: 1 },
        bug: { intendedTransport: "mock", conceptualShape: "unusual-protocol-combination", repeat: 1 },
        invisible: { intendedTransport: "mock", conceptualText: "high-zero-width-density", repeat: 1 },
        quota: { intendedTransport: "mock", conceptualBytes: "large-byte-budget", repeat: "many" },
        spam: { intendedTransport: "mock", conceptualMessage: "ordinary-placeholder", repeat: "many" },
    }
    return [
        "🧯 *SAFE DRY-RUN SIMULATION*",
        `Category: ${key}`,
        "Transport: MOCK ONLY — tidak ada sock.sendMessage/relayMessage.",
        "",
        JSON.stringify(examples[key], null, 2),
        "",
        "Gunakan hasil ini untuk memetakan loop/ukuran/rate tanpa mengirim payload aktual.",
    ].join("\n")
}

function buildReportTemplate(category) {
    const key = normalizeCategory(category) || "unknown"
    return [
        "📋 *BAILEYS SECURITY REPORT TEMPLATE*",
        `Category: ${key}`,
        `Research guard build: ${BUILD}`,
        `Node: ${process.version}`,
        "",
        "Isi saat pengujian lokal/staging:",
        "1. Baileys version / commit:",
        "2. WhatsApp client/version target uji milik sendiri:",
        "3. Message type/API path (sendMessage/relayMessage):",
        "4. Encoded/object size:",
        "5. Object depth/node count:",
        "6. Repeat count/rate (gunakan mock bila memungkinkan):",
        "7. Expected result:",
        "8. Actual result/error/stack:",
        "9. Minimal reproducer yang sudah diperkecil:",
        "10. Mitigation/validation suggestion:",
        "",
        "Jangan sertakan auth/session keys, messageSecret, mediaKey, token, atau data pihak ketiga.",
    ].join("\n")
}

function wizardOwnerKey(context = {}, msg = {}) {
    return String(
        context.senderJid
        || context.resolvedSender
        || context.replyJid
        || context.from
        || msg?.key?.participant
        || msg?.key?.remoteJid
        || "owner"
    ).trim()
}

function getWizard(ownerKey) {
    const wizard = researchWizardByOwner.get(ownerKey)
    if (!wizard) return null
    if (Date.now() - Number(wizard.updatedAt || 0) > WIZARD_TTL_MS) {
        researchWizardByOwner.delete(ownerKey)
        return null
    }
    return wizard
}

function setWizard(ownerKey, patch) {
    const next = { ...(researchWizardByOwner.get(ownerKey) || {}), ...patch, updatedAt: Date.now() }
    researchWizardByOwner.set(ownerKey, next)
    return next
}

function clearWizard(ownerKey) {
    researchWizardByOwner.delete(ownerKey)
}

function safeProbeCeiling(content) {
    const metrics = objectMetrics(content)
    const blocked = metrics.jsonBytes < 0 || metrics.jsonBytes > 8192 || metrics.maxDepth > 8 || metrics.nodes > 64 || metrics.stringBytes > 6000
    return { metrics, blocked }
}

async function executeLiveSafeProbe(sock, state, targetJid, kind = "baseline", arg) {
    const content = buildSafeProbe(kind, arg)
    const ceiling = safeProbeCeiling(content)
    const started = Date.now()
    const baseReport = {
        build: BUILD,
        targetMasked: maskJid(targetJid),
        kind,
        at: new Date(started).toISOString(),
        metrics: ceiling.metrics,
    }

    if (ceiling.blocked) {
        const report = { ...baseReport, durationMs: 0, ok: false, blocked: true, error: "SAFETY_CEILING" }
        state.lastProbe = report
        saveState(state)
        console.log("[WA RESEARCH TEST]", report)
        return {
            sent: false,
            blocked: true,
            text: [
                "❌ *LAPORAN PERCOBAAN WA*",
                `Target: ${report.targetMasked}`,
                "Status: GAGAL SEBELUM KIRIM",
                `Waktu: ${report.at}`,
                `Metrics: ${formatMetrics(report.metrics)}`,
                "Alasan: safety ceiling",
            ].join("\n"),
        }
    }

    try {
        const result = await sock.sendMessage(targetJid, content)
        const report = {
            ...baseReport,
            durationMs: Date.now() - started,
            ok: true,
            blocked: false,
            messageId: String(result?.key?.id || ""),
        }
        state.lastProbe = report
        saveState(state)
        console.log("[WA RESEARCH TEST]", report)
        return {
            sent: true,
            blocked: false,
            text: [
                "✅ *LAPORAN PERCOBAAN WA*",
                `Target: ${report.targetMasked}`,
                "Status: BERHASIL DIKIRIM",
                `Waktu: ${report.at}`,
                `Durasi: ${report.durationMs} ms`,
                `Message ID: ${report.messageId || "-"}`,
                `Metrics: ${formatMetrics(report.metrics)}`,
            ].join("\n"),
        }
    } catch (error) {
        const report = {
            ...baseReport,
            durationMs: Date.now() - started,
            ok: false,
            blocked: false,
            error: String(error?.message || error).slice(0, 500),
        }
        state.lastProbe = report
        saveState(state)
        console.log("[WA RESEARCH TEST]", report)
        return {
            sent: false,
            blocked: false,
            text: [
                "❌ *LAPORAN PERCOBAAN WA*",
                `Target: ${report.targetMasked}`,
                "Status: GAGAL DIKIRIM",
                `Waktu: ${report.at}`,
                `Durasi: ${report.durationMs} ms`,
                `Metrics: ${formatMetrics(report.metrics)}`,
                `Error: ${report.error}`,
            ].join("\n"),
        }
    }
}

async function handleResearchLabCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    const isOwnerPrivate = !context.isGroup && Boolean(context.canControlOwner || context.isOwner)
    const replyJid = context.replyJid || context.from || msg?.key?.remoteJid
    const reply = async value => sock.sendMessage(replyJid, { text: value }, { quoted: msg })
    const ownerKey = wizardOwnerKey(context, msg)
    const match = /^\.(?:waresearch|walab)(?:\s+([\s\S]*))?$/i.exec(text)

    // Wizard intentionally accepts the manually typed number directly after
    // `.waresearch test`. There is no ownership/pairing verification step.
    // The live sender remains bounded to the safe single-shot probe builders.
    if (!match) {
        if (!isOwnerPrivate) return false
        const wizard = getWizard(ownerKey)
        if (!wizard) return false
        if (/^(?:batal|cancel)$/i.test(text)) {
            clearWizard(ownerKey)
            await reply("✅ Research test dibatalkan.")
            return true
        }

        if (wizard.stage === "target") {
            if (!TARGET_RE.test(text)) {
                await reply("Format nomor tidak valid. Ketik nomor test, contoh `62812xxxxxxx`, atau BATAL.")
                return true
            }
            const targetJid = toJid(text)
            if (!targetJid) {
                await reply("Nomor harus bisa dinormalisasi ke format 62xxxxxxxx. Coba lagi atau ketik BATAL.")
                return true
            }
            clearWizard(ownerKey)
            await reply(`🧪 Testing ke ${maskJid(targetJid)}...`)
            const state = loadState()
            const result = await executeLiveSafeProbe(sock, state, targetJid, "baseline")
            await reply(result.text)
            return true
        }

        clearWizard(ownerKey)
        return false
    }

    if (!isOwnerPrivate) return true

    const rest = String(match[1] || "status").trim()
    const [actionRaw, ...argParts] = rest.split(/\s+/)
    const action = String(actionRaw || "status").toLowerCase()
    const args = argParts.join(" ")
    const state = loadState()

    if (["status", "help"].includes(action)) {
        const wizard = getWizard(ownerKey)
        await reply([
            "🛡️ *WA SECURITY RESEARCH LAB*",
            `Build: ${BUILD}`,
            "Outbound guard: ALWAYS ON (tidak ada chat bypass)",
            "Live transport: SAFE SINGLE-SHOT",
            `Target tersimpan: ${state.targetJid ? maskJid(state.targetJid) : "belum disetel"}`,
            `Manual test wizard: ${wizard ? wizard.stage : "idle"}`,
            `Max text probe: ${MAX_SAFE_TEXT} chars`,
            `Max unicode marks: ${MAX_SAFE_UNICODE_MARKS}`,
            "Crash/virtex/flood payload operasional: DISABLED",
            "",
            ".waresearch test — bot minta nomor lalu langsung testing + laporan",
            ".waresearch test <nomor> — langsung testing + laporan",
            ".waresearch cancel — batalkan wizard",
            ".waresearch target <nomor-test>",
            ".waresearch send baseline",
            ".waresearch send text <1-4000>",
            ".waresearch send unicode <1-64>",
            ".waresearch send context",
            ".waresearch last",
            ".waresearch explain <virtex|crash|bug|invisible|quota|spam>",
            ".waresearch scan <source> — atau reply source",
            ".waresearch simulate <category> — dry-run tanpa network",
            ".waresearch report <category> — template laporan Baileys",
            ".waresearch selftest",
        ].join("\n"))
        return true
    }

    if (action === "test") {
        clearWizard(ownerKey)
        const supplied = String(argParts[0] || "").trim()
        if (!supplied) {
            setWizard(ownerKey, { stage: "target" })
            await reply("🧪 *LIVE RESEARCH TEST*\n\nKetik nomor test yang mau dipakai, contoh `62812xxxxxxx`.\nTidak ada langkah verifikasi/pairing.\n\nKetik BATAL untuk keluar.")
            return true
        }
        if (!TARGET_RE.test(supplied)) {
            await reply("Format nomor test tidak valid. Contoh: `.waresearch test 62812xxxxxxx`.")
            return true
        }
        const targetJid = toJid(supplied)
        if (!targetJid) {
            await reply("Nomor harus bisa dinormalisasi ke format 62xxxxxxxx.")
            return true
        }
        await reply(`🧪 Testing ke ${maskJid(targetJid)}...`)
        const result = await executeLiveSafeProbe(sock, state, targetJid, "baseline")
        await reply(result.text)
        return true
    }

    if (["cancel", "batal"].includes(action)) {
        clearWizard(ownerKey)
        await reply("✅ Research wizard dibatalkan.")
        return true
    }

    if (action === "target") {
        const rawTarget = argParts[0] || ""
        if (!TARGET_RE.test(rawTarget)) {
            await reply("Format nomor test tidak valid. Contoh: `.waresearch target 62812xxxxxxx`.")
            return true
        }
        const jid = toJid(rawTarget)
        if (!jid) {
            await reply("Nomor harus Indonesia dan dinormalisasi ke 62xxxxxxxx.")
            return true
        }
        state.targetJid = jid
        saveState(state)
        await reply(`✅ Target test disetel ke ${maskJid(jid)}. Hanya probe aman single-shot yang tersedia.`)
        return true
    }

    if (action === "send") {
        if (!state.targetJid) {
            await reply("Set target nomor test dulu dengan `.waresearch target 628xx...` atau gunakan `.waresearch test`.")
            return true
        }
        const kind = String(argParts[0] || "baseline").toLowerCase()
        try {
            const result = await executeLiveSafeProbe(sock, state, state.targetJid, kind, argParts[1])
            await reply(result.text)
        } catch (error) {
            await reply(String(error?.message || error))
        }
        return true
    }

    if (action === "last") {
        await reply(`📋 *LAST LIVE PROBE*\n${formatLastProbe(state.lastProbe)}`)
        return true
    }

    if (action === "explain") {
        await reply(buildExplain(args))
        return true
    }
    if (action === "simulate") {
        await reply(buildSimulation(args))
        return true
    }
    if (action === "report") {
        await reply(buildReportTemplate(args))
        return true
    }
    if (action === "scan") {
        const source = args || extractQuotedText(msg)
        if (!source) await reply("Reply source/text atau gunakan `.waresearch scan <snippet>` untuk static scan.")
        else await reply(formatSourceScan(analyzeSourceText(source)))
        return true
    }
    if (action === "selftest") {
        const safe = analyzePayload({ text: "hello" })
        const suspicious = analyzePayload({ text: "x".repeat(LIMITS.maxSingleStringChars + 1) })
        await reply([
            "🧪 *RESEARCH GUARD SELFTEST*",
            `safe payload allowed: ${safe.safe ? "PASS" : "FAIL"}`,
            `oversized synthetic blocked: ${suspicious.blocked ? "PASS" : "FAIL"}`,
            "Tidak ada network send selama selftest.",
        ].join("\n"))
        return true
    }

    await reply("Subcommand tidak dikenal. Gunakan `.waresearch status`.")
    return true
}

function resetRuntimeForTests() {
    recentOutboundByTarget.clear()
    researchWizardByOwner.clear()
}

module.exports = {
    BUILD,
    LIMITS,
    CATEGORY_INFO,
    MAX_SAFE_TEXT,
    MAX_SAFE_UNICODE_MARKS,
    normalizeNumber,
    toJid,
    objectMetrics,
    buildSafeProbe,
    safeProbeCeiling,
    analyzePayload,
    analyzeSourceText,
    buildExplain,
    buildSimulation,
    buildReportTemplate,
    handleResearchLabCommand,
    handleCommand: handleResearchLabCommand,
    installOutboundSafetyGuard,
    inspectAndBlock,
    resetRuntimeForTests,
}
