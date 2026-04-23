-- Phase 3a migration — run ONCE in Supabase SQL editor
-- https://supabase.com/dashboard/project/tafwprmxhwuhxckjdwdj/sql/new
--
-- Adds per-animal weigh records so the farmer can drill from mob → individual
-- animals with ADG computed across uploads. Also creates a private storage
-- bucket for the raw CSVs so uploads are preserved (enables future re-parsing).

-- ───────────────────────────────────────────────────────────────────
-- animal_weighs: one row per EID per upload
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.animal_weighs (
  id           uuid primary key default gen_random_uuid(),
  mob_id       uuid not null references public.mobs(id) on delete cascade,
  eid          text not null,
  weigh_date   date not null,
  weight       numeric not null,
  draft        text,
  created_at   timestamptz not null default now(),
  unique (eid, weigh_date)
);

create index if not exists idx_animal_weighs_mob_eid
  on public.animal_weighs (mob_id, eid);

create index if not exists idx_animal_weighs_eid_date
  on public.animal_weighs (eid, weigh_date);

alter table public.animal_weighs enable row level security;

-- ───────────────────────────────────────────────────────────────────
-- Storage bucket — private, for raw livestock weighing CSVs.
-- Path convention: <farm_id>/<mob_id>/<weigh_date>.csv
-- Reads/writes go through the service role key only.
-- ───────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('weigh-uploads', 'weigh-uploads', false)
on conflict (id) do nothing;

-- Sanity checks
select count(*) as animal_weighs_rows from public.animal_weighs;
select id, public from storage.buckets where id = 'weigh-uploads';
