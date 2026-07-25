function getKey(target, jid) {
    const key = target?.key || target;
    if (!key?.id) return null;

    return {
        ...key,
        remoteJid: key.remoteJid || jid,
    };
}

function rememberKey(state, target, jid) {
    const key = getKey(target, jid);
    if (key) state.push(key);
    return key;
}

async function safeDelete(sock, jid, target, label = "pesan") {
    const key = getKey(target, jid);
    if (!key) return false;

    try {
        await sock.sendMessage(jid, { delete: key });
        return true;
    } catch (error) {
        try {
            if (typeof sock.chatModify !== "function") throw error;
            await sock.chatModify({
                clear: {
                    messages: [{
                        id: key.id,
                        fromMe: !!key.fromMe,
                        timestamp: key.messageTimestamp || Math.floor(Date.now() / 1000),
                    }],
                },
            }, jid);
            return true;
        } catch (fallbackError) {
            console.log(`[CLEANER] Gagal hapus ${label}: ${error.message}`);
            return false;
        }
    }
}

async function sendTemporary(sock, jid, text) {
    return sock.sendMessage(jid, { text });
}

async function deleteMessageObject(sock, jid, message, label) {
    return safeDelete(sock, jid, message?.key, label);
}

async function deleteMany(sock, jid, keys, label = "pesan sementara") {
    for (const key of keys) {
        await safeDelete(sock, jid, key, label);
    }
}

module.exports = {
    safeDelete,
    sendTemporary,
    deleteMessageObject,
    rememberKey,
    deleteMany,
};
