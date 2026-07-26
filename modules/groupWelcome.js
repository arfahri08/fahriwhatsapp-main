"use strict"

const fs = require("fs")
const path = require("path")

const DATA_FILE = process.env.GROUP_WELCOME_DATA_FILE
    ? path.resolve(process.env.GROUP_WELCOME_DATA_FILE)
    : path.join(__dirname, "..", "data", "groupWelcome.json")

const DEFAULT_TEMPLATE = [
    "Halo {users}, selamat datang di *{group}*!",
    "",
    "Silakan baca peraturan dan jaga kenyamanan bersama.",
    "Jumlah anggota sekarang: *{member_count}*",
].join("\n")

const DEFAULT_STATE = Object.freeze({
    version: 1,
    groups: {},
})

const GAME_TRUTH_PROMPTS = [
    "Apa kebiasaan kamu yang paling malu kalau teman grup tahu?",
    "Siapa orang terakhir yang kamu stalk diam-diam?",
    "Kalau bisa mengulang satu momen memalukan, momen apa itu?",
    "Apa hal paling random yang pernah kamu lakukan tengah malam?",
    "Kalau disuruh jujur total, siapa anggota grup yang paling sering kamu perhatikan?",
]

const GAME_DARE_PROMPTS = [
    "Kirim voice note 5 detik dengan nada sok serius.",
    "Ganti foto profil selama 10 menit dengan gambar lucu.",
    "Sebutkan 3 hal positif tentang anggota grup yang terakhir chat.",
    "Kirim emoji yang menggambarkan mood kamu sekarang tanpa teks.",
    "Mention satu teman grup lalu bilang: kamu keren hari ini.",
]

const SUIT_CHOICES = ["batu", "gunting", "kertas"]

const QUIZ_QUESTIONS = [
    { question: "Planet terbesar di Tata Surya adalah...", options: ["A. Bumi", "B. Jupiter", "C. Mars", "D. Venus"], answer: "B", explanation: "Jupiter adalah planet terbesar di Tata Surya." },
    { question: "Hasil dari 12 × 8 adalah...", options: ["A. 86", "B. 92", "C. 96", "D. 108"], answer: "C", explanation: "12 × 8 = 96." },
    { question: "Ibu kota Provinsi Jawa Timur adalah...", options: ["A. Malang", "B. Surabaya", "C. Gresik", "D. Sidoarjo"], answer: "B", explanation: "Ibu kota Jawa Timur adalah Surabaya." },
    { question: "Bahasa utama untuk memberi gaya pada halaman web adalah...", options: ["A. CSS", "B. SQL", "C. Python", "D. Bash"], answer: "A", explanation: "CSS digunakan untuk mengatur tampilan dan gaya halaman web." },
    { question: "Hewan yang mengalami metamorfosis dari ulat adalah...", options: ["A. Lebah", "B. Kupu-kupu", "C. Belalang", "D. Semut"], answer: "B", explanation: "Ulat berubah menjadi kepompong lalu kupu-kupu." },
]

const GAME_SESSION_TTL_MS = 10 * 60 * 1000
const quizSessions = new Map()
const numberGuessSessions = new Map()

const EVENT_DEDUPE_TTL_MS = 10 * 60 * 1000
const EVENT_DELAY_MS = Math.max(0, Number(process.env.GROUP_WELCOME_EVENT_DELAY_MS || 1200))
const recentEvents = new Map()
const learnedBotIdentities = new Set()
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

function getBotIdentityCandidates(sock, extraCandidates = []) {
    return unique([
        sock?.user?.id,
        sock?.user?.lid,
        sock?.user?.jid,
        sock?.user?.phoneNumber,
        sock?.user?.pn,
        sock?.authState?.creds?.me?.id,
        sock?.authState?.creds?.me?.lid,
        sock?.authState?.creds?.me?.phoneNumber,
        sock?.authState?.creds?.me?.pn,
        ...learnedBotIdentities,
        ...(Array.isArray(extraCandidates) ? extraCandidates : [extraCandidates]),
    ])
}

function rememberBotIdentityCandidates(sock, messageOrMsg) {
    const msg = messageOrMsg?.key ? messageOrMsg : { key: messageOrMsg || {} }
    const key = msg?.key || {}
    if (key.fromMe !== true) return getBotIdentityCandidates(sock)

    const candidates = unique([
        key.participant,
        key.participantAlt,
        msg?.participant,
        msg?.participantAlt,
    ])
    for (const candidate of candidates) learnedBotIdentities.add(candidate)
    return getBotIdentityCandidates(sock)
}

function getBotParticipant(metadata, sock, extraCandidates = []) {
    const identities = getBotIdentityCandidates(sock, extraCandidates)
    return (metadata?.participants || []).find(participant => participantMatches(participant, identities)) || null
}

function isBotAdmin(metadata, sock, extraCandidates = []) {
    return isAdminParticipant(getBotParticipant(metadata, sock, extraCandidates))
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
            title: "INFORMASI GRUP",
            rows: [
                { header: "INFO", title: "Informasi Grup", description: "Nama grup, anggota, admin, dan status bot", id: ".groupinfo" },
                { header: "ATURAN", title: "Peraturan Grup", description: "Lihat deskripsi dan aturan grup", id: ".rules" },
                { header: "ADMIN", title: "Daftar Admin", description: "Lihat seluruh admin grup", id: ".adminlist" },
                { header: "FITUR", title: "Status Fitur Grup", description: "Cek fitur grup yang sedang aktif", id: ".fiturgrup" },
                { header: "KOMPATIBEL", title: "Menu Versi Teks", description: "Gunakan jika tombol menu tidak terbuka di HP", id: ".menuteks" },
            ],
        },
        {
            title: "MEDIA TOOLS",
            rows: [
                { header: "UPLOAD", title: "Image to URL", description: "Reply gambar lalu ketik .tourl", id: ".tourlinfo" },
                { header: "STIKER", title: "Buat Stiker", description: "Ubah gambar atau video menjadi stiker", id: ".stikerinfo" },
                { header: "PDF", title: "Gambar ke PDF", description: "Ubah gambar menjadi dokumen PDF", id: ".pdfinfo" },
            ],
        },
        {
            title: "GAME ZONE",
            rows: [
                { header: "GAME", title: "Kuis Cepat", description: "Jawab soal pilihan ganda", id: ".quiz" },
                { header: "GAME", title: "Tebak Angka", description: "Tebak angka rahasia dari 1 sampai 20", id: ".tebakangka" },
                { header: "GAME", title: "Suit", description: "Batu, gunting, atau kertas melawan bot", id: ".suit" },
                { header: "GAME", title: "Truth", description: "Ambil pertanyaan truth secara acak", id: ".truth" },
                { header: "GAME", title: "Dare", description: "Ambil tantangan dare secara acak", id: ".dare" },
                { header: "GAME", title: "Coin Flip", description: "Lempar koin virtual", id: ".coinflip" },
                { header: "GAME", title: "Roll Dice", description: "Acak angka dadu 1 sampai 6", id: ".roll" },
                { header: "GAMES", title: "Panduan Game", description: "Lihat seluruh command game", id: ".games" },
            ],
        },
    ]
}

function buildFallbackMenuText(bodyText = "") {
    return [
        bodyText || "Akses cepat seluruh fitur grup dalam satu tempat.",
        "",
        "✦ *MENU GRUP • COMMAND CENTER* ✦",
        "",
        "👥 *INFORMASI GRUP*",
        "• `.groupinfo` — informasi grup",
        "• `.rules` — peraturan grup",
        "• `.adminlist` — daftar admin",
        "• `.fiturgrup` — status fitur grup",
        "",
        "🧰 *MEDIA TOOLS*",
        "• `.tourl` — reply media menjadi link URL",
        "• `.stiker` — gambar/video menjadi stiker",
        "• `.pdf` — gambar menjadi PDF",
        "",
        "🎮 *GAME GRUP*",
        "• `.quiz` — kuis cepat",
        "• `.tebakangka` — mulai tebak angka",
        "• `.suit batu` — suit melawan bot",
        "• `.truth` / `.dare`",
        "• `.coinflip` / `.roll`",
        "",
        "Menu interaktif: `.menu`",
    ].filter(Boolean).join("\n")
}

function getPrivacyModeTs() {
    const offset = 77980457
    return String(Math.floor(Date.now() / 1000) - offset)
}

function buildMixedNativeFlowBizNode() {
    return {
        tag: "biz",
        attrs: {
            actual_actors: "2",
            host_storage: "2",
            privacy_mode_ts: getPrivacyModeTs(),
        },
        content: [
            {
                tag: "interactive",
                attrs: { type: "native_flow", v: "1" },
                content: [
                    {
                        tag: "native_flow",
                        attrs: { v: "9", name: "mixed" },
                    },
                ],
            },
            {
                tag: "quality_control",
                attrs: { source_type: "third_party" },
            },
        ],
    }
}

async function sendNativeFlowMenu(sock, groupJid, options = {}) {
    const { generateWAMessageFromContent, proto } = require("@whiskeysockets/baileys")
    if (typeof generateWAMessageFromContent !== "function" || !proto?.Message?.InteractiveMessage) {
        throw new Error("Baileys InteractiveMessage tidak tersedia")
    }

    const title = String(options.title || "✦ MENU GRUP • COMMAND CENTER ✦")
    const bodyText = String(options.bodyText || "Akses cepat seluruh fitur grup dalam satu tempat. Jika tombol tidak terbuka di HP, ketik .menuteks.")
    const footer = String(options.footer || "Mobile-first menu • alternatif: .menuteks")
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
                            title: "BUKA MENU",
                            sections,
                        }),
                    })
                    : {
                        name: "single_select",
                        buttonParamsJson: JSON.stringify({
                            title: "BUKA MENU",
                            sections,
                        }),
                    },
            ],
            messageParamsJson: "{}",
            messageVersion: 1,
        }),
    })

    const generated = generateWAMessageFromContent(groupJid, { interactiveMessage }, {
        userJid: sock?.user?.id,
    })
    await sock.relayMessage(groupJid, generated.message, {
        messageId: generated.key.id,
        additionalNodes: [buildMixedNativeFlowBizNode()],
    })
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
        title: String(options.title || "✦ MENU GRUP • COMMAND CENTER ✦"),
        text: String(options.bodyText || "Akses cepat seluruh fitur grup dalam satu tempat. Jika tombol tidak terbuka di HP, ketik .menuteks."),
        footer: String(options.footer || "Mobile-first menu • alternatif: .menuteks"),
        buttonText: "BUKA MENU",
        sections,
        mentions: unique(options.mentionedJid),
    })
}

async function sendInteractiveMenu(sock, groupJid, options = {}) {
    if (options.disableInteractive !== true) {
        // ListMessage diprioritaskan karena lebih kompatibel dengan aplikasi
        // WhatsApp Android/iOS dibanding Native Flow single_select tertentu.
        try {
            await sendLegacyListMenu(sock, groupJid, options)
            console.log("[GROUP MENU] ListMessage terkirim (mobile-first)", { groupJid })
            return { sent: true, mode: "list-message" }
        } catch (error) {
            console.log("[GROUP MENU] ListMessage gagal, coba Native Flow", {
                groupJid,
                error: String(error?.message || error).slice(0, 240),
            })
        }

        try {
            const generated = await sendNativeFlowMenu(sock, groupJid, options)
            console.log("[GROUP MENU] Native Flow fallback terkirim", {
                groupJid,
                messageId: generated?.key?.id || "-",
            })
            return { sent: true, mode: "native-flow", messageId: generated?.key?.id || "" }
        } catch (error) {
            console.log("[GROUP MENU] Native Flow gagal, pakai fallback teks", {
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
    const participants = unique(update?.participants).filter(jid => (
        context.allowBotParticipant === true || !botUsers.has(jidUser(jid))
    ))
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
            title: "🎉 WELCOME TO THE GROUP",
            bodyText,
            footer: "Baca aturan • Kenalan • Nikmati kebersamaan",
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

function pickRandom(items = []) {
    if (!Array.isArray(items) || !items.length) return "-"
    return items[Math.floor(Math.random() * items.length)]
}

function pruneGameSessions(now = Date.now()) {
    for (const [key, session] of quizSessions) {
        if (!session?.createdAt || now - session.createdAt > GAME_SESSION_TTL_MS) quizSessions.delete(key)
    }
    for (const [key, session] of numberGuessSessions) {
        if (!session?.createdAt || now - session.createdAt > GAME_SESSION_TTL_MS) numberGuessSessions.delete(key)
    }
}

function normalizeQuizAnswer(value) {
    const clean = String(value || "").trim().toUpperCase()
    const match = clean.match(/^[ABCD]/)
    return match ? match[0] : ""
}

function buildGamesText() {
    return [
        "🎮 *GAME ZONE*",
        "",
        "• `.quiz` — mulai kuis pilihan ganda",
        "• `.jawab <A/B/C/D>` — jawab kuis aktif",
        "• `.tebakangka` — mulai tebak angka 1-20",
        "• `.tebak <angka>` — kirim tebakan",
        "• `.suit <batu|gunting|kertas>` — lawan bot",
        "• `.truth` — pertanyaan truth acak",
        "• `.dare` — tantangan dare acak",
        "• `.coinflip` — lempar koin",
        "• `.roll` — acak dadu 1-6",
    ].join("\n")
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
        "Menu Build: V1.3.4",
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

    let text = String(context.text || extractInteractiveSelection(msg) || "").trim()
    const compact = text.toLowerCase().replace(/\s+/g, "")
    if (compact === ".welcomestatus") text = ".welcome status"
    if (compact === ".welcometest") text = ".welcome test"
    const lower = text.toLowerCase()
    const commands = [".welcome", ".groupmenu", ".menu", ".help", ".menuteks", ".menutext", ".groupinfo", ".rules", ".adminlist", ".fiturgrup", ".tourlinfo", ".stikerinfo", ".pdfinfo", ".games", ".quiz", ".jawab", ".tebakangka", ".tebak", ".coinflip", ".roll", ".truth", ".dare", ".suit"]
    if (!commands.some(command => lower === command || lower.startsWith(`${command} `))) return false

    const groupRemoteControl = context.groupRemoteControl
    const senderJid = normalizeJid(context.senderJid || context.sender || msg?.key?.participant)
    const canControlOwner = Boolean(context.canControlOwner || context.isOwner)

    if (lower === ".menuteks" || lower === ".menutext") {
        await sock.sendMessage(groupJid, { text: buildFallbackMenuText() })
        return true
    }

    if (lower === ".menu" || lower === ".groupmenu" || lower === ".help") {
        if (groupRemoteControl?.isGroupFeatureEnabled && !groupRemoteControl.isGroupFeatureEnabled(groupJid, "groupMenu")) {
            await sock.sendMessage(groupJid, { text: "Menu interaktif sedang dinonaktifkan untuk grup ini." })
            return true
        }
        const menuResult = await sendInteractiveMenu(sock, groupJid, {
            title: "✦ MENU GRUP • COMMAND CENTER ✦",
            bodyText: "Akses cepat seluruh fitur grup dalam satu tempat. Jika tombol tidak terbuka di HP, ketik .menuteks.",
            footer: "Mobile-first menu • alternatif: .menuteks",
        })
        console.log("[GROUP MENU] Command selesai", {
            groupJid,
            senderJid,
            mode: menuResult?.mode || "unknown",
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

    if (lower === ".tourlinfo") {
        await sock.sendMessage(groupJid, {
            text: [
                "🖼️ *IMAGE TO URL*",
                "",
                "Cara pakai:",
                "• reply gambar/stiker/video lalu ketik `.tourl`",
                "• atau kirim gambar/video dengan caption `.tourl`",
                "",
                "Bot akan upload media dan mengirim link hasilnya.",
            ].join("\n"),
        })
        return true
    }

    if (lower === ".stikerinfo") {
        await sock.sendMessage(groupJid, {
            text: "🎟️ Kirim gambar/video dengan caption *.stiker* atau reply medianya lalu ketik *.stiker*."
        })
        return true
    }

    if (lower === ".pdfinfo") {
        await sock.sendMessage(groupJid, {
            text: "📄 Kirim gambar dengan caption *.pdf* atau reply gambar lalu ketik *.pdf*."
        })
        return true
    }

    if (lower === ".games") {
        await sock.sendMessage(groupJid, { text: buildGamesText() })
        return true
    }

    pruneGameSessions()

    if (lower === ".quiz") {
        const question = pickRandom(QUIZ_QUESTIONS)
        quizSessions.set(groupJid, {
            ...question,
            createdAt: Date.now(),
            startedBy: senderJid,
        })
        await sock.sendMessage(groupJid, {
            text: [
                "🧠 *KUIS CEPAT*",
                "",
                question.question,
                "",
                ...question.options,
                "",
                "Jawab dengan: *.jawab A* / *.jawab B* / *.jawab C* / *.jawab D*",
                "Waktu menjawab: 10 menit.",
            ].join("\n"),
        })
        return true
    }

    if (lower === ".jawab" || lower.startsWith(".jawab ")) {
        const session = quizSessions.get(groupJid)
        if (!session) {
            await sock.sendMessage(groupJid, { text: "Belum ada kuis aktif. Mulai dengan *.quiz*." })
            return true
        }
        const answer = normalizeQuizAnswer(text.replace(/^\.jawab/i, ""))
        if (!answer) {
            await sock.sendMessage(groupJid, { text: "Format jawaban: *.jawab A* sampai *.jawab D*." })
            return true
        }
        quizSessions.delete(groupJid)
        const correct = answer === session.answer
        await sock.sendMessage(groupJid, {
            text: [
                correct ? "✅ *JAWABAN BENAR!*" : "❌ *JAWABAN BELUM TEPAT*",
                "",
                `Jawaban kamu: *${answer}*`,
                `Jawaban benar: *${session.answer}*`,
                session.explanation,
            ].join("\n"),
        })
        return true
    }

    if (lower === ".tebakangka") {
        const secret = Math.floor(Math.random() * 20) + 1
        numberGuessSessions.set(groupJid, {
            secret,
            attempts: 0,
            createdAt: Date.now(),
            startedBy: senderJid,
        })
        await sock.sendMessage(groupJid, {
            text: [
                "🔢 *TEBAK ANGKA*",
                "",
                "Bot sudah memilih angka rahasia dari *1 sampai 20*.",
                "Kirim tebakan dengan: *.tebak <angka>*",
                "Maksimal 5 percobaan dalam 10 menit.",
            ].join("\n"),
        })
        return true
    }

    if (lower === ".tebak" || lower.startsWith(".tebak ")) {
        const session = numberGuessSessions.get(groupJid)
        if (!session) {
            await sock.sendMessage(groupJid, { text: "Belum ada permainan tebak angka. Mulai dengan *.tebakangka*." })
            return true
        }
        const guessed = Number(String(text).replace(/^\.tebak/i, "").trim())
        if (!Number.isInteger(guessed) || guessed < 1 || guessed > 20) {
            await sock.sendMessage(groupJid, { text: "Masukkan angka 1 sampai 20. Contoh: *.tebak 7*." })
            return true
        }
        session.attempts += 1
        if (guessed === session.secret) {
            numberGuessSessions.delete(groupJid)
            await sock.sendMessage(groupJid, {
                text: `🎉 *TEPAT!* Angka rahasianya adalah *${session.secret}*. Kamu berhasil dalam *${session.attempts} percobaan*.`
            })
            return true
        }
        if (session.attempts >= 5) {
            numberGuessSessions.delete(groupJid)
            await sock.sendMessage(groupJid, {
                text: `Game selesai. Kesempatan habis. Angka rahasianya adalah *${session.secret}*.`
            })
            return true
        }
        numberGuessSessions.set(groupJid, session)
        await sock.sendMessage(groupJid, {
            text: `${guessed < session.secret ? "Terlalu kecil" : "Terlalu besar"}. Sisa kesempatan: *${5 - session.attempts}*.`
        })
        return true
    }

    if (lower === ".coinflip") {
        const result = Math.random() < 0.5 ? "HEADS / ANGKA" : "TAILS / GAMBAR"
        await sock.sendMessage(groupJid, { text: `🪙 *COIN FLIP*

Hasil: *${result}*` })
        return true
    }

    if (lower === ".roll") {
        const value = Math.floor(Math.random() * 6) + 1
        await sock.sendMessage(groupJid, { text: `🎲 *ROLL DICE*

Angka kamu: *${value}*` })
        return true
    }

    if (lower === ".truth") {
        await sock.sendMessage(groupJid, { text: `🤫 *TRUTH*

${pickRandom(GAME_TRUTH_PROMPTS)}` })
        return true
    }

    if (lower === ".dare") {
        await sock.sendMessage(groupJid, { text: `🔥 *DARE*

${pickRandom(GAME_DARE_PROMPTS)}` })
        return true
    }

    if (lower === ".suit" || lower.startsWith(".suit ")) {
        const choice = String(text.split(/\s+/).slice(1).join(" ") || "").trim().toLowerCase()
        const normalizedChoice = choice.replace(/[^a-z]/g, "")
        const botPick = pickRandom(SUIT_CHOICES)
        if (!normalizedChoice) {
            await sock.sendMessage(groupJid, {
                text: `✊ *SUIT*

Format: *.suit batu* / *.suit gunting* / *.suit kertas*
Bot tadi memilih contoh: *${botPick}*`,
            })
            return true
        }
        if (!SUIT_CHOICES.includes(normalizedChoice)) {
            await sock.sendMessage(groupJid, { text: "Pilihan suit hanya: batu, gunting, atau kertas." })
            return true
        }
        let verdict = "SERI"
        if (normalizedChoice === botPick) verdict = "SERI"
        else if (
            (normalizedChoice === "batu" && botPick === "gunting")
            || (normalizedChoice === "gunting" && botPick === "kertas")
            || (normalizedChoice === "kertas" && botPick === "batu")
        ) verdict = "KAMU MENANG"
        else verdict = "BOT MENANG"
        await sock.sendMessage(groupJid, {
            text: `✊ *SUIT*

Pilihan kamu: *${normalizedChoice}*
Pilihan bot: *${botPick}*
Hasil: *${verdict}*`,
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
        const testResult = await handleParticipantUpdate(sock, {
            id: groupJid,
            action: "add",
            participants: [senderJid],
        }, {
            ...context,
            groupRemoteControl,
            skipDelay: true,
            skipDedupe: true,
            allowBotParticipant: true,
        })
        if (!testResult?.handled) {
            await sock.sendMessage(groupJid, {
                text: `Test welcome gagal dijalankan. Alasan: ${testResult?.reason || "unknown"}`,
            })
        }
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
    buildMixedNativeFlowBizNode,
    extractInteractiveSelection,
    findCommandId,
    formatFeatureStatus,
    getBotIdentityCandidates,
    getBotParticipant,
    rememberBotIdentityCandidates,
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
