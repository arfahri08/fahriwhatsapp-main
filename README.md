<div align="center">

<img src="https://readme-typing-svg.demolab.com?font=Space+Grotesk&weight=700&size=34&duration=2800&pause=900&color=25D366&center=true&vCenter=true&width=760&lines=ANTONIUS+FAHRI;WhatsApp+Automation+%7C+Node.js;Build.+Automate.+Stay+Human." alt="Animasi nama Antonius Fahri" />

### WhatsApp automation toolkit yang modular, aman, dan siap dijalankan di Termux

<a href="https://instagram.com/antoniusfahri"><img src="https://img.shields.io/badge/Instagram-@antoniusfahri-E4405F?style=for-the-badge&logo=instagram&logoColor=white" alt="Instagram Antonius Fahri" /></a>
<a href="https://www.linkedin.com/in/a-rachman-fahri-9998443b8"><img src="https://img.shields.io/badge/LinkedIn-A.%20Rachman%20Fahri-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white" alt="LinkedIn A. Rachman Fahri" /></a>
<a href="https://github.com/arfahri08"><img src="https://img.shields.io/badge/GitHub-arfahri08-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub arfahri08" /></a>

<br />

<a href="https://github.com/arfahri08/fahriwhatsapp-main/stargazers"><img src="https://img.shields.io/github/stars/arfahri08/fahriwhatsapp-main?style=for-the-badge&logo=github&label=Stars&color=gold&cacheSeconds=300" alt="GitHub stars" /></a>
<a href="https://github.com/arfahri08/fahriwhatsapp-main/network/members"><img src="https://img.shields.io/github/forks/arfahri08/fahriwhatsapp-main?style=for-the-badge&logo=github&label=Forks&color=blue&cacheSeconds=300" alt="GitHub forks" /></a>
<a href="https://github.com/arfahri08/fahriwhatsapp-main/issues"><img src="https://img.shields.io/github/issues/arfahri08/fahriwhatsapp-main?style=for-the-badge&logo=github&label=Issues&color=orange&cacheSeconds=300" alt="GitHub issues" /></a>
<a href="https://github.com/arfahri08/fahriwhatsapp-main/watchers"><img src="https://img.shields.io/github/watchers/arfahri08/fahriwhatsapp-main?style=for-the-badge&logo=github&label=Watchers&color=brightgreen&cacheSeconds=300" alt="GitHub watchers" /></a>

![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![Baileys](https://img.shields.io/badge/WhatsApp-Baileys%207-25D366?style=flat-square&logo=whatsapp&logoColor=white)
![License](https://img.shields.io/badge/license-private%20project-555?style=flat-square)

</div>

## Tentang proyek

`fahriwhatsapp-main` adalah userbot WhatsApp berbasis Node.js dengan arsitektur modular. Fitur disusun sebagai modul terpisah agar mudah dirawat, diuji, dan dinonaktifkan sesuai kebutuhan.

## Fitur unggulan

<table>
<tr>
<td width="50%">

### 🤖 Smart automation

- Auto-reply privat dengan quoted bubble dan nama personal.
- Custom reply, keyword reply, link detector, serta menu `.help` interaktif.
- Reminder kontak berbasis contact card dan scheduler.
- Reconnect otomatis, health check, source watchdog, dan session repair.

</td>
<td width="50%">

### 🛡️ Moderasi & keamanan

- Anti-toxic, safe words, reflection profile, warning, anti-spam, dan slowmode.
- Sticker Safety dengan OCR, NSFW scoring, warmup model, dan cache control.
- Edited Message Guardian, Anti-Delete, View Once security log, dan media audit.
- Blocklist, permission policy, command rate limit, serta owner/admin authorization.

</td>
</tr>
<tr>
<td width="50%">

### 👥 Group command suite

- `.gcopen`, `.gcclose`, `.gcschedule`, `.setnamegc`, `.setdeskgc`, dan `.setppgc`.
- `.tagall`, `.hidetag`, `.poll`, `.pin`, `.adminlist`, `.groupinfo`, serta `.rules`.
- Welcome/goodbye menu, kick sticker, attendance, group utility, dan feature toggle.
- Mini games: quiz, tebak angka, suit, truth, dare, coinflip, dan roll.

</td>
<td width="50%">

### 📥 Media & downloader

- Downloader Spotify, TikTok, Instagram, Threads, YouTube, Facebook, Pinterest, dan SoundCloud.
- Convert gambar/video ke sticker, image-to-PDF, upload media ke URL, dan QR art.
- Voice note/text-to-speech, audio transcription, Telegram sticker, status, serta View Once.
- Album media, local downloader, cleanup media, dan kontrol media berbasis scope.

</td>
</tr>
<tr>
<td width="50%">

### 🛒 Store & wallet

- Etalase produk melalui `.shop` atau `.store`.
- Checkout `.beli`, status pesanan, saldo, deposit, dan riwayat saldo.
- Owner tools untuk produk, stok, order fulfillment, deposit approval, dan saldo customer.
- Dukungan delivery digital dengan validasi transaksi dan idempotency.

</td>
<td width="50%">

### ⚡ Owner toolkit

- Broadcast terkontrol dengan status, retry, delay, blacklist, dan whitelist.
- Push kontak, backup, reaction workflow, status broadcast, serta notifikasi aktif.
- Jadibot manager, private agent, web-to-zip, WhatsApp inspect, dan safe mockup tools.
- Konfigurasi runtime melalui `.settings`, diagnostics, serta research lab terbatas owner.

</td>
</tr>
</table>

### Contoh command

```text
.help                         # Menu lengkap fitur
.stikerguard scan             # Scan sticker dengan OCR dan NSFW guard
.welcome menu on              # Aktifkan menu interaktif grup
.poll multi Pertanyaan? | A, B, C
.shop                         # Lihat katalog produk
.status                       # Status bot dan koneksi
```

> Gunakan bot hanya pada akun dan grup yang Anda miliki atau yang memberi izin. Hormati Terms of Service WhatsApp, privasi pengguna, dan hukum setempat.

## Persyaratan

- Node.js `20` atau lebih baru dan npm.
- Akun WhatsApp khusus bot sangat disarankan.
- Untuk fitur tertentu: `ffmpeg`, `tesseract`, dan build tools native seperti `python`, `make`, serta `g++`.
- Ruang penyimpanan memadai untuk model AI, cache, dan media sementara.

## Instalasi di Termux

```bash
pkg update && pkg upgrade
pkg install nodejs-lts git python make clang ffmpeg tesseract
git clone https://github.com/arfahri08/fahriwhatsapp-main.git
cd fahriwhatsapp-main
npm install
```

Siapkan konfigurasi lokal sebelum menjalankan:

```bash
cp .env.example .env
nano .env
npm start
```

Jika `.env.example` belum tersedia pada branch yang digunakan, buat `.env` secara manual dan isi minimal:

```dotenv
OWNER_JID=628xxxxxxxxxx@s.whatsapp.net
```

Scan QR dari terminal atau gunakan alur pairing yang tersedia. Folder `auth/` akan dibuat otomatis dan **tidak boleh diunggah**.

## Instalasi di Linux, macOS, atau Windows

1. Install Node.js `20+` dari [nodejs.org](https://nodejs.org/), lalu pastikan `node --version` dan `npm --version` berjalan.
2. Clone repository dan masuk ke folder proyek.
3. Jalankan `npm install`.
4. Buat `.env` dari contoh konfigurasi, lalu sesuaikan nomor owner dan opsi runtime.
5. Jalankan `npm start`.

Windows dapat memakai PowerShell atau WSL. Fitur yang membutuhkan binary eksternal mungkin memerlukan instalasi `ffmpeg` dan `tesseract` terpisah.

## Menjalankan sebagai service dengan PM2

```bash
npm install --global pm2
pm2 start ecosystem.config.cjs --update-env
pm2 save
pm2 startup
```

Perintah praktis:

```bash
npm run pm2:watch
pm2 logs a
pm2 restart a --update-env
pm2 stop a
```

## Konfigurasi penting

Semua nilai rahasia harus berada di `.env`, bukan di source code. Contoh variabel yang didukung antara lain:

| Variabel | Kegunaan |
| --- | --- |
| `OWNER_JID` | JID owner yang berwenang menjalankan command administratif. |
| `ACTIVE_NOTIFY_JIDS` | Target notifikasi aktif, bila digunakan. |
| `ANTI_TOXIC_DEBUG` | Mengaktifkan log debug anti-toxic saat troubleshooting. |
| `WA_GROUP_WARMUP` | Mengatur warm-up metadata grup. |
| `WA_RECONNECT_MIN_DELAY_MS` | Jeda minimum reconnect. |
| `WA_RECONNECT_MAX_DELAY_MS` | Jeda maksimum reconnect. |
| `INCOMING_MEDIA_LOGGER_ENABLED` | Mengatur pencatatan intake media. |

Nilai, nama command, dan default dapat berubah mengikuti implementasi di `index.js` dan folder `modules/`. Jangan menyalin credential dari perangkat lain ke repository.

## Command dasar

Kirim `.help` dari chat yang diizinkan untuk melihat katalog command yang aktif. Beberapa contoh:

```text
.reply on
.reply off
.reply status
.renungan list
.renungan status 628xxxxxxxxxx
```

Command administratif dan fitur grup dapat dibatasi oleh owner, admin grup, policy grup, atau scope privat. Periksa `.help` pada versi yang sedang dijalankan sebelum mengandalkan command tertentu.

## Pengujian

Test yang tersedia dijalankan langsung dengan Node.js:

```bash
npm run test:source-watch
npm run test:auto-reply-scope
npm run test:call-first-voice
npm run test:rate-limit
npm run test:viewonce-sender
```

Test tambahan dapat ditemukan di `scripts/test-*.js`. Beberapa test bersifat lokal dan tidak memerlukan koneksi WhatsApp.

## Checklist keamanan sebelum commit dan push

- [ ] Pastikan `.env`, `auth/`, session, database, media, cache, log, dan corpus privat tidak ikut staged.
- [ ] Ganti semua nomor contoh, JID owner, URL callback, dan path lokal.
- [ ] Jalankan `git status --short` dan `git diff --cached --name-only` sebelum commit.
- [ ] Audit file yang pernah tracked; `.gitignore` tidak menghapus tracking lama secara otomatis.
- [ ] Bila credential pernah ter-commit, revoke/rotate credential tersebut dan bersihkan riwayat Git dengan prosedur yang tepat.
- [ ] Jangan menjalankan bot memakai akun utama sebelum memahami risiko spam, logout, dan pembatasan akun.

Untuk memeriksa kandidat file sensitif sebelum staging:

```bash
git status --short
git ls-files | grep -Ei '(^|/)(auth|session|sessions|\.env|data/(media|agentprivate)|.*\.(db|sqlite|jsonl|log))'
```

## Struktur ringkas

```text
.
├── index.js                 # Entry point bot
├── modules/                 # Fitur dan service modular
├── scripts/                 # Setup, utility, dan test lokal
├── data/                    # Config/runtime lokal; audit sebelum push
├── ecosystem.config.cjs     # Konfigurasi PM2
├── package.json             # Dependency dan command npm
└── .env                     # Rahasia lokal, jangan di-commit
```

## Lisensi dan penggunaan

Repository ini dipublikasikan untuk kebutuhan pengembangan dan eksperimen. Tinjau lisensi dependency pihak ketiga serta kebijakan penggunaan WhatsApp sebelum mendistribusikan atau mengoperasikan bot dalam skala besar.

<div align="center">

**Built by Antonius Fahri**

<a href="https://instagram.com/antoniusfahri">Instagram</a> · <a href="https://www.linkedin.com/in/a-rachman-fahri-9998443b8">LinkedIn</a> · <a href="https://github.com/arfahri08">GitHub</a>

</div>