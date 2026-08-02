# Yang berubah & cara pasang

## 1) Kenapa pengumuman/pesan terjadwal tidak terkirim
`scheduler.js` versi lama (yang sedang jalan di bot kamu) **tidak pernah membaca**
tabel `scheduled_messages` sama sekali — jadi dashboard nulis baris pesan,
tapi tidak ada kode di bot yang mengecek & mengirimkannya. Sudah diperbaiki:
`scheduler.js` sekarang punya worker yang cek tabel itu tiap 1 menit dan
mengirim pesan yang sudah waktunya lewat `sock.sendMessage`.

## 2) Fitur baru: Tambah/Kick anggota dari dashboard
- Tabel baru `group_actions` menyimpan permintaan tambah/kick.
- Bot cek tabel itu tiap 20 detik, jalankan `groupParticipantsUpdate`,
  lalu tulis balik status `success`/`failed` + pesan error yang jelas
  (nomor tidak terdaftar di WhatsApp, privasi membatasi, sudah anggota,
  bukan anggota, baru saja keluar, dll).
- Untuk kasus gagal tambah karena privasi (kode 403), bot otomatis coba
  kirim link undangan grup lewat chat pribadi ke nomor tersebut.

## 3) Langkah pasang

### Supabase
1. Jalankan `migration_group_actions.sql` di SQL Editor.

### Bot
Timpa/tambahkan file-file ini ke project bot kamu:
- `scheduler.js` → timpa yang lama
- `db/scheduledMessages.js` → file baru
- `db/groupActions.js` → file baru

Tidak ada perubahan di `index.js`, `db/schedule.js`, `db/filters.js`, dll.

Restart bot setelah itu.

### Dashboard
Timpa `index.html` (admin) yang lama dengan versi baru — sudah termasuk:
- Panel "Kelola Anggota Grup" (input nomor 628xxxx, tombol Tambah/Kick,
  tabel riwayat + status + keterangan error).
- Teks di kolom ID pada tab login "ID Admin" sudah tidak bold lagi.

## Catatan keamanan
`.env` yang kamu upload berisi kredensial Supabase asli. Karena sudah
sempat diunggah ke chat ini, sebaiknya **rotasi/regenerate** key tersebut
dari Supabase dashboard (Project Settings → API) untuk jaga-jaga, lalu
update `.env` bot dan `SUPABASE_KEY` di `index.html` dashboard dengan
key yang baru.
