const fs = require("fs")
const path = require("path")

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_RECORDS = 500
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "expired", "failed"])
const VALID_STATUSES = new Set(["pending", "processing", "completed", "cancelled", "expired", "failed"])

const installedSockets = new WeakMap()
const actionHandlers = new Map()
let cleanupTimer = null

function getDataFile() {
    return process.env.REACTION_ACTIONS_FILE
        ? path.resolve(process.env.REACTION_ACTIONS_FILE)
        : path.join(__dirname, "../data/reactionActions.json")
}

function parseBool(value, defaultValue) {
    if (value == null || value === "") return defaultValue
    const clean = String(value).trim().toLowerCase()
    if (["1", "true", "yes", "y", "on", "aktif", "enable", "enabled"].includes(clean)) return true
    if (["0", "false", "no", "n", "off", "mati", "disable", "disabled"].includes(clean)) return false
    return defaultValue
}

function getConfig() {
    return {
        enabledByEnv: parseBool(process.env.REACTION_WORKFLOW_ENABLED, true),
        debug: parseBool(process.env.REACTION_WORKFLOW_DEBUG, false),
        ownerOnly: parseBool(process.env.REACTION_OWNER_ONLY, true),
        allowGroupControl: parseBool(process.env.REACTION_ALLOW_GROUP_CONTROL, false),
        ttlMs: Math.max(60 * 1000, Number(process.env.REACTION_ACTION_TTL_MS || DEFAULT_TTL_MS) || DEFAULT_TTL_MS),
        maxRecords: Math.max(50, Number(process.env.REACTION_ACTION_MAX_RECORDS || DEFAULT_MAX_RECORDS) || DEFAULT_MAX_RECORDS),
        cleanupIntervalMs: Math.max(30 * 1000, Number(process.env.REACTION_ACTION_CLEANUP_INTERVAL_MS || DEFAULT_CLEANUP_INTERVAL_MS) || DEFAULT_CLEANUP_INTERVAL_MS),
    }
}

function defaultState() {
    return {
        version: 1,
        settings: {
            enabled: true,
        },
        actions: {},
        updatedAt: Date.now(),
    }
}

function ensureDataDir() {
    fs.mkdirSync(path.dirname(getDataFile()), { recursive: true })
}

function normalizeJid(value) {
    const clean = String(value || "").trim().toLowerCase()
    if (!clean) return ""
    if (clean === "status@broadcast" || clean.endsWith("@newsletter") || clean.endsWith("@broadcast")) return ""

    if (clean.endsWith("@lid")) {
        const user = clean.split("@")[0].split(":")[0].replace(/[^0-9]/g, "")
        return user ? `${user}@lid` : ""
    }

    if (clean.endsWith("@g.us")) {
        const user = clean.split("@")[0]
        return user ? `${user}@g.us` : ""
    }

    const user = clean.split("@")[0].split(":")[0].split("_")[0].replace(/[^0-9]/g, "")
    return user ? `${user}@s.whatsapp.net` : ""
}

function getJidNumber(value) {
    return String(value || "").split("@")[0].split(":")[0].split("_")[0].replace(/[^0-9]/g, "")
}

function isSamePrivateUser(a, b) {
    const numberA = getJidNumber(a)
    const numberB = getJidNumber(b)
    return Boolean(numberA && numberB && numberA === numberB)
}

function unique(items) {
    return [...new Set((items || []).filter(Boolean))]
}

function sanitizeError(error, maxLength = 300) {
    const text = String(error?.message || error || "unknown error").replace(/\s+/g, " ").trim()
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function normalizeAction(input = {}) {
    const now = Date.now()
    const status = VALID_STATUSES.has(String(input.status || "pending")) ? String(input.status || "pending") : "pending"
    return {
        id: String(input.id || makeActionId()),
        chatJid: normalizeJid(input.chatJid),
        controlMessageId: String(input.controlMessageId || ""),
        controlMessageFromMe: input.controlMessageFromMe !== false,
        controlMessageParticipant: String(input.controlMessageParticipant || ""),
        type: String(input.type || "").trim(),
        status,
        allowedActorJids: unique((input.allowedActorJids || []).map(normalizeJid)),
        emojiActions: input.emojiActions && typeof input.emojiActions === "object" ? { ...input.emojiActions } : {},
        payload: input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? { ...input.payload } : {},
        createdAt: Number(input.createdAt || now),
        expiresAt: Number(input.expiresAt || now + getConfig().ttlMs),
        claimedAt: input.claimedAt || null,
        claimedBy: input.claimedBy || null,
        selectedEmoji: input.selectedEmoji || null,
        selectedAction: input.selectedAction || null,
        completedAt: input.completedAt || null,
        failedAt: input.failedAt || null,
        cancelledAt: input.cancelledAt || null,
        expiredAt: input.expiredAt || null,
        expiredNotifiedAt: input.expiredNotifiedAt || null,
        result: input.result || null,
        lastError: input.lastError || null,
    }
}

function normalizeState(input) {
    const state = input && typeof input === "object" && !Array.isArray(input) ? input : defaultState()
    const actions = {}
    for (const [id, action] of Object.entries(state.actions || {})) {
        const normalized = normalizeAction({ ...action, id: action?.id || id })
        if (normalized.id && normalized.chatJid && normalized.controlMessageId && normalized.type) {
            actions[normalized.id] = normalized
        }
    }

    return {
        version: 1,
        settings: {
            ...defaultState().settings,
            ...(state.settings && typeof state.settings === "object" ? state.settings : {}),
        },
        actions,
        updatedAt: Number(state.updatedAt || Date.now()),
    }
}

function loadState() {
    ensureDataDir()
    const file = getDataFile()
    if (!fs.existsSync(file)) return defaultState()

    try {
        return normalizeState(JSON.parse(fs.readFileSync(file, "utf8")))
    } catch (error) {
        try {
            const backup = path.join(path.dirname(file), `reactionActions.corrupt.${Date.now()}.json`)
            fs.copyFileSync(file, backup)
        } catch {}
        const fresh = defaultState()
        saveState(fresh)
        return fresh
    }
}

function saveState(state) {
    ensureDataDir()
    const normalized = normalizeState(state)
    normalized.updatedAt = Date.now()
    const file = getDataFile()
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`)
    fs.renameSync(tmp, file)
    return normalized
}

function mutateState(mutator) {
    const state = loadState()
    const result = mutator(state)
    saveState(state)
    return result
}

function formatDateForId(date = new Date()) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const day = String(date.getDate()).padStart(2, "0")
    return `${year}${month}${day}`
}

function makeActionId() {
    const date = formatDateForId()
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase().replace(/[^A-Z0-9]/g, "")
    return `RACT-${date}-${suffix.slice(-8)}`
}

function isWorkflowEnabled() {
    const config = getConfig()
    if (!config.enabledByEnv) return false
    const state = loadState()
    return state.settings?.enabled !== false
}

function setWorkflowEnabled(enabled) {
    return mutateState(state => {
        state.settings = {
            ...(state.settings || {}),
            enabled: Boolean(enabled),
        }
        return state.settings.enabled
    })
}

function createReactionAction(input = {}) {
    const messageKey = input.messageKey || {}
    const expiresInMs = Math.max(60 * 1000, Number(input.expiresInMs || getConfig().ttlMs) || getConfig().ttlMs)
    const action = normalizeAction({
        id: input.id || makeActionId(),
        chatJid: input.chatJid || messageKey.remoteJid,
        controlMessageId: input.controlMessageId || messageKey.id,
        controlMessageFromMe: input.controlMessageFromMe ?? messageKey.fromMe ?? true,
        controlMessageParticipant: input.controlMessageParticipant || messageKey.participant || "",
        type: input.type,
        allowedActorJids: input.allowedActorJids || [],
        emojiActions: input.emojiActions || {},
        payload: input.payload || {},
        createdAt: Date.now(),
        expiresAt: Date.now() + expiresInMs,
        status: "pending",
    })

    if (!action.chatJid || !action.controlMessageId || !action.type) {
        throw new Error("reaction action tidak lengkap")
    }

    return mutateState(state => {
        state.actions[action.id] = action
        return action
    })
}

function getReactionAction(id) {
    return loadState().actions[String(id || "")] || null
}

function listReactionActions(options = {}) {
    const limit = Math.max(1, Number(options.limit || 0) || 0)
    const list = Object.values(loadState().actions || {})
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    return limit ? list.slice(0, limit) : list
}

function findActionForTargetKey(targetKey = {}) {
    const targetId = String(targetKey.id || "")
    const targetChat = normalizeJid(targetKey.remoteJid)
    if (!targetId || !targetChat) return null
    if (targetKey.fromMe === false) return null

    return Object.values(loadState().actions || {}).find(action => (
        action.controlMessageId === targetId &&
        action.controlMessageFromMe === true &&
        normalizeJid(action.chatJid) === targetChat
    )) || null
}

function cancelReactionAction(actionId, reason = "cancelled") {
    return mutateState(state => {
        const action = state.actions[actionId]
        if (!action || !["pending", "processing"].includes(action.status)) return null
        action.status = "cancelled"
        action.cancelledAt = Date.now()
        action.result = { ok: true, reason }
        return { ...action }
    })
}

function markActionCompleted(actionId, result = {}) {
    return mutateState(state => {
        const action = state.actions[actionId]
        if (!action) return null
        action.status = "completed"
        action.completedAt = Date.now()
        action.result = {
            ok: true,
            message: String(result.message || "Action completed."),
            data: result.data || {},
        }
        action.lastError = null
        return { ...action }
    })
}

function markActionFailed(actionId, error) {
    return mutateState(state => {
        const action = state.actions[actionId]
        if (!action) return null
        action.status = "failed"
        action.failedAt = Date.now()
        action.lastError = sanitizeError(error)
        action.result = {
            ok: false,
            message: action.lastError,
        }
        return { ...action }
    })
}

function markActionExpired(actionId, notify = false) {
    return mutateState(state => {
        const action = state.actions[actionId]
        if (!action) return null
        if (action.status === "pending") {
            action.status = "expired"
            action.expiredAt = Date.now()
        }
        if (notify && !action.expiredNotifiedAt) action.expiredNotifiedAt = Date.now()
        return { ...action }
    })
}

function claimReactionAction(actionId, reactorJid, emoji) {
    return mutateState(state => {
        const action = state.actions[actionId]
        if (!action || action.status !== "pending") return null
        if (Date.now() > Number(action.expiresAt || 0)) {
            action.status = "expired"
            action.expiredAt = Date.now()
            return null
        }

        const selectedAction = action.emojiActions?.[emoji]
        if (!selectedAction) return null

        action.status = "processing"
        action.claimedAt = Date.now()
        action.claimedBy = normalizeJid(reactorJid)
        action.selectedEmoji = emoji
        action.selectedAction = selectedAction
        return { ...action }
    })
}

function cleanupExpiredActions(options = {}) {
    const now = Date.now()
    const maxRecords = Math.max(50, Number(options.maxRecords || getConfig().maxRecords) || getConfig().maxRecords)
    return mutateState(state => {
        for (const action of Object.values(state.actions || {})) {
            if (action.status === "pending" && now > Number(action.expiresAt || 0)) {
                action.status = "expired"
                action.expiredAt = action.expiredAt || now
            }
        }

        let actions = Object.values(state.actions || {})
        if (options.clearTerminal === true) {
            actions = actions.filter(action => !TERMINAL_STATUSES.has(action.status))
        }

        if (actions.length > maxRecords) {
            const pending = actions.filter(action => action.status === "pending" || action.status === "processing")
            const terminal = actions
                .filter(action => !pending.includes(action))
                .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
            actions = [...pending, ...terminal.slice(0, Math.max(0, maxRecords - pending.length))]
        }

        state.actions = Object.fromEntries(actions.map(action => [action.id, action]))
        return {
            total: actions.length,
            removed: 0,
        }
    })
}

function normalizeMessageKey(key = {}) {
    return {
        remoteJid: normalizeJid(key.remoteJid),
        id: String(key.id || ""),
        fromMe: key.fromMe === undefined ? undefined : Boolean(key.fromMe),
        participant: normalizeJid(key.participant),
    }
}

function getReactionPayload(update = {}) {
    if (!update || typeof update !== "object") return {}
    return update.reaction || update.reactionMessage || update.message?.reactionMessage || update.message?.reaction || {}
}

function normalizeReactionUpdate(update) {
    if (Array.isArray(update)) {
        return update.map(normalizeReactionUpdate).filter(Boolean)
    }

    if (!update || typeof update !== "object") return null

    const reaction = getReactionPayload(update)
    const targetKey = normalizeMessageKey(update.key || reaction.targetMessageKey || reaction.messageKey || reaction.key || {})
    const reactionKey = normalizeMessageKey(reaction.key || update.reactionKey || update.messageKey || {})
    const emoji = String(reaction.text ?? reaction.emoji ?? reaction.reaction ?? update.text ?? "").trim()
    const removed = !emoji
    const reactorJid = normalizeJid(
        update.actor ||
        update.author ||
        update.participant ||
        reaction.participant ||
        reaction.senderJid ||
        reactionKey.participant ||
        reactionKey.remoteJid ||
        targetKey.participant ||
        targetKey.remoteJid
    )

    return {
        targetKey,
        reactorJid,
        emoji,
        timestamp: Number(reaction.senderTimestampMs || update.timestamp || Date.now()),
        removed,
        raw: update,
    }
}

function resolveActorJid(jid, context = {}) {
    const normalized = normalizeJid(jid)
    if (!normalized) return ""
    if (normalized.endsWith("@lid")) {
        const resolved = context.lidAliasStore?.resolveBestJid?.(normalized)
        const resolvedNormalized = normalizeJid(resolved)
        return resolvedNormalized && !resolvedNormalized.endsWith("@lid") ? resolvedNormalized : ""
    }
    return normalized
}

function isAllowedActor(action, reactorJid, context = {}) {
    const actor = resolveActorJid(reactorJid, context)
    if (!actor) return false

    const allowed = (action.allowedActorJids || [])
        .map(jid => resolveActorJid(jid, context) || normalizeJid(jid))
        .filter(Boolean)

    const listed = allowed.some(jid => jid === actor || isSamePrivateUser(jid, actor))
    if (!getConfig().ownerOnly) return listed || true

    const ownerByCallback = typeof context.isOwnerJid === "function" && context.isOwnerJid(actor)
    const ownerJid = typeof context.resolveOwnerJid === "function" ? normalizeJid(context.resolveOwnerJid()) : ""
    const ownerByPrimary = ownerJid && (ownerJid === actor || isSamePrivateUser(ownerJid, actor))
    return Boolean(listed || ownerByCallback || ownerByPrimary)
}

function reactionDebug(normalized, action, matched, result = "") {
    if (!getConfig().debug) return
    console.log("[REACTION]", {
        messageId: normalized?.targetKey?.id || "-",
        emoji: normalized?.emoji || "-",
        actor: normalized?.reactorJid ? "present" : "-",
        actionId: action?.id || "-",
        matched,
        result,
    })
}

function reactionRouterTrace(action, normalized, result, ownerMatched = false) {
    if (!parseBool(process.env.ROUTER_TRACE_ENABLED, false)) return
    console.log(`[REACTION ROUTER] action=${action?.id || "-"} type=${action?.type || "-"} emoji=${normalized?.emoji || "-"} actor=${ownerMatched ? "owner" : "unknown"} result=${result}`)
}

async function notifyActionResult(sock, action, text) {
    const target = normalizeJid(action?.allowedActorJids?.[0]) || normalizeJid(action?.chatJid)
    if (!target || !sock?.sendMessage) return false
    await sock.sendMessage(target, { text })
    return true
}

async function executeClaimedAction(sock, claimedAction, normalized, context = {}) {
    if (claimedAction.selectedAction === "cancel") {
        const cancelled = cancelReactionAction(claimedAction.id, "cancelled_by_reaction")
        const message = claimedAction.type === "broadcast.create"
            ? "❌ Broadcast dibatalkan.\nTidak ada jadwal yang dibuat."
            : claimedAction.type === "reaction.test"
                ? "❌ Reaction test dibatalkan."
                : "❌ Reaction action dibatalkan."
        await notifyActionResult(sock, cancelled || claimedAction, message)
        reactionRouterTrace(claimedAction, normalized, "cancelled", true)
        return
    }

    const handler = actionHandlers.get(claimedAction.type)
    if (!handler) {
        const failed = markActionFailed(claimedAction.id, "Action handler belum tersedia.")
        await notifyActionResult(sock, failed || claimedAction, `❌ Action handler belum tersedia.\n\nAction: ${claimedAction.type}\nID: ${claimedAction.id}`)
        reactionRouterTrace(claimedAction, normalized, "failed", true)
        return
    }

    try {
        const result = await handler({
            sock,
            action: claimedAction,
            selectedEmoji: claimedAction.selectedEmoji,
            selectedAction: claimedAction.selectedAction,
            reactorJid: normalized.reactorJid,
            reactionUpdate: normalized,
            services: context.services || {},
        })

        if (result?.ok) {
            const completed = markActionCompleted(claimedAction.id, result)
            if (result.message) await notifyActionResult(sock, completed || claimedAction, result.message)
            reactionRouterTrace(completed || claimedAction, normalized, "completed", true)
            return
        }

        throw new Error(result?.message || "Reaction action gagal.")
    } catch (error) {
        const failed = markActionFailed(claimedAction.id, error)
        await notifyActionResult(sock, failed || claimedAction, [
            "❌ Reaction action gagal.",
            "",
            `Action: ${claimedAction.type}`,
            `ID: ${claimedAction.id}`,
            `Alasan: ${sanitizeError(error)}`,
        ].join("\n"))
        reactionRouterTrace(failed || claimedAction, normalized, "failed", true)
    }
}

async function handleNormalizedReaction(sock, normalized, context = {}) {
    if (!normalized || normalized.removed) return false
    if (!isWorkflowEnabled()) return false
    if (normalizeJid(normalized.targetKey?.remoteJid).endsWith("@g.us")) return false

    const action = findActionForTargetKey(normalized.targetKey)
    if (!action) {
        reactionDebug(normalized, null, false, "no-action")
        return false
    }

    reactionDebug(normalized, action, true, "matched")

    if (Date.now() > Number(action.expiresAt || 0)) {
        const expired = markActionExpired(action.id, true)
        if (expired && !action.expiredNotifiedAt) {
            await notifyActionResult(sock, expired, "⌛ Reaction action sudah kedaluwarsa.\nBuat control card baru untuk melanjutkan.")
        }
        reactionRouterTrace(action, normalized, "expired", false)
        return true
    }

    if (action.status !== "pending") {
        reactionRouterTrace(action, normalized, "ignored", false)
        return true
    }

    if (!action.emojiActions?.[normalized.emoji]) return false

    const ownerMatched = isAllowedActor(action, normalized.reactorJid, context)
    if (!ownerMatched) {
        console.log("[REACTION] Unauthorized reaction ignored.", {
            actionId: action.id,
            type: action.type,
            messageId: normalized.targetKey.id,
        })
        reactionRouterTrace(action, normalized, "unauthorized", false)
        return true
    }

    const claimed = claimReactionAction(action.id, normalized.reactorJid, normalized.emoji)
    if (!claimed) return true

    await executeClaimedAction(sock, claimed, normalized, context)
    return true
}

async function handleReactionUpdate(sock, update, context = {}) {
    try {
        const normalized = normalizeReactionUpdate(update)
        const items = Array.isArray(normalized) ? normalized : [normalized].filter(Boolean)
        let handled = false
        for (const item of items) {
            const result = await handleNormalizedReaction(sock, item, context)
            handled = handled || result
        }
        return handled
    } catch (error) {
        console.log("[REACTION] Handler error:", sanitizeError(error))
        return false
    }
}

function registerActionHandler(type, handler) {
    if (!type || typeof handler !== "function") return false
    actionHandlers.set(String(type), handler)
    return true
}

function unregisterActionHandler(type) {
    return actionHandlers.delete(String(type || ""))
}

function getExpiryText(expiresInMs) {
    const minutes = Math.max(1, Math.round(expiresInMs / 60000))
    return `${minutes} menit`
}

function formatEmojiActions(emojiActions = {}, labels = {}) {
    return Object.entries(emojiActions)
        .map(([emoji, action]) => `${emoji} ${labels[emoji] || action}`)
        .join("\n")
}

async function sendReactionActionCard(sock, options = {}) {
    const config = getConfig()
    const chatJid = normalizeJid(options.chatJid)
    if (!chatJid) return { ok: false, message: "chat JID tidak valid" }
    if (chatJid.endsWith("@g.us")) {
        return { ok: false, message: "control card grup tidak aktif" }
    }

    const expiresInMs = Math.max(60 * 1000, Number(options.expiresInMs || config.ttlMs) || config.ttlMs)
    const emojiActions = options.emojiActions || { "✅": "approve", "❌": "cancel" }
    const cardText = [
        String(options.text || "").trim(),
        "",
        "React:",
        formatEmojiActions(emojiActions, options.emojiActionLabels || {}),
        "",
        `Berlaku selama ${getExpiryText(expiresInMs)}.`,
    ].filter(Boolean).join("\n")

    const sendOptions = options.quoted ? { quoted: options.quoted } : undefined
    const sent = await sock.sendMessage(chatJid, { text: cardText }, sendOptions)
    const key = sent?.key || {}
    if (!key.id) return { ok: false, message: "message key tidak tersedia" }

    const action = createReactionAction({
        chatJid,
        messageKey: key,
        type: options.type,
        payload: options.payload || {},
        emojiActions,
        allowedActorJids: options.allowedActorJids || [],
        expiresInMs,
    })

    console.log("[REACTION] Action created.", {
        actionId: action.id,
        type: action.type,
        chatJid: action.chatJid,
    })

    return {
        ok: true,
        actionId: action.id,
        messageKey: key,
        action,
    }
}

function getActionCounts() {
    const counts = {
        pending: 0,
        processing: 0,
        completed: 0,
        cancelled: 0,
        expired: 0,
        failed: 0,
    }
    for (const action of Object.values(loadState().actions || {})) {
        counts[action.status] = (counts[action.status] || 0) + 1
    }
    return counts
}

function formatDurationRemaining(action) {
    if (!action?.expiresAt) return "-"
    const remaining = Number(action.expiresAt) - Date.now()
    if (remaining <= 0) return "expired"
    const minutes = Math.ceil(remaining / 60000)
    return `${minutes} menit lagi`
}

function getHelpText() {
    return [
        "⚡ REACTION CONTROL",
        "",
        ".reactionctl status",
        ".reactionctl on",
        ".reactionctl off",
        ".reactionctl list",
        ".reactionctl clear",
        ".reactionctl help",
        ".reactiontest",
        ".bcprepare template <nama> <target_jid> <tanggal> <jam>",
        ".bcaction <schedule_id>",
        ".healthreact",
    ].join("\n")
}

async function handleReactionControlCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    const lower = text.toLowerCase()
    const isCommand = /^(\.reactionctl|\.reactctl|\.reactiontest|\.reacttest|\.bcprepare|\.bcaction|\.healthreact)(?:\s|$)/i.test(text)
    if (!isCommand) return false

    if (context.isGroup) return true
    if (!context.isOwner) {
        await sock.sendMessage(context.from, { text: "Akses Ditolak" })
        return true
    }

    const ownerJid = normalizeJid(context.ownerJid || context.allowedActorJids?.[0] || context.from)
    const allowedActorJids = unique([ownerJid, ...(context.allowedActorJids || [])].map(normalizeJid))
    const services = context.services || {}

    if (lower === ".reactiontest" || lower === ".reacttest") {
        const result = await sendReactionActionCard(sock, {
            chatJid: context.from,
            type: "reaction.test",
            allowedActorJids,
            emojiActions: {
                "✅": "approve",
                "❌": "cancel",
            },
            emojiActionLabels: {
                "✅": "Jalankan test",
                "❌": "Batalkan test",
            },
            text: [
                "⚡ REACTION CONTROL TEST",
                "",
                "React pada pesan ini:",
                "",
                "Action: reaction.test",
            ].join("\n"),
        })
        if (!result.ok) await sock.sendMessage(context.from, { text: `Gagal membuat reaction test: ${result.message}` })
        return true
    }

    if (lower.startsWith(".healthreact")) {
        if (!services.healthCheck?.buildHealthText) {
            await sock.sendMessage(context.from, { text: "Health check service belum tersedia." })
            return true
        }

        const healthText = await services.healthCheck.buildHealthText({
            ...(services.healthContext || {}),
            bcscheduler: services.bcscheduler,
            broadcastSchedulerStatus: services.broadcastSchedulerStatus,
        })
        const result = await sendReactionActionCard(sock, {
            chatJid: context.from,
            type: "health.refresh",
            allowedActorJids,
            emojiActions: {
                "🔄": "refresh",
                "❌": "cancel",
            },
            emojiActionLabels: {
                "🔄": "Refresh",
                "❌": "Tutup",
            },
            text: [
                healthText,
                "",
                "Action: health.refresh",
            ].join("\n"),
        })
        if (!result.ok) await sock.sendMessage(context.from, { text: `Gagal membuat health reaction card: ${result.message}` })
        return true
    }

    if (lower.startsWith(".bcprepare ")) {
        if (!services.bctemplate?.getTemplate || !services.bcscheduler?.normalizeTargetJid) {
            await sock.sendMessage(context.from, { text: "Broadcast service belum tersedia." })
            return true
        }

        const match = text.match(/^\.bcprepare\s+template\s+(\S+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})$/i)
        if (!match) {
            await sock.sendMessage(context.from, { text: "Format: .bcprepare template <nama_template> <target_jid> <tanggal> <jam>" })
            return true
        }

        const [, templateName, targetInput, dateInput, timeInput] = match
        const templateText = services.bctemplate.getTemplate(templateName)
        const targetJid = services.bcscheduler.normalizeTargetJid(targetInput)
        const date = services.bcscheduler.normalizeDate(dateInput)
        const time = services.bcscheduler.normalizeTime(timeInput)
        if (!templateText || !targetJid || !date || !time) {
            await sock.sendMessage(context.from, { text: "Template, target, tanggal, atau jam tidak valid." })
            return true
        }

        const result = await sendReactionActionCard(sock, {
            chatJid: context.from,
            type: "broadcast.create",
            allowedActorJids,
            emojiActions: {
                "✅": "approve",
                "❌": "cancel",
            },
            emojiActionLabels: {
                "✅": "Jadwalkan",
                "❌": "Batalkan",
            },
            payload: {
                templateName,
                targetJid,
                date,
                time,
                timezone: services.bcscheduler.getTimezone(),
            },
            text: [
                "📤 BROADCAST PREVIEW",
                "",
                `Template: ${templateName}`,
                `Target: ${targetJid}`,
                `Waktu: ${date} ${time} (${services.bcscheduler.getTimezone()})`,
                "",
                "Isi:",
                templateText,
            ].join("\n"),
        })
        if (!result.ok) await sock.sendMessage(context.from, { text: `Gagal membuat preview broadcast: ${result.message}` })
        return true
    }

    if (lower.startsWith(".bcaction")) {
        if (!services.bcscheduler?.getFailedSchedules) {
            await sock.sendMessage(context.from, { text: "Broadcast scheduler service belum tersedia." })
            return true
        }

        const scheduleId = text.replace(/^\.bcaction\s*/i, "").trim()
        if (!scheduleId) {
            await sock.sendMessage(context.from, { text: "Format: .bcaction <schedule_id>" })
            return true
        }

        const schedule = services.bcscheduler.getFailedSchedules().find(item => item.id === scheduleId)
        if (!schedule) {
            await sock.sendMessage(context.from, { text: "Schedule failed tidak ditemukan." })
            return true
        }

        const result = await sendReactionActionCard(sock, {
            chatJid: context.from,
            type: "broadcast.retry",
            allowedActorJids,
            emojiActions: {
                "🔁": "retry",
                "❌": "cancel",
            },
            emojiActionLabels: {
                "🔁": "Retry",
                "❌": "Biarkan gagal",
            },
            payload: { scheduleId },
            text: [
                "🔁 BROADCAST FAILED ACTION",
                "",
                `Schedule ID: ${schedule.id}`,
                `Target: ${schedule.targetJid}`,
                `Attempts: ${schedule.attempts || 0}`,
                `Last Error: ${schedule.lastError || "-"}`,
            ].join("\n"),
        })
        if (!result.ok) await sock.sendMessage(context.from, { text: `Gagal membuat action retry: ${result.message}` })
        return true
    }

    if (lower === ".reactionctl" || lower === ".reactctl" || lower.endsWith(" help")) {
        await sock.sendMessage(context.from, { text: getHelpText() })
        return true
    }

    if (lower.endsWith(" on")) {
        setWorkflowEnabled(true)
        await sock.sendMessage(context.from, { text: "Reaction control diaktifkan." })
        return true
    }

    if (lower.endsWith(" off")) {
        setWorkflowEnabled(false)
        await sock.sendMessage(context.from, { text: "Reaction control dimatikan. Action pending tetap tersimpan." })
        return true
    }

    if (lower.endsWith(" status")) {
        cleanupExpiredActions()
        const counts = getActionCounts()
        const cfg = getConfig()
        await sock.sendMessage(context.from, {
            text: [
                "⚡ REACTION CONTROL",
                "",
                `Status: ${isWorkflowEnabled() ? "ON" : "OFF"}`,
                `Mode: ${cfg.ownerOnly ? "Owner-only" : "Custom actor"}`,
                `Pending Actions: ${counts.pending}`,
                `Completed Actions: ${counts.completed}`,
                `Expired Actions: ${counts.expired}`,
                `TTL: ${Math.round(cfg.ttlMs / 60000)} menit`,
                "Group Control Card: OFF (private-only)",
            ].join("\n"),
        })
        return true
    }

    if (lower.endsWith(" list")) {
        cleanupExpiredActions()
        const actions = listReactionActions({ limit: 20 })
        await sock.sendMessage(context.from, {
            text: actions.length
                ? `⚡ REACTION ACTIONS\n\n${actions.map((action, index) => `${index + 1}. ${action.id}\nType: ${action.type}\nStatus: ${action.status}${action.status === "pending" ? `\nExpires: ${formatDurationRemaining(action)}` : ""}`).join("\n\n")}`
                : "Belum ada reaction action.",
        })
        return true
    }

    if (lower.endsWith(" clear")) {
        cleanupExpiredActions({ clearTerminal: true })
        await sock.sendMessage(context.from, { text: "Riwayat action terminal dibersihkan. Pending aktif tetap disimpan." })
        return true
    }

    await sock.sendMessage(context.from, { text: getHelpText() })
    return true
}

function registerDefaultActionHandlers() {
    registerActionHandler("reaction.test", async ({ action }) => ({
        ok: true,
        message: [
            "✅ Reaction workflow berjalan normal.",
            "",
            "Actor: Owner",
            `Action ID: ${action.id}`,
            "Status: completed",
        ].join("\n"),
    }))

    registerActionHandler("broadcast.create", async ({ action, services }) => {
        if (!services.bctemplate?.getTemplate || !services.bcscheduler?.addSchedule) {
            return { ok: false, message: "Broadcast service belum tersedia.", errorCode: "BROADCAST_SERVICE_UNAVAILABLE" }
        }

        const payload = action.payload || {}
        const message = services.bctemplate.getTemplate(payload.templateName)
        if (!message) {
            return { ok: false, message: "Template tidak ditemukan.", errorCode: "TEMPLATE_NOT_FOUND" }
        }

        const schedule = services.bcscheduler.addSchedule({
            targetJid: payload.targetJid,
            date: payload.date,
            time: payload.time,
            timezone: payload.timezone || services.bcscheduler.getTimezone(),
            templateName: payload.templateName,
            message,
        })

        if (!schedule) {
            return { ok: false, message: "Broadcast gagal dijadwalkan.", errorCode: "SCHEDULE_CREATE_FAILED" }
        }

        return {
            ok: true,
            message: [
                "✅ BROADCAST DIJADWALKAN",
                "",
                `Schedule ID: ${schedule.id}`,
                `Target: ${schedule.targetJid}`,
                `Waktu: ${schedule.date || "harian"} ${schedule.time}`,
                `Template: ${payload.templateName}`,
            ].join("\n"),
            data: { scheduleId: schedule.id },
        }
    })

    registerActionHandler("broadcast.retry", async ({ action, services }) => {
        if (!services.bcscheduler?.getFailedSchedules || !services.bcscheduler?.resetFailed) {
            return { ok: false, message: "Broadcast scheduler service belum tersedia.", errorCode: "BROADCAST_SERVICE_UNAVAILABLE" }
        }

        const scheduleId = action.payload?.scheduleId
        const failed = services.bcscheduler.getFailedSchedules().find(item => item.id === scheduleId)
        if (!failed) {
            return { ok: false, message: "Schedule failed tidak ditemukan.", errorCode: "SCHEDULE_NOT_FAILED" }
        }

        const schedule = services.bcscheduler.resetFailed(scheduleId)
        if (!schedule) {
            return { ok: false, message: "Schedule gagal dikembalikan ke pending.", errorCode: "SCHEDULE_RETRY_FAILED" }
        }

        return {
            ok: true,
            message: `✅ Broadcast schedule ${schedule.id} dikembalikan ke pending.`,
            data: { scheduleId: schedule.id },
        }
    })

    registerActionHandler("health.refresh", async ({ sock, action, services }) => {
        if (!services.healthCheck?.buildHealthText) {
            return { ok: false, message: "Health check service belum tersedia.", errorCode: "HEALTH_SERVICE_UNAVAILABLE" }
        }

        const text = await services.healthCheck.buildHealthText({
            ...(services.healthContext || {}),
            bcscheduler: services.bcscheduler,
            broadcastSchedulerStatus: services.broadcastSchedulerStatus,
        })
        await sock.sendMessage(action.chatJid, { text })
        return {
            ok: true,
            message: "✅ Health refresh dikirim.",
        }
    })
}

function startCleanupTimer() {
    if (cleanupTimer) return
    cleanupTimer = setInterval(() => {
        try {
            cleanupExpiredActions()
        } catch (error) {
            console.log("[REACTION] Cleanup error:", sanitizeError(error))
        }
    }, getConfig().cleanupIntervalMs)
    if (typeof cleanupTimer.unref === "function") cleanupTimer.unref()
}

function stopCleanupTimer() {
    if (!cleanupTimer) return
    clearInterval(cleanupTimer)
    cleanupTimer = null
}

function installReactionWorkflow(sock, options = {}) {
    if (!sock?.ev || installedSockets.has(sock)) return false
    registerDefaultActionHandlers()

    const context = {
        ...options,
        services: {
            ...(options.services || {}),
            bcscheduler: options.bcscheduler || options.services?.bcscheduler,
            bctemplate: options.bctemplate || options.services?.bctemplate,
            mediaCleanupManager: options.mediaCleanupManager || options.services?.mediaCleanupManager,
            healthCheck: options.healthCheck || options.services?.healthCheck,
            groupRemoteControl: options.groupRemoteControl || options.services?.groupRemoteControl,
            broadcastSchedulerStatus: options.broadcastSchedulerStatus || options.services?.broadcastSchedulerStatus,
            healthContext: options.healthContext || options.services?.healthContext,
        },
    }

    const listener = update => {
        handleReactionUpdate(sock, update, context).catch(error => {
            console.log("[REACTION] Event error:", sanitizeError(error))
        })
    }

    sock.ev.on("messages.reaction", listener)
    installedSockets.set(sock, listener)
    startCleanupTimer()
    return true
}

function disposeReactionWorkflow(sock) {
    const listener = sock ? installedSockets.get(sock) : null
    if (sock?.ev && listener && typeof sock.ev.off === "function") {
        try {
            sock.ev.off("messages.reaction", listener)
        } catch {}
    }
    if (sock) installedSockets.delete(sock)
    stopCleanupTimer()
    try {
        cleanupExpiredActions()
    } catch {}
    return true
}

module.exports = {
    installReactionWorkflow,
    disposeReactionWorkflow,
    handleReactionUpdate,
    createReactionAction,
    sendReactionActionCard,
    registerActionHandler,
    unregisterActionHandler,
    getReactionAction,
    listReactionActions,
    cancelReactionAction,
    cleanupExpiredActions,
    handleReactionControlCommand,
    normalizeReactionUpdate,
    loadState,
    saveState,
    claimReactionAction,
}
