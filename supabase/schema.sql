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
