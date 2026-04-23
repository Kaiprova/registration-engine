# KaiProva Registration Engine — Project Context

## What This Is

KaiProva is a Carbon Verification / Scope 3 SaaS platform for NZ dairy farmers, built by Dan Carson (Founder, Alps2Ocean Foods / Mīti). This repo is the **farmer registration & mob management portal** — the front door to the platform.

Live URL: `https://web-production-dab45.up.railway.app`  
Hosting: Railway (auto-deploys on push to `main`)  
Backend DB: Supabase (project ID: `tafwprmxhwuhxckjdwdj`)

## Critical Terminology

- Always spell the brand **Mīti** (with macron) — never "METI", "Miti" or "M-E-T-I"
- Always say **"young beef"** — never "veal"

## Project Structure

```
registration-engine/
├── server.js          # Express backend (API + static serving)
├── public/
│   └── index.html     # Single-page frontend (all UI)
├── supabase/
│   └── schema.sql     # DB schema (keep in sync with live Supabase)
└── package.json
```

## Supabase Schema (as of 23 Apr 2026)

```sql
-- farms
CREATE TABLE public.farms (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id),
  farm_name text,
  region text,
  herd_size integer,
  farm_type text,
  created_at timestamptz DEFAULT now()
);

-- mobs
CREATE TABLE public.mobs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  farm_id uuid REFERENCES public.farms(id),
  mob_name text,
  breed text,
  sex text,
  drop_type text,
  head_count integer,
  avg_weight numeric,
  updated_at timestamptz,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT mobs_farm_id_mob_name_key UNIQUE (farm_id, mob_name)
);
```

## What Was Built / Fixed (Session 23 Apr 2026)

### 1. CSV Upload — Livestock Weighing Format
**Problem:** CSV parser was creating 18 separate mobs instead of 1 mob with 18 animals.

**Fix in `server.js`:** Detects livestock weighing format by scanning for `/^(FileNo|Name|Date):/i` pattern. Extracts mob name from the `Name:` metadata line, skips the technical field definition line, then parses remaining rows as animal records.

**Key code pattern:**
```js
const metaPattern = /^(FileNo|Name|Date):\s*/i;
// scan first lines for metadata
// metaName = value.replace(/,+$/, '').trim()  // strips trailing commas from CSV
// skip technical def line
// parse remaining as CSV rows → animals
```

### 2. Mob Name Cleanup
**Problem:** Mob names like `"BULLS OUTRAM,,,,,,,,,,"` (trailing commas from CSV metadata line).

**Fix:** `.replace(/,+$/, '').trim()` applied after extracting the Name: value.

### 3. Duplicate Mob Prevention
**Problem:** Re-uploading a CSV created duplicate mob rows.

**Fix:** Changed INSERT to UPSERT with conflict resolution:
```js
await getSupabase().from('mobs').upsert(
  { farm_id, mob_name: metaName, head_count: rows.length, avg_weight, updated_at: new Date().toISOString() },
  { onConflict: 'farm_id,mob_name' }
)
```

**Required Supabase migration (already run):**
```sql
ALTER TABLE public.mobs ADD CONSTRAINT mobs_farm_id_mob_name_key UNIQUE (farm_id, mob_name);
```

### 4. avg_weight Column
**Problem:** `"Could not find 'avg_weight' column of 'mobs' in schema cache"`

**Fix:** Added column to Supabase:
```sql
ALTER TABLE public.mobs ADD COLUMN IF NOT EXISTS avg_weight numeric;
```

### 5. Last Updated Column (most recent fix)
**Problem:** "Last Updated" column showing "—" on the dashboard.

**Fix:** Added `updated_at: new Date().toISOString()` to both mob upsert paths in server.js. Also added column to Supabase:
```sql
ALTER TABLE public.mobs ADD COLUMN IF NOT EXISTS updated_at timestamptz;
```

Commit: `3fc1e4f6` — "fix: show last-updated date from mob updated_at timestamp"

## Git Workflow Note

The Linux sandbox **cannot push to GitHub** (no credential store). Use **Git GUI** on the Windows machine:
- Right-click project folder in File Explorer → Show more options → "Open Git GUI here"
- Stage specific files via Commit menu → "Stage To Commit" (don't stage `.claude/worktrees/*`)
- Commit → Remote → Push → select `main` → `origin` → Push

## Supply Planner + Carbon (built 23 Apr 2026)

The farmer dashboard opens a **Supply Planner** when a mob row is clicked. It auto-fills head count, avg weight, and last weigh date from Supabase. Farmer adjusts ADG slider (500–2000 g/d), target LW (300–800 kg), and schedule price ($/kg CW).

**Outputs (6 chips + breakdown):**
- Days to target · Projected kill date · Projected CW
- Footprint (LW) kg CO₂e/kg LW · Footprint (CW) kg CO₂e/kg CW · vs B+LNZ benchmark (% below/above)
- Total mob value ($) + per-head × head @ price breakdown
- Mob footprint total (t CO₂e) + scenario line (origin · class · drop · finishing months)

**LCA engine** is ported inline in `public/index.html` from the main Kaiprova platform (`src/engine/lca-calc.js` + `lca-tables.js`). Functions: `lcaCalcExtended`, `calcLW`, `byBW`, `byLWG`, `extrapolateFP`. Tables: `A4` (footprint by class/bw/season/month/lwg) and `A1lw` (LW by season/month/lwg). AgResearch RE450/2024/054 — 54 validated scenarios.

**Mob → LCA input mapping:**
- `season` from `mob.drop_type` (spring/autumn; default autumn)
- `cls` from `mob.sex` (bull/heifer/steer)
- `origin` from `mob.breed` (angus/hereford/murray/simmental/charolais/wagyu/limousin/beef → beef; else dairy)
- `bw` default 40.0 kg (AgResearch anchor)
- `months` computed from target LW, ADG, and `WEANING_LW_KG = 100` / `WEANING_AGE_MONTHS = 3.3`

Beef-bred mobs get a +30% uplift (IDF 2022 allocation). Ages >18mo use extrapolation engine (`EXTRAP_EXP = 0.2281`, calibrated to 28-month anchor). Indicative warning shown when any input falls outside validated range.

## Supabase SQL Editor URL

`https://supabase.com/dashboard/project/tafwprmxhwuhxckjdwdj/sql/new`

## Railway Deploy URL

`https://railway.com/project/4706c603-1a3f-42bf-89b2-7bd61acdb638/service/8657413e-a6ca-4dd6-8776-526511c4d482`
