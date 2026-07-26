"use strict"

const fs = require("fs")
const path = require("path")

const DATA_FILE = process.env.GROUP_WELCOME_DATA_FILE
    ? path.resolve(process.env.GROUP_WELCOME_DATA_FILE)
    : path.join(__dirname, "..", "data", "groupWelcome.json")

const DEFAULT_TEMPLATE = [
    "👋 *SELAMAT DATANG*",
    "",
    "Halo {users}, selamat datang di *{group}*!",
    "",
    "Silakan baca peraturan dan jaga kenyamanan bersama.",
    "Jumlah anggota sekarang: *{member_count}*",
].join("\n")

const DEFAULT_STATE = Object.freeze({
    version: 1,
    groups: {},
})

const EVENT_DEDUPE_TTL_MS = 10 * 60 * 1000
const EVENT_DELAY_MS = Math.max(0, Number(process.env.GROUP_WELCOME_EVENT_DELAY_MS || 1200))
const recentEvents = new Map()
let stateCache = null

function normalizeJid(value) {
    return String(value || "").trim().toLowerCase()
}

function isGroupJid(value) {
    return normalizeJid(value).endsWith("@g.us")
}

function jidUser(value) {
    return normalizeJid(value).split("@")[0].split(":")[0]
}

function unique(items) {
    return [...new Set((items || []).map(normalizeJid).filter(Boolean))]
}

function readState() {
    if (stateCache) return stateCache
    try {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
        stateCache = {
            version: Number(parsed?.version || 1),
            groups: parsed?.groups && typeof parsed.groups === "object" ? parsed.groups : {},
        }
    } catch {
        stateCache = { version: DEFAULT_STATE.version, groups: {} }
    }
    return stateCache
}

function saveState(next = stateCache || DEFAULT_STATE) {
    const normalized = {
        version: Number(next?.version || 1),
        groups: next?.groups && typeof next.groups === "object" ? next.groups : {},
    }
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
    const temp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
    fs.renameSync(temp, DATA_FILE)
    stateCache = normalized
    return normalized
}

function getGroupConfig(groupJid) {
    const jid = normalizeJid(groupJid)
    const raw = readState().groups[jid]
    return {
        template: String(raw?.template || DEFAULT_TEMPLATE),
        updatedAt: raw?.updatedAt || null,
        updatedBy: raw?.updatedBy || null,
        custom: Boolean(raw?.template),
    }
}

function updateGroupConfig(groupJid, patch, updatedBy = "admin") {
    const jid = normalizeJid(groupJid)
    if (!isGroupJid(jid)) return null
    const state = readState()
    const current = state.groups[jid] && typeof state.groups[jid] === "object" ? state.groups[jid] : {}
    state.groups[jid] = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
        updatedBy: normalizeJid(updatedBy) || String(updatedBy || "admin"),
    }
    saveState(state)
    return getGroupConfig(jid)
}

function resetGroupConfig(groupJid) {
    const jid = normalizeJid(groupJid)
    const state = readState()
    if (!Object.prototype.hasOwnProperty.call(state.groups, jid)) return false
    delete state.groups[jid]
    saveState(state)
    return true
}

function unwrapMessage(message) {
    let current = message || {}
    for (let i = 0; i < 8; i += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message
        else break
    }
    return current || {}
}

function findCommandId(value, depth = 0) {
    if (depth > 5 || value == null) return ""
    if (typeof value === "string") {
        const clean = value.trim()
        if (clean.startsWith(".")) return clean
        try {
            return findCommandId(JSON.parse(clean), depth + 1)
        } catch {
            return ""
        }
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findCommandId(item, depth + 1)
            if (found) return found
        }
        return ""
    }
    if (typeof value === "object") {
        const preferredKeys = [
            "id",
            "selectedId",
            "selectedRowId",
            "rowId",
            "buttonId",
            "command",
            "value",
        ]
        for (const key of preferredKeys) {
            const found = findCommandId(value[key], depth + 1)
            if (found) return found
        }
        for (const item of Object.values(value)) {
            const found = findCommandId(item, depth + 1)
            if (found) return found
        }
    }
    return ""
}

function extractInteractiveSelection(messageOrMsg) {
    const source = messageOrMsg?.message ? messageOrMsg.message : messageOrMsg
    const message = unwrapMessage(source)
    const direct = [
        message.buttonsResponseMessage?.selectedButtonId,
        message.listResponseMessage?.singleSelectReply?.selectedRowId,
        message.templateButtonReplyMessage?.selectedId,
        message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson,
    ]
    for (const value of direct) {
        const found = findCommandId(value)
        if (found) return found
    }
    return ""
}

function normalizeParticipantCandidates(participant) {
    if (!participant) return []
    if (typeof participant === "string") return [normalizeJid(participant)]
    return unique([
        participant.id,
        participant.jid,
        participant.lid,
        participant.phoneNumber,
        participant.pn,
    ])
}

function participantMatches(participant, candidates = []) {
    const candidateUsers = new Set(unique(candidates).map(jidUser).filter(Boolean))
    return normalizeParticipantCandidates(participant).some(value => candidateUsers.has(jidUser(value)))
}

function isAdminParticipant(participant) {
    return ["admin", "superadmin"].includes(String(participant?.admin || "").toLowerCase())
}

function getBotIdentityCandidates(sock) {
    return unique([
        sock?.user?.id,
        sock?.user?.lid,
        sock?.user?.jid,
        sock?.authState?.creds?.me?.id,
        sock?.authState?.creds?.me?.lid,
    ])
}

function getBotParticipant(metadata, sock) {
    const identities = getBotIdentityCandidates(sock)
    return (metadata?.participants || []).find(participant => participantMatches(participant, identities)) || null
}

function isBotAdmin(metadata, sock) {
    return isAdminParticipant(getBotParticipant(metadata, sock))
}

function getSenderParticipant(metadata, senderJid) {
    return (metadata?.participants || []).find(participant => participantMatches(participant, [senderJid])) || null
}

function isSenderAdmin(metadata, senderJid) {
    return isAdminParticipant(getSenderParticipant(metadata, senderJid))
}

function resolveMentionJids(metadata, participants) {
    const result = []
    for (const jid of unique(participants)) {
        const match = (metadata?.participants || []).find(item => participantMatches(item, [jid]))
        const preferred = normalizeParticipantCandidates(match).find(value => value.endsWith("@s.whatsapp.net"))
            || normalizeParticipantCandidates(match)[0]
            || jid
        if (preferred) result.push(preferred)
    }
    return unique(result)
}

function mentionLabel(jid) {
    return `@${jidUser(jid) || "anggota"}`
}

function renderTemplate(template, values = {}) {
    const users = Array.isArray(values.users)
        ? values.users.map(mentionLabel).join(", ")
        : String(values.users || "anggota")
    return String(template || DEFAULT_TEMPLATE)
        .replace(/\{user\}/gi, users)
        .replace(/\{users\}/gi, users)
        .replace(/\{group\}/gi, String(values.group || "grup ini"))
        .replace(/\{member_count\}/gi, String(values.memberCount ?? values.member_count ?? "-"))
}

function buildMenuSections() {
    return [
        {
            title: "Informasi Grup",
            rows: [
                { header: "INFO", title: "Informasi Grup", description: "Nama, jumlah anggota, dan status bot", id: ".groupinfo" },
                { header: "ATURAN", title: "Peraturan Grup", description: "Lihat deskripsi atau peraturan grup", id: ".rules" },
                { header: "ADMIN", title: "Daftar Admin", description: "Lihat admin grup", id: ".adminlist" },
            ],
        },
        {
            title: "Fitur Bot",
            rows: [
                { header: "STATUS", title: "Status Fitur Grup", description: "Lihat fitur bot yang aktif", id: ".fiturgrup" },
                { header: "BANTUAN", title: "Help Menu", description: "Lihat daftar command bot", id: ".help" },
            ],
        },
    ]
}

function buildFallbackMenuText(bodyText = "") {
    return [
        bodyText,
        "",
        "☰ *MENU GRUP*",
        "1. `.groupinfo` — informasi grup",
        "2. `.rules` — peraturan grup",
        "3. `.adminlist` — daftar admin",
        "4. `.fiturgrup` — status fitur grup",
        "5. `.help` — daftar command bot",
    ].filter(Boolean).join("\n")
}

async function sendNativeFlowMenu(sock, groupJid, options = {}) {
    const { generateWAMessageFromContent, proto } = require("@whiskeysockets/baileys")
    if (typeof generateWAMessageFromContent !== "function" || !proto?.Message?.InteractiveMessage) {
        throw new Error("Baileys InteractiveMessage tidak tersedia")
    }

    const title = String(options.title || "☰ MENU GRUP")
    const bodyText = String(options.bodyText || "Tekan tombol di bawah untuk membuka menu.")
    const footer = String(options.footer || "Pilih menu yang ingin digunakan")
    const mentionedJid = unique(options.mentionedJid)
    const sections = options.sections || buildMenuSections()
    const interactiveMessage = proto.Message.InteractiveMessage.create({
        contextInfo: mentionedJid.length ? { mentionedJid } : undefined,
        body: proto.Message.InteractiveMessage.Body.create({ text: bodyText }),
        footer: proto.Message.InteractiveMessage.Footer.create({ text: footer }),
        header: proto.Message.InteractiveMessage.Header.create({
            title,
            hasMediaAttachment: false,
        }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: [
                proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton?.create
                    ? proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton.create({
                        name: "single_select",
                        buttonParamsJson: JSON.stringify({
                            title: "☰ BUKA MENU",
                            sections,
                        }),
                    })
                    : {
                        name: "single_select",
                        buttonParamsJson: JSON.stringify({
                            title: "☰ BUKA MENU",
                            sections,
                        }),
                    },
            ],
            messageParamsJson: "{}",
            messageVersion: 1,
        }),
    })

    const content = {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    deviceListMetadata: {},
                    deviceListMetadataVersion: 2,
                },
                interactiveMessage,
            },
        },
    }
    const generated = generateWAMessageFromContent(groupJid, content, {
        userJid: sock?.user?.id,
    })
    await sock.relayMessage(groupJid, generated.message, { messageId: generated.key.id })
    return generated
}

async function sendLegacyListMenu(sock, groupJid, options = {}) {
    const sections = (options.sections || buildMenuSections()).map(section => ({
        title: section.title,
        rows: (section.rows || []).map(row => ({
            title: row.title,
            description: row.description,
            rowId: row.id || row.rowId,
        })),
    }))
    return sock.sendMessage(groupJid, {
        title: String(options.title || "☰ MENU GRUP"),
        text: String(options.bodyText || "Tekan tombol di bawah untuk membuka menu."),
        footer: String(options.footer || "Pilih menu yang ingin digunakan"),
        buttonText: "☰ BUKA MENU",
        sections,
        mentions: unique(options.mentionedJid),
    })
}

async function sendInteractiveMenu(sock, groupJid, options = {}) {
    if (options.disableInteractive !== true) {
        try {
            await sendNativeFlowMenu(sock, groupJid, options)
            return { sent: true, mode: "native-flow" }
        } catch (error) {
            console.log("[GROUP MENU] Native Flow gagal, coba ListMessage", {
                groupJid,
                error: String(error?.message || error).slice(0, 240),
            })
        }

        try {
            await sendLegacyListMenu(sock, groupJid, options)
            return { sent: true, mode: "list-message" }
        } catch (error) {
            console.log("[GROUP MENU] ListMessage gagal, pakai fallback teks", {
                groupJid,
                error: String(error?.message || error).slice(0, 240),
            })
        }
    }

    await sock.sendMessage(groupJid, {
        text: buildFallbackMenuText(options.bodyText),
        mentions: unique(options.mentionedJid),
    })
    return { sent: true, mode: "text-fallback" }
}

function pruneRecentEvents(now = Date.now()) {
    for (const [key, timestamp] of recentEvents) {
        if (now - timestamp > EVENT_DEDUPE_TTL_MS) recentEvents.delete(key)
    }
}

function makeEventKey(update) {
    return [
        normalizeJid(update?.id),
        String(update?.action || "").toLowerCase(),
        unique(update?.participants).sort().join(","),
    ].join("|")
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function handleParticipantUpdate(sock, update = {}, context = {}) {
    const groupJid = normalizeJid(update?.id)
    const action = String(update?.action || "").toLowerCase()
    if (!isGroupJid(groupJid) || action !== "add") return { handled: false, reason: "not-add" }

    const groupRemoteControl = context.groupRemoteControl
    if (groupRemoteControl?.isGroupBotEnabled && !groupRemoteControl.isGroupBotEnabled(groupJid)) {
        return { handled: false, reason: "group-bot-off" }
    }
    if (groupRemoteControl?.isGroupFeatureEnabled && !groupRemoteControl.isGroupFeatureEnabled(groupJid, "welcome")) {
        return { handled: false, reason: "welcome-off" }
    }

    pruneRecentEvents()
    const eventKey = makeEventKey(update)
    if (context.skipDedupe !== true) {
        if (recentEvents.has(eventKey)) return { handled: false, reason: "duplicate" }
        recentEvents.set(eventKey, Date.now())
    }

    if (EVENT_DELAY_MS > 0 && context.skipDelay !== true) await delay(EVENT_DELAY_MS)

    let metadata
    try {
        metadata = await sock.groupMetadata(groupJid)
    } catch (error) {
        console.log("[GROUP WELCOME] Gagal membaca metadata", {
            groupJid,
            error: String(error?.message || error).slice(0, 240),
        })
        return { handled: false, reason: "metadata-error" }
    }

    if (!isBotAdmin(metadata, sock)) {
        console.log("[GROUP WELCOME] Skip karena bot bukan admin", { groupJid })
        return { handled: false, reason: "bot-not-admin" }
    }

    const botUsers = new Set(getBotIdentityCandidates(sock).map(jidUser).filter(Boolean))
    const participants = unique(update?.participants).filter(jid => !botUsers.has(jidUser(jid)))
    if (!participants.length) return { handled: false, reason: "only-bot-added" }

    const mentionedJid = resolveMentionJids(metadata, participants).slice(0, 25)
    const config = getGroupConfig(groupJid)
    const bodyText = renderTemplate(config.template, {
        users: mentionedJid,
        group: metadata?.subject || "grup ini",
        memberCount: Array.isArray(metadata?.participants) ? metadata.participants.length : "-",
    })
    const menuEnabled = !groupRemoteControl?.isGroupFeatureEnabled
        || groupRemoteControl.isGroupFeatureEnabled(groupJid, "groupMenu")

    if (menuEnabled) {
        const sent = await sendInteractiveMenu(sock, groupJid, {
            title: "👋 MEMBER BARU",
            bodyText,
            footer: "Selamat bergabung — tekan tombol untuk membuka menu grup",
            mentionedJid,
            disableInteractive: context.disableInteractive,
        })
        return { handled: true, reason: "welcome-sent", mode: sent.mode, participants: mentionedJid }
    }

    await sock.sendMessage(groupJid, { text: bodyText, mentions: mentionedJid })
    return { handled: true, reason: "welcome-sent", mode: "text", participants: mentionedJid }
}

function installGroupWelcome(sock, context = {}) {
    if (!sock?.ev || sock.__groupWelcomeInstalled) return false
    const listener = update => {
        void handleParticipantUpdate(sock, update, context).catch(error => {
            console.log("[GROUP WELCOME] Handler error", {
                groupJid: update?.id,
                error: String(error?.message || error).slice(0, 300),
            })
        })
    }
    sock.ev.on("group-participants.update", listener)
    sock.__groupWelcomeInstalled = true
    sock.__groupWelcomeListener = listener
    console.log("[GROUP WELCOME] Admin-only welcome + interactive menu aktif")
    return true
}

async function requireGroupAdmin(sock, groupJid, senderJid, canControlOwner) {
    if (canControlOwner) return { allowed: true, metadata: await sock.groupMetadata(groupJid).catch(() => null) }
    const metadata = await sock.groupMetadata(groupJid).catch(() => null)
    return { allowed: Boolean(metadata && isSenderAdmin(metadata, senderJid)), metadata }
}

function formatFeatureStatus(groupJid, groupRemoteControl, botAdmin) {
    const effective = groupRemoteControl?.getEffectiveGroupConfig?.(groupJid)
    const feature = name => !groupRemoteControl?.isGroupFeatureEnabled
        || groupRemoteControl.isGroupFeatureEnabled(groupJid, name)
    return [
        "👥 *STATUS FITUR GRUP*",
        "",
        `Bot Grup: ${effective?.botEnabled === false ? "OFF" : "ON"}`,
        `Bot Admin: ${botAdmin ? "YA" : "TIDAK"}`,
        `Welcome: ${feature("welcome") ? "ON" : "OFF"}`,
        `Menu Interaktif: ${feature("groupMenu") ? "ON" : "OFF"}`,
        `Anti Kasar: ${feature("antiToxic") ? "ON" : "OFF"}`,
        `Sticker Safety: ${feature("stickerSafety") ? "ON" : "OFF"}`,
        `Downloader Command: ${feature("downloader") ? "ON" : "OFF"}`,
    ].join("\n")
}

function welcomeHelp() {
    return [
        "👋 *WELCOME & MENU GRUP*",
        "",
        ".welcome status",
        ".welcome on/off",
        ".welcome menu on/off",
        ".welcome set <pesan>",
        ".welcome reset",
        ".welcome test",
        ".groupmenu atau .menu",
        "",
        "Placeholder pesan:",
        "{user} / {users}",
        "{group}",
        "{member_count}",
        "",
        "Welcome hanya dikirim bila bot berstatus admin di grup.",
    ].join("\n")
}

async function handleGroupWelcomeCommand(sock, msg, context = {}) {
    const groupJid = normalizeJid(context.from || msg?.key?.remoteJid)
    if (!isGroupJid(groupJid)) return false

    const text = String(context.text || extractInteractiveSelection(msg) || "").trim()
    const lower = text.toLowerCase()
    const commands = [".welcome", ".groupmenu", ".menu", ".groupinfo", ".rules", ".adminlist", ".fiturgrup"]
    if (!commands.some(command => lower === command || lower.startsWith(`${command} `))) return false

    const groupRemoteControl = context.groupRemoteControl
    const senderJid = normalizeJid(context.senderJid || context.sender || msg?.key?.participant)
    const canControlOwner = Boolean(context.canControlOwner || context.isOwner)

    if (lower === ".menu" || lower === ".groupmenu") {
        if (groupRemoteControl?.isGroupFeatureEnabled && !groupRemoteControl.isGroupFeatureEnabled(groupJid, "groupMenu")) {
            await sock.sendMessage(groupJid, { text: "Menu interaktif sedang dinonaktifkan untuk grup ini." })
            return true
        }
        await sendInteractiveMenu(sock, groupJid, {
            title: "☰ MENU GRUP",
            bodyText: "Pilih menu yang ingin dibuka.",
        })
        return true
    }

    let metadata = null
    if (lower === ".groupinfo" || lower === ".rules" || lower === ".adminlist" || lower === ".fiturgrup") {
        metadata = await sock.groupMetadata(groupJid).catch(() => null)
    }

    if (lower === ".groupinfo") {
        const admins = (metadata?.participants || []).filter(isAdminParticipant)
        await sock.sendMessage(groupJid, {
            text: [
                "ℹ️ *INFORMASI GRUP*",
                "",
                `Nama: ${metadata?.subject || "-"}`,
                `Anggota: ${metadata?.participants?.length ?? "-"}`,
                `Admin: ${admins.length}`,
                `Bot Admin: ${metadata && isBotAdmin(metadata, sock) ? "YA" : "TIDAK"}`,
                `ID: ${groupJid}`,
            ].join("\n"),
        })
        return true
    }

    if (lower === ".rules") {
        const description = String(metadata?.desc || "").trim()
        await sock.sendMessage(groupJid, {
            text: description
                ? `📜 *PERATURAN / DESKRIPSI GRUP*\n\n${description}`
                : "📜 *PERATURAN GRUP*\n\nBelum ada deskripsi atau peraturan grup yang diatur.",
        })
        return true
    }

    if (lower === ".adminlist") {
        const admins = (metadata?.participants || []).filter(isAdminParticipant)
        const mentions = admins.map(item => normalizeParticipantCandidates(item)[0]).filter(Boolean)
        const lines = admins.map((item, index) => `${index + 1}. ${mentionLabel(normalizeParticipantCandidates(item)[0])}${String(item.admin).toLowerCase() === "superadmin" ? " (owner)" : ""}`)
        await sock.sendMessage(groupJid, {
            text: lines.length ? `👮 *ADMIN GRUP*\n\n${lines.join("\n")}` : "Admin grup tidak dapat dibaca.",
            mentions,
        })
        return true
    }

    if (lower === ".fiturgrup") {
        await sock.sendMessage(groupJid, {
            text: formatFeatureStatus(groupJid, groupRemoteControl, Boolean(metadata && isBotAdmin(metadata, sock))),
        })
        return true
    }

    const parsed = lower.match(/^\.welcome(?:\s+([a-z]+))?(?:\s+([\s\S]*))?$/i)
    if (!parsed) return false
    const action = String(parsed[1] || "help").toLowerCase()
    const argument = String(parsed[2] || "").trim()

    const permission = await requireGroupAdmin(sock, groupJid, senderJid, canControlOwner)
    if (!permission.allowed) {
        await sock.sendMessage(groupJid, { text: "Command .welcome hanya dapat digunakan oleh admin grup atau owner bot." })
        return true
    }
    metadata = permission.metadata || await sock.groupMetadata(groupJid).catch(() => null)

    if (action === "help") {
        await sock.sendMessage(groupJid, { text: welcomeHelp() })
        return true
    }

    if (action === "status") {
        const config = getGroupConfig(groupJid)
        await sock.sendMessage(groupJid, {
            text: [
                "👋 *WELCOME STATUS*",
                "",
                `Bot Admin: ${metadata && isBotAdmin(metadata, sock) ? "YA" : "TIDAK"}`,
                `Welcome: ${!groupRemoteControl?.isGroupFeatureEnabled || groupRemoteControl.isGroupFeatureEnabled(groupJid, "welcome") ? "ON" : "OFF"}`,
                `Menu: ${!groupRemoteControl?.isGroupFeatureEnabled || groupRemoteControl.isGroupFeatureEnabled(groupJid, "groupMenu") ? "ON" : "OFF"}`,
                `Template: ${config.custom ? "CUSTOM" : "DEFAULT"}`,
                "",
                config.template,
            ].join("\n"),
        })
        return true
    }

    if (action === "on" || action === "off") {
        groupRemoteControl?.setFeature?.(groupJid, "welcome", action === "on", senderJid)
        await sock.sendMessage(groupJid, { text: `Welcome grup ${action === "on" ? "diaktifkan" : "dinonaktifkan"}.` })
        return true
    }

    if (action === "menu" && /^(on|off)$/i.test(argument)) {
        groupRemoteControl?.setFeature?.(groupJid, "groupMenu", argument.toLowerCase() === "on", senderJid)
        await sock.sendMessage(groupJid, { text: `Menu interaktif ${argument.toLowerCase() === "on" ? "diaktifkan" : "dinonaktifkan"}.` })
        return true
    }

    if (action === "set") {
        if (!argument) {
            await sock.sendMessage(groupJid, { text: "Format: .welcome set <pesan>. Gunakan \\n untuk pindah baris." })
            return true
        }
        const template = argument.replace(/\\n/g, "\n").slice(0, 2500)
        updateGroupConfig(groupJid, { template }, senderJid)
        await sock.sendMessage(groupJid, { text: `Template welcome disimpan.\n\n${template}` })
        return true
    }

    if (action === "reset") {
        resetGroupConfig(groupJid)
        await sock.sendMessage(groupJid, { text: "Template welcome dikembalikan ke default." })
        return true
    }

    if (action === "test") {
        if (!metadata || !isBotAdmin(metadata, sock)) {
            await sock.sendMessage(groupJid, { text: "Welcome tidak dikirim karena bot belum menjadi admin di grup ini." })
            return true
        }
        await handleParticipantUpdate(sock, {
            id: groupJid,
            action: "add",
            participants: [senderJid],
        }, {
            ...context,
            groupRemoteControl,
            skipDelay: true,
            skipDedupe: true,
        })
        return true
    }

    await sock.sendMessage(groupJid, { text: welcomeHelp() })
    return true
}

module.exports = {
    DATA_FILE,
    DEFAULT_TEMPLATE,
    buildFallbackMenuText,
    buildMenuSections,
    extractInteractiveSelection,
    findCommandId,
    formatFeatureStatus,
    getBotIdentityCandidates,
    getBotParticipant,
    getGroupConfig,
    handleGroupWelcomeCommand,
    handleParticipantUpdate,
    installGroupWelcome,
    isBotAdmin,
    isSenderAdmin,
    renderTemplate,
    resetGroupConfig,
    saveState,
    sendInteractiveMenu,
    updateGroupConfig,
    welcomeHelp,
}
