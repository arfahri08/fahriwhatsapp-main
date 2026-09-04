const assert = require("assert");
const { sendDownloadedFiles } = require("../modules/localDownloader");

async function main() {
    const calls = [];
    const albumKey = {
        remoteJid: "628000000000@s.whatsapp.net",
        fromMe: true,
        id: "album-parent",
    };
    const sock = {
        async sendMessage(jid, content, options) {
            calls.push({ jid, content, options });
            if (content.album) return { key: albumKey };
            return { key: { ...albumKey, id: `child-${calls.length}` } };
        },
    };

    const files = Array.from({ length: 9 }, (_, index) => ({
        filePath: `C:/temp/tiktok-${index + 1}.jpg`,
        type: "image",
    }));

    await sendDownloadedFiles(sock, albumKey.remoteJid, files, "TikTok", "media");

    assert.strictEqual(calls.length, 10, "harus ada satu induk album dan sembilan item gambar");
    assert.deepStrictEqual(calls[0].content.album, {
        expectedImageCount: 9,
        expectedVideoCount: 0,
    });

    const children = calls.slice(1);
    assert.ok(children.every(call => call.content.image));
    assert.ok(children.every(call => call.content.albumParentKey === albumKey));
    assert.match(children[0].content.caption, /9 gambar/);
    assert.ok(children.slice(1).every(call => !call.content.caption));

    const visibleText = calls
        .map(call => call.content.caption || call.content.text || "")
        .join("\n");
    assert.doesNotMatch(visibleText, /tikwm|yt-dlp|rapidapi|fallback|\bapi\b/i);

    console.log("Downloader private caption and album tests passed.");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
