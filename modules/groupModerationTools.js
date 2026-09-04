"use strict"

const common = require("./groupUtilityCommon")
const defaultStore = require("./groupUtilityStore")

const FEATURE_NAME = "groupModeration"
const DEFAULT_WARN_MAX = 3
const MAX_WARN_LIMIT = 20
const COMMAND_PATTERN = /^(?:\.warn|\.warning|\.listwarn|\.warnlist|\.resetwarn|\.warnreset|\.warnmax|\.warnautokick)(?:\s|$)/i
const MAX_EVENT_RECORDS = 500

function isModerationCommand(text) {
    return COMMAND_PATTERN.test(String(text || "").trim())
}

function normalizeModeration(value = {}) {
    const warnMax = Number(value.warnMax)
    return {
        ...value,
        warnMax: Number.isInteger(warnMax) && warnMax >= 1 && warnMax <= MAX_WARN_LIMIT ? warnMax : DEFAULT_WARN_MAX,
        autoKickOnMaxWarn: value.autoKickOnMaxWarn === true,
        warnings: value.warnings && typeof value.warnings === "object" ? value.warnings : {},
        processedEvents: value.processedEvents && typeof value.processedEvents === "object" ? value.processedEvents : {},
        kickedTargets: value.kickedTargets && typeof value.kickedTargets === "object" ? value.kickedTargets : {},
    }
}

function updateModeration(store, groupJid, mutator) {
    return store.updateGroup(groupJid, group => {
        const moderation = normalizeModeration(group.moderation)
        const next = mutator(moderation) || moderation
        return { ...group, moderation: next }
    })
}

function eventKey(msg) {
    const id = String(msg?.key?.id || "").trim()
    return id ? `${String(msg?.key?.remoteJid || "").toLowerCase()}:${id}` : ""
}

function trimEventRecords(records = {}) {
    const entries = Object.entries(records).sort((a, b) => Number(a[1]?.at || 0) - Number(b[1]?.at || 0))
    while (entries.length > MAX_EVENT_RECORDS) entries.shift()
    return Object.fromEntries(entries)
}

function getTarget(store, access, msg, context) {
    const resolved = common.resolveTargetParticipant(access.policy.metadata, msg, context)
    if (!resolved) return { ok: false, reason: "Reply atau mention anggota target." }
    if (common.isProtectedParticipant(resolved.participant, context.sock, context)) {
        return { ok: false, reason: "Admin grup, owner grup, owner bot, dan akun bot tidak dapat diberi warning." }
    }
    return { ok: true, ...resolved }
}

function formatTargetLabel(target) {
    return `@${String(target?.jid || target?.mutationJid || "anggota").split("@")[0].split(":")[0]}`
}

function getFreshMetadataResolver(sock) {
    return async groupJid => {
        if (typeof sock?.__resolveGroupMetadataForRuntimePolicy === "function") {
            return sock.__resolveGroupMetadataForRuntimePolicy(groupJid, { forceRefresh: true })
        }
        return sock?.groupMetadata?.(groupJid)
    }
}

async function handleWarn(sock, msg, access, argument, context, store) {
    context.sock = sock
    const target = getTarget(store, access, msg, context)
    if (!target.ok) {
        await sock.sendMessage(access.groupJid, { text: target.reason }, { quoted: msg })
        return true
    }
    const duplicateKey = eventKey(msg)
    const existing = normalizeModeration(store.getGroup(access.groupJid)?.moderation)
    if (duplicateKey && existing.processedEvents[duplicateKey]) return true

    const reason = String(argument || "").trim() || "Tidak ada alasan"
    const createdAt = new Date().toISOString()
    const record = {
        jid: target.jid || target.mutationJid,
        reason: reason.slice(0, 500),
        by: access.senderJid,
        createdAt,
    }
    let nextModeration = null
    updateModeration(store, access.groupJid, moderation => {
        const currentWarnings = Array.isArray(moderation.warnings[target.key]) ? moderation.warnings[target.key] : []
        const processedEvents = {
            ...moderation.processedEvents,
            ...(duplicateKey ? { [duplicateKey]: { at: Date.now(), target: target.key } } : {}),
        }
        nextModeration = {
            ...moderation,
            warnings: { ...moderation.warnings, [target.key]: [...currentWarnings, record] },
            processedEvents: trimEventRecords(processedEvents),
        }
        return nextModeration
    })

    const count = nextModeration.warnings[target.key].length
    let kicked = false
    if (
        nextModeration.autoKickOnMaxWarn
        && count >= nextModeration.warnMax
        && !nextModeration.kickedTargets[target.key]
    ) {
        const currentPolicy = await common.resolveFeaturePolicy(sock, access.groupJid, FEATURE_NAME, context, {
            getGroupMetadata: getFreshMetadataResolver(sock),
        })
        const currentParticipant = common.findParticipant(currentPolicy.metadata, common.getParticipantCandidates(target.participant), context)
        if (currentPolicy.allowed && currentParticipant && !common.isProtectedParticipant(currentParticipant, sock, context)) {
            const mutationJid = common.getPreferredJid(currentParticipant, context, { forMutation: true })
            try {
                await sock.groupParticipantsUpdate(access.groupJid, [mutationJid], "remove")
                updateModeration(store, access.groupJid, moderation => ({
                    ...moderation,
                    kickedTargets: { ...moderation.kickedTargets, [target.key]: { at: Date.now(), eventId: duplicateKey } },
                }))
                kicked = true
            } catch (error) {
                console.log(`[GROUP MODERATION] Auto-kick gagal ${access.groupJid}: ${String(error?.message || error).slice(0, 180)}`)
            }
        }
    }

    await sock.sendMessage(access.groupJid, {
        text: [
            `${formatTargetLabel(target)} mendapat warning ${count}/${nextModeration.warnMax}.`,
            `Alasan: ${record.reason}`,
            kicked ? "Batas tercapai: anggota dikeluarkan." : (count >= nextModeration.warnMax && !nextModeration.autoKickOnMaxWarn ? "Batas tercapai, auto-kick masih OFF." : ""),
        ].filter(Boolean).join("\n"),
        mentions: [target.jid].filter(Boolean),
    }, { quoted: msg })
    return true
}

async function handleListWarn(sock, msg, access, context, store) {
    const moderation = normalizeModeration(store.getGroup(access.groupJid)?.moderation)
    const optionalTarget = common.resolveTargetParticipant(access.policy.metadata, msg, context)
    const entries = optionalTarget
        ? [[optionalTarget.key, moderation.warnings[optionalTarget.key] || []]]
        : Object.entries(moderation.warnings)
    const lines = ["DAFTAR WARNING", ""]
    const mentions = []
    let total = 0
    for (const [, warnings] of entries) {
        if (!Array.isArray(warnings) || !warnings.length) continue
        total += warnings.length
        const jid = warnings[0]?.jid || ""
        if (jid) mentions.push(jid)
        lines.push(`${jid ? `@${jid.split("@")[0]}` : "Anggota"}: ${warnings.length}/${moderation.warnMax}`)
        warnings.slice(-10).forEach((warning, index) => lines.push(`  ${index + 1}. ${warning.reason} (${warning.createdAt})`))
    }
    if (!total) lines.push("Belum ada warning aktif.")
    await sock.sendMessage(access.groupJid, { text: lines.join("\n"), mentions: common.unique(mentions) }, { quoted: msg })
    return true
}

async function handleResetWarn(sock, msg, access, context, store) {
    const target = common.resolveTargetParticipant(access.policy.metadata, msg, context)
    if (!target) {
        await sock.sendMessage(access.groupJid, { text: "Reply atau mention anggota yang warning-nya ingin direset." }, { quoted: msg })
        return true
    }
    updateModeration(store, access.groupJid, moderation => {
        const warnings = { ...moderation.warnings }
        const kickedTargets = { ...moderation.kickedTargets }
        delete warnings[target.key]
        delete kickedTargets[target.key]
        return { ...moderation, warnings, kickedTargets }
    })
    await sock.sendMessage(access.groupJid, {
        text: `Warning @${target.jid.split("@")[0]} berhasil direset.`,
        mentions: [target.jid],
    }, { quoted: msg })
    return true
}

async function handleWarnMax(sock, msg, access, argument, store) {
    const moderation = normalizeModeration(store.getGroup(access.groupJid)?.moderation)
    if (!argument.trim() || /^status$/i.test(argument.trim())) {
        await sock.sendMessage(access.groupJid, { text: `Batas warning saat ini: ${moderation.warnMax}.` }, { quoted: msg })
        return true
    }
    const value = Number(argument.trim())
    if (!Number.isInteger(value) || value < 1 || value > MAX_WARN_LIMIT) {
        await sock.sendMessage(access.groupJid, { text: `Batas warning harus 1 sampai ${MAX_WARN_LIMIT}.` }, { quoted: msg })
        return true
    }
    updateModeration(store, access.groupJid, current => ({ ...current, warnMax: value }))
    await sock.sendMessage(access.groupJid, { text: `Batas warning diubah menjadi ${value}.` }, { quoted: msg })
    return true
}

async function handleAutoKick(sock, msg, access, argument, store) {
    const moderation = normalizeModeration(store.getGroup(access.groupJid)?.moderation)
    const action = String(argument || "status").trim().toLowerCase()
    if (action === "status" || !action) {
        await sock.sendMessage(access.groupJid, { text: `Auto-kick saat warning maksimum: ${moderation.autoKickOnMaxWarn ? "ON" : "OFF"}.` }, { quoted: msg })
        return true
    }
    if (!/^(on|off)$/.test(action)) {
        await sock.sendMessage(access.groupJid, { text: "Format: .warnautokick status/on/off" }, { quoted: msg })
        return true
    }
    updateModeration(store, access.groupJid, current => ({ ...current, autoKickOnMaxWarn: action === "on" }))
    await sock.sendMessage(access.groupJid, { text: `Auto-kick warning: ${action.toUpperCase()}.` }, { quoted: msg })
    return true
}

async function handleGroupModerationCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    if (!isModerationCommand(text)) return false
    const command = text.split(/\s+/)[0].toLowerCase()
    const argument = text.slice(command.length).trim()
    const access = await common.resolveCommandAccess(sock, msg, FEATURE_NAME, context)
    if (access.hardDenied) return true
    if (!access.allowed) {
        await sock.sendMessage(access.groupJid, { text: "Perintah moderasi hanya untuk admin grup atau owner bot." }, { quoted: msg })
        return true
    }
    const store = context.store || defaultStore
    if ([".warn", ".warning"].includes(command)) return handleWarn(sock, msg, access, argument, { ...context }, store)
    if ([".listwarn", ".warnlist"].includes(command)) return handleListWarn(sock, msg, access, context, store)
    if ([".resetwarn", ".warnreset"].includes(command)) return handleResetWarn(sock, msg, access, context, store)
    if (command === ".warnmax") return handleWarnMax(sock, msg, access, argument, store)
    if (command === ".warnautokick") return handleAutoKick(sock, msg, access, argument, store)
    return false
}

module.exports = {
    DEFAULT_WARN_MAX,
    FEATURE_NAME,
    MAX_WARN_LIMIT,
    eventKey,
    handleGroupModerationCommand,
    isModerationCommand,
    normalizeModeration,
}
