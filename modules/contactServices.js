"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")
const groupRuntimePolicy = require("./groupRuntimePolicy")
const groupCommon = require("./groupUtilityCommon")
const identity = require("./canonicalIdentity")
const defaultContactNameStore = require("./contactNameStore")

const FEATURE_NAME = "groupUtilities"

function escapeVcf(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n").trim()
}

function buildVcfCard(entry) {
    const name = escapeVcf(entry.name || entry.number || "WhatsApp Contact")
    const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${name}`, `N:${name};;;;`]
    if (entry.number) lines.push(`TEL;TYPE=CELL;TYPE=VOICE;waid=${entry.number}:+${entry.number}`)
    if (entry.jid) lines.push(`X-WA-JID:${escapeVcf(entry.jid)}`)
    lines.push("END:VCARD")
    return lines.join("\r\n")
}

function buildGroupVcf(metadata, sock, context = {}) {
    const contactStore = context.contactNameStore || defaultContactNameStore
    const participants = groupCommon.dedupeParticipants(metadata, context, { sock, omitBot: true })
    const seen = new Set()
    const contacts = []
    for (const item of participants) {
        const canonical = identity.participantIdentity(item.participant, context)
        if (!canonical.key || seen.has(canonical.key)) continue
        seen.add(canonical.key)
        const number = canonical.type === "pn" ? canonical.number : ""
        const fallbacks = [item.participant?.notify, item.participant?.name, number]
        const name = contactStore?.resolveContactName?.(canonical.jid, fallbacks) || fallbacks.find(Boolean) || "WhatsApp Contact"
        contacts.push({ jid: canonical.jid, number, name: String(name).slice(0, 100) })
    }
    return {
        contacts,
        text: contacts.map(buildVcfCard).join("\r\n"),
    }
}

async function handleExportVcf(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    if (!/^\.exportvcf(?:\s|$)/i.test(text)) return false
    const access = await groupCommon.resolveCommandAccess(sock, msg, FEATURE_NAME, context)
    if (access.hardDenied) return true
    if (!access.allowed) {
        await sock.sendMessage(access.groupJid, { text: "Export VCF hanya untuk admin grup atau owner bot." }, { quoted: msg })
        return true
    }
    const generated = buildGroupVcf(access.policy.metadata, sock, context)
    if (!generated.contacts.length) {
        await sock.sendMessage(access.groupJid, { text: "Tidak ada kontak valid yang dapat diekspor." }, { quoted: msg })
        return true
    }
    const tempRoot = context.tempDir || process.env.CONTACT_EXPORT_TEMP_DIR || os.tmpdir()
    const tempDir = fs.mkdtempSync(path.join(path.resolve(tempRoot), "wa-vcf-"))
    const file = path.join(tempDir, "kontak-grup.vcf")
    try {
        fs.writeFileSync(file, generated.text, { encoding: "utf8", mode: 0o600 })
        await sock.sendMessage(access.groupJid, {
            document: fs.readFileSync(file),
            mimetype: "text/vcard",
            fileName: "kontak-grup.vcf",
            caption: `${generated.contacts.length} kontak unik berhasil diekspor.`,
        }, { quoted: msg })
    } finally {
        try { fs.unlinkSync(file) } catch {}
        try { fs.rmdirSync(tempDir) } catch {}
    }
    return true
}

module.exports = {
    FEATURE_NAME,
    buildGroupVcf,
    buildVcfCard,
    escapeVcf,
    handleExportVcf,
}
