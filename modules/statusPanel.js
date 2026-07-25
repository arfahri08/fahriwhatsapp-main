const { generateWAMessageFromContent, proto } = require("@whiskeysockets/baileys");

const STATUS_OPTIONS = {
    status_makan: {
        label: "🍽️ Sedang Makan",
        buttonLabel: "🍽️ Makan",
        description: "Balasan: sedang makan",
        statusText: "sedang makan",
    },
    status_sibuk: {
        label: "💻 Sedang Sibuk (Nugas/Bikin Script)",
        buttonLabel: "💻 Sibuk",
        description: "Balasan: sedang sibuk nugas",
        statusText: "sedang sibuk nugas",
    },
    status_jalan: {
        label: "🛵 Sedang di Jalan",
        buttonLabel: "🛵 Jalan",
        description: "Balasan: sedang di jalan",
        statusText: "sedang di jalan",
    },
    status_tidur: {
        label: "💤 Sedang Istirahat",
        buttonLabel: "💤 Istirahat",
        description: "Balasan: sedang istirahat",
        statusText: "sedang istirahat",
    },
    status_off: {
        label: "❌ Matikan Auto-Reply Custom",
        buttonLabel: "❌ Off",
        description: "Custom auto-reply dimatikan",
        statusText: "",
        off: true,
    },
};

function unwrapMessage(input) {
    let message = input?.message || input || {};

    for (let i = 0; i < 5; i += 1) {
        if (message.ephemeralMessage?.message) {
            message = message.ephemeralMessage.message;
            continue;
        }
        if (message.viewOnceMessage?.message) {
            message = message.viewOnceMessage.message;
            continue;
        }
        if (message.viewOnceMessageV2?.message) {
            message = message.viewOnceMessageV2.message;
            continue;
        }
        if (message.viewOnceMessageV2Extension?.message) {
            message = message.viewOnceMessageV2Extension.message;
            continue;
        }
        break;
    }

    return message;
}

function normalizeJid(value) {
    const clean = String(value || "").trim();
    if (!clean) return null;
    if (clean.endsWith("@lid")) return null;
    if (clean.endsWith("@s.whatsapp.net") && !clean.includes(":")) return clean;

    const number = clean.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
    return number ? `${number}@s.whatsapp.net` : null;
}

function getConfiguredPanelTarget(sock) {
    const raw = process.env.PANEL_TARGET_JID || process.env.OWNER_JID || process.env.ACTIVE_NOTIFY_JIDS || "";
    const fromEnv = raw
        .split(",")
        .map(normalizeJid)
        .find(Boolean);

    return fromEnv || normalizeJid(sock?.user?.id || sock?.user?.jid);
}

function getSendTarget(sock, jid) {
    const requested = String(jid || "").trim();
    if (process.env.PANEL_TARGET_JID) {
        const target = getConfiguredPanelTarget(sock);
        if (target) {
            console.log(`[PANEL] Target panel diarahkan ke ${target}`);
            return target;
        }
    }

    return requested || getConfiguredPanelTarget(sock);
}

function parseNativeFlowParams(paramsJson) {
    if (!paramsJson || typeof paramsJson !== "string") return "";

    try {
        const params = JSON.parse(paramsJson);
        return String(
            params.id ||
            params.rowId ||
            params.row_id ||
            params.selectedRowId ||
            params.selectedRowID ||
            params.button_id ||
            params.response_id ||
            ""
        ).trim();
    } catch {
        return "";
    }
}

function extractSelectedId(input) {
    const message = unwrapMessage(input);

    const listReply = message.listResponseMessage?.singleSelectReply;
    const selectedId = listReply?.selectedRowId || listReply?.selectedRowID || listReply?.rowId;
    if (selectedId) return String(selectedId).trim();

    const buttonId = message.buttonsResponseMessage?.selectedButtonId;
    if (buttonId) return String(buttonId).trim();

    const templateId = message.templateButtonReplyMessage?.selectedId;
    if (templateId) return String(templateId).trim();

    const nativeParams = message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
    return parseNativeFlowParams(nativeParams);
}

function isStatusPanelId(id) {
    return Boolean(id && STATUS_OPTIONS[id]);
}

function commandToId(command) {
    const key = String(command || "").trim().toLowerCase();
    const aliases = {
        makan: "status_makan",
        maem: "status_makan",
        sibuk: "status_sibuk",
        nugas: "status_sibuk",
        script: "status_sibuk",
        jalan: "status_jalan",
        otw: "status_jalan",
        tidur: "status_tidur",
        istirahat: "status_tidur",
        rest: "status_tidur",
        off: "status_off",
        mati: "status_off",
        disable: "status_off",
    };

    return aliases[key] || (isStatusPanelId(key) ? key : "");
}

function extractCommandId(text) {
    const parts = String(text || "").trim().split(/\s+/);
    if (parts.length < 2) return "";
    if (parts[0].toLowerCase() !== ".panel" && parts[0].toLowerCase() !== ".status") return "";
    return commandToId(parts[1]);
}

function getStateText(state) {
    if (state?.isCustomAutoReplyOn && state?.customStatusText) {
        return `Status sekarang: ${state.customStatusText}`;
    }

    if (state?.customStatusText) {
        return `Mode custom mati. Status terakhir: ${state.customStatusText}`;
    }

    return "Belum ada status custom tersimpan.";
}

function getFallbackText(state) {
    return `⚙️ *Panel Status Custom*
${getStateText(state)}

Kalau tombol/list tidak muncul di WhatsApp kamu, pakai command cepat ini:

• *.status makan* → 🍽️ Sedang Makan
• *.status sibuk* → 💻 Sedang Sibuk
• *.status jalan* → 🛵 Sedang di Jalan
• *.status tidur* → 💤 Sedang Istirahat
• *.status off* → ❌ Matikan custom auto-reply

_Watermark: USERBOT FAHRI_`;
}

function getPanelText(state) {
    return `⚙️ *Panel Status Custom*\n${getStateText(state)}\n\nPilih status cepat di bawah ini.`;
}

function getRows() {
    return Object.entries(STATUS_OPTIONS).map(([id, option]) => ({
        title: option.label,
        rowId: id,
        description: option.description,
    }));
}

function makeClassicButton(id) {
    const option = STATUS_OPTIONS[id];
    return {
        buttonId: id,
        buttonText: {
            displayText: option.buttonLabel || option.label,
        },
        type: 1,
    };
}

async function sendClassicButtonPanel(sock, jid, state) {
    const firstButtons = ["status_makan", "status_sibuk", "status_jalan"].map(makeClassicButton);
    const secondButtons = ["status_tidur", "status_off"].map(makeClassicButton);

    const firstPanel = await sock.sendMessage(jid, {
        text: getPanelText(state),
        footer: "Watermark: USERBOT FAHRI",
        buttons: firstButtons,
        headerType: 1,
    });

    const secondPanel = await sock.sendMessage(jid, {
        text: "Opsi status lainnya:",
        footer: "Watermark: USERBOT FAHRI",
        buttons: secondButtons,
        headerType: 1,
    });

    return secondPanel || firstPanel;
}

function makeTemplateButton(id, index) {
    const option = STATUS_OPTIONS[id];
    return {
        index,
        quickReplyButton: {
            displayText: option.buttonLabel || option.label,
            id,
        },
    };
}

async function sendTemplateButtonPanel(sock, jid, state) {
    const firstButtons = ["status_makan", "status_sibuk", "status_jalan"]
        .map((id, index) => makeTemplateButton(id, index + 1));
    const secondButtons = ["status_tidur", "status_off"]
        .map((id, index) => makeTemplateButton(id, index + 1));

    const firstPanel = await sock.sendMessage(jid, {
        text: getPanelText(state),
        footer: "Watermark: USERBOT FAHRI",
        templateButtons: firstButtons,
    });

    const secondPanel = await sock.sendMessage(jid, {
        text: "Opsi status lainnya:",
        footer: "Watermark: USERBOT FAHRI",
        templateButtons: secondButtons,
    });

    return secondPanel || firstPanel;
}

async function sendNativePanel(sock, jid, state) {
    const rows = getRows().map((row) => ({
        title: row.title,
        description: row.description,
        id: row.rowId,
    }));

    const message = generateWAMessageFromContent(jid, {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    deviceListMetadata: {},
                    deviceListMetadataVersion: 2,
                },
                interactiveMessage: proto.Message.InteractiveMessage.create({
                    header: proto.Message.InteractiveMessage.Header.create({
                        title: "USERBOT FAHRI",
                        hasMediaAttachment: false,
                    }),
                    body: proto.Message.InteractiveMessage.Body.create({
                        text: getPanelText(state),
                    }),
                    footer: proto.Message.InteractiveMessage.Footer.create({
                        text: "Watermark: USERBOT FAHRI",
                    }),
                    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                        buttons: [
                            {
                                name: "single_select",
                                buttonParamsJson: JSON.stringify({
                                    title: "Buka Pilihan Status",
                                    sections: [
                                        {
                                            title: "Pilihan Status",
                                            rows,
                                        },
                                    ],
                                }),
                            },
                        ],
                        messageVersion: 1,
                    }),
                }),
            },
        },
    }, {
        userJid: sock.user?.id || sock.user?.jid || jid,
    });

    await sock.relayMessage(jid, message.message, { messageId: message.key.id });
    return message;
}

async function sendButtonPanel(sock, jid, state) {
    const buttons = Object.entries(STATUS_OPTIONS).map(([id, option]) => ({
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
            display_text: option.label,
            id,
        }),
    }));

    const message = generateWAMessageFromContent(jid, {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    deviceListMetadata: {},
                    deviceListMetadataVersion: 2,
                },
                interactiveMessage: proto.Message.InteractiveMessage.create({
                    body: proto.Message.InteractiveMessage.Body.create({
                        text: getPanelText(state),
                    }),
                    footer: proto.Message.InteractiveMessage.Footer.create({
                        text: "Watermark: USERBOT FAHRI",
                    }),
                    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                        buttons,
                        messageVersion: 1,
                    }),
                }),
            },
        },
    }, {
        userJid: sock.user?.id || sock.user?.jid || jid,
    });

    await sock.relayMessage(jid, message.message, { messageId: message.key.id });
    return message;
}

async function sendPanel(sock, jid, state) {
    const targetJid = getSendTarget(sock, jid);
    const rows = getRows();

    try {
        const templatePanel = await sendTemplateButtonPanel(sock, targetJid, state);
        console.log(`[PANEL] Template button terkirim ke ${targetJid}`);
        return templatePanel;
    } catch (error) {
        console.log(`[PANEL] Gagal kirim template button: ${error.message}`);
    }

    try {
        const buttonPanel = await sendClassicButtonPanel(sock, targetJid, state);
        console.log(`[PANEL] Tombol klasik terkirim ke ${targetJid}`);
        return buttonPanel;
    } catch (error) {
        console.log(`[PANEL] Gagal kirim tombol klasik: ${error.message}`);
    }

    try {
        await sendButtonPanel(sock, targetJid, state);
        console.log(`[PANEL] Tombol quick reply dikirim ke ${targetJid}`);
        return null;
    } catch (error) {
        console.log(`[PANEL] Gagal kirim tombol quick reply: ${error.message}`);
    }

    try {
        await sendNativePanel(sock, targetJid, state);
        console.log(`[PANEL] Interactive List modern dikirim ke ${targetJid}`);
        return null;
    } catch (error) {
        console.log(`[PANEL] Gagal kirim Interactive List modern: ${error.message}`);
    }

    try {
        const listPanel = await sock.sendMessage(targetJid, {
            title: "USERBOT FAHRI",
            text: getPanelText(state),
            footer: "Watermark: USERBOT FAHRI",
            buttonText: "Buka Pilihan Status",
            sections: [
                {
                    title: "Pilihan Status",
                    rows,
                },
            ],
        });
        console.log(`[PANEL] List Message klasik dikirim ke ${targetJid}`);
        return listPanel;
    } catch (error) {
        console.log(`[PANEL] Gagal kirim List Message: ${error.message}`);
        return sock.sendMessage(targetJid, { text: getFallbackText(state) });
    }
}

function applySelection(selectedId, customAutoReply) {
    const option = STATUS_OPTIONS[selectedId];
    if (!option) return null;

    if (option.off) {
        const state = customAutoReply.setEnabled(false);
        return {
            state,
            text: "✅ Custom auto-reply berhasil dimatikan.",
        };
    }

    const state = customAutoReply.setStatus(option.statusText);
    return {
        state,
        text: `✅ Status berhasil diubah menjadi: ${option.label}`,
    };
}

module.exports = {
    STATUS_OPTIONS,
    applySelection,
    commandToId,
    extractCommandId,
    extractSelectedId,
    getFallbackText,
    getSendTarget,
    isStatusPanelId,
    sendPanel,
};
