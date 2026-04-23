-- Phase 2b backfill — one-shot, run ONCE in Supabase SQL editor
-- https://supabase.com/dashboard/project/tafwprmxhwuhxckjdwdj/sql/new
--
-- The weigh_history table was added in Phase 2a, but CSVs uploaded before that
-- migration only wrote to mobs.avg_weight + mobs.updated_at. This backfills a
-- single weigh_history row per affected mob so the Mob Detail chart has a
-- starting point to draw. Future uploads populate weigh_history directly.

insert into public.weigh_history (mob_id, weigh_date, avg_lw, head_count)
select
  m.id,
  coalesce(m.updated_at, m.created_at)::date as weigh_date,
  m.avg_weight,
  m.head_count
from public.mobs m
where m.avg_weight is not null
  and not exists (
    select 1 from public.weigh_history wh where wh.mob_id = m.id
  )
on conflict (mob_id, weigh_date) do nothing;

-- Sanity: how many rows ended up in weigh_history
select count(*) as weigh_history_rows from public.weigh_history;
