const axios = require("axios");
const FormData = require("form-data");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");

const HELP_CONFIG = {
    name: "Visual QR Generator",
    desc: "Mengubah gambar yang dikirim menjadi kode QR artistik yang jika dipindai akan menampilkan kembali gambar asli tersebut.",
};

const CATBOX_UPLOAD_URL = "https://catbox.moe/user/api.php";
const QUICKCHART_QR_URL = "https://quickchart.io/qr";
const QUICKCHART_WATERMARK_URL = "https://quickchart.io/watermark";
const DOWNLOAD_TIMEOUT_MS = Number(process.env.QR_ART_DOWNLOAD_TIMEOUT_MS || 30000);
const UPLOAD_TIMEOUT_MS = Number(process.env.QR_ART_UPLOAD_TIMEOUT_MS || 45000);
const QR_TIMEOUT_MS = Number(process.env.QR_ART_GENERATE_TIMEOUT_MS || 45000);
const MAX_IMAGE_BYTES = Number(process.env.QR_ART_MAX_IMAGE_BYTES || 20 * 1024 * 1024);

function normalizeJid(value) {
    const clean = String(value || "").trim();
    if (!clean) return null;

    if (clean.includes("@")) {
        const [rawUser, server] = clean.split("@");
        const user = rawUser.split(":")[0].split("_")[0].replace(/[^0-9]/g, "");
        if (!user || !server) return null;
        return `${user}@${server === "c.us" ? "s.whatsapp.net" : server}`;
    }

    const number = clean.replace(/[^0-9]/g, "");
    return number ? `${number}@s.whatsapp.net` : null;
}

function getJidUser(value) {
    return String(value || "").split("@")[0].split(":")[0].split("_")[0].replace(/[^0-9]/g, "");
}

function isSameUserJid(a, b) {
    const userA = getJidUser(a);
    const userB = getJidUser(b);
    return Boolean(userA && userB && userA === userB);
}

function getSenderJid(msg) {
    const remoteJid = msg?.key?.remoteJid || "";
    if (remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") {
        return msg?.key?.participant || msg?.participant || remoteJid;
    }
    return remoteJid;
}

function isOwnerMessage(msg, ownerJid) {
    if (msg?.key?.fromMe) return true;

    const normalizedOwner = normalizeJid(ownerJid);
    const senderJid = normalizeJid(getSenderJid(msg));
    const chatJid = normalizeJid(msg?.key?.remoteJid);

    return isSameUserJid(senderJid, normalizedOwner) || isSameUserJid(chatJid, normalizedOwner);
}

function unwrapMessage(message = {}) {
    let current = message || {};

    for (let i = 0; i < 6; i += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
        else if (current.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message;
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
        else break;
    }

    return current || {};
}

function getText(message = {}) {
    const current = unwrapMessage(message);
    return String(
        current.conversation ||
        current.extendedTextMessage?.text ||
        current.imageMessage?.caption ||
        current.videoMessage?.caption ||
        current.documentMessage?.caption ||
        ""
    ).trim();
}

function getQuotedContext(message = {}) {
    return (
        message.extendedTextMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.documentMessage?.contextInfo ||
        null
    );
}

function isMakeQrCommand(text) {
    return /^\.makeqr(?:\s|$)/i.test(String(text || "").trim());
}

function getTargetImageMessage(msg) {
    const message = unwrapMessage(msg?.message || {});
    const text = getText(msg?.message || {});

    if (!isMakeQrCommand(text)) return null;
    if (message.imageMessage) return message.imageMessage;

    const contextInfo = getQuotedContext(message);
    const quotedMessage = unwrapMessage(contextInfo?.quotedMessage || {});
    return quotedMessage.imageMessage || null;
}

async function downloadImageBuffer(imageMessage) {
    const chunks = [];
    const stream = await downloadContentFromMessage(imageMessage, "image", {
        options: { timeout: DOWNLOAD_TIMEOUT_MS },
    });

    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    if (!buffer.length) throw new Error("Gambar kosong atau gagal diunduh.");
    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error(`Ukuran gambar terlalu besar. Maksimal ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`);
    }

    return buffer;
}

async function uploadToCatbox(buffer, mimeType = "image/jpeg") {
    const form = new FormData();
    form.append("reqtype", "fileupload");

    if (process.env.CATBOX_USERHASH) {
        form.append("userhash", process.env.CATBOX_USERHASH);
    }

    form.append("fileToUpload", buffer, {
        filename: `visual_qr_${Date.now()}.jpg`,
        contentType: mimeType,
        knownLength: buffer.length,
    });

    const response = await axios.post(CATBOX_UPLOAD_URL, form, {
        headers: form.getHeaders(),
        timeout: UPLOAD_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: status => status >= 200 && status < 500,
    });

    const imageUrl = String(response.data || "").trim();
    if (response.status >= 400 || !/^https?:\/\//i.test(imageUrl)) {
        throw new Error(`Upload Catbox gagal: ${imageUrl || `HTTP ${response.status}`}`);
    }

    return imageUrl;
}

function buildQuickChartQrUrl(imageUrl) {
    const params = new URLSearchParams({
        text: imageUrl,
        format: "png",
        size: "900",
        margin: "2",
        ecLevel: "H",
        dark: "111827",
        light: "fffdf7",
        finderColor: "0f766e",
        dotStyle: "rounded",
        finderStyle: "circle",
        finderDotStyle: "dot",
        centerImageUrl: imageUrl,
        centerImageSizeRatio: "0.28",
        caption: "USERBOT",
        captionFontFamily: "sans-serif",
        captionFontSize: "28",
        captionFontColor: "111827",
    });

    return `${QUICKCHART_QR_URL}?${params.toString()}`;
}

function buildWatermarkedQrUrl(qrUrl, imageUrl) {
    const params = new URLSearchParams({
        mainImageUrl: qrUrl,
        markImageUrl: imageUrl,
        markRatio: "0.9",
        position: "center",
        opacity: String(process.env.QR_ART_WATERMARK_OPACITY || "0.08"),
        margin: "0",
        imageWidth: "900",
    });

    return `${QUICKCHART_WATERMARK_URL}?${params.toString()}`;
}

async function createVisualQrBuffer(imageUrl) {
    const baseQrUrl = buildQuickChartQrUrl(imageUrl);
    const visualQrUrl = buildWatermarkedQrUrl(baseQrUrl, imageUrl);

    try {
        const response = await axios.get(visualQrUrl, {
            responseType: "arraybuffer",
            timeout: QR_TIMEOUT_MS,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            validateStatus: status => status >= 200 && status < 500,
        });

        if (response.status >= 400) throw new Error(`QuickChart HTTP ${response.status}`);
        return Buffer.from(response.data);
    } catch (error) {
        const response = await axios.get(baseQrUrl, {
            responseType: "arraybuffer",
            timeout: QR_TIMEOUT_MS,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
        });

        if (response.status >= 400) throw new Error(error.message);
        return Buffer.from(response.data);
    }
}

async function notifyError(sock, ownerJid, error) {
    try {
        await sock.sendMessage(ownerJid, {
            text:
                `❌ *VISUAL QR GAGAL DIBUAT*\n\n` +
                `Error: ${error.message}\n\n` +
                `Kemungkinan penyebab:\n` +
                `• Upload gambar ke Catbox sedang gagal/limit\n` +
                `• QuickChart sedang tidak bisa membuat QR\n` +
                `• Koneksi server sedang timeout`,
        });
    } catch (sendError) {
        console.log(`[VisualQR] Gagal mengirim laporan error: ${sendError.message}`);
    }
}

async function handleVisualQR(msg, sock, ownerJid) {
    if (!msg?.message || !sock || !ownerJid) return false;
    if (!isOwnerMessage(msg, ownerJid)) return false;

    const text = getText(msg.message);
    if (!isMakeQrCommand(text)) return false;

    const imageMessage = getTargetImageMessage(msg);
    const destinationJid = normalizeJid(ownerJid) || ownerJid;
    if (!imageMessage) {
        await sock.sendMessage(destinationJid, {
            text:
                `📌 *VISUAL QR GENERATOR*\n\n` +
                `Fitur ini hanya jalan kalau pakai command.\n\n` +
                `Cara pakai:\n` +
                `• Kirim gambar dengan caption *.makeqr*\n` +
                `• Atau reply gambar lalu ketik *.makeqr*`,
        });
        return true;
    }

    try {
        console.log("[VisualQR] Mengunduh gambar owner...");
        const imageBuffer = await downloadImageBuffer(imageMessage);

        console.log("[VisualQR] Mengunggah gambar ke Catbox...");
        const imageUrl = await uploadToCatbox(imageBuffer, imageMessage.mimetype || "image/jpeg");

        console.log("[VisualQR] Membuat visual QR via QuickChart...");
        const qrBuffer = await createVisualQrBuffer(imageUrl);

        await sock.sendMessage(destinationJid, {
            image: qrBuffer,
            caption:
                `✨ *VISUAL QR CODE BERHASIL DICIPTAKAN*\n\n` +
                `Silakan pindai kode QR di atas untuk melihat kembali gambar asli yang kamu kirimkan!\n` +
                `• *Tautan Gambar:* ${imageUrl}`,
        });

        return true;
    } catch (error) {
        console.log(`[VisualQR] Error: ${error.message}`);
        await notifyError(sock, destinationJid, error);
        return true;
    }
}

module.exports = {
    HELP_CONFIG,
    handleVisualQR,
};
