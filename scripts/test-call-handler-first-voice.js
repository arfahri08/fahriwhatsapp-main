"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "userbot-call-test-"));
const stateFile = path.join(testDirectory, "callFirstVoiceState.json");

process.env.CALL_REPLY_DELAY_MS = "5";
process.env.CALL_TERMINATE_GRACE_MS = "250";
process.env.CALL_FIRST_VOICE_ENABLED = "true";
process.env.CALL_FIRST_VOICE_RESET_MS = "0";
process.env.CALL_SPAM_THRESHOLD = "99";

const callHandler = require("../modules/callHandler");

const CALLER = "628111111111@s.whatsapp.net";
const CALLER_LID = "17756082725042@lid";
const OTHER_CALLER = "628222222222@s.whatsapp.net";
const VALID_OGG_OPUS = Buffer.concat([
    Buffer.from("OggS"),
    Buffer.alloc(24),
    Buffer.from("OpusHead"),
    Buffer.alloc(24),
]);

function wait(ms = 35) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createSocket() {
    const sent = [];
    const ev = new EventEmitter();
    return {
        ev,
        user: { id: "6288287764273:1@s.whatsapp.net" },
        signalRepository: {
            lidMapping: {
                getPNForLID: async jid => jid === CALLER_LID ? CALLER : null,
                getLIDForPN: async jid => jid === CALLER ? CALLER_LID : null,
            },
        },
        sent,
        sendMessage: async (jid, content) => {
            sent.push({ jid, content });
            return { key: { id: `SENT-${sent.length}` } };
        },
    };
}

function callerMessages(sock, jid = CALLER) {
    return sock.sent.filter(item => item.jid === jid);
}

function emitMissedCall(sock, id, from = CALLER_LID) {
    const callerPn = from === CALLER_LID ? CALLER : undefined;
    sock.ev.emit("call", [{ id, from, callerPn, chatId: from, status: "offer" }]);
    // Timeout merupakan bukti missed call eksplisit. `terminate` juga dapat
    // berarti call dijawab sehingga tidak boleh digunakan sebagai bukti tunggal.
    sock.ev.emit("call", [{ id, from, chatId: from, status: "timeout" }]);
}

function emitAmbiguousTerminate(sock, offerId, terminateId = offerId, from = CALLER_LID) {
    const callerPn = from === CALLER_LID ? CALLER : undefined;
    sock.ev.emit("call", [{ id: offerId, from, callerPn, chatId: from, status: "offer" }]);
    sock.ev.emit("call", [{ id: terminateId, from, callerPn, chatId: from, status: "terminate" }]);
}

function emitCallLog(sock, remoteJid, callOutcome, durationSecs = 0) {
    sock.ev.emit("messages.upsert", {
        type: "notify",
        messages: [{
            key: { remoteJid },
            messageTimestamp: Date.now(),
            message: {
                callLogMesssage: { callOutcome, durationSecs, participants: [] },
            },
        }],
    });
}

async function run() {
    const sock = createSocket();
    const spokenTexts = [];
    await callHandler.handleCall(sock, {
        ownerJids: [],
        contactNameStore: {
            resolveSavedContactName: jid => jid === CALLER ? "I Linda" : "",
        },
        lidAliasStore: {
            resolveBestJid: jid => jid,
            rememberAlias: () => ({ saved: true }),
        },
        firstVoiceContentProvider: async text => {
            spokenTexts.push(text);
            return {
                audio: Buffer.concat([VALID_OGG_OPUS, Buffer.from(`voice:${text}`)]),
                mimetype: "audio/ogg; codecs=opus",
                ptt: true,
            };
        },
    });

    emitMissedCall(sock, "FIRST");
    await wait();
    let messages = callerMessages(sock);
    assert.strictEqual(messages.length, 1, "panggilan pertama harus mendapat satu balasan");
    assert.strictEqual(messages[0].jid, CALLER, "callerPn harus menjadi identitas utama untuk event call LID");
    assert.ok(Buffer.isBuffer(messages[0].content.audio), "balasan pertama harus berupa audio");
    assert.strictEqual(messages[0].content.ptt, true, "audio pertama harus dikirim sebagai voice note");
    assert.match(spokenTexts[0], /^Halo, I! /, "voice note harus memakai nama depan kontak tersimpan");
    assert.doesNotMatch(spokenTexts[0], /Linda/, "voice note tidak boleh menyebut sisa nama kontak");
    assert.strictEqual(fs.existsSync(stateFile), false, "state panggilan tidak boleh disimpan ke disk");
    assert.strictEqual(callHandler.getCallAutoReplyHealth().stateMode, "memory-per-process");

    emitMissedCall(sock, "SECOND");
    await wait();
    messages = callerMessages(sock);
    assert.strictEqual(messages.length, 2, "panggilan kedua harus mendapat satu balasan tambahan");
    assert.match(messages[1].content.text, /tidak bisa dihubungi lewat telepon/i);

    sock.ev.emit("call", [{ id: "SECOND", from: CALLER, status: "terminate", duration: 0 }]);
    await wait();
    assert.strictEqual(callerMessages(sock).length, 2, "event final duplikat tidak boleh dibalas ulang");

    emitMissedCall(sock, "OTHER-FIRST", OTHER_CALLER);
    await wait();
    const otherMessages = callerMessages(sock, OTHER_CALLER);
    assert.strictEqual(otherMessages.length, 1, "nomor lain harus memiliki giliran pertama sendiri");
    assert.ok(Buffer.isBuffer(otherMessages[0].content.audio));
    assert.match(spokenTexts[1], /^Halo, Kak! /, "nomor tanpa nama kontak harus memakai sapaan netral");

    sock.ev.emit("call", [{ id: "ANSWERED", from: CALLER, status: "offer" }]);
    sock.ev.emit("call", [{ id: "ANSWERED", from: CALLER, status: "accept" }]);
    sock.ev.emit("call", [{ id: "ANSWERED", from: CALLER, status: "terminate" }]);
    await wait();
    assert.strictEqual(callerMessages(sock).length, 2, "panggilan yang dijawab tidak boleh dibalas");

    sock.ev.emit("call", [{ id: "PREACCEPTED", from: CALLER, status: "offer" }]);
    sock.ev.emit("call", [{ id: "PREACCEPTED", from: CALLER, status: "preaccept" }]);
    sock.ev.emit("call", [{ id: "PREACCEPTED", from: CALLER, status: "terminate" }]);
    await wait();
    assert.strictEqual(callerMessages(sock).length, 2, "preaccept adalah bukti call mulai diangkat dan tidak boleh dibalas");

    sock.ev.emit("call", [{ id: "TRANSPORTED", from: CALLER, status: "offer" }]);
    sock.ev.emit("call", [{ id: "TRANSPORTED", from: CALLER, status: "transport" }]);
    sock.ev.emit("call", [{ id: "TRANSPORTED", from: CALLER, status: "terminate" }]);
    await wait();
    assert.strictEqual(callerMessages(sock).length, 2, "transport adalah bukti koneksi dan tidak boleh dibalas");

    const beforeAmbiguous = callerMessages(sock).length;
    emitAmbiguousTerminate(sock, "AMBIGUOUS-NO-LOG");
    await wait(330);
    assert.strictEqual(callerMessages(sock).length, beforeAmbiguous + 1, "terminate tanpa bukti answered harus menjadi fallback missed");

    emitAmbiguousTerminate(sock, "AMBIGUOUS-CONNECTED");
    emitCallLog(sock, CALLER, 0, 12); // CallLogMessage.CONNECTED
    await wait(330);
    assert.strictEqual(callerMessages(sock).length, beforeAmbiguous + 1, "call-log connected wajib membatalkan fallback auto-reply");

    sock.ev.emit("call", [{ id: "ANSWERED-ID-A", from: CALLER, status: "offer" }]);
    sock.ev.emit("call", [{ id: "ANSWERED-ID-A", from: CALLER, status: "accept" }]);
    sock.ev.emit("call", [{ id: "TERMINATE-ID-B", from: CALLER, status: "terminate" }]);
    await wait();
    assert.strictEqual(callerMessages(sock).length, beforeAmbiguous + 1, "accept dan terminate beda ID tetap dianggap answered");

    emitAmbiguousTerminate(sock, "AMBIGUOUS-MISSED");
    emitCallLog(sock, CALLER, 1, 0); // CallLogMessage.MISSED
    await wait();
    assert.strictEqual(callerMessages(sock).length, beforeAmbiguous + 2, "call-log missed boleh mempercepat balasan terminate");

    emitMissedCall(sock, "AFTER-ANSWER");
    await wait();
    messages = callerMessages(sock);
    assert.strictEqual(messages.length, 5, "setelah pernah mendapat voice note, panggilan berikutnya tetap dibalas");
    assert.match(messages[4].content.text, /tidak bisa dihubungi lewat telepon/i, "answered tidak boleh mereset hitungan runtime");

    sock.ev.emit("call", [{ id: "DURATION", from: CALLER, status: "offer" }]);
    sock.ev.emit("call", [{ id: "DURATION", from: CALLER, status: "terminate", duration: 12 }]);
    await wait();
    assert.strictEqual(callerMessages(sock).length, 5, "panggilan berdurasi harus dianggap dijawab");

    emitMissedCall(sock, "AFTER-DURATION");
    await wait();
    messages = callerMessages(sock);
    assert.strictEqual(messages.length, 6, "panggilan setelah sesi berdurasi tetap harus dibalas");
    assert.match(messages[5].content.text, /tidak bisa dihubungi lewat telepon/i, "durasi panggilan tidak mereset hitungan runtime");

    const markerSock = createSocket();
    const markerCaller = "628333333333@s.whatsapp.net";
    await callHandler.handleCall(markerSock, {
        firstVoiceContentProvider: async () => ({
            audio: VALID_OGG_OPUS,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
        }),
    });
    markerSock.ev.emit("call", [{ id: "ANSWERED-WITHOUT-FINAL", from: markerCaller, status: "offer" }]);
    markerSock.ev.emit("call", [{ id: "ANSWERED-WITHOUT-FINAL", from: markerCaller, status: "accept" }]);
    emitMissedCall(markerSock, "NEW-MISSED-AFTER-ANSWERED", markerCaller);
    await wait();
    assert.strictEqual(callerMessages(markerSock, markerCaller).length, 1, "offer baru harus membersihkan marker answered lama");
    callHandler.disposeCallHandler(markerSock);

    callHandler._simulateProcessRestartForTest();
    emitAmbiguousTerminate(sock, "AFTER-RESTART");
    await wait(330);
    messages = callerMessages(sock);
    assert.strictEqual(messages.length, 7, "terminate-only setelah restart harus tetap membuka giliran voice note pertama");
    assert.ok(Buffer.isBuffer(messages[6].content.audio), "panggilan pertama setelah restart harus berupa voice note");
    assert.match(spokenTexts.at(-1), /^Halo, I! /, "voice note setelah restart tetap harus personal");

    const converted = await callHandler._prepareFirstVoiceAudioForTest({
        audio: Buffer.from("fake-mp3"),
        mimetype: "audio/mpeg",
    }, {
        firstVoiceTranscoder: async () => VALID_OGG_OPUS,
    });
    assert.strictEqual(converted.ptt, true, "hasil OGG/Opus harus menjadi voice note");
    assert.strictEqual(converted.mimetype, "audio/ogg; codecs=opus");

    const regularAudio = await callHandler._prepareFirstVoiceAudioForTest({
        audio: Buffer.from("fake-mp3"),
        mimetype: "audio/mpeg",
    }, {
        firstVoiceTranscoder: async () => { throw new Error("ffmpeg missing"); },
    });
    assert.strictEqual(regularAudio.ptt, false, "MP3 tidak boleh ditandai PTT jika konversi gagal");
    assert.strictEqual(regularAudio.mimetype, "audio/mpeg");

    await assert.rejects(
        callHandler._prepareFirstVoiceAudioForTest({
            audio: Buffer.from("fake-mp3"),
            mimetype: "audio/mpeg",
        }, {
            requireVoiceNote: true,
            firstVoiceTranscoder: async () => { throw new Error("ffmpeg missing"); },
        }),
        error => error?.code === "TTS_VOICE_NOTE_CONVERSION_FAILED",
        "mode TTS command wajib gagal daripada menyamar sebagai VN tanpa OGG/Opus"
    );

    assert.match(callHandler._renderFirstVoiceTextForTest(CALLER, {
        contactNameStore: { resolveSavedContactName: () => "I Linda" },
    }), /^Halo, I! /);
    assert.match(callHandler._renderFirstVoiceTextForTest(CALLER, {
        contactNameStore: { resolveSavedContactName: () => "6211 I Linda" },
    }), /^Halo, I! /, "token angka di cache kontak tidak boleh dibacakan");
    assert.match(callHandler._renderFirstVoiceTextForTest(CALLER, {
        contactNameStore: { resolveSavedContactName: () => "621188881111" },
    }), /^Halo, Kak! /, "nilai kontak berupa nomor harus ditolak total");
    assert.match(callHandler._renderFirstVoiceTextForTest(CALLER, {
        contactNameStore: { resolveSavedContactName: () => "" },
    }), /^Halo, Kak! /);

    // Regresi: kegagalan audio pertama tidak boleh turun kelas menjadi teks dan
    // tidak boleh menghanguskan giliran voice pertama milik caller.
    callHandler._simulateProcessRestartForTest();
    const failingSock = createSocket();
    await callHandler.handleCall(failingSock, {
        firstVoiceContentProvider: async () => { throw new Error("provider sementara gagal"); },
    });
    emitMissedCall(failingSock, "FIRST-AUDIO-FAIL", CALLER);
    await wait();
    assert.strictEqual(callerMessages(failingSock).length, 0, "audio gagal tidak boleh diganti fallback teks");
    assert.strictEqual(callHandler._getCallerReplyModeForTest(CALLER), "first-voice", "jatah audio pertama harus tetap tersedia");
    callHandler.disposeCallHandler(failingSock);

    const recoverySock = createSocket();
    await callHandler.handleCall(recoverySock, {
        firstVoiceContentProvider: async () => ({
            audio: VALID_OGG_OPUS,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
        }),
    });
    emitMissedCall(recoverySock, "FIRST-AUDIO-RECOVERY", CALLER);
    await wait();
    assert.strictEqual(callerMessages(recoverySock).length, 1, "panggilan berikutnya harus mencoba audio lagi");
    assert.strictEqual(callerMessages(recoverySock)[0].content.ptt, true);
    callHandler.disposeCallHandler(recoverySock);

    callHandler.disposeCallHandler(sock);
    console.log("PASS: answered/terminate aman, call-log terverifikasi, voice pertama, retry audio, dan OGG/Opus.");
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        try {
            fs.rmSync(testDirectory, { recursive: true, force: true });
        } catch {}
    });
