-- Phase 3c migration — run ONCE in Supabase SQL editor
-- Adds farmer-editable overrides + birth date to the mobs table.
-- These feed the LCA engine: if set, they override the auto-derived class
-- (from sex) / origin (from breed) / season (from drop_type or birth month).

alter table public.mobs
  add column if not exists class      text,
  add column if not exists origin     text,
  add column if not exists birth_date date;

select id, mob_name, class, origin, birth_date from public.mobs limit 5;
