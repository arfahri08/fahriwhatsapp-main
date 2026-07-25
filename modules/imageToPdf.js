const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const PDFDocument = require("pdfkit");
const messageCleaner = require("./messageCleaner");

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

function isPdfCommand(text) {
    return /^\.pdf(?:\s|$)/i.test(String(text || "").trim());
}

function getCommandText(msg, fallbackText = "") {
    const message = unwrapMessage(msg?.message || {});
    return String(
        fallbackText ||
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        ""
    ).trim();
}

function sanitizeFileName(value) {
    const clean = String(value || "")
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
        .replace(/\s+/g, "_")
        .replace(/^\.+/, "")
        .slice(0, 80);

    return clean || null;
}

function getPdfFileName(text) {
    const requested = sanitizeFileName(String(text || "").replace(/^\.pdf/i, ""));
    const baseName = requested || `Dokumen_${Date.now()}`;
    return baseName.toLowerCase().endsWith(".pdf") ? baseName : `${baseName}.pdf`;
}

function getQuotedImageTarget(msg) {
    const message = unwrapMessage(msg?.message || {});
    const contextInfo =
        message.extendedTextMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.documentMessage?.contextInfo ||
        {};

    const quoted = unwrapMessage(contextInfo.quotedMessage || {});
    if (!quoted.imageMessage) return null;

    return {
        key: {
            remoteJid: contextInfo.remoteJid || msg.key?.remoteJid,
            id: contextInfo.stanzaId,
            participant: contextInfo.participant,
            fromMe: false,
        },
        message: quoted,
    };
}

function getDirectImageTarget(msg, text) {
    const message = unwrapMessage(msg?.message || {});
    if (!message.imageMessage) return null;
    if (!isPdfCommand(message.imageMessage.caption || text)) return null;

    return {
        ...msg,
        message,
    };
}

function getImageTarget(msg, text) {
    return getDirectImageTarget(msg, text) || (isPdfCommand(text) ? getQuotedImageTarget(msg) : null);
}

async function downloadImage(sock, targetMsg) {
    return downloadMediaMessage(
        targetMsg,
        "buffer",
        {},
        { reuploadRequest: sock.updateMediaMessage }
    );
}

function imageBufferToPdf(buffer) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
        const chunks = [];

        doc.on("data", chunk => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        const image = doc.openImage(buffer);
        doc.addPage({ size: [image.width, image.height], margin: 0 });
        doc.image(buffer, 0, 0, { width: image.width, height: image.height });
        doc.end();
    });
}

async function handleImageToPdf(sock, msg, context = {}) {
    const from = context.from || msg?.key?.remoteJid;
    const text = getCommandText(msg, context.text);
    if (!isPdfCommand(text) && !getDirectImageTarget(msg, text)) return false;

    const targetMsg = getImageTarget(msg, text);
    if (!targetMsg) {
        await sock.sendMessage(from, {
            text: "Kirim gambar dengan caption *.pdf* atau reply gambar lalu ketik *.pdf*.",
        }, { quoted: msg });
        return true;
    }

    let waitingMsg = null;
    try {
        await sock.sendPresenceUpdate("composing", from).catch(() => {});
        waitingMsg = await messageCleaner.sendTemporary(sock, from, "Sedang convert gambar ke PDF...");

        const imageBuffer = await downloadImage(sock, targetMsg);
        const pdfBuffer = await imageBufferToPdf(imageBuffer);

        await messageCleaner.deleteMessageObject(sock, from, waitingMsg, "status PDF");
        waitingMsg = null;

        await sock.sendMessage(from, {
            document: pdfBuffer,
            mimetype: "application/pdf",
            fileName: getPdfFileName(text),
            caption: "Berhasil convert gambar ke PDF!",
        }, { quoted: msg });
    } catch (error) {
        console.log(`[IMAGE PDF] Gagal convert gambar ke PDF: ${error.message}`);
        if (waitingMsg) await messageCleaner.deleteMessageObject(sock, from, waitingMsg, "status PDF");
        await sock.sendMessage(from, {
            text: `Gagal convert gambar ke PDF: ${error.message}`,
        }, { quoted: msg });
    }

    return true;
}

module.exports = {
    handleImageToPdf,
    imageBufferToPdf,
};
