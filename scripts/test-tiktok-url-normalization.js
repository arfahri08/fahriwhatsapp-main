const assert = require("assert");
const {
    extractUrl,
    handleLocalDownload,
    normalizeDownloadUrl,
    unwrapTikTokRedirectUrl,
    getUnsupportedTikTokPageKind,
    isLikelyTikTokMediaUrl,
} = require("../modules/localDownloader");

const loginWrapper = "https://www.tiktok.com/login?lang=en&enter_method=developer&enter_from=minis&redirect_url=https%253A%252F%252Fwww.tiktok.com%252Fminis%252FmKWqXCKt0ij";
const minisUrl = "https://www.tiktok.com/minis/mKWqXCKt0ij";
const videoUrl = "https://www.tiktok.com/@contoh/video/7530000000000000000";

assert.strictEqual(unwrapTikTokRedirectUrl(loginWrapper), minisUrl);
assert.strictEqual(normalizeDownloadUrl(loginWrapper, "tiktok"), minisUrl);
assert.strictEqual(getUnsupportedTikTokPageKind(loginWrapper), "minis");
assert.strictEqual(getUnsupportedTikTokPageKind(minisUrl), "minis");
assert.strictEqual(getUnsupportedTikTokPageKind(videoUrl), null);
assert.strictEqual(isLikelyTikTokMediaUrl(videoUrl), true);
assert.strictEqual(isLikelyTikTokMediaUrl("https://vt.tiktok.com/ZSExample/"), true);

const wrappedVideoUrl = `https://www.tiktok.com/login?redirect_url=${encodeURIComponent(encodeURIComponent(videoUrl))}`;
assert.strictEqual(normalizeDownloadUrl(wrappedVideoUrl, "tiktok"), videoUrl);

assert.strictEqual(
    extractUrl(`Coba ${loginWrapper} tetapi video aslinya ${videoUrl}`),
    videoUrl
);

const externalRedirect = "https://www.tiktok.com/login?redirect_url=https%3A%2F%2Fevil.example%2Fvideo";
assert.strictEqual(unwrapTikTokRedirectUrl(externalRedirect), externalRedirect);

async function testMinisRejectedBeforeDownloaderMenu() {
    const sentMessages = [];
    const sock = {
        async sendMessage(jid, content) {
            sentMessages.push({ jid, content });
            return { key: { id: "test-message" } };
        },
    };

    const handled = await handleLocalDownload(
        sock,
        "628000000000@s.whatsapp.net",
        loginWrapper,
        "Tester",
        { id: "incoming-message" }
    );

    assert.strictEqual(handled, true);
    assert.strictEqual(sentMessages.length, 1);
    assert.match(sentMessages[0].content.text, /bukan link video TikTok/i);
    assert.match(sentMessages[0].content.text, /TikTok Minis/i);
}

testMinisRejectedBeforeDownloaderMenu()
    .then(() => console.log("TikTok URL normalization tests passed."))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
