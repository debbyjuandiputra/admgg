-- ============================================================
-- SCHEMA UNTUK DASHBOARD ADMIN WA GROUP GUARD
-- Jalankan di Supabase SQL Editor (Project > SQL Editor > New query)
-- ============================================================

-- 1) Jadwal buka/tutup grup (dipakai bot: db/schedule.js)
create table if not exists public.group_schedule (
  group_id     text primary key,          -- contoh: 6288215292431-1593157650@g.us
  open_hour    smallint not null default 7,
  open_minute  smallint not null default 0,
  close_hour   smallint not null default 22,
  close_minute smallint not null default 0,
  is_active    boolean not null default true,
  updated_at   timestamptz not null default now()
);

-- 2) Admin dashboard (login: nomor HP + grup harus cocok satu baris ini)
create table if not exists public.admins (
  phone      text primary key,             -- contoh: 6281234567890
  nama       text,                         -- opsional
  "group"    text references public.group_schedule(group_id) on update cascade
);

-- 3) Kata kasar (dipakai bot: db/filters.js)
create table if not exists public.bad_words (
  id         bigint generated always as identity primary key,
  word       text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- 4) Pesan terjadwal (baru — diisi dari dashboard, dikirim oleh bot)
create table if not exists public.scheduled_messages (
  id           bigint generated always as identity primary key,
  group_id     text not null references public.group_schedule(group_id) on update cascade,
  message      text not null,
  send_at      timestamptz not null,       -- waktu kirim (simpan sbg UTC, dashboard convert dari WIB)
  status       text not null default 'pending', -- pending | sent | failed | canceled
  created_by   text references public.admins(phone),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  error        text
);

create index if not exists idx_scheduled_messages_due
  on public.scheduled_messages (status, send_at);

-- ============================================================
-- Row Level Security
-- Dashboard mengakses tabel-tabel ini langsung dari browser memakai
-- Supabase "publishable" (anon) key, jadi WAJIB pasang RLS + policy.
-- Karena tidak ada Supabase Auth (login custom by phone), policy di
-- bawah membuka akses ke anon role tapi lewat rest API terbatas pada
-- kolom yg diperlukan. Untuk keamanan lebih ketat, pertimbangkan pindah
-- ke Supabase Edge Function agar anon key tidak pernah menyentuh
-- tabel secara langsung.
-- ============================================================

alter table public.group_schedule enable row level security;
alter table public.admins enable row level security;
alter table public.bad_words enable row level security;
alter table public.scheduled_messages enable row level security;

drop policy if exists "anon read schedule" on public.group_schedule;
create policy "anon read schedule" on public.group_schedule for select using (true);
drop policy if exists "anon update schedule" on public.group_schedule;
create policy "anon update schedule" on public.group_schedule for update using (true);

drop policy if exists "anon read admins" on public.admins;
create policy "anon read admins" on public.admins for select using (true);

drop policy if exists "anon read badwords" on public.bad_words;
create policy "anon read badwords" on public.bad_words for select using (true);
drop policy if exists "anon write badwords" on public.bad_words;
create policy "anon write badwords" on public.bad_words for insert with check (true);
drop policy if exists "anon delete badwords" on public.bad_words;
create policy "anon delete badwords" on public.bad_words for delete using (true);

drop policy if exists "anon read scheduled_messages" on public.scheduled_messages;
create policy "anon read scheduled_messages" on public.scheduled_messages for select using (true);
drop policy if exists "anon write scheduled_messages" on public.scheduled_messages;
create policy "anon write scheduled_messages" on public.scheduled_messages for insert with check (true);
drop policy if exists "anon update scheduled_messages" on public.scheduled_messages;
create policy "anon update scheduled_messages" on public.scheduled_messages for update using (true);
drop policy if exists "anon delete scheduled_messages" on public.scheduled_messages;
create policy "anon delete scheduled_messages" on public.scheduled_messages for delete using (true);

-- Contoh isi awal (GANTI dengan grup & nomor asli kamu):
-- insert into public.group_schedule (group_id) values ('6288215292431-1593157650@g.us')
--   on conflict (group_id) do nothing;
-- insert into public.admins (phone, nama, "group") values ('6281234567890', 'Nama Kamu', '6288215292431-1593157650@g.us')
--   on conflict (phone) do nothing;
