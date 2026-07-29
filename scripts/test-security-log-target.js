"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "security-log-target-test-"))
const statePath = path.join(tempRoot, "securityMediaLog.json")
const persistedTarget = "120363111111111111@g.us"
const envTarget = "120363222222222222@g.us"

fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    targetJid: persistedTarget,
    antiDeleteEnabled: true,
    viewOnceEnabled: true,
}, null, 2), "utf8")

process.env.SECURITY_MEDIA_LOG_STATE_PATH = statePath
delete process.env.SECURITY_MEDIA_LOG_JID

const securityMediaLog = require("../modules/securityMediaLog")

try {
    assert.equal(
        securityMediaLog.getSecurityLogJid(),
        persistedTarget,
        "persisted targetJid must be used when env is absent"
    )

    process.env.SECURITY_MEDIA_LOG_JID = envTarget
    assert.equal(
        securityMediaLog.getSecurityLogJid(),
        envTarget,
        "valid env target must override persisted target"
    )

    process.env.SECURITY_MEDIA_LOG_JID = "invalid-target"
    assert.equal(
        securityMediaLog.getSecurityLogJid(),
        persistedTarget,
        "invalid env target must fall back to persisted target"
    )

    delete process.env.SECURITY_MEDIA_LOG_JID
    const state = securityMediaLog.loadState()
    assert.equal(state.targetJid, persistedTarget, "loadState must preserve persisted target")

    console.log("SECURITY_LOG_TARGET_TESTS_OK")
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
}
