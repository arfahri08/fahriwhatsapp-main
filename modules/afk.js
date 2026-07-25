let afk = false
let reason = ""

function setAFK(r) {
    afk = true
    reason = r || "USERBOT REPLY, HARAP TUNGGU. PESAN AKAN SEGERA DITERUSKAN"
}

function clearAFK() {
    afk = false
}

function isAFK() {
    return afk
}

function getReason() {
    return reason
}

module.exports = {
    setAFK,
    clearAFK,
    isAFK,
    getReason
}
