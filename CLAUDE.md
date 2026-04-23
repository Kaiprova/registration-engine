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

**LCA engine** is ported inline in `public/index.html` from the main Kaiprova platform (`src/engine/lca-calc.js` + `lca-tables.js`). Functions: `lcaCalcExtended`, `calcLW`, `byBW`, `byLWG`, `extrapolateFP`. Tables: `A4` (footprint by class/bw/season/month/lwg) and `A1lw` (LW by season/month/lwg). AgResearch RE450/2024/054 — 54 vali

## Phase 1 — Dashboard look + sidebar nav (23 Apr 2026)

Migrated from the main Kaiprova platform's visual language. Structure now:

- **Top-level sections** (flat, no shell): `sectionLogin`, `sectionMagicSent`, `sectionRegister` — front door kept simple so farmers aren't dropped into a dashboard before registering.
- **App shell** (`sectionApp`): 220px dark-green sidebar + white main area. Contains 5 sub-views: `sectionOverview`, `sectionDashboard` (My Mobs — the existing mob list + CSV upload), `sectionPlanner` (Supply Planner + carbon chips — existing), `sectionOffers` (placeholder), `sectionTrace` (placeholder).

Navigation: sidebar buttons carry `data-view="sectionX"`. `showSection(id)` detects app-view IDs and routes via `sectionApp`, toggling `.active` on the sidebar button. Legacy `showSection('sectionDashboard')` calls still work unchanged.

Sidebar exposes Signout (mirrors the top bar). Top bar `siteHeader` is hidden inside the app shell — shown only during auth/register flow.

Style tokens reused from main platform: `--kp-pasture-mid` for sidebar bg, Inter Tight 12–13px body, Fraunces 1.7rem for view titles. CSS is additive — the original cream/Fraunces palette for login/register is untouched.

## Next: Phase 2 — Mob Detail

Click a mob row → full detail view with Chart.js weigh-history curve, attrition log, carbon panel, and a "Plan supply" button that opens the existing planner pre-loaded with that mob. Real Supabase weigh data only (no demo).

## Phase 2a — Weigh history + mob API (23 Apr 2026)

**New Supabase tables** (live migration in `supabase/phase2_migration.sql`):
- `weigh_history` — one row per CSV upload per mob. Columns: `mob_id`, `weigh_date`, `avg_lw`, `head_count`. Unique on `(mob_id, weigh_date)` so re-uploads replace, not duplicate.
- `attrition` — mob loss events. No write-path UI yet (deferred).

**server.js changes:**
- CSV upload (livestock weighing format) now captures `Date:` metadata and writes a `weigh_history` row after each successful mob upsert. Date parser accepts ISO, `dd/mm/yyyy`, `dd-mm-yyyy`, `dd Mon yyyy`.
- New endpoints:
  - `GET /api/mobs/:id` — single mob + farm info for the detail view
  - `GET /api/mobs/:id/weigh-history` — ordered asc by date (for Chart.js)
  - `GET /api/mobs/:id/attrition` — ordered desc by date
- All three use `loadOwnedMob()` which joins `farms!inner(owner_id)` to scope to the authenticated farmer.
- Removed the broken `weigh_events(*)` join from `GET /api/farms/:id/animals` (that table never existed).

## Next: Phase 2b — Mob Detail frontend

Add Chart.js 4.4 CDN. New `sectionMobDetail` app-view: summary card (breed/sex/drop/head/avg/last upload/farm/region), weigh history line chart, carbon panel (uses existing LCA engine), attrition log, and a "Plan supply" button that opens the existing planner pre-loaded with the mob. Update mob row click in My Mobs to open the detail view (not the planner directly).