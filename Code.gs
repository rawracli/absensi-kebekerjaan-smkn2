/**
 * ============================================================================
 *  SISTEM ABSENSI REAL-TIME - 9 PESERTA
 *  Backend : Google Apps Script (V8)
 *  Database: Google Sheets  (Master_Peserta / Log_Absensi / Konfigurasi)
 *  Storage : Google Drive   (foto JPEG, ANYONE_WITH_LINK)
 *  Notif   : Fonnte WhatsApp Gateway (https://api.fonnte.com/send)
 *
 *  ZONA WAKTU : Asia/Jakarta (WIB)
 *  Seluruh validasi waktu dan perhitungan keterlambatan dilakukan di server,
 *  sehingga jam perangkat pengguna tidak dapat dimanipulasi.
 *
 *  ATURAN BISNIS
 *   - Form dibuka  : sebelum 10:00:00 WIB
 *   - Tepat waktu  : <= 08:00:00 WIB   -> Hadir, Terlambat_Menit = 0
 *   - Terlambat    :  > 08:00:00 WIB dan < 10:00:00 WIB -> Hadir, menit penuh
 *   - Izin / Sakit : < 10:00:00 WIB, keterangan wajib, Terlambat_Menit = 0
 *   - >= 10:00:00  : ditolak server; peserta yang belum mengisi ditandai Alpha
 *                    oleh trigger harian, lalu rekap dikirim ke WhatsApp guru.
 *
 *  FUNGSI UTAMA
 *   - setupProject()               : setup sekali klik (sheet, folder, trigger)
 *   - doGet(e)                     : halaman HTML atau JSON (?api=1)
 *   - doPost(e)                    : endpoint submit untuk hosting statis
 *   - submitAttendance(payload)    : inti pencatatan absensi
 *   - processDailyClosingAndSendWA(): penutupan harian + rekap WhatsApp
 * ============================================================================
 */

/* ========================================================================== */
/*                             KONFIGURASI DASAR                              */
/* ========================================================================== */

const CONFIG = Object.freeze({
  TIMEZONE: 'Asia/Jakarta',

  CUTOFF_HOUR: 10,          // batas akhir pengisian (10:00 WIB)
  ONTIME_HOUR: 8,           // batas tepat waktu (08:00 WIB)

  LOCK_TIMEOUT_MS: 30000,   // maksimal menunggu script lock
  MAX_PHOTO_BYTES: 8 * 1024 * 1024,   // jaring pengaman; foto aplikasi ±300 KB
  MAX_REASON_LENGTH: 500,
  MAX_NAME_LENGTH: 120,

  SHEET_MASTER: 'Master_Peserta',
  SHEET_LOG: 'Log_Absensi',
  SHEET_CONFIG: 'Konfigurasi',

  HEADERS_MASTER: ['No', 'Nama_Lengkap'],
  HEADERS_LOG: [
    'Timestamp',
    'Tanggal',
    'Nama_Lengkap',
    'Status',
    'Terlambat_Menit',
    'Keterangan',
    'Link_Foto_Drive'
  ],
  HEADERS_CONFIG: ['Key', 'Value'],

  SEED_COUNT: 9,
  DEFAULT_ACTIVE_DAYS: '1,2,3,4,5',   // 1 = Senin ... 7 = Minggu
  FOLDER_PREFIX: 'Foto Absensi',
  WA_ENDPOINT: 'https://api.fonnte.com/send',

  COMPRESSO_ENDPOINT: 'https://api.compresso.space/v1/compress',
  COMPRESSO_USAGE: 'https://api.compresso.space/v1/usage',

  XLSX_MIME: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

  PUBLIC_DAYS: 7,          // halaman publik: hari ini + 6 hari sebelumnya
  LIST_CACHE_SECONDS: 20,

  STATUS_LIST: ['Hadir', 'Izin', 'Sakit'],
  STATUS_ALL: ['Hadir', 'Izin', 'Sakit', 'Alpha']
});

const SECONDS_PER_MINUTE = 60;

/** Parse "HH:MM" (00-23:00-59) -> detik sejak tengah malam; 0 bila tidak valid. */
function timeToSeconds_(label) {
  const m = String(label || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}

/** "HH:MM" dari detik sejak tengah malam. */
function secondsToTimeLabel_(secs) {
  const total = (((Number(secs) || 0) % 86400) + 86400) % 86400;
  return pad2_(Math.floor(total / 3600)) + ':' + pad2_(Math.floor((total % 3600) / 60));
}

/** Detik batas akhir pengisian dari konfigurasi (fallback CONFIG.CUTOFF_HOUR). */
function cutoffSeconds_(cfg) {
  const secs = timeToSeconds_(cfg && cfg.JAM_TUTUP);
  return secs > 0 ? secs : CONFIG.CUTOFF_HOUR * 3600;
}

/** Detik batas tepat waktu dari konfigurasi (fallback CONFIG.ONTIME_HOUR). */
function onTimeCfgSeconds_(cfg) {
  const secs = timeToSeconds_(cfg && cfg.JAM_TEPAT_WAKTU);
  return secs > 0 ? secs : CONFIG.ONTIME_HOUR * 3600;
}

/** Label "HH:MM" batas akhir, dari konfigurasi atau fallback. */
function cutoffLabel_(cfg) {
  const secs = timeToSeconds_(cfg && cfg.JAM_TUTUP);
  return secs > 0 ? secondsToTimeLabel_(secs) : pad2_(CONFIG.CUTOFF_HOUR) + ':00';
}

/** Label "HH:MM" batas tepat waktu, dari konfigurasi atau fallback. */
function onTimeLabel_(cfg) {
  const secs = timeToSeconds_(cfg && cfg.JAM_TEPAT_WAKTU);
  return secs > 0 ? secondsToTimeLabel_(secs) : pad2_(CONFIG.ONTIME_HOUR) + ':00';
}

/** Angka konfigurasi integer non-negatif (fallback bila kosong/tidak valid). */
function cfgInt_(cfg, key, fallback) {
  const raw = String((cfg && cfg[key]) == null ? '' : cfg[key]).trim();
  const n = parseInt(raw, 10);
  return isNaN(n) || n < 0 ? fallback : n;
}

/** Ambil jam (0-23) dari label "HH:MM" dalam cfg, fallback ke CONFIG.CUTOFF_HOUR. */
function triggerHour_(cfg) {
  const secs = timeToSeconds_(cfg && cfg.JAM_TUTUP);
  if (secs > 0) return Math.floor(secs / 3600);
  return CONFIG.CUTOFF_HOUR;
}

/** Ambil menit (0-59) dari label "HH:MM" dalam cfg. */
function triggerMinute_(cfg) {
  const secs = timeToSeconds_(cfg && cfg.JAM_TUTUP);
  if (secs > 0) return Math.floor((secs % 3600) / 60);
  return 0;
}

const HARI_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

/* ========================================================================== */
/*                              ERROR & RESPON                                */
/* ========================================================================== */

/**
 * Error yang aman ditampilkan ke pengguna (pesan berbahasa Indonesia).
 */
class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

/**
 * Mengubah error apa pun menjadi envelope JSON yang konsisten.
 * Detail teknis hanya masuk log, tidak pernah dikirim ke browser.
 */
function fail_(err) {
  if (err instanceof AppError) {
    return { ok: false, code: err.code, message: err.message };
  }
  console.error(err && err.stack ? err.stack : err);
  return {
    ok: false,
    code: 'SERVER_ERROR',
    message: 'Terjadi kesalahan pada server. Silakan coba lagi beberapa saat lagi.'
  };
}

function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** Kunci pembanding nama: huruf kecil, spasi dirapikan, tanpa spasi tepi. */
function normKey_(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* ========================================================================== */
/*                          NORMALISASI NILAI TANGGAL                         */
/* ========================================================================== */

/**
 * Ubah nilai sel tanggal menjadi `YYYY-MM-DD`.
 *
 * Google Sheets mengubah string "2026-11-18" yang ditulis ke sel berformat
 * otomatis menjadi nilai Date. Tanpa normalisasi, pembandingan
 * `String(row[1]) === '2026-11-18'` selalu gagal dan seluruh absensi dianggap
 * belum mengisi (bug rekap Alpha).
 *
 * Menerima: Date, serial number Sheets, string ISO, dan string lokal.
 * Nilai yang tidak dikenali menghasilkan string kosong (tidak melempar error).
 */
function toDateStr_(value) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return '';
    return Utilities.formatDate(value, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }

  // Serial date Google Sheets: 25569 = 1970-01-01.
  if (typeof value === 'number' && isFinite(value)) {
    const ms = Math.round((value - 25569) * 86400000);
    return Utilities.formatDate(new Date(ms), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }

  const text = String(value == null ? '' : value).trim();
  if (!text) return '';

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return iso[1] + '-' + pad2_(Number(iso[2])) + '-' + pad2_(Number(iso[3]));
  }

  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }

  return '';
}

/** Geser tanggal `YYYY-MM-DD` sebanyak `delta` hari (boleh negatif). */
function shiftDateStr_(dateStr, delta) {
  const parts = String(dateStr || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return '';

  const base = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  base.setUTCDate(base.getUTCDate() + Number(delta || 0));

  return base.getUTCFullYear() + '-' +
    pad2_(base.getUTCMonth() + 1) + '-' +
    pad2_(base.getUTCDate());
}


/* ========================================================================== */
/*                            UTILITAS WAKTU WIB                              */
/* ========================================================================== */

/**
 * Snapshot waktu server dalam zona Asia/Jakarta.
 * Dipakai untuk SEMUA keputusan waktu (buka/tutup, keterlambatan, tanggal).
 */
function nowWib_(cfg) {
  const cutoffSeconds = cutoffSeconds_(cfg);
  const now = new Date();
  const parts = Utilities
    .formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss')
    .split(/[- :]/)
    .map(Number);

  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  const hour = parts[3];
  const minute = parts[4];
  const second = parts[5];

  const secondsOfDay = hour * 3600 + minute * 60 + second;
  const epochMs = now.getTime();
  const dayStartEpochMs = epochMs - secondsOfDay * 1000;
  const dateStr = year + '-' + pad2_(month) + '-' + pad2_(day);

  return {
    epochMs: epochMs,
    year: year,
    month: month,
    day: day,
    hour: hour,
    minute: minute,
    second: second,
    secondsOfDay: secondsOfDay,
    dateStr: dateStr,
    timeLabel: pad2_(hour) + ':' + pad2_(minute) + ':' + pad2_(second),
    dayOfWeek: wibDayOfWeek_(year, month, day),
    dayStartEpochMs: dayStartEpochMs,
    cutoffEpochMs: dayStartEpochMs + cutoffSeconds_(cfg) * 1000,
    isPastCutoff: secondsOfDay >= cutoffSeconds_(cfg)
  };
}

/**
 * Nomor hari 1..7 (Senin..Minggu) dari tanggal kalender WIB.
 * Dihitung lewat UTC agar tidak terpengaruh zona waktu script.
 */
function wibDayOfWeek_(year, month, day) {
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Minggu
  return jsDay === 0 ? 7 : jsDay;
}

/** "Rabu, 18 November 2026" */
function dateLabel_(dateStr) {
  const parts = String(dateStr || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return String(dateStr || '');
  const jsDay = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
  return HARI_ID[jsDay] + ', ' + parts[2] + ' ' + BULAN_ID[parts[1] - 1] + ' ' + parts[0];
}

/** "Senin, Selasa & Rabu" */
function activeDaysLabel_(cfg) {
  const map = { 1: 'Senin', 2: 'Selasa', 3: 'Rabu', 4: 'Kamis', 5: 'Jumat', 6: 'Sabtu', 7: 'Minggu' };
  const days = String((cfg && cfg.HARI_AKTIF) || CONFIG.DEFAULT_ACTIVE_DAYS)
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean)
    .map(function (d) { return map[d]; })
    .filter(Boolean);

  if (!days.length) return 'hari aktif';
  if (days.length === 1) return days[0];
  return days.slice(0, -1).join(', ') + ' & ' + days[days.length - 1];
}

/**
 * Normalisasi daftar tanggal libur menjadi array `YYYY-MM-DD`.
 *
 * Menerima format yang longgar agar mudah diisi dari spreadsheet:
 *   `2026-12-25`  `2026-12-25, 2027-01-01`  `25/12/2026`  `25-12-2026`
 *   `2026-12-5`   `20261225`                 dipisah koma / titik koma / spasi
 *
 * Tanggal yang tidak dikenali diabaikan (tidak melempar error), supaya satu
 * salah ketik tidak membuat seluruh sistem berhenti.
 */
function normalizeDateList_(value) {
  const out = [];

  String(value == null ? '' : value)
    .split(/[,;\s]+/)
    .map(function (s) { return s.trim(); })
    .filter(Boolean)
    .forEach(function (token) {
      const groups = token.match(/\d+/g) || [];
      let year = 0;
      let month = 0;
      let day = 0;

      if (groups.length === 1 && groups[0].length === 8) {
        // 20261225
        year = Number(groups[0].slice(0, 4));
        month = Number(groups[0].slice(4, 6));
        day = Number(groups[0].slice(6, 8));
      } else if (groups.length >= 3) {
        if (groups[0].length === 4) {
          // 2026-12-25
          year = Number(groups[0]);
          month = Number(groups[1]);
          day = Number(groups[2]);
        } else if (groups[2].length === 4) {
          // 25-12-2026
          day = Number(groups[0]);
          month = Number(groups[1]);
          year = Number(groups[2]);
        }
      }

      if (!year || !month || !day) return;
      if (year < 2000 || year > 2100) return;
      if (month < 1 || month > 12 || day < 1 || day > 31) return;

      // Tolak tanggal yang tidak ada di kalender (mis. 31 Februari).
      const probe = new Date(Date.UTC(year, month - 1, day));
      if (probe.getUTCFullYear() !== year ||
          probe.getUTCMonth() !== month - 1 ||
          probe.getUTCDate() !== day) {
        return;
      }

      const iso = year + '-' + pad2_(month) + '-' + pad2_(day);
      if (out.indexOf(iso) === -1) out.push(iso);
    });

  return out;
}

/** Penanda konfigurasi boolean: `ya`, `on`, `aktif`, `1`, `true`. */
function isEnabled_(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return ['1', 'ya', 'yes', 'on', 'aktif', 'true'].indexOf(text) !== -1;
}

/** MODE_UJI: melewati batas 10:00 dan hari aktif, untuk pengujian. */
function isTestMode_(cfg) {
  return isEnabled_(cfg && cfg.MODE_UJI);
}

/**
 * Apakah tanggal ini hari absensi?
 *   - TANGGAL_LIBUR  : daftar YYYY-MM-DD dipisah koma (opsional)
 *   - HARI_AKTIF     : daftar 1..7 dipisah koma, default Senin-Jumat
 */
function resolveActiveDay_(wib, cfg) {
  const holidays = normalizeDateList_((cfg && cfg.TANGGAL_LIBUR) || '');

  if (holidays.indexOf(wib.dateStr) !== -1) {
    return { isActive: false, reason: 'holiday' };
  }

  const activeDays = String((cfg && cfg.HARI_AKTIF) || CONFIG.DEFAULT_ACTIVE_DAYS)
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);

  if (activeDays.indexOf(String(wib.dayOfWeek)) === -1) {
    return { isActive: false, reason: 'inactive' };
  }

  return { isActive: true, reason: null };
}

/**
 * Menit keterlambatan penuh sejak batas tepat waktu (JAM_TEPAT_WAKTU) pada
 * hari yang sama. Contoh: 08:00:59 -> 0 menit, 08:01:00 -> 1 menit.
 */
function calculateLateness_(wib, cfg) {
  const onTime = onTimeCfgSeconds_(cfg);
  if (wib.secondsOfDay <= onTime) return 0;
  return Math.floor((wib.secondsOfDay - onTime) / SECONDS_PER_MINUTE);
}

/* ========================================================================== */
/*                        AKSES SPREADSHEET & SHEET                           */
/* ========================================================================== */

/**
 * Spreadsheet aktif (container-bound) atau yang tersimpan di Script
 * Properties (standalone). Melempar AppError yang ramah bila belum ada.
 */
function getSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (err) {
      throw new AppError(
        'NO_SPREADSHEET',
        'Spreadsheet tidak dapat dibuka. Periksa ID spreadsheet pada Script Properties.'
      );
    }
  }

  throw new AppError(
    'NO_SPREADSHEET',
    'Script belum terhubung ke Spreadsheet. Jalankan setupProject() terlebih dahulu.'
  );
}

/**
 * Dipakai setupProject(): bila script standalone dan belum punya database,
 * buat spreadsheet baru otomatis lalu simpan ID-nya.
 */
function resolveSpreadsheetForSetup_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    return active;
  }

  const props = PropertiesService.getScriptProperties();
  const id = String(props.getProperty('SPREADSHEET_ID') || '').trim();

  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (err) {
      throw new AppError(
        'NO_SPREADSHEET',
        'Spreadsheet lama tidak dapat dibuka (ID: ' + id + '). Periksa izin aksesnya, ' +
        'atau kosongkan Script Property SPREADSHEET_ID bila memang ingin membuat database baru.'
      );
    }
  }

  const ss = SpreadsheetApp.create('Absensi Kehadiran 9 Peserta');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

function getSheet_(name) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new AppError(
      'NO_SHEET',
      'Sheet "' + name + '" tidak ditemukan. Jalankan setupProject() untuk membuat ulang.'
    );
  }
  return sheet;
}

/**
 * Ambil sheet berdasarkan nama; buat beserta header bila belum ada.
 * Header juga ditulis ulang bila baris pertama masih kosong.
 */
function getOrCreateSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  const width = headers.length;
  const firstRow = sheet.getRange(1, 1, 1, width).getValues()[0];
  const isEmpty = firstRow.every(function (v) { return String(v).trim() === ''; });

  if (isEmpty) {
    const headerRange = sheet.getRange(1, 1, 1, width);
    headerRange.setValues([headers]);
    headerRange
      .setFontWeight('bold')
      .setBackground('#0d6b5f')
      .setFontColor('#ffffff')
      .setVerticalAlignment('middle');
    sheet.setFrozenRows(1);
    sheet.setRowHeight(1, 32);
  }

  return sheet;
}

/**
 * Memastikan 3 sheet wajib ada, header benar, peserta terisi, dan
 * key konfigurasi tersedia. Aman dipanggil berulang (idempotent).
 */
function ensureSheets_() {
  const ss = getSpreadsheet_();

  const master = getOrCreateSheet_(ss, CONFIG.SHEET_MASTER, CONFIG.HEADERS_MASTER);
  const log = getOrCreateSheet_(ss, CONFIG.SHEET_LOG, CONFIG.HEADERS_LOG);
  const config = getOrCreateSheet_(ss, CONFIG.SHEET_CONFIG, CONFIG.HEADERS_CONFIG);

  if (master.getLastRow() < 2) seedParticipants_(master);
  ensureConfigDefaults_();

  return { ss: ss, master: master, log: log, config: config };
}

function seedParticipants_(sheet) {
  const rows = [];
  for (let i = 1; i <= CONFIG.SEED_COUNT; i++) {
    rows.push([i, 'Peserta ' + i]);
  }
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

/* ------------------------------ KONFIGURASI ------------------------------- */

function configDefaults_() {
  return {
    FOLDER_DRIVE_ID: '',
    NO_WA_GURU: '',
    FONNTE_TOKEN: '',
    KIRIM_FOTO_WA: 'tidak',
    KIRIM_TEKS_REKAP: 'tidak',
    KIRIM_XLSX: 'ya',
    COMPRESSO_TOKEN: '',
    KOMPRES_FOTO: 'ya',
    TARGET_WA: 'nomor',
    NAMA_GRUP_WA: 'Kelas Kebekerjaan LN',
    ID_GRUP_WA: '',
    PUBLIK_ALASAN: 'ya',
    PUBLIK_FOTO: 'tidak',
    PUBLIK_HARI: String(CONFIG.PUBLIC_DAYS),
    CACHE_DAFTAR_DETIK: String(CONFIG.LIST_CACHE_SECONDS),
    JAM_TUTUP: '10:00',          // batas akhir pengisian (HH:MM WIB)
    JAM_TEPAT_WAKTU: '08:00',   // batas tepat waktu (HH:MM WIB)
    MODE_UJI: 'tidak',
    HARI_AKTIF: CONFIG.DEFAULT_ACTIVE_DAYS,
    TANGGAL_LIBUR: '',
    LAST_WA_SENT_DATE: '',
    LAST_REPORT_SENT_DATE: '',
    LAST_WA_STATUS: '',
    LAST_CLOSING_DATE: ''
  };
}

/** Baca seluruh isi sheet Konfigurasi menjadi objek key-value. */
function getConfigMap_() {
  const sheet = getSheet_(CONFIG.SHEET_CONFIG);
  const lastRow = sheet.getLastRow();
  const map = {};

  if (lastRow < 2) return map;

  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  values.forEach(function (row) {
    const key = String(row[0] == null ? '' : row[0]).trim();
    if (key) map[key] = String(row[1] == null ? '' : row[1]).trim();
  });

  return map;
}

/** Tambahkan key yang belum ada tanpa menimpa nilai yang sudah diisi. */
function ensureConfigDefaults_() {
  const sheet = getSheet_(CONFIG.SHEET_CONFIG);
  const map = getConfigMap_();
  const defaults = configDefaults_();

  Object.keys(defaults).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) {
      sheet.appendRow([key, defaults[key]]);
      map[key] = defaults[key];
    }
  });

  // Migrasi v2 - sekali saja. Versi lama mengirim 1 teks + 1 pesan per foto;
  // sekarang cukup satu file XLSX per hari.
  if (!Object.prototype.hasOwnProperty.call(map, 'MIGRASI_V2')) {
    const v2 = {
      MIGRASI_V2: 'selesai',
      KIRIM_FOTO_WA: 'tidak',
      KIRIM_TEKS_REKAP: 'tidak',
      KIRIM_XLSX: 'ya',
      TARGET_WA: 'nomor'
    };

    setConfigValues_(v2);
    Object.keys(v2).forEach(function (key) { map[key] = v2[key]; });
    Logger.log('Migrasi v2 diterapkan: rekap harian berupa satu file XLSX.');
  }

  return map;
}

/** Simpan/perbarui beberapa key sekaligus. */
function setConfigValues_(values) {
  if (!values) return;

  const sheet = getSheet_(CONFIG.SHEET_CONFIG);
  const lastRow = sheet.getLastRow();
  const rowByKey = {};

  if (lastRow >= 2) {
    const keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    keys.forEach(function (row, index) {
      const key = String(row[0] == null ? '' : row[0]).trim();
      if (key) rowByKey[key] = index + 2;
    });
  }

  Object.keys(values).forEach(function (key) {
    const value = values[key] == null ? '' : String(values[key]);
    if (rowByKey[key]) {
      sheet.getRange(rowByKey[key], 2).setValue(value);
    } else {
      sheet.appendRow([key, value]);
      rowByKey[key] = sheet.getLastRow();
    }
  });
}

/** Helper manual dari editor: setKonfigurasi('NO_WA_GURU', '62812...') */
function setKonfigurasi(key, value) {
  if (!key) throw new Error('Key konfigurasi wajib diisi.');
  setConfigValues_({ [key]: value });
  Logger.log('Konfigurasi disimpan: ' + key + ' = ' + value);
  return getConfigMap_();
}

function lihatKonfigurasi() {
  const map = getConfigMap_();
  Logger.log(JSON.stringify(map, null, 2));
  return map;
}

/**
 * Hapus sisa baris konfigurasi Telegram dari sheet Konfigurasi.
 * Hanya menyentuh tiga key Telegram; konfigurasi lain tidak diubah.
 * Jalankan sekali bila proyek pernah mencoba integrasi Telegram.
 */
function hapusKonfigurasiTelegram() {
  const sheet = getSheet_(CONFIG.SHEET_CONFIG);
  const lastRow = sheet.getLastRow();
  const keys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'LAST_TELEGRAM_STATUS'];

  if (lastRow < 2) return { ok: true, removed: 0 };

  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let removed = 0;

  for (let i = values.length - 1; i >= 0; i--) {
    const key = String(values[i][0] == null ? '' : values[i][0]).trim();
    if (keys.indexOf(key) !== -1) {
      sheet.deleteRow(i + 2);
      removed++;
    }
  }

  Logger.log('Baris konfigurasi Telegram dihapus: ' + removed);
  return { ok: true, removed: removed };
}

/**
 * Perbaiki kolom Tanggal pada Log_Absensi.
 *
 * Baris lama mungkin tersimpan sebagai nilai Date karena sel tidak diformat
 * teks. Fungsi ini menormalkan semuanya ke `YYYY-MM-DD` sebagai teks dan
 * mengubah format kolom B menjadi teks. Idempoten: aman dijalankan berulang.
 */
function perbaikiTanggalLog() {
  const sheet = getSheet_(CONFIG.SHEET_LOG);
  const lastRow = sheet.getLastRow();
  const result = { ok: true, total: 0, diperbaiki: 0, contoh: [] };

  if (lastRow < 2) {
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  }

  const range = sheet.getRange(2, 2, lastRow - 1, 1);
  const values = range.getValues();

  const normalized = values.map(function (row) {
    const before = row[0];
    const after = toDateStr_(before);

    if (after && String(before) !== after) {
      result.diperbaiki++;
      if (result.contoh.length < 5) {
        result.contoh.push({ sebelum: String(before), sesudah: after });
      }
    }

    return [after || String(before == null ? '' : before).trim()];
  });

  range.setNumberFormat('@');
  range.setValues(normalized);
  SpreadsheetApp.flush();

  result.total = values.length;
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Hapus data uji: baris dengan Keterangan `[MODE UJI]` dan file `_UJI.jpg`.
 * Dipakai setelah pengujian selesai, sebelum sistem dipakai sungguhan.
 */
function hapusBarisUji() {
  const sheet = getSheet_(CONFIG.SHEET_LOG);
  const lastRow = sheet.getLastRow();
  const result = { ok: true, barisDihapus: 0, fileDihapus: 0, fileGagal: 0 };

  if (lastRow < 2) return result;

  const values = sheet.getRange(2, 1, lastRow - 1, CONFIG.HEADERS_LOG.length).getValues();

  for (let i = values.length - 1; i >= 0; i--) {
    const keterangan = String(values[i][5] == null ? '' : values[i][5]);
    if (keterangan.indexOf('[MODE UJI]') === -1) continue;

    const fileId = driveFileId_(values[i][6]);
    if (fileId) {
      try {
        DriveApp.getFileById(fileId).setTrashed(true);
        result.fileDihapus++;
      } catch (err) {
        result.fileGagal++;
        console.warn('File uji tidak dapat dihapus: ' + (err && err.message));
      }
    }

    sheet.deleteRow(i + 2);
    result.barisDihapus++;
  }

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/* --------------------------- DATA PESERTA & LOG ---------------------------- */

/** Daftar peserta unik dari Master_Peserta, urut sesuai sheet. */
function getParticipants_() {
  const sheet = getSheet_(CONFIG.SHEET_MASTER);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const seen = {};
  return sheet
    .getRange(2, 1, lastRow - 1, 2)
    .getValues()
    .map(function (row) {
      return { no: Number(row[0]) || 0, nama: String(row[1] == null ? '' : row[1]).trim() };
    })
    .filter(function (p) {
      if (!p.nama) return false;
      const key = normKey_(p.nama);
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
}

/**
 * Semua baris Log_Absensi untuk satu tanggal (YYYY-MM-DD).
 * Kolom A..G dibaca sekaligus agar tetap ringan.
 */
function getLogByDate_(dateStr) {
  const sheet = getSheet_(CONFIG.SHEET_LOG);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, CONFIG.HEADERS_LOG.length).getValues();
  const result = [];

  values.forEach(function (row) {
    // Kolom Tanggal bisa berupa Date (lihat toDateStr_), bukan selalu string.
    const tanggal = toDateStr_(row[1]);
    if (tanggal !== dateStr) return;

    const nama = String(row[2] == null ? '' : row[2]).trim();
    if (!nama) return;

    result.push({
      timestamp: row[0],
      tanggal: tanggal,
      nama: nama,
      status: String(row[3] == null ? '' : row[3]).trim(),
      terlambat: Number(row[4]) || 0,
      keterangan: String(row[5] == null ? '' : row[5]).trim(),
      link: String(row[6] == null ? '' : row[6]).trim()
    });
  });

  return result;
}

/**
 * Append satu baris log dengan kolom Tanggal dipaksa berformat teks,
 * supaya Sheets tidak mengubah "2026-11-18" menjadi nilai Date.
 */
function appendLogRow_(sheet, values) {
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 2).setNumberFormat('@');
  sheet.appendRow(values);
}

/* ========================================================================== */
/*                         GOOGLE DRIVE & VALIDASI FOTO                       */
/* ========================================================================== */

/** Nama file Drive yang aman: tanpa karakter terlarang, spasi -> garis bawah. */
function sanitizeFileName_(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|#%{}~&]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60);
}

/** Folder foto tahun berjalan, dibuat bila belum ada. */
function getOrCreatePhotoFolder_() {
  const folderName = CONFIG.FOLDER_PREFIX + ' ' +
    Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy');

  const existing = DriveApp.getFoldersByName(folderName);
  while (existing.hasNext()) {
    const candidate = existing.next();
    if (!candidate.isTrashed()) return candidate;
  }

  return DriveApp.createFolder(folderName);
}

/**
 * Folder tujuan foto. Memakai FOLDER_DRIVE_ID dari Konfigurasi bila valid;
 * bila tidak, folder dicari/dibuat lalu ID-nya disimpan kembali.
 */
function getPhotoFolder_(cfg) {
  const folderId = String((cfg && cfg.FOLDER_DRIVE_ID) || '').trim();

  if (folderId) {
    try {
      const folder = DriveApp.getFolderById(folderId);
      if (!folder.isTrashed()) return folder;
    } catch (err) {
      console.warn('FOLDER_DRIVE_ID tidak valid, membuat folder baru: ' + err.message);
    }
  }

  const folder = getOrCreatePhotoFolder_();
  setConfigValues_({ FOLDER_DRIVE_ID: folder.getId() });
  return folder;
}

/** Buang prefix data URL dan seluruh whitespace dari string base64. */
function extractBase64_(input) {
  return String(input == null ? '' : input)
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s+/g, '');
}

/**
 * Validasi ketat foto: harus base64 JPEG yang benar-benar gambar.
 * Mengembalikan Byte[] siap dipakai Utilities.newBlob().
 */
function decodeAndValidatePhoto_(base64Input) {
  const clean = extractBase64_(base64Input);

  if (!clean) {
    throw new AppError(
      'INVALID_PHOTO',
      'Foto kehadiran wajib diambil langsung dari kamera sebelum mengirim absensi.'
    );
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    throw new AppError('INVALID_PHOTO', 'Data foto tidak valid. Silakan ambil ulang foto.');
  }

  // Estimasi ukuran hasil decode (base64 membengkak ~4/3).
  const estimatedBytes = Math.ceil(clean.length * 3 / 4);
  if (estimatedBytes > CONFIG.MAX_PHOTO_BYTES) {
    throw new AppError(
      'PHOTO_TOO_LARGE',
      'Ukuran foto terlalu besar (maksimal ' +
      Math.round(CONFIG.MAX_PHOTO_BYTES / (1024 * 1024)) +
      ' MB). Silakan ambil ulang foto.'
    );
  }

  let bytes;
  try {
    bytes = Utilities.base64Decode(clean);
  } catch (err) {
    throw new AppError('INVALID_PHOTO', 'Data foto tidak dapat dibaca. Silakan ambil ulang foto.');
  }

  // JPEG selalu diawali FF D8 FF.
  const isJpeg = bytes.length > 4 &&
    (bytes[0] & 0xFF) === 0xFF &&
    (bytes[1] & 0xFF) === 0xD8 &&
    (bytes[2] & 0xFF) === 0xFF;

  if (!isJpeg) {
    throw new AppError('INVALID_PHOTO', 'Format foto harus JPEG. Silakan ambil ulang foto.');
  }

  return bytes;
}

/* ========================================================================== */
/*                       KOMPRESI FOTO (API COMPRESSO)                        */
/* ========================================================================== */

/** Apakah byte diawali penanda JPEG (FF D8 FF)? */
function isJpegBytes_(bytes) {
  return !!bytes && bytes.length > 4 &&
    (bytes[0] & 0xFF) === 0xFF &&
    (bytes[1] & 0xFF) === 0xD8 &&
    (bytes[2] & 0xFF) === 0xFF;
}

/**
 * Satu permintaan kompresi ke Compresso.
 * Body = byte gambar mentah; respons = biner gambar terkompresi.
 * Retry hanya bila 429/503 membawa Retry-After <= 30 detik.
 */
function compressWithCompresso_(bytes, token) {
  const request = function () {
    return UrlFetchApp.fetch(CONFIG.COMPRESSO_ENDPOINT, {
      method: 'post',
      contentType: 'image/jpeg',
      payload: bytes,
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
  };

  let response;

  try {
    response = request();
  } catch (err) {
    return { ok: false, httpStatus: 0, message: err && err.message ? err.message : String(err) };
  }

  const firstCode = response.getResponseCode();

  if (firstCode === 429 || firstCode === 503) {
    let retryAfter = 0;

    try {
      const headers = response.getAllHeaders ? response.getAllHeaders() : {};
      retryAfter = Number(headers['Retry-After'] || headers['retry-after'] || 0);
    } catch (err) {
      retryAfter = 0;
    }

    if (retryAfter > 0 && retryAfter <= 30) {
      Utilities.sleep(retryAfter * 1000);
      try {
        response = request();
      } catch (err) {
        return { ok: false, httpStatus: 0, message: err && err.message ? err.message : String(err) };
      }
    }
  }

  const code = response.getResponseCode();

  if (code !== 200) {
    let detail = 'HTTP ' + code;

    try {
      const body = response.getContentText() || '';
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (err) { parsed = null; }
      if (parsed && parsed.error) {
        detail = String(parsed.error) + (parsed.message ? ': ' + parsed.message : '');
      } else if (body) {
        detail = ('HTTP ' + code + ': ' + body).slice(0, 300);
      }
    } catch (err) {
      // biarkan detail apa adanya
    }

    return { ok: false, httpStatus: code, message: detail };
  }

  let out;

  try {
    out = response.getBlob().getBytes();
  } catch (err) {
    return { ok: false, httpStatus: code, message: 'Respons kompresi tidak dapat dibaca.' };
  }

  if (!isJpegBytes_(out) || out.length < 1024) {
    return { ok: false, httpStatus: code, message: 'Respons kompresi bukan JPEG yang valid.' };
  }

  return { ok: true, httpStatus: code, bytes: out };
}

/**
 * Kompresi foto sebelum disimpan ke Drive.
 * Selalu mengembalikan byte yang aman dipakai: bila gagal, foto asli.
 *
 * @return {{bytes: Byte[], info: Object}}
 */
function kompresFoto_(bytes, cfg) {
  const before = bytes.length;
  const info = {
    aktif: false,
    sebelum: before,
    sesudah: before,
    hemat: 0,
    pesan: ''
  };

  const token = String((cfg && cfg.COMPRESSO_TOKEN) || '').trim();

  if (!isEnabled_(cfg && cfg.KOMPRES_FOTO)) {
    info.pesan = 'KOMPRES_FOTO tidak aktif.';
    return { bytes: bytes, info: info };
  }

  if (!token) {
    info.pesan = 'COMPRESSO_TOKEN belum diisi.';
    return { bytes: bytes, info: info };
  }

  info.aktif = true;
  const result = compressWithCompresso_(bytes, token);

  if (!result.ok) {
    info.pesan = result.message;
    console.warn('Kompresi dilewati: ' + result.message);
    return { bytes: bytes, info: info };
  }

  if (result.bytes.length >= before) {
    info.pesan = 'Hasil kompresi tidak lebih kecil; foto asli dipakai.';
    return { bytes: bytes, info: info };
  }

  info.sesudah = result.bytes.length;
  info.hemat = before - result.bytes.length;
  info.pesan = 'Foto dikompresi.';

  return { bytes: result.bytes, info: info };
}

/** Cek sisa kuota Compresso hari ini (tidak memakai kuota). */
function cekKuotaCompresso() {
  const cfg = getConfigMap_();
  const token = String(cfg.COMPRESSO_TOKEN || '').trim();

  if (!token) {
    throw new Error('Isi COMPRESSO_TOKEN pada sheet Konfigurasi terlebih dahulu.');
  }

  const response = UrlFetchApp.fetch(CONFIG.COMPRESSO_USAGE, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });

  const body = response.getContentText() || '';
  let parsed = null;
  try { parsed = JSON.parse(body); } catch (err) { parsed = null; }

  const info = {
    httpStatus: response.getResponseCode(),
    kuota: parsed || body.slice(0, 300),
    waktuServer: nowWib_().dateStr + ' ' + nowWib_().timeLabel + ' WIB'
  };

  Logger.log(JSON.stringify(info, null, 2));
  return info;
}

/* ========================================================================== */
/*                            DATA BOOTSTRAP UI                               */
/* ========================================================================== */

/**
 * Seluruh data awal yang dibutuhkan halaman absensi.
 * Tidak pernah memuat token/nomor WA - hanya penanda boolean.
 */
function getBootstrapData() {
  try {
    ensureSheets_();

    const cfg = getConfigMap_();
    const wib = nowWib_(cfg);
    const activeInfo = resolveActiveDay_(wib, cfg);
    const participants = getParticipants_();
    const todayLog = getLogByDate_(wib.dateStr);

    const submittedMap = {};
    todayLog.forEach(function (row) {
      submittedMap[normKey_(row.nama)] = row.status;
    });

    const enriched = participants.map(function (p) {
      const key = normKey_(p.nama);
      return {
        no: p.no,
        nama: p.nama,
        sudahAbsen: Object.prototype.hasOwnProperty.call(submittedMap, key),
        statusHariIni: submittedMap[key] || null
      };
    });

    const isCutoff = wib.isPastCutoff;
    const testMode = isTestMode_(cfg);
    const normalClosedReason = !activeInfo.isActive
      ? activeInfo.reason
      : (isCutoff ? 'cutoff' : null);
    // MODE UJI membuka form kapan pun agar alur dapat diuji di luar jam kerja.
    const closedReason = testMode ? null : normalClosedReason;

    return {
      ok: true,
      data: {
        serverTimeWIB: {
          iso: new Date(wib.epochMs).toISOString(),
          formatted:
            pad2_(wib.day) + '/' + pad2_(wib.month) + '/' + wib.year +
            ' ' + wib.timeLabel,
          timeLabel: wib.timeLabel,
          epochMs: wib.epochMs,
          secondsOfDay: wib.secondsOfDay,
          timezone: CONFIG.TIMEZONE
        },
        today: {
          tanggal: wib.dateStr,
          label: dateLabel_(wib.dateStr),
          dayOfWeek: wib.dayOfWeek
        },
        isActiveDay: activeInfo.isActive,
        activeDaysLabel: activeDaysLabel_(cfg),
        cutoff: { label: cutoffLabel_(cfg), epochMs: wib.cutoffEpochMs },
        onTime: { label: onTimeLabel_(cfg) },
        isClosed: !!closedReason,
        closedReason: closedReason,
        normalClosedReason: normalClosedReason,
        testMode: testMode,
        holidays: normalizeDateList_(cfg.TANGGAL_LIBUR),
        participants: participants.map(function (p) { return p.nama; }),
        participantDetails: enriched,
        submittedToday: todayLog.map(function (row) { return row.nama; }),
        stats: {
          total: participants.length,
          submitted: todayLog.length
        },
        reportConfigured: !!String(cfg.NO_WA_GURU || '').trim() &&
          !!String(cfg.FONNTE_TOKEN || '').trim(),
        photoDelivery: {
          whatsappImages: isEnabled_(cfg.KIRIM_FOTO_WA),
          xlsxRekap: isEnabled_(cfg.KIRIM_XLSX)
        }
      }
    };
  } catch (err) {
    return fail_(err);
  }
}

/**
 * Daftar absensi untuk halaman publik.
 *
 * Menampilkan hari ini dan 6 hari sebelumnya. Alasan Izin/Sakit ikut dikirim
 * bila PUBLIK_ALASAN = ya. Hanya nama, status, waktu, alasan, dan foto yang
 * ditampilkan - token dan nomor WhatsApp tidak pernah ikut.
 *
 * @param {string=} dateStr `YYYY-MM-DD`; di luar rentang 7 hari akan
 *                          dikembalikan ke hari ini.
 */
function getAttendanceList(dateStr) {
  try {
    ensureSheets_();
    const cfg = getConfigMap_();
    const wib = nowWib_(cfg);
    const publicHari = cfgInt_(cfg, 'PUBLIK_HARI', CONFIG.PUBLIC_DAYS);
    const listCacheSeconds = cfgInt_(cfg, 'CACHE_DAFTAR_DETIK', CONFIG.LIST_CACHE_SECONDS);

    const today = wib.dateStr;
    const earliest = shiftDateStr_(today, -(publicHari - 1));

    let target = toDateStr_(dateStr || today);
    if (!target || target > today || target < earliest) target = today;

    const showReason = isEnabled_(cfg.PUBLIK_ALASAN);
    const showPhoto = isEnabled_(cfg.PUBLIK_FOTO);
    const cacheKey = 'list:' + target + ':' + (showReason ? '1' : '0') + ':' + (showPhoto ? '1' : '0');

    let cache = null;
    try { cache = CacheService.getScriptCache(); } catch (err) { cache = null; }

    if (cache) {
      const cached = cache.get(cacheKey);
      if (cached) {
        try { return { ok: true, data: JSON.parse(cached), cached: true }; } catch (err) { /* lanjut hitung */ }
      }
    }

    const participants = getParticipants_();
    const logRows = getLogByDate_(target);

    const byName = {};
    logRows.forEach(function (row) { byName[normKey_(row.nama)] = row; });

    const isToday = target === today;
    const belumTutup = isToday && !wib.isPastCutoff;

    const stats = { total: participants.length, hadir: 0, izin: 0, sakit: 0, alpha: 0, belum: 0 };
    const rows = [];

    participants.forEach(function (p, index) {
      const row = byName[normKey_(p.nama)];

      let status;
      if (row) status = row.status;
      else if (belumTutup) status = 'Belum';
      else status = 'Alpha';

      if (status === 'Hadir') stats.hadir++;
      else if (status === 'Izin') stats.izin++;
      else if (status === 'Sakit') stats.sakit++;
      else if (status === 'Belum') stats.belum++;
      else stats.alpha++;

      const link = row ? row.link : '';
      const fileId = driveFileId_(link);
      const hasPhoto = !!fileId && link.indexOf('http') === 0;
      const fotoUrlFinal = showPhoto ? (hasPhoto ? link : '') : '';
      const fotoThumbFinal = showPhoto ? (hasPhoto ? driveThumbUrl_(fileId, 600) : '') : '';

      rows.push({
        no: index + 1,
        nama: p.nama,
        status: status,
        jam: row ? formatLogTime_(row.timestamp) : '-',
        terlambat: row ? (Number(row.terlambat) || 0) : 0,
        keterangan: row && showReason && row.keterangan !== '-' ? row.keterangan : '',
        fotoUrl: fotoUrlFinal,
        fotoThumb: fotoThumbFinal
      });
    });

    const dates = [];
    for (let i = 0; i < publicHari; i++) {
      const value = shiftDateStr_(today, -i);
      dates.push({ value: value, label: dateLabel_(value) });
    }

    let xlsxUrl = '';
    if (isEnabled_(cfg.KIRIM_XLSX)) {
      const xlsx = findDailyXlsx_(target, cfg);
      xlsxUrl = xlsx ? xlsx.url : '';
    }

    const data = {
      tanggal: target,
      label: dateLabel_(target),
      hariIni: isToday,
      sudahTutup: !belumTutup,
      modeUji: isTestMode_(cfg),
      showPhoto: showPhoto,
      jumlahFoto: logRows.filter(function (row) { return !!driveFileId_(row.link); }).length,
      stats: stats,
      rows: rows,
      dates: dates,
      xlsxUrl: xlsxUrl,
      catatan:
        'Daftar ini bersifat publik: nama, status, waktu, alasan, dan foto ' +
        'dapat dilihat siapa pun yang memiliki tautan.' +
        (showPhoto ? '' : ' Foto disembunyikan berdasarkan PUBLIK_FOTO=tidak.')
    };

    if (cache) {
      try { cache.put(cacheKey, JSON.stringify(data), listCacheSeconds); } catch (err) { /* abaikan */ }
    }

    return { ok: true, data: data };
  } catch (err) {
    return fail_(err);
  }
}

/* ========================================================================== */
/*                               ENDPOINT HTTP                                */
/* ========================================================================== */

/**
 * doGet:
 *   ?api=1  -> JSON (dipakai hosting statis / integrasi lain)
 *   lainnya -> halaman aplikasi absensi
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = String(params.action || '').toLowerCase();
  const isApi = params.api === '1' || action === 'bootstrap' || action === 'list';

  if (isApi) {
    if (action === 'list') {
      return jsonOutput_(getAttendanceList(params.date));
    }

    return jsonOutput_(getBootstrapData());
  }

  return HtmlService
    .createHtmlOutputFromFile('index')
    .setTitle('Absensi Kehadiran')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * doPost: endpoint submit untuk frontend yang di-hosting statis.
 * Body JSON dikirim sebagai text/plain agar tidak memicu preflight CORS.
 */
function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '';
    const params = (e && e.parameter) || {};

    let body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch (err) {
        body = {};
      }
    }

    let payload = body && body.payload ? body.payload : params.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch (err) {
        payload = null;
      }
    }

    if (!payload && params.nama) {
      payload = {
        nama: params.nama,
        status: params.status,
        keterangan: params.keterangan,
        fotoBase64: params.fotoBase64
      };
    }

    return jsonOutput_(submitAttendance(payload));
  } catch (err) {
    return jsonOutput_(fail_(err));
  }
}

/* ========================================================================== */
/*                             SUBMIT ABSENSI                                 */
/* ========================================================================== */

/** Jam (HH:mm) dari nilai Timestamp di sheet, dalam WIB. */
function formatLogTime_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, CONFIG.TIMEZONE, 'HH:mm');
  }
  const text = String(value == null ? '' : value).trim();
  if (!text) return '-';
  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, CONFIG.TIMEZONE, 'HH:mm');
  }
  return text;
}

/**
 * Inti pencatatan absensi.
 *
 * Alur (semua di dalam satu script lock):
 *   1. Validasi bentuk payload          (tanpa akses sheet)
 *   2. Ambil lock                       (anti race condition)
 *   3. Cek hari aktif + batas 10:00 WIB (waktu request, bukan waktu klien)
 *   4. Cek nama terdaftar + belum absen hari ini
 *   5. Hitung keterlambatan
 *   6. Simpan foto ke Drive             (ANYONE_WITH_LINK / VIEW)
 *   7. Append baris ke Log_Absensi
 *
 * Waktu request diambil SEBELUM menunggu lock, sehingga pengguna yang menekan
 * tombol pada 09:59:58 tetap dilayani dengan benar meskipun penulisan sheet
 * baru selesai setelah pukul 10:00.
 */
function submitAttendance(payload) {
  let lock = null;

  try {
    // Konfigurasi dibaca awal agar batas tepat waktu/cutoff memakai nilai
    // terbaru dari sheet Konfigurasi. Bila sheet belum siap, nilai bawaan
    // (CONFIG) yang dipakai.
    let cfgAwal = null;
    try { cfgAwal = getConfigMap_(); } catch (errCfg) { cfgAwal = null; }

    const requestWib = nowWib_(cfgAwal);

    if (!payload || typeof payload !== 'object') {
      throw new AppError('INVALID_PAYLOAD', 'Data absensi tidak lengkap. Silakan muat ulang halaman.');
    }

    /* ------------------------- 1. Validasi payload ------------------------ */

    const namaInput = String(payload.nama == null ? '' : payload.nama)
      .replace(/\s+/g, ' ')
      .trim();

    if (!namaInput) {
      throw new AppError('INVALID_NAME', 'Silakan pilih nama peserta terlebih dahulu.');
    }
    if (namaInput.length > CONFIG.MAX_NAME_LENGTH) {
      throw new AppError('INVALID_NAME', 'Nama peserta terlalu panjang.');
    }

    const status = String(payload.status == null ? '' : payload.status).trim();
    if (CONFIG.STATUS_LIST.indexOf(status) === -1) {
      throw new AppError('INVALID_STATUS', 'Status kehadiran tidak valid. Pilih Hadir, Izin, atau Sakit.');
    }

    let keterangan = String(payload.keterangan == null ? '' : payload.keterangan)
      .replace(/\s+/g, ' ')
      .trim();

    // Hitung keterlambatan lebih dulu: Hadir setelah 08:00 WIB wajib alasan.
    const terlambat = status === 'Hadir' ? calculateLateness_(requestWib, cfgAwal) : 0;

    if (status === 'Hadir') {
      if (terlambat > 0) {
        if (keterangan.length < 3) {
          throw new AppError(
            'REASON_REQUIRED',
            'Keterangan wajib diisi minimal 3 karakter karena absen telat setelah pukul ' + onTimeLabel_(cfgAwal) + ' WIB.'
          );
        }
        if (keterangan.length > CONFIG.MAX_REASON_LENGTH) {
          keterangan = keterangan.slice(0, CONFIG.MAX_REASON_LENGTH);
        }
      } else {
        keterangan = '-';
      }
    } else {
      if (keterangan.length < 3) {
        throw new AppError(
          'MISSING_REASON',
          'Keterangan wajib diisi minimal 3 karakter untuk status ' + status + '.'
        );
      }
      if (keterangan.length > CONFIG.MAX_REASON_LENGTH) {
        keterangan = keterangan.slice(0, CONFIG.MAX_REASON_LENGTH);
      }
    }

    const photoBytes = decodeAndValidatePhoto_(payload.fotoBase64);

    /* ---------------------------- 2. Ambil lock --------------------------- */

    lock = LockService.getScriptLock();
    if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
      throw new AppError(
        'BUSY',
        'Server sedang memproses absensi lain. Silakan coba lagi dalam beberapa detik.'
      );
    }

    // Inisialisasi sheet di dalam lock agar dua permintaan pertama tidak
    // berlomba membuat baris konfigurasi/seed yang sama.
    ensureSheets_();

    /* --------------------- 3. Cek hari aktif & cutoff --------------------- */

    const cfg = getConfigMap_();
    // Samakan status cutoff bila konfigurasi berubah sejak request diterima.
    requestWib.isPastCutoff = requestWib.secondsOfDay >= cutoffSeconds_(cfg);
    requestWib.cutoffEpochMs = requestWib.dayStartEpochMs + cutoffSeconds_(cfg) * 1000;
    const activeInfo = resolveActiveDay_(requestWib, cfg);
    const testMode = isTestMode_(cfg);

    if (!testMode && !activeInfo.isActive) {
      throw new AppError(
        'INACTIVE_DAY',
        activeInfo.reason === 'holiday'
          ? 'Hari ini libur, tidak ada absensi.'
          : 'Hari ini bukan hari absensi. Absensi hanya dibuka pada ' +
            activeDaysLabel_(cfg) + '.'
      );
    }

    if (!testMode && requestWib.isPastCutoff) {
      throw new AppError(
        'CLOSED',
        'Absensi hari ini sudah ditutup. Batas waktu pengisian pukul ' +
        cutoffLabel_(cfg) + ' WIB telah berakhir.'
      );
    }

    /* -------------------- 4. Validasi nama & duplikasi -------------------- */

    const participants = getParticipants_();
    const canonical = participants.filter(function (p) {
      return normKey_(p.nama) === normKey_(namaInput);
    })[0];

    if (!canonical) {
      throw new AppError(
        'INVALID_NAME',
        'Nama "' + namaInput + '" tidak terdaftar pada Master_Peserta. Hubungi guru Anda.'
      );
    }

    const todayLog = getLogByDate_(requestWib.dateStr);
    const duplicate = todayLog.filter(function (row) {
      return normKey_(row.nama) === normKey_(canonical.nama);
    })[0];

    if (duplicate) {
      throw new AppError(
        'DUPLICATE',
        'Absensi atas nama ' + canonical.nama + ' sudah tercatat hari ini pukul ' +
        formatLogTime_(duplicate.timestamp) + ' WIB. Setiap peserta hanya dapat mengisi sekali per hari.'
      );
    }

    /* ---------------------- 5. Hitung keterlambatan ---------------------- */

    // `terlambat` sudah dihitung pada blok validasi di atas.

    // Baris hasil pengujian ditandai agar mudah dibedakan (dan dihapus) nanti.
    const keteranganFinal = testMode
      ? ('[MODE UJI] ' + keterangan).slice(0, CONFIG.MAX_REASON_LENGTH)
      : keterangan;

    /* -------------------------- 6. Simpan foto --------------------------- */

    // Kompresi dilakukan sebelum file dibuat, sehingga foto besar tidak
    // pernah tersimpan ke Drive. Gagal kompresi = pakai foto asli.
    const compressed = kompresFoto_(photoBytes, cfg);

    const folder = getPhotoFolder_(cfg);
    const fileName = requestWib.dateStr + '_' +
      sanitizeFileName_(canonical.nama) + '_' + status +
      (testMode ? '_UJI' : '') + '.jpg';

    let file;
    try {
      file = folder.createFile(Utilities.newBlob(compressed.bytes, 'image/jpeg', fileName));
    } catch (err) {
      console.error('Gagal menyimpan foto: ' + (err && err.message));
      throw new AppError(
        'DRIVE_ERROR',
        'Foto gagal disimpan ke Google Drive. Silakan coba lagi.'
      );
    }

    let sharingWarning = null;
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (err) {
      sharingWarning =
        'Foto tersimpan, namun tautan publik tidak dapat diaktifkan karena kebijakan berbagi Google Drive.';
      console.warn(sharingWarning + ' ' + (err && err.message));
    }

    try {
      file.setDescription(
        'Absensi ' + canonical.nama + ' - ' + requestWib.dateStr +
        ' - ' + status + (terlambat > 0 ? ' (' + terlambat + ' menit terlambat)' : '')
      );
    } catch (err) {
      // Deskripsi hanya pelengkap; kegagalan di sini tidak menggagalkan absensi.
    }

    const photoUrl = file.getUrl();

    /* ------------------------ 7. Tulis Log_Absensi ------------------------ */

    const timestamp = new Date();
    const sheet = getSheet_(CONFIG.SHEET_LOG);

    appendLogRow_(sheet, [
      timestamp,
      requestWib.dateStr,
      canonical.nama,
      status,
      terlambat,
      keteranganFinal,
      photoUrl
    ]);

    sheet.getRange(sheet.getLastRow(), 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    SpreadsheetApp.flush();

    const formattedTimestamp =
      Utilities.formatDate(timestamp, CONFIG.TIMEZONE, 'dd/MM/yyyy HH:mm:ss') + ' WIB';

    return {
      ok: true,
      data: {
        nama: canonical.nama,
        status: status,
        tanggal: requestWib.dateStr,
        tanggalLabel: dateLabel_(requestWib.dateStr),
        jam: Utilities.formatDate(timestamp, CONFIG.TIMEZONE, 'HH:mm:ss'),
        timestampFormatted: formattedTimestamp,
        terlambatMenit: terlambat,
        isTerlambat: status === 'Hadir' && terlambat > 0,
        keterangan: keteranganFinal,
        fotoUrl: photoUrl,
        modeUji: testMode,
        kompresi: compressed.info,
        warning: sharingWarning,
        pesan: (status === 'Hadir'
          ? (terlambat > 0
              ? 'Absensi tercatat. Anda terlambat ' + terlambat + ' menit.'
              : 'Absensi tercatat tepat waktu. Terima kasih!')
          : 'Absensi tercatat dengan status ' + status + '. Terima kasih!') +
          (testMode ? ' Data ini ditandai MODE UJI.' : '')
      }
    };
  } catch (err) {
    return fail_(err);
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (err) { /* diabaikan */ }
    }
  }
}

/* ========================================================================== */
/*                     PENUTUPAN HARIAN & REKAP WHATSAPP                      */
/* ========================================================================== */

/**
 * Trigger harian pukul 10:00 WIB.
 * Menandai peserta yang belum mengisi sebagai Alpha lalu mengirim rekap WA.
 */
function processDailyClosingAndSendWA() {
  return runDailyClosing_(false);
}

/** Jalankan penutupan manual dari editor/menu (tidak mengirim ulang bila sudah). */
function manualCloseToday() {
  return runDailyClosing_(false);
}

/** Kirim ulang rekap hari ini ke WhatsApp guru (paksa kirim). */
function resendWhatsAppReport() {
  return runDailyClosing_(true);
}

/**
 * @param {boolean} forceSend true = kirim WA meskipun sudah pernah dikirim hari ini.
 */
function runDailyClosing_(forceSend) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    Logger.log('Penutupan dilewati: gagal memperoleh script lock.');
    return { ok: false, code: 'BUSY', message: 'Gagal memperoleh lock. Coba lagi.' };
  }

  try {
    ensureSheets_();

    // Sinkronkan trigger harian dengan JAM_TUTUP terbaru (bisa berubah
    // setelah trigger dipasang) agar jam kirim otomatis mengikuti konfigurasi.
    const triggerSync = ensureDailyTrigger_();

    let cfg = getConfigMap_();
    let wib = nowWib_(cfg);

    if (triggerSync.changed) {
      Logger.log('Trigger harian disesuaikan ke ' + triggerSync.hour + ':' +
        pad2_(triggerSync.minute) + ' WIB.');
    }
    const activeInfo = resolveActiveDay_(wib, cfg);

    if (isTestMode_(cfg)) {
      Logger.log('Penutupan dilewati: MODE_UJI aktif.');
      return {
        ok: true,
        skipped: true,
        reason: 'test_mode',
        message: 'MODE_UJI aktif, jadi penutupan otomatis dilewati agar tidak menulis baris Alpha ' +
          'selama pengujian. Gunakan ujiKirimRekap() untuk menguji pengiriman laporan, ' +
          'lalu set MODE_UJI = tidak untuk operasional.'
      };
    }

    if (!activeInfo.isActive) {
      Logger.log('Penutupan dilewati: hari tidak aktif (' + activeInfo.reason + ').');
      return {
        ok: true,
        skipped: true,
        reason: activeInfo.reason,
        message: 'Hari ini bukan hari absensi (' + activeInfo.reason + '). Tidak ada Alpha maupun laporan.'
      };
    }

    /*
     * Trigger timeBased bisa menyala sedikit lebih awal. Bila itu terjadi,
     * tunggu sampai batas 10:00 WIB agar tidak menandai Alpha terlalu dini.
     */
    const cutoffSec = cutoffSeconds_(cfg);
    if (wib.secondsOfDay < cutoffSec) {
      const waitMs = (cutoffSec - wib.secondsOfDay) * 1000 + 1000;
      if (waitMs <= 120000) {
        Utilities.sleep(waitMs);
        wib = nowWib_(cfg);
      }
    }

    const dateStr = wib.dateStr;
    const participants = getParticipants_();

    /* ------------------- Tandai peserta yang belum mengisi ------------------ */

    const existingLog = getLogByDate_(dateStr);
    const alreadyLogged = {};
    existingLog.forEach(function (row) {
      alreadyLogged[normKey_(row.nama)] = true;
    });

    const missing = participants.filter(function (p) {
      return !alreadyLogged[normKey_(p.nama)];
    });

    if (missing.length) {
      const sheet = getSheet_(CONFIG.SHEET_LOG);
      const now = new Date();

      missing.forEach(function (p) {
        appendLogRow_(sheet, [
          now,
          dateStr,
          p.nama,
          'Alpha',
          0,
          'Tidak mengisi absensi hingga pukul ' + cutoffLabel_(cfg),
          '-'
        ]);
      });

      const startRow = sheet.getLastRow() - missing.length + 1;
      sheet.getRange(startRow, 1, missing.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
      SpreadsheetApp.flush();
    }

    /* ----------------------------- Susun rekap ----------------------------- */

    const finalLog = getLogByDate_(dateStr);
    const report = buildWaReport_(dateStr, participants, finalLog, cfg);

    /* ------------------------- Kirim laporan ------------------------- */

    const alreadySent = String(cfg.LAST_WA_SENT_DATE || '') === dateStr ||
      String(cfg.LAST_REPORT_SENT_DATE || '') === dateStr;

    let delivery;

    if (alreadySent && !forceSend) {
      const note = 'Laporan tanggal ini sudah dikirim sebelumnya. ' +
        'Gunakan resendWhatsAppReport() bila ingin mengirim ulang.';
      delivery = {
        dateStr: dateStr,
        skipped: true,
        message: note,
        photoCount: 0,
        whatsapp: { configured: true, sent: false, skipped: true, httpStatus: 0, message: note }
      };
    } else {
      delivery = deliverReport_(dateStr, report, cfg, {});

      const stamp = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
      const photoStats = delivery.whatsapp.photos;
      const photoNote = photoStats && !photoStats.skipped &&
          (photoStats.sent + photoStats.failed) > 0
        ? ' • foto ' + photoStats.sent + '/' + (photoStats.sent + photoStats.failed) +
          (photoStats.failed ? ' - ' + photoStats.message : '')
        : '';
      const xlsxNote = delivery.xlsx && delivery.xlsx.ok
        ? ' • XLSX ' + delivery.xlsx.name +
          (delivery.xlsx.gambar >= 0 ? ' (' + delivery.xlsx.gambar + ' foto)' : '')
        : '';

      const updates = {
        LAST_CLOSING_DATE: dateStr,
        LAST_WA_STATUS: delivery.whatsapp.configured
          ? (delivery.whatsapp.sent ? 'TERKIRIM ' : 'GAGAL ') + stamp + xlsxNote + photoNote +
            (delivery.whatsapp.sent ? '' : ' - ' + delivery.whatsapp.message)
          : 'LEWAT ' + stamp + ' - ' + delivery.whatsapp.message
      };

      if (delivery.whatsapp.sent) {
        updates.LAST_WA_SENT_DATE = dateStr;
        updates.LAST_REPORT_SENT_DATE = dateStr;
      }

      setConfigValues_(updates);
    }

    const summary = {
      ok: true,
      tanggal: dateStr,
      tanggalLabel: dateLabel_(dateStr),
      addedAlpha: missing.map(function (p) { return p.nama; }),
      counts: report.counts,
      skipped: !!delivery.skipped,
      message: delivery.message,
      photoCount: delivery.photoCount || 0,
      whatsapp: delivery.whatsapp,
      xlsx: delivery.xlsx,
      waMessage: report.text
    };

    Logger.log(JSON.stringify(summary, null, 2));
    return summary;
  } catch (err) {
    Logger.log('Penutupan gagal: ' + (err && err.stack ? err.stack : err));
    return {
      ok: false,
      code: 'CLOSING_ERROR',
      message: err && err.message ? err.message : String(err)
    };
  } finally {
    try { lock.releaseLock(); } catch (err) { /* diabaikan */ }
  }
}

/**
 * Menyusun teks rekap WhatsApp + ringkasan hitungan.
 * @return {{text: string, counts: Object}}
 */
function buildWaReport_(dateStr, participants, logRows, cfg) {
  const byName = {};
  logRows.forEach(function (row) {
    byName[normKey_(row.nama)] = row;
  });

  const counts = {
    total: participants.length,
    hadir: 0,
    tepatWaktu: 0,
    terlambat: 0,
    izin: 0,
    sakit: 0,
    alpha: 0
  };

  const detailBlocks = [];
  const dataRows = [];

  participants.forEach(function (p, index) {
    const row = byName[normKey_(p.nama)];
    const status = row ? row.status : 'Alpha';
    const late = row ? (Number(row.terlambat) || 0) : 0;
    const reason = row ? row.keterangan : '';
    const link = row ? row.link : '';
    const jam = row ? formatLogTime_(row.timestamp) : '-';

    dataRows.push({
      no: index + 1,
      nama: p.nama,
      status: status,
      jam: jam,
      terlambat: late,
      keterangan: reason && reason !== '-' ? reason : '',
      link: link,
      fileId: driveFileId_(link),
      tercatat: !!row
    });

    if (status === 'Hadir') {
      counts.hadir++;
      if (late > 0) counts.terlambat++; else counts.tepatWaktu++;
    } else if (status === 'Izin') {
      counts.izin++;
    } else if (status === 'Sakit') {
      counts.sakit++;
    } else {
      counts.alpha++;
    }

    const lines = [(index + 1) + '. ' + p.nama];

    if (status === 'Hadir') {
      lines.push(
        '   Hadir • ' + jam + ' WIB' +
        (late > 0 ? ' • terlambat ' + late + ' menit' : ' • tepat waktu')
      );
    } else if (status === 'Izin' || status === 'Sakit') {
      lines.push('   ' + status + ' • ' + jam + ' WIB');
      if (reason && reason !== '-') lines.push('   Alasan: ' + reason);
    } else {
      lines.push('   Alpha • tidak mengisi absensi');
    }

    if (link && /^https?:\/\//i.test(link)) {
      lines.push('   Foto: ' + link);
    }

    detailBlocks.push(lines.join('\n'));
  });

  const out = [];
  out.push('*LAPORAN ABSENSI HARIAN*');
  out.push(dateLabel_(dateStr));
  out.push('Batas pengisian: ' + cutoffLabel_(cfg) + ' WIB');
  out.push('');
  out.push('*RINGKASAN*');
  out.push('Total peserta: ' + counts.total);
  out.push(
    'Hadir: ' + counts.hadir +
    ' (' + counts.tepatWaktu + ' tepat waktu, ' + counts.terlambat + ' terlambat)'
  );
  out.push('Izin: ' + counts.izin);
  out.push('Sakit: ' + counts.sakit);
  out.push('Alpha: ' + counts.alpha);
  out.push('');
  out.push('*RINCIAN PESERTA*');
  out.push(detailBlocks.join('\n\n'));
  out.push('');
  out.push('_Pesan otomatis dari Sistem Absensi Digital._');

  return { text: out.join('\n'), counts: counts, rows: dataRows };
}

/* ========================================================================== */
/*                        REKAP HARIAN SEBAGAI FILE XLSX                      */
/* ========================================================================== */

/** Ekspor spreadsheet menjadi XLSX memakai endpoint export Google (OAuth). */
function exportSpreadsheetAsXlsx_(spreadsheetId, fileName) {
  const url = 'https://docs.google.com/spreadsheets/d/' +
    encodeURIComponent(spreadsheetId) + '/export?format=xlsx';

  const response = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
    followRedirects: true
  });

  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('Ekspor XLSX gagal (HTTP ' + code + ').');
  }

  const blob = response.getBlob();
  if (!blob || blob.getBytes().length < 1000) {
    throw new Error('Berkas XLSX kosong.');
  }

  // Biarkan content type bawaan dari Google Sheets export (biasanya
  // application/zip) agar Utilities.unzip tetap dapat membaca arsipnya.
  return blob.setName(fileName);
}

/**
 * Hitung gambar yang benar-benar ikut terekspor di dalam XLSX.
 * XLSX adalah arsip ZIP: gambar berada di `xl/media/`.
 * Mengembalikan 0 bila arsip tidak dapat dibaca (bukan -1 agar tidak
 * dianggap sebagai "belum ada gambar yang diekspor" saat retry).
 */
function countXlsxMedia_(blob) {
  try {
    // Buat blob sementara dengan content type application/zip untuk unzip operasi
    const zipBlob = Utilities.newBlob(blob.getBytes(), 'application/zip', blob.getName());
    const entries = Utilities.unzip(zipBlob);
    let count = 0;

    entries.forEach(function (entry) {
      const name = String(entry.getName() || '');
      if (/^xl\/media\/.+\.(png|jpe?g|gif|webp)$/i.test(name)) count++;
    });

    return count;
  } catch (err) {
    console.warn('Isi XLSX tidak dapat diperiksa: ' + (err && err.message));
    return 0;
  }
}

/** Hapus file dengan nama tertentu di folder (upsert). */
function deleteFolderFileByName_(folder, name) {
  const files = folder.getFilesByName(name);
  let deleted = 0;

  while (files.hasNext()) {
    const file = files.next();
    try {
      file.setTrashed(true);
      deleted++;
    } catch (err) {
      console.warn('File lama tidak dapat dihapus: ' + (err && err.message));
    }
  }

  return deleted;
}

/** Cari file XLSX harian yang sudah ada di folder. */
function findDailyXlsx_(dateStr, cfg) {
  const name = 'Absensi_' + dateStr + '.xlsx';

  try {
    const folder = getPhotoFolder_(cfg);
    const files = folder.getFilesByName(name);
    while (files.hasNext()) {
      const file = files.next();
      if (!file.isTrashed()) {
        return { fileId: file.getId(), url: file.getUrl(), name: name };
      }
    }
  } catch (err) {
    console.warn('XLSX harian tidak ditemukan: ' + (err && err.message));
  }

  return null;
}

/** Isi satu sheet rekap: ringkasan, tabel peserta, dan foto tertanam. */
function renderDailySheet_(sheet, dateStr, report, photos, opsi) {
  const opts = opsi || {};
  const counts = report.counts;
  const rows = report.rows || [];

  const fotoById = {};
  photos.forEach(function (photo) {
    if (photo && photo.fileId) fotoById[photo.fileId] = photo;
  });

  // Merge sel A2:D2 agar tanggal ditampilkan penuh (bahasa Indonesia).
  sheet.getRange(2, 1, 1, 4).merge();

  sheet.setColumnWidth(1, 46);
  sheet.setColumnWidth(2, 200);
  sheet.setColumnWidth(3, 80);
  sheet.setColumnWidth(4, 74);
  sheet.setColumnWidth(5, 74);
  sheet.setColumnWidth(6, 230);
  sheet.setColumnWidth(7, 180);
  if (opts.withLink) sheet.setColumnWidth(8, 220);

  sheet.getRange(1, 1).setValue('REKAP ABSENSI HARIAN').setFontSize(16).setFontWeight('bold');
  sheet.getRange(2, 1).setValue(dateLabel_(dateStr)).setFontSize(11);
  sheet.getRange(3, 1).setValue(
    'Dibuat: ' + nowWib_().dateStr + ' ' + nowWib_().timeLabel + ' WIB'
  ).setFontSize(9);

  const ringkas =
    'Total ' + counts.total +
    '  •  Hadir ' + counts.hadir +
    '  •  Izin ' + counts.izin +
    '  •  Sakit ' + counts.sakit +
    '  •  Alpha ' + counts.alpha;
  sheet.getRange(4, 1).setValue(ringkas).setFontSize(10).setFontWeight('bold');

  const headers = ['No', 'Nama', 'Status', 'Jam', 'Terlambat', 'Keterangan', 'Foto'];
  if (opts.withLink) headers.push('Tautan Foto');

  sheet.getRange(6, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#0d6b5f')
    .setFontColor('#ffffff');

  const startRow = 7;

  if (rows.length) {
    const table = rows.map(function (row) {
      // Format terlambat: tampilkan "X menit" atau "-"
      const terlambatDisplay = (typeof row.terlambat === 'number' && row.terlambat > 0)
        ? row.terlambat + ' menit'
        : '-';

      // Jika terlambat > 0, keterangan berisi "Alasan telat: ..."
      let keteranganDisplay;
      if (terlambatDisplay !== '-') {
        keteranganDisplay = (row.keterangan && row.keterangan !== '-')
          ? 'Alasan telat: ' + row.keterangan
          : 'Alasan telat: (tidak diisi)';
      } else {
        keteranganDisplay = row.keterangan || '-';
      }

      const values = [
        row.no,
        row.nama,
        row.status,
        row.jam,
        terlambatDisplay,
        keteranganDisplay,
        ''
      ];
      if (opts.withLink) values.push(row.link || '-');
      return values;
    });

    sheet.getRange(startRow, 1, table.length, headers.length).setValues(table);
    sheet.getRange(startRow, 6, table.length, 1).setWrap(true);
    sheet.getRange(startRow, 4, table.length, 1).setHorizontalAlignment('center');
    sheet.getRange(startRow, 5, table.length, 1).setHorizontalAlignment('center');

    // Styling tabel data: center untuk No/Jam/Terlambat, border, zebra striping,
    // dan warna teks berdasarkan status.
    var lastRow = startRow + table.length - 1;
    var lastCol = headers.length;
    var dataRange = sheet.getRange(startRow, 1, table.length, lastCol);
    dataRange.setBorder(true, true, true, true, true, true, '#999999', SpreadsheetApp.BorderStyle.SOLID);

    // Kolom 1 (No), 4 (Jam), 5 (Terlambat) rata tengah.
    sheet.getRange(startRow, 1, table.length, 1).setHorizontalAlignment('center');
    sheet.getRange(startRow, 4, table.length, 2).setHorizontalAlignment('center');

    // Warna status pada kolom 3.
    rows.forEach(function (row, index) {
      var targetRow = startRow + index;
      var statusCell = sheet.getRange(targetRow, 3);
      var statusVal = String(row.status || '');
      if (statusVal === 'Hadir') {
        statusCell.setBackground('#e8f5e9').setFontColor('#2e7d32').setFontWeight('bold');
      } else if (statusVal === 'Izin') {
        statusCell.setBackground('#fff3e0').setFontColor('#ef6c00').setFontWeight('bold');
      } else if (statusVal === 'Sakit') {
        statusCell.setBackground('#ffebee').setFontColor('#c62828').setFontWeight('bold');
      } else if (statusVal === 'Alpha') {
        statusCell.setBackground('#eceff1').setFontColor('#546e7a').setFontWeight('bold');
      } else {
        statusCell.setBackground('#f5f5f5').setFontColor('#616161');
      }

      // Zebra striping pada baris genap.
      if (index % 2 === 1) {
        sheet.getRange(targetRow, 1, 1, lastCol).setBackground('#f9f9f9');
      }
    });

    // Tinggi default 24px; naikkan per baris hanya bila ada foto.
    sheet.setRowHeights(startRow, table.length, 24);

    rows.forEach(function (row, index) {
      const photo = fotoById[row.fileId];
      const targetRow = startRow + index;

      if (!photo || !photo.blob) {
        sheet.getRange(targetRow, 7).setValue('-').setHorizontalAlignment('center');
        return;
      }

      try {
        const image = sheet.insertImage(photo.blob, 7, targetRow);
        image.setWidth(156);
        image.setHeight(94);
        sheet.setRowHeight(targetRow, 96);
      } catch (err) {
        console.warn('Foto ' + row.nama + ' gagal dimasukkan ke XLSX: ' + (err && err.message));
        sheet.getRange(targetRow, 7).setValue('(foto gagal dimuat)');
      }
    });
  }

  sheet.setFrozenRows(6);
}

/**
 * Bangun file `Absensi_YYYY-MM-DD.xlsx` untuk satu hari.
 * Foto ditanam di dalam file, bukan sekadar tautan.
 */
function buildDailyXlsx_(dateStr, report, cfg, photos) {
  const folder = getPhotoFolder_(cfg);
  const fileName = 'Absensi_' + dateStr + '.xlsx';
  const temp = SpreadsheetApp.create('Absensi ' + dateStr);
  const tempId = temp.getId();

  try {
    const sheet = temp.getActiveSheet();
    sheet.setName(dateStr);

    renderDailySheet_(sheet, dateStr, report, photos, { withLink: false });
    SpreadsheetApp.flush();

    let blob = exportSpreadsheetAsXlsx_(tempId, fileName);
    let media = countXlsxMedia_(blob);
    const expected = photos.length;

    // Bila gambar tidak ikut terekspor, ulangi sekali dengan kolom tautan
    // cadangan agar data foto tetap dapat diakses.
    let denganTautan = false;
    if (media >= 0 && expected > 0 && media < expected) {
      console.warn('XLSX: ' + media + '/' + expected + ' gambar terekspor. Menambahkan kolom tautan.');
      renderDailySheet_(sheet, dateStr, report, photos, { withLink: true });
      SpreadsheetApp.flush();
      blob = exportSpreadsheetAsXlsx_(tempId, fileName);
      media = countXlsxMedia_(blob);
      denganTautan = true;
    }

    deleteFolderFileByName_(folder, fileName);
    const file = folder.createFile(blob);

    let sharingWarning = null;
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (err) {
      sharingWarning = 'Tautan XLSX tidak dapat dipublikasikan: ' + (err && err.message);
      console.warn(sharingWarning);
    }

    return {
      ok: true,
      fileId: file.getId(),
      url: file.getUrl(),
      downloadUrl: driveDirectDownloadUrl_(file.getId()),
      name: fileName,
      gambar: media,
      diharapkan: expected,
      denganTautan: denganTautan,
      warning: sharingWarning
    };
  } finally {
    try {
      DriveApp.getFileById(tempId).setTrashed(true);
    } catch (err) {
      console.warn('Spreadsheet sementara tidak dapat dihapus: ' + (err && err.message));
    }
  }
}

/* ------------------------- FONNTE WHATSAPP GATEWAY ------------------------- */

/** Terjemahkan respons HTTP Fonnte menjadi hasil ringkas. */
function describeFonnte_(response) {
  const code = response.getResponseCode();
  const body = response.getContentText() || '';

  let parsed = null;
  try { parsed = JSON.parse(body); } catch (err) { parsed = null; }

  let ok = code >= 200 && code < 300;
  if (parsed && parsed.status === false) ok = false;

  let detail;
  if (ok) {
    detail = 'Pesan terkirim.';
  } else if (parsed) {
    detail = String(
      parsed.reason || parsed.message || parsed.detail || body
    ).slice(0, 300);
  } else {
    detail = ('HTTP ' + code + ': ' + body).slice(0, 300);
  }

  return { ok: ok, httpStatus: code, message: detail };
}

/**
 * Kirim satu payload ke Fonnte. Tidak pernah melempar error agar kegagalan
 * pengiriman tidak menggagalkan pencatatan absensi.
 */
function postFonnte_(token, payload) {
  try {
    const response = UrlFetchApp.fetch(CONFIG.WA_ENDPOINT, {
      method: 'post',
      headers: { Authorization: String(token) },
      payload: payload,
      muteHttpExceptions: true
    });

    return describeFonnte_(response);
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      message: err && err.message ? err.message : String(err)
    };
  }
}

/** Kirim pesan teks melalui Fonnte. */
function sendWhatsApp_(token, target, message) {
  return postFonnte_(token, {
    target: String(target),
    message: String(message)
  });
}

/**
 * Kirim satu foto melalui Fonnte memakai URL gambar publik.
 * Fonnte mengunduh URL tersebut lalu mengirimkannya sebagai gambar WhatsApp.
 */
function sendWhatsAppImage_(token, target, imageUrl, caption) {
  return postFonnte_(token, {
    target: String(target),
    message: String(caption || ''),
    url: String(imageUrl)
  });
}

/**
 * Kirim dokumen (XLSX) melalui Fonnte.
 * Bila Fonnte menolak parameter `filename`, coba sekali lagi tanpa parameter itu.
 */
function sendWhatsAppFile_(token, target, fileUrl, fileName, caption) {
  const first = postFonnte_(token, {
    target: String(target),
    message: String(caption || ''),
    url: String(fileUrl),
    filename: String(fileName || '')
  });

  if (first.ok) return first;

  const second = postFonnte_(token, {
    target: String(target),
    message: String(caption || ''),
    url: String(fileUrl)
  });

  return second.ok ? second : first;
}

/**
 * Kirim file dokumen melalui WhatsApp dengan multipart/form-data (langsung
 * dari Blob Drive, bukan URL). Lebih andal karena Fonnte tidak perlu
 * mengikuti redirect Google Drive yang kadang menghasilkan HTML.
 */
function sendWhatsAppFileBlob_(token, target, blob, fileName, caption) {
  try {
    blob.setContentType(CONFIG.XLSX_MIME);
    const payload = {
      target: String(target),
      message: String(caption || ''),
      filename: String(fileName || ''),
      file: blob
    };
    const result = postFonnte_(token, payload);
    if (!result.ok) {
      console.warn('Kirim dokumen multipart gagal: ' + result.message);
    }
    return result;
  } catch (err) {
    console.error('Gagal mengirim file lampiran via multipart: ' + (err && err.message));
    return {
      ok: false,
      httpStatus: 0,
      message: err && err.message ? err.message : String(err)
    };
  }
}

/**
 * Tentukan tujuan pengiriman WhatsApp.
 *
 * Mode `grup` memakai ID grup apa adanya (mis. `1203630xxx@g.us`) - ID tersebut
 * TIDAK boleh dinormalisasi seperti nomor telepon.
 */
function resolveWaTarget_(cfg) {
  const mode = String((cfg && cfg.TARGET_WA) || 'nomor').trim().toLowerCase();

  if (mode === 'grup' || mode === 'group') {
    const id = String((cfg && cfg.ID_GRUP_WA) || '').trim();
    return {
      mode: 'grup',
      target: id,
      ok: !!id,
      label: id ? 'Grup ' + id : 'Grup (ID_GRUP_WA kosong)'
    };
  }

  const number = normalizeWaNumber_(cfg && cfg.NO_WA_GURU);
  return {
    mode: 'nomor',
    target: number,
    ok: !!number,
    label: number ? 'Nomor ' + number : 'Nomor (NO_WA_GURU kosong)'
  };
}

/**
 * Periksa kesiapan target WhatsApp TANPA mengirim pesan apa pun.
 * Dipakai untuk memastikan konfigurasi grup benar sebelum production.
 */
function validasiTargetWA() {
  const cfg = getConfigMap_();
  const resolved = resolveWaTarget_(cfg);

  const info = {
    mode: resolved.mode,
    target: resolved.target || '(kosong)',
    siap: resolved.ok &&
      !!String(cfg.FONNTE_TOKEN || '').trim() &&
      !!(resolved.mode === 'grup' ? resolved.target : cfg.NO_WA_GURU),
    namaGrupDiharapkan: cfg.NAMA_GRUP_WA || '(kosong)',
    idGrupTerisi: !!String(cfg.ID_GRUP_WA || '').trim(),
    tokenFonnte: String(cfg.FONNTE_TOKEN || '').trim() ? 'terisi' : 'KOSONG',
    catatan: resolved.mode === 'grup'
      ? 'Pastikan perangkat Fonnte sudah menjadi anggota grup tersebut.'
      : 'Mode nomor: pesan dikirim ke NO_WA_GURU.'
  };

  Logger.log(JSON.stringify(info, null, 2));
  return info;
}

/** Caption singkat untuk foto yang dikirim lewat WhatsApp. */
function captionForPhoto_(item) {
  const jam = item && item.jam && item.jam !== '-' ? ' \u2022 ' + item.jam + ' WIB' : '';
  const text = String((item && item.nama) || 'Peserta') + ' \u2014 ' +
    String((item && item.status) || 'Hadir') + jam;
  return text.slice(0, 300);
}

/* ------------------------- FOTO & PENGIRIMAN REKAP ------------------------ */

/** Ambil ID file Drive dari tautan `.../d/<id>/view` atau `...?id=<id>`. */
function driveFileId_(link) {
  const text = String(link == null ? '' : link);
  if (!text) return '';

  const nested = text.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  if (nested) return nested[1];

  const query = text.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return query ? query[1] : '';
}

/** URL gambar langsung yang dapat diunduh Fonnte untuk dikirim sebagai foto. */
function driveDirectImageUrl_(fileId) {
  return 'https://lh3.googleusercontent.com/d/' + String(fileId) + '=w1200';
}

/** URL pratinjau ringan untuk daftar publik (hemat kuota HP peserta). */
function driveThumbUrl_(fileId, width) {
  return 'https://lh3.googleusercontent.com/d/' + String(fileId) + '=w' + (Number(width) || 600);
}

/**
 * URL unduh langsung sebuah file Drive.
 * Dipakai Fonnte untuk mengambil file; `getUrl()` hanya halaman pratinjau HTML
 * yang tidak dapat diunduh sebagai dokumen.
 */
function driveDirectDownloadUrl_(fileId) {
  return 'https://drive.google.com/uc?export=download&id=' + String(fileId);
}

/**
 * Fetch a resized thumbnail blob from Drive for XLSX insertion.
 * Uses Drive thumbnail URL with specified width to reduce pixel count.
 * @param {string} fileId Drive file ID
 * @param {number} width Desired width in pixels (e.g., 800)
 * @return {Blob} Resized thumbnail blob, or null if failed
 */
function fotoXlsxBlob_(fileId, width) {
  const url = driveThumbUrl_(fileId, width);
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) return null;

  const blob = response.getBlob();
  const type = String(blob.getContentType() || '').toLowerCase();
  // Tolak respons non-gambar (mis. halaman HTML error) agar tidak masuk XLSX.
  if (type.indexOf('image/') !== 0) return null;
  return blob;
}

/** Baca semua foto absensi pada satu tanggal dari Google Drive. */
function collectPhotos_(dateStr) {
  const rows = getLogByDate_(dateStr);
  const photos = [];

  rows.forEach(function (row) {
    const fileId = driveFileId_(row.link);
    if (!fileId) return;

    try {
      const file = DriveApp.getFileById(fileId);
      const xlsxBlob = fotoXlsxBlob_(fileId, 800); // 800px width max
      photos.push({
        nama: row.nama,
        status: row.status,
        jam: formatLogTime_(row.timestamp),
        fileId: fileId,
        blob: xlsxBlob || file.getBlob()
      });
    } catch (err) {
      console.warn(
        'Foto ' + row.nama + ' tidak dapat dibaca: ' + (err && err.message)
      );
    }
  });

  return photos;
}

/**
 * Kirim rekap harian ke WhatsApp.
 *
 * Default produksi: SATU pesan berisi file XLSX (foto sudah tertanam di
 * dalamnya), tanpa teks panjang dan tanpa foto satuan. Bila pembuatan XLSX
 * gagal, rekap teks dikirim sebagai fallback agar informasi tidak hilang.
 */
function deliverReport_(dateStr, report, cfg, options) {
  const opts = options || {};
  const token = String(cfg.FONNTE_TOKEN || '').trim();
  const target = resolveWaTarget_(cfg);
  const photos = collectPhotos_(dateStr);

  const whatsapp = {
    configured: !!(token && target.ok),
    sent: false,
    skipped: true,
    httpStatus: 0,
    message: '',
    target: target.label,
    document: { sent: false, name: '', url: '', message: '' },
    text: { sent: false, skipped: true, message: '' },
    photos: { sent: 0, failed: 0, skipped: true, message: '' }
  };

  const result = {
    dateStr: dateStr,
    photoCount: photos.length,
    xlsx: null,
    whatsapp: whatsapp
  };

  if (!token || !target.ok) {
    whatsapp.message = !token
      ? 'FONNTE_TOKEN belum diisi.'
      : 'Tujuan WhatsApp belum siap (' + target.label + ').';
    console.warn(whatsapp.message);
    return result;
  }

  let xlsx = null;
  let xlsxError = '';

  if (isEnabled_(cfg.KIRIM_XLSX)) {
    try {
      xlsx = buildDailyXlsx_(dateStr, report, cfg, photos);
      result.xlsx = xlsx;
    } catch (err) {
      xlsxError = err && err.message ? err.message : String(err);
      console.error('Gagal membuat XLSX: ' + xlsxError);
    }
  }

  let primary;

  if (xlsx && xlsx.ok) {
    const caption = 'REKAP ABSENSI - ' + dateLabel_(dateStr) + '\n' +
      '\n' +
      'Total ' + report.counts.total + ' peserta\n' +
      'Hadir ' + report.counts.hadir +
        ' (' + report.counts.tepatWaktu + ' tepat waktu, ' + report.counts.terlambat + ' terlambat)\n' +
      'Izin ' + report.counts.izin + '\n' +
      'Sakit ' + report.counts.sakit + '\n' +
      'Alpha ' + report.counts.alpha + '\n' +
      '\n' +
      'File XLSX:\n' + String(xlsx.downloadUrl || xlsx.url);
    // Fonnte tidak dapat mengunduh dokumen langsung dari URL Google Drive (redirect/HTML
    // atau virus scan). Kirim teks informatif berisi ringkasan + link Drive.
    primary = sendWhatsApp_(token, target.target, caption);
    whatsapp.document = {
      sent: primary.ok,
      name: xlsx.name,
      url: xlsx.url,
      message: primary.message
    };
  } else {
    primary = sendWhatsApp_(token, target.target, String(opts.prefix || '') + report.text);
    whatsapp.text = { sent: primary.ok, skipped: false, message: primary.message };
  }

  whatsapp.sent = primary.ok;
  whatsapp.skipped = false;
  whatsapp.httpStatus = primary.httpStatus;
  whatsapp.message = primary.message;

  if (xlsxError) {
    whatsapp.message = 'XLSX gagal dibuat (' + xlsxError + '); teks rekap dikirim. ' +
      primary.message;
  }

  // Teks rekap tambahan - hanya bila diminta eksplisit.
  if (isEnabled_(cfg.KIRIM_TEKS_REKAP) && xlsx && xlsx.ok) {
    const textResult = sendWhatsApp_(token, target.target, String(opts.prefix || '') + report.text);
    whatsapp.text = { sent: textResult.ok, skipped: false, message: textResult.message };

    if (!textResult.ok) {
      whatsapp.message = whatsapp.message + ' Teks rekap gagal: ' + textResult.message;
    }
  }

  // Foto satuan - hanya bila diminta eksplisit (memakai kuota per foto).
  if (isEnabled_(cfg.KIRIM_FOTO_WA)) {
    if (!photos.length) {
      whatsapp.photos.message = 'Tidak ada foto pada tanggal ini.';
    } else {
      whatsapp.photos.skipped = false;

      photos.forEach(function (photo) {
        const photoResult = sendWhatsAppImage_(
          token,
          target.target,
          driveDirectImageUrl_(photo.fileId),
          captionForPhoto_(photo)
        );

        if (photoResult.ok) {
          whatsapp.photos.sent++;
        } else {
          whatsapp.photos.failed++;
          whatsapp.photos.message = photoResult.message;
        }
      });

      whatsapp.photos.message = whatsapp.photos.failed === 0
        ? 'Semua foto terkirim (' + whatsapp.photos.sent + ').'
        : whatsapp.photos.sent + ' foto terkirim, ' + whatsapp.photos.failed +
          ' gagal. ' + whatsapp.photos.message;
    }
  }

  return result;
}

/** Kirim pesan uji ke nomor guru. */
function sendTestWA() {
  const cfg = getConfigMap_();
  const token = String(cfg.FONNTE_TOKEN || '').trim();
  const resolved = resolveWaTarget_(cfg);

  if (!token || !resolved.ok) {
    throw new Error(
      'Isi FONNTE_TOKEN dan tujuan WhatsApp yang sesuai pada sheet Konfigurasi ' +
      'terlebih dahulu. Status sekarang: ' + resolved.label + '.'
    );
  }

  if (resolved.mode === 'grup') {
    Logger.log(
      'PERHATIAN: pesan uji akan masuk ke GRUP ' + resolved.target +
      '. Gunakan validasiTargetWA() bila hanya ingin memeriksa konfigurasi.'
    );
  }

  const wib = nowWib_();
  const message = '*TES KONEKSI*\n' +
    'Sistem absensi berhasil terhubung ke WhatsApp.\n' +
    'Tujuan: ' + resolved.label + '\n' +
    'Waktu server: ' + dateLabel_(wib.dateStr) + ' ' + wib.timeLabel + ' WIB';

  const result = sendWhatsApp_(token, resolved.target, message);
  Logger.log(JSON.stringify(result));
  return result;
}

/** Pratinjau rekap hari ini tanpa mengirim WhatsApp. */
function previewLaporanHariIni() {
  ensureSheets_();
  const cfg = getConfigMap_();
  const wib = nowWib_(cfg);
  const report = buildWaReport_(wib.dateStr, getParticipants_(), getLogByDate_(wib.dateStr), cfg);
  Logger.log(report.text);
  Logger.log(JSON.stringify(report.counts, null, 2));
  return report;
}

/**
 * Buat file XLSX rekap hari ini TANPA mengirim WhatsApp.
 *
 * Hasilnya dapat diperiksa langsung: foto harus tampil di dalam file, bukan
 * sebagai tautan. URL file dicatat pada log eksekusi.
 *
 * @param {string=} dateStr Tanggal `YYYY-MM-DD`; kosong = hari ini.
 */
function ujiBuatXlsx(dateStr) {
  ensureSheets_();
  const cfg = getConfigMap_();
  const wib = nowWib_(cfg);
  const tanggal = toDateStr_(dateStr || wib.dateStr) || wib.dateStr;

  const report = buildWaReport_(tanggal, getParticipants_(), getLogByDate_(tanggal), cfg);
  const photos = collectPhotos_(tanggal);
  const info = buildDailyXlsx_(tanggal, report, cfg, photos);

  Logger.log(JSON.stringify(info, null, 2));
  Logger.log('Buka file: ' + info.url);
  return info;
}

/**
 * Uji pengiriman rekap hari ini TANPA mengubah data apa pun.
 *
 * Berguna saat MODE_UJI aktif atau setelah pukul 10:00: teks rekap dan seluruh
 * foto yang sudah ada dikirim ke WhatsApp. Baris Alpha pada rekap hanya
 * perhitungan - tidak ditulis ke Log_Absensi - dan tanggal pengiriman tidak
 * ditandai selesai.
 */
function ujiKirimRekap() {
  ensureSheets_();
  const cfg = getConfigMap_();
  const wib = nowWib_(cfg);
  const report = buildWaReport_(
    wib.dateStr,
    getParticipants_(),
    getLogByDate_(wib.dateStr),
    cfg
  );

  const prefix =
    '*[MODE UJI] REKAP MANUAL*\n' +
    'Dikirim dari fungsi ujiKirimRekap(). Baris Alpha di bawah hanya ' +
    'perhitungan dan TIDAK ditulis ke Log_Absensi.\n\n';

  const delivery = deliverReport_(wib.dateStr, report, cfg, { prefix: prefix });
  Logger.log(JSON.stringify(delivery, null, 2));
  return delivery;
}

/* ========================================================================== */
/*                           SETUP & PEMELIHARAAN                             */
/* ========================================================================== */

/** Normalisasi nomor WhatsApp ke format 62xxxxxxxxxx. */
function normalizeWaNumber_(value) {
  let digits = String(value == null ? '' : value).replace(/\D/g, '');
  if (digits.charAt(0) === '0') digits = '62' + digits.slice(1);
  return digits;
}

function makeStatusRule_(text, background, fontColor, range) {
  return SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(text)
    .setBackground(background)
    .setFontColor(fontColor)
    .setRanges([range])
    .build();
}

/** Lebar kolom, format angka, validasi status, dan pewarnaan status. */
function formatSheets_(sheets) {
  const master = sheets.master;
  const log = sheets.log;
  const config = sheets.config;

  master.setColumnWidth(1, 60);
  master.setColumnWidth(2, 260);

  const widths = [160, 110, 200, 95, 120, 340, 260];
  widths.forEach(function (w, i) {
    log.setColumnWidth(i + 1, w);
  });

  const bodyRows = Math.max(log.getMaxRows() - 1, 1);
  log.getRange(2, 1, bodyRows, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  // Tanggal disimpan sebagai TEKS agar tidak diubah Sheets menjadi nilai Date.
  log.getRange(2, 2, bodyRows, 1).setNumberFormat('@');
  log.getRange(2, 5, bodyRows, 1).setHorizontalAlignment('center');
  log.getRange(2, 6, bodyRows, 1).setWrap(true);

  const statusValidation = SpreadsheetApp.newDataValidation()
    .requireValueInList(CONFIG.STATUS_ALL, true)
    .setAllowInvalid(false)
    .build();
  log.getRange(2, 4, bodyRows, 1).setDataValidation(statusValidation);

  const statusRange = log.getRange(2, 4, bodyRows, 1);
  log.setConditionalFormatRules([
    makeStatusRule_('Hadir', '#d1fae5', '#065f46', statusRange),
    makeStatusRule_('Izin', '#dbeafe', '#1e40af', statusRange),
    makeStatusRule_('Sakit', '#fef3c7', '#92400e', statusRange),
    makeStatusRule_('Alpha', '#fee2e2', '#991b1b', statusRange)
  ]);

  config.setColumnWidth(1, 220);
  config.setColumnWidth(2, 340);
  config.getRange(2, 2, Math.max(config.getMaxRows() - 1, 1), 1).setWrap(true);
}

/** Hapus trigger lama untuk fungsi ini, lalu pasang trigger harian sesuai JAM_TUTUP. */
function installDailyTrigger_(cfg) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'processDailyClosingAndSendWA') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('processDailyClosingAndSendWA')
    .timeBased()
    .atHour(triggerHour_(cfg))
    .nearMinute(triggerMinute_(cfg))
    .everyDays(1)
    .inTimezone(CONFIG.TIMEZONE)
    .create();
}

/**
 * Sinkronkan trigger harian dengan JAM_TUTUP terbaru.
 * Bila jam trigger berbedan dengan konfigurasi, trigger dipasang ulang
 * otomatis. Bisa dijalankan manual dari editor Apps Script.
 */
function aturTriggerHarian() {
  const result = ensureDailyTrigger_();
  if (!result.ok) throw new Error(result.message);
  Logger.log('Trigger harian: ' + (result.changed ? 'diperbarui' : 'sudah cocok') +
    ' ke ' + pad2_(result.hour) + ':' + pad2_(result.minute) + ' WIB.');
  return result;
}

/**
 * Cocokkan trigger harian dengan JAM_TUTUP terbaru.
 * Bila jam trigger berbeda dengan konfigurasi, trigger dipasang ulang
 * otomatis sehingga tidak perlu setup ulang setelah ubah konfigurasi.
 */
function ensureDailyTrigger_() {
  try {
    const cfg = getConfigMap_();
    const wantHour = triggerHour_(cfg);
    const wantMinute = triggerMinute_(cfg);

    const triggers = ScriptApp.getProjectTriggers();
    for (let i = 0; i < triggers.length; i++) {
      const t = triggers[i];
      if (t.getHandlerFunction() !== 'processDailyClosingAndSendWA') continue;
      if (t.getHour() === wantHour && t.getMinute() === wantMinute) {
        return { ok: true, changed: false, hour: wantHour, minute: wantMinute };
      }
    }

    installDailyTrigger_(cfg);
    return { ok: true, changed: true, hour: wantHour, minute: wantMinute };
  } catch (err) {
    return { ok: false, message: String(err && err.message ? err.message : err) };
  }
}

/**
 * SETUP SEKALI KLIK - jalankan dari editor Apps Script.
 *
 *   setupProject()                                  // konfigurasi diisi manual nanti
 *   setupProject('6281234567890', 'TOKEN_FONNTE')   // langsung lengkap
 *
 * Yang dilakukan:
 *   1. Timezone spreadsheet -> Asia/Jakarta
 *   2. Membuat/memeriksa sheet Master_Peserta, Log_Absensi, Konfigurasi
 *   3. Mengisi 9 peserta contoh bila Master_Peserta masih kosong
 *   4. Membuat folder foto di Google Drive dan menyimpan ID-nya
 *   5. Memasang trigger harian processDailyClosingAndSendWA sesuai JAM_TUTUP
 */
function setupProject(waNumber, fonnteToken) {
  const wa = typeof waNumber === 'string' ? waNumber.trim() : '';
  const token = typeof fonnteToken === 'string' ? fonnteToken.trim() : '';

  // Setiap langkah dibungkus agar galat menyebut langkah yang bermasalah.
  function step_(nama, fn) {
    try {
      return fn();
    } catch (err) {
      const pesan = err && err.message ? err.message : String(err);
      const kode = err && err.code ? err.code : 'SETUP_GAGAL';
      throw new AppError(kode, 'Langkah "' + nama + '" gagal: ' + pesan);
    }
  }


  const ss = step_('buka spreadsheet', resolveSpreadsheetForSetup_);
  step_('set zona waktu', function () { return ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE); });

  const sheets = step_('siapkan sheet', ensureSheets_);
  step_('rapikan format sheet', function () { return formatSheets_(sheets); });

  const folder = step_('siapkan folder foto', getOrCreatePhotoFolder_);

  const updates = { FOLDER_DRIVE_ID: folder.getId() };
  if (wa) updates.NO_WA_GURU = normalizeWaNumber_(wa);
  if (token) updates.FONNTE_TOKEN = token;
  step_('simpan konfigurasi', function () { return setConfigValues_(updates); });

  const cfg = step_('muat konfigurasi', ensureConfigDefaults_);
  step_('pasang trigger harian', function () { return installDailyTrigger_(cfg); });

  // Sekaligus menormalkan kolom Tanggal agar tidak lagi tersimpan sebagai Date.
  const perbaikanTanggal = step_('perbaiki kolom Tanggal', perbaikiTanggalLog);

  const belumDiisi = [];
  if (!cfg.NO_WA_GURU) belumDiisi.push('NO_WA_GURU');
  if (!cfg.FONNTE_TOKEN) belumDiisi.push('FONNTE_TOKEN');
  if (!cfg.COMPRESSO_TOKEN) belumDiisi.push('COMPRESSO_TOKEN (opsional)');

  const info = {
    ok: true,
    spreadsheet: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    spreadsheetId: ss.getId(),
    folderDrive: folder.getName(),
    folderDriveId: folder.getId(),
    trigger: 'processDailyClosingAndSendWA - setiap hari pukul ' +
      cutoffLabel_(cfg) + ' ' + CONFIG.TIMEZONE,
    zonaWaktu: ss.getSpreadsheetTimeZone(),
    perbaikanTanggal: perbaikanTanggal,
    konfigurasiBelumDiisi: belumDiisi,
    langkahBerikutnya: belumDiisi.length
      ? [
          'Isi ' + belumDiisi.join(' dan ') + ' pada sheet Konfigurasi.',
          'Jalankan validasiTargetWA() untuk memastikan tujuan WhatsApp sudah benar.',
          'Jalankan ujiBuatXlsx() untuk memeriksa file rekap sebelum production.',
          'Deploy ulang Web App (Deploy > Manage deployments > Edit > New version).'
        ]
      : [
          'Jalankan validasiTargetWA() untuk memastikan tujuan WhatsApp sudah benar.',
          'Jalankan ujiBuatXlsx() untuk memeriksa file rekap sebelum production.',
          'Deploy ulang Web App (Deploy > Manage deployments > Edit > New version).'
        ]
  };

  Logger.log(JSON.stringify(info, null, 2));
  return info;
}

/** Ringkasan kondisi sistem - untuk memastikan semua komponen siap. */
function diagnosaSistem() {
  const ss = getSpreadsheet_();
  const cfg = getConfigMap_();

  const sheetsInfo = [CONFIG.SHEET_MASTER, CONFIG.SHEET_LOG, CONFIG.SHEET_CONFIG].map(function (name) {
    const sheet = ss.getSheetByName(name);
    return {
      nama: name,
      ada: !!sheet,
      barisData: sheet ? Math.max(sheet.getLastRow() - 1, 0) : 0
    };
  });

  let folderInfo = null;
  const folderId = String(cfg.FOLDER_DRIVE_ID || '').trim();
  if (folderId) {
    try {
      const folder = DriveApp.getFolderById(folderId);
      folderInfo = { nama: folder.getName(), id: folder.getId(), terhapus: folder.isTrashed() };
    } catch (err) {
      folderInfo = { error: 'Folder tidak dapat diakses: ' + err.message };
    }
  }

  const triggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'processDailyClosingAndSendWA';
  }).length;

  const info = {
    spreadsheet: { nama: ss.getName(), zonaWaktu: ss.getSpreadsheetTimeZone(), url: ss.getUrl() },
    sheets: sheetsInfo,
    folderFoto: folderInfo,
    triggerHarian: triggers,
    konfigurasi: {
      NO_WA_GURU: cfg.NO_WA_GURU ? 'terisi' : 'KOSONG',
      FONNTE_TOKEN: cfg.FONNTE_TOKEN ? 'terisi' : 'KOSONG',
      TARGET_WA: cfg.TARGET_WA || 'nomor',
      NAMA_GRUP_WA: cfg.NAMA_GRUP_WA || '(kosong)',
      ID_GRUP_WA: cfg.ID_GRUP_WA ? 'terisi' : 'KOSONG',
      targetAktif: resolveWaTarget_(cfg).label,
      COMPRESSO_TOKEN: cfg.COMPRESSO_TOKEN ? 'terisi' : 'KOSONG',
      KOMPRES_FOTO: cfg.KOMPRES_FOTO || 'ya',
      KIRIM_XLSX: cfg.KIRIM_XLSX || 'ya',
      KIRIM_TEKS_REKAP: cfg.KIRIM_TEKS_REKAP || 'tidak',
      KIRIM_FOTO_WA: cfg.KIRIM_FOTO_WA || 'tidak',
      PUBLIK_ALASAN: cfg.PUBLIK_ALASAN || 'ya',
      MODE_UJI: cfg.MODE_UJI || 'tidak',
      HARI_AKTIF: cfg.HARI_AKTIF || CONFIG.DEFAULT_ACTIVE_DAYS,
      TANGGAL_LIBUR: cfg.TANGGAL_LIBUR || '(kosong)',
      tanggalLiburTerbaca: normalizeDateList_(cfg.TANGGAL_LIBUR),
      LAST_WA_SENT_DATE: cfg.LAST_WA_SENT_DATE || '(belum pernah)',
      LAST_REPORT_SENT_DATE: cfg.LAST_REPORT_SENT_DATE || '(belum pernah)',
      LAST_WA_STATUS: cfg.LAST_WA_STATUS || '(belum ada)'
    },
    waktuServer: nowWib_().dateStr + ' ' + nowWib_().timeLabel + ' ' + CONFIG.TIMEZONE
  };

  Logger.log(JSON.stringify(info, null, 2));
  return info;
}

/** Menu praktis di spreadsheet (hanya muncul pada script container-bound). */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Absensi')
      .addItem('Setup / Perbaiki Proyek', 'setupProject')
      .addItem('Diagnosa Sistem', 'diagnosaSistem')
      .addSeparator()
      .addItem('Tutup & Kirim Laporan Sekarang', 'manualCloseToday')
      .addItem('Kirim Ulang Laporan', 'resendWhatsAppReport')
      .addItem('Uji Buat XLSX (tanpa kirim)', 'ujiBuatXlsx')
      .addItem('Uji Kirim Rekap', 'ujiKirimRekap')
      .addSeparator()
      .addItem('Perbaiki Kolom Tanggal', 'perbaikiTanggalLog')
      .addItem('Hapus Data Uji', 'hapusBarisUji')
      .addSeparator()
      .addItem('Cek Kuota Kompresi', 'cekKuotaCompresso')
      .addItem('Validasi Target WhatsApp', 'validasiTargetWA')
      .addItem('Tes Kirim WhatsApp', 'sendTestWA')
      .addToUi();
  } catch (err) {
    // Script standalone tidak memiliki UI spreadsheet - abaikan.
  }
}
