# Absensi Kehadiran - Google Apps Script

Aplikasi absensi peserta berbasis **Google Apps Script**, dengan database
**Google Sheets**, foto di **Google Drive**, dan rekap harian otomatis ke
**WhatsApp (Fonnte)**.

Cocok untuk kelas, pelatihan, atau kegiatan rutin berskala kecil. Tidak perlu
server sendiri dan tidak ada biaya hosting: seluruh aplikasi berjalan di
infrastruktur Google.

**Fitur utama**

- Absensi mandiri lewat browser HP: pilih nama, pilih status, ambil foto.
- Status **Hadir / Izin / Sakit**. Peserta yang tidak mengisi sampai batas
  waktu otomatis dicatat **Alpha**.
- Foto wajib dari kamera langsung, dengan watermark waktu server.
- Validasi lokasi untuk status **Hadir** (geofence radius sekolah).
- Satu peserta hanya boleh mengisi sekali per hari, dicek di server.
- Rekap harian otomatis ke WhatsApp: ringkasan + tautan file XLSX.
- Tab **Daftar** publik berisi rekap beberapa hari terakhir, tanpa login.
- Seluruh keputusan waktu memakai zona **Asia/Jakarta (WIB)** di server,
  bukan jam HP peserta.

---

## Daftar Isi

1. [Persyaratan](#1-persyaratan)
2. [Struktur Proyek](#2-struktur-proyek)
3. [Mulai Cepat](#3-mulai-cepat)
4. [Pemasangan dari Nol](#4-pemasangan-dari-nol)
5. [Konfigurasi](#5-konfigurasi)
6. [Aturan Absensi](#6-aturan-absensi)
7. [Fungsi Admin](#7-fungsi-admin)
8. [Rekap Harian dan WhatsApp](#8-rekap-harian-dan-whatsapp)
9. [Tab Daftar Publik](#9-tab-daftar-publik)
10. [Skema Database](#10-skema-database)
11. [Troubleshooting](#11-troubleshooting)
12. [Keamanan dan Privasi](#12-keamanan-dan-privasi)
13. [Checklist Uji Sebelum Produksi](#13-checklist-uji-sebelum-produksi)
14. [Batasan yang Diketahui](#14-batasan-yang-diketahui)

---

## 1. Persyaratan

| Kebutuhan | Keterangan |
|---|---|
| Akun Google | Untuk Spreadsheet, Drive, dan Apps Script |
| Spreadsheet Google | Dibuat otomatis oleh `setupProject()` bila belum ada |
| Akun Fonnte | Untuk mengirim WhatsApp. Diperlukan token dan perangkat yang terhubung |
| Browser modern | Chrome, Safari, atau Firefox terbaru di HP peserta |
| HTTPS | Wajib untuk kamera dan lokasi. Lihat [bagian 4.8](#48-hosting-statis-untuk-kamera-dan-lokasi) |
| Internet | HP peserta dan server Google harus dapat mengakses internet |

Tidak perlu memasang Node.js, PHP, database, atau hosting berbayar.

---

## 2. Struktur Proyek

| File / Folder | Fungsi |
|---|---|
| `Code.gs` | Seluruh backend: setup, validasi, endpoint, Drive, XLSX, WhatsApp, trigger |
| `index.html` | Frontend satu halaman: form, kamera, lokasi, bukti absensi, tab Daftar |
| `appsscript.json` | Manifest Apps Script: zona waktu, scope OAuth, akses Web App |
| `Netliify/index.html` | Salinan `index.html` yang siap diunggah ke hosting statis |
| `README.md` | Panduan ini |

> `Netliify/index.html` **harus selalu identik** dengan `index.html`. Setelah
> mengubah salah satunya, salin ulang agar keduanya sama. Nama folder tidak
> penting; yang penting isi file `index.html` berada di root situs hosting.

---

## 3. Mulai Cepat

Ikuti urutan ini bila Anda sudah familiar dengan Apps Script:

1. Buat Spreadsheet baru, lalu buka **Extensions -> Apps Script**.
2. Ganti isi `Code.gs` dengan `Code.gs` dari proyek ini.
3. Buat file HTML bernama **`index`**, tempel isi `index.html`.
4. Aktifkan manifest dan tempel isi `appsscript.json`.
5. Jalankan `setupProject()` dan setujui semua izin.
6. Isi `NO_WA_GURU` (atau `TARGET_WA=grup` + `ID_GRUP_WA`) dan `FONNTE_TOKEN`
   di sheet **Konfigurasi**.
7. Jalankan `validasiTargetWA()` lalu `sendTestWA()`.
8. Deploy sebagai **Web app** dengan akses **Anyone**.
9. Hosting `index.html` di HTTPS agar kamera dan lokasi berfungsi
   ([bagian 4.8](#48-hosting-statis-untuk-kamera-dan-lokasi)).
10. Jalankan `ujiBuatXlsx()` dan `ujiKirimRekap()` untuk memastikan rekap benar.

Detail setiap langkah ada di bawah.

---

## 4. Pemasangan dari Nol

### 4.1 Buat Spreadsheet

1. Buka <https://sheets.new>.
2. Beri nama, misalnya **Absensi Kebekerjaan**.
3. Jangan menutup tab Spreadsheet; Anda akan kembali ke sini beberapa kali.

### 4.2 Buka Editor Apps Script

1. Dari Spreadsheet, klik **Extensions -> Apps Script**.
2. Ganti nama proyek (opsional), misalnya **Absensi Kebekerjaan**.
3. Anda akan melihat file `Code.gs` bawaan.

### 4.3 Pasang Kode Backend

1. Buka `Code.gs` bawaan di editor.
2. Hapus seluruh isinya.
3. Buka file `Code.gs` dari proyek ini, salin seluruh isinya, lalu tempel.
4. Simpan dengan **Ctrl/Cmd + S**.

### 4.4 Pasang Frontend

1. Di panel **Files**, klik **+ -> HTML**.
2. Beri nama **`index`** (tanpa `.html`; Apps Script menambahkan ekstensinya).
3. Hapus isi yang muncul, lalu tempel seluruh isi `index.html`.
4. Simpan.

> Nama file harus tepat `index` karena `doGet()` memanggil
> `createHtmlOutputFromFile('index')`.

### 4.5 Pasang Manifest

1. Klik **Project Settings** (ikon gerigi) di sidebar kiri.
2. Centang **Show "appsscript.json" manifest file in editor**.
3. Kembali ke daftar file, buka `appsscript.json`.
4. Ganti seluruh isinya dengan isi `appsscript.json` dari proyek ini.
5. Simpan.

Manifest ini menyetel zona waktu `Asia/Jakarta` dan scope yang dibutuhkan:
Spreadsheet, Drive, trigger, permintaan HTTP eksternal, dan UI spreadsheet.

### 4.6 Jalankan `setupProject()`

1. Pada dropdown fungsi di toolbar, pilih **`setupProject`**.
2. Klik **Run**.
3. Saat diminta, klik **Review permissions -> pilih akun -> Allow**.
4. Tunggu hingga eksekusi selesai. Buka **Execution log** bila perlu.

`setupProject()` akan:

- Menyiapkan sheet **`Master_Peserta`**, **`Log_Absensi`**, dan **`Konfigurasi`**.
- Membuat atau menemukan folder Drive **`Foto Absensi <tahun>`**.
- Mengisi `FOLDER_DRIVE_ID` secara otomatis.
- Memasang trigger harian sesuai `JAM_TUTUP`.
- Merapikan format kolom tanggal di `Log_Absensi`.
- Menampilkan daftar konfigurasi yang masih kosong pada log.

Kembali ke Spreadsheet. Anda akan melihat tiga sheet baru dan menu **Absensi**
(menu hanya muncul pada script yang terikat ke Spreadsheet).

> Bila muncul pesan **"Spreadsheet belum terhubung"**, jalankan `setupProject()`
> dari script yang terikat ke Spreadsheet, atau biarkan script standalone
> membuat spreadsheet baru secara otomatis.

### 4.7 Isi Konfigurasi Wajib

Buka sheet **`Konfigurasi`**. Isi minimal:

| Key | Contoh | Wajib? |
|---|---|---|
| `FONNTE_TOKEN` | `xxxxxxxxxxxx` | Ya, untuk mengirim WhatsApp |
| `NO_WA_GURU` | `6281234567890` | Ya, bila `TARGET_WA=nomor` |
| `ID_GRUP_WA` | `1203630...@g.us` | Ya, bila `TARGET_WA=grup` |
| `TARGET_WA` | `grup` atau `nomor` | Pilih salah satu |

Cara cepat dari editor Apps Script:

```javascript
setKonfigurasi('TARGET_WA', 'grup');
setKonfigurasi('ID_GRUP_WA', '1203630xxxxxxxx@g.us');
setKonfigurasi('FONNTE_TOKEN', 'TOKEN_FONNTE_ANDA');
```

Atau isi langsung di sheet, lalu jalankan `lihatKonfigurasi()` untuk memastikan
nilai terbaca server.

**Uji koneksi WhatsApp:**

```javascript
validasiTargetWA();  // cek tujuan tanpa mengirim pesan
sendTestWA();        // kirim pesan uji
```

Pastikan perangkat Fonnte berstatus **connected**, token masih aktif, dan kuota
mencukupi. Nomor boleh ditulis `08...` atau `62...`; sistem menormalkannya.

### 4.8 Hosting Statis untuk Kamera dan Lokasi

**Mengapa perlu?** Apps Script menampilkan halaman Anda di dalam iframe. Iframe
milik Google tersebut tidak mengizinkan kamera dan sering memblokir lokasi.
Akibatnya browser menolak `getUserMedia()` sebelum sempat menampilkan prompt
izin. Ini batasan platform, bukan bug aplikasi.

Solusinya: sajikan `index.html` sebagai halaman HTTPS mandiri. Halaman itu tetap
mengirim data ke Web App Apps Script yang sama.

**Langkah:**

1. Deploy Web App terlebih dahulu ([bagian 4.9](#49-deploy-web-app)), lalu salin
   URL yang berakhiran `/exec`.
2. Buka `index.html` (atau `Netliify/index.html`) dan cari bagian:

   ```javascript
   const APP_CONFIG = {
     WEB_APP_URL: 'https://script.google.com/macros/s/XXXXXXXX/exec',
     STANDALONE_URL: ''
   };
   ```

3. Ganti `WEB_APP_URL` dengan URL `/exec` milik Anda.

   > **Penting:** file di repo ini mungkin masih berisi URL deployment contoh.
   > Ganti dengan URL Anda. Bila tidak diganti, data absensi akan dikirim ke
   > aplikasi milik pemilik URL tersebut.

4. Unggah file `index.html` ke hosting statis HTTPS. Pilihan paling mudah:
   **Netlify Drop** (<https://app.netlify.com/drop>) - seret satu file
   `index.html` ke halaman tersebut.
5. Buka URL hasil hosting di HP. Prompt izin kamera dan lokasi akan muncul pada
   kunjungan pertama.
6. Opsional: isi `STANDALONE_URL` pada `index.html` **yang dipasang di Apps
   Script** dengan URL hosting langkah 5. Bila kamera gagal di iframe, muncul
   tombol **Buka Versi Kamera** yang membuka halaman mandiri di tab baru.

**Cara kerja halaman statis:**

- Frontend mendeteksi `google.script.run`.
- Bila tidak tersedia (halaman statis), frontend memakai HTTP:
  - `GET <WEB_APP_URL>?api=1` untuk data awal,
  - `POST <WEB_APP_URL>` dengan `Content-Type: text/plain` untuk submit.
- Semua validasi tetap dilakukan di server. Logika jam di browser hanya untuk
  tampilan.

> Halaman statis wajib memakai HTTPS. Alamat `http://` biasa diblokir browser
> untuk kamera dan lokasi.
>
> URL `/exec` **tidak** bisa dijadikan pengganti hosting statis. Membukanya di
> tab baru tetap menampilkan iframe yang sama.

### 4.9 Deploy Web App

1. Di editor Apps Script, klik **Deploy -> New deployment**.
2. Klik ikon gerigi, pilih **Web app**.
3. Isi:
   - **Description**: `Absensi v1`
   - **Execute as**: `Me (email Anda)`
   - **Who has access**: `Anyone`
4. Klik **Deploy**, lalu salin **Web app URL** yang berakhiran `/exec`.
5. Buka URL tersebut untuk memastikan halaman tampil.

Setiap kali `Code.gs` atau `index.html` diubah:

1. **Deploy -> Manage deployments**.
2. Klik ikon pensil pada deployment yang dipakai.
3. Pilih **Version: New version**.
4. Klik **Deploy**.

Tanpa langkah ini, URL yang sudah dibagikan masih menjalankan versi lama.

### 4.10 Verifikasi Trigger Harian

1. Di editor Apps Script, buka **Triggers** (ikon jam).
2. Pastikan hanya ada satu trigger:
   - Fungsi: `processDailyClosingAndSendWA`
   - Event: **Time-driven -> Day timer**
   - Zona waktu: `Asia/Jakarta`
   - Jam mengikuti `JAM_TUTUP` (default sekitar pukul 10:00)
3. Bila trigger tidak ada atau jamnya salah, jalankan:

   ```javascript
   aturTriggerHarian();
   ```

4. Cek **Executions** bila trigger tidak berjalan.

> Google dapat menjalankan trigger beberapa menit setelah jadwal. Ini normal.
> Validasi pengisian tetap tegas ditutup pada `JAM_TUTUP`.

### 4.11 Ganti Nama Peserta

1. Buka sheet **`Master_Peserta`**.
2. Ganti `Peserta 1` ... `Peserta 9` dengan nama sebenarnya.
3. Jumlah baris boleh lebih atau kurang dari 9; sistem mengikuti isi sheet.
4. **Jangan mengubah nama header.**

Nama yang diubah tidak mengubah baris log lama. Laporan selalu memakai nama yang
ada di `Master_Peserta` saat laporan dibuat.

---

## 5. Konfigurasi

Semua pengaturan berada di sheet **`Konfigurasi`** dengan format dua kolom:
`Key` dan `Value`.

Nilai `ya` / `tidak` tidak membedakan huruf besar-kecil.

### 5.1 Identitas dan Lokasi

| Key | Default | Keterangan |
|---|---|---|
| `NAMA_LOKASI` | `SMKN 2` | Nama lokasi yang tampil pada kartu lokasi |
| `LAT_SEKOLAH` | `-6.934730751402668` | Latitude pusat lokasi Hadir |
| `LON_SEKOLAH` | `106.92613213306163` | Longitude pusat lokasi Hadir |
| `RADIUS_LOKASI` | `180` | Radius toleransi dalam meter (maksimal 10.000) |
| `WAJIB_LOKASI` | `ya` | `ya` = Hadir wajib di dalam radius; `tidak` = cek lokasi nonaktif |

Cara mendapatkan koordinat: buka Google Maps, klik kanan titik lokasi, klik
angka koordinat untuk menyalinnya.

> Sel `LAT_SEKOLAH`, `LON_SEKOLAH`, `JAM_TUTUP`, `JAM_TEPAT_WAKTU`, dan
> `RADIUS_LOKASI` disimpan sebagai **teks**. Jangan mengubahnya menjadi angka
> atau tanggal. Bila nilai terlanjur rusak (misalnya koordinat menjadi
> `-6.934.730.751.402.660`), jalankan:

```javascript
perbaikiKonfigurasiLokasi();
```

Fungsi ini mengembalikan format teks dan mengganti nilai yang tidak valid
dengan bawaan. Aman dijalankan berulang.

### 5.2 Jam dan Hari

| Key | Default | Keterangan |
|---|---|---|
| `JAM_TUTUP` | `10:00` | Batas akhir pengisian dan jam trigger rekap harian (`HH:MM` WIB) |
| `JAM_TEPAT_WAKTU` | `08:00` | Batas hadir tepat waktu; setelah ini wajib mengisi alasan (`HH:MM` WIB) |
| `HARI_AKTIF` | `1,2,3,4,5` | Hari absensi: 1=Senin ... 7=Minggu |
| `TANGGAL_LIBUR` | _(kosong)_ | Daftar tanggal libur, lihat [bagian 5.6](#56-format-tanggal_libur) |
| `MODE_UJI` | `tidak` | `ya` = buka form di luar hari/jam normal untuk pengujian |

Bila `JAM_TUTUP` diubah, jalankan `aturTriggerHarian()` agar jadwal trigger
langsung menyesuaikan. Tanpa itu, trigger baru disesuaikan pada penutupan
berikutnya.

### 5.3 Foto dan Kompresi

| Key | Default | Keterangan |
|---|---|---|
| `FOLDER_DRIVE_ID` | _(otomatis)_ | ID folder Drive foto. Diisi `setupProject()` |
| `KOMPRES_FOTO` | `ya` | `ya` = kecilkan foto sebelum disimpan |
| `COMPRESSO_TOKEN` | _(kosong)_ | Token <https://api.compresso.space>. Opsional |

Bila token kosong atau kuota kompresi habis, foto asli tetap dipakai dan absensi
tidak gagal. Cek sisa kuota dengan:

```javascript
cekKuotaCompresso();
```

### 5.4 WhatsApp

| Key | Default | Keterangan |
|---|---|---|
| `FONNTE_TOKEN` | _(kosong)_ | Token perangkat Fonnte |
| `TARGET_WA` | `nomor` | `nomor` = kirim ke `NO_WA_GURU`; `grup` = kirim ke `ID_GRUP_WA` |
| `NO_WA_GURU` | _(kosong)_ | Nomor penerima rekap |
| `ID_GRUP_WA` | _(kosong)_ | ID grup WhatsApp, biasanya berakhiran `@g.us` |
| `NAMA_GRUP_WA` | `Kelas Kebekerjaan LN` | Nama grup untuk label dan pemeriksaan tujuan |
| `KIRIM_XLSX` | `ya` | `ya` = buat XLSX dan kirim ringkasan + tautannya |
| `KIRIM_TEKS_REKAP` | `tidak` | `ya` = kirim juga teks rekap panjang |
| `KIRIM_FOTO_WA` | `tidak` | `ya` = kirim setiap foto peserta satu per satu |

- ID grup **tidak** boleh diperlakukan seperti nomor telepon. Salin ID apa
  adanya dari Fonnte.
- Perangkat Fonnte harus sudah menjadi anggota grup tujuan.
- Setiap pesan dan setiap foto memakai kuota Fonnte. Untuk 9 peserta, sediakan
  minimal 10 kuota per hari bila `KIRIM_FOTO_WA=ya`.
- Token tidak pernah dikirim ke browser peserta.

### 5.5 Tab Daftar Publik

| Key | Default | Keterangan |
|---|---|---|
| `PUBLIK_ALASAN` | `ya` | `ya` = tampilkan alasan Izin/Sakit di tab Daftar |
| `PUBLIK_FOTO` | `tidak` | `ya` = tampilkan thumbnail foto |
| `PUBLIK_HARI` | `7` | Jumlah hari yang ditampilkan, termasuk hari ini |
| `CACHE_DAFTAR_DETIK` | `20` | Lama cache tab Daftar (detik) untuk menghemat kuota |

### 5.6 Format `TANGGAL_LIBUR`

Pemisah boleh koma, titik koma, atau spasi. Format yang tidak dikenali
diabaikan, tidak membuat sistem error.

| Yang ditulis | Terbaca sebagai |
|---|---|
| `2026-12-25` | 25 Desember 2026 |
| `2026-12-25, 2027-01-01` | Dua tanggal |
| `2026-12-5` | 5 Desember 2026 (nol di depan opsional) |
| `25/12/2026` atau `25-12-2026` | 25 Desember 2026 |
| `20261225` | 25 Desember 2026 |

Sabtu dan Minggu tidak perlu didaftarkan bila `HARI_AKTIF=1,2,3,4,5`.

Setelah mengubah, jalankan `diagnosaSistem()` dan periksa
`konfigurasi.tanggalLiburTerbaca`.

### 5.7 Key Internal

Key berikut diisi otomatis. **Jangan diubah manual** kecuali Anda tahu
konsekuensinya.

| Key | Isi |
|---|---|
| `LAST_CLOSING_DATE` | Tanggal terakhir penutupan dijalankan |
| `LAST_WA_SENT_DATE` | Tanggal terakhir rekap berhasil dikirim lewat WhatsApp |
| `LAST_REPORT_SENT_DATE` | Tanggal terakhir rekap berhasil dikirim |
| `LAST_WA_STATUS` | Status pengiriman terakhir |
| `MIGRASI_V2` | Penanda migrasi internal |

Saat kode versi baru pertama kali berjalan pada spreadsheet lama, `MIGRASI_V2`
menyetel kanal rekap sekali saja menjadi `KIRIM_XLSX=ya`,
`KIRIM_TEKS_REKAP=tidak`, `KIRIM_FOTO_WA=tidak`, dan `TARGET_WA=nomor`. Nilai
yang Anda ubah setelah itu tidak ditimpa lagi. Untuk penggunaan grup, ubah
`TARGET_WA` dan `ID_GRUP_WA` setelah migrasi.

Bila spreadsheet lama masih menyimpan key Telegram (`TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `LAST_TELEGRAM_STATUS`), key tersebut tidak dibaca lagi.
Anda boleh menghapus barisnya secara manual.

---

## 6. Aturan Absensi

| Kondisi (waktu server WIB) | Status | `Terlambat_Menit` |
|---|---|---|
| Hadir, submit <= `JAM_TEPAT_WAKTU` | `Hadir` | `0` |
| Hadir, setelah `JAM_TEPAT_WAKTU` dan sebelum `JAM_TUTUP` | `Hadir` | Menit penuh sejak batas tepat waktu |
| Izin / Sakit, sebelum `JAM_TUTUP` | `Izin` / `Sakit` | `0` |
| Submit >= `JAM_TUTUP` | Ditolak server | - |
| Belum mengisi sampai `JAM_TUTUP` | `Alpha` (oleh trigger) | `0` |

Dengan nilai bawaan:

- Submit pukul **08:00:59** -> `Hadir`, terlambat `0` menit.
- Submit pukul **08:01:00** -> `Hadir`, terlambat `1` menit.
- Submit pukul **09:59:00** -> masih diterima.
- Submit pukul **10:00:00** -> ditolak.

Aturan tambahan:

- **Satu peserta satu kali per hari.** Dicek di server di dalam `LockService`,
  sehingga dua kiriman bersamaan tidak menghasilkan baris ganda.
- **Foto wajib** untuk semua status, berasal dari kamera langsung (bukan galeri).
- **Lokasi wajib untuk Hadir** bila `WAJIB_LOKASI=ya`. Izin dan Sakit tidak
  memerlukan lokasi.
- **Keterangan wajib** minimal 3 karakter untuk Izin/Sakit, dan untuk Hadir
  yang dikirim setelah batas tepat waktu. Hadir tepat waktu tidak memerlukan
  keterangan.
- **Hari tidak aktif** membuat form ditutup dan trigger tidak menandai Alpha
  maupun mengirim laporan.
- **Batas ukuran foto** aplikasi: lebar maksimal 1280 px, JPEG kualitas 0,85.
- **Nama file foto**: `YYYY-MM-DD_NamaLengkap_Status.jpg`.
- **`MODE_UJI=ya`** membuka form kapan pun, tetapi **tidak** mematikan validasi
  lokasi. Set `WAJIB_LOKASI=tidak` bila ingin menguji tanpa lokasi.
- Baris uji ditandai `[MODE UJI]` pada `Keterangan` dan `_UJI` pada nama file.
- Selama `MODE_UJI=ya`, penutupan otomatis sengaja dilewati agar tidak menulis
  Alpha palsu.

---

## 7. Fungsi Admin

Jalankan dari editor Apps Script, atau lewat menu **Absensi** di Spreadsheet.

| Fungsi | Kegunaan |
|---|---|
| `setupProject(wa, token)` | Membuat/memperbaiki sheet, folder Drive, dan trigger. Argumen opsional |
| `diagnosaSistem()` | Ringkasan sheet, folder, trigger, dan konfigurasi |
| `lihatKonfigurasi()` | Tampilkan seluruh konfigurasi di log |
| `setKonfigurasi(key, value)` | Ubah satu nilai konfigurasi |
| `validasiTargetWA()` | Periksa tujuan WhatsApp tanpa mengirim pesan |
| `sendTestWA()` | Kirim pesan uji ke tujuan WhatsApp |
| `aturTriggerHarian()` | Pasang ulang trigger sesuai `JAM_TUTUP` |
| `cekKonfigurasiJam()` | Tampilkan jam server dan jam yang terbaca dari konfigurasi |
| `cekKonfigurasiLokasi()` | Tampilkan koordinat, radius, dan uji jarak |
| `perbaikiKonfigurasiLokasi()` | Rapikan format sel koordinat/jam yang rusak |
| `perbaikiTanggalLog()` | Rapikan kolom `Tanggal` yang terbaca sebagai Date |
| `hapusBarisUji()` | Hapus baris `[MODE UJI]` dan foto uji yang tertaut |
| `cekKuotaCompresso()` | Tampilkan sisa kuota kompresi foto |
| `previewLaporanHariIni()` | Lihat teks rekap hari ini tanpa mengirim |
| `ujiBuatXlsx(tanggal)` | Buat file XLSX tanpa mengirim. Tanggal opsional |
| `ujiKirimRekap()` | Kirim rekap hari ini tanpa menulis Alpha atau menandai terkirim |
| `manualCloseToday()` | Jalankan penutupan hari ini sekarang |
| `resendWhatsAppReport()` | Paksa kirim ulang rekap hari ini |
| `processDailyClosingAndSendWA()` | Handler trigger harian. Jangan dijalankan manual kecuali perlu |

Contoh:

```javascript
// Melihat semua konfigurasi yang terbaca server
lihatKonfigurasi();

// Mengubah satu nilai
setKonfigurasi('JAM_TUTUP', '09:30');

// Memeriksa hasil rekap tanpa mengirim
previewLaporanHariIni();

// Membuat XLSX untuk tanggal tertentu
ujiBuatXlsx('2026-11-20');
```

> `setupProject()` dan `manualCloseToday()` bersifat idempotent: aman dijalankan
> ulang. `manualCloseToday()` tidak mengirim ulang rekap bila hari ini sudah
> pernah terkirim; gunakan `resendWhatsAppReport()` untuk memaksa.

---

## 8. Rekap Harian dan WhatsApp

### 8.1 Alur Otomatis

1. Trigger berjalan setiap hari pada `JAM_TUTUP` (default 10:00 WIB).
2. Peserta yang belum mengisi dicatat sebagai `Alpha`.
3. File **`Absensi_YYYY-MM-DD.xlsx`** dibuat di folder Drive foto.
4. Ringkasan dan tautan file dikirim ke WhatsApp tujuan.
5. Status pengiriman dicatat di `LAST_WA_STATUS`.

File XLSX berisi:

- Ringkasan jumlah Hadir, Izin, Sakit, dan Alpha.
- Tabel peserta dengan status, jam, keterangan, dan foto tertanam.
- Warna status dan baris zebra agar mudah dibaca.
- Kolom tautan foto sebagai cadangan bila gambar gagal diekspor.

### 8.2 Perilaku Pengiriman

- Bawaan: **satu pesan teks** berisi ringkasan + tautan Drive ke file XLSX.
  Fonnte tidak menerima lampiran dokumen, jadi tautan yang dikirim.
- Bila `KIRIM_XLSX=tidak`, rekap dikirim sebagai teks biasa.
- Bila pembuatan XLSX gagal, teks rekap biasa dikirim sebagai cadangan.
- `KIRIM_TEKS_REKAP=ya` menambahkan teks rekap panjang sebagai pesan
  tambahan. Opsi ini hanya berlaku bila XLSX berhasil dibuat.
- `KIRIM_FOTO_WA=ya` mengirim foto asli satu per satu dengan caption
  `Nama - Status - jam WIB`. Setiap foto memakai satu kuota Fonnte.
- File XLSX lama dengan nama sama dipindahkan ke sampah agar folder tetap rapi.

### 8.3 Menguji Rekap

```javascript
ujiBuatXlsx();     // buat file hari ini, tautan dicetak di log
ujiKirimRekap();   // kirim rekap hari ini tanpa mengubah Log_Absensi
```

`ujiKirimRekap()` tidak menulis baris Alpha dan tidak menandai laporan sebagai
terkirim, sehingga aman dipakai berulang.

---

## 9. Tab Daftar Publik

Tab **Daftar** pada halaman web menampilkan rekap beberapa hari terakhir tanpa
login:

- Nama peserta dan status.
- Jam absensi.
- Alasan Izin/Sakit, bila `PUBLIK_ALASAN=ya`.
- Thumbnail foto, bila `PUBLIK_FOTO=ya`.
- Tautan file XLSX, bila tersedia.

Ketentuan:

- Rentang hari mengikuti `PUBLIK_HARI` (default 7 hari, termasuk hari ini).
- Hari ini yang belum ditutup menampilkan status **Belum**.
- Hasil disimpan di cache selama `CACHE_DAFTAR_DETIK` detik (default 20), jadi
  data terbaru muncul paling lambat sekitar 20 detik setelah absensi dikirim.
- Tab ini publik dan hanya menampilkan nama, status, jam, alasan, dan foto.
  Token dan nomor WhatsApp tidak pernah ikut.

---

## 10. Skema Database

### `Master_Peserta`

| Kolom | Isi |
|---|---|
| `No` | Nomor urut |
| `Nama_Lengkap` | Nama peserta |

Jumlah baris bebas; sistem mengikuti isi sheet. Jangan mengubah nama header.

### `Log_Absensi`

| Kolom | Contoh |
|---|---|
| `Timestamp` | `2026-11-18 07:42:10` |
| `Tanggal` | `2026-11-18` |
| `Nama_Lengkap` | `Budi` |
| `Status` | `Hadir` |
| `Terlambat_Menit` | `0` |
| `Keterangan` | `-` |
| `Link_Foto_Drive` | `https://drive.google.com/...` |

- `Tanggal` selalu `YYYY-MM-DD` WIB dan disimpan sebagai **teks** (format `@`).
- `Status` adalah `Hadir`, `Izin`, `Sakit`, atau `Alpha`.
- Baris Alpha dibuat oleh trigger dengan `Keterangan` seperti
  `Tidak mengisi absensi hingga pukul 10:00` dan tautan foto `-`.

### `Konfigurasi`

Tabel key-value (`Key` | `Value`) seperti pada [bagian 5](#5-konfigurasi).

---

## 11. Troubleshooting

### Kamera dan Lokasi

| Gejala | Penyebab dan solusi |
|---|---|
| Prompt izin kamera tidak muncul; tombol **Aktifkan Kamera** langsung gagal | Halaman dibuka dari URL `/exec` (iframe Apps Script). Gunakan hosting statis HTTPS ([bagian 4.8](#48-hosting-statis-untuk-kamera-dan-lokasi)) |
| **Akses kamera ditolak** di halaman hosting | Izin pernah diblokir untuk origin tersebut. Buka ikon gembok -> Kamera -> **Izinkan** -> muat ulang. Pastikan alamat berawalan `https://` |
| Kamera hitam atau **sedang digunakan aplikasi lain** | Tutup aplikasi kamera/meeting lain, lalu tekan **Coba Lagi** |
| **Lokasi Anda belum terdeteksi** | GPS mati atau izin lokasi ditolak. Aktifkan lokasi, izinkan situs memakai lokasi, lalu tekan **Periksa Ulang Lokasi**. Di `/exec`, geolocation sering diblokir; gunakan hosting statis |
| **Anda berada sekitar N m dari SMKN 2** | Peserta di luar `RADIUS_LOKASI`. Mendekat, perbesar radius, atau periksa koordinat lewat `cekKonfigurasiLokasi()` |
| Ingin mematikan cek lokasi | Set `WAJIB_LOKASI=tidak`, lalu muat ulang halaman |

### Absensi

| Gejala | Penyebab dan solusi |
|---|---|
| **Hari ini bukan hari absensi** | `HARI_AKTIF` tidak memuat hari ini, atau tanggal ada di `TANGGAL_LIBUR`. Isi `1,2,3,4,5,6,7` untuk membuka setiap hari. Periksa `tanggalLiburTerbaca` lewat `diagnosaSistem()` |
| **Absensi sudah ditutup** | Waktu server >= `JAM_TUTUP`. Ini disengaja. Cek jam di header (berasal dari server). Untuk uji, set `MODE_UJI=ya` |
| **Nama sudah tercatat hari ini** | Anti-duplikasi. Satu nama hanya boleh sekali per tanggal |
| **Keterangan wajib diisi** | Izin/Sakit wajib beralasan minimal 3 karakter. Hadir setelah `JAM_TEPAT_WAKTU` wajib mengisi alasan terlambat |
| Foto tersimpan tetapi tautan tidak publik | Kebijakan Google Workspace membatasi `ANYONE_WITH_LINK`. Absensi tetap tercatat. Minta admin domain mengizinkan link sharing |
| Ingin menguji setelah `JAM_TUTUP` | Set `MODE_UJI=ya`, muat ulang, kirim absensi uji, lalu `ujiKirimRekap()`. Setelah selesai kembalikan ke `tidak` dan jalankan `hapusBarisUji()` |

### WhatsApp dan Trigger

| Gejala | Penyebab dan solusi |
|---|---|
| WA tidak terkirim | Periksa `LAST_WA_STATUS`. Penyebab umum: token salah, perangkat Fonnte offline, kuota habis, tujuan bukan format `62...`, atau ID grup salah. Uji dengan `validasiTargetWA()` lalu `sendTestWA()` |
| Teks rekap masuk, foto tidak | `KIRIM_FOTO_WA=tidak`, tidak ada foto pada tanggal itu, kuota habis di tengah pengiriman, atau tautan foto tidak dapat diunduh Fonnte |
| Tautan XLSX tidak muncul di WhatsApp | `KIRIM_XLSX=tidak`, pembuatan XLSX gagal, atau rekap belum dijalankan. Cek `ujiBuatXlsx()` dan `LAST_WA_STATUS` |
| Rekap tidak masuk padahal trigger jalan | `LAST_WA_SENT_DATE` sudah bernilai hari ini. Gunakan `resendWhatsAppReport()` |
| Trigger tidak jalan | Buka **Triggers**, pastikan hanya ada satu `processDailyClosingAndSendWA` dengan timezone `Asia/Jakarta`. Jalankan `aturTriggerHarian()` lalu cek **Executions** |
| Trigger berjalan terlambat | Normal. Google dapat memundurkannya beberapa menit. Validasi tutup tetap tepat pada `JAM_TUTUP` |
| `t.getHour is not a function` | Versi lama. Jalankan kode terbaru, lalu `aturTriggerHarian()` |

### Instalasi dan Data

| Gejala | Penyebab dan solusi |
|---|---|
| **Spreadsheet belum terhubung** | Script standalone tanpa database. Jalankan `setupProject()`; spreadsheet baru dibuat otomatis. Bila ID lama tidak bisa dibuka, `setupProject` berhenti dengan pesan yang menyebut ID tersebut |
| Perubahan kode tidak muncul di URL | Deploy ulang: **Manage deployments -> Edit -> New version -> Deploy** |
| Tanggal/jam di sheet tidak sesuai WIB | Jalankan `setupProject()`; fungsi ini menyetel timezone spreadsheet ke `Asia/Jakarta` |
| Koordinat berubah menjadi angka berpemisah ribuan | Jalankan `perbaikiKonfigurasiLokasi()`, lalu jangan ubah format sel dari teks |
| Kolom `Tanggal` terbaca sebagai Date | Jalankan `perbaikiTanggalLog()` |
| Menu **Absensi** tidak muncul | Script tidak terikat ke Spreadsheet (standalone). Menu hanya tersedia pada script container-bound |
| Ingin menghapus data uji | Jalankan `hapusBarisUji()`. Fungsi ini menghapus baris `[MODE UJI]` sekaligus foto yang tertaut. File `*_UJI.jpg` yang tidak tertaut dihapus manual bila perlu |

---

## 12. Keamanan dan Privasi

- **Tanpa login peserta.** Siapa pun yang memiliki tautan dapat memilih nama
  mana pun. Bukti yang tersedia: foto kamera langsung, watermark waktu server,
  dan batas waktu pengisian. Bila perlu verifikasi identitas, tambahkan PIN
  pada `Master_Peserta` dan validasi di `submitAttendance()`.
- **Foto bersifat publik-baca** (`ANYONE_WITH_LINK / VIEW`) agar tautan dapat
  dibuka dari WhatsApp dan diunduh Fonnte. Jangan menyimpan dokumen sensitif
  di folder ini.
- **Token Fonnte tidak pernah dikirim ke browser.** Frontend hanya menerima
  penanda boolean pada `reportConfigured` dan `photoDelivery`.
- **Pesan error ke pengguna sudah disaring.** Detail teknis hanya masuk log
  eksekusi Apps Script.
- **Penulisan dibungkus `LockService`.** Dua permintaan bersamaan tidak dapat
  membuat baris ganda.
- **Web App dijalankan sebagai pemilik deployment.** Peserta tidak perlu akun
  Google dan tidak mendapat akses ke Spreadsheet atau Drive Anda.
- **File XLSX berisi data peserta.** Siapa pun yang memiliki tautannya dapat
  membuka file. Sesuaikan kebijakan berbagi dengan kebutuhan.

---

## 13. Checklist Uji Sebelum Produksi

1. `setupProject()` berhasil: tiga sheet dan folder Drive terbentuk.
2. `validasiTargetWA()` menunjukkan tujuan yang benar.
3. `sendTestWA()` masuk ke WhatsApp tujuan.
4. Buka halaman hosting statis di HP:
   - Prompt **Izinkan kamera** muncul.
   - Prompt **Izinkan lokasi** muncul (bila `WAJIB_LOKASI=ya`).
   - **Ambil Foto**, **Putar Kamera**, dan **Foto Ulang** berfungsi.
5. Kirim absensi **Hadir** di dalam radius -> muncul kartu bukti dengan jam dan
   status.
6. Coba kirim lagi dengan nama yang sama -> ditolak "sudah tercatat".
7. Kirim **Izin** dan **Sakit** dengan alasan -> berhasil dan alasannya tersimpan.
8. Coba kirim Hadir dari luar radius -> ditolak dengan pesan jarak.
9. Batalkan izin kamera -> muncul pesan yang jelas dan panduan, bukan layar
   kosong.
10. Ubah `HARI_AKTIF` ke hari lain -> form menampilkan "bukan hari absensi".
11. Set jam HP beberapa jam ke depan -> countdown dan validasi tetap mengikuti
    jam server.
12. Jalankan `ujiBuatXlsx()` -> buka file dan pastikan foto peserta tertanam.
13. Jalankan `ujiKirimRekap()` -> masuk satu pesan ringkasan + tautan XLSX,
    tanpa mengubah `Log_Absensi`.
14. Set `MODE_UJI=ya` -> banner kuning muncul dan absensi dapat dikirim di luar
    jam. Kembalikan ke `tidak` setelah selesai.
15. Jalankan `manualCloseToday()` -> peserta yang belum mengisi menjadi `Alpha`
    dan rekap terkirim.
16. Buka `Log_Absensi`: `Tanggal` bertipe teks `YYYY-MM-DD`,
    `Terlambat_Menit` sesuai, dan tautan foto dapat dibuka.
17. Buka tab **Daftar**: rentang tanggal benar, pilih tanggal lain, lalu kembali
    ke tab **Absensi** tanpa kehilangan isian.
18. Buka tab **Daftar** di ponsel: tidak ada geser mendatar dan tombol nyaman
    disentuh.
19. Ubah `JAM_TUTUP`, jalankan `aturTriggerHarian()`, lalu pastikan jadwal
    trigger ikut berubah.
20. Deploy ulang Web App setelah semua perubahan kode.

---

## 14. Batasan yang Diketahui

- **Kamera tidak dapat dipakai di URL `/exec`.** Iframe Apps Script memblokir
  `getUserMedia` tanpa prompt izin. Kamera dan lokasi hanya andal di halaman
  HTTPS mandiri ([bagian 4.8](#48-hosting-statis-untuk-kamera-dan-lokasi)).
- Jalur statis bergantung pada permintaan lintas-origin ke `script.google.com`.
  Bila jaringan sekolah memblokirnya, form tidak dapat memuat data.
- Rekap WhatsApp dikirim setelah trigger berjalan. Google dapat memundurkannya
  beberapa menit dari `JAM_TUTUP`, tetapi validasi pengisian tetap tegas.
- Nama peserta yang diubah tidak mengubah baris log lama.
- Foto yang gagal diunggah membuat absensi ditolak, agar setiap baris selalu
  memiliki bukti visual.
- Bila `setSharing` diblokir kebijakan domain, tautan Drive tetap dicatat dan
  pengguna menerima peringatan pada kartu bukti. Fonnte mungkin juga gagal
  mengunduh foto, sehingga hanya teks rekap yang sampai.
- Mengirim foto lewat WhatsApp memakai satu kuota Fonnte per foto. Set
  `KIRIM_FOTO_WA=tidak` bila ingin hanya mengirim rekap XLSX.
- `ujiKirimRekap()` bersifat read-only terhadap data: baris Alpha pada
  laporannya hanya perhitungan, bukan catatan baru.
- Pembuatan XLSX memakai ekspor Google. Spreadsheet sementara dibuat di Drive
  lalu dipindahkan ke sampah setelah file jadi. Bila proses gagal, file
  sementara bisa tertinggal dan dapat dihapus manual.
- Tab **Daftar** memakai cache `CACHE_DAFTAR_DETIK` detik, sehingga data
  terbaru muncul dengan jeda singkat.
- Kompresi foto bergantung pada layanan pihak ketiga
  (`api.compresso.space`). Bila token kosong atau kuota habis, foto asli tetap
  dipakai dan absensi tidak gagal.
- Aplikasi ini tidak menyediakan fitur edit absensi dari UI. Koreksi data
  dilakukan langsung di sheet `Log_Absensi` dengan hati-hati.
