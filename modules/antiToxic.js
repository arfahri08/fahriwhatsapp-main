const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const reflectionConfig = require("./antiToxicReflectionConfig");
const lidAliasStore = require("./lidAliasStore");
const antiToxicStickerOcr = require("./antiToxicStickerOcr");
const antiToxicMatcher = require("./antiToxicMatcher");

const WORDS_FILE = path.join(__dirname, "../data/kataKasar.json");
const SEND_TIMEOUT_MS = Number(process.env.ANTI_TOXIC_SEND_TIMEOUT_MS || 12000);
const SEND_RETRY_ATTEMPTS = Number(process.env.ANTI_TOXIC_SEND_RETRY_ATTEMPTS || 3);
const SEND_RETRY_MIN_DELAY_MS = Number(process.env.ANTI_TOXIC_SEND_RETRY_MIN_DELAY_MS || 600);
const SEND_RETRY_MAX_DELAY_MS = Number(process.env.ANTI_TOXIC_SEND_RETRY_MAX_DELAY_MS || 1600);
const SEND_STATUS_WAIT_MS = Number(process.env.ANTI_TOXIC_SEND_STATUS_WAIT_MS || 2500);
const ANTI_TOXIC_WARN_COOLDOWN_MS = Number(process.env.ANTI_TOXIC_WARN_COOLDOWN_MS || 0);
const ANTI_TOXIC_WARNING_LOCK_TTL_MS = 2 * 60 * 1000;
const GROUP_METADATA_TIMEOUT_MS = Number(process.env.ANTI_TOXIC_GROUP_METADATA_TIMEOUT_MS || 7000);
const TRANSLATE_ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.ANTI_TOXIC_TRANSLATE || "true").trim());
const TRANSLATE_TIMEOUT_MS = Number(process.env.ANTI_TOXIC_TRANSLATE_TIMEOUT_MS || 5500);
const TRANSLATE_CACHE_LIMIT = Number(process.env.ANTI_TOXIC_TRANSLATE_CACHE_LIMIT || 300);
const TRANSLATE_MAX_TEXT_LENGTH = Number(process.env.ANTI_TOXIC_TRANSLATE_MAX_TEXT_LENGTH || 300);
const TRANSLATE_LATIN_ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.ANTI_TOXIC_TRANSLATE_LATIN || "true").trim());
const TRANSLATE_LATIN_SOURCE_LANGS = new Set(
    String(process.env.ANTI_TOXIC_TRANSLATE_LATIN_SOURCE_LANGS || "de,fr,es,pt,tl")
        .split(",")
        .map(item => item.trim().toLowerCase())
        .filter(Boolean)
);
const TRANSLATE_TARGETS = String(process.env.ANTI_TOXIC_TRANSLATE_TARGETS || "id,en")
    .split(",")
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 3);
const ANTI_TOXIC_STICKER_OCR_ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.ANTI_TOXIC_STICKER_OCR || "true").trim());
const ANTI_TOXIC_STICKER_OCR_TIMEOUT_MS = Number(process.env.ANTI_TOXIC_STICKER_OCR_TIMEOUT_MS || 15000);
const ANTI_TOXIC_STICKER_OCR_LANGS = String(process.env.ANTI_TOXIC_STICKER_OCR_LANGS || process.env.ANTI_TOXIC_STICKER_OCR_LANG || "eng+ind,eng")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
const ANTI_TOXIC_STICKER_OCR_LANG = ANTI_TOXIC_STICKER_OCR_LANGS[0] || "eng+ind";
const ANTI_TOXIC_STICKER_OCR_MAX_BYTES = parseByteLimit(process.env.ANTI_TOXIC_STICKER_OCR_MAX_BYTES, 3 * 1024 * 1024);
const ANTI_TOXIC_STICKER_OCR_CACHE_LIMIT = Number(process.env.ANTI_TOXIC_STICKER_OCR_CACHE_LIMIT || 300);
const ANTI_TOXIC_STICKER_OCR_MAX_FRAMES = Math.max(1, Number(process.env.ANTI_TOXIC_STICKER_OCR_MAX_FRAMES || 3));
const ANTI_TOXIC_STICKER_OCR_MAX_CANDIDATES = Math.max(1, Number(process.env.ANTI_TOXIC_STICKER_OCR_MAX_CANDIDATES || 6));
const ANTI_TOXIC_STICKER_OCR_DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.ANTI_TOXIC_STICKER_OCR_DEBUG || "false").trim());
const ANTI_TOXIC_WARN_OWNER_MESSAGES = /^(1|true|yes|on)$/i.test(
    String(process.env.ANTI_TOXIC_WARN_OWNER_MESSAGES || process.env.ANTI_TOXIC_TEST_OWNER || "false").trim()
);
const ANTI_TOXIC_STICKER_WARN_FROM_ME = /^(1|true|yes|on)$/i.test(
    String(process.env.ANTI_TOXIC_STICKER_WARN_FROM_ME || process.env.ANTI_TOXIC_TEST_STICKER_FROM_ME || "true").trim()
);
const EXACT_MATCH_IGNORED_WORDS = new Set();
const antiToxicWarningLocks = new Map();
const CLEAN_TOKEN_ALLOWLIST = new Set(
    String(process.env.ANTI_TOXIC_CLEAN_WORDS || "konyol,saran,jemput,cabut,singing")
        .split(",")
        .map(item => item.trim().toLowerCase())
        .filter(Boolean)
);
const ANTI_TOXIC_VARIANT_MATCH_ENABLED = !/^(0|false|off|no)$/i.test(
    String(process.env.ANTI_TOXIC_VARIANT_MATCH || "true").trim()
);
const TOXIC_ALIAS_GROUPS = [
    {
        word: "anjir",
        aliases: [
            "anjr",
            "anjirr",
            "jir",
            "jirr",
            "jier",
            "njir",
            "njirr",
            "njing",
            "njayy",
            "bjir",
            "bjirr",
        ],
    },
    {
        word: "memek",
        aliases: [
            "mmk",
            "mmek",
            "phephek",
            "mhemhek",
        ],
    },
    {
        word: "tai",
        aliases: [
            "taik",
            "tahi",
        ],
    },
    {
        word: "mesum",
        aliases: [
            "msum",
            "msumm",
        ],
    },
    {
        word: "peler",
        aliases: [
            "peler",
            "pler",
            "plerr",
        ],
    },
    {
        word: "jembut",
        aliases: [
            "mbut",
            "mbutt",
            "mbud",
            "mbudd",
            "mbuddd",
        ],
    },
    {
        word: "gila",
        aliases: [
            "gelo",
            "gilo",
            "gilok",
            "gilz",
            "gils",
            "sinting",
            "edan",
            "gendeng",
            "sarap",
            "sableng",
            "kurang waras",
        ],
    },
    {
        word: "bodoh",
        aliases: [
            "bodo",
            "oon",
            "bloon",
            "bego",
            "buyan",
            "dungu",
            "dongok",
            "bongok",
            "bebal",
            "tolol",
            "idiot",
            "bahlul",
            "bahlol",
            "pekok",
            "koplok",
            "belegug",
            "boloho",
            "geblek",
            "gebleh",
            "otak kosong",
            "otak udang",
        ],
    },
];
const FUZZY_TOXIC_WORDS = new Set([
    "anjir",
    "gila",
    "kontol",
    "mesum",
    "peler",
]);
const VARIANT_CHAR_MAP = new Map(Object.entries({
    "0": "o",
    "1": "i",
    "3": "e",
    "4": "a",
    "5": "s",
    "6": "g",
    "7": "t",
    "8": "b",
    "9": "g",
    "@": "a",
    "$": "s",
    "!": "i",
    "|": "i",
}));
const VARIANT_CHAR_CHOICES = new Map(Object.entries({
    "0": ["o"],
    "1": ["i", "l"],
    "3": ["e"],
    "4": ["a"],
    "5": ["s"],
    "6": ["g"],
    "7": ["t"],
    "8": ["b"],
    "9": ["g"],
    "@": ["a"],
    "$": ["s"],
    "!": ["i"],
    "|": ["i", "l"],
}));
const MAX_VARIANT_TOKEN_CANDIDATES = Number(process.env.ANTI_TOXIC_MAX_VARIANT_TOKEN_CANDIDATES || 12);
const MAX_FRAGMENTED_TOKEN_PARTS = Number(process.env.ANTI_TOXIC_MAX_FRAGMENTED_TOKEN_PARTS || 8);
const translateCache = new Map();
const stickerOcrCache = new Map();
let sharpModule = null;
let sharpLoadAttempted = false;
let tesseractModule = null;
let tesseractLoadAttempted = false;
let stickerOcrDependencyWarningShown = false;
const TRANSLATED_TOXIC_ALIASES = [
    {
        word: "memek",
        aliases: [
            "vagina",
            "vaginal",
            "vulva",
            "pussy",
            "cunt",
            "female genitalia",
            "female genitals",
            "female private part",
            "female private parts",
        ],
    },
    {
        word: "kontol",
        aliases: [
            "penis",
            "dick",
            "cock",
            "male genitalia",
            "male genitals",
            "male private part",
            "male private parts",
        ],
    },
    {
        word: "sampah",
        aliases: [
            "rubbish",
            "garbage",
            "trash",
            "junk",
        ],
    },
];

const INITIAL_WORDS = [
    "anjg",
    "anj",
    "babi",
    "bjir",
    "bjirr",
    "bgst",
    "bangsat",
    "bangst",
    "bngsat",
    "bngst",
    "kampang",
    "kmpg",
    "kpg",
    "kampank",
    "memek",
    "mmek",
    "mmk",
    "puki",
    "pilat",
    "tolol",
    "bego",
    "yatim",
    "piatu",
    "ndasmu",
];

const EXTRA_INITIAL_WORDS = [
    "phephek",
    "mhemhek",
    "njayy",
    "njir",
    "njing",
];

const BUILTIN_WORDS = normalizeWords([
    ...INITIAL_WORDS,
    ...EXTRA_INITIAL_WORDS,
    "anjir",
    "anjr",
    "anjirr",
    "anjing",
    "njir",
    "njirr",
    "njing",
    "njayy",
    "tai",
    "taik",
    "tahi",
    "kontol",
    "kntl",
    "memek",
    "mmk",
    "phephek",
    "mhemhek",
    "bangsat",
    "bgst",
    "babi",
    "tolol",
    "bego",
]);

const MORAL_QUOTES = [
    // Islam
    {
        source: "Islam",
        quote: "Lisan yang dijaga adalah tanda hati yang sedang belajar tunduk pada kebaikan.",
    },
    {
        source: "Islam",
        quote: "Berkata baik atau diam adalah jalan sederhana untuk menjaga diri dan orang lain.",
    },
    {
        source: "Islam",
        quote: "Ucapan yang lembut dapat menjadi sedekah, sedangkan kata kasar bisa melukai tanpa terlihat.",
    },
    {
        source: "Islam",
        quote: "Jangan jadikan marah sebagai alasan untuk merusak adab dalam berbicara.",
    },
    {
        source: "Islam",
        quote: "Orang yang kuat bukan hanya mampu menahan tangan, tetapi juga menahan lisan.",
    },
    {
        source: "Islam",
        quote: "Setiap kata akan meninggalkan jejak; pilihlah jejak yang mendekatkan pada kebaikan.",
    },
    {
        source: "Islam",
        quote: "Menjaga ucapan adalah bagian dari menjaga kehormatan diri.",
    },

    // Kristen
    {
        source: "Kristen",
        quote: "Perkataan yang membangun lebih berharga daripada kata tajam yang memenangkan emosi sesaat.",
    },
    {
        source: "Kristen",
        quote: "Kasih tidak perlu berteriak kasar untuk didengar.",
    },
    {
        source: "Kristen",
        quote: "Gunakan mulut untuk menguatkan, bukan menjatuhkan.",
    },
    {
        source: "Kristen",
        quote: "Hati yang damai akan lebih mudah melahirkan perkataan yang menenangkan.",
    },
    {
        source: "Kristen",
        quote: "Jangan biarkan amarah memimpin lidahmu lebih cepat daripada kasih.",
    },
    {
        source: "Kristen",
        quote: "Perkataan yang penuh kasih dapat menjadi terang kecil di tengah suasana panas.",
    },
    {
        source: "Kristen",
        quote: "Menahan kata kasar sering kali lebih kuat daripada membalas dengan suara keras.",
    },

    // Katolik
    {
        source: "Katolik",
        quote: "Martabat sesama tetap harus dihormati, bahkan ketika kita sedang tidak setuju.",
    },
    {
        source: "Katolik",
        quote: "Perkataan yang penuh kasih adalah bentuk kecil dari pelayanan kepada sesama.",
    },
    {
        source: "Katolik",
        quote: "Damai dimulai dari hati, lalu terlihat dari cara kita berbicara.",
    },
    {
        source: "Katolik",
        quote: "Jangan biarkan mulut menjadi alat luka; jadikan ia alat penghiburan.",
    },
    {
        source: "Katolik",
        quote: "Kebaikan tidak kehilangan nilainya hanya karena disampaikan dengan lembut.",
    },
    {
        source: "Katolik",
        quote: "Kerendahan hati membuat seseorang mampu memilih kata yang tidak merendahkan orang lain.",
    },
    {
        source: "Katolik",
        quote: "Mengampuni bukan berarti lemah; kadang dimulai dari menahan balasan yang kasar.",
    },

    // Hindu
    {
        source: "Hindu",
        quote: "Ucapan yang benar, lembut, dan bermanfaat adalah latihan suci bagi diri.",
    },
    {
        source: "Hindu",
        quote: "Kata yang menyakiti akan kembali sebagai kegelisahan; kata yang baik kembali sebagai kedamaian.",
    },
    {
        source: "Hindu",
        quote: "Dharma dapat tampak sederhana: tidak menyakiti lewat pikiran, tindakan, dan ucapan.",
    },
    {
        source: "Hindu",
        quote: "Kendalikan lisan sebagaimana engkau belajar mengendalikan diri.",
    },
    {
        source: "Hindu",
        quote: "Kebenaran yang disampaikan tanpa kelembutan bisa berubah menjadi luka.",
    },
    {
        source: "Hindu",
        quote: "Sebelum berbicara, timbanglah apakah kata itu membawa manfaat atau hanya panas sesaat.",
    },
    {
        source: "Hindu",
        quote: "Ucapan yang jernih lahir dari batin yang tidak dikuasai amarah.",
    },

    // Buddha
    {
        source: "Buddha",
        quote: "Ucapan benar menjauhi dusta, fitnah, kata kasar, dan omong kosong.",
    },
    {
        source: "Buddha",
        quote: "Kemarahan tidak padam dengan kemarahan; ia padam saat batin memilih tenang.",
    },
    {
        source: "Buddha",
        quote: "Satu kata lembut dapat menenangkan lebih banyak daripada seratus kata penuh emosi.",
    },
    {
        source: "Buddha",
        quote: "Perhatikan ucapanmu, sebab dari sana kebiasaan batin terlihat.",
    },
    {
        source: "Buddha",
        quote: "Kata kasar adalah beban; melepasnya membuat batin lebih ringan.",
    },
    {
        source: "Buddha",
        quote: "Berbicaralah pada waktu yang tepat, dengan niat yang baik, dan tanpa keinginan melukai.",
    },
    {
        source: "Buddha",
        quote: "Menang atas amarah sendiri lebih damai daripada menang dalam pertengkaran.",
    },

    // Konghucu
    {
        source: "Konghucu",
        quote: "Seorang susila berhati-hati dalam ucapan dan sungguh-sungguh dalam tindakan.",
    },
    {
        source: "Konghucu",
        quote: "Kata-kata yang tidak dipikirkan dapat merusak hormat yang lama dibangun.",
    },
    {
        source: "Konghucu",
        quote: "Kesopanan terlihat jelas saat seseorang mampu tetap santun dalam keadaan marah.",
    },
    {
        source: "Konghucu",
        quote: "Ucapan yang tertib menunjukkan hati yang sedang menjaga keharmonisan.",
    },
    {
        source: "Konghucu",
        quote: "Jangan cepat berbicara tajam; perbaiki diri dahulu sebelum menilai orang lain.",
    },
    {
        source: "Konghucu",
        quote: "Harmoni dimulai dari kemampuan menahan kata yang tidak perlu.",
    },
    {
        source: "Konghucu",
        quote: "Orang berbudi tidak menggunakan ucapan untuk mempermalukan sesama.",
    },

    // Kepercayaan/Budaya
    {
        source: "Kepercayaan/Budaya",
        quote: "Ajining diri dumunung ing lathi: harga diri seseorang tampak dari tutur katanya.",
    },
    {
        source: "Kepercayaan/Budaya",
        quote: "Mulutmu adalah cermin batinmu; rawatlah agar tidak memantulkan kebencian.",
    },
    {
        source: "Kepercayaan/Budaya",
        quote: "Kata yang keluar tidak bisa ditarik pulang; maka pilihlah sebelum terucap.",
    },
    {
        source: "Kepercayaan/Budaya",
        quote: "Tutur yang halus bukan tanda takut, melainkan tanda tahu diri dan tahu rasa.",
    },
    {
        source: "Kepercayaan/Budaya",
        quote: "Jaga rasa, jaga kata, sebab hidup bersama butuh saling menghormati.",
    },
    {
        source: "Kepercayaan/Budaya",
        quote: "Luka karena kata kadang tidak berdarah, tetapi lama sembuhnya.",
    },
    {
        source: "Kepercayaan/Budaya",
        quote: "Sebelum menegur orang lain, pastikan ucapanmu tidak kehilangan unggah-ungguh.",
    },
];

MORAL_QUOTES.push(
    {
        source: "Islam",
        quote: "Terinspirasi QS Al-Ahzab 33:70: luruskan ucapanmu agar kebaikan ikut menjaga tindakanmu.",
    },
    {
        source: "Islam",
        quote: "Terinspirasi QS Al-Baqarah 2:263: kata yang baik lebih mulia daripada pemberian yang disertai luka.",
    },
    {
        source: "Islam",
        quote: "Terinspirasi hadis tentang menjaga lisan: keselamatan sering dimulai dari kemampuan menahan kata.",
    },
    {
        source: "Katolik",
        quote: "Terinspirasi Efesus 4:29: pakailah perkataan untuk membangun, bukan meruntuhkan martabat sesama.",
    },
    {
        source: "Katolik",
        quote: "Terinspirasi Yakobus 1:19: cepatlah mendengar, lambat berkata kasar, dan lambat dikuasai amarah.",
    },
    {
        source: "Katolik",
        quote: "Terinspirasi Amsal 15:1: jawaban yang lembut dapat meredakan panas yang hampir menjadi pertengkaran.",
    },
    {
        source: "Kristen",
        quote: "Terinspirasi Kolose 4:6: biarlah ucapanmu membawa rasa hormat dan hikmat, bukan bara emosi.",
    },
    {
        source: "Kristen",
        quote: "Terinspirasi Matius 12:36: setiap kata punya tanggung jawab, maka pilihlah yang membawa hidup.",
    },
    {
        source: "Kristen",
        quote: "Terinspirasi Amsal 16:24: kata yang ramah dapat menjadi obat kecil bagi hati yang lelah.",
    },
    {
        source: "Hindu",
        quote: "Terinspirasi Bhagavad Gita 17:15: ucapan yang benar, lembut, dan bermanfaat adalah latihan pengendalian diri.",
    },
    {
        source: "Hindu",
        quote: "Terinspirasi ajaran ahimsa: jangan melukai melalui pikiran, tindakan, maupun ucapan.",
    },
    {
        source: "Hindu",
        quote: "Terinspirasi Sarasamuccaya: kebajikan tampak ketika kata dipilih untuk membawa damai.",
    },
    {
        source: "Buddha",
        quote: "Terinspirasi Jalan Mulia Berunsur Delapan: ucapan benar menjauhi kata kasar dan niat melukai.",
    },
    {
        source: "Buddha",
        quote: "Terinspirasi Dhammapada: kebencian tidak reda dengan kebencian; tenanglah sebelum berbicara.",
    },
    {
        source: "Buddha",
        quote: "Terinspirasi Sigalovada Sutta: tutur yang baik menjaga persahabatan dan kepercayaan.",
    },
    {
        source: "Konghucu",
        quote: "Terinspirasi Lun Yu: pribadi berbudi berhati-hati dalam ucapan dan sungguh-sungguh dalam tindakan.",
    },
    {
        source: "Konghucu",
        quote: "Terinspirasi Zhong Yong: harmoni dimulai dari diri yang mampu menata rasa dan kata.",
    },
    {
        source: "Konghucu",
        quote: "Terinspirasi ajaran ren: hormati sesama dengan ucapan yang tidak mempermalukan.",
    },
    {
        source: "Kepercayaan/Budaya",
        quote: "Kearifan lokal mengingatkan: ajining diri ana ing lathi, harga diri tampak dari tutur kata.",
    },
    {
        source: "Kepercayaan/Budaya",
        quote: "Dalam hidup bersama, jaga rasa dan jaga kata agar hubungan tidak rusak oleh emosi sesaat.",
    },
    {
        source: "Kepercayaan/Budaya",
        quote: "Tutur yang halus bukan kelemahan; ia tanda seseorang tahu tempat, tahu rasa, dan tahu hormat.",
    },
);

let wordCache = null;
let quoteBag = [];
let lastQuoteKey = null;
const sendQueues = new Map();
const warnCooldowns = new Map();
const toxicSendFailureReports = new Map();
const TOXIC_SEND_FAILURE_REPORT_TTL_MS = 10 * 60 * 1000;

function getQuoteKey(item) {
    return `${item.source}::${item.quote}`;
}

function shuffleArray(items) {
    const shuffled = [...items];

    for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled;
}

function refillQuoteBag() {
    quoteBag = shuffleArray(MORAL_QUOTES);

    // Hindari quote terakhir siklus sebelumnya langsung muncul lagi
    // sebagai quote pertama di siklus baru, selama masih ada pilihan lain.
    if (quoteBag.length > 1 && lastQuoteKey) {
        const nextQuoteKey = getQuoteKey(quoteBag[quoteBag.length - 1]);

        if (nextQuoteKey === lastQuoteKey) {
            const swapIndex = Math.floor(Math.random() * (quoteBag.length - 1));
            [quoteBag[quoteBag.length - 1], quoteBag[swapIndex]] = [quoteBag[swapIndex], quoteBag[quoteBag.length - 1]];
        }
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseByteLimit(value, fallback) {
    const clean = String(value || "").trim();
    if (!clean) return fallback;

    const match = clean.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb)?$/i);
    if (!match) return Number(value) || fallback;

    const amount = Number(match[1]);
    const unit = String(match[2] || "b").toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) return fallback;
    if (unit === "mb") return Math.floor(amount * 1024 * 1024);
    if (unit === "kb") return Math.floor(amount * 1024);
    return Math.floor(amount);
}

function randomDelay(min, max) {
    const low = Number.isFinite(min) ? min : SEND_RETRY_MIN_DELAY_MS;
    const high = Number.isFinite(max) ? max : SEND_RETRY_MAX_DELAY_MS;
    return low + Math.floor(Math.random() * (Math.max(high - low, 0) + 1));
}

function withTimeout(promise, timeoutMs, label) {
    let timer = null;

    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`${label || "operation"} timeout after ${timeoutMs}ms`);
            error.code = "ANTI_TOXIC_SEND_TIMEOUT";
            reject(error);
        }, timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function isGroupJid(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@g.us");
}

function isBroadcastJid(jid) {
    const value = String(jid || "").trim().toLowerCase();
    return value === "broadcast" || value === "status@broadcast" || value.endsWith("@broadcast");
}

function isNewsletterJid(jid) {
    const value = String(jid || "").trim().toLowerCase();
    return value === "newsletter" || value.endsWith("@newsletter");
}

function isLidJid(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@lid");
}

function isPrivateUserJid(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@s.whatsapp.net");
}

function isPrivateLidJid(jid) {
    return isLidJid(jid) && Boolean(getJidNumber(jid));
}

function isSendableChatJid(jid) {
    const value = String(jid || "").trim().toLowerCase();
    if (!value || isBroadcastJid(value) || isNewsletterJid(value)) return false;
    return isGroupJid(value) || isPrivateUserJid(value) || isPrivateLidJid(value);
}

function isValidMentionJid(jid) {
    const value = normalizeJid(jid);
    if (!value || isBroadcastJid(value) || isNewsletterJid(value) || isGroupJid(value)) return false;
    return (isPrivateUserJid(value) || isPrivateLidJid(value)) && Boolean(getJidNumber(value));
}

function sanitizeMentions(mentions) {
    const values = Array.isArray(mentions) ? mentions : [];
    return [...new Set(values.map(normalizeJid).filter(isValidMentionJid))];
}

function normalizeJid(value) {
    const clean = String(value || "").trim();
    if (!clean) return null;

    if (/@(s\.whatsapp\.net|lid)$/i.test(clean)) {
        const [rawUser, rawServer] = clean.split("@");
        const user = rawUser.split(":")[0].split("_")[0].replace(/[^0-9]/g, "");
        const server = rawServer.toLowerCase();
        return user ? `${user}@${server}` : null;
    }

    if (isGroupJid(clean)) return clean.split(":")[0].toLowerCase();

    const number = clean.replace(/[^0-9]/g, "");
    return number ? `${number}@s.whatsapp.net` : null;
}

function getJidNumber(jid) {
    return String(jid || "")
        .split("@")[0]
        .split(":")[0]
        .split("_")[0]
        .replace(/[^0-9]/g, "");
}

function getMentionLabel(jid) {
    return getJidNumber(jid) || String(jid || "").split("@")[0].split(":")[0];
}

function getTrueMentionTag(jid) {
    const number = getJidNumber(jid);
    return number ? `@${number}` : "@user";
}

function cleanDisplayName(value) {
    const clean = String(value || "")
        .replace(/\s+/g, " ")
        .trim();

    if (!clean) return "";
    return clean.slice(0, 40);
}

function getMentionDisplayName(msg, fallbackJid, fallbackName = "") {
    const candidates = [
        msg?.pushName,
        msg?.verifiedBizName,
        msg?.notifyName,
        msg?.name,
        fallbackName,
    ]
        .map(cleanDisplayName)
        .filter(Boolean);

    const nonNumberName = candidates.find(name => {
        const onlyNumber = name.replace(/[^0-9]/g, "");
        return !(onlyNumber && onlyNumber.length >= 8);
    });

    if (nonNumberName) return nonNumberName;

    const number = getJidNumber(fallbackJid);
    return number || "~";
}

function buildMentionLabel(msg, mentionJid, fallbackName = "") {
    return getTrueMentionTag(mentionJid || fallbackName);
}

function getOptionalContactName(msg, fallbackName = "") {
    const raw = cleanDisplayName(
        msg?.pushName
        || msg?.verifiedBizName
        || msg?.notifyName
        || msg?.name
        || fallbackName
        || ""
    );

    if (!raw) return "";

    const onlyNumber = raw.replace(/[^0-9]/g, "");
    if (onlyNumber && onlyNumber.length >= 8) return "";

    return raw;
}

function buildTrueMentionHeader(msg, mentionJid, fallbackName = "") {
    const tag = getTrueMentionTag(mentionJid);
    return `🤬 ATTENTION ${tag} 😡`;
}

function buildMentionArray(mentionJid) {
    const jid = normalizeJid(mentionJid);
    if (!jid || !isPrivateJidValue(jid)) return [];
    return [jid];
}

function resolveWarningMentionJid(msg, senderJid, isGroup, senderMention = {}) {
    const key = msg?.key || {};

    const pnCandidates = isGroup
        ? [
            key.participantAlt,
            key.participantPn,
            key.senderPn,
            senderMention?.mentionJid,
            key.participant,
            msg?.participantAlt,
            msg?.participant,
            senderJid,
        ]
        : [
            key.remoteJidAlt,
            key.senderPn,
            key.participantPn,
            senderMention?.mentionJid,
            senderJid,
            key.remoteJid,
        ];

    const lidCandidates = isGroup
        ? [
            key.participant,
            key.participantLid,
            key.senderLid,
            senderMention?.mentionJid,
            msg?.participant,
            senderJid,
        ]
        : [
            key.remoteJid,
            key.senderLid,
            key.participantLid,
            senderMention?.mentionJid,
            senderJid,
        ];

    return uniqueNormalizedJids(pnCandidates).find(isPnJidValue)
        || uniqueNormalizedJids(lidCandidates).find(isLidJidValue)
        || null;
}

function getOffenderMentionJid(msg, senderJid) {
    return uniqueNormalizedJids([
        msg?.key?.participantAlt,
        msg?.key?.participantPn,
        msg?.key?.senderPn,
        msg?.key?.participant,
        msg?.key?.participantLid,
        msg?.key?.senderLid,
        msg?.participantAlt,
        msg?.participant,
        senderJid,
    ]).find(isPrivateJidValue) || null;
}

function isSameUser(a, b) {
    const numberA = getJidNumber(a);
    const numberB = getJidNumber(b);
    return Boolean(numberA && numberB && numberA === numberB);
}

function areSameUser(a, b) {
    return isSameUser(a, b);
}

function getRawSenderJid(msg) {
    const key = msg?.key || {};
    const remoteJid = key.remoteJid || "";

    if (isGroupJid(remoteJid)) {
        return key.participantAlt || msg?.participantAlt || key.participant || msg?.participant || remoteJid;
    }

    return key.remoteJidAlt || key.participantAlt || msg?.participantAlt || key.participant || msg?.participant || remoteJid;
}

function getErrorStatusCode(error) {
    return error?.output?.statusCode || error?.statusCode || error?.data?.statusCode || error?.code || null;
}

function createSendMeta(jid, options = {}, meta = {}) {
    const quoted = options?.quoted || meta?.quoted || meta?.msg || null;
    const remoteJid = jid || meta.remoteJid || quoted?.key?.remoteJid || "";
    const senderJid = meta.senderJid || getRawSenderJid(quoted);

    return {
        remoteJid,
        senderJid,
        messageId: meta.messageId || quoted?.key?.id || "",
        fromMe: Boolean(meta.fromMe ?? quoted?.key?.fromMe),
        isGroup: Boolean(meta.isGroup ?? isGroupJid(remoteJid)),
        ...meta,
        remoteJid,
        senderJid,
    };
}

function logAntiToxicDebug(label, details = {}) {
    console.log(label, {
        stage: details.stage,
        remoteJid: details.remoteJid,
        senderJid: details.senderJid,
        messageId: details.messageId,
        fromMe: details.fromMe,
        isGroup: details.isGroup,
        isLid: details.isLid ?? isLidJid(details.remoteJid),
        attempt: details.attempt,
        variantIndex: details.variantIndex,
        fallbackType: details.fallbackType,
        variantsTried: details.variantsTried,
        sentMessageId: details.sentMessageId,
        sentRemoteJid: details.sentRemoteJid,
        sentFromMe: details.sentFromMe,
        sentParticipant: details.sentParticipant,
        sentStatus: details.sentStatus,
        sentTimestamp: details.sentTimestamp,
        statusCode: details.statusCode,
        errorMessage: details.error?.message || details.errorMessage,
        stack: details.error?.stack,
    });
}

function isAntiToxicDebug() {
    return /^(1|true|yes|on)$/i.test(String(process.env.ANTI_TOXIC_DEBUG || "false").trim());
}

function debugAntiToxic(stage, details = {}) {
    if (!isAntiToxicDebug()) return;
    console.log("[ANTI-TOXIC DEBUG]", { stage, ...details });
}

function getAntiToxicReplyMode() {
    return String(process.env.ANTI_TOXIC_REPLY_MODE || "smart_reply")
        .trim()
        .toLowerCase();
}

function isSmartReplyMode() {
    return getAntiToxicReplyMode() === "smart_reply";
}

function getGroupWarnMode() {
    return String(process.env.ANTI_TOXIC_GROUP_WARN_MODE || "group_only")
        .trim()
        .toLowerCase();
}

function isGroupOnlyWarnMode() {
    return getGroupWarnMode() === "group_only";
}

function cleanupAntiToxicWarningLocks() {
    const now = Date.now();

    for (const [key, value] of antiToxicWarningLocks.entries()) {
        if (now - value.createdAt > ANTI_TOXIC_WARNING_LOCK_TTL_MS) {
            antiToxicWarningLocks.delete(key);
        }
    }
}

function getWarningLockKey(msg, mode) {
    const id = msg?.key?.id || "";
    const remoteJid = msg?.key?.remoteJid || "";
    return `${mode || "default"}:${remoteJid}:${id}`;
}

function acquireWarningLock(msg, mode) {
    cleanupAntiToxicWarningLocks();

    const key = getWarningLockKey(msg, mode);
    if (antiToxicWarningLocks.has(key)) {
        console.log("[ANTI-TOXIC DEDUP] duplicate toxic warning blocked", {
            key,
            id: msg?.key?.id,
            remoteJid: msg?.key?.remoteJid,
            mode,
        });

        return false;
    }

    antiToxicWarningLocks.set(key, {
        createdAt: Date.now(),
        messageId: msg?.key?.id,
        remoteJid: msg?.key?.remoteJid,
        mode,
    });

    return true;
}

function acquireAntiToxicWarnDedup(msg) {
    return acquireWarningLock(msg, "anti-toxic-warning");
}

function normalizeJidForCompare(value) {
    const clean = String(value || "").trim();
    if (!clean) return null;

    const lower = clean.toLowerCase();
    if (lower.endsWith("@s.whatsapp.net") || lower.endsWith("@lid")) {
        const [rawUser] = clean.split("@");
        const rawServer = lower.split("@").pop();
        const user = rawUser.split(":")[0].split("_")[0].replace(/[^0-9]/g, "");
        return user ? `${user}@${rawServer}` : null;
    }

    if (lower.endsWith("@g.us")) return lower.split(":")[0];

    const number = clean.replace(/[^0-9]/g, "");
    return number ? `${number}@s.whatsapp.net` : null;
}

function getJidNumberForCompare(value) {
    return String(value || "")
        .split("@")[0]
        .split(":")[0]
        .split("_")[0]
        .replace(/[^0-9]/g, "");
}

function isSameJidUserForCompare(a, b) {
    const na = normalizeJidForCompare(a);
    const nb = normalizeJidForCompare(b);
    if (na && nb && na === nb) return true;

    const aa = getJidNumberForCompare(a);
    const bb = getJidNumberForCompare(b);
    return Boolean(aa && bb && aa === bb);
}

function getBotSelfJidCandidates(sock, ownerJid) {
    const raw = [
        sock?.user?.id,
        sock?.user?.lid,
        sock?.authState?.creds?.me?.id,
        sock?.authState?.creds?.me?.lid,
        ownerJid,
        process.env.OWNER_JID,
        process.env.ACTIVE_NOTIFY_JIDS,
    ]
        .filter(Boolean)
        .join(",")
        .split(",");

    return [...new Set(raw
        .map(item => normalizeJidForCompare(item))
        .filter(Boolean))];
}

function isBotSelfOrOwnerJid(jid, sock, ownerJid) {
    const target = normalizeJidForCompare(jid);
    if (!target) return false;

    return getBotSelfJidCandidates(sock, ownerJid)
        .some(selfJid => isSameJidUserForCompare(target, selfJid));
}

function isGroupJidValue(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@g.us");
}

function isLidJidValue(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@lid");
}

function isPnJidValue(jid) {
    return String(jid || "").trim().toLowerCase().endsWith("@s.whatsapp.net");
}

function isPrivateJidValue(jid) {
    return isPnJidValue(jid) || isLidJidValue(jid);
}

function isPrivateSendableJid(jid) {
    const value = String(jid || "").trim().toLowerCase();
    return value.endsWith("@s.whatsapp.net") || value.endsWith("@lid");
}

function isSendableAntiToxicTarget(jid) {
    const value = String(jid || "").trim().toLowerCase();
    if (!value) return false;
    if (value === "status@broadcast") return false;
    if (value.endsWith("@newsletter")) return false;
    return value.endsWith("@s.whatsapp.net")
        || value.endsWith("@lid")
        || value.endsWith("@g.us");
}

function uniqueNormalizedJids(items) {
    const seen = new Set();
    const result = [];

    for (const item of items || []) {
        const normalized = normalizeJidForCompare(item);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }

    return result;
}

function isAntiToxicOwnerCommandText(text) {
    const clean = String(text || "").trim().toLowerCase();
    return clean.startsWith(".cekkasar")
        || clean.startsWith(".kasar")
        || clean.startsWith(".antitoxicstatus")
        || clean.startsWith(".antitoxicreload")
        || clean.startsWith(".testwarn")
        || clean.startsWith(".bindlid")
        || clean.startsWith(".ceklid")
        || clean.startsWith(".unlid")
        || clean.startsWith(".listlid");
}

function isAntiToxicGeneratedText(text) {
    const clean = String(text || "").trim();
    return clean.startsWith("*ANTI-TOXIC TERDETEKSI TAPI WARNING GAGAL DIKIRIM*")
        || clean.startsWith("ANTI-TOXIC TERDETEKSI TAPI WARNING GAGAL")
        || clean.startsWith("ANTI-TOXIC CHECK")
        || clean.startsWith("ANTI-TOXIC STATUS")
        || clean.includes("ANTI-TOXIC TERDETEKSI TAPI WARNING GAGAL DIKIRIM")
        || clean.includes("Pengirim masih berupa LID:")
        || clean.includes("Penyebab: bot belum punya mapping LID")
        || clean.includes("Solusi manual kalau owner tahu nomor user:")
        || clean.includes("Targets tried:")
        || clean.includes("Send mode:");
}

function sanitizePublicAntiToxicWarningText(text) {
    return String(text || "")
        .split("\n")
        .filter(line => {
            const normalized = line.trim().toLowerCase();
            if (!normalized) return true;
            if (normalized.startsWith("kamu mengucapkannya di grup")) return false;
            if (normalized.startsWith("kamu menyebutkannya di grup")) return false;
            return true;
        })
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function sanitizeAntiToxicWarningMessage(message) {
    if (!message || typeof message !== "object") return message;
    if (typeof message.text !== "string") return message;
    return {
        ...message,
        text: sanitizePublicAntiToxicWarningText(message.text),
    };
}

function isFailedSendStatus(status) {
    return Number(status) === 0 || String(status || "").toLowerCase() === "error";
}

function shouldWaitForSendStatus(jid, sent) {
    return SEND_STATUS_WAIT_MS > 0 && isLidJid(jid) && Boolean(sent?.key?.id);
}

function waitForSentMessageStatus(sock, sent, timeoutMs = SEND_STATUS_WAIT_MS) {
    const messageId = sent?.key?.id;
    if (!messageId || !sock?.ev || typeof sock.ev.on !== "function") return Promise.resolve(null);

    return new Promise(resolve => {
        let done = false;
        const finish = value => {
            if (done) return;
            done = true;

            clearTimeout(timer);
            if (typeof sock.ev.off === "function") {
                sock.ev.off("messages.update", handler);
            } else if (typeof sock.ev.removeListener === "function") {
                sock.ev.removeListener("messages.update", handler);
            }

            resolve(value);
        };
        const handler = updates => {
            for (const item of updates || []) {
                if (item?.key?.id !== messageId) continue;

                finish({
                    status: item?.update?.status ?? item?.status,
                    updateKeys: Object.keys(item?.update || {}),
                    remoteJid: item?.key?.remoteJid,
                    fromMe: item?.key?.fromMe,
                    participant: item?.key?.participant,
                });
                return;
            }
        };
        const timer = setTimeout(() => finish(null), timeoutMs);

        if (typeof timer.unref === "function") timer.unref();
        sock.ev.on("messages.update", handler);
    });
}

async function getGroupParticipants(sock, groupJid, meta = {}) {
    if (!isGroupJid(groupJid) || typeof sock?.groupMetadata !== "function") return [];

    try {
        const metadata = await withTimeout(
            sock.groupMetadata(groupJid),
            GROUP_METADATA_TIMEOUT_MS,
            `groupMetadata ${groupJid}`
        );

        return Array.isArray(metadata?.participants) ? metadata.participants : [];
    } catch (error) {
        logAntiToxicDebug("[ANTI-TOXIC DEBUG]", {
            ...meta,
            stage: "group-metadata-failed",
            remoteJid: groupJid,
            statusCode: getErrorStatusCode(error),
            error,
        });
        return [];
    }
}

function sanitizeGroupSubject(value) {
    return String(value || "")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 80);
}

async function getGroupSubject(sock, groupJid, meta = {}) {
    if (!isGroupJid(groupJid) || typeof sock?.groupMetadata !== "function") return "";

    try {
        const metadata = await withTimeout(
            sock.groupMetadata(groupJid),
            GROUP_METADATA_TIMEOUT_MS,
            `groupMetadata ${groupJid}`
        );

        return sanitizeGroupSubject(metadata?.subject || metadata?.name);
    } catch (error) {
        logAntiToxicDebug("[ANTI-TOXIC DEBUG]", {
            ...meta,
            stage: "group-subject-failed",
            remoteJid: groupJid,
            statusCode: getErrorStatusCode(error),
            error,
        });
        return "";
    }
}

async function resolveGroupMentionJids(sock, groupJid, candidateJids = [], meta = {}) {
    const candidates = sanitizeMentions(candidateJids);
    if (!isGroupJid(groupJid) || candidates.length === 0) return candidates;

    const participants = await getGroupParticipants(sock, groupJid, meta);
    if (participants.length === 0) return [];

    const participantJids = participants
        .map(participant => participant?.id || participant?.jid || participant)
        .map(normalizeJid)
        .filter(isValidMentionJid);

    return candidates.filter(candidate => participantJids.some(participantJid => areSameUser(participantJid, candidate)));
}

function getParticipantJidFields(participant) {
    if (!participant) return [];
    if (typeof participant === "string") return [participant];

    return [
        participant.id,
        participant.jid,
        participant.lid,
        participant.phoneNumber,
        participant.phoneNumberJid,
        participant.pn,
        participant.pnJid,
        participant.participant,
    ].filter(Boolean);
}

function getSenderMentionCandidates(msg, senderJid) {
    // contextInfo.participant adalah pemilik pesan yang di-reply, bukan pengirim pesan ini.
    return expandPrivateJidAliases([
        senderJid,
        msg?.key?.participantAlt,
        msg?.key?.participant,
        msg?.participantAlt,
        msg?.participant,
        msg?.key?.remoteJidAlt,
        msg?.key?.remoteJid,
    ]);
}

async function resolveSenderMention(sock, remoteJid, senderJid, msg, meta = {}) {
    const candidates = [...new Set(getSenderMentionCandidates(msg, senderJid))];
    const directMention = candidates.find(isPrivateUserJid) || candidates.find(isPrivateLidJid);

    if (!isGroupJid(remoteJid)) {
        if (directMention && isValidMentionJid(directMention)) {
            return {
                mentionJid: directMention,
                label: getMentionDisplayName(msg, directMention),
                source: isLidJid(directMention) ? "private-lid" : "private",
            };
        }

        return {
            mentionJid: null,
            label: getMentionDisplayName(msg, senderJid),
            source: "private-text",
        };
    }

    if (directMention && isPrivateUserJid(directMention)) {
        return {
            mentionJid: directMention,
            label: getMentionDisplayName(msg, directMention),
            source: "group-direct-pn",
        };
    }

    const metadata = await getGroupParticipants(sock, remoteJid, meta);
    const candidateSet = new Set(candidates.map(value => value.toLowerCase()));

    for (const participant of metadata) {
        const fields = getParticipantJidFields(participant)
            .map(normalizeJid)
            .filter(Boolean);
        const normalizedFields = fields.map(value => value.toLowerCase());

        if (!normalizedFields.some(value => candidateSet.has(value))) continue;

        const pnJid = fields.find(isPrivateUserJid);
        const lidJid = fields.find(isPrivateLidJid);
        const mentionJid = pnJid || lidJid;

        if (pnJid && lidJid) {
            lidAliasStore.rememberAlias(lidJid, pnJid, {
                source: "group-metadata",
                pushName: participant?.name || participant?.notify || participant?.verifiedName || "",
                messageId: msg?.key?.id,
                remoteJid,
            });
        } else if (lidJid) {
            lidAliasStore.rememberSeenLid(lidJid, {
                source: "group-metadata",
                pushName: participant?.name || participant?.notify || participant?.verifiedName || "",
                messageId: msg?.key?.id,
                remoteJid,
            });
        }

        if (mentionJid && isValidMentionJid(mentionJid)) {
            const participantDisplayName = cleanDisplayName(
                participant?.name
                || participant?.notify
                || participant?.verifiedName
                || participant?.verifiedBizName
                || participant?.pushName
                || ""
            );
            return {
                mentionJid,
                label: getMentionDisplayName(msg, mentionJid, participantDisplayName),
                source: pnJid ? "group-metadata-pn" : "group-metadata-lid",
            };
        }
    }

    if (directMention && isValidMentionJid(directMention)) {
        return {
            mentionJid: directMention,
            label: getMentionDisplayName(msg, directMention),
            source: isLidJid(directMention) ? "group-lid-fallback" : "group-fallback",
        };
    }

    return {
        mentionJid: null,
        label: getMentionDisplayName(msg, senderJid),
        source: "group-text-only",
    };
}

function uniqueJids(items) {
    return [...new Set((items || []).filter(Boolean))];
}

function getPnAliasForJid(jid) {
    const normalized = normalizeJid(jid);
    if (!normalized) return null;
    if (isPrivateUserJid(normalized)) return normalized;
    if (isPrivateLidJid(normalized)) return lidAliasStore.getPnForLid(normalized);
    return null;
}

function resolveKnownPrivateJidForLog(jid) {
    const normalized = normalizeJid(jid);
    if (!normalized) return jid;
    if (!isPrivateLidJid(normalized)) return normalized;
    return lidAliasStore.getPnForLid(normalized) || normalized;
}

function expandPrivateJidAliases(jids) {
    const normalized = uniqueJids((jids || []).map(normalizeJid).filter(Boolean));
    const pnAliases = normalized
        .map(getPnAliasForJid)
        .filter(isPrivateUserJid);

    return uniqueJids([...pnAliases, ...normalized]);
}

function getPrivateSendCandidateJids(msg, senderJid, remoteJid, senderMention = {}) {
    return expandPrivateJidAliases([
        msg?.key?.remoteJidAlt,
        msg?.key?.participantAlt,
        msg?.participantAlt,
        senderMention?.mentionJid,
        msg?.key?.participant,
        msg?.participant,
        senderJid,
        remoteJid,
    ].map(normalizeJid).filter(Boolean));
}

function prioritizePrivateSendJids(candidates) {
    const unique = uniqueJids(candidates);
    const pn = unique.filter(isPrivateUserJid);
    const lid = unique.filter(isPrivateLidJid);
    return [...pn, ...lid];
}

function getAliasCandidatesFromReflectionState(...jids) {
    const normalizedJids = uniqueJids(jids.map(normalizeJid).filter(Boolean));
    const aliasCandidates = [];

    try {
        if (typeof reflectionConfig.loadState !== "function") return aliasCandidates;

        const state = reflectionConfig.loadState();
        for (const jid of normalizedJids) {
            const primary = normalizeJid(state?.aliases?.[jid]);
            if (primary) aliasCandidates.push(primary);

            const knownAliases = Array.isArray(state?.knownAliases?.[jid]) ? state.knownAliases[jid] : [];
            aliasCandidates.push(...knownAliases.map(normalizeJid).filter(Boolean));

            for (const [alias, target] of Object.entries(state?.aliases || {})) {
                const normalizedAlias = normalizeJid(alias);
                const normalizedTarget = normalizeJid(target);
                if (normalizedAlias === jid && normalizedTarget) aliasCandidates.push(normalizedTarget);
                if (normalizedTarget === jid && normalizedAlias) aliasCandidates.push(normalizedAlias);
            }

            for (const entry of Object.values(state?.users || {})) {
                const entryJid = normalizeJid(entry?.jid);
                const entryAliases = (entry?.aliases || []).map(normalizeJid).filter(Boolean);
                if (entryJid === jid || entryAliases.includes(jid)) {
                    aliasCandidates.push(entryJid, ...entryAliases);
                }
            }
        }
    } catch (error) {
        console.log("[ANTI-TOXIC LID RESOLVE] Alias state gagal", {
            jids: normalizedJids,
            errorMessage: error?.message || String(error),
        });
    }

    return uniqueJids(aliasCandidates.map(normalizeJid).filter(Boolean));
}

async function resolvePrivateWarningTargets(sock, msg, remoteJid, senderJid, senderMention, meta = {}) {
    const candidates = getPrivateSendCandidateJids(msg, senderJid, remoteJid, senderMention);
    const directPn = candidates.find(isPrivateUserJid);

    if (directPn) {
        const result = {
            targets: prioritizePrivateSendJids([directPn, ...candidates]),
            primary: directPn,
            source: "direct-pn",
            candidates,
        };
        console.log("[ANTI-TOXIC LID RESOLVE]", {
            remoteJid,
            senderJid,
            messageId: meta?.messageId,
            source: result.source,
            primary: result.primary,
            targets: result.targets,
            candidates: result.candidates,
        });
        return result;
    }

    const storePn = uniqueJids([remoteJid, senderJid, ...candidates])
        .map(jid => lidAliasStore.getPnForLid(jid))
        .find(isPrivateUserJid);
    if (storePn) {
        const result = {
            targets: prioritizePrivateSendJids([storePn, ...candidates]),
            primary: storePn,
            source: "lid-alias-store",
            candidates,
        };
        console.log("[ANTI-TOXIC LID RESOLVE]", {
            remoteJid,
            senderJid,
            messageId: meta?.messageId,
            source: result.source,
            primary: result.primary,
            targets: result.targets,
            candidates: result.candidates,
        });
        return result;
    }

    const aliasCandidates = [];
    try {
        if (typeof reflectionConfig.getAliases === "function") {
            aliasCandidates.push(...(reflectionConfig.getAliases(senderJid) || []));
            aliasCandidates.push(...(reflectionConfig.getAliases(remoteJid) || []));
        }
        if (typeof reflectionConfig.resolveUserAliases === "function") {
            aliasCandidates.push(...(reflectionConfig.resolveUserAliases(senderJid) || []));
            aliasCandidates.push(...(reflectionConfig.resolveUserAliases(remoteJid) || []));
        }
        if (typeof reflectionConfig.getLinkedJids === "function") {
            aliasCandidates.push(...(reflectionConfig.getLinkedJids(senderJid) || []));
            aliasCandidates.push(...(reflectionConfig.getLinkedJids(remoteJid) || []));
        }
        aliasCandidates.push(...getAliasCandidatesFromReflectionState(senderJid, remoteJid, ...candidates));
    } catch (error) {
        console.log("[ANTI-TOXIC LID RESOLVE] Alias resolver gagal", {
            remoteJid,
            senderJid,
            errorMessage: error?.message || String(error),
        });
    }

    const aliasPn = aliasCandidates.map(normalizeJid).find(isPrivateUserJid);
    if (aliasPn) {
        const result = {
            targets: prioritizePrivateSendJids([aliasPn, ...candidates]),
            primary: aliasPn,
            source: "alias-pn",
            candidates: uniqueJids([...candidates, ...aliasCandidates].map(normalizeJid).filter(Boolean)),
        };
        console.log("[ANTI-TOXIC LID RESOLVE]", {
            remoteJid,
            senderJid,
            messageId: meta?.messageId,
            source: result.source,
            primary: result.primary,
            targets: result.targets,
            candidates: result.candidates,
        });
        return result;
    }

    const fallback = {
        targets: prioritizePrivateSendJids(candidates),
        primary: candidates.find(isPrivateLidJid) || remoteJid,
        source: "lid-only",
        candidates,
    };
    console.log("[ANTI-TOXIC LID RESOLVE]", {
        remoteJid,
        senderJid,
        messageId: meta?.messageId,
        source: fallback.source,
        primary: fallback.primary,
        targets: fallback.targets,
        candidates: fallback.candidates,
    });
    return fallback;
}

function ensureWordsFile() {
    loadWords(true);
}

function sanitizeWord(value) {
    return String(value || "")
        .normalize("NFKC")
        .trim()
        .toLowerCase()
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
        .replace(/\s+/g, " ");
}

function normalizeWords(words) {
    return [...new Set(
        (Array.isArray(words) ? words : [])
            .map(sanitizeWord)
            .filter(Boolean)
    )].sort((a, b) => b.length - a.length);
}

function getBuiltinWords() {
    return [...BUILTIN_WORDS];
}

function mergeBuiltinWords(existingWords = []) {
    return normalizeWords([...(Array.isArray(existingWords) ? existingWords : []), ...BUILTIN_WORDS]);
}

function areWordListsEqual(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((word, index) => word === right[index]);
}

function readWordsFileEntries() {
    const raw = fs.readFileSync(WORDS_FILE, "utf8").replace(/^\uFEFF/, "").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
}

function writeNormalizedWordsFile(words) {
    const normalized = normalizeWords(words);
    fs.mkdirSync(path.dirname(WORDS_FILE), { recursive: true });
    fs.writeFileSync(WORDS_FILE, JSON.stringify(normalized, null, 2));
    return normalized;
}

function loadWords(force = false) {
    if (wordCache && !force) return wordCache;

    fs.mkdirSync(path.dirname(WORDS_FILE), { recursive: true });

    const fileExists = fs.existsSync(WORDS_FILE);
    let existing = [];

    try {
        if (fileExists) {
            existing = readWordsFileEntries();
        }
    } catch (error) {
        console.log("[ANTI-TOXIC] kataKasar.json rusak, fallback builtin:", error.message);
        existing = [];
    }

    const normalizedExisting = normalizeWords(existing);
    const merged = mergeBuiltinWords(normalizedExisting);
    wordCache = merged;

    try {
        const changed = !areWordListsEqual(normalizedExisting, merged);
        if (changed || !fileExists) {
            writeNormalizedWordsFile(merged);
            console.log("[ANTI-TOXIC] kataKasar.json disinkronkan", {
                before: normalizedExisting.length,
                after: merged.length,
            });
        }
    } catch (error) {
        console.log("[ANTI-TOXIC] Gagal menyimpan merge builtin:", error.message);
    }

    return wordCache;
}

function saveWords(words) {
    try {
        const normalized = writeNormalizedWordsFile(mergeBuiltinWords(words));
        wordCache = normalized;
        return true;
    } catch (error) {
        console.log(`[ANTI-TOXIC] Gagal menyimpan kataKasar.json: ${error.message}`);
        return false;
    }
}

function unwrapTextContainerMessage(message) {
    let current = message || {};

    for (let i = 0; i < 6; i += 1) {
        if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
        else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
        else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
        else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
        else break;
    }

    return current;
}

function getIncomingText(msg) {
    const message = unwrapTextContainerMessage(msg?.message || {});
    return String(
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        message.buttonsResponseMessage?.selectedDisplayText ||
        message.listResponseMessage?.title ||
        message.listResponseMessage?.singleSelectReply?.selectedRowId ||
        message.templateButtonReplyMessage?.selectedDisplayText ||
        ""
    ).trim();
}

function isStickerMessage(msg) {
    return Boolean(getStickerMessage(msg));
}

function getStickerMessage(msg) {
    const message = unwrapTextContainerMessage(msg?.message || {});
    return message?.stickerMessage || null;
}

function logStickerOcrDebug(details = {}) {
    if (!ANTI_TOXIC_STICKER_OCR_DEBUG) return;

    console.log("[ANTI-TOXIC STICKER OCR]", {
        messageId: details.messageId,
        remoteJid: details.remoteJid,
        ocrText: details.ocrText,
        durationMs: details.durationMs,
        candidate: details.candidate,
        lang: details.lang,
        frameIndex: details.frameIndex,
        pageCount: details.pageCount,
        stickerBytes: details.stickerBytes,
        error: details.error?.message || details.errorMessage,
    });
}

function warnStickerOcrUnavailable(dependency, error) {
    if (stickerOcrDependencyWarningShown) return;
    stickerOcrDependencyWarningShown = true;

    console.log("[ANTI-TOXIC STICKER OCR] Fitur OCR sticker nonaktif otomatis.", {
        dependency,
        error: error?.message || String(error || "unknown error"),
    });
}

function getSharpModule() {
    if (!ANTI_TOXIC_STICKER_OCR_ENABLED) return null;
    if (sharpLoadAttempted) return sharpModule;
    sharpLoadAttempted = true;

    try {
        sharpModule = require("sharp");
    } catch (error) {
        sharpModule = null;
        warnStickerOcrUnavailable("sharp", error);
    }

    return sharpModule;
}

function getTesseractModule() {
    if (!ANTI_TOXIC_STICKER_OCR_ENABLED) return null;
    if (tesseractLoadAttempted) return tesseractModule;
    tesseractLoadAttempted = true;

    try {
        tesseractModule = require("tesseract.js");
    } catch (error) {
        tesseractModule = null;
        warnStickerOcrUnavailable("tesseract.js", error);
    }

    return tesseractModule;
}

function getBinaryCachePart(value) {
    if (!value) return "";
    if (Buffer.isBuffer(value)) return value.toString("base64");
    if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
    if (Array.isArray(value)) return Buffer.from(value).toString("base64");
    if (value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data).toString("base64");
    return String(value || "").trim();
}

function getStickerOcrCacheKey(msg, stickerMessage) {
    const fileSha = getBinaryCachePart(stickerMessage?.fileSha256);
    if (fileSha) return `fileSha256:${fileSha}`;

    const fileEncSha = getBinaryCachePart(stickerMessage?.fileEncSha256);
    if (fileEncSha) return `fileEncSha256:${fileEncSha}`;

    const remoteJid = String(msg?.key?.remoteJid || "").trim();
    const id = String(msg?.key?.id || "").trim();
    return remoteJid && id ? `message:${remoteJid}:${id}` : "";
}

function rememberStickerOcrCache(key, text) {
    if (!key) return;
    if (stickerOcrCache.has(key)) stickerOcrCache.delete(key);
    stickerOcrCache.set(key, String(text || ""));

    while (stickerOcrCache.size > ANTI_TOXIC_STICKER_OCR_CACHE_LIMIT) {
        const oldestKey = stickerOcrCache.keys().next().value;
        if (!oldestKey) break;
        stickerOcrCache.delete(oldestKey);
    }
}

async function downloadStickerBuffer(sock, msg) {
    void sock;
    const stickerMessage = getStickerMessage(msg);
    if (!stickerMessage) return null;

    const stream = await downloadContentFromMessage(stickerMessage, "sticker");
    const chunks = [];
    let totalBytes = 0;

    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > ANTI_TOXIC_STICKER_OCR_MAX_BYTES) {
            logStickerOcrDebug({
                messageId: msg?.key?.id,
                remoteJid: msg?.key?.remoteJid,
                errorMessage: `sticker melebihi batas ${ANTI_TOXIC_STICKER_OCR_MAX_BYTES} bytes`,
            });
            return null;
        }
        chunks.push(buffer);
    }

    return chunks.length ? Buffer.concat(chunks, totalBytes) : null;
}

function getUniqueNumbers(values) {
    const result = [];
    const seen = new Set();

    for (const value of values) {
        const number = Number(value);
        if (!Number.isFinite(number)) continue;
        const safeNumber = Math.max(0, Math.floor(number));
        if (seen.has(safeNumber)) continue;
        seen.add(safeNumber);
        result.push(safeNumber);
    }

    return result;
}

function pickStickerOcrFrameIndexes(pageCount) {
    const totalPages = Math.max(1, Math.floor(Number(pageCount) || 1));
    const preferred = getUniqueNumbers([
        0,
        Math.floor(totalPages / 3),
        Math.floor(totalPages / 2),
        totalPages - 1,
    ]).filter(index => index < totalPages);

    for (let index = 0; preferred.length < ANTI_TOXIC_STICKER_OCR_MAX_FRAMES && index < totalPages; index += 1) {
        if (!preferred.includes(index)) preferred.push(index);
    }

    return preferred.slice(0, ANTI_TOXIC_STICKER_OCR_MAX_FRAMES);
}

async function getStickerOcrMetadata(buffer, sharp) {
    try {
        return await sharp(buffer, { animated: true, pages: -1 }).metadata();
    } catch (error) {
        logStickerOcrDebug({ error, candidate: "metadata-animated" });
    }

    try {
        return await sharp(buffer, { animated: false }).metadata();
    } catch (error) {
        logStickerOcrDebug({ error, candidate: "metadata-static" });
        return {};
    }
}

function createStickerFramePipeline(sharp, buffer, frameIndex) {
    try {
        return sharp(buffer, {
            animated: true,
            page: frameIndex,
            pages: 1,
        });
    } catch (error) {
        logStickerOcrDebug({ error, candidate: "frame-pipeline", frameIndex });
    }

    return sharp(buffer, { animated: false });
}

async function renderStickerOcrCandidate(buffer, frameIndex, variant) {
    const sharp = getSharpModule();
    if (!sharp) return null;

    let pipeline = createStickerFramePipeline(sharp, buffer, frameIndex)
        .resize({ width: 1200, fit: "inside" })
        .flatten({ background: variant.background })
        .grayscale()
        .normalize()
        .sharpen();

    if (variant.negate) pipeline = pipeline.negate();
    if (variant.threshold) pipeline = pipeline.threshold(variant.threshold);

    try {
        return await pipeline.png().toBuffer();
    } catch (error) {
        logStickerOcrDebug({
            error,
            candidate: variant.name,
            frameIndex,
        });
        return null;
    }
}

async function buildStickerOcrCandidates(buffer) {
    if (!buffer?.length) return [];

    const sharp = getSharpModule();
    if (!sharp) return buildStickerOcrCandidatesWithFrameExtractor(buffer);

    const metadata = await getStickerOcrMetadata(buffer, sharp);
    const pageCount = Math.max(1, Number(metadata?.pages || 1));
    const frameIndexes = pickStickerOcrFrameIndexes(pageCount);
    const variants = [
        { name: "white-threshold", background: "#ffffff", negate: false, threshold: 165 },
        { name: "black-invert-threshold", background: "#000000", negate: true, threshold: 165 },
        { name: "white-normal", background: "#ffffff", negate: false, threshold: 0 },
    ];
    const candidates = [];

    for (const frameIndex of frameIndexes) {
        for (const variant of variants) {
            if (candidates.length >= ANTI_TOXIC_STICKER_OCR_MAX_CANDIDATES) return candidates;

            const imageBuffer = await renderStickerOcrCandidate(buffer, frameIndex, variant);
            if (!imageBuffer?.length) continue;

            candidates.push({
                buffer: imageBuffer,
                candidate: variant.name,
                frameIndex,
                pageCount,
            });
        }
    }

    return candidates;
}

async function buildStickerOcrCandidatesWithFrameExtractor(buffer) {
    try {
        const frames = await stickerFrameExtractor.convertStickerToImageBuffers(buffer, {
            maxFrames: ANTI_TOXIC_STICKER_OCR_MAX_FRAMES,
        });
        return frames
            .filter(frame => frame?.imageBuffer?.length)
            .slice(0, ANTI_TOXIC_STICKER_OCR_MAX_CANDIDATES)
            .map(frame => ({
                buffer: frame.imageBuffer,
                candidate: "ffmpeg-frame",
                frameIndex: frame.frameIndex,
                pageCount: frame.pageCount,
            }));
    } catch (error) {
        logStickerOcrDebug({
            candidate: "ffmpeg-frame",
            error,
        });
        return [];
    }
}

function cleanStickerOcrText(value) {
    return String(value || "")
        .normalize("NFKC")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 300);
}

async function readStickerTextWithOcr(buffer, details = {}) {
    if (!buffer?.length) return "";

    const tesseract = getTesseractModule();
    if (!tesseract) return "";

    for (const lang of ANTI_TOXIC_STICKER_OCR_LANGS.length ? ANTI_TOXIC_STICKER_OCR_LANGS : [ANTI_TOXIC_STICKER_OCR_LANG]) {
        const startedAt = Date.now();
        try {
            const result = await withTimeout(
                tesseract.recognize(buffer, lang),
                ANTI_TOXIC_STICKER_OCR_TIMEOUT_MS,
                `sticker OCR ${lang}`
            );
            const text = cleanStickerOcrText(result?.data?.text);
            logStickerOcrDebug({
                ...details,
                lang,
                ocrText: text,
                durationMs: Date.now() - startedAt,
            });
            if (text) return text;
        } catch (error) {
            logStickerOcrDebug({
                ...details,
                lang,
                durationMs: Date.now() - startedAt,
                error,
            });
        }
    }

    return "";
}

async function getStickerOcrResultIfNeeded(msg, sock) {
    void sock;
    if (!ANTI_TOXIC_STICKER_OCR_ENABLED || !isStickerMessage(msg)) return null;

    return antiToxicStickerOcr.scanStickerForToxicWords(msg, {
        stickerMessage: getStickerMessage(msg),
        toxicWords: loadWords(),
    });
}

async function getStickerOcrTextIfNeeded(msg, sock) {
    const result = await getStickerOcrResultIfNeeded(msg, sock);

    // Hanya canonical match diteruskan ke detector Anti Kasar existing.
    // Detail OCR tetap dipertahankan agar warning dapat menyorot kata yang
    // benar-benar terdeteksi pada stiker.
    return result?.status === "toxic" ? String(result.matchedWord || "") : "";
}

function normalizeStickerOcrWarningText(value) {
    return String(value || "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "")
        .trim();
}

function sanitizeStickerOcrWarningWord(value) {
    return String(value || "")
        .normalize("NFKC")
        .replace(/[`*_~]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
}

function buildStickerOcrWarningContext(result, fallbackWord = "") {
    const matchedWord = sanitizeStickerOcrWarningWord(result?.matchedWord || fallbackWord);
    if (!matchedWord) return "";

    const rawText = String(result?.matchedRawText || result?.rawTexts?.[0] || "")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 160);
    const rawDetail = rawText
        && normalizeStickerOcrWarningText(rawText) !== normalizeStickerOcrWarningText(matchedWord)
        ? `\nTeks OCR: "${rawText}"`
        : "";

    return [
        "🧾 *TEKS KASAR PADA STIKER*",
        `> *Kata terdeteksi:* \`${matchedWord}\`${rawDetail}`,
        "",
    ].join("\n");
}

async function getIncomingToxicText(msg, sock) {
    const text = getIncomingText(msg);
    if (text) return text;
    return getStickerOcrTextIfNeeded(msg, sock);
}

function getSenderJid(msg) {
    return normalizeJid(getRawSenderJid(msg));
}

function isPrivateOrGroupChat(jid) {
    return isSendableChatJid(jid);
}

function tokenizeExactWords(text) {
    const normalized = String(text || "")
        .toLowerCase()
        .normalize("NFKC");

    return normalized.match(/[\p{L}\p{N}]+/gu) || [];
}

function tokenizeVariantWords(text) {
    const normalized = String(text || "")
        .toLowerCase()
        .normalize("NFKC");

    return normalized.match(/[\p{L}\p{N}@#$!|]+/gu) || [];
}

function normalizeVariantToken(token) {
    const compact = String(token || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[013456789@$!|]/g, char => VARIANT_CHAR_MAP.get(char) || char)
        .replace(/[^\p{L}\p{N}]+/gu, "");

    if (compact.length <= 3) return compact;
    return compact.replace(/([\p{L}\p{N}])\1+/gu, "$1");
}

function normalizeVariantCandidate(value) {
    const compact = String(value || "").replace(/[^\p{L}\p{N}]+/gu, "");
    if (compact.length <= 3) return compact;
    return compact.replace(/([\p{L}\p{N}])\1+/gu, "$1");
}

function getVariantCharChoices(char) {
    const clean = String(char || "").toLowerCase();
    if (VARIANT_CHAR_CHOICES.has(clean)) return VARIANT_CHAR_CHOICES.get(clean);
    if (/[\p{L}\p{N}]/u.test(clean)) return [clean];
    return [];
}

function getVariantTokenCandidates(token) {
    const raw = String(token || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "");
    let candidates = [""];

    for (const char of raw) {
        const choices = getVariantCharChoices(char);
        if (choices.length === 0) continue;

        const next = [];
        for (const prefix of candidates) {
            for (const choice of choices) {
                if (next.length >= Math.max(1, MAX_VARIANT_TOKEN_CANDIDATES)) break;
                next.push(`${prefix}${choice}`);
            }
            if (next.length >= Math.max(1, MAX_VARIANT_TOKEN_CANDIDATES)) break;
        }

        candidates = next.length ? next : candidates;
    }

    return [...new Set(candidates.map(normalizeVariantCandidate).filter(Boolean))];
}

function addVariantTokenSetVariants(tokenSets, seen, rawTokens, source) {
    if (!rawTokens.length) return;

    const candidateLists = rawTokens.map(getVariantTokenCandidates);
    if (candidateLists.some(list => list.length === 0)) return;

    let combinations = [[]];
    const maxCombinations = Math.max(1, MAX_VARIANT_TOKEN_CANDIDATES * 4);

    for (const candidates of candidateLists) {
        const next = [];
        for (const prefix of combinations) {
            for (const candidate of candidates) {
                if (next.length >= maxCombinations) break;
                next.push([...prefix, candidate]);
            }
            if (next.length >= maxCombinations) break;
        }
        combinations = next;
    }

    for (const tokens of combinations) {
        const key = `${source}:${tokens.join("\u0000")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tokenSets.push({ source, tokens, rawTokens });
    }
}

function getVariantTokenSets(text) {
    const exactTokens = tokenizeExactWords(text);
    const compactRawTokens = tokenizeVariantWords(text);
    const normalizedExactTokens = exactTokens.map(normalizeVariantToken).filter(Boolean);
    const compactTokens = compactRawTokens.map(normalizeVariantToken).filter(Boolean);
    const tokenSets = [];
    const seen = new Set();

    if (exactTokens.length > 0) {
        addVariantTokenSetVariants(tokenSets, seen, exactTokens, "normalized");
    }
    if (compactRawTokens.length > 0 && compactTokens.join("\u0000") !== normalizedExactTokens.join("\u0000")) {
        addVariantTokenSetVariants(tokenSets, seen, compactRawTokens, "compact");
    }

    return tokenSets;
}

function joinMatchedTokens(tokens, startIndex, length) {
    return (tokens || [])
        .slice(startIndex, startIndex + length)
        .filter(Boolean)
        .join(" ");
}

function levenshteinDistance(a, b) {
    const left = String(a || "");
    const right = String(b || "");
    if (left === right) return 0;
    if (!left) return right.length;
    if (!right) return left.length;

    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    const current = Array(right.length + 1).fill(0);

    for (let i = 1; i <= left.length; i += 1) {
        current[0] = i;

        for (let j = 1; j <= right.length; j += 1) {
            const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
            current[j] = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + substitutionCost
            );
        }

        for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
    }

    return previous[right.length];
}

function canFuzzyMatchToken(inputToken, entryToken) {
    if (!ANTI_TOXIC_VARIANT_MATCH_ENABLED) return false;
    if (!inputToken || !entryToken) return false;
    if (CLEAN_TOKEN_ALLOWLIST.has(normalizeVariantToken(inputToken))) return false;
    if (inputToken[0] !== entryToken[0]) return false;
    if (entryToken.length < 5 || inputToken.length < 4) return false;
    if (Math.abs(inputToken.length - entryToken.length) > 1) return false;

    const distance = levenshteinDistance(inputToken, entryToken);
    return distance <= 1;
}

function getToxicAliasEntries() {
    return TOXIC_ALIAS_GROUPS.flatMap(group => {
        const canonicalWord = sanitizeWord(group.word);
        return (group.aliases || []).map(alias => ({
            word: canonicalWord,
            alias: sanitizeWord(alias),
            allowFuzzy: false,
        }));
    });
}

function buildToxicEntries(words) {
    const aliasEntries = getToxicAliasEntries();
    const aliasCanonicalByWord = new Map(
        aliasEntries
            .filter(entry => entry.alias && entry.word && entry.alias !== entry.word)
            .map(entry => [entry.alias, entry.word])
    );

    const baseEntries = (Array.isArray(words) ? words : [])
        .map(word => {
            const sanitizedWord = sanitizeWord(word);
            const canonicalAlias = aliasCanonicalByWord.get(sanitizedWord);
            return {
                word: canonicalAlias || sanitizedWord,
                alias: canonicalAlias ? sanitizedWord : null,
                allowFuzzy: canonicalAlias ? false : FUZZY_TOXIC_WORDS.has(sanitizedWord),
            };
        });

    const seen = new Set();

    return [...baseEntries, ...aliasEntries]
        .map(entry => {
            const sanitized = sanitizeWord(entry.alias || entry.word);
            const tokens = tokenizeExactWords(sanitized);
            const variantTokens = tokens.map(normalizeVariantToken).filter(Boolean);
            const canonicalWord = sanitizeWord(entry.word);
            const key = `${canonicalWord}|${sanitized}`;
            if (seen.has(key)) return null;
            seen.add(key);

            return {
                word: canonicalWord,
                alias: entry.alias ? sanitized : null,
                tokens,
                variantTokens,
                allowFuzzy: entry.alias
                    ? Boolean(entry.allowFuzzy)
                    : Boolean(entry.allowFuzzy || FUZZY_TOXIC_WORDS.has(canonicalWord)),
            };
        })
        .filter(Boolean)
        .filter(entry => entry.word && entry.tokens.length > 0)
        .filter(entry => !(entry.tokens.length === 1 && EXACT_MATCH_IGNORED_WORDS.has(entry.word)))
        .sort((a, b) => {
            if (b.tokens.length !== a.tokens.length) return b.tokens.length - a.tokens.length;
            return b.word.length - a.word.length;
        });
}

function tokensMatchAt(tokens, matchTokens, startIndex) {
    if (startIndex + matchTokens.length > tokens.length) return false;

    for (let i = 0; i < matchTokens.length; i += 1) {
        if (tokens[startIndex + i] !== matchTokens[i]) return false;
    }

    return true;
}

function variantTokensMatchAt(tokens, matchTokens, startIndex, allowFuzzy = false) {
    if (startIndex + matchTokens.length > tokens.length) return false;

    for (let i = 0; i < matchTokens.length; i += 1) {
        const inputToken = tokens[startIndex + i];
        const entryToken = matchTokens[i];
        if (inputToken === entryToken) continue;
        if (allowFuzzy && canFuzzyMatchToken(inputToken, entryToken)) continue;
        return false;
    }

    return true;
}

function canUseFragmentedTokenSequence(tokens) {
    if (!Array.isArray(tokens) || tokens.length < 2) return false;
    if (tokens.length > Math.max(2, MAX_FRAGMENTED_TOKEN_PARTS)) return false;

    const lengths = tokens.map(token => String(token || "").length);
    if (lengths.some(length => length < 1 || length > 4)) return false;

    return lengths.some(length => length === 1) || lengths.every(length => length <= 2);
}

function findFragmentedVariantMatch(tokenSet, toxicEntries, originalTokens) {
    const tokens = tokenSet?.tokens || [];
    const rawTokens = tokenSet?.rawTokens || tokens;
    const singleTokenEntries = toxicEntries.filter(entry => (
        entry?.variantTokens?.length === 1 &&
        entry.variantTokens[0] &&
        entry.variantTokens[0].length >= 3
    ));

    if (singleTokenEntries.length === 0) return null;

    for (let index = 0; index < tokens.length; index += 1) {
        let combined = "";
        let bestMatch = null;
        const sliceTokens = [];
        const sliceRawTokens = [];

        for (
            let offset = 0;
            offset < Math.max(2, MAX_FRAGMENTED_TOKEN_PARTS) && index + offset < tokens.length;
            offset += 1
        ) {
            const token = tokens[index + offset];
            if (!token || token.length > 4) break;

            combined += token;
            sliceTokens.push(token);
            sliceRawTokens.push(rawTokens[index + offset] || token);

            if (!canUseFragmentedTokenSequence(sliceTokens)) continue;

            const normalizedCombined = normalizeVariantCandidate(combined);
            if (!normalizedCombined) continue;

            for (const entry of singleTokenEntries) {
                const entryToken = entry.variantTokens[0];
                if (normalizedCombined.length > entryToken.length + 1) continue;
                if (normalizedCombined !== entryToken) continue;

                const exactNameMatch = entry.word === normalizedCombined || entry.alias === normalizedCombined;
                const score = (exactNameMatch ? 1000 : 0) + entryToken.length;
                if (bestMatch && bestMatch.score >= score) continue;

                bestMatch = {
                    score,
                    word: entry.word,
                    tokens: originalTokens,
                    matchedTokens: entry.tokens,
                    matchedInput: joinMatchedTokens(sliceRawTokens, 0, sliceRawTokens.length),
                    matchedNormalizedInput: normalizedCombined,
                    matchedAlias: entry.alias,
                    normalizedTokens: tokens,
                    detectionVariant: entry.alias ? "alias" : "fragmented",
                };
            }
        }

        if (bestMatch) {
            delete bestMatch.score;
            return bestMatch;
        }
    }

    return null;
}

function getAntiToxicMatcherOptions() {
    return {
        toxicWords: loadWords(),
        aliasGroups: TOXIC_ALIAS_GROUPS,
        legacyFuzzyWords: [...FUZZY_TOXIC_WORDS],
        variantMatchEnabled: ANTI_TOXIC_VARIANT_MATCH_ENABLED,
        maxCandidates: MAX_VARIANT_TOKEN_CANDIDATES,
        maxFragmentedParts: MAX_FRAGMENTED_TOKEN_PARTS,
    };
}

function findToxicMatch(text) {
    return antiToxicMatcher.findToxicMatch(text, getAntiToxicMatcherOptions());
}

function findToxicWord(text) {
    return findToxicMatch(text).word;
}

function buildDetectionDetailText(toxicMatch, triggeredWord, canonicalWord) {
    if (!toxicMatch || toxicMatch.detectionSource === "translated") return "";

    const detectedInput = String(toxicMatch.matchedInput || "").trim();
    const normalizedInput = String(toxicMatch.matchedAlias || toxicMatch.matchedNormalizedInput || "").trim();
    const canonical = String(canonicalWord || "").trim();
    const triggered = String(triggeredWord || "").trim();
    const isVariant = toxicMatch.detectionSource === "variant" || toxicMatch.detectionVariant === "alias";

    if (!isVariant && (!detectedInput || detectedInput === triggered)) return "";

    if (detectedInput && normalizedInput && canonical && canonical !== normalizedInput) {
        if (detectedInput === normalizedInput) {
            return `Tulisan yang terdeteksi: *"${detectedInput}"* masuk sebagai plesetan kategori *"${canonical}"*.\n`;
        }
        return `Tulisan yang terdeteksi: *"${detectedInput}"* dibaca sebagai plesetan *"${normalizedInput}"* (kategori: *"${canonical}"*).\n`;
    }

    if (detectedInput && normalizedInput && detectedInput !== normalizedInput) {
        return `Tulisan yang terdeteksi: *"${detectedInput}"* dibaca sebagai *"${normalizedInput}"*.\n`;
    }

    if (detectedInput && canonical && detectedInput !== canonical) {
        return `Tulisan yang terdeteksi: *"${detectedInput}"* masuk kategori *"${canonical}"*.\n`;
    }

    return "";
}

function buildTranslatedAliasEntries() {
    return TRANSLATED_TOXIC_ALIASES
        .flatMap(group => {
            const canonicalWord = sanitizeWord(group.word);
            return (group.aliases || []).map(alias => {
                const sanitizedAlias = sanitizeWord(alias);
                return {
                    word: canonicalWord,
                    alias: sanitizedAlias,
                    tokens: tokenizeExactWords(sanitizedAlias),
                };
            });
        })
        .filter(entry => entry.word && entry.alias && entry.tokens.length > 0)
        .sort((a, b) => {
            if (b.tokens.length !== a.tokens.length) return b.tokens.length - a.tokens.length;
            return b.alias.length - a.alias.length;
        });
}

function findTranslatedToxicAlias(text) {
    const tokens = tokenizeExactWords(text);
    if (!text || tokens.length === 0) return { word: null, tokens, matchedTokens: [] };

    const aliasEntries = buildTranslatedAliasEntries();
    for (let index = 0; index < tokens.length; index += 1) {
        for (const entry of aliasEntries) {
            if (tokensMatchAt(tokens, entry.tokens, index)) {
                return {
                    word: entry.word,
                    tokens,
                    matchedTokens: entry.tokens,
                    matchedAlias: entry.alias,
                };
            }
        }
    }

    return { word: null, tokens, matchedTokens: [] };
}

function hasForeignScript(text) {
    return /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(String(text || "").normalize("NFKC"));
}

function hasLatinLetter(text) {
    return /\p{Script=Latin}/u.test(String(text || "").normalize("NFKC"));
}

function normalizeLanguageCode(value) {
    const clean = String(value || "").trim().toLowerCase();
    if (!clean) return "";
    return clean.split(/[-_]/)[0];
}

function isAllowedLatinSourceLanguage(languageCode) {
    const normalized = normalizeLanguageCode(languageCode);
    if (!normalized) return false;

    return TRANSLATE_LATIN_SOURCE_LANGS.has(normalized) || TRANSLATE_LATIN_SOURCE_LANGS.has(languageCode);
}

function shouldTryTranslation(text) {
    if (!TRANSLATE_ENABLED) return false;
    if (hasForeignScript(text)) return true;
    return TRANSLATE_LATIN_ENABLED && hasLatinLetter(text);
}

function shouldUseTranslationResult(originalText, translation) {
    if (hasForeignScript(originalText)) return true;
    return isAllowedLatinSourceLanguage(translation?.detectedLanguage);
}

function getTranslateCacheKey(text, targetLang) {
    return `${targetLang}:${String(text || "").trim().toLowerCase()}`;
}

function rememberTranslateCache(key, value) {
    translateCache.set(key, {
        ...value,
        cachedAt: Date.now(),
    });

    while (translateCache.size > Math.max(20, TRANSLATE_CACHE_LIMIT)) {
        const oldestKey = translateCache.keys().next().value;
        if (!oldestKey) break;
        translateCache.delete(oldestKey);
    }
}

function parseGoogleTranslateResponse(data) {
    const segments = Array.isArray(data?.[0]) ? data[0] : [];
    const translatedText = segments
        .map(segment => Array.isArray(segment) ? segment[0] : "")
        .filter(Boolean)
        .join("")
        .trim();

    return {
        translatedText,
        detectedLanguage: String(data?.[2] || "").trim() || null,
    };
}

async function translateText(text, targetLang) {
    const cleanText = String(text || "").trim().slice(0, Math.max(20, TRANSLATE_MAX_TEXT_LENGTH));
    if (!cleanText || !targetLang) return null;

    const cacheKey = getTranslateCacheKey(cleanText, targetLang);
    const cached = translateCache.get(cacheKey);
    if (cached) return cached;

    try {
        const response = await axios.get("https://translate.googleapis.com/translate_a/single", {
            params: {
                client: "gtx",
                sl: "auto",
                tl: targetLang,
                dt: "t",
                q: cleanText,
            },
            timeout: TRANSLATE_TIMEOUT_MS,
            validateStatus: status => status >= 200 && status < 500,
        });

        if (response.status >= 400) throw new Error(`HTTP ${response.status}`);

        const parsed = parseGoogleTranslateResponse(response.data);
        if (!parsed.translatedText) return null;

        const result = {
            targetLang,
            translatedText: parsed.translatedText,
            detectedLanguage: parsed.detectedLanguage,
        };
        rememberTranslateCache(cacheKey, result);
        return result;
    } catch (error) {
        console.log("[ANTI-TOXIC TRANSLATE] Gagal translate", {
            targetLang,
            text: cleanText,
            errorMessage: error.message,
        });
        return null;
    }
}

async function getTranslationCandidates(text) {
    if (!shouldTryTranslation(text)) return [];

    const candidates = [];
    for (const targetLang of TRANSLATE_TARGETS) {
        const result = await translateText(text, targetLang);
        if (!result?.translatedText) continue;
        if (!shouldUseTranslationResult(text, result)) continue;

        const isDuplicate = candidates.some(item =>
            item.translatedText.toLowerCase() === result.translatedText.toLowerCase()
        );
        if (!isDuplicate) candidates.push(result);
    }

    return candidates;
}

async function findToxicMatchWithTranslation(text) {
    const exactMatch = findToxicMatch(text);
    if (exactMatch.word) {
        return {
            ...exactMatch,
            detectionSource: exactMatch.detectionVariant && exactMatch.detectionVariant !== "exact" ? "variant" : "exact",
            checkedText: text,
        };
    }

    const originalTokens = exactMatch.tokens || tokenizeExactWords(text);
    const translations = await getTranslationCandidates(text);

    for (const translation of translations) {
        const translatedMatch = findToxicMatch(translation.translatedText);
        const aliasMatch = translatedMatch.word ? translatedMatch : findTranslatedToxicAlias(translation.translatedText);
        if (aliasMatch.word) {
            return {
                ...aliasMatch,
                originalTokens,
                detectionSource: "translated",
                translatedText: translation.translatedText,
                translatedLanguage: translation.targetLang,
                detectedLanguage: translation.detectedLanguage,
            };
        }
    }

    return {
        ...exactMatch,
        originalTokens,
        detectionSource: translations.length ? "translated-clean" : "none",
        translationCandidates: translations,
    };
}

function pickQuote(profile) {
    const allowedSources = reflectionConfig.getAllowedQuoteSources(profile);
    
    // ✅ Log untuk debug
    if (profile && allowedSources.length > 0) {
        console.log(`[ANTI-TOXIC RENUNGAN] ✅ Using profile "${profile}" with sources:`, allowedSources);
        
        const candidates = MORAL_QUOTES.filter(item => allowedSources.includes(item.source));
        if (candidates.length > 0) {
            const nonRepeated = candidates.filter(item => getQuoteKey(item) !== lastQuoteKey);
            const pool = nonRepeated.length > 0 ? nonRepeated : candidates;
            const quote = pool[Math.floor(Math.random() * pool.length)];
            lastQuoteKey = getQuoteKey(quote);
            console.log(`[ANTI-TOXIC RENUNGAN] Quote selected from profile pool: "${quote.quote.slice(0, 50)}..." (${quote.source})`);
            return quote;
        }
    } else if (profile) {
        console.log(`[ANTI-TOXIC RENUNGAN] ⚠️ Profile "${profile}" tidak ditemukan atau tanpa sources, fallback ke random`);
    } else {
        console.log(`[ANTI-TOXIC RENUNGAN] No profile set, using random quotes`);
    }

    // ✅ Fallback ke random pool
    if (quoteBag.length === 0) refillQuoteBag();

    const quote = quoteBag.pop() || MORAL_QUOTES[Math.floor(Math.random() * MORAL_QUOTES.length)];
    lastQuoteKey = getQuoteKey(quote);

    return quote;
}

function getSocketReadyState(sock) {
    const ws = sock?.ws || sock?.websocket || sock?.conn?.ws;
    return ws?.readyState;
}

function canAttemptSend(sock) {
    return Boolean(sock && typeof sock.sendMessage === "function");
}

function prepareMessageForSend(message, removeMentions = false, jid = "") {
    if (!message || typeof message !== "object") return message;

    const prepared = { ...message };
    const shouldRemoveMentions = Boolean(removeMentions);

    if (shouldRemoveMentions) {
        delete prepared.mentions;
        return prepared;
    }

    if (Object.prototype.hasOwnProperty.call(prepared, "mentions")) {
        if (!Array.isArray(prepared.mentions) || prepared.mentions.length === 0) {
            delete prepared.mentions;
            return prepared;
        }

        const sanitized = sanitizeMentions(prepared.mentions);
        if (sanitized.length > 0) prepared.mentions = sanitized;
        else delete prepared.mentions;
    }

    return prepared;
}

function removeQuotedOption(options = {}) {
    const next = { ...(options || {}) };
    delete next.quoted;
    return next;
}

function sanitizeSendOptionsForJid(jid, options = {}) {
    if (!isSendableChatJid(jid)) return null;

    const next = { ...(options || {}) };

    if (isLidJid(jid)) {
        delete next.quoted;
    }

    return next;
}

function hasQuotedOption(options = {}) {
    return Boolean(options?.quoted);
}

function hasMentions(message = {}) {
    return Array.isArray(message?.mentions) && message.mentions.length > 0;
}

function getSendVariantKey(variant) {
    return JSON.stringify({
        quoted: Boolean(variant.options?.quoted),
        mentions: Array.isArray(variant.message?.mentions) ? variant.message.mentions : [],
        text: variant.message?.text || "",
        keys: Object.keys(variant.message || {}).sort(),
    });
}

function uniqueSendVariants(variants) {
    const seen = new Set();

    return variants.filter(variant => {
        if (!variant?.message || !variant?.options) return false;

        const key = getSendVariantKey(variant);
        if (seen.has(key)) return false;

        seen.add(key);
        return true;
    });
}

function buildSendVariants(jid, message, options = {}) {
    const safeOptions = sanitizeSendOptionsForJid(jid, options);
    if (!safeOptions) return [];

    const noQuotedOptions = removeQuotedOption(safeOptions);
    const messageWithMentions = prepareMessageForSend(message, false, jid);
    const messageWithoutMentions = prepareMessageForSend(message, true, jid);

    if (isLidJid(jid)) {
        return uniqueSendVariants([
            {
                message: messageWithMentions,
                options: noQuotedOptions,
                fallbackType: hasMentions(messageWithMentions) ? "lid-mentions" : "lid-plain",
            },
            {
                message: messageWithoutMentions,
                options: noQuotedOptions,
                fallbackType: "lid-plain",
            },
        ]);
    }

    if (isGroupJid(jid)) {
        const variants = [];

        if (hasQuotedOption(safeOptions)) {
            variants.push({
                message: messageWithMentions,
                options: safeOptions,
                fallbackType: hasMentions(messageWithMentions) ? "group-quoted+mentions" : "group-quoted",
            });
        }

        variants.push({
            message: messageWithMentions,
            options: noQuotedOptions,
            fallbackType: hasMentions(messageWithMentions) ? "group-no-quoted+mentions" : "group-no-quoted",
        });

        variants.push({
            message: messageWithoutMentions,
            options: noQuotedOptions,
            fallbackType: "group-plain",
        });

        return uniqueSendVariants(variants);
    }

    if (isPrivateUserJid(jid)) {
        const variants = [];

        if (hasQuotedOption(safeOptions)) {
            variants.push({
                message: messageWithMentions,
                options: safeOptions,
                fallbackType: hasMentions(messageWithMentions) ? "private-quoted+mentions" : "private-quoted",
            });
        }

        variants.push({
            message: messageWithMentions,
            options: noQuotedOptions,
            fallbackType: hasMentions(messageWithMentions) ? "private-no-quoted+mentions" : "private-no-quoted",
        });

        variants.push({
            message: messageWithoutMentions,
            options: noQuotedOptions,
            fallbackType: "private-plain",
        });

        return uniqueSendVariants(variants);
    }

    return [];
}

async function sendMessageRaw(sock, jid, message, options = {}, meta = {}) {
    return sendMessageWithRetry(sock, jid, message, options, meta);
}

async function sendMessageWithRetry(sock, jid, message, options = {}, meta = {}) {
    const sendMeta = createSendMeta(jid, options, meta);

    if (!isSendableChatJid(jid)) {
        logAntiToxicDebug("[ANTI-TOXIC SEND]", {
            ...sendMeta,
            stage: "invalid-remote-jid",
            errorMessage: "remoteJid tidak valid untuk sendMessage",
        });
        return false;
    }

    if (!canAttemptSend(sock)) {
        logAntiToxicDebug("[ANTI-TOXIC SEND]", {
            ...sendMeta,
            stage: "send-function-unavailable",
            errorMessage: "sock.sendMessage tidak tersedia",
        });
        return false;
    }

    const readyState = getSocketReadyState(sock);
    if (typeof readyState === "number" && readyState !== 1) {
        logAntiToxicDebug("[ANTI-TOXIC SEND]", {
            ...sendMeta,
            stage: "socket-ready-state-non-open-try-anyway",
            errorMessage: `ws.readyState=${readyState}`,
        });
    }

    if (isLidJid(jid) && hasQuotedOption(options)) {
        logAntiToxicDebug("[ANTI-TOXIC SEND]", {
            ...sendMeta,
            stage: "lid-quoted-stripped",
            fallbackType: "no-quoted",
        });
    }

    const variants = buildSendVariants(jid, message, options);
    if (variants.length === 0) {
        logAntiToxicDebug("[ANTI-TOXIC SEND]", {
            ...sendMeta,
            stage: "send-give-up",
            variantsTried: 0,
            errorMessage: "Tidak ada variant pengiriman yang aman",
        });
        return false;
    }

    const configuredAttempts = Number.isFinite(SEND_RETRY_ATTEMPTS) ? SEND_RETRY_ATTEMPTS : 2;
    const retriesPerVariant = Math.min(2, Math.max(1, configuredAttempts));
    let lastError = null;
    let variantsTried = 0;

    for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
        const variant = variants[variantIndex];
        variantsTried += 1;

        for (let attempt = 1; attempt <= retriesPerVariant; attempt += 1) {
            try {
                console.log("[ANTI-TOXIC SEND ATTEMPT]", {
                    targetJid: jid,
                    attempt,
                    variantIndex,
                    fallbackType: variant.fallbackType,
                    hasQuoted: Boolean(variant.options?.quoted),
                    messageId: sendMeta?.messageId,
                    remoteJid: sendMeta?.remoteJid,
                    senderJid: sendMeta?.senderJid,
                });

                const sent = await withTimeout(
                    sock.sendMessage(jid, variant.message, variant.options),
                    SEND_TIMEOUT_MS,
                    `sendMessage ${jid} variant ${variantIndex + 1} attempt ${attempt}`
                );

                if (!sent) throw new Error("sock.sendMessage returned empty result");

                logAntiToxicDebug("[ANTI-TOXIC SEND]", {
                    ...sendMeta,
                    stage: "send-success",
                    attempt,
                    variantIndex,
                    fallbackType: variant.fallbackType,
                    sentMessageId: sent?.key?.id,
                    sentRemoteJid: sent?.key?.remoteJid,
                    sentFromMe: sent?.key?.fromMe,
                    sentParticipant: sent?.key?.participant,
                    sentStatus: sent?.status,
                    sentTimestamp: sent?.messageTimestamp,
                });

                console.log("[ANTI-TOXIC SEND RESULT]", {
                    targetJid: jid,
                    attempt,
                    variantIndex,
                    fallbackType: variant.fallbackType,
                    success: true,
                    sentMessageId: sent?.key?.id,
                    sentRemoteJid: sent?.key?.remoteJid,
                });

                if (shouldWaitForSendStatus(jid, sent)) {
                    const statusUpdate = await waitForSentMessageStatus(sock, sent);

                    logAntiToxicDebug("[ANTI-TOXIC SEND]", {
                        ...sendMeta,
                        stage: statusUpdate ? "send-status-update" : "send-status-timeout",
                        attempt,
                        variantIndex,
                        fallbackType: variant.fallbackType,
                        sentMessageId: sent?.key?.id,
                        sentRemoteJid: sent?.key?.remoteJid,
                        sentFromMe: sent?.key?.fromMe,
                        sentParticipant: sent?.key?.participant,
                        sentStatus: statusUpdate?.status,
                    });

                    if (isFailedSendStatus(statusUpdate?.status)) {
                        lastError = new Error(`WhatsApp reported failed send status ${statusUpdate.status}`);
                        lastError.antiToxicStatus0 = Number(statusUpdate.status) === 0;
                        logAntiToxicDebug("[ANTI-TOXIC SEND]", {
                            ...sendMeta,
                            stage: "send-status-error",
                            attempt,
                            variantIndex,
                            fallbackType: variant.fallbackType,
                            sentMessageId: sent?.key?.id,
                            sentRemoteJid: sent?.key?.remoteJid,
                            sentFromMe: sent?.key?.fromMe,
                            sentParticipant: sent?.key?.participant,
                            sentStatus: statusUpdate.status,
                            error: lastError,
                        });

                        if (lastError.antiToxicStatus0 && isLidJid(jid)) {
                            console.log("[ANTI-TOXIC LID STATUS 0]", {
                                targetJid: jid,
                                messageId: sendMeta.messageId,
                                attempt,
                                note: "WhatsApp menolak send ke @lid. Perlu PN alias atau fallback owner report.",
                            });
                        }

                        console.log("[ANTI-TOXIC SEND RESULT]", {
                            targetJid: jid,
                            attempt,
                            variantIndex,
                            fallbackType: variant.fallbackType,
                            success: false,
                            sentMessageId: sent?.key?.id,
                            sentRemoteJid: sent?.key?.remoteJid,
                            sentStatus: statusUpdate.status,
                            statusCode: getErrorStatusCode(lastError),
                            errorMessage: lastError.message,
                            stack: lastError.stack,
                        });

                        const hasNextVariant = variantIndex < variants.length - 1;
                        if (hasNextVariant) {
                            await delay(randomDelay(SEND_RETRY_MIN_DELAY_MS, SEND_RETRY_MAX_DELAY_MS));
                            break;
                        }

                        throw lastError;
                    }
                }

                return true;
            } catch (error) {
                lastError = error;
                logAntiToxicDebug("[ANTI-TOXIC SEND]", {
                    ...sendMeta,
                    stage: "send-failed",
                    attempt,
                    variantIndex,
                    fallbackType: variant.fallbackType,
                    statusCode: getErrorStatusCode(error),
                    error,
                });

                console.log("[ANTI-TOXIC SEND RESULT]", {
                    targetJid: jid,
                    attempt,
                    variantIndex,
                    fallbackType: variant.fallbackType,
                    success: false,
                    statusCode: getErrorStatusCode(error),
                    errorMessage: error?.message || String(error || ""),
                    stack: error?.stack,
                });

                const isLastTry = variantIndex === variants.length - 1 && attempt === retriesPerVariant;
                if (error?.antiToxicStatus0 && isLidJid(jid)) break;
                if (!isLastTry) {
                    await delay(randomDelay(SEND_RETRY_MIN_DELAY_MS, SEND_RETRY_MAX_DELAY_MS));
                }
            }
        }
    }

    logAntiToxicDebug("[ANTI-TOXIC SEND]", {
        ...sendMeta,
        stage: "send-give-up",
        attempt: retriesPerVariant,
        fallbackType: "exhausted",
        variantsTried,
        statusCode: getErrorStatusCode(lastError),
        error: lastError,
    });

    return false;
}

function enqueueSend(jid, task) {
    const key = String(jid || "");
    const previous = sendQueues.get(key) || Promise.resolve();

    const next = previous
        .catch(error => {
            console.log("[ANTI-TOXIC QUEUE]", {
                stage: "previous-task-failed",
                remoteJid: key,
                errorMessage: error?.message || String(error || ""),
                statusCode: getErrorStatusCode(error),
                stack: error?.stack,
            });
        })
        .then(async () => {
            try {
                return await task();
            } catch (error) {
                console.log("[ANTI-TOXIC QUEUE]", {
                    stage: "task-crashed",
                    remoteJid: key,
                    errorMessage: error?.message || String(error || ""),
                    statusCode: getErrorStatusCode(error),
                    stack: error?.stack,
                });
                return false;
            }
        });

    const cleanup = next.finally(() => {
        if (sendQueues.get(key) === cleanup) sendQueues.delete(key);
    });

    sendQueues.set(key, cleanup);
    return next;
}

async function safeSend(sock, jid, message, options = {}, meta = {}) {
    const sendMeta = createSendMeta(jid, options, meta);

    if (!isSendableChatJid(jid)) {
        logAntiToxicDebug("[ANTI-TOXIC SEND]", {
            ...sendMeta,
            stage: "safe-send-invalid-jid",
            errorMessage: "remoteJid kosong/status/broadcast/newsletter",
        });
        return false;
    }

    return enqueueSend(jid, () => sendMessageWithRetry(sock, jid, message, options, sendMeta));
}

function cloneMessageContentWithoutMentions(content) {
    if (!content || typeof content !== "object") return content;
    const cloned = { ...content };
    delete cloned.mentions;
    return cloned;
}

function cloneContentWithoutMentions(content) {
    return cloneMessageContentWithoutMentions(content);
}

function cloneWithoutMentions(content) {
    return cloneMessageContentWithoutMentions(content);
}

function removeMentionSyntaxFromPrivateText(content) {
    if (!content || typeof content !== "object") return content;

    const cloned = cloneWithoutMentions(content);

    if (typeof cloned.text === "string") {
        cloned.text = cloned.text
            .replace(/🤬 ATTENTION\s+@\d+(?:\s+\([^)]+\))?\s+😡\n\n?/i, "🤬 ATTENTION 😡\n\n")
            .replace(/🤬 ATTENTION\s+@user(?:\s+\([^)]+\))?\s+😡\n\n?/i, "🤬 ATTENTION 😡\n\n")
            .replace(/ðŸ¤¬ ATTENTION\s+@\d+(?:\s+\([^)]+\))?\s+ðŸ˜¡\n\n?/i, "ðŸ¤¬ ATTENTION ðŸ˜¡\n\n")
            .replace(/ðŸ¤¬ ATTENTION\s+@user(?:\s+\([^)]+\))?\s+ðŸ˜¡\n\n?/i, "ðŸ¤¬ ATTENTION ðŸ˜¡\n\n");
    }

    return cloned;
}

function buildPrivateWarningAttempts(warningMessage) {
    return [
        {
            label: "private-plain-clean-no-mentions",
            content: removeMentionSyntaxFromPrivateText(warningMessage),
            options: {},
        },
        {
            label: "private-plain-no-mentions",
            content: cloneWithoutMentions(warningMessage),
            options: {},
        },
        {
            label: "private-plain-original-last-resort",
            content: warningMessage,
            options: {},
        },
    ];
}

function buildGroupFallbackAttempts(warningMessage, msg) {
    return [
        {
            label: "group-quoted-true-mention-once",
            content: warningMessage,
            options: { quoted: msg },
        },
    ];
}

function buildSendAttempts(targetJid, warningMessage, msg, context = {}) {
    const normalizedTarget = normalizeJid(targetJid);
    const isGroupTarget = isGroupJidValue(normalizedTarget);
    const isPrivateTarget = isPrivateJidValue(normalizedTarget);
    const noMentions = cloneWithoutMentions(warningMessage);
    const allowQuoted = context.allowQuoted !== false;

    if (isPrivateTarget) {
        return buildPrivateWarningAttempts(warningMessage);
    }

    if (isGroupTarget) {
        if (allowQuoted) {
            return buildGroupFallbackAttempts(warningMessage, msg);
        }

        return [
            {
                label: "group-plain-original-once",
                content: warningMessage,
                options: {},
            },
        ];
    }

    return [
        {
            label: "unknown-plain-no-mentions",
            content: noMentions,
            options: {},
        },
    ];
}

function waitForMessageStatus(sock, sentId, timeoutMs = 3500) {
    if (!sentId || !sock?.ev) return Promise.resolve(null);

    return new Promise(resolve => {
        let done = false;

        const finish = value => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (typeof sock.ev.off === "function") sock.ev.off("messages.update", handler);
            else if (typeof sock.ev.removeListener === "function") sock.ev.removeListener("messages.update", handler);
            resolve(value);
        };

        const handler = updates => {
            for (const update of updates || []) {
                if (update?.key?.id !== sentId) continue;

                finish({
                    status: update?.update?.status ?? update?.status,
                    remoteJid: update?.key?.remoteJid,
                    fromMe: update?.key?.fromMe,
                    participant: update?.key?.participant,
                    updateKeys: Object.keys(update?.update || {}),
                });
                return;
            }
        };

        const timer = setTimeout(() => finish(null), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
        sock.ev.on("messages.update", handler);
    });
}

function isBadSendStatus(statusInfo) {
    const status = statusInfo?.status;
    return Number(status) === 0 || String(status || "").toLowerCase() === "error";
}

function isGoodEnoughSendStatus(statusInfo) {
    if (!statusInfo) return false;
    const status = Number(statusInfo.status);
    return status >= 1;
}

function getBadSendStatusAction(context = {}) {
    if (context.mode === "group-private-reply") return "fallback-group";
    if (context.mode === "private-warning") return "retry-next-target";
    return "retry-next-attempt";
}

function resolvePrivateToxicTarget(sock, msg, context = {}) {
    const ownerJid = context.ownerJid;
    const key = msg?.key || {};
    const senderJid = normalizeJidForCompare(context.senderJid);
    const expandedCandidates = expandPrivateJidAliases([
        key.remoteJidAlt,
        key.senderPn,
        key.participantPn,
        key.remoteJid,
        senderJid,
        key.senderLid,
        key.participantLid,
    ]);

    const pnCandidates = expandedCandidates.filter(isPnJidValue);

    const lidCandidates = expandedCandidates.filter(isLidJidValue);

    const candidates = [...pnCandidates, ...lidCandidates];

    const safeCandidates = candidates.filter(jid => !isBotSelfOrOwnerJid(jid, sock, ownerJid));

    if (safeCandidates.length > 0) {
        return {
            targetJid: safeCandidates[0],
            source: "private-safe-candidate",
            candidates,
            pnCandidates,
            lidCandidates,
            safeCandidates,
        };
    }

    return {
        targetJid: null,
        source: "private-prevented-self-target",
        candidates,
        pnCandidates,
        lidCandidates,
        safeCandidates,
    };
}

function resolvePrivateTargetsForAntiToxic(sock, msg, ownerJid, senderJid) {
    const key = msg?.key || {};
    const normalizedSender = normalizeJidForCompare(senderJid);
    const expandedCandidates = expandPrivateJidAliases([
        key.remoteJidAlt,
        key.senderPn,
        key.participantPn,
        normalizedSender,
        key.remoteJid,
        key.senderLid,
        key.participantLid,
    ]);

    const pnCandidates = expandedCandidates.filter(isPnJidValue);

    const lidCandidates = expandedCandidates.filter(isLidJidValue);

    const targets = uniqueNormalizedJids([...pnCandidates, ...lidCandidates])
        .filter(isPrivateJidValue)
        .filter(jid => !isBotSelfOrOwnerJid(jid, sock, ownerJid));

    return {
        targets,
        targetJid: targets[0] || null,
        pnCandidates,
        lidCandidates,
    };
}

function resolveGroupOffenderPrivateTarget(sock, msg, context = {}) {
    const ownerJid = context.ownerJid;
    const key = msg?.key || {};
    const groupJid = normalizeJidForCompare(key.remoteJid);
    const senderJid = normalizeJidForCompare(context.senderJid);

    const pnCandidates = uniqueNormalizedJids([
        key.participantAlt,
        key.participantPn,
        key.senderPn,
        key.participant,
        msg?.participantAlt,
        msg?.participant,
        senderJid,
    ]).filter(isPnJidValue);

    const lidCandidates = uniqueNormalizedJids([
        key.participant,
        key.participantLid,
        key.senderLid,
        msg?.participant,
        senderJid,
    ]).filter(isLidJidValue);

    const candidates = [...new Set([...pnCandidates, ...lidCandidates])]
        .filter(isPrivateJidValue);

    const safeCandidates = candidates.filter(jid => !isBotSelfOrOwnerJid(jid, sock, ownerJid));

    if (safeCandidates.length > 0) {
        return {
            targetJid: safeCandidates[0],
            targets: safeCandidates,
            source: "group-private-offender",
            groupJid,
            candidates,
            pnCandidates,
            lidCandidates,
            safeCandidates,
        };
    }

    return {
        targetJid: null,
        targets: [],
        source: "group-private-offender-not-found",
        groupJid,
        candidates,
        pnCandidates,
        lidCandidates,
        safeCandidates,
    };
}

async function sendWarningContentWithFallbacks(sock, targetJid, warningMessage, msg, context = {}) {
    if (!targetJid || !isSendableAntiToxicTarget(targetJid)) {
        console.log("[ANTI-TOXIC SEND TARGET INVALID]", {
            targetJid,
            messageId: msg?.key?.id,
            context,
        });
        return false;
    }

    if (isBotSelfOrOwnerJid(targetJid, sock, context.ownerJid)) {
        console.log("[ANTI-TOXIC HARD BLOCK SELF TARGET]", {
            targetJid,
            ownerJid: context.ownerJid,
            botSelfJids: getBotSelfJidCandidates(sock, context.ownerJid),
            messageId: msg?.key?.id,
            context,
        });
        return false;
    }

    if (!warningMessage || typeof warningMessage !== "object") {
        console.log("[ANTI-TOXIC SEND WARNING INVALID]", {
            targetJid,
            messageId: msg?.key?.id,
            warningType: typeof warningMessage,
            context,
        });
        return false;
    }

    warningMessage = sanitizeAntiToxicWarningMessage(warningMessage);
    const attempts = buildSendAttempts(targetJid, warningMessage, msg, context);

    for (const attempt of attempts) {
        try {
            console.log("[ANTI-TOXIC SEND TRY]", {
                targetJid,
                label: attempt.label,
                messageId: msg?.key?.id,
                fromMe: msg?.key?.fromMe,
                originalRemoteJid: msg?.key?.remoteJid,
                participant: msg?.key?.participant,
                participantAlt: msg?.key?.participantAlt,
                hasQuoted: Boolean(attempt.options?.quoted),
                hasMentions: Array.isArray(attempt.content?.mentions) && attempt.content.mentions.length > 0,
                contentTypes: Object.keys(attempt.content || {}),
                textPreview: String(attempt.content?.text || "").slice(0, 120),
                context,
            });

            const sendOptions = isPrivateLidJid(targetJid)
                ? { ...(attempt.options || {}), __skipLidAliasResolve: true }
                : attempt.options;
            const sent = await sock.sendMessage(targetJid, attempt.content, sendOptions);
            const sentId = sent?.key?.id;
            const statusInfo = await waitForMessageStatus(sock, sentId, SEND_STATUS_WAIT_MS);

            console.log("[ANTI-TOXIC SEND STATUS]", {
                targetJid,
                label: attempt.label,
                messageId: msg?.key?.id,
                sentId,
                statusInfo,
                statusGoodEnough: isGoodEnoughSendStatus(statusInfo),
                statusBad: isBadSendStatus(statusInfo),
                context,
            });

            if (isBadSendStatus(statusInfo)) {
                console.log("[ANTI-TOXIC SEND BAD STATUS]", {
                    targetJid,
                    label: attempt.label,
                    messageId: msg?.key?.id,
                    sentId,
                    statusInfo,
                    action: getBadSendStatusAction(context),
                    context,
                });

                if (context.mode === "group-private-reply" || context.mode === "private-warning") return false;
                continue;
            }

            console.log("[ANTI-TOXIC SEND OK]", {
                targetJid,
                label: attempt.label,
                messageId: msg?.key?.id,
                sentId,
                sentRemoteJid: sent?.key?.remoteJid,
                sentFromMe: sent?.key?.fromMe,
                statusInfo,
                context,
            });

            return true;
        } catch (error) {
            console.log("[ANTI-TOXIC SEND FAIL]", {
                targetJid,
                label: attempt.label,
                messageId: msg?.key?.id,
                errorMessage: error?.message || String(error || ""),
                statusCode: getErrorStatusCode(error),
                context,
            });
        }
    }

    return false;
}

async function sendPrivateAntiToxicWarning(sock, msg, warningMessage, context = {}) {
    const resolved = resolvePrivateTargetsForAntiToxic(
        sock,
        msg,
        context.ownerJid,
        context.senderJid
    );

    console.log("[ANTI-TOXIC PRIVATE TARGETS]", {
        messageId: msg?.key?.id,
        resolved,
    });

    for (const targetJid of resolved.targets) {
        const sent = await sendWarningContentWithFallbacks(
            sock,
            targetJid,
            warningMessage,
            msg,
            {
                ...context,
                mode: "private-warning",
                allowQuoted: false,
                allowMentions: false,
            }
        );

        if (sent) return true;
    }

    return false;
}

async function sendGroupOnlyAntiToxicWarning(sock, msg, warningMessage, context = {}) {
    const groupJid = normalizeJid(msg?.key?.remoteJid);

    if (!groupJid || !isGroupJidValue(groupJid)) {
        console.log("[ANTI-TOXIC GROUP ONLY] invalid group jid", {
            groupJid,
            messageId: msg?.key?.id,
            context,
        });
        return false;
    }

    warningMessage = sanitizeAntiToxicWarningMessage(warningMessage);

    try {
        console.log("[ANTI-TOXIC GROUP ONLY SEND TRY]", {
            groupJid,
            messageId: msg?.key?.id,
            hasMentions: Array.isArray(warningMessage?.mentions) && warningMessage.mentions.length > 0,
            contentTypes: Object.keys(warningMessage || {}),
            textPreview: String(warningMessage?.text || "").slice(0, 120),
            context,
        });

        const sent = await sock.sendMessage(groupJid, warningMessage, { quoted: msg });

        console.log("[ANTI-TOXIC GROUP ONLY SEND OK]", {
            groupJid,
            messageId: msg?.key?.id,
            sentId: sent?.key?.id,
            sentRemoteJid: sent?.key?.remoteJid,
            context,
        });

        return true;
    } catch (error) {
        console.log("[ANTI-TOXIC GROUP ONLY SEND FAIL]", {
            groupJid,
            messageId: msg?.key?.id,
            errorMessage: error?.message || String(error || ""),
            statusCode: getErrorStatusCode(error),
            context,
        });

        try {
            const sent = await sock.sendMessage(groupJid, warningMessage, {});

            console.log("[ANTI-TOXIC GROUP ONLY SEND OK PLAIN]", {
                groupJid,
                messageId: msg?.key?.id,
                sentId: sent?.key?.id,
                sentRemoteJid: sent?.key?.remoteJid,
                context,
            });

            return true;
        } catch (retryError) {
            console.log("[ANTI-TOXIC GROUP ONLY SEND FAIL PLAIN]", {
                groupJid,
                messageId: msg?.key?.id,
                errorMessage: retryError?.message || String(retryError || ""),
                statusCode: getErrorStatusCode(retryError),
                context,
            });

            return false;
        }
    }
}

async function sendSmartToxicWarning(sock, msg, context = {}) {
    const ownerJid = context.ownerJid;
    const warningMessage = context.warningMessage;
    const senderJid = context.senderJid || getRawSenderJid(msg);
    const remoteJid = normalizeJidForCompare(msg?.key?.remoteJid);
    const isGroup = isGroupJidValue(remoteJid);
    const forceGroupPrivateReply = Boolean(context.groupPrivateReply || context.forceGroupPrivateReply);
    const suppressGroupFallback = Boolean(context.suppressGroupFallback || forceGroupPrivateReply);

    console.log("[ANTI-TOXIC SMART TARGET START]", {
        messageId: msg?.key?.id,
        remoteJid: msg?.key?.remoteJid,
        remoteJidAlt: msg?.key?.remoteJidAlt,
        participant: msg?.key?.participant,
        participantAlt: msg?.key?.participantAlt,
        senderLid: msg?.key?.senderLid,
        senderPn: msg?.key?.senderPn,
        participantLid: msg?.key?.participantLid,
        participantPn: msg?.key?.participantPn,
        addressingMode: msg?.key?.addressingMode,
        fromMe: msg?.key?.fromMe,
        senderJid,
        ownerJid,
        isGroup,
        forceGroupPrivateReply,
        botSelfJids: getBotSelfJidCandidates(sock, ownerJid),
    });

    if (isGroup) {
        if (isGroupOnlyWarnMode() && !forceGroupPrivateReply) {
            console.log("[ANTI-TOXIC MODE] group_only", {
                remoteJid,
                senderJid,
                messageId: msg?.key?.id,
                triggeredWord: context.triggeredWord,
                canonicalWord: context.canonicalWord,
                groupWarnMode: getGroupWarnMode(),
            });

            return await sendGroupOnlyAntiToxicWarning(
                sock,
                msg,
                warningMessage,
                {
                    mode: "group_only",
                    ownerJid,
                    senderJid,
                    triggeredWord: context.triggeredWord,
                    canonicalWord: context.canonicalWord,
                }
            );
        }

        const resolved = resolveGroupOffenderPrivateTarget(sock, msg, {
            ownerJid,
            senderJid,
        });

        console.log("[ANTI-TOXIC GROUP PRIVATE TARGET]", {
            messageId: msg?.key?.id,
            resolved,
        });

        for (const targetJid of resolved.targets || []) {
            const privateSent = await sendWarningContentWithFallbacks(
                sock,
                targetJid,
                warningMessage,
                msg,
                {
                    mode: "group-private-reply",
                    ownerJid,
                    senderJid,
                    groupJid: resolved.groupJid,
                    source: resolved.source,
                    allowQuoted: false,
                    allowMentions: false,
                    triggeredWord: context.triggeredWord,
                    canonicalWord: context.canonicalWord,
                }
            );

            if (privateSent) return true;
        }

        if (suppressGroupFallback) {
            console.log("[ANTI-TOXIC GROUP PRIVATE ONLY] private failed; group fallback disabled", {
                messageId: msg?.key?.id,
                groupJid: resolved.groupJid || remoteJid,
                targetTried: resolved.targetJid,
                targetsTried: resolved.targets,
                candidates: resolved.candidates,
                pnCandidates: resolved.pnCandidates,
                lidCandidates: resolved.lidCandidates,
                resolved,
            });
            return false;
        }

        const groupJid = normalizeJidForCompare(msg?.key?.remoteJid);
        console.log("[ANTI-TOXIC GROUP FALLBACK] private failed, reply in group once", {
            messageId: msg?.key?.id,
            groupJid: resolved.groupJid || groupJid,
            targetTried: resolved.targetJid,
            targetsTried: resolved.targets,
            candidates: resolved.candidates,
            pnCandidates: resolved.pnCandidates,
            lidCandidates: resolved.lidCandidates,
            resolved,
        });

        return await sendWarningContentWithFallbacks(
            sock,
            groupJid,
            warningMessage,
            msg,
            {
                mode: "group-fallback-reply",
                ownerJid,
                senderJid,
                source: "group-private-failed",
                targetTried: resolved.targets || [resolved.targetJid].filter(Boolean),
                allowQuoted: true,
                allowMentions: true,
                triggeredWord: context.triggeredWord,
                canonicalWord: context.canonicalWord,
            }
        );
    }

    if (msg?.key?.fromMe && ANTI_TOXIC_WARN_OWNER_MESSAGES) {
        console.log("[ANTI-TOXIC FROMME PRIVATE] detected; warning send suppressed", {
            messageId: msg?.key?.id,
            remoteJid: msg?.key?.remoteJid,
            senderJid,
            ownerJid,
            reason: "avoid-warning-to-chat-peer",
            triggeredWord: context.triggeredWord,
            canonicalWord: context.canonicalWord,
        });
        return true;
    }

    const privateSent = await sendPrivateAntiToxicWarning(
        sock,
        msg,
        warningMessage,
        {
            mode: "private-warning",
            ownerJid,
            senderJid,
            triggeredWord: context.triggeredWord,
            canonicalWord: context.canonicalWord,
        }
    );

    if (!privateSent) {
        console.log("[ANTI-TOXIC TARGET ERROR] private warning failed for all targets", {
            messageId: msg?.key?.id,
            remoteJid: msg?.key?.remoteJid,
            remoteJidAlt: msg?.key?.remoteJidAlt,
            participant: msg?.key?.participant,
            participantAlt: msg?.key?.participantAlt,
            fromMe: msg?.key?.fromMe,
            senderJid,
            ownerJid,
        });
    }

    return privateSent;
}

async function sendWarningToTargets(sock, targets, warningMessage, msg, baseMeta = {}) {
    const tried = [];

    for (const targetJid of uniqueJids(targets)) {
        if (!isSendableChatJid(targetJid)) continue;

        const variants = [];

        if (isPrivateUserJid(targetJid)) {
            variants.push({
                label: "pn-quoted",
                options: { quoted: msg },
                message: warningMessage,
            });
            variants.push({
                label: "pn-plain",
                options: {},
                message: warningMessage,
            });
        }

        if (isPrivateLidJid(targetJid)) {
            const plainNoMention = {
                text: String(warningMessage?.text || "").replace(/@\d+/g, "pengguna ini"),
            };
            variants.push({
                label: "lid-plain-no-mention",
                options: {},
                message: plainNoMention,
            });
            variants.push({
                label: "lid-plain-original",
                options: {},
                message: warningMessage,
            });
        }

        for (const variant of variants) {
            console.log("[ANTI-TOXIC SEND TRY TARGET]", {
                targetJid,
                variant: variant.label,
                messageId: msg?.key?.id,
            });

            const sent = await safeSend(
                sock,
                targetJid,
                variant.message,
                variant.options,
                createSendMeta(targetJid, variant.options, {
                    ...baseMeta,
                    msg,
                    fallbackType: variant.label,
                })
            );

            tried.push({ targetJid, variant: variant.label, sent });

            if (sent) {
                console.log("[ANTI-TOXIC SEND SUCCESS TARGET]", {
                    targetJid,
                    variant: variant.label,
                    messageId: msg?.key?.id,
                });
                return {
                    sent: true,
                    targetJid,
                    variant: variant.label,
                    tried,
                };
            }
        }
    }

    console.log("[ANTI-TOXIC SEND FAILED ALL TARGETS]", {
        messageId: msg?.key?.id,
        tried,
    });

    return {
        sent: false,
        targetJid: null,
        variant: null,
        tried,
    };
}

async function sendPrivateLidWarning(sock, msg, warningMessage, context = {}) {
    const targets = [];

    if (context.mappedPn) {
        targets.push({
            jid: context.mappedPn,
            label: "mapped-pn-quoted",
            options: { quoted: msg },
            message: warningMessage,
        });
        targets.push({
            jid: context.mappedPn,
            label: "mapped-pn-plain",
            options: {},
            message: warningMessage,
        });
    }

    if (!context.mappedPn) {
        targets.push({
            jid: context.remoteJid,
            label: "lid-plain-short",
            options: {},
            message: {
                text: "Kamu terdeteksi mengirim kata kasar. Mohon jaga bahasa dan jangan diulangi lagi.",
            },
        });

        targets.push({
            jid: context.remoteJid,
            label: "lid-plain-original",
            options: {},
            message: warningMessage,
        });
    }

    const tried = [];
    for (const target of targets) {
        if (!isSendableChatJid(target.jid)) continue;

        console.log("[ANTI-TOXIC PRIVATE LID SEND TRY]", {
            jid: target.jid,
            label: target.label,
            messageId: msg?.key?.id,
        });

        const sent = await safeSend(sock, target.jid, target.message, target.options, {
            msg,
            remoteJid: target.jid,
            senderJid: context.senderJid,
            messageId: msg?.key?.id,
            fallbackType: target.label,
        });

        tried.push({
            jid: target.jid,
            targetJid: target.jid,
            label: target.label,
            variant: target.label,
            sent,
        });

        if (sent) {
            return { sent: true, target: target.jid, targetJid: target.jid, label: target.label, variant: target.label, tried };
        }
    }

    return { sent: false, tried };
}

function maskToxicWord(word) {
    const clean = String(word || "").trim();
    if (clean.length <= 2) return clean ? `${clean[0] || ""}*` : "-";
    return `${clean[0]}${"*".repeat(Math.max(1, clean.length - 2))}${clean[clean.length - 1]}`;
}

async function reportToxicSendFailureToOwner(sock, msg, details = {}) {
    const ownerCandidates = [
        process.env.OWNER_JID,
        process.env.ACTIVE_NOTIFY_JIDS,
        ...(Array.isArray(details.ownerJids) ? details.ownerJids : []),
    ]
        .filter(Boolean)
        .join(",")
        .split(",")
        .map(normalizeJid)
        .filter(isPrivateUserJid);

    const ownerJids = uniqueJids(ownerCandidates);
    if (!ownerJids.length) return false;

    const offenderLid = lidAliasStore.normalizeLidJid(details.remoteJid) || lidAliasStore.normalizeLidJid(details.senderJid);
    const text =
        "*ANTI-TOXIC TERDETEKSI TAPI WARNING GAGAL DIKIRIM*\n\n" +
        `Pengirim masih berupa LID: ${offenderLid || details.senderJid || "-"}\n` +
        `Nama WA: ${details.pushName || "-"}\n` +
        `Chat: ${details.remoteJid || "-"}\n` +
        `Message ID: ${msg?.key?.id || "-"}\n` +
        `Kata: ${maskToxicWord(details.triggeredWord)}\n` +
        `Canonical: ${maskToxicWord(details.canonicalWord)}\n` +
        `Send mode: ${details.sendMode || "-"}\n` +
        `Targets tried: ${(details.tried || []).map(item => `${item.targetJid || item.jid}/${item.variant || item.label}/${item.sent}`).join(", ") || "-"}\n\n` +
        "Penyebab: bot belum punya mapping LID ke nomor HP asli.\n\n" +
        "Solusi manual kalau owner tahu nomor user:\n" +
        `.bindlid ${offenderLid || "<lid>"} 628xxxxxxxxxx\n\n` +
        "Setelah bind, test lagi.";

    for (const ownerJid of ownerJids) {
        const ok = await safeSend(sock, ownerJid, { text }, {}, {
            msg,
            remoteJid: ownerJid,
            senderJid: details.senderJid,
            messageId: msg?.key?.id,
            fallbackType: "owner-report-toxic-send-failed",
        });
        if (ok) return true;
    }

    return false;
}

function getCooldownKey(remoteJid, senderJid) {
    return `${remoteJid || "-"}:${senderJid || "-"}`;
}

function shouldReportToxicSendFailure(messageId) {
    const id = String(messageId || "");
    if (!id) return true;

    const now = Date.now();
    for (const [key, ts] of toxicSendFailureReports) {
        if (now - ts > TOXIC_SEND_FAILURE_REPORT_TTL_MS) toxicSendFailureReports.delete(key);
    }

    if (toxicSendFailureReports.has(id)) return false;
    toxicSendFailureReports.set(id, now);
    return true;
}

function isWarnCooldownActive(remoteJid, senderJid) {
    if (!ANTI_TOXIC_WARN_COOLDOWN_MS || ANTI_TOXIC_WARN_COOLDOWN_MS <= 0) return false;

    const key = getCooldownKey(remoteJid, senderJid);
    const expiresAt = warnCooldowns.get(key) || 0;

    if (expiresAt > Date.now()) return true;

    if (expiresAt) warnCooldowns.delete(key);
    return false;
}

function setWarnCooldown(remoteJid, senderJid) {
    if (!ANTI_TOXIC_WARN_COOLDOWN_MS || ANTI_TOXIC_WARN_COOLDOWN_MS <= 0) return;

    const key = getCooldownKey(remoteJid, senderJid);
    const expiresAt = Date.now() + ANTI_TOXIC_WARN_COOLDOWN_MS;
    warnCooldowns.set(key, expiresAt);

    const timer = setTimeout(() => {
        if (warnCooldowns.get(key) === expiresAt) warnCooldowns.delete(key);
    }, ANTI_TOXIC_WARN_COOLDOWN_MS + 250);

    if (typeof timer.unref === "function") timer.unref();
}

function getDebugDetectionSource(toxicMatch) {
    if (!toxicMatch?.word) return "none";
    if (toxicMatch.detectionVariant === "alias") return "alias";
    return toxicMatch.detectionSource || toxicMatch.detectionVariant || "exact";
}

async function handleCekKasarCommand(msg, sock, ownerJid, text) {
    if (!/^\.cekkasar(?:\s|$)/i.test(text)) return false;

    const remoteJid = msg?.key?.remoteJid;
    const senderJid = msg?.key?.fromMe
        ? (normalizeJid(ownerJid) || getSenderJid(msg))
        : getSenderJid(msg);
    const isOwner = Boolean(msg?.key?.fromMe || isSameUser(senderJid, ownerJid));

    if (!isOwner) {
        await safeSend(sock, remoteJid, { text: "Akses Ditolak" }, { quoted: msg });
        return true;
    }

    const checkText = String(text.replace(/^\.cekkasar/i, "")).trim();
    const words = loadWords(true);

    if (!checkText) {
        await safeSend(sock, remoteJid, {
            text: `Format: *.cekkasar teks*\nTotal kata terlarang saat ini: *${words.length}*`,
        }, { quoted: msg });
        return true;
    }

    const toxicMatch = await findToxicMatchWithTranslation(checkText);
    const detected = Boolean(toxicMatch.word);
    const triggeredWord = detected ? (toxicMatch.matchedAlias || toxicMatch.word) : "-";
    const canonicalWord = detected ? toxicMatch.word : "-";
    const detectionSource = getDebugDetectionSource(toxicMatch);
    const matchedInput = toxicMatch.matchedInput || toxicMatch.matchedNormalizedInput || "-";
    const ownerExempt = Boolean(isOwner && !ANTI_TOXIC_WARN_OWNER_MESSAGES);

    await safeSend(sock, remoteJid, {
        text: [
            "ANTI-TOXIC CHECK",
            `Text: ${checkText}`,
            `Detected: ${detected ? "YES" : "NO"}`,
            `Triggered: ${triggeredWord}`,
            `Canonical: ${canonicalWord}`,
            `Source: ${detectionSource}`,
            `Matched input: ${matchedInput}`,
            `Word count: ${words.length}`,
            `Sender owner exempt: ${ownerExempt ? "YES" : "NO"}`,
        ].join("\n"),
    }, { quoted: msg });

    return true;
}

async function handleAntiToxicStatusCommand(msg, sock, ownerJid, text) {
    if (!/^\.antitoxicstatus(?:\s|$)/i.test(text)) return false;

    const remoteJid = msg?.key?.remoteJid;
    const senderJid = getSenderJid(msg);
    const isOwner = Boolean(msg?.key?.fromMe || isSameUser(senderJid, ownerJid));

    if (!isOwner) {
        await safeSend(sock, remoteJid, { text: "Akses Ditolak" }, { quoted: msg });
        return true;
    }

    const words = loadWords(true);
    const botJid = normalizeJid(sock?.user?.id) || sock?.user?.id || "-";
    const readyState = getSocketReadyState(sock);

    await safeSend(sock, remoteJid, {
        text: [
            "ANTI-TOXIC STATUS",
            `Word count: ${words.length}`,
            `Owner JID: ${ownerJid || "-"}`,
            `Warn owner: ${ANTI_TOXIC_WARN_OWNER_MESSAGES ? "true" : "false"}`,
            `Cooldown ms: ${ANTI_TOXIC_WARN_COOLDOWN_MS}`,
            `Send timeout: ${SEND_TIMEOUT_MS}`,
            `Send retry attempts: ${SEND_RETRY_ATTEMPTS}`,
            `Debug: ${isAntiToxicDebug() ? "true" : "false"}`,
            `Last word file: ${WORDS_FILE}`,
            `Bot JID: ${botJid}`,
            `Active socket: ${canAttemptSend(sock) ? "true" : "false"}`,
            `Socket readyState: ${readyState ?? "-"}`,
        ].join("\n"),
    }, { quoted: msg });

    return true;
}

async function handleAntiToxicReloadCommand(msg, sock, ownerJid, text) {
    if (!/^\.antitoxicreload(?:\s|$)/i.test(text)) return false;

    const remoteJid = msg?.key?.remoteJid;
    const senderJid = getSenderJid(msg);
    const isOwner = Boolean(msg?.key?.fromMe || isSameUser(senderJid, ownerJid));

    if (!isOwner) {
        await safeSend(sock, remoteJid, { text: "Akses Ditolak" }, { quoted: msg });
        return true;
    }

    const words = loadWords(true);
    await safeSend(sock, remoteJid, {
        text: `ANTI-TOXIC RELOAD\nWord count: ${words.length}`,
    }, { quoted: msg });

    return true;
}

function parseTestWarnArgs(text) {
    const body = String(text || "").replace(/^\.testwarn/i, "").trim();
    const parts = body.split("|").map(part => part.trim());
    const targetRaw = parts[0] || "";
    const sampleText = parts.slice(1).join(" | ").trim() || "tai";
    const targetJid = normalizeJid(targetRaw);

    return { targetRaw, targetJid, sampleText };
}

async function handleTestWarnCommand(msg, sock, ownerJid, text) {
    if (!/^\.testwarn(?:\s|$)/i.test(text)) return false;

    const remoteJid = msg?.key?.remoteJid;
    const senderJid = getSenderJid(msg);
    const isOwner = Boolean(msg?.key?.fromMe || isSameUser(senderJid, ownerJid));

    if (!isOwner) {
        await safeSend(sock, remoteJid, { text: "Akses Ditolak" }, { quoted: msg });
        return true;
    }

    const { targetRaw, targetJid, sampleText } = parseTestWarnArgs(text);
    if (!targetRaw || !isSendableChatJid(targetJid) || isGroupJid(targetJid)) {
        await safeSend(sock, remoteJid, {
            text: "Format: .testwarn 6281234567890 | tai",
        }, { quoted: msg });
        return true;
    }

    const warningMessage = {
        text: [
            `ATTENTION @${getMentionLabel(targetJid)}`,
            "",
            `Kamu terdeteksi mengucapkan kata kasar terlarang: *"${sampleText}"*!`,
            "Tolong jangan diulangi lagi ya. Mari saling menjaga lisan.",
            "",
            "TEST WARN anti-toxic.",
        ].join("\n"),
    };
    if (isValidMentionJid(targetJid)) warningMessage.mentions = [targetJid];

    const sentPlain = await safeSend(sock, targetJid, warningMessage, {}, createSendMeta(targetJid, {}, {
        msg,
        senderJid,
        messageId: msg?.key?.id,
        fallbackType: "testwarn-plain",
    }));

    await safeSend(sock, remoteJid, {
        text: [
            "TEST WARN RESULT",
            `Target: ${targetJid}`,
            "Sent quoted: -",
            `Sent plain: ${sentPlain ? "YES" : "NO"}`,
            `Error: ${sentPlain ? "-" : "lihat [ANTI-TOXIC SEND RESULT] di PM2"}`,
        ].join("\n"),
    }, { quoted: msg });

    return true;
}

function formatLidAliasEntry(entry) {
    if (!entry) return "Tidak ada data LID.";
    return [
        `LID: ${entry.lid || "-"}`,
        `PN: ${entry.pn || "-"}`,
        `Source: ${entry.source || "-"}`,
        `PushName: ${entry.pushName || "-"}`,
        `Last seen: ${entry.lastSeenAt ? new Date(entry.lastSeenAt).toISOString() : "-"}`,
        `Last message: ${entry.lastMessageId || "-"}`,
        `Last chat: ${entry.lastRemoteJid || "-"}`,
    ].join("\n");
}

async function handleLidAliasCommand(msg, sock, ownerJid, text) {
    if (!/^\.(?:bindlid|ceklid|unlid|listlid)(?:\s|$)/i.test(text)) return false;

    const remoteJid = msg?.key?.remoteJid;
    const senderJid = getSenderJid(msg);
    const isOwner = Boolean(msg?.key?.fromMe || isSameUser(senderJid, ownerJid));

    if (!isOwner) {
        await safeSend(sock, remoteJid, { text: "Akses Ditolak" }, { quoted: msg });
        return true;
    }

    const command = text.trim().split(/\s+/)[0].toLowerCase();
    const args = text.trim().split(/\s+/).slice(1);

    if (command === ".bindlid") {
        const lid = lidAliasStore.normalizeLidJid(args[0]);
        const pn = lidAliasStore.normalizePnJid(args[1]);
        if (!lid || !pn) {
            await safeSend(sock, remoteJid, {
                text: "Format: .bindlid 223712548782270@lid 6281234567890",
            }, { quoted: msg });
            return true;
        }

        const result = lidAliasStore.rememberAlias(lid, pn, {
            source: "manual-bind",
            boundBy: ownerJid,
            pushName: msg?.pushName || "",
            messageId: msg?.key?.id,
            remoteJid,
        });

        await safeSend(sock, remoteJid, {
            text: [
                result?.saved ? "LID berhasil dibind" : "LID gagal dibind",
                `LID: ${lid}`,
                `PN: ${pn}`,
                result?.reason ? `Reason: ${result.reason}` : "",
            ].filter(Boolean).join("\n"),
        }, { quoted: msg });
        return true;
    }

    if (command === ".ceklid") {
        const lid = lidAliasStore.normalizeLidJid(args[0]);
        if (!lid) {
            await safeSend(sock, remoteJid, { text: "Format: .ceklid 223712548782270@lid" }, { quoted: msg });
            return true;
        }

        await safeSend(sock, remoteJid, {
            text: formatLidAliasEntry(lidAliasStore.getAlias(lid)),
        }, { quoted: msg });
        return true;
    }

    if (command === ".unlid") {
        const lid = lidAliasStore.normalizeLidJid(args[0]);
        if (!lid) {
            await safeSend(sock, remoteJid, { text: "Format: .unlid 223712548782270@lid" }, { quoted: msg });
            return true;
        }

        const result = lidAliasStore.removeAlias(lid);
        await safeSend(sock, remoteJid, {
            text: result.removed
                ? `Mapping LID dihapus: ${lid}`
                : `Mapping LID tidak ditemukan: ${lid}`,
        }, { quoted: msg });
        return true;
    }

    if (command === ".listlid") {
        const entries = lidAliasStore.listAliases().slice(0, 10);
        const lines = entries.length
            ? entries.map((entry, index) => `${index + 1}. ${entry.lid} -> ${entry.pn || "-"} | ${entry.pushName || "-"} | ${entry.source || "-"}`)
            : ["Belum ada LID tersimpan."];

        await safeSend(sock, remoteJid, {
            text: ["LID ALIAS TERBARU", ...lines].join("\n"),
        }, { quoted: msg });
        return true;
    }

    return false;
}

async function handleKasarCommand(msg, sock, ownerJid, text) {
    if (!/^\.kasar(?:\s|$)/i.test(text)) return false;

    const remoteJid = msg?.key?.remoteJid;
    const senderJid = getSenderJid(msg);
    const isOwner = Boolean(msg?.key?.fromMe || isSameUser(senderJid, ownerJid));

    if (!isOwner) {
        await safeSend(sock, remoteJid, { text: "Akses Ditolak" }, { quoted: msg });
        return true;
    }

    const newWord = sanitizeWord(text.replace(/^\.kasar/i, ""));
    if (!newWord) {
        await safeSend(sock, remoteJid, {
            text: `Format: *.kasar kata_baru*\nTotal kata terlarang saat ini: *${loadWords().length}*`,
        }, { quoted: msg });
        return true;
    }

    const words = loadWords(true);
    if (!words.includes(newWord)) {
        const saved = saveWords([...words, newWord]);
        if (!saved) {
            await safeSend(sock, remoteJid, { text: "Gagal menyimpan kata baru ke daftar terlarang." }, { quoted: msg });
            return true;
        }
    }

    await safeSend(sock, remoteJid, {
        text: `✓ Berhasil menambahkan '${newWord}' ke daftar kata terlarang. Varian alay seperti huruf berulang dan angka mirip huruf akan ikut dicek otomatis.`,
    }, { quoted: msg });
    return true;
}

async function handleToxicCheckInner(msg, sock, ownerJid, options = {}) {
    const remoteJid = msg?.key?.remoteJid;
    const rawText = getIncomingText(msg);
    const senderJid = msg?.key?.fromMe
        ? (normalizeJid(ownerJid) || getSenderJid(msg))
        : getSenderJid(msg);

    debugAntiToxic("enter", {
        id: msg?.key?.id,
        remoteJid,
        senderJid,
        rawSenderJid: getRawSenderJid(msg),
        fromMe: msg?.key?.fromMe,
        isGroup: isGroupJid(remoteJid),
        ownerJid,
        text: rawText,
        messageTypes: Object.keys(msg?.message || {}),
        wordCount: loadWords().length,
    });

    console.log("[ANTI-TOXIC ENTER]", {
        id: msg?.key?.id,
        remoteJid,
        fromMe: msg?.key?.fromMe,
        senderJid,
        text: rawText,
        wordCount: loadWords().length,
        ownerJid,
        testOwner: process.env.ANTI_TOXIC_TEST_OWNER,
        warnOwner: process.env.ANTI_TOXIC_WARN_OWNER_MESSAGES,
    });

    if (!remoteJid || !isPrivateOrGroupChat(remoteJid) || !msg?.message) return false;

    if (msg?.key?.fromMe && isAntiToxicGeneratedText(rawText)) {
        console.log("[ANTI-TOXIC SKIP] generated anti-toxic system text", {
            id: msg?.key?.id,
            remoteJid,
            fromMe: msg?.key?.fromMe,
            textPreview: rawText.slice(0, 120),
        });
        return false;
    }

    if (
        msg?.key?.fromMe
        && !ANTI_TOXIC_WARN_OWNER_MESSAGES
        && !isAntiToxicOwnerCommandText(rawText)
        && !(isStickerMessage(msg) && ANTI_TOXIC_STICKER_WARN_FROM_ME)
    ) {
        console.log("[ANTI-TOXIC SKIP] fromMe non-command", {
            id: msg?.key?.id,
            remoteJid,
            senderJid,
            textPreview: rawText.slice(0, 100),
        });
        return false;
    }

    const lidAliasHandled = rawText
        ? await handleLidAliasCommand(msg, sock, ownerJid, rawText)
        : false;
    if (lidAliasHandled) return true;

    const cekKasarHandled = rawText
        ? await handleCekKasarCommand(msg, sock, ownerJid, rawText)
        : false;
    if (cekKasarHandled) return true;

    const statusHandled = rawText
        ? await handleAntiToxicStatusCommand(msg, sock, ownerJid, rawText)
        : false;
    if (statusHandled) return true;

    const reloadHandled = rawText
        ? await handleAntiToxicReloadCommand(msg, sock, ownerJid, rawText)
        : false;
    if (reloadHandled) return true;

    const testWarnHandled = rawText
        ? await handleTestWarnCommand(msg, sock, ownerJid, rawText)
        : false;
    if (testWarnHandled) return true;

    const commandHandled = rawText
        ? await handleKasarCommand(msg, sock, ownerJid, rawText)
        : false;
    if (commandHandled) return true;

    const reflectionCommandHandled = await reflectionConfig.handleCommand(sock, msg, {
        text: rawText,
        remoteJid,
        senderJid,
        ownerJid,
    });
    if (reflectionCommandHandled) return true;

    if (rawText && /^\./.test(rawText) && !/^\.kasar(?:\s|$)/i.test(rawText)) {
        debugAntiToxic("skip-non-kasar-command", {
            text: rawText,
            id: msg?.key?.id,
        });
        console.log("[ANTI-TOXIC SKIP] command non-kasar", {
            id: msg?.key?.id,
            remoteJid,
            senderJid,
            text: rawText,
        });
        return false;
    }

    if (!senderJid) return false;

    const stickerOcrResult = rawText ? null : await getStickerOcrResultIfNeeded(msg, sock);
    const stickerOcrText = stickerOcrResult?.status === "toxic"
        ? String(stickerOcrResult.matchedWord || "")
        : "";
    const text = rawText || stickerOcrText;
    const isStickerOcr = !rawText && Boolean(stickerOcrText);
    if (!text) {
        debugAntiToxic("skip-empty-text", {
            id: msg?.key?.id,
            remoteJid,
            senderJid,
            messageTypes: Object.keys(msg?.message || {}),
        });
        console.log("[ANTI-TOXIC SKIP] text kosong", {
            id: msg?.key?.id,
            remoteJid,
            senderJid,
            messageTypes: Object.keys(msg?.message || {}),
        });
        return false;
    }

    const toxicMatch = await findToxicMatchWithTranslation(text);
    const triggeredWord = toxicMatch.matchedAlias || toxicMatch.word;
    const canonicalWord = toxicMatch.word;
    debugAntiToxic("match-result", {
        text,
        detected: Boolean(triggeredWord),
        triggeredWord,
        canonicalWord,
        matchedInput: toxicMatch?.matchedInput,
        detectionSource: toxicMatch?.detectionSource,
        tokens: toxicMatch?.tokens,
    });

    if (!triggeredWord) {
        debugAntiToxic("not-toxic", { text, remoteJid, senderJid });
        return false;
    }

    console.log("[ANTI-TOXIC DEBUG]", {
        stage: toxicMatch.detectionSource === "translated"
            ? "translated-toxic-detected"
            : toxicMatch.detectionSource === "variant"
                ? "variant-toxic-detected"
                : "exact-toxic-detected",
        remoteJid,
        senderJid,
        messageId: msg?.key?.id,
        isGroup: isGroupJid(remoteJid),
        text,
        detectionInputSource: isStickerOcr ? "sticker OCR" : "text",
        tokens: toxicMatch.tokens,
        originalTokens: toxicMatch.originalTokens,
        normalizedTokens: toxicMatch.normalizedTokens,
        matchedInput: toxicMatch.matchedInput,
        matchedNormalizedInput: toxicMatch.matchedNormalizedInput,
        triggeredWord,
        canonicalWord,
        matchedAlias: toxicMatch.matchedAlias,
        detectionVariant: toxicMatch.detectionVariant,
        detectionSource: toxicMatch.detectionSource,
        translatedText: toxicMatch.translatedText,
        translatedLanguage: toxicMatch.translatedLanguage,
        detectedLanguage: toxicMatch.detectedLanguage,
    });

    const isOwnerSender = Boolean(msg?.key?.fromMe || isSameUser(senderJid, ownerJid));
    debugAntiToxic("owner-check", {
        remoteJid,
        senderJid,
        ownerJid,
        fromMe: msg?.key?.fromMe,
        isOwnerSender,
        warnOwnerMessages: ANTI_TOXIC_WARN_OWNER_MESSAGES,
    });

    console.log("[ANTI-TOXIC DETECTED]", {
        id: msg?.key?.id,
        remoteJid,
        senderJid,
        text,
        triggeredWord,
        canonicalWord,
        fromMe: msg?.key?.fromMe,
        ownerJid,
        isOwnerSender,
    });

    console.log("[ANTI-TOXIC ORIGINAL MESSAGE]", {
        messageId: msg?.key?.id,
        remoteJid: msg?.key?.remoteJid,
        remoteJidAlt: msg?.key?.remoteJidAlt,
        participant: msg?.key?.participant,
        participantAlt: msg?.key?.participantAlt,
        senderLid: msg?.key?.senderLid,
        senderPn: msg?.key?.senderPn,
        participantLid: msg?.key?.participantLid,
        participantPn: msg?.key?.participantPn,
        addressingMode: msg?.key?.addressingMode,
        fromMe: msg?.key?.fromMe,
        senderJid,
        ownerJid,
        isSenderSelf: isBotSelfOrOwnerJid(senderJid, sock, ownerJid),
        isRemoteSelf: isBotSelfOrOwnerJid(msg?.key?.remoteJid, sock, ownerJid),
        text,
        triggeredWord,
        canonicalWord,
    });

    if (isOwnerSender && !ANTI_TOXIC_WARN_OWNER_MESSAGES && !(isStickerOcr && ANTI_TOXIC_STICKER_WARN_FROM_ME)) {
        console.log("[ANTI-TOXIC SKIP] owner exempt. Set ANTI_TOXIC_TEST_OWNER=true untuk testing.", {
            remoteJid,
            senderJid,
            messageId: msg?.key?.id,
            fromMe: Boolean(msg?.key?.fromMe),
            isGroup: isGroupJid(remoteJid),
            triggeredWord,
            canonicalWord,
        });
        return false;
    }

    if (isWarnCooldownActive(remoteJid, senderJid)) {
        logAntiToxicDebug("[ANTI-TOXIC DEBUG]", {
            ...createSendMeta(remoteJid, { quoted: msg }),
            stage: "warning-cooldown-active",
        });
        return true;
    }

    const isGroup = isGroupJid(remoteJid);
    const isPrivateUser = isPrivateUserJid(remoteJid);
    const isLidChat = isLidJid(remoteJid);
    const forceGroupPrivateReply = Boolean(options.groupPrivateReply || options.forceGroupPrivateReply);
    const suppressGroupFallback = Boolean(options.suppressGroupFallback || forceGroupPrivateReply);

    if (!acquireAntiToxicWarnDedup(msg)) {
        return true;
    }

    if (isSmartReplyMode()) {
        const smartSenderMention = await resolveSenderMention(sock, remoteJid, senderJid, msg, {
            remoteJid,
            senderJid,
            messageId: msg?.key?.id,
            fromMe: Boolean(msg?.key?.fromMe),
            isGroup,
        });
        const smartSafeMentionJid = smartSenderMention.mentionJid && isValidMentionJid(smartSenderMention.mentionJid)
            ? smartSenderMention.mentionJid
            : null;
        const mentionJid = isGroup
            ? getOffenderMentionJid(msg, senderJid)
            : resolveWarningMentionJid(msg, senderJid, isGroup, {
                ...smartSenderMention,
                mentionJid: smartSafeMentionJid || smartSenderMention.mentionJid,
            });
        const mentionJids = buildMentionArray(mentionJid);
        const mentionHeader = buildTrueMentionHeader(msg, mentionJid, smartSenderMention.label);
        const groupSubject = isGroup
            ? await getGroupSubject(sock, remoteJid, {
                remoteJid,
                senderJid,
                messageId: msg?.key?.id,
                fromMe: Boolean(msg?.key?.fromMe),
                isGroup,
            })
            : "";
        const reflectionCandidateJids = [
            smartSenderMention.mentionJid,
            msg?.key?.participantAlt,
            msg?.participantAlt,
            msg?.key?.participant,
            msg?.participant,
            msg?.key?.remoteJidAlt,
            msg?.key?.remoteJid,
        ].filter(Boolean);

        if (reflectionCandidateJids.length > 0) {
            try {
                reflectionConfig.rememberUserAliases(senderJid, ...reflectionCandidateJids);
            } catch (error) {
                console.log("[ANTI-TOXIC RENUNGAN] Gagal simpan alias pengirim toxic.", {
                    senderJid,
                    candidates: reflectionCandidateJids,
                    errorMessage: error?.message || String(error),
                });
            }
        }

        const reflectionPreference = reflectionConfig.getPreferenceForWarning({
            chatJid: remoteJid,
            remoteJid,
            senderJid,
            mentionJid: smartSafeMentionJid,
            candidateJids: reflectionCandidateJids,
            msg,
        });
        const quote = pickQuote(reflectionPreference?.profile);
        const translatedPreview = String(toxicMatch.translatedText || "").replace(/\s+/g, " ").trim().slice(0, 120);
        const translationContextText = !isStickerOcr && toxicMatch.detectionSource === "translated" && translatedPreview
            ? `Terdeteksi dari hasil translate (${toxicMatch.detectedLanguage || "auto"} -> ${toxicMatch.translatedLanguage || "id"}): "${translatedPreview}"\n`
            : "";
        const stickerOcrContextText = isStickerOcr
            ? buildStickerOcrWarningContext(stickerOcrResult, triggeredWord)
            : "";
        const detectionDetailText = isStickerOcr ? "" : buildDetectionDetailText(toxicMatch, triggeredWord, canonicalWord);
        const detectionOpeningText = isStickerOcr
            ? "Stiker yang kamu kirim terdeteksi mengandung kata kasar.\n"
            : `Kamu terdeteksi mengucapkan kata kasar terlarang: *"${triggeredWord}"*!\n`;
        const responseText =
            `${mentionHeader}\n\n` +
            detectionOpeningText +
            stickerOcrContextText +
            detectionDetailText +
            translationContextText +
            "Tolong jangan diulangi lagi ya. Mari saling menjaga lisan.\n\n" +
            `✨ *Renungan Hari Ini (${quote.source})* ✨\n` +
            `"${quote.quote}"`;
        const warningMessage = sanitizeAntiToxicWarningMessage({ text: responseText });
        if (mentionJids.length > 0) warningMessage.mentions = mentionJids;

        console.log("[ANTI-TOXIC DEBUG]", {
            stage: "toxic-warning-prepared",
            remoteJid,
            warningRemoteJid: null,
            warningTargets: [],
            senderJid,
            messageId: msg?.key?.id,
            isGroup,
            isLid: isLidChat,
            triggeredWord,
            canonicalWord,
            detectionInputSource: isStickerOcr ? "sticker OCR" : "text",
            matchedInput: toxicMatch.matchedInput,
            matchedNormalizedInput: toxicMatch.matchedNormalizedInput,
            matchedAlias: toxicMatch.matchedAlias,
            detectionVariant: toxicMatch.detectionVariant,
            groupSubject: groupSubject || null,
            reflectionProfile: reflectionPreference?.profile || null,
            reflectionScope: reflectionPreference?.scope || null,
            mentionJids,
            mentionSource: smartSenderMention.source,
            sendMode: "smart_reply",
        });

        console.log("[ANTI-TOXIC MODE] smart_reply", {
            remoteJid,
            senderJid,
            isGroup: isGroupJid(remoteJid),
            isLid: isLidJid(remoteJid),
            messageId: msg?.key?.id,
            triggeredWord,
            canonicalWord,
            replyMode: getAntiToxicReplyMode(),
        });

        const sent = await sendSmartToxicWarning(sock, msg, {
            warningMessage,
            senderJid,
            triggeredWord,
            canonicalWord,
            ownerJid,
            groupPrivateReply: forceGroupPrivateReply,
            suppressGroupFallback,
        });

        const resultRemoteJid = resolveKnownPrivateJidForLog(remoteJid);
        const resultSenderJid = resolveKnownPrivateJidForLog(senderJid);
        console.log("[ANTI-TOXIC SMART RESULT]", {
            remoteJid: resultRemoteJid,
            originalRemoteJid: resultRemoteJid !== remoteJid ? remoteJid : undefined,
            senderJid: resultSenderJid,
            originalSenderJid: resultSenderJid !== senderJid ? senderJid : undefined,
            isGroup: isGroupJid(remoteJid),
            isLid: isLidJid(resultRemoteJid),
            messageId: msg?.key?.id,
            sent,
        });

        if (sent) {
            setWarnCooldown(remoteJid, senderJid);
        } else {
            console.log("[ANTI-TOXIC ERROR] smart warning failed", {
                remoteJid: resultRemoteJid,
                originalRemoteJid: resultRemoteJid !== remoteJid ? remoteJid : undefined,
                senderJid: resultSenderJid,
                originalSenderJid: resultSenderJid !== senderJid ? senderJid : undefined,
                messageId: msg?.key?.id,
                isGroup: isGroupJid(remoteJid),
                isLid: isLidJid(resultRemoteJid),
                triggeredWord,
                canonicalWord,
            });
        }

        return true;
    }

    console.log("[ANTI-TOXIC ORIGINAL OFFENDER]", {
        messageId: msg?.key?.id,
        pushName: msg?.pushName || "",
        remoteJid,
        remoteJidAlt: msg?.key?.remoteJidAlt,
        participant: msg?.key?.participant,
        participantAlt: msg?.key?.participantAlt,
        senderJid,
        fromMe: msg?.key?.fromMe,
        isGroup,
        isLidChat,
    });

    if (isPrivateLidJid(remoteJid)) {
        lidAliasStore.rememberSeenLid(remoteJid, {
            source: "anti-toxic-private",
            pushName: msg?.pushName || "",
            messageId: msg?.key?.id,
            remoteJid,
            remoteJidAlt: msg?.key?.remoteJidAlt,
            participant: msg?.key?.participant,
            participantAlt: msg?.key?.participantAlt,
        });
        for (const pn of [msg?.key?.remoteJidAlt, msg?.key?.participantAlt, msg?.participantAlt].filter(isPrivateUserJid)) {
            lidAliasStore.rememberAlias(remoteJid, pn, {
                source: "anti-toxic-message-alt",
                pushName: msg?.pushName || "",
                messageId: msg?.key?.id,
                remoteJid,
                remoteJidAlt: msg?.key?.remoteJidAlt,
                participant: msg?.key?.participant,
                participantAlt: msg?.key?.participantAlt,
            });
        }
    }

    if (isLidJid(senderJid) || isLidChat) {
        console.log("[ANTI-TOXIC SENDER IS LID, PHONE UNKNOWN]", {
            senderJid,
            remoteJid,
            pushName: msg?.pushName || "",
            note: "Ini LID pengirim, bukan nomor HP. Butuh mapping ke @s.whatsapp.net.",
        });
    }

    const senderMention = await resolveSenderMention(sock, remoteJid, senderJid, msg, {
        remoteJid,
        senderJid,
        messageId: msg?.key?.id,
        fromMe: Boolean(msg?.key?.fromMe),
        isGroup,
    });
    const safeMentionJid = senderMention.mentionJid && isValidMentionJid(senderMention.mentionJid)
        ? senderMention.mentionJid
        : null;
    let warningTargets = [];
    let warningRemoteJid = remoteJid;
    let sendOptions = {};
    let mentionJid = safeMentionJid;
    let sendMode = "unknown";
    let resolvedPrivate = null;
    let mappedPn = null;

    if (isGroup) {
        if (!safeMentionJid || (!isPrivateUserJid(safeMentionJid) && !isPrivateLidJid(safeMentionJid))) {
            console.log("[ANTI-TOXIC DEBUG]", {
                stage: forceGroupPrivateReply
                    ? "group-private-warning-target-unresolved-no-group-fallback"
                    : "group-private-warning-target-unresolved-fallback-to-group",
                remoteJid,
                senderJid,
                messageId: msg?.key?.id,
                isGroup,
                triggeredWord,
                mentionSource: senderMention.source,
                resolvedMentionJid: senderMention.mentionJid || null,
                note: forceGroupPrivateReply
                    ? "JID private pengirim belum berhasil di-resolve, warning grup dimatikan oleh groupctl privatewarn."
                    : "JID private pengirim belum berhasil di-resolve, warning dikirim ke grup sebagai fallback.",
            });
            warningRemoteJid = forceGroupPrivateReply ? "" : remoteJid;
            warningTargets = forceGroupPrivateReply ? [] : [remoteJid];
            sendOptions = forceGroupPrivateReply ? {} : { quoted: msg };
            mentionJid = null;
            sendMode = forceGroupPrivateReply
                ? "group-toxic-private-unresolved-no-fallback"
                : "group-toxic-warning-unresolved-fallback";
        } else {
            resolvedPrivate = isPrivateUserJid(safeMentionJid)
                ? {
                    targets: [safeMentionJid],
                    primary: safeMentionJid,
                    source: "group-direct-pn",
                    candidates: [safeMentionJid],
                }
                : await resolvePrivateWarningTargets(sock, msg, safeMentionJid, senderJid, senderMention, {
                    remoteJid: safeMentionJid,
                    senderJid,
                    messageId: msg?.key?.id,
                });
            warningTargets = resolvedPrivate.targets.length
                ? resolvedPrivate.targets
                : [safeMentionJid];
            mappedPn = isPrivateUserJid(resolvedPrivate.primary) ? resolvedPrivate.primary : null;
            warningRemoteJid = warningTargets[0];
            sendOptions = {};
            mentionJid = safeMentionJid;
            sendMode = isLidJid(safeMentionJid)
                ? (mappedPn ? "group-toxic-private-lid-mapped-to-pn" : `group-toxic-private-lid-${resolvedPrivate.source}`)
                : "group-toxic-private-warning";
            if (isLidJid(safeMentionJid)) {
                console.log("[ANTI-TOXIC GROUP LID RESOLUTION]", {
                    remoteJid,
                    senderJid,
                    offenderLid: safeMentionJid,
                    mappedPn,
                    resolvedSource: resolvedPrivate.source,
                    targets: warningTargets,
                });
            }
        }
    } else if (msg?.key?.fromMe && ANTI_TOXIC_WARN_OWNER_MESSAGES && normalizeJid(ownerJid)) {
        const ownerSelfTarget = normalizeJid(ownerJid);
        warningTargets = [ownerSelfTarget];
        warningRemoteJid = ownerSelfTarget;
        sendOptions = {};
        mentionJid = ownerSelfTarget;
        sendMode = "private-from-me-owner-warning";
        resolvedPrivate = {
            targets: [ownerSelfTarget],
            primary: ownerSelfTarget,
            source: "from-me-owner-self",
            candidates: [ownerSelfTarget],
        };
    } else {
        resolvedPrivate = await resolvePrivateWarningTargets(sock, msg, remoteJid, senderJid, senderMention, {
            remoteJid,
            senderJid,
            messageId: msg?.key?.id,
        });
        warningTargets = resolvedPrivate.targets.length
            ? resolvedPrivate.targets
            : [remoteJid];
        mappedPn = isPrivateUserJid(resolvedPrivate.primary) ? resolvedPrivate.primary : null;
        warningRemoteJid = warningTargets[0];
        sendOptions = isPrivateUserJid(warningRemoteJid) ? { quoted: msg } : {};
        mentionJid = safeMentionJid || warningRemoteJid;
        sendMode = isLidChat
            ? (mappedPn ? "private-lid-mapped-to-pn" : "private-lid-unresolved")
            : "private-pn";

        if (isLidChat) {
            console.log("[ANTI-TOXIC LID RESOLUTION]", {
                remoteJid,
                senderJid,
                mappedPn,
                aliasInfo: lidAliasStore.getDebugInfo(remoteJid),
                sendMode,
                resolvedSource: resolvedPrivate.source,
                targets: warningTargets,
            });
        }
    }

    console.log("[ANTI-TOXIC WARNING TARGET]", {
        mode: isGroup ? "group" : "private",
        remoteJid,
        senderJid,
        warningRemoteJid,
        warningTargets,
        sendMode,
        resolvedSource: resolvedPrivate?.source || null,
        isPrivateUser,
        isLidChat,
    });

    const sendMeta = createSendMeta(warningRemoteJid, sendOptions, {
        msg,
        senderJid,
        messageId: msg?.key?.id,
    });
    const trueMentionJid = resolveWarningMentionJid(msg, senderJid, isGroup, {
        ...senderMention,
        mentionJid: mentionJid || senderMention.mentionJid,
    });
    const mentionJids = buildMentionArray(trueMentionJid);
    const mentionHeader = buildTrueMentionHeader(msg, trueMentionJid, senderMention.label);
    const groupSubject = isGroup
        ? await getGroupSubject(sock, remoteJid, {
            remoteJid,
            senderJid,
            messageId: msg?.key?.id,
            fromMe: Boolean(msg?.key?.fromMe),
            isGroup,
        })
        : "";
    const reflectionCandidateJids = [
        senderMention.mentionJid,
        msg?.key?.participantAlt,
        msg?.participantAlt,
        msg?.key?.participant,
        msg?.participant,
        msg?.key?.remoteJidAlt,
        msg?.key?.remoteJid,
    ].filter(Boolean);

    if (reflectionCandidateJids.length > 0) {
        try {
            reflectionConfig.rememberUserAliases(senderJid, ...reflectionCandidateJids);
        } catch (error) {
            console.log("[ANTI-TOXIC RENUNGAN] Gagal simpan alias pengirim toxic.", {
                senderJid,
                candidates: reflectionCandidateJids,
                errorMessage: error?.message || String(error),
            });
        }
    }

    const reflectionPreference = reflectionConfig.getPreferenceForWarning({
        chatJid: remoteJid,
        remoteJid,
        senderJid,
        mentionJid: safeMentionJid,
        candidateJids: reflectionCandidateJids,
        msg,
    });
    const quote = pickQuote(reflectionPreference?.profile);
    const translatedPreview = String(toxicMatch.translatedText || "").replace(/\s+/g, " ").trim().slice(0, 120);
    const translationContextText = !isStickerOcr && toxicMatch.detectionSource === "translated" && translatedPreview
        ? `Terdeteksi dari hasil translate (${toxicMatch.detectedLanguage || "auto"} -> ${toxicMatch.translatedLanguage || "id"}): "${translatedPreview}"\n`
        : "";
    const stickerOcrContextText = isStickerOcr
        ? buildStickerOcrWarningContext(stickerOcrResult, triggeredWord)
        : "";
    const detectionDetailText = isStickerOcr ? "" : buildDetectionDetailText(toxicMatch, triggeredWord, canonicalWord);
    const detectionOpeningText = isStickerOcr
        ? "Stiker yang kamu kirim terdeteksi mengandung kata kasar.\n"
        : `Kamu terdeteksi mengucapkan kata kasar terlarang: *"${triggeredWord}"*!\n`;
    const responseText =
        `${mentionHeader}\n\n` +
        detectionOpeningText +
        stickerOcrContextText +
        detectionDetailText +
        translationContextText +
        "Tolong jangan diulangi lagi ya. Mari saling menjaga lisan.\n\n" +
        `✨ *Renungan Hari Ini (${quote.source})* ✨\n` +
        `"${quote.quote}"`;
    const warningMessage = sanitizeAntiToxicWarningMessage({ text: responseText });
    if (mentionJids.length > 0) warningMessage.mentions = mentionJids;

    console.log("[ANTI-TOXIC DEBUG]", {
        stage: "toxic-warning-prepared",
        remoteJid,
        warningRemoteJid,
        warningTargets,
        senderJid,
        messageId: msg?.key?.id,
        isGroup,
        isLid: isLidChat,
        triggeredWord,
        canonicalWord,
        detectionInputSource: isStickerOcr ? "sticker OCR" : "text",
        matchedInput: toxicMatch.matchedInput,
        matchedNormalizedInput: toxicMatch.matchedNormalizedInput,
        matchedAlias: toxicMatch.matchedAlias,
        detectionVariant: toxicMatch.detectionVariant,
        groupSubject: groupSubject || null,
        reflectionProfile: reflectionPreference?.profile || null,
        reflectionScope: reflectionPreference?.scope || null,
        mentionJids,
        mentionSource: senderMention.source,
        sendMode,
    });

    let privateSendResult = null;
    let sent = false;
    let groupFallbackSent = false;

    if (isGroup && warningRemoteJid === remoteJid) {
        sent = await safeSend(sock, warningRemoteJid, warningMessage, sendOptions, sendMeta);
        if (!sent) {
            sent = await safeSend(
                sock,
                remoteJid,
                warningMessage,
                {},
                createSendMeta(remoteJid, {}, {
                    msg,
                    senderJid,
                    messageId: msg?.key?.id,
                    fallbackType: "group-direct-plain-after-quoted-failed",
                })
            );
        }
    } else if (!isGroup && isLidChat) {
        privateSendResult = await sendPrivateLidWarning(
            sock,
            msg,
            warningMessage,
            {
                mappedPn,
                remoteJid,
                senderJid,
            }
        );
        sent = privateSendResult.sent;
        if (privateSendResult.targetJid || privateSendResult.target) {
            warningRemoteJid = privateSendResult.targetJid || privateSendResult.target;
        }
    } else {
        privateSendResult = await sendWarningToTargets(
            sock,
            warningTargets,
            warningMessage,
            msg,
            {
                remoteJid,
                senderJid,
                messageId: msg?.key?.id,
                sendMode,
            }
        );
        sent = privateSendResult.sent;
        if (privateSendResult.targetJid) warningRemoteJid = privateSendResult.targetJid;
    }

    if (!sent && isGroup && warningRemoteJid !== remoteJid && !suppressGroupFallback) {
        const groupFallbackMessage = { ...warningMessage };
        const groupFallbackOptions = { quoted: msg };

        console.log("[ANTI-TOXIC DEBUG]", {
            stage: "private-toxic-warning-failed-fallback-to-group",
            remoteJid,
            warningRemoteJid,
            senderJid,
            messageId: msg?.key?.id,
            triggeredWord,
            mentionJids,
        });

        groupFallbackSent = await safeSend(
            sock,
            remoteJid,
            groupFallbackMessage,
            groupFallbackOptions,
            createSendMeta(remoteJid, groupFallbackOptions, {
                msg,
                senderJid,
                messageId: msg?.key?.id,
                fallbackType: "group-after-private-failed",
            })
        );
        if (!groupFallbackSent) {
            groupFallbackSent = await safeSend(
                sock,
                remoteJid,
                groupFallbackMessage,
                {},
                createSendMeta(remoteJid, {}, {
                    msg,
                    senderJid,
                    messageId: msg?.key?.id,
                    fallbackType: "group-after-private-failed-plain",
                })
            );
        }
        sent = groupFallbackSent;
    } else if (!sent && isGroup && warningRemoteJid !== remoteJid && suppressGroupFallback) {
        console.log("[ANTI-TOXIC DEBUG]", {
            stage: "private-toxic-warning-failed-no-group-fallback",
            remoteJid,
            warningRemoteJid,
            senderJid,
            messageId: msg?.key?.id,
            triggeredWord,
            mentionJids,
            sendMode,
        });
    }

    console.log("[ANTI-TOXIC DEBUG]", {
        stage: "toxic-warning-send-result",
        remoteJid,
        warningRemoteJid,
        senderJid,
        messageId: msg?.key?.id,
        isGroup,
        isLid: isLidChat,
        sent,
        groupFallbackSent,
        tried: privateSendResult?.tried || [],
    });

    if (sent || groupFallbackSent) {
        setWarnCooldown(remoteJid, senderJid);
    } else {
        console.log("[ANTI-TOXIC ERROR] toxic detected but warning failed to send", {
            remoteJid,
            warningRemoteJid,
            senderJid,
            messageId: msg?.key?.id,
            isGroup,
            isLid: isLidChat,
            triggeredWord,
            canonicalWord,
            sendMode,
            tried: privateSendResult?.tried || [],
        });
        if (shouldReportToxicSendFailure(msg?.key?.id)) {
            await reportToxicSendFailureToOwner(sock, msg, {
                remoteJid,
                senderJid,
                triggeredWord,
                canonicalWord,
                sendMode,
                pushName: msg?.pushName || "",
                tried: privateSendResult?.tried || [],
                ownerJids: [ownerJid],
            });
        }
    }

    return true;
}

async function handleToxicCheck(msg, sock, ownerJid, options = {}) {
    try {
        return await handleToxicCheckInner(msg, sock, ownerJid, options);
    } catch (error) {
        logAntiToxicDebug("[ANTI-TOXIC DEBUG]", {
            stage: "handle-toxic-check-crashed",
            remoteJid: msg?.key?.remoteJid,
            senderJid: getRawSenderJid(msg),
            messageId: msg?.key?.id,
            fromMe: Boolean(msg?.key?.fromMe),
            isGroup: isGroupJid(msg?.key?.remoteJid),
            statusCode: getErrorStatusCode(error),
            error,
        });
        return false;
    }
}

ensureWordsFile();
antiToxicMatcher.initializeMatcher(getAntiToxicMatcherOptions());

module.exports = {
    handleToxicCheck,
    findToxicWord,
    findToxicMatch,
    getAntiToxicMatcherOptions,
    handleAntiToxicSafeMatcherCommand: (sock, msg, context = {}) => antiToxicMatcher.handleAntiToxicSafeMatcherCommand(sock, msg, {
        ...context,
        getMatcherOptions: getAntiToxicMatcherOptions,
    }),
    getAntiToxicMatcherHealth: () => antiToxicMatcher.getMatcherHealth(getAntiToxicMatcherOptions()),
    loadWords,
    saveWords,
    getAntiToxicStickerOcrHealth: () => antiToxicStickerOcr.getAntiToxicStickerOcrHealth({
        toxicWords: loadWords(),
        probeDependencies: true,
    }),
    clearAntiToxicStickerOcrCache: antiToxicStickerOcr.clearAntiToxicStickerOcrCache,
    disposeAntiToxicStickerOcr: antiToxicStickerOcr.disposeAntiToxicStickerOcr,
    buildStickerOcrWarningContext,
};
