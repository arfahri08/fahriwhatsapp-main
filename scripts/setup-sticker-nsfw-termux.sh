#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

cd "${HOME}/fahriwhatsapp-main"

echo "== Memasang ImageMagick =="
pkg install -y imagemagick

echo "== Memasang ONNX Runtime Web =="
npm install onnxruntime-web@1.27.0 --save --ignore-scripts --no-audit --no-fund

echo "== Validasi file dan model =="
command -v magick >/dev/null 2>&1 || {
  echo "ERROR: command magick tidak ditemukan setelah instalasi ImageMagick." >&2
  exit 1
}

test -s data/models/nudenet/320n.onnx || {
  echo "ERROR: data/models/nudenet/320n.onnx belum ada. Jalankan installer Windows terbaru dan git pull." >&2
  exit 1
}

test -s data/models/AdamCodd/vit-base-nsfw-detector/onnx/model_quantized.onnx || {
  echo "ERROR: model ViT NSFW lokal tidak ditemukan." >&2
  exit 1
}

node --check modules/stickerSafetyGuard.js
node --check modules/localNsfwVision.js
node scripts/test-local-nsfw-vision.js
node scripts/test-local-nsfw-vision.js --smoke-model

echo "== Membersihkan cache guard lama =="
rm -f data/sticker-safety-cache/results.json
mkdir -p data/sticker-safety-cache
printf '{}\n' > data/sticker-safety-cache/results.json

echo "== Restart PM2 =="
pm2 restart a --update-env

echo ""
echo "SETUP SELESAI"
echo "Di WhatsApp kirim:"
echo "  .stikerguard clearcache"
echo "  .stikerguard warmup"
echo "Lalu reply stiker dan kirim: .guardscan"
