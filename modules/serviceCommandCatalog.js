"use strict"

const CATEGORIES = Object.freeze({
    groupAdmin: [".gcopen / .gcclose", ".gcschedule", ".setnamegc / .setdeskgc / .setppgc", ".pin", ".tagall / .hidetag", ".poll", ".exportvcf"],
    groupModeration: [".warn / .listwarn / .resetwarn / .warnmax", ".slowmode", ".antispam", ".nsfw status/on/off/threshold/action", ".nsfwscan"],
    customerStore: [".shop / .store", ".produk [id]", ".beli <id>", ".pesanan [trxId]", ".saldo", ".deposit <nominal>", ".depositstatus", ".riwayatsaldo"],
    privateTools: [".jadibot", ".statusjadibot", ".stopjadibot", ".inspect <link>", ".inspectmsg / .q", ".web2zip <url>", ".mockchat / .fakechat", ".mockcall / .fakecall", ".mockstory / .fakestory"],
    ownerOnly: [
        ".jpm status/stop/delay/resume/blacklist/whitelist",
        ".pushkontak status/stop/delay",
        ".addproduk / .editproduk / .delproduk / .produkoff / .produkon / .stok / .addstok",
        ".orderlist / .order / .orderdone / .orderreject",
        ".saldoadd / .saldoreduce / .depositlist / .depositacc / .depositreject",
        ".upsw / .upstatus",
        ".autoreactsw",
        ".jadibotctl / .listjadibot",
        ".waresearch test/status/last/explain/scan/report — owner-private research + testing nomor manual + laporan",
    ],
})

function formatCategory(title, commands) {
    return [title, ...commands.map(command => `- ${command}`)].join("\n")
}

function buildServiceHelpText() {
    return [
        formatCategory("GROUP / ADMIN — GROUP ADMIN", CATEGORIES.groupAdmin),
        "",
        formatCategory("GROUP / ADMIN — MODERATION", CATEGORIES.groupModeration),
        "",
        formatCategory("STORE & WALLET", CATEGORIES.customerStore),
        "",
        formatCategory("PRIVATE TOOLS", CATEGORIES.privateTools),
        "",
        formatCategory("OWNER ONLY", CATEGORIES.ownerOnly),
    ].join("\n")
}

module.exports = {
    CATEGORIES,
    buildServiceHelpText,
    formatCategory,
}
