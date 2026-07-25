const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const TEMP_DIR = path.join(__dirname, "../data/fake_vn_tmp");
const FFMPEG_TIMEOUT_MS = 90 * 1000;

fs.mkdirSync(TEMP_DIR, { recursive: true });

function safeUnlink(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
}

function makeTempPath(ext) {
    const id = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    return path.join(TEMP_DIR, `fake_vn_${id}.${ext}`);
}

function unwrapMessage(message) {
    let current = message || {};

    for (let i = 0; i < 6; i += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
        else if (current.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message;
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
        else break;
    }

    return current;
}

function getMessageText(msg) {
    const message = unwrapMessage(msg?.message || {});
    return String(
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        ""
    ).trim();
}

function isFakeVnCommand(text) {
    return /^(\.vn|\.ptt)(?:\s|$)/i.test(String(text || "").trim());
}

function getContextInfo(msg) {
    const message = unwrapMessage(msg?.message || {});
    return (
        message.extendedTextMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.documentMessage?.contextInfo ||
        message.audioMessage?.contextInfo ||
        {}
    );
}

function isAudioDocument(documentMessage) {
    const mimetype = String(documentMessage?.mimetype || "").toLowerCase();
    const fileName = String(documentMessage?.fileName || "").toLowerCase();

    return (
        mimetype.startsWith("audio/") ||
        /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(fileName)
    );
}

function getQuotedAudio(msg) {
    const contextInfo = getContextInfo(msg);
    const quoted = unwrapMessage(contextInfo.quotedMessage || {});

    if (quoted.audioMessage) {
        return {
            media: quoted.audioMessage,
            streamType: "audio",
            inputExt: "audio",
        };
    }

    if (quoted.documentMessage && isAudioDocument(quoted.documentMessage)) {
        return {
            media: quoted.documentMessage,
            streamType: "document",
            inputExt: "audio",
        };
    }

    return null;
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function runFfmpeg(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        execFile("ffmpeg", [
            "-y",
            "-i",
            inputPath,
            "-vn",
            "-c:a",
            "libopus",
            "-b:a",
            "32k",
            "-vbr",
            "on",
            "-application",
            "voip",
            outputPath,
        ], {
            windowsHide: true,
            timeout: FFMPEG_TIMEOUT_MS,
        }, (error, stdout, stderr) => {
            if (error) {
                const details = String(stderr || error.message || "").trim();
                reject(new Error(details || "FFmpeg gagal convert audio."));
                return;
            }

            resolve(stdout);
        });
    });
}

async function safeSend(sock, jid, message, options = {}) {
    try {
        return await sock.sendMessage(jid, message, options);
    } catch (error) {
        console.log(`[FAKE VN] Gagal kirim pesan: ${error.message}`);
        return null;
    }
}

async function handleFakeVn(msg, sock) {
    const jid = msg?.key?.remoteJid;
    if (!jid || !msg?.message) return false;

    const text = getMessageText(msg);
    if (!isFakeVnCommand(text)) return false;

    const quotedAudio = getQuotedAudio(msg);
    if (!quotedAudio) {
        await safeSend(sock, jid, {
            text: "❌ Gagal! Silakan balas/reply sebuah file audio/MP3 terlebih dahulu dengan ketik .vn",
        }, { quoted: msg });
        return true;
    }

    let inputPath = null;
    let outputPath = null;
    let statusMsg = null;

    try {
        statusMsg = await safeSend(sock, jid, {
            text: "⏳ Sedang mengubah audio menjadi Voice Note...",
        }, { quoted: msg });

        inputPath = makeTempPath(quotedAudio.inputExt || "audio");
        outputPath = makeTempPath("opus");

        const stream = await downloadContentFromMessage(quotedAudio.media, quotedAudio.streamType);
        const buffer = await streamToBuffer(stream);
        if (!buffer.length) throw new Error("Audio kosong atau gagal diunduh.");

        fs.writeFileSync(inputPath, buffer);
        await runFfmpeg(inputPath, outputPath);

        if (!fs.existsSync(outputPath)) throw new Error("File output opus tidak ditemukan.");

        await safeSend(sock, jid, {
            audio: fs.readFileSync(outputPath),
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
        }, { quoted: msg });

        if (statusMsg?.key) {
            try {
                await sock.sendMessage(jid, { delete: statusMsg.key });
            } catch {}
        }
    } catch (error) {
        console.log(`[FAKE VN] Gagal convert VN: ${error.message}`);

        const ffmpegHint = /ffmpeg|libopus|not recognized|not found|no such file/i.test(error.message)
            ? "\n\nPastikan FFmpeg sudah terpasang di Termux: pkg install ffmpeg"
            : "";

        await safeSend(sock, jid, {
            text: `❌ Gagal mengubah audio menjadi Voice Note.${ffmpegHint}`,
        }, { quoted: msg });
    } finally {
        safeUnlink(inputPath);
        safeUnlink(outputPath);
    }

    return true;
}

module.exports = {
    handleFakeVn,
};
