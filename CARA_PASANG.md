# Cara pasang

## 1. Supabase
1. Buka project Supabase kamu → **SQL Editor** → jalankan isi `schema.sql`.
2. Isi baris awal di tabel `group_schedule` dan `admins` (contoh ada di bagian bawah `schema.sql`, tinggal uncomment & ganti nilai).

## 2. Dashboard (`admin.html`)
1. Buka `admin.html`, cari baris ini di bagian `<script>`:
   ```js
   const SUPABASE_URL = "https://xxxxxxxxxxxxxxxxxxxx.supabase.co";
   const SUPABASE_KEY = "sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxx";
   ```
   Ganti dengan URL & **publishable/anon key** project Supabase kamu (yang sama dengan di `.env` bot: `SUPABASE_URL` & `SUPABASE_KEY`).
2. Upload `admin.html` ke hosting statis manapun (Vercel, Netlify, Cloudflare Pages, GitHub Pages, atau cukup dibuka langsung dari file lokal).
3. Login pakai ID grup (`group_id` yang sudah kamu masukkan di tabel `group_schedule`) dan nomor HP yang sudah kamu masukkan di tabel `admins`.

⚠️ **Catatan keamanan:** dashboard ini memanggil Supabase langsung dari browser pakai anon key + RLS policy yang cukup terbuka (siapapun yang tahu URL + anon key bisa baca/tulis tabel-tabel ini, sama seperti pola di `index2.html` referensi kamu). Ini cukup untuk pemakaian pribadi/developer, tapi:
- Jangan sebar link dashboard ke publik.
- Kalau mau lebih aman, langkah berikutnya yang disarankan: pindahkan operasi tulis (simpan jadwal, tambah/hapus bad word, jadwalkan pesan) ke **Supabase Edge Function** yang memverifikasi nomor admin di server, sehingga anon key di browser tidak punya akses tulis langsung.

## 3. Bot (kode yang di-hosting)
1. Salin `bot_updates/db/scheduledMessages.js` ke folder `db/` project bot kamu.
2. Timpa `scheduler.js` project bot kamu dengan `bot_updates/scheduler.js` (isinya sama seperti sebelumnya + tambahan worker yang cek tabel `scheduled_messages` tiap 1 menit dan mengirim pesan yang sudah waktunya).
3. Tidak ada perubahan di `index.js`, `db/schedule.js`, atau `db/filters.js` — dashboard menulis ke tabel yang sama yang sudah dipakai bot kamu.
4. Restart bot.

## Yang berubah dari sisi bot
- `db/schedule.js` & `db/filters.js` **tidak diubah** — dashboard langsung membaca/menulis ke tabel `group_schedule` dan `bad_words` yang sudah dipakai bot (perubahan jadwal via dashboard otomatis kepakai bot lewat re-check tiap 5 menit yang sudah ada; bad words otomatis kepakai lewat cache 5 menit yang sudah ada di `db/filters.js`).
- Satu-satunya penambahan di sisi bot adalah worker pengecekan `scheduled_messages` di `scheduler.js`.

## Ingat: rotasi kredensial
File `.env` yang kamu upload berisi `SUPABASE_URL` dan `SUPABASE_KEY` asli. Kalau file itu sempat ke-share ke luar, sebaiknya buat ulang (regenerate) publishable key-nya dari Supabase dashboard untuk jaga-jaga.
