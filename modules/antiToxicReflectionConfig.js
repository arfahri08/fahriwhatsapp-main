const fs = require("fs");
const path = require("path");

const CONFIG_FILE = process.env.ANTI_TOXIC_REFLECTION_CONFIG_FILE
    ? path.resolve(process.env.ANTI_TOXIC_REFLECTION_CONFIG_FILE)
    : path.join(__dirname, "../data/antiToxicReflections.json");
const SESSION_TTL_MS = Number(process.env.ANTI_TOXIC_REFLECTION_SESSION_TTL_MS || 3 * 60 * 1000);
const MAX_TARGETS_PER_COMMAND = Number(process.env.ANTI_TOXIC_REFLECTION_MAX_TARGETS || 20);

const sessions = new Map();

const PROFILES = {
    islam: {
        label: "Islam",
        sources: ["Islam"],
        aliases: ["muslim"],
    },
    katolik: {
        label: "Katolik",
        sources: ["Katolik"],
        aliases: ["catholic"],
    },
    kristen: {
        label: "Kristen",
        sources: ["Kristen"],
        aliases: ["protestan", "christian"],
    },
    hindu: {
        label: "Hindu",
        sources: ["Hindu"],
        aliases: [],
    },
    buddha: {
        label: "Buddha",
        sources: ["Buddha"],
        aliases: ["buddha", "buddhist"],
    },
    konghucu: {
        label: "Konghucu",
        sources: ["Konghucu"],
        aliases: ["khonghucu", "confucian"],
    },
    kepercayaan: {
        label: "Kepercayaan/Budaya",
        sources: ["Kepercayaan/Budaya"],
        aliases: ["budaya", "adat", "umum", "kepercayaanbudaya"],
    },
};

const PROFILE_ALIASES = new Map();
for (const [key, profile] of Object.entries(PROFILES)) {
    PROFILE_ALIASES.set(key, key);
    for (const alias of profile.aliases || []) {
        PROFILE_ALIASES.set(sanitizeProfileToken(alias), key);
    }
}

function sanitizeProfileToken(value) {
    return String(value || "")
        .normalize("NFKC")
        .trim()
        .toLowerCase()
        .replace(/^\./, "")
        .replace(/[^a-z]/g, "");
}

function normalizeProfileKey(value) {
    const token = sanitizeProfileToken(value);
    return PROFILE_ALIASES.get(token) || null;
}

function getAllowedQuoteSources(profile) {
    const key = normalizeProfileKey(profile);
    if (!key || !PROFILES[key]) return [];
    return [...PROFILES[key].sources];
}

function getProfileLabel(profile) {
    const key = normalizeProfileKey(profile);
    return key && PROFILES[key] ? PROFILES[key].label : String(profile || "-");
}

function normalizeReflectionMode(input) {
    const token = sanitizeProfileToken(input);
    if (["random", "default", "umum", "campur"].includes(token)) return "random";
    if (["katolik", "catholic", "katholik"].includes(token)) return "katolik";
    if (["islam", "muslim"].includes(token)) return "islam";
    return null;
}

function getReflectionModeLabel(mode) {
    const normalized = normalizeReflectionMode(mode);
    if (normalized === "random") return "default/random";
    if (normalized) return getProfileLabel(normalized);

    const profile = normalizeProfileKey(mode);
    return profile ? getProfileLabel(profile) : "default/random";
}

function emptyState() {
    return {
        users: {},
        aliases: {},
        knownAliases: {},
        groups: {},
        pending: {},
        updatedAt: new Date().toISOString(),
    };
}

function writeJsonAtomic(filePath, value) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpFile = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmpFile, JSON.stringify(value, null, 2));
    fs.renameSync(tmpFile, filePath);
}

function ensureStateFile() {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    if (!fs.existsSync(CONFIG_FILE)) {
        writeJsonAtomic(CONFIG_FILE, emptyState());
    }
}

function isGroupJid(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@g.us");
}

function isLidJid(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@lid");
}

function isPrivateUserJid(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@s.whatsapp.net");
}

function normalizeLidJid(value) {
    const clean = String(value || "").trim();
    if (!/@lid$/i.test(clean)) return null;

    const id = getJidNumber(clean);
    return id ? `${id}@lid` : null;
}

function getJidNumber(value) {
    return String(value || "")
        .split("@")[0]
        .split(":")[0]
        .split("_")[0]
        .replace(/[^0-9]/g, "");
}

function normalizeNumber(value) {
    let number = getJidNumber(value);
    if (!number) return null;

    if (number.startsWith("0")) number = `62${number.slice(1)}`;
    else if (number.startsWith("8")) number = `62${number}`;

    return number.length >= 9 && number.length <= 16 ? number : null;
}

function normalizeStableUserJid(value) {
    const number = normalizeNumber(value);
    return number ? `${number}@s.whatsapp.net` : null;
}

function normalizeGroupJid(value) {
    const clean = String(value || "").trim().toLowerCase();
    const match = clean.match(/[0-9][0-9-]{4,}@g\.us/i);
    return match ? match[0].toLowerCase() : null;
}

function normalizeUserJid(value) {
    const clean = String(value || "").trim();
    if (!clean) return null;

    if (/@lid$/i.test(clean)) {
        return normalizeLidJid(clean);
    }

    if (/@s\.whatsapp\.net$/i.test(clean)) {
        return normalizeStableUserJid(clean);
    }

    return normalizeStableUserJid(clean);
}

function normalizeTargetJid(value) {
    return normalizeGroupJid(value) || normalizeUserJid(value);
}

function getTargetType(jid) {
    return isGroupJid(jid) ? "group" : "user";
}

function isSameUser(a, b) {
    const numberA = normalizeNumber(a);
    const numberB = normalizeNumber(b);
    return Boolean(numberA && numberB && numberA === numberB);
}

function normalizeUserAliases(values, primaryJid = null) {
    const aliases = [
        primaryJid,
        ...(Array.isArray(values) ? values : []),
    ].map(normalizeUserJid).filter(Boolean);

    return [...new Set(aliases.map(item => item.toLowerCase()))];
}

function normalizeEntry(rawEntry, fallbackJid, fallbackType) {
    const jid = fallbackType === "group"
        ? normalizeGroupJid(rawEntry?.jid || fallbackJid)
        : normalizeUserJid(rawEntry?.jid || fallbackJid);
    const profile = normalizeProfileKey(rawEntry?.profile || rawEntry?.mode);

    if (!jid || !profile) return null;

    return {
        type: fallbackType,
        jid,
        profile,
        mode: profile,
        label: getProfileLabel(profile),
        aliases: fallbackType === "user" ? normalizeUserAliases(rawEntry?.aliases || [], jid) : [],
        updatedAt: rawEntry?.updatedAt || new Date().toISOString(),
        updatedBy: rawEntry?.updatedBy || "owner",
    };
}

function normalizeState(raw) {
    const state = emptyState();
    const users = raw && typeof raw.users === "object" ? raw.users : {};
    const aliases = raw && typeof raw.aliases === "object" ? raw.aliases : {};
    const knownAliases = raw && typeof raw.knownAliases === "object" ? raw.knownAliases : {};
    const groups = raw && typeof raw.groups === "object" ? raw.groups : {};

    for (const [jid, entry] of Object.entries(users)) {
        const normalized = normalizeEntry(entry, jid, "user");
        if (normalized) {
            state.users[normalized.jid] = normalized;
            for (const alias of normalized.aliases || []) {
                if (alias !== normalized.jid) state.aliases[alias] = normalized.jid;
            }
        }
    }

    for (const [jid, entry] of Object.entries(groups)) {
        const normalized = normalizeEntry(entry, jid, "group");
        if (normalized) state.groups[normalized.jid] = normalized;
    }

    for (const [alias, primary] of Object.entries(aliases)) {
        const aliasJid = normalizeUserJid(alias);
        const primaryJid = normalizeUserJid(primary);
        if (!aliasJid || !primaryJid || !state.users[primaryJid]) continue;
        state.aliases[aliasJid] = primaryJid;
        const entry = state.users[primaryJid];
        entry.aliases = normalizeUserAliases([...(entry.aliases || []), aliasJid], primaryJid);
    }

    for (const [alias, values] of Object.entries(knownAliases)) {
        const aliasValues = Array.isArray(values) ? values : [values];
        linkKnownUserAliases(state, [alias, ...aliasValues]);
    }

    state.pending = raw && typeof raw.pending === "object" ? raw.pending : {};
    state.updatedAt = raw?.updatedAt || state.updatedAt;
    return state;
}

function loadState() {
    try {
        ensureStateFile();
        const raw = fs.readFileSync(CONFIG_FILE, "utf8");
        return normalizeState(JSON.parse(raw));
    } catch (error) {
        console.log("[ANTI-TOXIC RENUNGAN] Gagal membaca config, pakai state kosong.", {
            errorMessage: error?.message || String(error),
        });

        try {
            if (fs.existsSync(CONFIG_FILE)) {
                const backupPath = path.join(
                    path.dirname(CONFIG_FILE),
                    `${path.basename(CONFIG_FILE, ".json")}.corrupt.${Date.now()}.json`
                );
                fs.renameSync(CONFIG_FILE, backupPath);
                console.log("[ANTI-TOXIC RENUNGAN] Config rusak dibackup.", {
                    backup: path.basename(backupPath),
                });
            }
            writeJsonAtomic(CONFIG_FILE, emptyState());
        } catch (backupError) {
            console.log("[ANTI-TOXIC RENUNGAN] Gagal backup config rusak.", {
                errorMessage: backupError?.message || String(backupError),
            });
        }

        return emptyState();
    }
}

function saveState(state) {
    try {
        const next = normalizeState(state);
        next.updatedAt = new Date().toISOString();
        writeJsonAtomic(CONFIG_FILE, next);
        return next;
    } catch (error) {
        console.log("[ANTI-TOXIC RENUNGAN] Gagal menyimpan config.", {
            errorMessage: error?.message || String(error),
        });
        return normalizeState(state);
    }
}

function unwrapMessage(message) {
    let current = message || {};

    for (let i = 0; i < 8; i += 1) {
        if (current?.ephemeralMessage?.message) current = current.ephemeralMessage.message;
        else if (current?.viewOnceMessage?.message) current = current.viewOnceMessage.message;
        else if (current?.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
        else if (current?.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message;
        else if (current?.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
        else break;
    }

    return current;
}

function getIncomingText(msg) {
    const message = unwrapMessage(msg?.message || {});
    return String(
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        message.buttonsResponseMessage?.selectedDisplayText ||
        message.listResponseMessage?.title ||
        message.listResponseMessage?.singleSelectReply?.selectedRowId ||
        message.templateButtonReplyMessage?.selectedDisplayText ||
        ""
    ).trim();
}

function getContextInfo(msg) {
    const message = unwrapMessage(msg?.message || {});
    return (
        message.extendedTextMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.documentMessage?.contextInfo ||
        message.audioMessage?.contextInfo ||
        message.stickerMessage?.contextInfo ||
        message.contactMessage?.contextInfo ||
        {}
    );
}

function getContactEntries(message) {
    const current = unwrapMessage(message || {});
    if (current.contactMessage) return [current.contactMessage];
    if (current.contactsArrayMessage?.contacts?.length) return current.contactsArrayMessage.contacts;
    return [];
}

function uniqueTargets(targets) {
    const seen = new Set();
    const result = [];

    for (const target of targets || []) {
        const jid = normalizeTargetJid(target?.jid || target);
        if (!jid) continue;
        const key = jid.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
            jid,
            type: getTargetType(jid),
            label: target?.label || formatTargetJid(jid),
            source: target?.source || "unknown",
            aliases: getTargetType(jid) === "user" ? normalizeUserAliases(target?.aliases || [], jid) : [],
        });
    }

    return result;
}

function getUserLookupKeys(jid) {
    const clean = String(jid || "").trim();
    const keys = [];

    if (isLidJid(clean)) {
        keys.push(normalizeLidJid(clean));
    } else if (isPrivateUserJid(clean)) {
        keys.push(normalizeStableUserJid(clean));
    } else {
        keys.push(normalizeUserJid(clean));
    }

    return [...new Set(keys.filter(Boolean).map(item => item.toLowerCase()))];
}

function linkKnownUserAliases(state, values) {
    if (!state) return [];
    if (!state.knownAliases || typeof state.knownAliases !== "object") state.knownAliases = {};

    const directAliases = normalizeUserAliases(values || []);
    if (directAliases.length === 0) return [];

    const merged = new Set(directAliases);
    let changed = true;

    while (changed) {
        changed = false;
        for (const alias of [...merged]) {
            const known = Array.isArray(state.knownAliases[alias]) ? state.knownAliases[alias] : [];
            for (const item of normalizeUserAliases(known)) {
                if (merged.has(item)) continue;
                merged.add(item);
                changed = true;
            }
        }
    }

    const aliases = [...merged];
    for (const alias of aliases) {
        state.knownAliases[alias] = aliases.filter(item => item !== alias);
    }

    return aliases;
}

function getKnownAliasesForJid(state, jid) {
    const seeds = getUserLookupKeys(jid);
    if (!state?.knownAliases || seeds.length === 0) return seeds;

    const aliases = new Set(seeds);
    let changed = true;

    while (changed) {
        changed = false;
        for (const alias of [...aliases]) {
            const known = Array.isArray(state.knownAliases[alias]) ? state.knownAliases[alias] : [];
            for (const item of normalizeUserAliases(known)) {
                if (aliases.has(item)) continue;
                aliases.add(item);
                changed = true;
            }
        }
    }

    return [...aliases];
}

function getParticipantJidFields(participant) {
    if (!participant) return [];
    if (typeof participant === "string") return [participant];

    return [
        participant.id,
        participant.jid,
        participant.lid,
        participant.phoneNumber,
        participant.phoneNumberJid,
        participant.pn,
        participant.pnJid,
        participant.participant,
    ].filter(Boolean);
}

async function resolveTargetsWithGroupMetadata(sock, remoteJid, targets) {
    const normalizedTargets = uniqueTargets(targets);
    const groupJid = normalizeGroupJid(remoteJid);
    const userTargets = normalizedTargets.filter(target => target.type === "user");
    if (!groupJid || !userTargets.length || typeof sock?.groupMetadata !== "function") return normalizedTargets;

    let participants = [];
    try {
        const metadata = await sock.groupMetadata(groupJid);
        participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
    } catch (error) {
        console.log("[ANTI-TOXIC RENUNGAN] Gagal ambil metadata grup untuk alias target.", {
            remoteJid: groupJid,
            errorMessage: error?.message || String(error),
        });
        return normalizedTargets;
    }

    if (!participants.length) return normalizedTargets;

    const participantAliases = participants
        .map(participant => normalizeUserAliases(getParticipantJidFields(participant)))
        .filter(aliases => aliases.length > 0);

    return normalizedTargets.map(target => {
        if (target.type !== "user") return target;

        const targetAliases = normalizeUserAliases([target.jid]);
        const matchedAliases = participantAliases.find(aliases => (
            aliases.some(alias => targetAliases.includes(alias))
        ));

        if (!matchedAliases) return {
            ...target,
            aliases: targetAliases,
        };

        return {
            ...target,
            aliases: normalizeUserAliases([...targetAliases, ...matchedAliases]),
        };
    });
}

function extractNumbersFromVcard(vcard) {
    const text = String(vcard || "");
    const waids = [...text.matchAll(/waid=(\d+)/gi)].map(match => match[1]);
    const telLines = text
        .split(/\r?\n/)
        .filter(line => /^TEL/i.test(line))
        .map(line => line.split(":").slice(1).join(":"));
    const genericNumbers = [...text.matchAll(/(?:\+?62|0|8)(?:[\s().-]*\d){7,13}(?!\d)/g)]
        .map(match => match[0]);

    return [...new Set([...waids, ...telLines, ...genericNumbers].map(normalizeNumber).filter(Boolean))];
}

function extractContactTargets(msg) {
    const entries = getContactEntries(msg?.message);
    const targets = [];

    for (const entry of entries) {
        const numbers = extractNumbersFromVcard(entry?.vcard);
        for (const number of numbers) {
            targets.push({
                jid: `${number}@s.whatsapp.net`,
                type: "user",
                label: entry?.displayName || number,
                source: "contact",
            });
        }
    }

    return uniqueTargets(targets);
}

function extractTextTargets(text) {
    const clean = String(text || "");
    if (!clean) return [];

    const targets = [];
    const jidPattern = /[0-9A-Za-z._:-]+@(?:s\.whatsapp\.net|g\.us|lid)/gi;

    for (const match of clean.matchAll(jidPattern)) {
        const jid = normalizeTargetJid(match[0]);
        if (!jid) continue;
        targets.push({
            jid,
            type: getTargetType(jid),
            label: formatTargetJid(jid),
            source: "jid",
        });
    }

    const withoutJids = clean.replace(jidPattern, " ");
    const phonePattern = /(?:\+?62|0|8)(?:[\s().-]*\d){7,13}(?!\d)/g;

    for (const match of withoutJids.matchAll(phonePattern)) {
        const number = normalizeNumber(match[0]);
        if (!number) continue;
        targets.push({
            jid: `${number}@s.whatsapp.net`,
            type: "user",
            label: number,
            source: "number",
        });
    }

    return uniqueTargets(targets);
}

function extractMentionTargets(msg) {
    const contextInfo = getContextInfo(msg);
    const mentions = Array.isArray(contextInfo.mentionedJid) ? contextInfo.mentionedJid : [];

    return uniqueTargets(mentions.map(jid => ({
        jid,
        type: "user",
        label: formatTargetJid(jid),
        source: "mention",
    })));
}

function extractQuotedTarget(msg, context = {}) {
    const contextInfo = getContextInfo(msg);
    const hasQuotedMessage = Boolean(contextInfo.quotedMessage || contextInfo.stanzaId);
    if (!hasQuotedMessage) return [];

    const remoteJid = context.remoteJid || msg?.key?.remoteJid || "";
    const isGroupChat = isGroupJid(remoteJid);
    const candidates = [
        contextInfo.participantAlt,
        contextInfo.participant,
        isGroupChat ? "" : contextInfo.remoteJidAlt,
        isGroupChat ? "" : contextInfo.remoteJid,
        isGroupChat ? "" : msg?.key?.remoteJidAlt,
        isGroupChat ? "" : msg?.key?.remoteJid,
    ].map(normalizeUserJid).filter(Boolean);
    const ownerLikeJids = [
        context.ownerJid,
        context.senderJid,
        msg?.key?.participantAlt,
        msg?.key?.participant,
        msg?.participantAlt,
        msg?.participant,
    ].map(normalizeUserJid).filter(Boolean);
    const filteredCandidates = candidates.filter(jid => (
        !ownerLikeJids.some(ownerJid => isSameUser(jid, ownerJid))
    ));
    const targetJid = filteredCandidates.find(isPrivateUserJid) || filteredCandidates[0];

    if (!targetJid) return [];

    return uniqueTargets([{
        jid: targetJid,
        type: "user",
        label: formatTargetJid(targetJid),
        source: "reply",
    }]);
}

async function collectTargets(sock, msg, text, context = {}) {
    const targets = [
        ...extractContactTargets(msg),
        ...extractTextTargets(text),
        ...extractMentionTargets(msg),
        ...extractQuotedTarget(msg, context),
    ];

    const resolvedTargets = await resolveTargetsWithGroupMetadata(
        sock,
        context.remoteJid || msg?.key?.remoteJid,
        targets
    );

    return resolvedTargets.slice(0, Math.max(1, MAX_TARGETS_PER_COMMAND));
}

function formatTargetJid(jid) {
    const normalized = normalizeTargetJid(jid) || String(jid || "");
    if (isGroupJid(normalized)) return normalized;
    if (isLidJid(normalized)) return normalized;

    const number = normalizeNumber(normalized);
    return number ? `+${number}` : normalized;
}

function formatTargetLine(entry, index) {
    const profile = entry?.profile ? getProfileLabel(entry.profile) : "Random/default";
    return `${index + 1}. ${formatTargetJid(entry?.jid || entry)} -> ${profile}`;
}

function formatTargetSummary(targets) {
    return (targets || [])
        .map((target, index) => {
            const aliases = normalizeUserAliases(target.aliases || [], target.jid)
                .filter(alias => alias !== normalizeUserJid(target.jid));
            const aliasText = aliases.length
                ? ` | alias: ${aliases.map(formatTargetJid).join(", ")}`
                : "";

            return `${index + 1}. ${formatTargetJid(target.jid)} (${target.source})${aliasText}`;
        })
        .join("\n");
}

function formatSkippedSummary(targets) {
    const skipped = targets || [];
    if (!skipped.length) return "";

    return `Tidak disimpan karena masih berupa ID sementara, bukan nomor WhatsApp stabil: ${skipped.map(target => formatTargetJid(target.jid)).join(", ")}`;
}

function getSessionKey(msg, context = {}) {
    const remoteJid = context.remoteJid || msg?.key?.remoteJid || "";
    const senderJid = isGroupJid(remoteJid)
        ? (context.senderJid || msg?.key?.participant || msg?.participant || remoteJid)
        : (context.senderJid || msg?.key?.participant || msg?.participant || remoteJid);

    return `${remoteJid}:${normalizeUserJid(senderJid) || senderJid}`;
}

function pruneSessions(now = Date.now()) {
    for (const [key, session] of sessions) {
        if (!session?.expiresAt || session.expiresAt < now) {
            sessions.delete(key);
        }
    }
}

function getOwnerLikeJids(msg, context = {}) {
    return [
        context.ownerJid,
        context.senderJid,
        msg?.key?.participant,
        msg?.participant,
        context.remoteJid,
        msg?.key?.remoteJid,
    ].map(normalizeUserJid).filter(Boolean);
}

function isOwnerMessage(msg, context = {}) {
    if (context.isOwner === true || msg?.key?.fromMe) return true;

    const ownerJid = normalizeUserJid(context.ownerJid);
    if (!ownerJid) return false;

    return getOwnerLikeJids(msg, context).some(jid => isSameUser(jid, ownerJid));
}

async function reply(sock, msg, text) {
    const remoteJid = msg?.key?.remoteJid;
    if (!sock || typeof sock.sendMessage !== "function" || !remoteJid) return false;

    try {
        await sock.sendMessage(remoteJid, { text }, { quoted: msg });
        return true;
    } catch (error) {
        console.log("[ANTI-TOXIC RENUNGAN] Gagal kirim balasan command.", {
            remoteJid,
            errorMessage: error?.message || String(error),
        });
        return false;
    }
}

function removeAliasesForPrimary(state, primaryJid) {
    if (!state?.aliases || !primaryJid) return;

    for (const [alias, targetJid] of Object.entries(state.aliases)) {
        if (targetJid === primaryJid) delete state.aliases[alias];
    }
}

function findUserPreferenceByJid(state, jid) {
    const keys = getKnownAliasesForJid(state, jid);

    for (const key of keys) {
        if (state.users[key]) return { entry: state.users[key], primaryJid: key, matchedJid: key };

        const primaryJid = state.aliases?.[key];
        if (primaryJid && state.users[primaryJid]) {
            return { entry: state.users[primaryJid], primaryJid, matchedJid: key };
        }
    }

    for (const entry of Object.values(state.users || {})) {
        const aliases = normalizeUserAliases(entry?.aliases || [], entry?.jid);
        const matchedJid = keys.find(key => aliases.includes(key));
        if (matchedJid) return { entry, primaryJid: entry.jid, matchedJid };
    }

    return null;
}

function setTargets(profile, targets) {
    const profileKey = normalizeProfileKey(profile);
    if (!profileKey) return { saved: 0, targets: [], skipped: [] };

    const now = new Date().toISOString();
    const state = loadState();
    const savedTargets = [];

    for (const target of uniqueTargets(targets)) {
        const targetJid = target.type === "group"
            ? normalizeGroupJid(target.jid)
            : normalizeUserJid(target.jid);

        if (!targetJid) continue;
        const aliases = normalizeUserAliases([
            ...(target.aliases || []),
            ...getKnownAliasesForJid(state, targetJid),
        ], targetJid);

        const entry = {
            type: target.type,
            jid: targetJid,
            profile: profileKey,
            label: getProfileLabel(profileKey),
            aliases: target.type === "user" ? aliases : [],
            updatedAt: now,
            updatedBy: "owner",
        };

        if (target.type === "group") state.groups[targetJid] = entry;
        else {
            for (const alias of aliases) {
                const oldPrimaryJid = state.aliases?.[alias];
                if (oldPrimaryJid && oldPrimaryJid !== targetJid) {
                    removeAliasesForPrimary(state, oldPrimaryJid);
                    delete state.users[oldPrimaryJid];
                }
                if (alias !== targetJid && state.users[alias]) {
                    removeAliasesForPrimary(state, alias);
                    delete state.users[alias];
                }
            }
            removeAliasesForPrimary(state, targetJid);
            state.users[targetJid] = entry;
            for (const alias of aliases) {
                if (alias !== targetJid) state.aliases[alias] = targetJid;
            }
        }

        savedTargets.push({ ...target, jid: targetJid, aliases, profile: profileKey });
    }

    saveState(state);
    return { saved: savedTargets.length, targets: savedTargets, skipped: [] };
}

function removeTargets(targets) {
    const state = loadState();
    let removed = 0;
    const missing = [];

    for (const target of uniqueTargets(targets)) {
        if (target.type === "group") {
            const groupJid = normalizeGroupJid(target.jid);
            if (groupJid && state.groups[groupJid]) {
                delete state.groups[groupJid];
                removed += 1;
            } else {
                missing.push(target);
            }
        } else {
            const match = findUserPreferenceByJid(state, target.jid);
            if (match?.primaryJid) {
                removeAliasesForPrimary(state, match.primaryJid);
                delete state.users[match.primaryJid];
                removed += 1;
            } else {
                missing.push(target);
            }
        }
    }

    saveState(state);
    return { removed, missing };
}

function rememberUserAliases(...values) {
    const aliases = normalizeUserAliases(values.flat ? values.flat() : values);
    if (aliases.length < 2) return { saved: false, aliases };

    const state = loadState();
    const linkedAliases = linkKnownUserAliases(state, aliases);
    const match = linkedAliases
        .map(alias => findUserPreferenceByJid(state, alias))
        .find(item => item?.entry?.profile);

    if (match?.entry?.jid) {
        const primaryJid = match.entry.jid;
        const entry = state.users[primaryJid];
        entry.aliases = normalizeUserAliases([
            ...(entry.aliases || []),
            ...linkedAliases,
        ], primaryJid);

        removeAliasesForPrimary(state, primaryJid);
        for (const alias of entry.aliases) {
            if (alias !== primaryJid) state.aliases[alias] = primaryJid;
        }
    }

    saveState(state);
    return {
        saved: true,
        aliases: linkedAliases,
        linkedProfile: match?.entry?.profile || null,
    };
}

function clearAllTargets() {
    const state = loadState();
    const totalUsers = Object.keys(state.users || {}).length;
    const totalGroups = Object.keys(state.groups || {}).length;
    state.users = {};
    state.aliases = {};
    state.knownAliases = {};
    state.groups = {};
    state.pending = {};
    saveState(state);
    return { totalUsers, totalGroups, total: totalUsers + totalGroups };
}

function countTargets() {
    const state = loadState();
    const totalUsers = Object.keys(state.users || {}).length;
    const totalGroups = Object.keys(state.groups || {}).length;
    return { totalUsers, totalGroups, total: totalUsers + totalGroups };
}

function findPreferenceForTarget(jid, state = loadState()) {
    const groupJid = normalizeGroupJid(jid);
    if (groupJid && state.groups[groupJid]) return { ...state.groups[groupJid], scope: "group" };

    const match = findUserPreferenceByJid(state, jid);
    if (match?.entry) return { ...match.entry, scope: "user", matchedJid: match.matchedJid };

    return null;
}

function setGroupReflectionMode(groupJid, mode, updatedBy = "owner") {
    const jid = normalizeGroupJid(groupJid);
    const normalizedMode = normalizeReflectionMode(mode);
    if (!jid || !normalizedMode) return { ok: false };

    if (normalizedMode === "random") {
        resetGroupReflectionMode(jid);
        return {
            ok: true,
            entry: {
                type: "group",
                jid,
                mode: "random",
                profile: null,
                source: "default",
            },
        };
    }

    const state = loadState();
    const entry = {
        type: "group",
        jid,
        profile: normalizedMode,
        mode: normalizedMode,
        label: getProfileLabel(normalizedMode),
        aliases: [],
        updatedAt: Date.now(),
        updatedBy: normalizeUserJid(updatedBy) || String(updatedBy || "owner"),
    };

    state.groups[jid] = entry;
    saveState(state);
    return { ok: true, entry: { ...entry, scope: "group", source: "group" } };
}

function getGroupReflectionMode(groupJid, state = loadState()) {
    const jid = normalizeGroupJid(groupJid);
    if (!jid) return { mode: "random", source: "default" };

    const entry = state.groups?.[jid];
    const profile = normalizeProfileKey(entry?.profile || entry?.mode);
    const mode = normalizeReflectionMode(entry?.mode || entry?.profile) || profile;
    if (!entry || !profile || mode === "random") {
        return { mode: "random", source: "default", jid };
    }

    return {
        mode,
        profile,
        source: "group",
        jid,
        label: getProfileLabel(profile),
        updatedAt: entry.updatedAt,
        updatedBy: entry.updatedBy,
    };
}

function resetGroupReflectionMode(groupJid) {
    const jid = normalizeGroupJid(groupJid);
    if (!jid) return false;

    const state = loadState();
    const existed = Boolean(state.groups?.[jid]);
    if (state.groups) delete state.groups[jid];
    saveState(state);
    return existed;
}

function listGroupReflectionModes() {
    const state = loadState();
    return Object.entries(state.groups || {})
        .map(([jid, entry]) => {
            const profile = normalizeProfileKey(entry?.profile || entry?.mode);
            const mode = normalizeReflectionMode(entry?.mode || entry?.profile) || profile;
            if (!profile || mode === "random") return null;
            return {
                jid: normalizeGroupJid(entry?.jid || jid),
                mode,
                profile,
                label: getProfileLabel(profile),
                updatedAt: entry.updatedAt,
                updatedBy: entry.updatedBy,
            };
        })
        .filter(item => item?.jid)
        .sort((a, b) => String(a.jid).localeCompare(String(b.jid)));
}

function getPreferenceForWarning(context = {}) {
    const state = loadState();
    const groupJid = normalizeGroupJid(context.chatJid || context.remoteJid || context.msg?.key?.remoteJid);
    const groupPreference = getGroupReflectionMode(groupJid, state);
    if (groupPreference.source === "group" && groupPreference.profile) {
        console.log("[ANTI-TOXIC RENUNGAN DEBUG] Found group preference:", {
            jid: groupJid,
            profile: groupPreference.profile,
        });
        return { ...groupPreference, scope: "group" };
    }

    const userCandidates = [
        context.mentionJid,
        context.senderJid,
        ...(Array.isArray(context.candidateJids) ? context.candidateJids : []),
        context.remoteJid,
    ].flatMap(getUserLookupKeys).filter(Boolean);

    for (const jid of [...new Set(userCandidates)]) {
        const match = findUserPreferenceByJid(state, jid);
        const entry = match?.entry;
        if (!entry?.profile) continue;

        console.log("[ANTI-TOXIC RENUNGAN DEBUG] Found user preference:", {
            jid: entry.jid,
            matchedJid: match.matchedJid,
            profile: entry.profile,
        });
        return { ...entry, scope: "user", matchedJid: match.matchedJid };
    }

    console.log("[ANTI-TOXIC RENUNGAN DEBUG] No preference found, will use random quotes", {
        remoteJid: context.remoteJid || null,
        senderJid: context.senderJid || null,
        mentionJid: context.mentionJid || null,
    });
    return null;
}

function parseRenunganCommand(text) {
    const clean = String(text || "").trim();
    const commandMatch = clean.match(/^\.([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!commandMatch) return null;

    const command = commandMatch[1].toLowerCase();
    const args = String(commandMatch[2] || "").trim();
    const shortcutProfile = normalizeProfileKey(command);

    if (shortcutProfile) {
        return { action: "set", profile: shortcutProfile, args, raw: clean };
    }

    if (command === "listren") return { action: "list", args, raw: clean };
    if (command === "delt") return { action: "off", args, raw: clean };
    if (command === "delall") return { action: "clear-all", args, raw: clean };

    return null;
}

function buildHelpText() {
    return [
        "📖 *Command Renungan Anti-Toxic*",
        "• 🙏 *.katolik 628123456789* - set target langsung",
        "• 🙏 *.katolik* - bot minta target, bisa kontak/nomor/reply/mention",
        "• 📋 *.listren* - lihat semua target tersimpan",
        "• 🧹 *.delt 628123456789* - hapus target tersimpan",
        "• ⚠️ *.delall* - hapus semua target tersimpan",
        "",
        "✅ Target bisa berupa kontak WhatsApp, beberapa nomor format 08/+62/628, mention, atau reply pesan target.",
        "🧭 Shortcut agama: *.islam*, *.katolik*, *.kristen*, *.hindu*, *.buddha*, *.konghucu*, *.kepercayaan*.",
        "🔒 Target user disimpan sesuai JID yang dibaca WhatsApp, termasuk @lid dari reply/mention atau nomor 628 dari kontak/manual.",
    ].join("\n");
}

function buildProfilesText() {
    return [
        "🙏 *Profil Renungan Tersedia*",
        ...Object.entries(PROFILES).map(([key, profile]) => `• ${key}: ${profile.label}`),
    ].join("\n");
}

function isRemoteReflectionCommand(text) {
    const clean = String(text || "").trim().toLowerCase();
    return clean === ".renungctl" || clean.startsWith(".renungctl ");
}

function buildRemoteReflectionHelpText() {
    return [
        "🕊️ *Remote Renungan Control*",
        "",
        ".renungctl set <id/kode> katolik",
        "Mengatur grup agar warning anti kasar memakai renungan Katolik.",
        "",
        ".renungctl set <id/kode> islam",
        "Mengatur grup agar warning anti kasar memakai renungan Islam.",
        "",
        ".renungctl set <id/kode> random",
        "Mengembalikan grup ke renungan random/default.",
        "",
        ".renungctl status <id/kode>",
        "Melihat setting renungan grup.",
        "",
        ".renungctl reset <id/kode>",
        "Menghapus setting khusus renungan grup.",
        "",
        ".renungctl list",
        "Melihat semua grup yang punya setting renungan khusus.",
        "",
        "Gunakan .grouplist untuk melihat ID/kode grup.",
    ].join("\n");
}

function splitRemoteCommand(text) {
    return String(text || "").trim().split(/\s+/).filter(Boolean);
}

function canUseRemoteReflectionCommand(msg, context = {}) {
    if (context.canControlOwner === true || context.isOwner === true) return true;
    if (context.isOwnerControlMessage === true) return true;
    if (typeof context.isOwnerControlMessage === "function") {
        try {
            return Boolean(context.isOwnerControlMessage(msg, context.sender || context.senderJid, context.from || context.remoteJid));
        } catch {}
    }
    return isOwnerMessage(msg, context);
}

function formatRemoteTimestamp(value) {
    if (!value) return "-";
    const numeric = Number(value);
    const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
    if (Number.isNaN(date.getTime())) return "-";

    try {
        return new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Asia/Jakarta",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        }).format(date);
    } catch {
        return date.toISOString().slice(0, 16).replace("T", " ");
    }
}

async function resolveRemoteGroupTarget(sock, input, context = {}) {
    const resolver = context.groupRemoteControl?.resolveGroupTarget || context.resolveGroupTarget;
    if (typeof resolver === "function") {
        try {
            const result = await resolver(input, sock);
            if (result?.ok && result.jid) {
                return {
                    ok: true,
                    jid: normalizeGroupJid(result.jid),
                    code: result.code || "",
                    subject: result.subject || result.jid,
                };
            }
        } catch (error) {
            console.log("[ANTI-TOXIC RENUNGAN] Gagal resolve grup via groupRemoteControl.", {
                input,
                errorMessage: error?.message || String(error),
            });
        }
    }

    const jid = normalizeGroupJid(input);
    if (!jid) return { ok: false, reason: "not_found" };

    try {
        if (typeof sock?.groupMetadata === "function") {
            const metadata = await sock.groupMetadata(jid);
            return {
                ok: true,
                jid,
                code: "",
                subject: String(metadata?.subject || metadata?.name || jid),
            };
        }
    } catch {}

    return {
        ok: true,
        jid,
        code: "",
        subject: jid,
    };
}

async function sendRemoteInvalidGroup(sock, msg) {
    await reply(sock, msg, "❌ ID/kode grup tidak valid.\nGunakan .grouplist untuk melihat daftar grup.");
}

async function handleRemoteReflectionCommand(sock, msg, context = {}) {
    const text = String(context.text ?? getIncomingText(msg)).trim();
    if (!isRemoteReflectionCommand(text)) return false;

    const from = context.from || context.remoteJid || msg?.key?.remoteJid || "";
    const isGroupChat = Boolean(context.isGroup || isGroupJid(from));

    if (isGroupChat) {
        await reply(sock, msg, "ℹ️ Command ini dijalankan lewat private chat owner dengan bot.\nGunakan .grouplist untuk melihat ID grup.");
        return true;
    }

    if (!canUseRemoteReflectionCommand(msg, context)) {
        await reply(sock, msg, "❌ Command ini hanya untuk owner bot.");
        return true;
    }

    const parts = splitRemoteCommand(text);
    const action = String(parts[1] || "help").toLowerCase();

    if (!action || action === "help") {
        await reply(sock, msg, buildRemoteReflectionHelpText());
        return true;
    }

    if (action === "list") {
        const entries = listGroupReflectionModes();
        if (!entries.length) {
            await reply(sock, msg, "📋 Belum ada grup dengan setting renungan khusus.\nSemua grup masih memakai mode default/random.");
            return true;
        }

        const lines = ["📋 *Grup Dengan Setting Renungan Khusus*", ""];
        for (const [index, entry] of entries.entries()) {
            const target = await resolveRemoteGroupTarget(sock, entry.jid, context);
            lines.push(`${index + 1}. ${target.subject || entry.jid}`);
            lines.push(`ID: ${entry.jid}`);
            lines.push(`Mode: ${getReflectionModeLabel(entry.mode)}`);
            lines.push("");
        }

        await reply(sock, msg, lines.join("\n").trim());
        return true;
    }

    const groupRef = parts[2];
    if (!groupRef) {
        await sendRemoteInvalidGroup(sock, msg);
        return true;
    }

    const target = await resolveRemoteGroupTarget(sock, groupRef, context);
    if (!target?.ok || !target.jid) {
        await sendRemoteInvalidGroup(sock, msg);
        return true;
    }

    if (action === "status") {
        const pref = getGroupReflectionMode(target.jid);
        const lines = [
            "🕊️ *Status Renungan Anti Kasar*",
            "",
            `Grup: ${target.subject || target.jid}`,
            `ID: ${target.jid}`,
            `Mode Renungan: ${getReflectionModeLabel(pref.mode)}`,
        ];

        if (pref.source === "group") {
            lines.push(`Updated By: ${pref.updatedBy || "-"}`);
            lines.push(`Updated At: ${formatRemoteTimestamp(pref.updatedAt)}`);
        }

        await reply(sock, msg, lines.join("\n"));
        return true;
    }

    if (action === "reset") {
        resetGroupReflectionMode(target.jid);
        await reply(sock, msg, "♻️ Setting renungan grup direset.\nGrup ini kembali memakai mode default/random.");
        return true;
    }

    if (action === "set") {
        const mode = normalizeReflectionMode(parts[3]);
        if (!mode) {
            await reply(sock, msg, "❌ Mode renungan tidak valid.\nGunakan: katolik, islam, atau random.");
            return true;
        }

        const updatedBy = context.sender || context.senderJid || msg?.key?.participant || msg?.key?.remoteJid || "owner";
        setGroupReflectionMode(target.jid, mode, updatedBy);

        if (mode === "random") {
            await reply(sock, msg, [
                "✅ Renungan anti kasar untuk grup ini dikembalikan ke mode random/default.",
                "",
                `Grup: ${target.subject || target.jid}`,
                `ID: ${target.jid}`,
            ].join("\n"));
            return true;
        }

        await reply(sock, msg, [
            `✅ Renungan anti kasar untuk grup ini disetel ke: ${getReflectionModeLabel(mode)}`,
            "",
            `Grup: ${target.subject || target.jid}`,
            `ID: ${target.jid}`,
        ].join("\n"));
        return true;
    }

    await reply(sock, msg, buildRemoteReflectionHelpText());
    return true;
}

function buildAwaitTargetText(session) {
    const actionText = session.action === "off"
        ? "dihapus dari renungan khusus"
        : session.action === "status"
            ? "dicek status renungannya"
            : `diberi renungan ${getProfileLabel(session.profile)}`;

    return [
        `🎯 Kirim target yang akan ${actionText}.`,
        "✅ Bisa kirim kontak, beberapa nomor 08/+62/628, mention target, atau reply pesan target.",
        "👥 Bisa lebih dari satu target dalam sekali kirim.",
        "❌ Ketik *.batal* untuk membatalkan.",
    ].join("\n");
}

function startTargetSession(msg, context, session) {
    const key = getSessionKey(msg, context);
    sessions.set(key, {
        ...session,
        key,
        expiresAt: Date.now() + SESSION_TTL_MS,
    });
}

function cancelSession(msg, context) {
    const key = getSessionKey(msg, context);
    return sessions.delete(key);
}

async function handleSet(sock, msg, context, profile, args) {
    const targets = await collectTargets(sock, msg, args, context);
    if (!targets.length) {
        startTargetSession(msg, context, { action: "set", profile });
        await reply(sock, msg, buildAwaitTargetText({ action: "set", profile }));
        return true;
    }

    const result = setTargets(profile, targets);
    const profileLabel = getProfileLabel(profile);
    await reply(sock, msg, [
        `Tersimpan: ${result.saved} target memakai renungan ${profileLabel}.`,
        formatTargetSummary(result.targets),
        formatSkippedSummary(result.skipped),
    ].filter(Boolean).join("\n"));
    return true;
}

async function handleOff(sock, msg, context, args) {
    const targets = await collectTargets(sock, msg, args, context);
    if (!targets.length) {
        startTargetSession(msg, context, { action: "off" });
        await reply(sock, msg, buildAwaitTargetText({ action: "off" }));
        return true;
    }

    const result = removeTargets(targets);
    await reply(sock, msg, [
        `Renungan khusus dihapus: ${result.removed}.`,
        result.missing.length ? `Tidak ditemukan: ${result.missing.map(item => formatTargetJid(item.jid)).join(", ")}` : "",
    ].filter(Boolean).join("\n"));
    return true;
}

async function handleStatus(sock, msg, context, args) {
    const targets = await collectTargets(sock, msg, args, context);
    if (!targets.length) {
        startTargetSession(msg, context, { action: "status" });
        await reply(sock, msg, buildAwaitTargetText({ action: "status" }));
        return true;
    }

    const state = loadState();
    const lines = targets.map((target, index) => {
        const pref = findPreferenceForTarget(target.jid, state);
        return formatTargetLine(pref || target, index);
    });

    await reply(sock, msg, ["Status renungan target:", ...lines].join("\n"));
    return true;
}

async function handleList(sock, msg) {
    const state = loadState();
    const entries = [
        ...Object.values(state.users || {}),
        ...Object.values(state.groups || {}),
    ].sort((a, b) => String(a.jid).localeCompare(String(b.jid)));

    if (!entries.length) {
        await reply(sock, msg, "Belum ada target renungan khusus. Target yang belum disetel akan memakai renungan random.");
        return true;
    }

    const visible = entries.slice(0, 60);
    const lines = visible.map(formatTargetLine);
    const hidden = entries.length - visible.length;

    await reply(sock, msg, [
        `Daftar target renungan khusus (${entries.length}):`,
        ...lines,
        hidden > 0 ? `...dan ${hidden} target lain.` : "",
    ].filter(Boolean).join("\n"));
    return true;
}

async function handleClear(sock, msg, context) {
    const counts = countTargets();
    if (!counts.total) {
        await reply(sock, msg, "Belum ada target renungan khusus yang perlu dihapus.");
        return true;
    }

    startTargetSession(msg, context, { action: "clear" });
    await reply(sock, msg, [
        `PERHATIAN: akan menghapus ${counts.total} target renungan khusus.`,
        `Kontak: ${counts.totalUsers}`,
        `Grup: ${counts.totalGroups}`,
        "Ketik .lanjut untuk konfirmasi, atau .batal untuk membatalkan.",
    ].join("\n"));
    return true;
}

async function handleConfirmClear(sock, msg, context) {
    const key = getSessionKey(msg, context);
    const session = sessions.get(key);
    if (!session || session.action !== "clear") {
        await reply(sock, msg, "Tidak ada proses clear renungan yang menunggu konfirmasi.");
        return true;
    }

    sessions.delete(key);
    const result = clearAllTargets();
    await reply(sock, msg, `Selesai. ${result.total} target renungan khusus sudah dihapus.`);
    return true;
}

async function handlePendingInput(sock, msg, context, text) {
    const key = getSessionKey(msg, context);
    const session = sessions.get(key);
    if (!session) return false;

    if (session.action === "clear") {
        await reply(sock, msg, "Clear renungan sedang menunggu konfirmasi. Ketik .lanjut atau .batal.");
        return true;
    }

    const targets = await collectTargets(sock, msg, text, context);
    if (!targets.length) {
        await reply(sock, msg, "Target belum terbaca. Kirim kontak, nomor 08/+62/628, mention, atau reply pesan target. Ketik .batal untuk batal.");
        return true;
    }

    sessions.delete(key);

    if (session.action === "set") {
        const result = setTargets(session.profile, targets);
        await reply(sock, msg, [
            `Tersimpan: ${result.saved} target memakai renungan ${getProfileLabel(session.profile)}.`,
            formatTargetSummary(result.targets),
            formatSkippedSummary(result.skipped),
        ].filter(Boolean).join("\n"));
        return true;
    }

    if (session.action === "off") {
        const result = removeTargets(targets);
        await reply(sock, msg, `Renungan khusus dihapus: ${result.removed}.`);
        return true;
    }

    if (session.action === "status") {
        const state = loadState();
        const lines = targets.map((target, index) => {
            const pref = findPreferenceForTarget(target.jid, state);
            return formatTargetLine(pref || target, index);
        });
        await reply(sock, msg, ["Status renungan target:", ...lines].join("\n"));
        return true;
    }

    return false;
}

async function handleCommand(sock, msg, context = {}) {
    pruneSessions();

    const text = String(context.text ?? getIncomingText(msg)).trim();
    const parsed = parseRenunganCommand(text);
    const owner = isOwnerMessage(msg, context);
    const sessionKey = getSessionKey(msg, context);
    const pendingSession = sessions.get(sessionKey);
    const lowerText = text.toLowerCase();

    if (pendingSession && (lowerText === ".batal" || lowerText === ".cancel")) {
        cancelSession(msg, context);
        await reply(sock, msg, "Pengaturan renungan dibatalkan.");
        return true;
    }

    if (pendingSession?.action === "clear" && (lowerText === ".lanjut" || lowerText === ".yes" || lowerText === ".ya")) {
        return handleConfirmClear(sock, msg, context);
    }

    if (!parsed) {
        if (owner && pendingSession) {
            return handlePendingInput(sock, msg, context, text);
        }
        return false;
    }

    if (!owner) {
        await reply(sock, msg, "Akses Ditolak");
        return true;
    }

    if (parsed.action === "cancel") {
        const hadSession = cancelSession(msg, context);
        await reply(sock, msg, hadSession ? "Pengaturan renungan dibatalkan." : "Tidak ada pengaturan renungan yang sedang menunggu target.");
        return true;
    }

    if (parsed.action === "confirm-clear") return handleConfirmClear(sock, msg, context);
    if (parsed.action === "help") {
        await reply(sock, msg, buildHelpText());
        return true;
    }
    if (parsed.action === "profiles") {
        await reply(sock, msg, buildProfilesText());
        return true;
    }
    if (parsed.action === "list") return handleList(sock, msg);
    if (parsed.action === "clear") return handleClear(sock, msg, context);
    if (parsed.action === "clear-all") {
        const result = clearAllTargets();
        await reply(sock, msg, result.total
            ? `Selesai. ${result.total} target renungan khusus sudah dihapus.`
            : "Belum ada target renungan khusus yang perlu dihapus.");
        return true;
    }
    if (parsed.action === "set") return handleSet(sock, msg, context, parsed.profile, parsed.args);
    if (parsed.action === "off") return handleOff(sock, msg, context, parsed.args);
    if (parsed.action === "status") return handleStatus(sock, msg, context, parsed.args);

    return false;
}

ensureStateFile();

module.exports = {
    handleCommand,
    handleRemoteReflectionCommand,
    getPreferenceForWarning,
    getAllowedQuoteSources,
    normalizeProfileKey,
    normalizeReflectionMode,
    normalizeUserJid,
    normalizeTargetJid,
    rememberUserAliases,
    setGroupReflectionMode,
    getGroupReflectionMode,
    resetGroupReflectionMode,
    listGroupReflectionModes,
    loadState,
};
