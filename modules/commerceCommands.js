"use strict"

const fs = require("fs")
const commerce = require("./commerceManager")
const identity = require("./canonicalIdentity")
const groupCommon = require("./groupUtilityCommon")

const GROUP_FEATURE = "store"
const CUSTOMER_COMMANDS = /^(?:\.shop|\.store|\.produk|\.beli|\.pesanan|\.saldo|\.deposit|\.depositstatus|\.riwayatsaldo)(?:\s|$)/i
const OWNER_COMMANDS = /^(?:\.addproduk|\.editproduk|\.delproduk|\.produkoff|\.produkon|\.stok|\.addstok|\.orderlist|\.order|\.orderdone|\.orderreject|\.saldoadd|\.saldoreduce|\.depositlist|\.depositacc|\.depositreject)(?:\s|$)/i

function formatMoney(value) {
    return `Rp${Number(value || 0).toLocaleString("id-ID")}`
}

function commandRoot(text) {
    return String(text || "").trim().split(/\s+/)[0].toLowerCase()
}

function isCommerceCommand(text) {
    const clean = String(text || "").trim()
    return CUSTOMER_COMMANDS.test(clean) || OWNER_COMMANDS.test(clean)
}

async function authorizeGroup(sock, msg, context) {
    if (!context.isGroup) return { allowed: true, groupJid: context.from, policy: null }
    const policy = await groupCommon.resolveFeaturePolicy(sock, context.from, GROUP_FEATURE, context)
    return { allowed: policy.allowed, groupJid: context.from, policy }
}

function senderIdentity(msg, context) {
    const resolved = identity.senderIdentity(msg, context)
    if (!resolved.key) throw new Error("Identitas customer tidak dapat ditentukan")
    return resolved
}

function formatProduct(product, details = false) {
    const lines = [
        `${product.id} — ${product.name}`,
        `Harga: ${formatMoney(product.price)}`,
        `Tipe: ${product.type}`,
        `Stok: ${commerce.productStock(product) == null ? "manual" : commerce.productStock(product)}`,
        `Status: ${product.active !== false ? "AKTIF" : "OFF"}`,
    ]
    if (details && product.description) lines.push(`Deskripsi: ${product.description}`)
    return lines.join("\n")
}

function formatOrder(order, owner = false) {
    return [
        `Order: ${order.id}`,
        `Produk: ${order.productName} (${order.productId})`,
        `Jumlah: ${formatMoney(order.amount)}`,
        `Status: ${order.state}`,
        `Pembayaran: ${order.paymentMethod}`,
        owner ? `Customer: ${order.customerJid}` : "",
        order.delivery?.status ? `Delivery: ${order.delivery.status}` : "",
        `Dibuat: ${order.createdAt}`,
    ].filter(Boolean).join("\n")
}

function parseProductInput(text) {
    const fields = String(text || "").replace(/^\.addproduk\b/i, "").split("|").map(value => value.trim())
    return { name: fields[0], description: fields[1] || "", price: Number(fields[2]), type: fields[3] || "manual", stock: Number(fields[4] || 0) }
}

function parseEditInput(text) {
    const fields = String(text || "").replace(/^\.editproduk\b/i, "").split("|").map(value => value.trim())
    const id = fields.shift()
    const patch = {}
    for (const field of fields) {
        const index = field.indexOf("=")
        if (index < 1) continue
        const key = field.slice(0, index).trim().toLowerCase()
        const value = field.slice(index + 1).trim()
        if (["name", "description", "price", "stock"].includes(key)) patch[key] = ["price", "stock"].includes(key) ? Number(value) : value
    }
    return { id, patch }
}

function operationId(msg, prefix) {
    const id = String(msg?.key?.id || "").trim()
    return id ? `${prefix}:${String(msg?.key?.remoteJid || "")}:${id}` : `${prefix}:${Date.now()}`
}

function resolveOwnerTarget(msg, parts, context = {}) {
    const info = groupCommon.getContextInfo(msg)
    return identity.canonicalIdentity([
        ...(Array.isArray(info.mentionedJid) ? info.mentionedJid : []),
        info.participantAlt,
        info.participant,
        parts[1],
    ], context)
}

async function deliverOrder(sock, orderId, actor) {
    const current = commerce.getOrder(orderId)
    if (!current) throw new Error("Order tidak ditemukan")
    if (!commerce.isDigitalType(current.productType)) return commerce.completeNonDigital(orderId, actor)
    const begun = commerce.beginDelivery(orderId, actor)
    if (begun.duplicate) return { duplicate: true, order: begun.order }
    const attemptId = begun.order.delivery.deliveryAttemptId
    try {
        if (begun.secret.type === "digital_file") {
            const file = String(begun.secret.value || "")
            if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error("File inventory tidak tersedia")
            await sock.sendMessage(begun.order.customerJid, { document: fs.readFileSync(file), fileName: require("path").basename(file), mimetype: "application/octet-stream", caption: `Pesanan ${begun.order.id}` })
        } else {
            await sock.sendMessage(begun.order.customerJid, { text: `PESANAN DIGITAL ${begun.order.id}\n\n${begun.secret.value}` })
        }
        const order = commerce.finishDelivery(orderId, attemptId, true)
        return { duplicate: false, order }
    } catch (error) {
        const order = commerce.finishDelivery(orderId, attemptId, false, error?.message || error)
        return { duplicate: false, ambiguous: true, order }
    }
}

async function handleCustomerCommand(sock, msg, context, root, text, customer) {
    const parts = text.split(/\s+/)
    if (root === ".shop" || root === ".store" || (root === ".produk" && !parts[1])) {
        const products = commerce.listProducts()
        const body = products.length ? products.map(product => formatProduct(product)).join("\n\n") : "Belum ada produk aktif."
        await sock.sendMessage(context.from, { text: `TOKO WHATSAPP\n\n${body}` }, { quoted: msg })
        return true
    }
    if (root === ".produk") {
        const product = commerce.getProduct(parts[1])
        await sock.sendMessage(context.from, { text: product && product.active !== false ? formatProduct(product, true) : "Produk tidak ditemukan." }, { quoted: msg })
        return true
    }
    if (root === ".beli") {
        try {
            const result = commerce.createOrder({ productId: parts[1], customer: customer.jid, operationId: operationId(msg, "buy") }, context)
            await sock.sendMessage(context.from, { text: `${result.duplicate ? "Order duplicate terdeteksi; memakai transaksi existing." : "Order dibuat."}\n\n${formatOrder(result.order)}` }, { quoted: msg })
        } catch (error) {
            await sock.sendMessage(context.from, { text: `Pembelian gagal: ${String(error?.message || error).slice(0, 180)}` }, { quoted: msg })
        }
        return true
    }
    if (root === ".pesanan") {
        if (parts[1]) {
            const order = commerce.getOrder(parts[1])
            await sock.sendMessage(context.from, { text: order && order.customerKey === customer.key ? formatOrder(order) : "Pesanan tidak ditemukan." }, { quoted: msg })
        } else {
            const orders = commerce.listOrders({ customerKey: customer.key }).slice(0, 10)
            await sock.sendMessage(context.from, { text: orders.length ? orders.map(order => `${order.id} — ${order.productName} — ${order.state}`).join("\n") : "Belum ada pesanan." }, { quoted: msg })
        }
        return true
    }
    if (root === ".saldo") {
        const wallet = commerce.getWallet(customer.jid, context)
        await sock.sendMessage(context.from, { text: `Saldo kamu: ${formatMoney(wallet.wallet.balance)}` }, { quoted: msg })
        return true
    }
    if (root === ".deposit") {
        try {
            const result = commerce.createDeposit({ customer: customer.jid, amount: parts[1], operationId: operationId(msg, "deposit") }, context)
            await sock.sendMessage(context.from, { text: `Request deposit ${result.deposit.id}\nNominal: ${formatMoney(result.deposit.amount)}\nStatus: ${result.deposit.state}\nSaldo belum bertambah sampai owner memverifikasi pembayaran.` }, { quoted: msg })
        } catch (error) {
            await sock.sendMessage(context.from, { text: `Deposit gagal: ${String(error?.message || error).slice(0, 180)}` }, { quoted: msg })
        }
        return true
    }
    if (root === ".depositstatus") {
        const deposits = Object.values(commerce.snapshot().deposits).filter(item => item.identityKey === customer.key).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        const selected = parts[1] ? deposits.find(item => item.id === parts[1].toUpperCase()) : deposits[0]
        await sock.sendMessage(context.from, { text: selected ? `${selected.id}: ${formatMoney(selected.amount)} — ${selected.state}` : "Belum ada request deposit." }, { quoted: msg })
        return true
    }
    if (root === ".riwayatsaldo") {
        const wallet = commerce.getWallet(customer.jid, context)
        const entries = wallet.ledger.slice(-10).reverse()
        await sock.sendMessage(context.from, { text: entries.length ? entries.map(item => `${item.createdAt} | ${item.type} | ${formatMoney(item.amount)} | ${formatMoney(item.balanceAfter)} | ${item.reason}`).join("\n") : "Riwayat saldo masih kosong." }, { quoted: msg })
        return true
    }
    return false
}

async function handleOwnerCommand(sock, msg, context, root, text) {
    const parts = text.split(/\s+/)
    const actor = context.senderJid || context.from
    try {
        if (root === ".addproduk") {
            const product = commerce.createProduct(parseProductInput(text), actor)
            await sock.sendMessage(context.from, { text: `Produk dibuat.\n${formatProduct(product, true)}` }, { quoted: msg })
            return true
        }
        if (root === ".editproduk") {
            const parsed = parseEditInput(text)
            const product = commerce.editProduct(parsed.id, parsed.patch, actor)
            await sock.sendMessage(context.from, { text: `Produk diperbarui.\n${formatProduct(product, true)}` }, { quoted: msg })
            return true
        }
        if (root === ".delproduk") {
            const product = commerce.deleteProduct(parts[1], actor)
            await sock.sendMessage(context.from, { text: `Produk ${product.id} dinonaktifkan/dihapus dari katalog.` }, { quoted: msg })
            return true
        }
        if (root === ".produkoff" || root === ".produkon") {
            const product = commerce.editProduct(parts[1], { active: root === ".produkon" }, actor)
            await sock.sendMessage(context.from, { text: `${product.id}: ${product.active ? "ON" : "OFF"}.` }, { quoted: msg })
            return true
        }
        if (root === ".stok") {
            const product = commerce.getProduct(parts[1])
            await sock.sendMessage(context.from, { text: product ? `${product.id}: stok ${commerce.productStock(product) == null ? "manual" : commerce.productStock(product)}.` : "Produk tidak ditemukan." }, { quoted: msg })
            return true
        }
        if (root === ".addstok") {
            const raw = text.replace(/^\.addstok\s+/i, "")
            const fields = raw.split("|").map(value => value.trim()).filter(Boolean)
            const productId = fields.shift()?.split(/\s+/)[0]
            let values = fields
            if (!values.length) values = [raw.slice(String(productId || "").length).trim()]
            const result = commerce.addInventory(productId, values, actor)
            await sock.sendMessage(context.from, { text: `Stok ditambah ${result.added}; tersedia ${result.stock}.` }, { quoted: msg })
            return true
        }
        if (root === ".orderlist") {
            const orders = commerce.listOrders().slice(0, 30)
            await sock.sendMessage(context.from, { text: orders.length ? orders.map(order => `${order.id} — ${order.productName} — ${order.state}`).join("\n") : "Order kosong." }, { quoted: msg })
            return true
        }
        if (root === ".order") {
            if (String(parts[2] || "").toLowerCase() === "paid") commerce.markOrderPaid(parts[1], actor)
            const order = commerce.getOrder(parts[1])
            await sock.sendMessage(context.from, { text: order ? formatOrder(order, true) : "Order tidak ditemukan." }, { quoted: msg })
            return true
        }
        if (root === ".orderdone") {
            const result = await deliverOrder(sock, parts[1], actor)
            await sock.sendMessage(context.from, { text: result.duplicate ? "Order sudah pernah diproses; tidak ada delivery kedua." : result.ambiguous ? "Hasil kirim ambigu. Inventory tidak diganti dan pengiriman tidak diulang otomatis." : `Order ${result.order.id} selesai.` }, { quoted: msg })
            return true
        }
        if (root === ".orderreject") {
            const result = commerce.rejectOrder(parts[1], actor, parts.slice(2).join(" "))
            await sock.sendMessage(context.from, { text: `${result.order.id}: REJECTED${result.duplicate ? " (sudah sebelumnya)" : ""}.` }, { quoted: msg })
            return true
        }
        if (root === ".saldoadd" || root === ".saldoreduce") {
            const target = resolveOwnerTarget(msg, parts, context)
            if (!target.key) throw new Error("Target saldo tidak valid")
            const amount = parts[2]
            const result = commerce.mutateWallet({ identity: target.jid, context, direction: root === ".saldoreduce" ? "DEBIT" : "CREDIT", type: "ADJUSTMENT", amount, actor, reason: parts.slice(3).join(" ") || "Owner adjustment", referenceId: operationId(msg, "adjust"), operationId: operationId(msg, root) })
            await sock.sendMessage(context.from, { text: `${target.jid}: saldo ${formatMoney(result.entry.balanceAfter)}.` }, { quoted: msg })
            return true
        }
        if (root === ".depositlist") {
            const deposits = Object.values(commerce.snapshot().deposits).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30)
            await sock.sendMessage(context.from, { text: deposits.length ? deposits.map(item => `${item.id} — ${item.jid} — ${formatMoney(item.amount)} — ${item.state}`).join("\n") : "Deposit kosong." }, { quoted: msg })
            return true
        }
        if (root === ".depositacc") {
            const result = commerce.approveDeposit(parts[1], actor)
            await sock.sendMessage(context.from, { text: `${result.deposit.id}: APPROVED${result.duplicate ? " (idempotent)" : ""}.` }, { quoted: msg })
            return true
        }
        if (root === ".depositreject") {
            const result = commerce.rejectDeposit(parts[1], actor, parts.slice(2).join(" "))
            await sock.sendMessage(context.from, { text: `${result.deposit.id}: REJECTED${result.duplicate ? " (idempotent)" : ""}.` }, { quoted: msg })
            return true
        }
    } catch (error) {
        await sock.sendMessage(context.from, { text: `Commerce command gagal: ${String(error?.message || error).slice(0, 180)}` }, { quoted: msg })
        return true
    }
    return false
}

async function handleCommerceCommand(sock, msg, context = {}) {
    const text = String(context.text || "").trim()
    if (!isCommerceCommand(text)) return false
    const access = await authorizeGroup(sock, msg, context)
    if (!access.allowed) return true
    const root = commandRoot(text)
    if (OWNER_COMMANDS.test(text)) {
        if (!context.isOwner || context.isGroup) {
            if (!context.isGroup) await sock.sendMessage(context.from, { text: "Command commerce owner hanya dapat digunakan owner di private chat." }, { quoted: msg })
            return true
        }
        return handleOwnerCommand(sock, msg, context, root, text)
    }
    try {
        return await handleCustomerCommand(sock, msg, context, root, text, senderIdentity(msg, context))
    } catch (error) {
        await sock.sendMessage(context.from, { text: `Commerce gagal: ${String(error?.message || error).slice(0, 180)}` }, { quoted: msg })
        return true
    }
}

module.exports = {
    GROUP_FEATURE,
    deliverOrder,
    formatMoney,
    formatOrder,
    formatProduct,
    handleCommerceCommand,
    isCommerceCommand,
    parseEditInput,
    parseProductInput,
}
