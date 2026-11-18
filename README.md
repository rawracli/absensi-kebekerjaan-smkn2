# Sistem Absensi Kehadiran - 9 Peserta

Aplikasi absensi real-time berbasis **Google Apps Script** dengan database
**Google Sheets**, penyimpanan foto di **Google Drive**, dan rekap harian
otomatis - teks **dan foto peserta** - ke **WhatsApp (Fonnte)**.

- Tanpa server tambahan, tanpa biaya hosting.
- Tanpa CDN / Google Fonts: seluruh CSS & JavaScript tertanam di `index.html`,
  sehingga hemat kuota dan tetap berfungsi di koneksi lambat.
- Seluruh keputusan waktu (buka/tutup, keterlambatan, tanggal) dihitung di
  server dengan zona waktu **Asia/Jakarta (WIB)**.

---

## 1. Isi Proyek

| File | Fungsi |
|---|---|
| `Code.gs` | Backend: setup, endpoint, validasi, Drive, closing harian, WhatsApp |
| `index.html` | Frontend satu halaman: form, kamera WebRTC, konfirmasi, bukti absensi |
| `appsscript.json` | Manifest: timezone `Asia/Jakarta`, scope OAuth, konfigurasi Web App |
| `README.md` | Panduan ini |

---

## 2. Aturan Bisnis

| Kondisi (waktu server WIB) | Status | Terlambat_Menit |
|---|---|---|
| Hadir, submit ≤ 08:00:00 | `Hadir` | `0` |
| Hadir, 08:00:00 < submit < 10:00:00 | `Hadir` | menit penuh sejak 08:00 |
| Izin / Sakit, submit < 10:00:00 | `Izin` / `Sakit` | `0` (tidak pernah dihitung) |
| Submit ≥ 10:00:00 | ditolak server | - |
| Belum mengisi sampai 10:00 | `Alpha` (oleh trigger) | `0` |

Aturan tambahan:

- **Satu peserta satu kali per hari.** Dicek di server di dalam `LockService`.
- **Wajib foto kamera langsung** untuk semua status (Hadir, Izin, Sakit).
- **Keterangan wajib** untuk Izin/Sakit (minimal 3 karakter), dan untuk **Hadir
  bila dikirim setelah 08:00:00 WIB** (alasan keterlambatan, minimal 3 karakter).
  Hadir pada atau sebelum 08:00:00 WIB tidak memerlukan keterangan (`-`).
- **Hari aktif** default Senin–Jumat (`HARI_AKTIF=1,2,3,4,5`). Pada hari tidak
  aktif form ditutup dan trigger 10:00 tidak menandai Alpha / mengirim laporan.
- Form dan pengiriman **ditutup otomatis** pada 10:00:00 WIB.
- Foto disimpan sebagai JPEG lebar maksimal 1280 px dengan nama
  `YYYY-MM-DD_NamaLengkap_Status.jpg` dan diberi watermark waktu server.
- Rekap 10:00 dikirim sebagai **teks link Drive** ke file XLSX (foto sudah
tertanam di dalam file). Bila pembuatan XLSX gagal, teks rekap dikirim
sebagai cadangan agar informasi tetap sampai. Teks panjang dan foto satuan
tetap dapat diminta lewat `KIRIM_TEKS_REKAP=ya` dan `KIRIM_FOTO_WA=ya`.
**Tab Daftar** pada halaman web menampilkan rekap 7 hari terakhir tanpa
perlu login: nama, status, jam, alasan, dan foto. Alasan hanya tampil bila
`PUBLIK_ALASAN=ya`.
- **`MODE_UJI=ya`** membuka form di luar hari/jam normal untuk pengujian. Setiap
  baris uji ditandai `[MODE UJI]` pada `Keterangan` dan `_UJI` pada nama file
  foto. Selama mode ini aktif, penutupan otomatis 10:00 dilewati.

---

## 3. Deployment (langkah demi langkah)

### 3.1 Siapkan Spreadsheet

1. Buka <https://sheets.new> dan beri nama misalnya **Absensi 9 Peserta**.
2. Buka menu **Extensions → Apps Script**.
3. Hapus isi `Code.gs` bawaan, lalu tempel seluruh isi `Code.gs` dari proyek ini.
4. Klik **+ → HTML** pada panel Files, beri nama `index`, lalu tempel seluruh
   isi `index.html` (nama file harus tepat `index`, ekstensi `.html` otomatis).
5. Aktifkan manifest: **Project Settings (ikon gerigi) → centang
   “Show appsscript.json manifest file in editor”**.
6. Buka `appsscript.json`, ganti seluruh isinya dengan file `appsscript.json`
   dari proyek ini.
7. Pastikan **Project Settings → Time zone** sudah
   `(GMT+07:00) Jakarta` (manifest juga sudah menyetelnya).
8. Simpan semua file (**Ctrl/Cmd + S**).

### 3.2 Jalankan Setup Sekali Klik

1. Pada dropdown fungsi di toolbar, pilih **`setupProject`**, lalu klik **Run**.
2. Saat diminta, klik **Review permissions → pilih akun → Allow**.
   Izin yang diminta: Sheets, Drive, trigger, dan permintaan HTTP eksternal.
3. Buka kembali Spreadsheet. Akan muncul:
   - Sheet **`Master_Peserta`** berisi `Peserta 1` … `Peserta 9`
   - Sheet **`Log_Absensi`** dengan 7 kolom
   - Sheet **`Konfigurasi`** dengan key bawaan
   - Folder Drive **`Foto Absensi <tahun>`**
   - Menu **Absensi** di spreadsheet (untuk script container-bound)

### 3.3 Isi Konfigurasi

Buka sheet **`Konfigurasi`** dan isi `Value`:

| Key | Contoh Value | Keterangan |
|---|---|---|
| `FOLDER_DRIVE_ID` | `1AbC...` | Terisi otomatis oleh `setupProject()` |
| `NO_WA_GURU` | `6281234567890` | Nomor WhatsApp guru penerima rekap |
| `FONNTE_TOKEN` | `xxxxxxxxxxxx` | Token perangkat dari dashboard Fonnte |
| `KIRIM_FOTO_WA` | `tidak` | `ya` kirim foto satuan lewat WhatsApp (memakai kuota Fonnte) |
| `KIRIM_TEKS_REKAP` | `tidak` | `ya` kirim teks rekap panjang (bawaan: hanya file XLSX) |
| `KIRIM_XLSX` | `ya` | `ya` kirim rekap sebagai teks link Drive (attachment tidak didukung) |
| `KOMPRES_FOTO` | `ya` | `ya` kecilkan foto sebelum disimpan ke Drive |
| `COMPRESSO_TOKEN` | `xxxx` | Token api.compresso.space bila `KOMPRES_FOTO=ya` |
| `PUBLIK_ALASAN` | `ya` | `ya` tampilkan alasan pada tab Daftar publik |
| `PUBLIK_FOTO` | `tidak` | `ya` tampilkan foto thumbnail pada tab Daftar publik |
| `TARGET_WA` | `nomor` | `nomor` kirim ke `NO_WA_GURU`, `grup` kirim ke `ID_GRUP_WA` |
| `ID_GRUP_WA` | `1203630...@g.us` | ID grup WhatsApp bila `TARGET_WA=grup` |
| `NAMA_GRUP_WA` | `Kelas Kebekerjaan LN` | Nama grup untuk label dan pemeriksaan tujuan |
| `MODE_UJI` | `tidak` | `ya` = form dibuka di luar hari/jam normal untuk pengujian |
| `HARI_AKTIF` | `1,2,3,4,5` | 1=Senin … 7=Minggu |
| `TANGGAL_LIBUR` | `2026-12-25,2027-01-01` | Opsional, lihat format di bawah |
| `MIGRASI_V2` | `selesai` | Penanda migrasi internal, jangan diubah manual |

> Saat kode versi baru pertama kali berjalan pada spreadsheet lama, `MIGRASI_V2`
menyetel kanal rekap sekali saja menjadi `KIRIM_XLSX=ya`, `KIRIM_TEKS_REKAP=tidak`,
`KIRIM_FOTO_WA=tidak`, `TARGET_WA=nomor`. Nilai yang Anda ubah setelah itu tidak
ditimpa lagi. Bila sebelumnya `KIRIM_FOTO_WA=ya`, setel ulang ke `ya` bila ingin
foto satuan ikut terkirim.

Jika proyek ini pernah memakai versi ber-Telegram, sheet mungkin masih
> menyimpan `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, dan `LAST_TELEGRAM_STATUS`.
> Kode baru tidak membacanya. Jalankan `hapusKonfigurasiTelegram()` sekali untuk
> membersihkannya.

Alternatif dari editor Apps Script:

```javascript
setupProject('6281234567890', 'TOKEN_FONNTE_ANDA');
// atau
setKonfigurasi('NO_WA_GURU', '6281234567890');
setKonfigurasi('FONNTE_TOKEN', 'TOKEN_FONNTE_ANDA');
```

Untuk mengubah satu nilai saja, `setKonfigurasi` sudah cukup. `setupProject` hanya
perlu dijalankan ulang bila ingin memperbaiki sheet, memasang ulang trigger, atau
mengganti folder Drive. Bila satu langkah gagal, pesan galatnya menyebut langkah
tersebut, misalnya `Langkah "pasang trigger harian" gagal: ...`.


Lalu uji koneksi WhatsApp:

```javascript
sendTestWA();
```

> Fonnte: pastikan perangkat sudah **connected** di dashboard, token masih
> aktif, dan kuota pesan mencukupi. Nomor tujuan boleh ditulis `08...` atau
> `62...`; sistem menormalkannya menjadi `62...` secara otomatis.

#### 3.3.1 Pengiriman rekap lewat WhatsApp

Bawaan produksi: **satu pesan teks berisi link Drive** ke file
`Absensi_YYYY-MM-DD.xlsx`. Foto setiap peserta sudah tertanam pada kolom
`Foto` di dalam file, jadi penerima cukup klik tautan untuk membuka file.

- File dibuat ulang setiap hari; file lama dengan nama sama dipindahkan ke
  sampah supaya folder tetap rapi.
- Bila gambar tidak ikut terekspor, kolom `Tautan Foto` ditambahkan otomatis
  sebagai cadangan.
- Bila pembuatan file gagal, teks rekap dikirim sebagai cadangan.
- Fonnte mengambil file lewat tautan unduh langsung Drive, bukan halaman
  pratinjau.

`KIRIM_TEKS_REKAP=ya` menambahkan teks rekap panjang sebelum file, dan
`KIRIM_FOTO_WA=ya` mengirim foto asli satu per satu dengan caption
`Nama - Status - jam WIB`. Setiap foto memakai **satu kuota pesan Fonnte**;
untuk 9 peserta sediakan kuota minimal 10 pesan per hari bila opsi ini aktif.
Kegagalan pengiriman dicatat pada `LAST_WA_STATUS`, dan foto tetap dapat
dibuka lewat tautan Drive.
Periksa hasilnya tanpa mengubah data:

```javascript
ujiBuatXlsx()         // buat file XLSX hari ini, cetak tautannya
ujiKirimRekap()       // kirim rekap WhatsApp hari ini
cekKuotaCompresso()   // sisa kuota kompresi foto
validasiTargetWA()    // pastikan tujuan WhatsApp sudah benar
```

#### 3.3.2 Format `TANGGAL_LIBUR`

Isi boleh longgar; sistem menormalkannya sendiri. Pemisah: koma, titik koma,
atau spasi.

| Yang ditulis | Terbaca sebagai |
|---|---|
| `2026-12-25` | 25 Desember 2026 |
| `2026-12-25, 2027-01-01` | dua tanggal |
| `2026-12-5` | 5 Desember 2026 (nol di depan opsional) |
| `25/12/2026` atau `25-12-2026` | 25 Desember 2026 |
| `20261225` | 25 Desember 2026 |

Catatan:

- Sabtu/Minggu tidak perlu didaftarkan bila `HARI_AKTIF=1,2,3,4,5`; keduanya
  sudah otomatis tutup.
- Format yang tidak dikenali **diabaikan**, tidak membuat sistem error.
- Setelah mengubah, jalankan `diagnosaSistem()` dan periksa
  `tanggalLiburTerbaca` untuk memastikan tanggal sudah terbaca benar.

#### 3.3.3 Menguji di luar jam absensi (`MODE_UJI`)

Bila perlu mencoba setelah pukul 10:00 atau pada hari libur:

1. Set `MODE_UJI` = `ya` pada sheet `Konfigurasi`.
2. Muat ulang halaman web. Akan muncul banner kuning **MODE UJI AKTIF** dan
   form dapat diisi seperti biasa.
3. Setiap kiriman uji ditandai:
   - `Keterangan` berawalan `[MODE UJI]`
   - nama file foto berakhiran `_UJI.jpg`
4. Untuk menguji pengiriman laporan + foto, jalankan `ujiKirimRekap()`. Fungsi
   ini **tidak** menulis baris `Alpha` dan **tidak** menandai laporan sebagai
   terkirim.
5. Setelah selesai, ubah `MODE_UJI` = `tidak`. Hapus baris uji di
   `Log_Absensi` dan file `*_UJI.jpg` di Drive bila tidak diperlukan.

> Selama `MODE_UJI=ya`, penutupan otomatis pukul 10:00 sengaja dilewati agar
> pengujian tidak menulis `Alpha` palsu. Untuk menguji penutupan penuh, matikan
> `MODE_UJI` lalu jalankan `manualCloseToday()`.

### 3.4 Ganti Nama Peserta

Buka sheet **`Master_Peserta`**, ganti `Peserta 1` … `Peserta 9` dengan nama
sebenarnya. Jumlah baris boleh lebih/kurang dari 9 - sistem mengikuti isi
sheet. **Jangan mengubah nama header.**

### 3.5 Deploy Web App

1. Di editor Apps Script klik **Deploy → New deployment**.
2. Ikon gerigi → pilih **Web app**.
3. Isi:
   - **Description**: `Absensi v1`
   - **Execute as**: `Me (email Anda)`
   - **Who has access**: `Anyone`
4. Klik **Deploy**, lalu salin **Web app URL** (berakhiran `/exec`).
5. Buka URL tersebut di HP.

> **Penting soal izin kamera.** Apps Script menampilkan halaman Anda di dalam
> iframe, dan iframe itu tidak mengizinkan kamera. Akibatnya browser menolak
> `getUserMedia` **sebelum** sempat menampilkan prompt izin - tombol
> “Aktifkan Kamera” langsung gagal meski izin situs belum pernah ditolak.
> Ini tidak bisa diperbaiki dari JavaScript. Untuk memunculkan prompt izin,
> halaman harus dibuka sebagai dokumen utama lewat HTTPS (bagian 5).

> Setiap kali `Code.gs` atau `index.html` diubah, buka
> **Deploy → Manage deployments → ikon pensil → Version: New version → Deploy**
> agar perubahan dipakai oleh URL yang sudah dibagikan.

### 3.6 Verifikasi Trigger Harian

1. Di editor Apps Script buka **Triggers** (ikon jam).
2. Pastikan ada satu trigger:
   - Fungsi: `processDailyClosingAndSendWA`
   - Event: **Time-driven → Day timer → 10am to 11am**
   - Timezone: `Asia/Jakarta`
3. Trigger akan berjalan sekali sehari. Google dapat menjalankannya beberapa
   menit setelah pukul 10:00 - ini normal dan tidak memengaruhi validasi,
   karena pengiriman sudah ditolak server sejak 10:00:00.

---

## 4. Fungsi Operasional (jalankan dari editor Apps Script)

| Fungsi | Kegunaan |
|---|---|
| `setupProject()` | Membuat/memperbaiki sheet, folder Drive, dan trigger |
| `diagnosaSistem()` | Ringkasan kondisi sheet, folder, trigger, dan konfigurasi |
| `sendTestWA()` | Kirim pesan uji ke nomor guru |
| `ujiKirimRekap()` | Kirim rekap + foto hari ini tanpa mengubah data (aman untuk uji) |
| `previewLaporanHariIni()` | Lihat teks rekap hari ini tanpa mengirim apa pun |
| `manualCloseToday()` | Jalankan penutupan hari ini sekarang (idempotent) |
| `resendWhatsAppReport()` | Paksa kirim ulang rekap WhatsApp hari ini |
| `setKonfigurasi(key, value)` | Ubah satu nilai konfigurasi |
| `lihatKonfigurasi()` | Tampilkan seluruh konfigurasi di log |
| `hapusKonfigurasiTelegram()` | Hapus sisa baris konfigurasi Telegram dari versi lama |
| `perbaikiTanggalLog()` | Rapikan kolom `Tanggal` yang terbaca sebagai Date |
| `ujiBuatXlsx()` | Buat file XLSX hari ini tanpa mengirim ke siapa pun |
| `cekKuotaCompresso()` | Tampilkan sisa kuota layanan kompresi foto |
| `validasiTargetWA()` | Tampilkan tujuan WhatsApp aktif tanpa mengirim |

Menu **Absensi** di spreadsheet menyediakan akses cepat ke fungsi-fungsi di atas.

---

## 5. Kamera: Mengapa Prompt Izin Tidak Muncul, dan Solusinya

**Gejala.** Menekan **Aktifkan Kamera** langsung gagal. Browser tidak pernah
menampilkan pertanyaan “Izinkan kamera?”. Ikon gembok di address bar juga tidak
punya pengaturan kamera untuk situs ini.

**Penyebab.** Apps Script tidak menyajikan `index.html` sebagai dokumen utama.
Halaman Anda berjalan di dalam iframe (`...googleusercontent.com`) yang
ditanamkan oleh `script.google.com`. Iframe itu tidak membawa delegasi izin
`camera` pada `Permissions-Policy`, sehingga `getUserMedia()` ditolak dengan
`NotAllowedError` **sebelum** tahap permintaan izin. Tidak ada API JavaScript
yang bisa memaksa prompt muncul dari dalam iframe, dan `sandbox`/header iframe
tersebut milik Google - tidak dapat diubah dari kode Anda.

**Solusi.** Sajikan file yang sama sebagai halaman HTTPS mandiri (top-level).
Prompt izin baru akan muncul di sana.

1. Deploy Web App seperti langkah 3.5 (akses **Anyone**), salin URL `/exec`.
2. Host `index.html` di layanan statis HTTPS apa pun. Yang paling ringan tanpa
   akun dan tanpa perkakas tambahan: **Netlify Drop** (`app.netlify.com/drop`) -
   cukup seret satu file `index.html` (±70 KB) ke halaman itu.
3. Pada salinan `index.html` yang akan di-hosting, isi `WEB_APP_URL` di bagian
   paling atas `<script>`:

   ```javascript
   const APP_CONFIG = {
     WEB_APP_URL: 'https://script.google.com/macros/s/AKfycb.../exec',
     STANDALONE_URL: ''
   };
   ```

4. Unggah, lalu buka URL hosting tersebut di HP. Prompt izin kamera muncul di
   kunjungan pertama.
5. Opsional: isi `STANDALONE_URL` pada `index.html` **yang dipakai Apps Script**
   dengan URL hosting langkah 4. Bila kamera gagal di iframe, muncul tombol
   **Buka Versi Kamera** yang membuka halaman mandiri di tab baru.

Cara kerja jalur statis:

- Frontend mendeteksi `google.script.run`. Bila tidak ada, ia memakai HTTP:
  - `GET  <WEB_APP_URL>?api=1` untuk data awal,
  - `POST <WEB_APP_URL>` dengan `Content-Type: text/plain` untuk submit
    (menghindari preflight CORS yang tidak didukung Apps Script).
- Semua validasi tetap di server. Tidak ada logika waktu di browser yang
  dipercaya.

> Halaman statis wajib **HTTPS** (`https://` atau `localhost`); alamat `http://`
> biasa juga diblokir browser untuk kamera.
> Bila jaringan sekolah memblokir permintaan lintas-origin ke
> `script.google.com`, gunakan halaman yang disajikan langsung oleh Apps Script
> (jalur utama) - dengan konsekuensi kamera tidak dapat dipakai.
> URL `/exec` **tidak** bisa dipakai sebagai pengganti hosting statis: membukanya
> di tab baru tetap menghasilkan iframe yang sama.

---

## 6. Skema Database

### `Master_Peserta`

| No | Nama_Lengkap |
|---|---|
| 1 | Peserta 1 |
| … | … |

### `Log_Absensi`

| Timestamp | Tanggal | Nama_Lengkap | Status | Terlambat_Menit | Keterangan | Link_Foto_Drive |
|---|---|---|---|---|---|---|
| `2026-11-18 07:42:10` | `2026-11-18` | Budi | Hadir | 0 | `-` | `https://drive.google.com/...` |

- `Tanggal` selalu `YYYY-MM-DD` WIB dan disimpan sebagai **teks**
(format sel `@`) agar Sheets tidak mengubahnya menjadi nilai Date.
- `Status` ∈ `Hadir`, `Izin`, `Sakit`, `Alpha`.
- Baris `Alpha` dibuat oleh trigger dengan `Keterangan` =
  `Tidak mengisi absensi hingga pukul 10:00` dan link `-`.

### `Konfigurasi`

Tabel key-value (`Key` | `Value`) seperti pada bagian 3.3, ditambah jejak audit:

| Key | Isi |
|---|---|
| `LAST_CLOSING_DATE` | Tanggal terakhir penutupan dijalankan |
| `LAST_WA_SENT_DATE` | Tanggal terakhir rekap berhasil dikirim lewat WhatsApp |
| `LAST_REPORT_SENT_DATE` | Tanggal terakhir rekap berhasil dikirim |
| `LAST_WA_STATUS` | `TERKIRIM ...`, `GAGAL ... - alasan`, atau `LEWAT ...` |

---

## 7. Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| **Prompt izin kamera tidak muncul, “Aktifkan Kamera” langsung gagal** | Normal bila halaman dibuka dari URL `/exec`. Iframe Apps Script tidak boleh memakai kamera, jadi browser menolak sebelum sempat bertanya. Pakai hosting statis HTTPS (bagian 5). |
| **“Akses kamera ditolak” di halaman hosting statis** | Izin pernah diblokir untuk origin tersebut. Buka ikon gembok → Kamera → **Izinkan** → muat ulang. Pastikan alamat berawalan `https://`. |
| **Kamera hitam / “sedang digunakan aplikasi lain”** | Tutup aplikasi kamera/meeting lain, lalu tekan **Coba Lagi**. |
| **“Hari ini bukan hari absensi”** | `HARI_AKTIF` di `Konfigurasi` tidak memuat hari ini. Isi `1,2,3,4,5,6,7` untuk membuka setiap hari. |
| **“Absensi sudah ditutup”** | Waktu server ≥ 10:00:00 WIB. Ini by design. Cek jam di header (bersumber dari server, bukan HP). Untuk pengujian, set `MODE_UJI=ya`. |
| **Ingin menguji setelah pukul 10:00** | Set `MODE_UJI=ya`, muat ulang halaman, kirim absensi uji (ditandai `[MODE UJI]`), lalu `ujiKirimRekap()` untuk menguji laporan + foto. Kembalikan ke `tidak` setelah selesai. |
| **“Hari ini bukan hari absensi” padahal seharusnya masuk** | Cek `HARI_AKTIF`. Bila tanggal ada di `TANGGAL_LIBUR`, jalankan `diagnosaSistem()` dan lihat `tanggalLiburTerbaca`. |
| **“Nama sudah tercatat hari ini”** | Anti-duplikasi. Satu nama hanya boleh sekali per tanggal. |
| **Foto tersimpan tapi tautan tidak publik** | Kebijakan berbagi Google Workspace membatasi `ANYONE_WITH_LINK`. Absensi tetap tercatat; minta admin domain mengizinkan link sharing, atau buka foto dengan akun yang berhak. |
| **WA tidak terkirim** | Periksa `LAST_WA_STATUS`. Penyebab umum: token salah, perangkat Fonnte offline, kuota habis, nomor tujuan bukan format `62...`. Uji dengan `sendTestWA()`. |
| **Foto tidak ikut di WhatsApp** | `KIRIM_FOTO_WA` masih `tidak`, atau tidak ada foto pada tanggal itu. Set `ya` lalu jalankan `ujiKirimRekap()`. Setiap foto memakai kuota pesan Fonnte. |
| **Teks rekap masuk, foto tidak** | Periksa `LAST_WA_STATUS` (bagian foto). Penyebab umum: kuota Fonnte habis di tengah pengiriman, atau tautan foto tidak dapat diunduh Fonnte karena kebijakan sharing Drive. Teks dan tautan tetap terkirim. |
| **Trigger tidak jalan** | Buka **Triggers**, pastikan hanya ada satu trigger `processDailyClosingAndSendWA`, timezone `Asia/Jakarta`. Jalankan `setupProject()` untuk memasang ulang. Cek **Executions** untuk error. |
| **Rekap tidak masuk padahal trigger jalan** | `LAST_WA_SENT_DATE` sudah bernilai hari ini (pernah terkirim). Gunakan `resendWhatsAppReport()`. |
| **Perubahan kode tidak muncul di URL** | Deploy ulang: **Manage deployments → Edit → New version → Deploy**. |
| **Tanggal/jam di sheet tidak sesuai WIB** | Jalankan `setupProject()`; fungsi ini menyetel timezone spreadsheet ke `Asia/Jakarta`. |
| **"Spreadsheet belum terhubung"** | Script standalone tanpa database. Jalankan `setupProject()`; spreadsheet baru dibuat otomatis dan ID-nya disimpan di Script Properties. Bila ID lama sudah ada tetapi tidak bisa dibuka, `setupProject` berhenti dengan pesan yang menyebut ID tersebut dan tidak membuat database kedua. |

---

## 8. Catatan Keamanan & Privasi

- **Tanpa login peserta.** Siapa pun yang memiliki tautan dapat memilih nama
  mana pun. Bukti yang tersedia: foto kamera langsung, watermark waktu server,
  dan batas 10:00 WIB. Bila perlu verifikasi identitas, tambahkan PIN pada
  `Master_Peserta` dan validasi di `submitAttendance()`.
- **Foto bersifat publik-baca** (`ANYONE_WITH_LINK / VIEW`) agar tautan bisa
  dibuka dari WhatsApp dan diunduh Fonnte sebelum dikirim sebagai gambar.
  Jangan menyimpan dokumen sensitif di folder ini.
- **Token Fonnte tidak pernah dikirim ke browser.** Frontend hanya menerima
  penanda boolean pada `reportConfigured` dan `photoDelivery`.
- **Pesan error ke pengguna sudah disaring**; detail teknis hanya masuk log
  eksekusi Apps Script.
- **Rate/duplikasi:** seluruh penulisan dibungkus `LockService`, sehingga dua
  permintaan bersamaan tidak dapat membuat baris ganda.

---

## 9. Checklist Uji Sebelum Dipakai

1. `setupProject()` berhasil, 3 sheet + folder Drive terbentuk.
2. `sendTestWA()` masuk ke WhatsApp guru.
3. Buka URL Web App `/exec` di HP → pilih nama → **Aktifkan Kamera**. Bila
   tombol langsung gagal tanpa prompt izin, itu memang perilaku iframe Apps
   Script - lanjut ke langkah 4.
4. Buka versi hosting statis (bagian 5) di HP → prompt **Izinkan kamera** muncul
   → **Ambil Foto** → **Putar Kamera** → **Foto Ulang** → **Ambil Foto** lagi.
5. Kirim absensi `Hadir` → muncul kartu bukti dengan jam dan status.
6. Coba kirim lagi dengan nama yang sama → ditolak “sudah tercatat”.
7. Batalkan izin kamera pada halaman statis → muncul pesan yang jelas dan kotak
   bantuan, bukan layar putih.
8. Ubah `HARI_AKTIF` ke hari ini → form muncul; ubah ke hari lain → layar
   “bukan hari absensi”.
9. Set jam sistem HP beberapa jam ke depan → countdown & validasi tetap
   mengikuti jam server.
10. Jalankan `ujiBuatXlsx()` muncul tautan file; buka file dan pastikan
    foto tiap peserta tertanam. Jalankan `ujiKirimRekap()` rekap masuk
    sebagai satu pesan berisi file XLSX, tanpa mengubah `Log_Absensi`.
11. Set `MODE_UJI=ya` → banner kuning muncul, absensi dapat dikirim setelah
    pukul 10:00, baris ditandai `[MODE UJI]`. Kembalikan ke `tidak`.
12. Jalankan `manualCloseToday()` → peserta yang belum mengisi menjadi `Alpha`
    dan rekap terkirim.
13. Buka sheet `Log_Absensi`: kolom `Tanggal` terbaca `YYYY-MM-DD` dengan
    jenis sel **teks**, `Terlambat_Menit` sesuai hitungan, link foto dapat
    dibuka.
14. Buka tab **Daftar** pada halaman web: rentang tanggal 7 hari, pilih
    tanggal lain, tab kembali ke **Absensi** tanpa kehilangan isian.
15. Buka tab **Daftar** pada ponsel: tidak ada geser mendatar, tombol dan
    pemilih tanggal nyaman disentuh.

---

## 10. Batasan yang Diketahui

- **Kamera tidak dapat dipakai di URL `/exec`.** Iframe Apps Script memblokir
  `getUserMedia` tanpa prompt izin; ini batasan platform, bukan bug aplikasi.
  Kamera hanya aktif di halaman HTTPS mandiri (bagian 5).
- Jalur statis bergantung pada permintaan lintas-origin ke `script.google.com`.
  Bila jaringan sekolah memblokirnya, form tidak dapat memuat data.
- Rekap WA dikirim setelah trigger berjalan; Google dapat memundurkannya
  beberapa menit dari 10:00. Validasi pengiriman tetap tegas pada 10:00:00.
- Nama peserta yang diubah setelah ada log historis tidak mengubah baris lama;
  laporan harian selalu mengikuti nama yang ada di `Master_Peserta` saat itu.
- Foto yang gagal diunggah tidak menyimpan absensi (ditolak dengan pesan jelas)
  agar setiap baris selalu memiliki bukti visual.
- Bila `setSharing` diblokir kebijakan domain, tautan Drive tetap dicatat dan
  pengguna menerima peringatan pada kartu bukti. Foto mungkin juga gagal
  diunduh Fonnte, sehingga hanya teks rekap yang sampai.
- Mengirim foto lewat WhatsApp memakai **satu kuota Fonnte per foto**. Untuk 9
  peserta, sediakan minimal 10 pesan per hari. Set `KIRIM_FOTO_WA=tidak` bila
  ingin hanya mengirim teks tautan. Sejak rekap bawaan berupa XLSX, opsi ini
hanya perlu bila teks dan foto satuan juga diminta.
- `ujiKirimRekap()` bersifat *read-only* terhadap data: baris `Alpha` pada
  laporannya hanya perhitungan, bukan catatan baru.
Pembuatan XLSX memakai endpoint ekspor Google, jadi memerlukan scope
`spreadsheets` dan `drive` yang sudah ada di `appsscript.json`. Spreadsheet
sementara dibuat di Drive lalu dipindahkan ke sampah setelah file jadi; bila
proses gagal, file sementara bisa tertinggal dan dapat dihapus manual.
Tab **Daftar** menyimpan hasil 20 detik pada cache agar hemat kuota Apps
Script, jadi data terbaru muncul paling lambat 20 detik setelah absensi
dikirim. Tab ini publik dan hanya menampilkan nama, status, jam, alasan, dan
foto, bukan token atau nomor WhatsApp.
Kompresi foto bergantung pada layanan pihak ketiga (`api.compresso.space`).
Bila token kosong atau kuota habis, foto asli yang lebih besar tetap dipakai
dan absensi tidak pernah gagal karena kompresi.

