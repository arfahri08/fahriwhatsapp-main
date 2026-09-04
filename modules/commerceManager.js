"use strict"

const path = require("path")
const crypto = require("crypto")
const { createAtomicJsonStore } = require("./atomicJsonStore")
const identity = require("./canonicalIdentity")

const STATE_FILE = process.env.COMMERCE_STATE_FILE
    ? path.resolve(process.env.COMMERCE_STATE_FILE)
    : path.join(__dirname, "..", "data", "commerceState.json")
const PRODUCT_TYPES = new Set(["manual", "physical", "digital_text", "digital_key", "digital_file"])
const ORDER_STATES = new Set(["PENDING", "PAID", "PROCESSING", "COMPLETED", "REJECTED", "CANCELLED", "DELIVERY_AMBIGUOUS"])
const MAX_AMOUNT = 1_000_000_000_000
const MAX_LEDGER = 50_000
const MAX_OPERATIONS = 20_000

const store = createAtomicJsonStore({
    filePath: STATE_FILE,
    label: "COMMERCE",
    defaultState: () => ({
        version: 1,
        products: {},
        orders: {},
        wallets: {},
        ledger: [],
        deposits: {},
        operations: {},
    }),
})

function normalizeState(value = store.snapshot()) {
    return {
        ...value,
        products: value.products && typeof value.products === "object" ? value.products : {},
        orders: value.orders && typeof value.orders === "object" ? value.orders : {},
        wallets: value.wallets && typeof value.wallets === "object" ? value.wallets : {},
        ledger: Array.isArray(value.ledger) ? value.ledger : [],
        deposits: value.deposits && typeof value.deposits === "object" ? value.deposits : {},
        operations: value.operations && typeof value.operations === "object" ? value.operations : {},
    }
}

function snapshot() {
    return normalizeState(store.snapshot())
}

function update(mutator) {
    let output
    store.update(raw => {
        const state = normalizeState(raw)
        output = mutator(state)
        return state
    })
    return output
}

function randomCode(length = 6) {
    return crypto.randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length).toUpperCase()
}

function dateCode() {
    return new Date().toISOString().slice(0, 10).replace(/-/g, "")
}

function uniqueId(prefix, collection) {
    for (let index = 0; index < 20; index += 1) {
        const id = `${prefix}-${prefix === "WA" ? `${dateCode()}-` : ""}${randomCode(6)}`
        if (!collection[id]) return id
    }
    return `${prefix}-${Date.now()}-${randomCode(4)}`
}

function cleanText(value, max = 500) {
    return String(value || "").replace(/[\0\r]/g, "").trim().slice(0, max)
}

function positiveInteger(value) {
    const amount = Number(value)
    return Number.isSafeInteger(amount) && amount > 0 && amount <= MAX_AMOUNT ? amount : 0
}

function isDigitalType(type) {
    return String(type || "").startsWith("digital_")
}

function productStock(product) {
    if (!product) return 0
    if (isDigitalType(product.type)) return (product.inventory || []).filter(item => item.status === "AVAILABLE").length
    if (product.type === "physical") return Math.max(0, Number(product.stock || 0))
    return product.stock == null ? null : Math.max(0, Number(product.stock || 0))
}

function createProduct(input = {}, actor = "owner") {
    return update(state => {
        const type = PRODUCT_TYPES.has(String(input.type || "")) ? String(input.type) : "manual"
        const price = Number(input.price)
        if (!cleanText(input.name, 100)) throw new Error("Nama produk wajib diisi")
        if (!Number.isSafeInteger(price) || price < 0 || price > MAX_AMOUNT) throw new Error("Harga produk tidak valid")
        const id = cleanText(input.id, 40).toUpperCase() || uniqueId("PRD", state.products)
        if (state.products[id]) throw new Error("ID produk sudah ada")
        const now = new Date().toISOString()
        state.products[id] = {
            id,
            name: cleanText(input.name, 100),
            description: cleanText(input.description, 1000),
            price,
            type,
            active: input.active !== false,
            stock: type === "physical" ? Math.max(0, Number(input.stock || 0)) : (type === "manual" ? null : 0),
            inventory: [],
            createdAt: now,
            updatedAt: now,
            updatedBy: cleanText(actor, 100),
        }
        return state.products[id]
    })
}

function editProduct(productId, patch = {}, actor = "owner") {
    const id = cleanText(productId, 40).toUpperCase()
    return update(state => {
        const current = state.products[id]
        if (!current) throw new Error("Produk tidak ditemukan")
        const next = { ...current }
        if (patch.name !== undefined) next.name = cleanText(patch.name, 100) || current.name
        if (patch.description !== undefined) next.description = cleanText(patch.description, 1000)
        if (patch.price !== undefined) {
            const price = Number(patch.price)
            if (!Number.isSafeInteger(price) || price < 0 || price > MAX_AMOUNT) throw new Error("Harga tidak valid")
            next.price = price
        }
        if (patch.active !== undefined) next.active = patch.active === true
        if (patch.stock !== undefined && next.type === "physical") next.stock = Math.max(0, Number(patch.stock || 0))
        next.updatedAt = new Date().toISOString()
        next.updatedBy = cleanText(actor, 100)
        state.products[id] = next
        return next
    })
}

function hashInventoryValue(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex")
}

function addInventory(productId, values = [], actor = "owner") {
    const id = cleanText(productId, 40).toUpperCase()
    return update(state => {
        const product = state.products[id]
        if (!product) throw new Error("Produk tidak ditemukan")
        if (!isDigitalType(product.type)) {
            const amount = positiveInteger(Array.isArray(values) ? values[0] : values)
            if (!amount) throw new Error("Jumlah stok tidak valid")
            product.stock = Number(product.stock || 0) + amount
            product.updatedAt = new Date().toISOString()
            return { added: amount, stock: productStock(product) }
        }
        const existingHashes = new Set((product.inventory || []).map(item => item.hash))
        let added = 0
        for (const raw of Array.isArray(values) ? values : [values]) {
            const value = String(raw || "").trim()
            if (!value || value.length > 20_000) continue
            const hash = hashInventoryValue(value)
            if (existingHashes.has(hash)) continue
            existingHashes.add(hash)
            product.inventory.push({ id: `ITM-${randomCode(10)}`, value, hash, status: "AVAILABLE", addedAt: new Date().toISOString(), addedBy: cleanText(actor, 100) })
            added += 1
        }
        product.stock = productStock(product)
        product.updatedAt = new Date().toISOString()
        return { added, stock: productStock(product) }
    })
}

function walletIdentity(input, context = {}) {
    const resolved = identity.canonicalIdentity(input, context)
    if (!resolved.key) throw new Error("Identitas wallet tidak valid")
    return resolved
}

function ensureWallet(state, resolved, context = {}) {
    const legacyKeys = Object.keys(state.wallets).filter(key => key !== resolved.key && identity.canonicalIdentity([
        state.wallets[key]?.jid,
        ...(state.wallets[key]?.aliases || []),
    ], context).key === resolved.key)
    if (legacyKeys.length) {
        const target = state.wallets[resolved.key] || { key: resolved.key, jid: resolved.jid, aliases: [], balance: 0, createdAt: new Date().toISOString() }
        for (const legacyKey of legacyKeys) {
            const legacy = state.wallets[legacyKey]
            target.balance = Number(target.balance || 0) + Number(legacy.balance || 0)
            target.aliases = identity.unique([...(target.aliases || []), ...(legacy.aliases || []), legacy.jid])
            for (const entry of state.ledger) if (entry.identityKey === legacyKey) entry.identityKey = resolved.key
            for (const order of Object.values(state.orders)) if (order.customerKey === legacyKey) {
                order.customerKey = resolved.key
                order.customerJid = resolved.jid || order.customerJid
            }
            for (const deposit of Object.values(state.deposits)) if (deposit.identityKey === legacyKey) {
                deposit.identityKey = resolved.key
                deposit.jid = resolved.jid || deposit.jid
            }
            delete state.wallets[legacyKey]
        }
        state.wallets[resolved.key] = target
    }
    if (!state.wallets[resolved.key]) {
        state.wallets[resolved.key] = { key: resolved.key, jid: resolved.jid, aliases: resolved.candidates, balance: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    } else {
        state.wallets[resolved.key].jid = resolved.jid || state.wallets[resolved.key].jid
        state.wallets[resolved.key].aliases = identity.unique([...(state.wallets[resolved.key].aliases || []), ...resolved.candidates])
    }
    return state.wallets[resolved.key]
}

function pruneOperations(state) {
    const entries = Object.entries(state.operations).sort((a, b) => Number(a[1]?.at || 0) - Number(b[1]?.at || 0))
    while (entries.length > MAX_OPERATIONS) {
        const [key] = entries.shift()
        delete state.operations[key]
    }
    if (state.ledger.length > MAX_LEDGER) state.ledger = state.ledger.slice(-MAX_LEDGER)
}

function appendLedger(state, options) {
    const operationId = cleanText(options.operationId, 200)
    if (operationId && state.operations[operationId]) {
        const ledgerId = state.operations[operationId].ledgerId
        return { duplicate: true, entry: state.ledger.find(item => item.id === ledgerId) || null }
    }
    const amount = positiveInteger(options.amount)
    if (!amount) throw new Error("Nominal harus integer positif")
    const resolved = walletIdentity(options.identity, options.context)
    const wallet = ensureWallet(state, resolved, options.context)
    const before = Number(wallet.balance || 0)
    const direction = options.direction === "DEBIT" ? -1 : 1
    const after = before + direction * amount
    if (after < 0) throw new Error("Saldo tidak mencukupi")
    const entry = {
        id: uniqueId("LED", Object.fromEntries(state.ledger.map(item => [item.id, true]))),
        jid: wallet.jid,
        identityKey: resolved.key,
        type: cleanText(options.type || (direction > 0 ? "CREDIT" : "DEBIT"), 40).toUpperCase(),
        amount,
        balanceBefore: before,
        balanceAfter: after,
        actor: cleanText(options.actor, 120),
        reason: cleanText(options.reason, 500),
        referenceId: cleanText(options.referenceId, 120),
        createdAt: new Date().toISOString(),
    }
    wallet.balance = after
    wallet.updatedAt = entry.createdAt
    state.ledger.push(entry)
    if (operationId) state.operations[operationId] = { type: "ledger", ledgerId: entry.id, at: Date.now() }
    pruneOperations(state)
    return { duplicate: false, entry }
}

function mutateWallet(options = {}) {
    return update(state => appendLedger(state, options))
}

function getWallet(input, context = {}) {
    const resolved = walletIdentity(input, context)
    let output
    update(state => {
        const wallet = ensureWallet(state, resolved, context)
        output = { identity: resolved, wallet: { ...wallet }, ledger: state.ledger.filter(item => item.identityKey === resolved.key).map(item => ({ ...item })) }
        return state
    })
    return output
}

function reserveStock(state, product, orderId) {
    if (isDigitalType(product.type)) {
        const item = (product.inventory || []).find(entry => entry.status === "AVAILABLE")
        if (!item) throw new Error("Stok digital habis")
        item.status = "RESERVED"
        item.orderId = orderId
        item.reservedAt = new Date().toISOString()
        product.stock = productStock(product)
        return { kind: "digital", itemId: item.id, itemHash: item.hash }
    }
    if (product.type === "physical") {
        if (Number(product.stock || 0) <= 0) throw new Error("Stok produk habis")
        product.stock -= 1
        return { kind: "physical", quantity: 1 }
    }
    return { kind: "manual" }
}

function releaseReservation(state, order) {
    const product = state.products[order.productId]
    if (!product || !order.reservation) return
    if (order.reservation.kind === "digital") {
        const item = product.inventory.find(entry => entry.id === order.reservation.itemId)
        if (item && item.status === "RESERVED" && item.orderId === order.id) {
            item.status = "AVAILABLE"
            delete item.orderId
        }
        product.stock = productStock(product)
    } else if (order.reservation.kind === "physical") {
        product.stock = Number(product.stock || 0) + Number(order.reservation.quantity || 1)
    }
    order.reservationReleasedAt = new Date().toISOString()
}

function createOrder(input = {}, context = {}) {
    const operationId = cleanText(input.operationId, 200)
    return update(state => {
        if (operationId && state.operations[operationId]?.orderId) {
            return { duplicate: true, order: state.orders[state.operations[operationId].orderId] }
        }
        const productId = cleanText(input.productId, 40).toUpperCase()
        const product = state.products[productId]
        if (!product || product.active === false) throw new Error("Produk tidak tersedia")
        const customer = walletIdentity(input.customer, context)
        const wallet = ensureWallet(state, customer, context)
        const orderId = uniqueId("WA", state.orders)
        const canPayWallet = Number(wallet.balance || 0) >= Number(product.price || 0)
        const now = new Date().toISOString()
        const order = {
            id: orderId,
            transactionId: orderId,
            productId,
            productName: product.name,
            productType: product.type,
            amount: product.price,
            customerKey: customer.key,
            customerJid: customer.jid,
            state: "PENDING",
            paymentMethod: canPayWallet ? "WALLET" : "MANUAL",
            createdAt: now,
            updatedAt: now,
            delivery: null,
        }
        if (canPayWallet) {
            const reservation = reserveStock(state, product, orderId)
            const debit = product.price > 0 ? appendLedger(state, {
                identity: customer.jid,
                direction: "DEBIT",
                type: "PURCHASE",
                amount: product.price,
                actor: customer.jid,
                reason: `Pembelian ${productId}`,
                referenceId: orderId,
                operationId: `purchase:${orderId}`,
                context,
            }) : null
            order.reservation = reservation
            order.debitLedgerId = debit?.entry?.id || null
            order.state = "PAID"
            order.paidAt = now
        }
        state.orders[orderId] = order
        if (operationId) state.operations[operationId] = { type: "order", orderId, at: Date.now() }
        pruneOperations(state)
        return { duplicate: false, order }
    })
}

function markOrderPaid(orderId, actor = "owner") {
    const id = cleanText(orderId, 80).toUpperCase()
    return update(state => {
        const order = state.orders[id]
        if (!order) throw new Error("Order tidak ditemukan")
        if (["REJECTED", "CANCELLED"].includes(order.state)) throw new Error("Order sudah ditolak/dibatalkan")
        if (order.state === "PENDING") {
            const product = state.products[order.productId]
            order.reservation = reserveStock(state, product, order.id)
            order.state = "PAID"
            order.paidAt = new Date().toISOString()
            order.paymentVerifiedBy = cleanText(actor, 120)
            order.updatedAt = order.paidAt
        }
        return order
    })
}

function beginDelivery(orderId, actor = "owner") {
    const id = cleanText(orderId, 80).toUpperCase()
    return update(state => {
        const order = state.orders[id]
        if (!order) throw new Error("Order tidak ditemukan")
        if (order.delivery?.deliveryAttemptId) return { duplicate: true, order, secret: null }
        if (order.state === "PENDING") {
            const product = state.products[order.productId]
            order.reservation = reserveStock(state, product, order.id)
            order.state = "PAID"
            order.paidAt = new Date().toISOString()
            order.paymentVerifiedBy = cleanText(actor, 120)
        }
        if (!["PAID", "PROCESSING"].includes(order.state)) throw new Error(`Order state ${order.state} tidak dapat diselesaikan`)
        const product = state.products[order.productId]
        const attemptId = crypto.randomUUID()
        let secret = null
        if (order.reservation?.kind === "digital") {
            const item = product.inventory.find(entry => entry.id === order.reservation.itemId)
            if (!item || !["RESERVED", "DELIVERED"].includes(item.status)) throw new Error("Inventory reservation tidak ditemukan")
            secret = { type: product.type, value: item.value, itemId: item.id, hash: item.hash }
        }
        order.delivery = { transactionId: order.id, itemId: secret?.itemId || null, itemHash: secret?.hash || null, sentAt: null, deliveryAttemptId: attemptId, status: "SENDING", startedAt: new Date().toISOString(), actor: cleanText(actor, 120) }
        order.state = "PROCESSING"
        order.updatedAt = new Date().toISOString()
        return { duplicate: false, order: { ...order }, secret }
    })
}

function finishDelivery(orderId, attemptId, success, error = "") {
    const id = cleanText(orderId, 80).toUpperCase()
    return update(state => {
        const order = state.orders[id]
        if (!order || order.delivery?.deliveryAttemptId !== attemptId) throw new Error("Delivery attempt tidak cocok")
        if (order.delivery.status !== "SENDING") return order
        if (success) {
            order.delivery.status = "SENT"
            order.delivery.sentAt = new Date().toISOString()
            order.state = "COMPLETED"
            if (order.reservation?.kind === "digital") {
                const product = state.products[order.productId]
                const item = product.inventory.find(entry => entry.id === order.reservation.itemId)
                if (item) {
                    item.status = "DELIVERED"
                    item.deliveredAt = order.delivery.sentAt
                }
            }
        } else {
            order.delivery.status = "AMBIGUOUS"
            order.delivery.error = cleanText(error, 180)
            order.state = "DELIVERY_AMBIGUOUS"
        }
        order.updatedAt = new Date().toISOString()
        return order
    })
}

function completeNonDigital(orderId, actor = "owner") {
    const id = cleanText(orderId, 80).toUpperCase()
    return update(state => {
        const order = state.orders[id]
        if (!order) throw new Error("Order tidak ditemukan")
        if (order.state === "COMPLETED") return { duplicate: true, order }
        if (order.state === "PENDING") {
            const product = state.products[order.productId]
            order.reservation = reserveStock(state, product, order.id)
            order.paidAt = new Date().toISOString()
        }
        if (isDigitalType(order.productType)) throw new Error("Gunakan digital delivery")
        if (["REJECTED", "CANCELLED"].includes(order.state)) throw new Error("Order tidak dapat diselesaikan")
        order.state = "COMPLETED"
        order.completedAt = new Date().toISOString()
        order.completedBy = cleanText(actor, 120)
        order.updatedAt = order.completedAt
        return { duplicate: false, order }
    })
}

function rejectOrder(orderId, actor = "owner", reason = "") {
    const id = cleanText(orderId, 80).toUpperCase()
    return update(state => {
        const order = state.orders[id]
        if (!order) throw new Error("Order tidak ditemukan")
        if (order.state === "REJECTED") return { duplicate: true, order }
        if (["COMPLETED", "DELIVERY_AMBIGUOUS"].includes(order.state)) throw new Error("Order yang telah dikirim tidak dapat ditolak")
        releaseReservation(state, order)
        if (order.debitLedgerId && !order.refundLedgerId) {
            const refund = appendLedger(state, {
                identity: order.customerJid,
                direction: "CREDIT",
                type: "REFUND",
                amount: order.amount,
                actor,
                reason: cleanText(reason, 500) || `Refund order ${order.id}`,
                referenceId: order.id,
                operationId: `refund:${order.id}`,
            })
            order.refundLedgerId = refund.entry?.id || null
        }
        order.state = "REJECTED"
        order.rejectedAt = new Date().toISOString()
        order.rejectedBy = cleanText(actor, 120)
        order.rejectReason = cleanText(reason, 500)
        order.updatedAt = order.rejectedAt
        return { duplicate: false, order }
    })
}

function createDeposit(input = {}, context = {}) {
    const operationId = cleanText(input.operationId, 200)
    return update(state => {
        if (operationId && state.operations[operationId]?.depositId) return { duplicate: true, deposit: state.deposits[state.operations[operationId].depositId] }
        const amount = positiveInteger(input.amount)
        if (!amount) throw new Error("Nominal deposit tidak valid")
        const customer = walletIdentity(input.customer, context)
        const id = uniqueId("DEP", state.deposits)
        const deposit = { id, jid: customer.jid, identityKey: customer.key, amount, state: "PENDING", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        state.deposits[id] = deposit
        if (operationId) state.operations[operationId] = { type: "deposit", depositId: id, at: Date.now() }
        pruneOperations(state)
        return { duplicate: false, deposit }
    })
}

function approveDeposit(depositId, actor = "owner") {
    const id = cleanText(depositId, 80).toUpperCase()
    return update(state => {
        const deposit = state.deposits[id]
        if (!deposit) throw new Error("Deposit tidak ditemukan")
        if (deposit.state === "APPROVED") return { duplicate: true, deposit, ledger: state.ledger.find(item => item.id === deposit.ledgerId) }
        if (deposit.state === "REJECTED") throw new Error("Deposit sudah ditolak dan tidak dapat di-approve")
        const ledger = appendLedger(state, {
            identity: deposit.jid,
            direction: "CREDIT",
            type: "DEPOSIT_APPROVED",
            amount: deposit.amount,
            actor,
            reason: `Approval deposit ${id}`,
            referenceId: id,
            operationId: `deposit-approval:${id}`,
        })
        deposit.state = "APPROVED"
        deposit.ledgerId = ledger.entry?.id || null
        deposit.approvedAt = new Date().toISOString()
        deposit.approvedBy = cleanText(actor, 120)
        deposit.updatedAt = deposit.approvedAt
        return { duplicate: false, deposit, ledger: ledger.entry }
    })
}

function rejectDeposit(depositId, actor = "owner", reason = "") {
    const id = cleanText(depositId, 80).toUpperCase()
    return update(state => {
        const deposit = state.deposits[id]
        if (!deposit) throw new Error("Deposit tidak ditemukan")
        if (deposit.state === "REJECTED") return { duplicate: true, deposit }
        if (deposit.state === "APPROVED") throw new Error("Deposit yang sudah approved tidak dapat ditolak")
        deposit.state = "REJECTED"
        deposit.rejectedAt = new Date().toISOString()
        deposit.rejectedBy = cleanText(actor, 120)
        deposit.reason = cleanText(reason, 500)
        deposit.updatedAt = deposit.rejectedAt
        return { duplicate: false, deposit }
    })
}

function getProduct(id) {
    return snapshot().products[cleanText(id, 40).toUpperCase()] || null
}

function listProducts(options = {}) {
    return Object.values(snapshot().products).filter(product => options.includeInactive || product.active !== false)
}

function getOrder(id) {
    return snapshot().orders[cleanText(id, 80).toUpperCase()] || null
}

function listOrders(options = {}) {
    const orders = Object.values(snapshot().orders)
    return orders.filter(order => !options.customerKey || order.customerKey === options.customerKey).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

function deleteProduct(productId, actor = "owner") {
    const id = cleanText(productId, 40).toUpperCase()
    return update(state => {
        const product = state.products[id]
        if (!product) throw new Error("Produk tidak ditemukan")
        product.active = false
        product.deletedAt = new Date().toISOString()
        product.updatedAt = product.deletedAt
        product.updatedBy = cleanText(actor, 100)
        return product
    })
}

module.exports = {
    MAX_AMOUNT,
    ORDER_STATES,
    PRODUCT_TYPES,
    STATE_FILE,
    addInventory,
    approveDeposit,
    beginDelivery,
    completeNonDigital,
    createDeposit,
    createOrder,
    createProduct,
    deleteProduct,
    editProduct,
    finishDelivery,
    getOrder,
    getProduct,
    getWallet,
    isDigitalType,
    listOrders,
    listProducts,
    markOrderPaid,
    mutateWallet,
    positiveInteger,
    productStock,
    rejectDeposit,
    rejectOrder,
    snapshot,
    store,
    update,
    walletIdentity,
}
