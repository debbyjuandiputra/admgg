-- ============================================================
-- Tabel antrean tambah/kick anggota grup (dari dashboard)
-- Jalankan di Supabase SQL Editor
-- ============================================================

create table if not exists public.group_actions (
  id           bigint generated always as identity primary key,
  group_id     text not null references public.group_schedule(group_id) on update cascade,
  phone        text not null,                 -- format 628xxxxxxxxx
  action       text not null check (action in ('add','kick')),
  status       text not null default 'pending', -- pending | success | failed
  created_by   text references public.admins(phone),
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  error        text
);

create index if not exists idx_group_actions_pending
  on public.group_actions (group_id, status, created_at);

alter table public.group_actions enable row level security;

-- Dashboard butuh baca (lihat riwayat) & tulis (bikin permintaan baru).
-- Bot pakai key yang sama (anon/publishable), jadi butuh policy update
-- juga supaya bisa menandai status success/failed.
drop policy if exists "anon read group_actions" on public.group_actions;
create policy "anon read group_actions" on public.group_actions for select using (true);
drop policy if exists "anon write group_actions" on public.group_actions;
create policy "anon write group_actions" on public.group_actions for insert with check (true);
drop policy if exists "anon update group_actions" on public.group_actions;
create policy "anon update group_actions" on public.group_actions for update using (true);
