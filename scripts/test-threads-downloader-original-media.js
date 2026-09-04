const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DOWNLOADER_TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "threads-dl-test-"));

const localDownloader = require("../modules/localDownloader");

function htmlWithPost(post, ogImage = "https://preview.example/share-card.jpg") {
    return `<!doctype html><html><head>
<meta property="og:image" content="${ogImage}">
<meta name="twitter:image" content="${ogImage}">
</head><body>
<script type="application/json">${JSON.stringify({ payload: { thread_items: [{ post }] } })}</script>
</body></html>`;
}

function image(id, url, width = 1080, height = 1350) {
    return {
        id,
        media_type: 1,
        image_versions2: {
            candidates: [
                { url: `${url}?small=1`, width: 320, height: 400 },
                { url, width, height },
            ],
        },
        original_width: width,
        original_height: height,
    };
}

function video(id, url) {
    return {
        id,
        media_type: 2,
        image_versions2: { candidates: [{ url: `https://cdn.example/${id}-thumb.jpg`, width: 640, height: 800 }] },
        video_versions: [
            { url: `${url}?low=1`, width: 360, height: 640, bandwidth: 200000 },
            { url, width: 1080, height: 1920, bandwidth: 2000000 },
        ],
    };
}

function fakeSock(sent) {
    return {
        sendMessage: async (_jid, payload) => {
            sent.push(payload);
            return { key: { id: `m${sent.length}`, remoteJid: _jid, fromMe: true } };
        },
    };
}

async function run() {
    // TEST A: single JPG. Structured original must beat OG/Twitter share card.
    {
        const post = { code: "POSTA", ...image("a", "https://cdn.example/original-a.jpg") };
        const media = localDownloader.extractThreadsMediaFromHtml(htmlWithPost(post), "POSTA");
        assert.strictEqual(media.length, 1);
        assert.strictEqual(media[0].url, "https://cdn.example/original-a.jpg");
        assert.strictEqual(media[0].source, "structured");
        assert.ok(!media[0].url.includes("share-card"));
    }

    // TEST B: 5-image carousel preserves original order and ignores share card.
    {
        const carousel = [1, 2, 3, 4, 5].map(i => image(`b${i}`, `https://cdn.example/b${i}.jpg`));
        const post = { code: "POSTB", carousel_media: carousel };
        const media = localDownloader.extractThreadsMediaFromHtml(htmlWithPost(post), "POSTB");
        assert.deepStrictEqual(media.map(x => x.url), carousel.map((_, i) => `https://cdn.example/b${i + 1}.jpg`));
        assert.ok(media.every(x => x.type === "image"));
        assert.ok(media.every(x => !x.url.includes("share-card")));
    }

    // REGRESSION: this reproduces the production bug reported by the user.
    // A Threads share wrapper points to the exact target via share_url and exposes
    // a 1200x628 social card in image_versions2. That wrapper must NEVER win over
    // the actual post media.
    {
        const actualCarousel = [1, 2, 3, 4, 5].map(i => image(`real${i}`, `https://cdn.example/real-${i}.jpg`));
        const shareWrapper = {
            share_url: "https://www.threads.com/@346eur/post/BUGCARD",
            image_versions2: {
                candidates: [{ url: "https://cdn.example/threads-social-card.jpg", width: 1200, height: 628 }],
            },
            preview_title: "Steal these for later!",
        };
        const actualPost = {
            code: "BUGCARD",
            pk: "123456789",
            media_type: 8,
            carousel_media: actualCarousel,
        };
        const html = `<!doctype html><script type="application/json">${JSON.stringify({ share: shareWrapper, thread_items: [{ post: actualPost }] })}</script>`;
        const media = localDownloader.extractThreadsMediaFromHtml(html, "BUGCARD");
        assert.strictEqual(media.length, 5);
        assert.deepStrictEqual(media.map(x => x.url), actualCarousel.map((_, i) => `https://cdn.example/real-${i + 1}.jpg`));
        assert.ok(media.every(x => !x.url.includes("social-card")));
    }

    // share_url by itself is only target CONTEXT, never proof that its image_versions2
    // is original post media. If there is no genuine descendant media record, fail.
    {
        const shareOnly = {
            share_url: "https://www.threads.com/@346eur/post/ONLYCARD",
            image_versions2: {
                candidates: [{ url: "https://cdn.example/only-social-card.jpg", width: 1200, height: 628 }],
            },
        };
        const html = `<script type="application/json">${JSON.stringify({ payload: shareOnly })}</script>`;
        const media = localDownloader.extractThreadsMediaFromHtml(html, "ONLYCARD");
        assert.deepStrictEqual(media, []);
    }

    // Wrapper may carry share_url while the genuine media record is nested below it
    // without repeating the shortcode. Recover that original record, but not wrapper image.
    {
        const nestedOriginal = {
            pk: "nested-1",
            media_type: 1,
            ...image("nested-1", "https://cdn.example/nested-original.jpg"),
        };
        const wrapper = {
            share_url: "https://www.threads.com/@346eur/post/NESTED",
            image_versions2: {
                candidates: [{ url: "https://cdn.example/nested-social-card.jpg", width: 1200, height: 628 }],
            },
            thread_items: [{ post: nestedOriginal }],
        };
        const html = `<script type="application/json">${JSON.stringify({ payload: wrapper })}</script>`;
        const media = localDownloader.extractThreadsMediaFromHtml(html, "NESTED");
        assert.strictEqual(media.length, 1);
        assert.strictEqual(media[0].url, "https://cdn.example/nested-original.jpg");
    }

    // Only OG share card => fail closed instead of returning wrong image.
    {
        const html = '<meta property="og:image" content="https://preview.example/white-threads-card.jpg">';
        const media = localDownloader.extractThreadsMediaFromHtml(html, "MISSING");
        assert.deepStrictEqual(media, []);
    }

    // TEST C: HEIC preview JPEG is temporary; original HEIC document is unchanged.
    {
        const dir = process.env.DOWNLOADER_TEMP_DIR;
        const heic = path.join(dir, "source.heic");
        fs.writeFileSync(heic, Buffer.from("ORIGINAL-HEIC-BYTES"));
        const original = fs.readFileSync(heic);
        const sent = [];
        const converter = async (_input, output) => {
            fs.writeFileSync(output, Buffer.from("JPEG-PREVIEW"));
            return output;
        };
        await localDownloader.sendThreadsDownloadedFiles(fakeSock(sent), "1@s.whatsapp.net", [{ filePath: heic, type: "image" }], "media", { convertHeicToJpeg: converter });
        assert.strictEqual(sent.filter(x => x.image).length, 1);
        assert.strictEqual(sent.filter(x => x.document).length, 1);
        const preview = sent.find(x => x.image);
        const doc = sent.find(x => x.document);
        assert.ok(String(preview.image.url).endsWith(".jpg"));
        assert.strictEqual(doc.document.url, heic);
        assert.strictEqual(doc.mimetype, "image/heic");
        assert.deepStrictEqual(fs.readFileSync(heic), original);
        assert.strictEqual(fs.existsSync(preview.image.url), false, "temporary JPEG must be cleaned");
    }

    // TEST D: structured video remains supported and beats image thumbnail.
    {
        const post = { code: "POSTD", ...video("d", "https://cdn.example/d.mp4") };
        const media = localDownloader.extractThreadsMediaFromHtml(htmlWithPost(post), "POSTD");
        assert.strictEqual(media.length, 1);
        assert.strictEqual(media[0].type, "video");
        assert.strictEqual(media[0].url, "https://cdn.example/d.mp4");
    }

    // TEST E: mixed carousel preserves every item and order.
    {
        const post = {
            code: "POSTE",
            carousel_media: [
                image("e1", "https://cdn.example/e1.jpg"),
                video("e2", "https://cdn.example/e2.mp4"),
                image("e3", "https://cdn.example/e3.heic"),
            ],
        };
        const media = localDownloader.extractThreadsMediaFromHtml(htmlWithPost(post), "POSTE");
        assert.deepStrictEqual(media.map(x => x.type), ["image", "video", "image"]);
        assert.deepStrictEqual(media.map(x => x.url), [
            "https://cdn.example/e1.jpg",
            "https://cdn.example/e2.mp4",
            "https://cdn.example/e3.heic",
        ]);
    }

    // Threads 5-image delivery => one Baileys image album + 5 original documents,
    // summary only once, no (1/5)... status spam.
    {
        const dir = process.env.DOWNLOADER_TEMP_DIR;
        const files = [];
        for (let i = 1; i <= 5; i++) {
            const filePath = path.join(dir, `carousel-${i}.jpg`);
            fs.writeFileSync(filePath, Buffer.from(`jpg-${i}`));
            files.push({ filePath, type: "image" });
        }
        const sent = [];
        await localDownloader.sendThreadsDownloadedFiles(fakeSock(sent), "1@s.whatsapp.net", files, "media");
        const albumParents = sent.filter(x => x.album);
        const imageChildren = sent.filter(x => x.image);
        const documents = sent.filter(x => x.document);
        assert.strictEqual(albumParents.length, 1);
        assert.strictEqual(albumParents[0].album.expectedImageCount, 5);
        assert.strictEqual(imageChildren.length, 5);
        assert.ok(imageChildren.every(x => x.albumParentKey), "all preview images must belong to album");
        assert.strictEqual(documents.length, 5);
        const captions = sent.map(x => x.caption).filter(Boolean);
        assert.strictEqual(captions.filter(x => /Threads berhasil didownload/.test(x)).length, 1);
        assert.ok(captions.every(x => !/\([1-5]\/5\)/.test(x)));
        assert.ok(captions.some(x => /Original files disertakan/.test(x)));
    }

    // TEST F: generic non-Threads sender retains CURRENT project behavior: image album.
    {
        const dir = process.env.DOWNLOADER_TEMP_DIR;
        const files = [1, 2].map(i => {
            const filePath = path.join(dir, `instagram-${i}.jpg`);
            fs.writeFileSync(filePath, Buffer.from(`ig-${i}`));
            return { filePath, type: "image" };
        });
        const sent = [];
        await localDownloader.sendDownloadedFiles(fakeSock(sent), "1@s.whatsapp.net", files, "Instagram", "media");
        assert.strictEqual(sent.filter(x => x.album).length, 1);
        assert.strictEqual(sent.filter(x => x.image).length, 2);
        assert.ok(sent.find(x => x.caption)?.caption.includes("Instagram berhasil didownload (2 gambar)"));
    }

    // Threads menu must not advertise/apply the generic USERBOT watermark label.
    {
        const sent = [];
        const sock = fakeSock(sent);
        const handled = await localDownloader.handleLocalDownload(
            sock,
            "628111111111@s.whatsapp.net",
            "https://www.threads.com/@346eur/post/MENUTEST",
            "Tester",
            { id: "trigger-threads" }
        );
        assert.strictEqual(handled, true);
        const menuText = sent.find(payload => payload.text)?.text || "";
        assert.ok(/Link Threads terdeteksi/.test(menuText));
        assert.ok(!/Watermark:\s*USERBOT_/i.test(menuText));
        await localDownloader.handleLocalDownload(
            sock,
            "628111111111@s.whatsapp.net",
            "3",
            "Tester",
            { id: "cancel-threads" }
        );
    }

    // SHARE URL REGRESSION: WhatsApp used to fail immediately because /share/<id>
    // has no /post/<code>. Match the working Telegram implementation: Vreden first.
    {
        const shareUrl = "https://www.threads.com/share/BAZUcM8P8O/";
        const apiUrl = localDownloader.buildThreadsVredenUrl(shareUrl);
        const parsed = new URL(apiUrl);
        assert.strictEqual(parsed.origin + parsed.pathname, "https://api.vreden.my.id/api/v1/download/threads");
        assert.strictEqual(parsed.searchParams.get("slof"), "1");
        assert.strictEqual(parsed.searchParams.get("url"), shareUrl);

        const payload = {
            data: {
                user: { profile_pic: "https://cdn.example/avatar.jpg" },
                preview_image: "https://cdn.example/white-card.jpg",
                media: [
                    { image: "https://cdn.example/share-original-1.jpg" },
                    { image: "https://cdn.example/share-original-2.heic" },
                ],
            },
        };
        const filtered = localDownloader.extractThreadsMediaFromApiPayload(payload);
        assert.deepStrictEqual(filtered.map(x => x.url), [
            "https://cdn.example/share-original-1.jpg",
            "https://cdn.example/share-original-2.heic",
        ]);
        assert.ok(filtered.every(x => x.source === "threads-vreden-api"));
        assert.ok(filtered.every(x => !x.url.includes("avatar") && !x.url.includes("white-card")));

        let requestedApi = null;
        const media = await localDownloader.extractThreadsMedia(shareUrl, {
            requestJson: async requestUrl => {
                requestedApi = requestUrl;
                return payload;
            },
            fetchPage: async () => {
                throw new Error("direct HTML should not run when Vreden succeeds");
            },
        });
        assert.ok(requestedApi.includes("api.vreden.my.id/api/v1/download/threads"));
        assert.deepStrictEqual(media.map(x => x.url), filtered.map(x => x.url));
    }

    // If Vreden is unavailable, a /share/ URL must follow the browser redirect and
    // derive the real /post/<code> from FINAL URL instead of failing before request.
    {
        const shareUrl = "https://www.threads.com/share/REDIRECTME/";
        const actualPost = { code: "REALPOST", ...image("redirect-real", "https://cdn.example/redirect-real.jpg") };
        let pageCalls = 0;
        const media = await localDownloader.extractThreadsMedia(shareUrl, {
            requestJson: async () => {
                throw new Error("synthetic API outage");
            },
            fetchPage: async () => {
                pageCalls += 1;
                return {
                    finalUrl: "https://www.threads.com/@tester/post/REALPOST/",
                    html: htmlWithPost(actualPost),
                };
            },
        });
        assert.ok(pageCalls >= 1);
        assert.strictEqual(media.length, 1);
        assert.strictEqual(media[0].url, "https://cdn.example/redirect-real.jpg");
    }

    // Current TikTok URL helpers must still be present after merge.
    assert.strictEqual(typeof localDownloader.extractUrls, "function");
    assert.strictEqual(typeof localDownloader.unwrapTikTokRedirectUrl, "function");
    assert.strictEqual(typeof localDownloader.getUnsupportedTikTokPageKind, "function");

    console.log("PASS test-threads-downloader-original-media");
}

run().finally(() => {
    fs.rmSync(process.env.DOWNLOADER_TEMP_DIR, { recursive: true, force: true });
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
