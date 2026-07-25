const fs = require("fs");
const path = require("path");

const target = path.join(
    __dirname,
    "..",
    "node_modules",
    "@whiskeysockets",
    "baileys",
    "lib",
    "Socket",
    "messages-send.js"
);

const patchMarker = "const groupMetadataCache = new Map();";

function log(message, options = {}) {
    if (!options.silent) console.log(message);
}

function applyBaileysGroupRetryPatch(options = {}) {
    if (!fs.existsSync(target)) {
        log("[BAILEYS PATCH] messages-send.js tidak ditemukan, skip.", options);
        return false;
    }

    let source = fs.readFileSync(target, "utf8");

    if (source.includes(patchMarker) && source.includes("if (participant || isStatus)")) {
        log("[BAILEYS PATCH] Group retry metadata patch sudah terpasang.", options);
        return false;
    }

    const cacheAnchors = [
        `    const userDevicesCache = config.userDevicesCache || new node_cache_1.default({
        stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.USER_DEVICES,
        useClones: false
    });`,
        `    const userDevicesCache = config.userDevicesCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
            useClones: false
        });`,
    ];

    const cacheAnchor = cacheAnchors.find(anchor => source.includes(anchor));
    if (!cacheAnchor) {
        log("[BAILEYS PATCH] Anchor userDevicesCache tidak ditemukan, kemungkinan struktur Baileys sudah berubah. Skip patch.", options);
        return false;
    }

    const cachePatch = `${cacheAnchor}
    const groupMetadataCache = new Map();
    const groupMetadataCacheTtlMs = Number(process.env.BAILEYS_GROUP_METADATA_CACHE_TTL_MS || 10 * 60 * 1000);
    const groupMetadataStaleTtlMs = Number(process.env.BAILEYS_GROUP_METADATA_STALE_TTL_MS || 6 * 60 * 60 * 1000);
    const rememberGroupMetadataForRelay = (jid, metadata) => {
        if (!metadata || !Array.isArray(metadata.participants)) {
            return metadata;
        }
        const relayMetadata = { participants: metadata.participants };
        groupMetadataCache.set(jid, {
            metadata: relayMetadata,
            cachedAt: Date.now()
        });
        return relayMetadata;
    };
    const getGroupMetadataForRelay = async (jid, cachedGroupMetadata) => {
        const now = Date.now();
        const cached = groupMetadataCache.get(jid);
        if (cached && now - cached.cachedAt <= groupMetadataCacheTtlMs) {
            return cached.metadata;
        }
        let groupData = cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined;
        if (groupData) {
            logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata');
            return rememberGroupMetadataForRelay(jid, groupData);
        }
        try {
            groupData = await groupMetadata(jid);
            return rememberGroupMetadataForRelay(jid, groupData);
        }
        catch (error) {
            if (cached && now - cached.cachedAt <= groupMetadataStaleTtlMs) {
                logger.warn({ jid, err: error }, 'using stale group metadata after relay metadata fetch failed');
                return cached.metadata;
            }
            throw error;
        }
    };`;

    source = source.replace(cacheAnchor, cachePatch);

    const metadataBlockPatterns = [
        /                    \(async \(\) => \{\r?\n                        let groupData = cachedGroupMetadata \? await cachedGroupMetadata\(jid\) : undefined;\r?\n                        if \(groupData\) \{\r?\n                            logger\.trace\(\{ jid, participants: groupData\.participants\.length \}, 'using cached group metadata'\);\r?\n                        \}\r?\n                        if \(!groupData && !isStatus\) \{\r?\n                            groupData = await groupMetadata\(jid\);\r?\n                        \}\r?\n                        return groupData;\r?\n                    \}\)\(\),/,
        /                    \(async \(\) => \{\r?\n                        let groupData = useCachedGroupMetadata && cachedGroupMetadata \? await cachedGroupMetadata\(jid\) : undefined;\r?\n                        if \(groupData && Array\.isArray\(groupData === null \|\| groupData === void 0 \? void 0 : groupData\.participants\)\) \{\r?\n                            logger\.trace\(\{ jid, participants: groupData\.participants\.length \}, 'using cached group metadata'\);\r?\n                        \}\r?\n                        else if \(!isStatus\) \{\r?\n                            groupData = await groupMetadata\(jid\);\r?\n                        \}\r?\n                        return groupData;\r?\n                    \}\)\(\),/,
        /                    \(async \(\) => \{\r?\n                        let groupData = useCachedGroupMetadata && cachedGroupMetadata \? await cachedGroupMetadata\(jid\) : undefined;[^\r\n]*\r?\n                        if \(groupData && Array\.isArray\(groupData\?\.participants\)\) \{\r?\n                            logger\.trace\(\{ jid, participants: groupData\.participants\.length \}, 'using cached group metadata'\);\r?\n                        \}\r?\n                        else if \(!isStatus\) \{\r?\n                            groupData = await groupMetadata\(jid\);[^\r\n]*\r?\n                        \}\r?\n                        return groupData;\r?\n                    \}\)\(\),/,
    ];

    const metadataBlockPatch = `                    (async () => {
                        if (participant || isStatus) {
                            return undefined;
                        }
                        return getGroupMetadataForRelay(jid, typeof useCachedGroupMetadata === "undefined" || useCachedGroupMetadata ? cachedGroupMetadata : null);
                    })(),`;

    const metadataBlockPattern = metadataBlockPatterns.find(pattern => pattern.test(source));
    if (!metadataBlockPattern) {
        log("[BAILEYS PATCH] Block groupMetadata relay tidak ditemukan, skip patch.", options);
        return false;
    }

    source = source.replace(metadataBlockPattern, metadataBlockPatch);

    fs.writeFileSync(target, source);
    log("[BAILEYS PATCH] Group retry metadata patch berhasil dipasang.", options);
    return true;
}

if (require.main === module) {
    applyBaileysGroupRetryPatch();
}

module.exports = {
    applyBaileysGroupRetryPatch,
};
