-- Registration Engine – Supabase schema
-- Sync this file with any migrations applied directly in the Supabase dashboard.

create table if not exists farms (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  farm_name   text not null,
  region      text not null,
  farm_type   text,
  herd_size   integer,
  created_at  timestamptz not null default now()
);

create table if not exists mobs (
  id          uuid primary key default gen_random_uuid(),
  farm_id     uuid not null references farms(id) on delete cascade,
  mob_name    text not null,
  breed       text,
  sex         text,
  drop_type   text,
  head_count  integer,
  avg_weight  numeric,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);

-- Migration: add updated_at if the table already exists in production
-- Run this once in the Supabase SQL editor:
--   ALTER TABLE public.mobs ADD COLUMN IF NOT EXISTS updated_at timestamptz;

create table if not exists animals (
  id          uuid primary key default gen_random_uuid(),
  farm_id     uuid not null references farms(id) on delete cascade,
  tag_id      text,
  species     text,
  breed       text,
  dob         date,
  sex         text,
  created_at  timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────────
-- Phase 2a (23 Apr 2026) — weigh_history + attrition tables
-- Live migration SQL lives in supabase/phase2_migration.sql
-- ───────────────────────────────────────────────────────────────────

create table if not exists weigh_history (
  id          uuid primary key default gen_random_uuid(),
  mob_id      uuid not null references mobs(id) on delete cascade,
  weigh_date  date not null,
  avg_lw      numeric,
  head_count  integer,
  created_at  timestamptz not null default now(),
  unique (mob_id, weigh_date)
);

create table if not exists attrition (
  id          uuid primary key default gen_random_uuid(),
  mob_id      uuid not null references mobs(id) on delete cascade,
  event_date  date not null,
  reason      text,
  head_count  integer default 1,
  created_at  timestamptz not null default now()
);
