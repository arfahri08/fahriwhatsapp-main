const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const BACKUP_FILE_NAME = "backup.zip";
const BACKUP_FILE_PATH = path.join(ROOT_DIR, BACKUP_FILE_NAME);
const TEMP_BACKUP_FILE_PATH = `${BACKUP_FILE_PATH}.tmp`;

const EXCLUDED_DIRS = new Set([
    "node_modules",
    ".git",
    ".vscode",
]);

let backupInProgress = false;

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let crc = i;
        for (let j = 0; j < 8; j += 1) {
            crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
        }
        table[i] = crc >>> 0;
    }
    return table;
})();

function isBackupCommand(text) {
    return /^\.backup(?:\s|$)/i.test(String(text || "").trim());
}

function toZipPath(filePath) {
    return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function shouldSkipEntry(entryPath, dirent) {
    const baseName = path.basename(entryPath);
    const lowerBaseName = baseName.toLowerCase();

    if (entryPath === BACKUP_FILE_PATH || entryPath === TEMP_BACKUP_FILE_PATH) return true;
    if (dirent.isDirectory() && (EXCLUDED_DIRS.has(baseName) || EXCLUDED_DIRS.has(lowerBaseName))) return true;
    if (dirent.isDirectory() && /^auth_backup_/i.test(baseName)) return true;

    return false;
}

function walkFiles(dirPath, files = [], skipped = []) {
    let entries = [];

    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (error) {
        skipped.push({ path: toZipPath(dirPath), reason: error.message });
        return { files, skipped };
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const fullPath = path.join(dirPath, entry.name);

        if (shouldSkipEntry(fullPath, entry)) continue;

        if (entry.isDirectory()) {
            walkFiles(fullPath, files, skipped);
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }

    return { files, skipped };
}

function crc32(buffer) {
    let crc = 0xFFFFFFFF;
    for (const byte of buffer) {
        crc = CRC32_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function getDosDateTime(dateValue) {
    const date = dateValue instanceof Date ? dateValue : new Date();
    const year = Math.max(1980, date.getFullYear());
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = Math.floor(date.getSeconds() / 2);

    return {
        time: (hours << 11) | (minutes << 5) | seconds,
        date: ((year - 1980) << 9) | (month << 5) | day,
    };
}

function createLocalFileHeader(fileNameBuffer, stats, dataBuffer) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(stats.dosTime, 10);
    header.writeUInt16LE(stats.dosDate, 12);
    header.writeUInt32LE(stats.crc, 14);
    header.writeUInt32LE(dataBuffer.length, 18);
    header.writeUInt32LE(dataBuffer.length, 22);
    header.writeUInt16LE(fileNameBuffer.length, 26);
    header.writeUInt16LE(0, 28);
    return Buffer.concat([header, fileNameBuffer]);
}

function createCentralDirectoryHeader(fileNameBuffer, stats, dataBuffer, localHeaderOffset) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(stats.dosTime, 12);
    header.writeUInt16LE(stats.dosDate, 14);
    header.writeUInt32LE(stats.crc, 16);
    header.writeUInt32LE(dataBuffer.length, 20);
    header.writeUInt32LE(dataBuffer.length, 24);
    header.writeUInt16LE(fileNameBuffer.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(localHeaderOffset, 42);
    return Buffer.concat([header, fileNameBuffer]);
}

function createEndOfCentralDirectory(entryCount, centralDirectorySize, centralDirectoryOffset) {
    const footer = Buffer.alloc(22);
    footer.writeUInt32LE(0x06054b50, 0);
    footer.writeUInt16LE(0, 4);
    footer.writeUInt16LE(0, 6);
    footer.writeUInt16LE(entryCount, 8);
    footer.writeUInt16LE(entryCount, 10);
    footer.writeUInt32LE(centralDirectorySize, 12);
    footer.writeUInt32LE(centralDirectoryOffset, 16);
    footer.writeUInt16LE(0, 20);
    return footer;
}

function formatBytes(value) {
    const size = Number(value || 0);
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function createZipArchive(filePaths) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    let totalInputBytes = 0;

    for (const filePath of filePaths) {
        const relativePath = toZipPath(filePath);
        const fileNameBuffer = Buffer.from(relativePath, "utf8");
        const stat = fs.statSync(filePath);
        const dataBuffer = fs.readFileSync(filePath);
        const dos = getDosDateTime(stat.mtime);
        const stats = {
            crc: crc32(dataBuffer),
            dosTime: dos.time,
            dosDate: dos.date,
        };
        const localHeader = createLocalFileHeader(fileNameBuffer, stats, dataBuffer);
        const centralHeader = createCentralDirectoryHeader(fileNameBuffer, stats, dataBuffer, offset);

        localParts.push(localHeader, dataBuffer);
        centralParts.push(centralHeader);
        offset += localHeader.length + dataBuffer.length;
        totalInputBytes += dataBuffer.length;
    }

    const centralDirectoryOffset = offset;
    const centralDirectory = Buffer.concat(centralParts);
    const footer = createEndOfCentralDirectory(filePaths.length, centralDirectory.length, centralDirectoryOffset);

    return {
        archive: Buffer.concat([...localParts, centralDirectory, footer]),
        totalInputBytes,
    };
}

function createBackup() {
    const { files, skipped } = walkFiles(ROOT_DIR);
    if (files.length === 0) throw new Error("Tidak ada file yang bisa dibackup.");

    const { archive, totalInputBytes } = createZipArchive(files);

    fs.writeFileSync(TEMP_BACKUP_FILE_PATH, archive);
    fs.renameSync(TEMP_BACKUP_FILE_PATH, BACKUP_FILE_PATH);

    return {
        filePath: BACKUP_FILE_PATH,
        fileName: BACKUP_FILE_NAME,
        fileCount: files.length,
        skippedCount: skipped.length,
        sizeBytes: archive.length,
        sourceBytes: totalInputBytes,
    };
}

async function handleBackupCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim();
    if (!isBackupCommand(text)) return false;

    const replyJid = context.ownerJid || context.from || msg?.key?.remoteJid;
    const quoted = replyJid === msg?.key?.remoteJid ? { quoted: msg } : {};

    if (!context.isOwner) {
        await sock.sendMessage(replyJid, { text: "Akses Ditolak" }, quoted);
        return true;
    }

    if (backupInProgress) {
        await sock.sendMessage(replyJid, { text: "Backup masih berjalan, tunggu sampai selesai." }, quoted);
        return true;
    }

    backupInProgress = true;
    let statusMsg = null;

    try {
        statusMsg = await sock.sendMessage(replyJid, {
            text: "Membuat backup.zip... file lama akan ditimpa.",
        }, quoted);

        const result = createBackup();
        const caption = [
            "Backup selesai.",
            `File: ${result.fileName}`,
            `Isi: ${result.fileCount} file`,
            `Ukuran: ${formatBytes(result.sizeBytes)}`,
            result.skippedCount ? `Dilewati: ${result.skippedCount} item` : null,
            "",
            "Backup lama sudah ditimpa oleh file baru.",
        ].filter(Boolean).join("\n");

        await sock.sendMessage(replyJid, {
            document: { url: result.filePath },
            mimetype: "application/zip",
            fileName: result.fileName,
            caption,
        }, quoted);

        return true;
    } catch (error) {
        console.log("[BACKUP] Gagal membuat backup:", {
            errorMessage: error.message,
            stack: error.stack,
        });
        await sock.sendMessage(replyJid, {
            text: `Gagal membuat backup: ${error.message}`,
        }, quoted);
        return true;
    } finally {
        backupInProgress = false;
        statusMsg = statusMsg || null;
    }
}

module.exports = {
    BACKUP_FILE_NAME,
    BACKUP_FILE_PATH,
    createBackup,
    handleBackupCommand,
};
