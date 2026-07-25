const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "../data/lidAliases.json");

function ensureDataFile() {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "{}\n");
}

function loadState() {
    ensureDataFile();
    try {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function saveState(state) {
    ensureDataFile();
    fs.writeFileSync(DATA_FILE, `${JSON.stringify(state || {}, null, 2)}\n`);
}

function normalizeNumber(value) {
    let number = String(value || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
    if (number.startsWith("0")) number = `62${number.slice(1)}`;
    if (number.startsWith("8")) number = `62${number}`;
    return number;
}

function normalizeJid(value) {
    const clean = String(value || "").trim();
    if (!clean) return null;

    if (/@lid$/i.test(clean)) return normalizeLidJid(clean);
    if (/@s\.whatsapp\.net$/i.test(clean)) return normalizePnJid(clean);
    return normalizePnJid(clean);
}

function normalizePnJid(value) {
    const clean = String(value || "").trim();
    if (!clean) return null;
    if (/@lid$/i.test(clean)) return null;

    const number = normalizeNumber(clean);
    return number ? `${number}@s.whatsapp.net` : null;
}

function normalizeLidJid(value) {
    const clean = String(value || "").trim();
    if (!/@lid$/i.test(clean)) return null;

    const number = normalizeNumber(clean);
    return number ? `${number}@lid` : null;
}

function normalizeMeta(meta = {}) {
    return {
        source: meta.source || "unknown",
        pushName: String(meta.pushName || ""),
        messageId: String(meta.messageId || ""),
        remoteJid: String(meta.remoteJid || ""),
        remoteJidAlt: String(meta.remoteJidAlt || ""),
        participant: String(meta.participant || ""),
        participantAlt: String(meta.participantAlt || ""),
        boundBy: String(meta.boundBy || ""),
    };
}

function mergeEntry(existing, lid, meta = {}) {
    const now = Date.now();
    const safeMeta = normalizeMeta(meta);
    return {
        ...(existing || {}),
        lid,
        source: safeMeta.source || existing?.source || "unknown",
        pushName: safeMeta.pushName || existing?.pushName || "",
        firstSeenAt: existing?.firstSeenAt || now,
        lastSeenAt: now,
        lastMessageId: safeMeta.messageId || existing?.lastMessageId || "",
        lastRemoteJid: safeMeta.remoteJid || existing?.lastRemoteJid || "",
        remoteJidAlt: safeMeta.remoteJidAlt || existing?.remoteJidAlt || "",
        participant: safeMeta.participant || existing?.participant || "",
        participantAlt: safeMeta.participantAlt || existing?.participantAlt || "",
        boundBy: safeMeta.boundBy || existing?.boundBy || "",
        notes: Array.isArray(existing?.notes) ? existing.notes : [],
    };
}

function rememberSeenLid(lid, meta = {}) {
    const normalizedLid = normalizeLidJid(lid);
    if (!normalizedLid) return { saved: false, reason: "invalid-lid" };

    const state = loadState();
    state[normalizedLid] = mergeEntry(state[normalizedLid], normalizedLid, meta);
    saveState(state);
    return { saved: true, entry: state[normalizedLid] };
}

function rememberAlias(lid, pn, meta = {}) {
    const normalizedLid = normalizeLidJid(lid);
    const normalizedPn = normalizePnJid(pn);
    if (!normalizedLid || !normalizedPn) {
        return { saved: false, reason: "invalid-lid-or-pn" };
    }

    const state = loadState();
    state[normalizedLid] = {
        ...mergeEntry(state[normalizedLid], normalizedLid, meta),
        pn: normalizedPn,
    };
    saveState(state);
    return { saved: true, entry: state[normalizedLid] };
}

function getAlias(lid) {
    const normalizedLid = normalizeLidJid(lid);
    if (!normalizedLid) return null;
    return loadState()[normalizedLid] || null;
}

function getPnForLid(lid) {
    const entry = getAlias(lid);
    return normalizePnJid(entry?.pn);
}

function removeAlias(lid) {
    const normalizedLid = normalizeLidJid(lid);
    if (!normalizedLid) return { removed: false, reason: "invalid-lid" };

    const state = loadState();
    if (!state[normalizedLid]) return { removed: false, reason: "not-found" };
    delete state[normalizedLid];
    saveState(state);
    return { removed: true, lid: normalizedLid };
}

function listAliases() {
    return Object.values(loadState())
        .sort((a, b) => Number(b?.lastSeenAt || 0) - Number(a?.lastSeenAt || 0));
}

function resolveBestJid(value) {
    const lid = normalizeLidJid(value);
    if (lid) return getPnForLid(lid) || lid;
    return normalizePnJid(value) || normalizeJid(value);
}

function getDebugInfo(value) {
    const lid = normalizeLidJid(value);
    if (lid) return getAlias(lid) || { lid, pn: null, found: false };

    const pn = normalizePnJid(value);
    if (!pn) return { input: value, found: false };

    const matches = listAliases().filter(entry => normalizePnJid(entry?.pn) === pn);
    return { pn, matches, found: matches.length > 0 };
}

ensureDataFile();

module.exports = {
    DATA_FILE,
    normalizeJid,
    normalizePnJid,
    normalizeLidJid,
    rememberAlias,
    rememberSeenLid,
    getPnForLid,
    getAlias,
    removeAlias,
    listAliases,
    resolveBestJid,
    getDebugInfo,
};
