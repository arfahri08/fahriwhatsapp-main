const fs = require("fs")
const path = require("path")
const axios = require("axios")
const { spawn } = require("child_process")

const TMP_DIR = path.join(__dirname, "..", "tmp", "spotify")
const SPOTIFY_COMMANDS = new Set([".spdl", ".spotify"])
const activeJobs = new Set()
const queuedJobs = []
const userCooldowns = new Map()
const groupCooldowns = new Map()

let dependencyCache = {
    checkedAt: 0,
    result: null,
}

function parseBool(value, defaultValue) {
    if (value == null || value === "") return defaultValue
    const clean = String(value).trim().toLowerCase()
    if (["1", "true", "yes", "y", "on", "aktif", "enable", "enabled"].includes(clean)) return true
    if (["0", "false", "no", "n", "off", "mati", "disable", "disabled"].includes(clean)) return false
    return defaultValue
}

function parsePositiveInt(value, defaultValue) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : defaultValue
}

function getConfig() {
    const audioFormat = String(process.env.SPOTIFY_DL_AUDIO_FORMAT || "mp3").trim().toLowerCase() || "mp3"

    return {
        enabled: parseBool(process.env.SPOTIFY_DL_ENABLED, true),
        public: parseBool(process.env.SPOTIFY_DL_PUBLIC, true),
        autoDetect: parseBool(process.env.SPOTIFY_DL_AUTO_DETECT, true),
        maxMb: parsePositiveInt(process.env.SPOTIFY_DL_MAX_MB, 64),
        timeoutMs: parsePositiveInt(process.env.SPOTIFY_DL_TIMEOUT_MS, 180000),
        audioFormat,
        searchSuffix: String(process.env.SPOTIFY_DL_SEARCH_SUFFIX || "official audio").trim() || "official audio",
        userCooldownMs: parsePositiveInt(process.env.SPOTIFY_DL_USER_COOLDOWN_MS, 60000),
        groupCooldownMs: parsePositiveInt(process.env.SPOTIFY_DL_GROUP_COOLDOWN_MS, 120000),
        ytdlpBin: process.env.YTDLP_BIN || "yt-dlp",
        ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg",
    }
}

function extractUrls(text) {
    const matches = String(text || "").match(/(?:https?:\/\/)?(?:open\.)?spotify\.com\/[^\s<>"']+|(?:https?:\/\/)?spotify\.link\/[^\s<>"']+/gi) || []
    return matches
        .map(url => url.replace(/[),.?!]+$/g, ""))
        .map(url => /^https?:\/\//i.test(url) ? url : `https://${url}`)
}

function extractFirstUrl(text) {
    return extractUrls(text)[0] || ""
}

function isSpotifyUrl(url) {
    try {
        const u = new URL(url)
        const hostname = u.hostname.toLowerCase()
        return (
            hostname === "spotify.com" ||
            hostname.endsWith(".spotify.com") ||
            hostname === "spotify.link" ||
            hostname.endsWith(".spotify.link")
        )
    } catch {
        return false
    }
}

function isSpotifyShortUrl(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase()
        return hostname === "spotify.link" || hostname.endsWith(".spotify.link")
    } catch {
        return false
    }
}

function getSpotifyPathType(url) {
    try {
        const parsed = new URL(url)
        const parts = parsed.pathname.split("/").filter(Boolean)
        const knownTypes = new Set(["track", "album", "playlist", "artist", "episode", "show"])
        const matchedType = parts.map(part => part.toLowerCase()).find(part => knownTypes.has(part))
        return matchedType || (parts[0] ? parts[0].toLowerCase() : "")
    } catch {
        return ""
    }
}

function isSpotifyTrackUrl(url) {
    if (!isSpotifyUrl(url)) return false
    if (isSpotifyShortUrl(url)) return true
    return getSpotifyPathType(url) === "track"
}

function isUnsupportedSpotifyUrl(url) {
    if (!isSpotifyUrl(url) || isSpotifyShortUrl(url)) return false
    const type = getSpotifyPathType(url)
    return Boolean(type && type !== "track")
}

function parseCommand(text) {
    const clean = String(text || "").trim()
    const parts = clean.split(/\s+/).filter(Boolean)
    const command = String(parts[0] || "").toLowerCase()
    return {
        command,
        isSpotifyCommand: SPOTIFY_COMMANDS.has(command),
        args: parts.slice(1),
    }
}

function decodeHtml(value) {
    return String(value || "")
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            try {
                return String.fromCodePoint(parseInt(hex, 16))
            } catch {
                return ""
            }
        })
        .replace(/&#(\d+);/g, (_, number) => {
            try {
                return String.fromCodePoint(parseInt(number, 10))
            } catch {
                return ""
            }
        })
}

function cleanMetadataText(value) {
    return decodeHtml(value)
        .replace(/\s*\|\s*Spotify\s*$/i, "")
        .replace(/\s*-\s*song and lyrics by\s*/i, " ")
        .replace(/\s+/g, " ")
        .trim()
}

function getHtmlAttribute(tag, attribute) {
    const match = tag.match(new RegExp(`${attribute}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
    if (!match) return ""
    return cleanMetadataText(match[2] || match[3] || match[4] || "")
}

function extractMetaContent(html, names) {
    const wanted = new Set(names.map(name => name.toLowerCase()))
    const metaTags = String(html || "").match(/<meta\b[^>]*>/gi) || []

    for (const tag of metaTags) {
        const name = (getHtmlAttribute(tag, "property") || getHtmlAttribute(tag, "name")).toLowerCase()
        if (!wanted.has(name)) continue
        const content = getHtmlAttribute(tag, "content")
        if (content) return content
    }

    return ""
}

function extractTitleTag(html) {
    const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    return cleanMetadataText(match?.[1] || "")
}

function getFinalUrl(response, fallbackUrl) {
    return (
        response?.request?.res?.responseUrl ||
        response?.request?._redirectable?._currentUrl ||
        response?.config?.url ||
        fallbackUrl
    )
}

function inferSpotifyTypeFromUrl(url) {
    return isSpotifyShortUrl(url) ? "" : getSpotifyPathType(url)
}

async function fetchSpotifyOembed(spotifyUrl) {
    const response = await axios.get("https://open.spotify.com/oembed", {
        params: { url: spotifyUrl },
        timeout: 12000,
        maxRedirects: 5,
        headers: {
            "user-agent": "Mozilla/5.0",
            accept: "application/json,text/plain,*/*",
        },
    })

    const data = response.data || {}
    const title = cleanMetadataText(data.title)
    const artist = cleanMetadataText(data.author_name)
    if (!title && !artist) throw new Error("metadata kosong")

    return {
        title: title || artist,
        artist: artist && artist !== title ? artist : "",
        type: inferSpotifyTypeFromUrl(spotifyUrl),
        sourceUrl: spotifyUrl,
        finalUrl: spotifyUrl,
    }
}

async function fetchSpotifyHtmlMetadata(spotifyUrl) {
    const response = await axios.get(spotifyUrl, {
        timeout: 15000,
        maxRedirects: 8,
        maxContentLength: 3 * 1024 * 1024,
        headers: {
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            accept: "text/html,application/xhtml+xml",
            "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        validateStatus: status => status >= 200 && status < 400,
    })

    const html = String(response.data || "")
    const finalUrl = getFinalUrl(response, spotifyUrl)
    const title =
        extractMetaContent(html, ["og:title", "twitter:title"]) ||
        extractTitleTag(html)

    if (!title) throw new Error("metadata kosong")

    return {
        title,
        artist: "",
        type: inferSpotifyTypeFromUrl(finalUrl),
        sourceUrl: spotifyUrl,
        finalUrl,
    }
}

async function resolveSpotifyMetadata(spotifyUrl) {
    if (!isSpotifyUrl(spotifyUrl)) throw new Error("URL Spotify tidak valid")

    let lastError = null
    try {
        const metadata = await fetchSpotifyOembed(spotifyUrl)
        if (!metadata.type || isSpotifyShortUrl(spotifyUrl)) {
            try {
                const htmlMetadata = await fetchSpotifyHtmlMetadata(spotifyUrl)
                return {
                    ...metadata,
                    title: metadata.title || htmlMetadata.title,
                    artist: metadata.artist || htmlMetadata.artist,
                    type: htmlMetadata.type || metadata.type,
                    finalUrl: htmlMetadata.finalUrl || metadata.finalUrl,
                }
            } catch {}
        }
        return metadata
    } catch (error) {
        lastError = error
    }

    try {
        return await fetchSpotifyHtmlMetadata(spotifyUrl)
    } catch (error) {
        lastError = error
    }

    throw lastError || new Error("metadata gagal dibaca")
}

function buildSearchQuery(metadata) {
    const config = getConfig()
    const title = cleanMetadataText(metadata?.title)
    const artist = cleanMetadataText(metadata?.artist)
    const parts = []

    if (title) parts.push(title)
    if (artist && !title.toLowerCase().includes(artist.toLowerCase())) parts.push(artist)
    if (config.searchSuffix) parts.push(config.searchSuffix)

    return parts.join(" ").replace(/\s+/g, " ").trim()
}

function ensureTmpDir() {
    fs.mkdirSync(TMP_DIR, { recursive: true })
}

function sanitizeFileName(value, fallback = "spotify_audio") {
    const clean = String(value || "")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80)

    return clean || fallback
}

function getAudioMimeType(format) {
    const clean = String(format || "").toLowerCase()
    if (clean === "m4a") return "audio/mp4"
    if (clean === "opus") return "audio/ogg"
    if (clean === "ogg") return "audio/ogg"
    if (clean === "wav") return "audio/wav"
    return "audio/mpeg"
}

function checkCommand(command, args, timeoutMs) {
    return new Promise(resolve => {
        let settled = false
        const child = spawn(command, args, {
            windowsHide: true,
            stdio: ["ignore", "ignore", "ignore"],
        })
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            try {
                child.kill("SIGKILL")
            } catch {}
            resolve(false)
        }, timeoutMs)

        child.on("error", () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(false)
        })

        child.on("close", code => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(code === 0)
        })
    })
}

async function checkSpotifyDownloaderReady(options = {}) {
    const config = getConfig()
    const now = Date.now()
    const cacheTtlMs = parsePositiveInt(options.cacheTtlMs, 60000)

    if (!options.force && dependencyCache.result && now - dependencyCache.checkedAt < cacheTtlMs) {
        return dependencyCache.result
    }

    const [hasYtDlp, hasFfmpeg] = await Promise.all([
        checkCommand(config.ytdlpBin, ["--version"], 8000),
        checkCommand(config.ffmpegBin, ["-version"], 8000),
    ])

    const result = {
        ok: hasYtDlp && hasFfmpeg,
        hasYtDlp,
        hasFfmpeg,
    }
    dependencyCache = {
        checkedAt: now,
        result,
    }
    return result
}

function listSpotifyTmpFiles(startedAt) {
    try {
        return fs.readdirSync(TMP_DIR)
            .filter(name => /^spotify_\d+_/i.test(name))
            .map(name => path.join(TMP_DIR, name))
            .filter(filePath => {
                try {
                    return fs.statSync(filePath).mtimeMs >= startedAt - 1000
                } catch {
                    return false
                }
            })
    } catch {
        return []
    }
}

function uniqueExistingFiles(files) {
    return [...new Set(files)]
        .filter(Boolean)
        .filter(filePath => {
            try {
                return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
            } catch {
                return false
            }
        })
}

function pickLargestFile(files) {
    return files
        .map(filePath => {
            try {
                return { filePath, size: fs.statSync(filePath).size }
            } catch {
                return { filePath, size: 0 }
            }
        })
        .sort((a, b) => b.size - a.size)[0]?.filePath || ""
}

function downloadSpotifyAudio(searchQuery, options = {}) {
    const config = getConfig()
    const audioFormat = String(options.audioFormat || config.audioFormat || "mp3").trim().toLowerCase()

    return new Promise((resolve, reject) => {
        ensureTmpDir()
        const startedAt = Date.now()
        const outputTemplate = path.join(TMP_DIR, `spotify_${startedAt}_%(title).80s.%(ext)s`)
        const args = [
            "--no-playlist",
            "--extract-audio",
            "--audio-format",
            audioFormat,
            "--audio-quality",
            "0",
            "--restrict-filenames",
            "--no-warnings",
            "--no-progress",
            "--print",
            "after_move:filepath",
            "-o",
            outputTemplate,
            `ytsearch1:${searchQuery}`,
        ]

        let stdout = ""
        let stderr = ""
        let settled = false
        const child = spawn(config.ytdlpBin, args, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        })

        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            try {
                child.kill("SIGKILL")
            } catch {}
            for (const filePath of listSpotifyTmpFiles(startedAt)) cleanupFile(filePath)
            const error = new Error("Spotify Downloader timeout")
            error.code = "TIMEOUT"
            reject(error)
        }, parsePositiveInt(options.timeoutMs, config.timeoutMs))

        child.stdout.on("data", chunk => {
            stdout += chunk.toString()
        })

        child.stderr.on("data", chunk => {
            stderr += chunk.toString()
        })

        child.on("error", error => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (error.code === "ENOENT") error.code = "DEPENDENCY"
            reject(error)
        })

        child.on("close", code => {
            if (settled) return
            settled = true
            clearTimeout(timer)

            const printedFiles = stdout
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)

            const files = uniqueExistingFiles([...printedFiles, ...listSpotifyTmpFiles(startedAt)])
            const filePath = pickLargestFile(files)

            if (code !== 0 || !filePath) {
                for (const tempPath of files) cleanupFile(tempPath)
                const error = new Error((stderr || `yt-dlp keluar dengan kode ${code}`).trim())
                error.code = "DOWNLOAD_FAILED"
                reject(error)
                return
            }

            resolve({
                filePath,
                fileName: path.basename(filePath),
                mimeType: getAudioMimeType(audioFormat),
            })
        })
    })
}

function cleanupFile(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch (error) {
        console.log(`[SPOTIFY DL] Gagal hapus file temp: ${error.message}`)
    }
}

function cleanupOldTempFiles(maxAgeMs = 6 * 60 * 60 * 1000) {
    try {
        if (!fs.existsSync(TMP_DIR)) return
        const now = Date.now()
        for (const name of fs.readdirSync(TMP_DIR)) {
            const filePath = path.join(TMP_DIR, name)
            const stat = fs.statSync(filePath)
            if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) cleanupFile(filePath)
        }
    } catch (error) {
        console.log(`[SPOTIFY DL] Gagal cleanup temp lama: ${error.message}`)
    }
}

function getCooldownKey(value) {
    return String(value || "").trim().toLowerCase()
}

function pruneCooldowns(map, now) {
    for (const [key, expiresAt] of map) {
        if (!key || expiresAt <= now) map.delete(key)
    }
}

function checkCooldown({ sender, from, isGroup }) {
    const config = getConfig()
    const now = Date.now()
    pruneCooldowns(userCooldowns, now)
    pruneCooldowns(groupCooldowns, now)

    const userKey = getCooldownKey(sender || from)
    const groupKey = isGroup ? getCooldownKey(from) : ""
    const userExpiresAt = userKey ? Number(userCooldowns.get(userKey) || 0) : 0
    const groupExpiresAt = groupKey ? Number(groupCooldowns.get(groupKey) || 0) : 0

    if (userExpiresAt > now || groupExpiresAt > now) return false

    if (userKey) userCooldowns.set(userKey, now + config.userCooldownMs)
    if (groupKey) groupCooldowns.set(groupKey, now + config.groupCooldownMs)
    return true
}

function enqueueSpotifyTask(task, onQueued) {
    const position = activeJobs.size + queuedJobs.length + 1

    return new Promise((resolve, reject) => {
        const job = { task, resolve, reject }

        if (activeJobs.size > 0 || queuedJobs.length > 0) {
            Promise.resolve(onQueued(position)).catch(() => {})
        }

        queuedJobs.push(job)
        runNextQueuedJob()
    })
}

function runNextQueuedJob() {
    if (activeJobs.size > 0 || queuedJobs.length === 0) return

    const job = queuedJobs.shift()
    activeJobs.add(job)

    Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
            activeJobs.delete(job)
            runNextQueuedJob()
        })
}

async function sendText(sock, jid, text, quoted) {
    await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined)
}

async function sendAudioFile(sock, jid, msg, fileInfo, metadata) {
    const config = getConfig()
    const title = sanitizeFileName(metadata?.title, "spotify_audio")
    const fileName = `${title}.${config.audioFormat || "mp3"}`
    const mimetype = fileInfo.mimeType || getAudioMimeType(config.audioFormat)

    try {
        await sock.sendMessage(jid, {
            audio: { url: fileInfo.filePath },
            mimetype,
            ptt: false,
            fileName,
        }, { quoted: msg })
        return
    } catch (error) {
        console.log(`[SPOTIFY DL] Gagal kirim audio, coba document: ${error.message}`)
    }

    await sock.sendMessage(jid, {
        document: { url: fileInfo.filePath },
        mimetype,
        fileName,
    }, { quoted: msg })
}

function getUserFacingFailure(error) {
    if (error?.code === "DEPENDENCY") {
        return "❌ Spotify Downloader belum siap.\nDependency belum lengkap di server."
    }

    if (error?.code === "METADATA") {
        return "❌ Spotify Downloader gagal membaca info lagu.\nCoba kirim link track Spotify lain."
    }

    if (error?.code === "TOO_LARGE") {
        return "❌ Spotify Downloader gagal mengirim lagu ini karena ukuran file terlalu besar."
    }

    if (error?.code === "UNSUPPORTED_TYPE") {
        return "❌ Spotify Downloader saat ini hanya mendukung link lagu/track."
    }

    return "❌ Spotify Downloader gagal memproses lagu ini.\nCoba kirim link track Spotify lain."
}

function makeCodedError(code, message) {
    const error = new Error(message || code)
    error.code = code
    return error
}

async function runSpotifyDownloadFlow(sock, msg, context, spotifyUrl) {
    const { from } = context
    const config = getConfig()
    let fileInfo = null

    try {
        await sendText(sock, from, "🎧 Spotify Downloader\n\nSedang memproses lagu...", msg)

        const ready = await checkSpotifyDownloaderReady()
        if (!ready.ok) throw makeCodedError("DEPENDENCY")

        let metadata
        try {
            metadata = await resolveSpotifyMetadata(spotifyUrl)
        } catch (error) {
            throw makeCodedError("METADATA", error.message)
        }

        if (metadata.type && metadata.type !== "track") {
            throw makeCodedError("UNSUPPORTED_TYPE")
        }

        const searchQuery = buildSearchQuery(metadata)
        if (!searchQuery) throw makeCodedError("METADATA")

        await sendText(sock, from, "🎧 Spotify Downloader\n\nMengunduh audio...", msg)

        fileInfo = await downloadSpotifyAudio(searchQuery, {
            timeoutMs: config.timeoutMs,
            audioFormat: config.audioFormat,
        })

        const fileSize = fs.statSync(fileInfo.filePath).size
        if (fileSize > config.maxMb * 1024 * 1024) {
            throw makeCodedError("TOO_LARGE")
        }

        await sendAudioFile(sock, from, msg, fileInfo, metadata)
    } finally {
        if (fileInfo?.filePath) cleanupFile(fileInfo.filePath)
    }
}

async function handleSpotifyDownloader(sock, msg, context = {}) {
    const from = context.from || msg?.key?.remoteJid
    const isGroup = Boolean(context.isGroup || String(from || "").endsWith("@g.us"))
    if (isGroup) return false

    const text = String(context.text || "").trim()
    const parsedCommand = parseCommand(text)
    const explicitUrl = parsedCommand.args.find(isSpotifyUrl) || extractFirstUrl(parsedCommand.args.join(" "))
    const detectedUrl = extractFirstUrl(text)
    const spotifyUrl = explicitUrl || detectedUrl
    const hasSpotifyLink = Boolean(spotifyUrl && isSpotifyUrl(spotifyUrl))
    const isSpotifyCommand = parsedCommand.isSpotifyCommand
    const config = getConfig()

    if (!isSpotifyCommand && !(config.autoDetect && hasSpotifyLink)) return false
    if (!config.enabled) return true

    if (!config.public && !context.canControlOwner && !context.isOwner) {
        await sendText(sock, from, "❌ Spotify Downloader hanya untuk owner.", msg)
        return true
    }

    if (!spotifyUrl || !isSpotifyUrl(spotifyUrl)) {
        await sendText(sock, from, "❌ Spotify Downloader gagal membaca info lagu.\nCoba kirim link track Spotify lain.", msg)
        return true
    }

    if (isUnsupportedSpotifyUrl(spotifyUrl) || !isSpotifyTrackUrl(spotifyUrl)) {
        await sendText(sock, from, "❌ Spotify Downloader saat ini hanya mendukung link lagu/track.", msg)
        return true
    }

    if (!checkCooldown({
        sender: context.sender || context.senderJid,
        from,
        isGroup,
    })) {
        await sendText(sock, from, "⏳ Tunggu sebentar sebelum memakai Spotify Downloader lagi.", msg)
        return true
    }

    cleanupOldTempFiles()

    try {
        await enqueueSpotifyTask(
            () => runSpotifyDownloadFlow(sock, msg, { ...context, from }, spotifyUrl),
            position => sendText(sock, from, `⏳ Spotify Downloader masuk antrean.\nPosisi antrean: ${position}`, msg)
        )
    } catch (error) {
        console.log("[SPOTIFY DL] Gagal memproses", {
            from,
            sender: context.sender || context.senderJid,
            messageId: msg?.key?.id,
            code: error?.code,
            message: error?.message,
        })
        await sendText(sock, from, getUserFacingFailure(error), msg)
    }

    return true
}

module.exports = {
    handleSpotifyDownloader,
    isSpotifyUrl,
    isSpotifyTrackUrl,
    resolveSpotifyMetadata,
    buildSearchQuery,
    downloadSpotifyAudio,
    checkSpotifyDownloaderReady,
}
