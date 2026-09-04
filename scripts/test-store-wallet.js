"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-commerce-test-"))
process.env.COMMERCE_STATE_FILE = path.join(temp, "commerce.json")
const commerce = require("../modules/commerceManager")

function run() {
    const customer = "628111111111@s.whatsapp.net"
    const product = commerce.createProduct({ name: "License", description: "Digital", price: 20000, type: "digital_key" })
    assert.strictEqual(commerce.listProducts().length, 1)
    assert.strictEqual(commerce.editProduct(product.id, { name: "License Pro" }).name, "License Pro")
    assert.strictEqual(commerce.addInventory(product.id, ["KEY-001", "KEY-002", "KEY-001"]).added, 2)
    assert.strictEqual(commerce.productStock(commerce.getProduct(product.id)), 2)

    const credit = commerce.mutateWallet({ identity: customer, direction: "CREDIT", type: "ADJUSTMENT", amount: 100000, actor: "owner", operationId: "credit-1" })
    assert.strictEqual(credit.entry.balanceAfter, 100000)
    const duplicateCredit = commerce.mutateWallet({ identity: customer, direction: "CREDIT", type: "ADJUSTMENT", amount: 100000, actor: "owner", operationId: "credit-1" })
    assert.strictEqual(duplicateCredit.duplicate, true)
    assert.strictEqual(commerce.getWallet(customer).wallet.balance, 100000)
    assert.throws(() => commerce.mutateWallet({ identity: customer, direction: "DEBIT", amount: 200000, actor: "owner" }), /Saldo tidak mencukupi/)

    const lid = "123456789@lid"
    commerce.mutateWallet({ identity: lid, direction: "CREDIT", amount: 7000, actor: "owner", operationId: "lid-credit" })
    const aliasContext = { lidAliasStore: { resolveBestJid(jid) { return jid === lid ? "628777777777@s.whatsapp.net" : jid } } }
    assert.strictEqual(commerce.getWallet("628777777777@s.whatsapp.net", aliasContext).wallet.balance, 7000, "wallet LID harus bermigrasi saat PN diketahui")
    assert.strictEqual(Object.keys(commerce.snapshot().wallets).filter(key => /123456789|628777777777/.test(key)).length, 1, "alias tidak boleh membuat dua wallet")

    const deposit = commerce.createDeposit({ customer, amount: 50000, operationId: "deposit-message-1" })
    const approved = commerce.approveDeposit(deposit.deposit.id, "owner")
    assert.strictEqual(approved.deposit.state, "APPROVED")
    assert.strictEqual(commerce.approveDeposit(deposit.deposit.id, "owner").duplicate, true)
    assert.strictEqual(commerce.getWallet(customer).wallet.balance, 150000, "approval duplicate tidak double-credit")
    const rejected = commerce.createDeposit({ customer, amount: 10000, operationId: "deposit-message-2" })
    commerce.rejectDeposit(rejected.deposit.id, "owner", "tidak valid")
    assert.throws(() => commerce.approveDeposit(rejected.deposit.id, "owner"), /sudah ditolak/)

    const orderResult = commerce.createOrder({ productId: product.id, customer, operationId: "buy-message-1" })
    assert.strictEqual(orderResult.order.state, "PAID")
    assert.strictEqual(commerce.getWallet(customer).wallet.balance, 130000)
    assert.strictEqual(commerce.productStock(commerce.getProduct(product.id)), 1)
    const sameOrder = commerce.createOrder({ productId: product.id, customer, operationId: "buy-message-1" })
    assert.strictEqual(sameOrder.order.id, orderResult.order.id)
    assert.strictEqual(commerce.getWallet(customer).wallet.balance, 130000, "purchase debit tepat sekali")

    const begun = commerce.beginDelivery(orderResult.order.id, "owner")
    assert.strictEqual(begun.secret.value, "KEY-001")
    commerce.finishDelivery(orderResult.order.id, begun.order.delivery.deliveryAttemptId, true)
    const duplicateDone = commerce.beginDelivery(orderResult.order.id, "owner")
    assert.strictEqual(duplicateDone.duplicate, true)
    assert.strictEqual(duplicateDone.secret, null, "double orderdone tidak mengeluarkan key lagi")
    assert.strictEqual(commerce.getOrder(orderResult.order.id).state, "COMPLETED")
    assert.strictEqual(commerce.getProduct(product.id).inventory.filter(item => item.status === "DELIVERED").length, 1)

    const ledgerLength = commerce.snapshot().ledger.length
    commerce.store.reload()
    assert.strictEqual(commerce.getProduct(product.id).name, "License Pro", "store reload persistence")
    assert.strictEqual(commerce.snapshot().ledger.length, ledgerLength, "ledger reload persistence")
    assert.ok(commerce.snapshot().ledger.every(entry => ["id", "jid", "type", "amount", "balanceBefore", "balanceAfter", "actor", "reason", "referenceId", "createdAt"].every(key => Object.hasOwn(entry, key))))

    console.log("PASS test-store-wallet")
}

try { run() } finally { fs.rmSync(temp, { recursive: true, force: true }) }
