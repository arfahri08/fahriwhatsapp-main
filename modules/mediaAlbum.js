function normalizeImage(image) {
    if (Buffer.isBuffer(image)) return image;
    if (typeof image === "string") return { url: image };
    if (image && typeof image === "object") return image;
    throw new Error("Data gambar album tidak valid.");
}

async function sendImageAlbum(sock, jid, images, options = {}) {
    const items = Array.isArray(images) ? images.filter(Boolean) : [];
    if (items.length < 2) throw new Error("Album gambar membutuhkan minimal dua gambar.");

    const parentOptions = options.quoted ? { quoted: options.quoted } : undefined;
    const parent = await sock.sendMessage(jid, {
        album: {
            expectedImageCount: items.length,
            expectedVideoCount: 0,
        },
    }, parentOptions);

    if (!parent?.key) throw new Error("WhatsApp tidak mengembalikan kunci album.");

    const sent = [];
    for (let index = 0; index < items.length; index += 1) {
        const content = {
            image: normalizeImage(items[index]),
            albumParentKey: parent.key,
        };

        if (index === 0 && options.caption) content.caption = options.caption;
        if (index === 0 && options.mentions?.length) content.mentions = options.mentions;
        sent.push(await sock.sendMessage(jid, content));
    }

    return { parent, items: sent };
}

module.exports = {
    sendImageAlbum,
};
