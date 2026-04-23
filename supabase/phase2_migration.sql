-- Phase 2a migration — run ONCE in Supabase SQL editor
-- https://supabase.com/dashboard/project/tafwprmxhwuhxckjdwdj/sql/new

-- ───────────────────────────────────────────────────────────────────
-- weigh_history: one row per CSV upload per mob.
-- CSV upload path in server.js inserts here on every upload so the
-- farmer's weigh curve is real, not synthesised.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.weigh_history (
  id          uuid primary key default gen_random_uuid(),
  mob_id      uuid not null references public.mobs(id) on delete cascade,
  weigh_date  date not null,
  avg_lw      numeric,
  head_count  integer,
  created_at  timestamptz not null default now(),
  unique (mob_id, weigh_date)
);

create index if not exists idx_weigh_history_mob
  on public.weigh_history (mob_id, weigh_date);

-- ───────────────────────────────────────────────────────────────────
-- attrition: mob-level loss events (injury, death, poor thrift).
-- No write-path UI yet — endpoint exists so the detail view can
-- render the (empty) list. Phase N will add input.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.attrition (
  id          uuid primary key default gen_random_uuid(),
  mob_id      uuid not null references public.mobs(id) on delete cascade,
  event_date  date not null,
  reason      text,
  head_count  integer default 1,
  created_at  timestamptz not null default now()
);

create index if not exists idx_attrition_mob
  on public.attrition (mob_id, event_date desc);

-- ───────────────────────────────────────────────────────────────────
-- RLS — all reads/writes go through the Express API with the service
-- role key, which bypasses RLS. Enabling RLS here keeps the public
-- anon key from reading either table directly. This matches the
-- pattern on mobs/farms.
-- ───────────────────────────────────────────────────────────────────
alter table public.weigh_history enable row level security;
alter table public.attrition      enable row level security;
