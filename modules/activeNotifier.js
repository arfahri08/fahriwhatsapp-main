const DEFAULT_NOTIFY_TARGETS = ["6288287764273@s.whatsapp.net"];
const DEFAULT_COOLDOWN_MS = 60 * 1000;

let lastSentAt = 0;

function normalizeJid(value) {
    const clean = String(value || "").trim();
    if (!clean) return null;
    if (clean.endsWith("@s.whatsapp.net")) return clean;

    const number = clean.replace(/[^0-9]/g, "");
    if (!number) return null;
    return `${number}@s.whatsapp.net`;
}

function getTargets(fallbackTargets = DEFAULT_NOTIFY_TARGETS) {
    if (/^(0|false|off)$/i.test(String(process.env.ACTIVE_NOTIFY || ""))) return [];

    const rawTargets = process.env.ACTIVE_NOTIFY_JIDS || process.env.OWNER_JID || "";
    const source = rawTargets
        ? rawTargets.split(",")
        : fallbackTargets;

    return [...new Set(source.map(normalizeJid).filter(Boolean))]
        .filter(jid => jid.endsWith("@s.whatsapp.net"));
}

function formatJakartaTime(date = new Date()) {
    return new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Jakarta",
        dateStyle: "medium",
        timeStyle: "medium",
    }).format(date);
}

function getActiveText(date = new Date()) {
    return (
        `✅ *USERBOT FAHRI AKTIF*\n\n` +
        `Bot sudah tersambung ke WhatsApp.\n` +
        `Waktu: ${formatJakartaTime(date)}\n\n` +
        `_Notifikasi otomatis setelah restart / reconnect._`
    );
}

async function notifyActive(sock, fallbackTargets, options = {}) {
    const targets = getTargets(fallbackTargets);
    if (targets.length === 0) return [];

    const cooldownMs = Number(process.env.ACTIVE_NOTIFY_COOLDOWN_MS || DEFAULT_COOLDOWN_MS);
    const now = Date.now();
    if (!options.force && cooldownMs > 0 && now - lastSentAt < cooldownMs) return [];

    lastSentAt = now;
    const text = getActiveText();

    const sentMessages = [];
    for (const jid of targets) {
        try {
            const sent = await sock.sendMessage(jid, { text });
            if (sent?.key?.id) {
                sentMessages.push({
                    jid,
                    key: sent.key,
                });
            }
        } catch (error) {
            console.log(`[ACTIVE] Gagal kirim notifikasi ke ${jid}: ${error.message}`);
        }
    }

    return sentMessages;
}

module.exports = {
    notifyActive,
    getTargets,
    getActiveText,
};
