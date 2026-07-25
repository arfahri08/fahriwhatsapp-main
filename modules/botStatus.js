const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "../data/botStatus.json");
const DEFAULT_STATE = {
    active: true,
    lastToggled: new Date().toISOString(),
    toggledBy: "system",
};

function writeJsonAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tempFile = `${file}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempFile, file);
}

function normalizeState(data) {
    return {
        ...DEFAULT_STATE,
        ...(data && typeof data === "object" ? data : {}),
        active: data?.active === undefined ? DEFAULT_STATE.active : Boolean(data.active),
        lastToggled: String(data?.lastToggled || DEFAULT_STATE.lastToggled),
        toggledBy: String(data?.toggledBy || DEFAULT_STATE.toggledBy),
    };
}

function loadState() {
    try {
        if (!fs.existsSync(FILE)) {
            writeJsonAtomic(FILE, DEFAULT_STATE);
            return { ...DEFAULT_STATE };
        }

        return normalizeState(JSON.parse(fs.readFileSync(FILE, "utf8")));
    } catch (error) {
        console.log(`[STATUS] Gagal membaca autosave, pakai default: ${error.message}`);
        return { ...DEFAULT_STATE };
    }
}

function saveState(nextState) {
    const normalized = normalizeState(nextState);

    try {
        writeJsonAtomic(FILE, normalized);
    } catch (error) {
        console.log(`[STATUS] Gagal autosave: ${error.message}`);
    }

    return normalized;
}

let state = loadState();

function getStatus() {
    return Boolean(state.active);
}

function getState() {
    return { ...state };
}

function setStatus(status, toggledBy = "system") {
    state = saveState({
        ...state,
        active: Boolean(status),
        lastToggled: new Date().toISOString(),
        toggledBy,
    });

    console.log(`[STATUS] Bot sekarang: ${state.active ? "ON" : "OFF"} (autosaved)`);
    return state.active;
}

module.exports = {
    getStatus,
    getState,
    setStatus,
};
