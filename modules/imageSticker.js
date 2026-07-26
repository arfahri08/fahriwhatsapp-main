const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const crypto = require("crypto");
const messageCleaner = require("./messageCleaner");

const TEMP_DIR = path.join(__dirname, "../data/sticker_tmp");
const CONFIG_FILE = path.join(__dirname, "../data/stickerPack.json");
const DEFAULT_PACK_NAME = "USERBOT FAHRI";
const DEFAULT_AUTHOR = "USERBOT FAHRI";
const FFMPEG_TIMEOUT_MS = 60 * 1000;
const VIDEO_STICKER_MAX_SECONDS = Number(process.env.STICKER_VIDEO_MAX_SECONDS || 6);
const VIDEO_STICKER_FPS = Number(process.env.STICKER_VIDEO_FPS || 12);
const VIDEO_STICKER_QUALITY = Number(process.env.STICKER_VIDEO_QUALITY || 55);
const VIDEO_STICKER_SCALE = Number(process.env.STICKER_VIDEO_SCALE || 420);
const ANIMATED_STICKER_MAX_BYTES = Number(process.env.STICKER_ANIMATED_MAX_BYTES || 450000);
const MEDIA_STICKER_MAX_BYTES = Number(process.env.STICKER_MEDIA_MAX_BYTES || 25 * 1024 * 1024);

fs.mkdirSync(TEMP_DIR, { recursive: true });

function safeUnlink(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
}

function readConfig() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) {
            return { packName: DEFAULT_PACK_NAME, author: DEFAULT_AUTHOR };
        }

        const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
        return {
            packName: String(parsed.packName || DEFAULT_PACK_NAME).trim() || DEFAULT_PACK_NAME,
            author: String(parsed.author || DEFAULT_AUTHOR).trim() || DEFAULT_AUTHOR,
        };
    } catch {
        return { packName: DEFAULT_PACK_NAME, author: DEFAULT_AUTHOR };
    }
}

function saveConfig(config) {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getPackName() {
    return readConfig().packName;
}

function setPackName(packName) {
    const clean = String(packName || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 64);
    if (!clean) return null;

    const current = readConfig();
    const next = { ...current, packName: clean };
    saveConfig(next);
    return next.packName;
}

function execFilePromise(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile(command, args, {
            windowsHide: true,
            timeout: options.timeout || FFMPEG_TIMEOUT_MS,
        }, (error, stdout, stderr) => {
            if (error) {
                const details = String(stderr || error.message || "").trim();
                reject(new Error(details || `${command} gagal dijalankan.`));
                return;
            }

            resolve(stdout);
        });

        child.on("error", reject);
    });
}

function makeTempPath(ext) {
    const id = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    return path.join(TEMP_DIR, `stiker_${id}.${ext}`);
}

function buildStickerExif(packName, author) {
    const json = {
        "sticker-pack-id": "com.userbot.fahri",
        "sticker-pack-name": packName || DEFAULT_PACK_NAME,
        "sticker-pack-publisher": author || DEFAULT_AUTHOR,
        emojis: ["🤖"],
    };
    const jsonBuffer = Buffer.from(JSON.stringify(json), "utf8");
    const exifAttr = Buffer.from([
        0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
    ]);

    exifAttr.writeUIntLE(jsonBuffer.length, 14, 4);
    return Buffer.concat([exifAttr, jsonBuffer]);
}

function appendExifChunk(webpBuffer, exifBuffer) {
    if (
        !Buffer.isBuffer(webpBuffer) ||
        webpBuffer.length < 12 ||
        webpBuffer.slice(0, 4).toString("ascii") !== "RIFF" ||
        webpBuffer.slice(8, 12).toString("ascii") !== "WEBP"
    ) {
        return webpBuffer;
    }

    const size = Buffer.alloc(4);
    size.writeUInt32LE(exifBuffer.length, 0);
    const padding = exifBuffer.length % 2 ? Buffer.from([0x00]) : Buffer.alloc(0);
    const exifChunk = Buffer.concat([Buffer.from("EXIF", "ascii"), size, exifBuffer, padding]);
    const output = Buffer.concat([webpBuffer, exifChunk]);
    output.writeUInt32LE(output.length - 8, 4);
    return output;
}

async function applyExif(rawWebpPath, finalWebpPath, packName, author, options = {}) {
    const exifBuffer = buildStickerExif(packName, author);
    const exifPath = makeTempPath("exif");
    const allowManualFallback = options.allowManualFallback !== false;

    try {
        fs.writeFileSync(exifPath, exifBuffer);
        await execFilePromise("webpmux", [
            "-set",
            "exif",
            exifPath,
            rawWebpPath,
            "-o",
            finalWebpPath,
        ], { timeout: 30 * 1000 });
        return fs.readFileSync(finalWebpPath);
    } catch (error) {
        const rawWebp = fs.readFileSync(rawWebpPath);
        if (!allowManualFallback) return rawWebp;
        return appendExifChunk(rawWebp, exifBuffer);
    } finally {
        safeUnlink(exifPath);
    }
}

async function imageBufferToSticker(buffer) {
    const inputPath = makeTempPath("png");
    const rawWebpPath = makeTempPath("webp");
    const finalWebpPath = makeTempPath("webp");
    const { packName, author } = readConfig();

    try {
        fs.writeFileSync(inputPath, buffer);

        await execFilePromise("ffmpeg", [
            "-y",
            "-i",
            inputPath,
            "-vcodec",
            "libwebp",
            "-vf",
            "scale=512:512:flags=lanczos:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000,setsar=1",
            "-preset",
            "default",
            "-loop",
            "0",
            "-an",
            "-vsync",
            "0",
            rawWebpPath,
        ]);

        return await applyExif(rawWebpPath, finalWebpPath, packName, author);
    } finally {
        safeUnlink(inputPath);
        safeUnlink(rawWebpPath);
        safeUnlink(finalWebpPath);
    }
}

function getExtensionFromMime(mimetype, fallback = "bin") {
    const clean = String(mimetype || "").split(";")[0].trim().toLowerCase();
    const map = {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
        "video/mp4": "mp4",
        "video/3gpp": "3gp",
        "video/webm": "webm",
        "video/quicktime": "mov",
    };

    if (map[clean]) return map[clean];
    const subtype = clean.split("/")[1]?.replace(/[^a-z0-9]+/g, "");
    return subtype || fallback;
}

function getExtensionFromName(fileName) {
    const ext = path.extname(String(fileName || "")).replace(".", "").toLowerCase();
    return ext && /^[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

async function animatedBufferToSticker(buffer, mediaInfo = {}) {
    const inputExt = getExtensionFromName(mediaInfo.fileName) ||
        getExtensionFromMime(mediaInfo.mimetype, mediaInfo.kind === "gif" ? "gif" : "mp4");
    const inputPath = makeTempPath(inputExt);
    const { packName, author } = readConfig();
    const maxSeconds = Math.max(1, Math.min(30, VIDEO_STICKER_MAX_SECONDS || 6));
    const fps = Math.max(6, Math.min(24, VIDEO_STICKER_FPS || 12));
    const quality = Math.max(20, Math.min(90, VIDEO_STICKER_QUALITY || 55));
    const scale = Math.max(256, Math.min(512, VIDEO_STICKER_SCALE || 420));
    const targetBytes = Math.max(250000, ANIMATED_STICKER_MAX_BYTES || 450000);
    const profiles = [
        { seconds: maxSeconds, fps, quality, scale },
        { seconds: Math.min(maxSeconds, 4), fps: Math.min(fps, 8), quality: Math.min(quality, 38), scale: Math.min(scale, 420) },
        { seconds: Math.min(maxSeconds, 3), fps: Math.min(fps, 7), quality: Math.min(quality, 32), scale: Math.min(scale, 384) },
        { seconds: Math.min(maxSeconds, 2), fps: Math.min(fps, 6), quality: Math.min(quality, 28), scale: Math.min(scale, 320) },
    ];
    let smallestBuffer = null;

    try {
        fs.writeFileSync(inputPath, buffer);

        for (const profile of profiles) {
            const rawWebpPath = makeTempPath("webp");
            const finalWebpPath = makeTempPath("webp");

            try {
                await execFilePromise("ffmpeg", [
                    "-y",
                    "-i",
                    inputPath,
                    "-t",
                    String(profile.seconds),
                    "-vcodec",
                    "libwebp",
                    "-vf",
                    `fps=${profile.fps},scale=${profile.scale}:${profile.scale}:flags=lanczos:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000,setsar=1`,
                    "-lossless",
                    "0",
                    "-compression_level",
                    "6",
                    "-q:v",
                    String(profile.quality),
                    "-preset",
                    "default",
                    "-loop",
                    "0",
                    "-an",
                    "-vsync",
                    "0",
                    rawWebpPath,
                ], { timeout: Math.max(FFMPEG_TIMEOUT_MS, profile.seconds * 15000) });

                const stickerBuffer = await applyExif(rawWebpPath, finalWebpPath, packName, author, {
                    allowManualFallback: false,
                });
                if (!smallestBuffer || stickerBuffer.length < smallestBuffer.length) {
                    smallestBuffer = stickerBuffer;
                }
                if (stickerBuffer.length <= targetBytes) return stickerBuffer;
            } finally {
                safeUnlink(rawWebpPath);
                safeUnlink(finalWebpPath);
            }
        }

        if (smallestBuffer) {
            throw new Error(
                `Hasil stiker animasi masih terlalu besar (${Math.round(smallestBuffer.length / 1024)}KB). ` +
                `Coba video/GIF yang lebih pendek atau set STICKER_VIDEO_MAX_SECONDS lebih kecil.`
            );
        }

        throw new Error("Gagal membuat stiker animasi.");
    } finally {
        safeUnlink(inputPath);
    }
}

async function mediaBufferToSticker(buffer, mediaInfo = {}) {
    if (MEDIA_STICKER_MAX_BYTES > 0 && buffer.length > MEDIA_STICKER_MAX_BYTES) {
        throw new Error(`Media terlalu besar. Maksimal ${Math.round(MEDIA_STICKER_MAX_BYTES / 1024 / 1024)}MB.`);
    }

    if (mediaInfo.kind === "video" || mediaInfo.kind === "gif") {
        return animatedBufferToSticker(buffer, mediaInfo);
    }

    return imageBufferToSticker(buffer);
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

function isStickerCommand(text) {
    return /^(?:\.s|\.sti(?:ker|cker))(?:\s|$)/i.test(String(text || "").trim());
}

function isPackNameCommand(text) {
    return /^\.nampak(?:\s|$)/i.test(String(text || "").trim());
}

function getTargetMediaInfo(message) {
    const current = unwrapMessage(message || {});

    if (current.imageMessage) {
        const mimetype = current.imageMessage.mimetype || "image/jpeg";
        return {
            kind: String(mimetype).toLowerCase().includes("image/gif") ? "gif" : "image",
            messageType: "imageMessage",
            caption: current.imageMessage.caption || "",
            mimetype,
        };
    }

    if (current.videoMessage) {
        return {
            kind: "video",
            messageType: "videoMessage",
            caption: current.videoMessage.caption || "",
            mimetype: current.videoMessage.mimetype || "video/mp4",
        };
    }

    const documentMessage = current.documentMessage;
    if (documentMessage) {
        const mimetype = String(documentMessage.mimetype || "").toLowerCase();
        const fileName = documentMessage.fileName || documentMessage.title || "";
        const fileExt = getExtensionFromName(fileName);
        const isGif = mimetype.includes("image/gif") || fileExt === "gif";
        const isVideo = mimetype.startsWith("video/") || ["mp4", "mov", "webm", "mkv", "3gp"].includes(fileExt);
        const isImage = mimetype.startsWith("image/") || ["jpg", "jpeg", "png", "webp"].includes(fileExt);

        if (isGif || isVideo || isImage) {
            return {
                kind: isGif ? "gif" : isVideo ? "video" : "image",
                messageType: "documentMessage",
                caption: documentMessage.caption || "",
                mimetype: documentMessage.mimetype || (isGif ? "image/gif" : isVideo ? "video/mp4" : "image/jpeg"),
                fileName,
            };
        }
    }

    return null;
}

function getQuotedTargetMessage(msg) {
    const message = unwrapMessage(msg?.message || {});
    const contextInfo =
        message.extendedTextMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.documentMessage?.contextInfo ||
        {};

    const quoted = unwrapMessage(contextInfo.quotedMessage || {});
    const mediaInfo = getTargetMediaInfo(quoted);
    if (!mediaInfo) return null;

    return {
        key: {
            remoteJid: msg.key.remoteJid,
            id: contextInfo.stanzaId,
            participant: contextInfo.participant,
            fromMe: false,
        },
        message: quoted,
        mediaInfo,
    };
}

function getDirectTargetMessage(msg) {
    const message = unwrapMessage(msg?.message || {});
    const mediaInfo = getTargetMediaInfo(message);
    if (!mediaInfo) return null;

    return {
        ...msg,
        message,
        mediaInfo,
    };
}

function getStickerTargetMessage(msg, text) {
    const direct = getDirectTargetMessage(msg);
    if (direct && isStickerCommand(direct.mediaInfo?.caption || text)) return direct;

    if (!isStickerCommand(text)) return null;
    return getQuotedTargetMessage(msg);
}

async function downloadTargetMedia(sock, targetMsg) {
    return downloadMediaMessage(
        targetMsg,
        "buffer",
        {},
        { reuploadRequest: sock.updateMediaMessage }
    );
}

async function handlePackNameCommand(sock, msg, context) {
    const { from, text, isOwner } = context;
    if (!isPackNameCommand(text)) return false;

    if (!isOwner) {
        await sock.sendMessage(from, { text: "Akses Ditolak" }, { quoted: msg });
        return true;
    }

    const nextPackName = text.replace(/^\.nampak/i, "").trim();
    if (!nextPackName) {
        await sock.sendMessage(from, {
            text: `🏷️ Nama pack stiker saat ini: *${getPackName()}*\n\nUbah dengan:\n*.nampak Nama Pack Baru*`,
        }, { quoted: msg });
        return true;
    }

    const savedName = setPackName(nextPackName);
    if (!savedName) {
        await sock.sendMessage(from, { text: "Nama pack tidak boleh kosong." }, { quoted: msg });
        return true;
    }

    await sock.sendMessage(from, {
        text: `✅ Nama pack stiker berhasil diubah menjadi:\n*${savedName}*`,
    }, { quoted: msg });
    return true;
}

async function handleStickerCommand(sock, msg, context = {}) {
    const from = context.from || msg?.key?.remoteJid;
    const text = context.text ?? getMessageText(msg);

    if (await handlePackNameCommand(sock, msg, { ...context, from, text })) return true;
    if (!isStickerCommand(text)) return false;

    const targetMsg = getStickerTargetMessage(msg, text);
    if (!targetMsg) {
        await sock.sendMessage(from, {
            text:
                "❌ Kirim gambar dengan caption *.s* atau *.stiker*, atau reply gambar lalu ketik *.s*.\n\n" +
                `Pack aktif: *${getPackName()}*`,
        }, { quoted: msg });
        return true;
    }

    let waitingMsg = null;
    try {
        waitingMsg = await messageCleaner.sendTemporary(sock, from, "⏳ Sedang generate stiker...");
        const mediaBuffer = await downloadTargetMedia(sock, targetMsg);
        const stickerBuffer = await mediaBufferToSticker(mediaBuffer, targetMsg.mediaInfo);

        await messageCleaner.deleteMessageObject(sock, from, waitingMsg, "status stiker");
        waitingMsg = null;

        await sock.sendMessage(from, {
            sticker: stickerBuffer,
        }, { quoted: msg });
    } catch (error) {
        console.log(`[IMAGE STICKER] Gagal generate stiker: ${error.message}`);
        if (waitingMsg) await messageCleaner.deleteMessageObject(sock, from, waitingMsg, "status stiker");

        const ffmpegHint = /ffmpeg/i.test(error.message)
            ? "\n\nPastikan ffmpeg sudah terpasang di Termux: pkg install ffmpeg"
            : "";
        await sock.sendMessage(from, {
            text: `❌ Gagal membuat stiker. Pastikan yang direply adalah gambar valid.${ffmpegHint}`,
        }, { quoted: msg });
    }

    return true;
}

module.exports = {
    handleStickerCommand,
    imageBufferToSticker,
    animatedBufferToSticker,
    mediaBufferToSticker,
    getPackName,
    setPackName,
};
