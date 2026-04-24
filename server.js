'use strict';

const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');

console.log('[startup] SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET' : 'MISSING',
  '| SUPABASE_SVC:', process.env.SUPABASE_SVC ? 'SET' : 'MISSING',
  '| NODE_ENV:', process.env.NODE_ENV || '(not set)');

let _supabase;
function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SVC;
    if (!url || !key) {
      throw new Error(`Supabase env vars missing — URL: ${url ? 'set' : 'MISSING'}, KEY: ${key ? 'set' : 'MISSING'}`);
    }
    _supabase = createClient(url, key);
  }
  return _supabase;
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header required' });
  }
  const token = auth.slice(7);
  const { data: { user }, error } = await getSupabase().auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = user;
  next();
}

// Admin gate — must run AFTER requireAuth. Whitelist comes from ADMIN_EMAILS
// (comma-separated) or falls back to the Alps2Ocean defaults.
function adminEmails() {
  const raw = (process.env.ADMIN_EMAILS || 'info@miti.nz,alps2ocean.foods.nz@gmail.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return new Set(raw);
}
function requireAdmin(req, res, next) {
  const email = (req.user && req.user.email || '').toLowerCase();
  if (!email || !adminEmails().has(email)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// POST /api/farms
app.post('/api/farms', requireAuth, async (req, res) => {
  const { farm_name, region, farm_type, herd_size } = req.body;
  if (!farm_name || !region || !farm_type) {
    return res.status(400).json({ error: 'farm_name, region, and farm_type are required' });
  }
  const { data, error } = await getSupabase()
    .from('farms')
    .insert({ farm_name, region, farm_type, herd_size: herd_size ? parseInt(herd_size, 10) : null, owner_id: req.user.id })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// GET /api/farms
app.get('/api/farms', requireAuth, async (req, res) => {
  const { data, error } = await getSupabase()
    .from('farms')
    .select('*, mobs(count)')
    .eq('owner_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/farms/:id
app.get('/api/farms/:id', requireAuth, async (req, res) => {
  const { data, error } = await getSupabase()
    .from('farms')
    .select('*, mobs(*)')
    .eq('id', req.params.id)
    .eq('owner_id', req.user.id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Farm not found' });
  res.json(data);
});

// POST /api/farms/:id/animals/upload
app.post('/api/farms/:id/animals/upload', requireAuth, upload.single('file'), async (req, res) => {
  const { data: farm, error: farmError } = await getSupabase()
    .from('farms')
    .select('id, farm_name')
    .eq('id', req.params.id)
    .eq('owner_id', req.user.id)
    .single();
  if (farmError || !farm) return res.status(404).json({ error: 'Farm not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // ── Livestock weighing/drafting export detection ──────────────────────────
  // These files have metadata header lines (FileNo:, Name:, Date:) followed by
  // one technical field-definition line, then the real column headers, then data.
  const rawText = req.file.buffer.toString('utf8');
  const allLines = rawText.split(/\r?\n/);
  const metaPattern = /^(FileNo|Name|Date):/i;

  let lineIndex = 0;
  let metaName = null;
  let metaDate = null;

  while (lineIndex < allLines.length && metaPattern.test(allLines[lineIndex])) {
    const line = allLines[lineIndex];
    const colonIdx = line.indexOf(':');
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    // Strip trailing commas (metadata values are padded with commas to match column count).
    // trim() first so \r doesn't sit after the commas and fool the regex anchor.
    const value = line.slice(colonIdx + 1).trim().replace(/,+$/, '').trim();
    if (key === 'name') metaName = value;
    if (key === 'date') metaDate = value;
    lineIndex++;
  }

  if (metaName !== null) {
    // Livestock weighing format confirmed — skip the technical field-definition line
    lineIndex++; // e.g. "F11EID(16)isID,DW2Weight(),..."

    // Next line is the real column headers (EID, Weight, Draft, ...)
    const headerLine = allLines[lineIndex];
    lineIndex++;

    // All remaining non-empty lines are animal data rows
    const dataLines = allLines.slice(lineIndex).filter(l => l.trim() !== '');

    let rows;
    try {
      rows = parse([headerLine, ...dataLines].join('\n'), {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });
    } catch (e) {
      return res.status(400).json({ error: 'Invalid CSV format in data section' });
    }

    if (rows.length === 0) return res.status(400).json({ error: 'CSV contains no data rows' });

    const head_count = rows.length;

    // Average weight (skip zero / missing values)
    const cols = Object.keys(rows[0]);
    const weightCol = cols.find(c => /^weight$/i.test(c));
    let avg_weight = null;
    if (weightCol) {
      const weights = rows
        .map(r => parseFloat(r[weightCol]))
        .filter(w => !isNaN(w) && w > 0);
      if (weights.length > 0) {
        avg_weight = Math.round((weights.reduce((a, b) => a + b, 0) / weights.length) * 10) / 10;
      }
    }

    const mob = {
      farm_id: req.params.id,
      mob_name: metaName,
      breed: null,
      sex: null,
      drop_type: null,
      head_count,
      updated_at: new Date().toISOString(),
      ...(avg_weight !== null ? { avg_weight } : {})
    };

    // Requires a unique constraint on (farm_id, mob_name) in Supabase:
    //   ALTER TABLE mobs ADD CONSTRAINT mobs_farm_id_mob_name_key UNIQUE (farm_id, mob_name);
    const { data, error } = await getSupabase().from('mobs').upsert([mob], { onConflict: 'farm_id,mob_name' }).select();
    if (error) return res.status(500).json({ error: error.message });

    // Phase 2a: record this upload as a weigh_history point.
    // Prefer the Date: metadata line over today; fall back to today if malformed.
    const weighDate = normaliseWeighDate(metaDate) || new Date().toISOString().slice(0, 10);
    if (data && data[0] && avg_weight !== null) {
      await getSupabase()
        .from('weigh_history')
        .upsert(
          { mob_id: data[0].id, weigh_date: weighDate, avg_lw: avg_weight, head_count },
          { onConflict: 'mob_id,weigh_date' }
        );
    }

    // Phase 3a: save raw CSV to storage + capture per-animal records.
    let animalsWritten = 0;
    if (data && data[0]) {
      const mobId = data[0].id;

      // 1) Archive the raw CSV so we have the source of truth for future re-parses.
      try {
        const storagePath = `${req.params.id}/${mobId}/${weighDate}.csv`;
        await getSupabase().storage
          .from('weigh-uploads')
          .upload(storagePath, req.file.buffer, { contentType: 'text/csv', upsert: true });
      } catch (e) {
        console.warn('[phase3a] storage upload failed:', e.message || e);
      }

      // 2) Upsert one row per animal into animal_weighs.
      const eidCol = cols.find(c => /^(eid|electronic[ _-]?id|rfid|tag[ _-]?id)$/i.test(c));
      const draftCol = cols.find(c => /^draft$/i.test(c));
      if (eidCol && weightCol) {
        const animalRows = [];
        for (const r of rows) {
          const eid = (r[eidCol] || '').toString().trim();
          const weight = parseFloat(r[weightCol]);
          if (!eid || isNaN(weight) || weight <= 0) continue;
          animalRows.push({
            mob_id: mobId,
            eid,
            weigh_date: weighDate,
            weight,
            draft: draftCol ? (r[draftCol] || '').toString().trim() || null : null
          });
        }
        if (animalRows.length) {
          // Chunk to avoid Supabase request limits on very large mobs.
          const CHUNK = 500;
          for (let i = 0; i < animalRows.length; i += CHUNK) {
            const { error: awErr } = await getSupabase()
              .from('animal_weighs')
              .upsert(animalRows.slice(i, i + CHUNK), { onConflict: 'eid,weigh_date' });
            if (awErr) {
              console.warn('[phase3a] animal_weighs upsert error:', awErr.message);
              break;
            }
          }
          animalsWritten = animalRows.length;
        }
      }
    }

    return res.json({
      inserted: data.length,
      mobs: data.map(m => ({ name: m.mob_name, head_count: m.head_count })),
      total: head_count,
      weigh_date: weighDate,
      animals_written: animalsWritten,
      ...(avg_weight !== null ? { avg_weight } : {})
    });
  }

  // ── Fallback: standard CSV (NAIT-style, group by Mob/Management Group column) ──
  let rows;
  try {
    rows = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).json({ error: 'Invalid CSV format' });
  }

  if (rows.length === 0) return res.status(400).json({ error: 'CSV contains no rows' });

  // Detect group column — NAIT NZ export uses "Management Group"; accept common alternatives
  const cols = Object.keys(rows[0]);
  const groupCol = cols.find(c =>
    /management.?group/i.test(c) ||
    /^mob$/i.test(c) ||
    /mob.?name/i.test(c) ||
    /^group$/i.test(c) ||
    /^herd$/i.test(c)
  );
  const breedCol = cols.find(c => /^breed/i.test(c));
  const sexCol = cols.find(c => /^sex$/i.test(c) || /^gender$/i.test(c) || /animal.?type/i.test(c));

  // Group all rows by mob name — if no group column, everything goes into one mob
  const uploadDate = new Date().toISOString().slice(0, 10);
  const defaultMobName = `Upload ${uploadDate}`;
  const groups = {};
  for (const row of rows) {
    const key = groupCol ? (row[groupCol].trim() || defaultMobName) : defaultMobName;
    if (!groups[key]) groups[key] = { breed: null, sex: null, count: 0 };
    groups[key].count++;
    if (!groups[key].breed && breedCol) groups[key].breed = row[breedCol] || null;
    if (!groups[key].sex && sexCol) groups[key].sex = row[sexCol] || null;
  }

  const now = new Date().toISOString();
  const mobs = Object.entries(groups).map(([mobName, g]) => ({
    farm_id: req.params.id,
    mob_name: mobName,
    breed: g.breed,
    sex: g.sex,
    drop_type: null,
    head_count: g.count,
    updated_at: now
  }));

  // Requires a unique constraint on (farm_id, mob_name) in Supabase:
  //   ALTER TABLE mobs ADD CONSTRAINT mobs_farm_id_mob_name_key UNIQUE (farm_id, mob_name);
  const { data, error } = await getSupabase().from('mobs').upsert(mobs, { onConflict: 'farm_id,mob_name' }).select();
  if (error) return res.status(500).json({ error: error.message });

  // Phase 2a: the standard-CSV path has no per-mob avg weight today, so we skip
  // the weigh_history insert here. When that CSV format carries weights,
  // extend this to insert per-mob rows keyed by today's date.

  res.json({ inserted: data.length, mobs: data.map(m => ({ name: m.mob_name, head_count: m.head_count })), total: rows.length });
});

// GET /api/farms/:id/animals
app.get('/api/farms/:id/animals', requireAuth, async (req, res) => {
  const { data: farm, error: farmError } = await getSupabase()
    .from('farms')
    .select('id')
    .eq('id', req.params.id)
    .eq('owner_id', req.user.id)
    .single();
  if (farmError || !farm) return res.status(404).json({ error: 'Farm not found' });

  const { data, error } = await getSupabase()
    .from('mobs')
    .select('*')
    .eq('farm_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/stats — returns only the authenticated farmer's own counts
app.get('/api/stats', requireAuth, async (req, res) => {
  const { count: farmCount, error: farmError } = await getSupabase()
    .from('farms')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', req.user.id);
  if (farmError) return res.status(500).json({ error: farmError.message });

  const { data: farms } = await getSupabase()
    .from('farms')
    .select('id')
    .eq('owner_id', req.user.id);

  const farmIds = (farms || []).map(f => f.id);
  let mobCount = 0;
  if (farmIds.length > 0) {
    const { count, error: mobError } = await getSupabase()
      .from('mobs')
      .select('id', { count: 'exact', head: true })
      .in('farm_id', farmIds);
    if (mobError) return res.status(500).json({ error: mobError.message });
    mobCount = count;
  }

  res.json({ farms: farmCount, mobs: mobCount });
});

// Phase 2a: normalise various date formats from livestock weighing CSVs.
function normaliseWeighDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return s;
  const dmy = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(s);
  if (dmy) {
    const [, d, m, y] = dmy;
    const dd = d.padStart(2, '0'), mm = m.padStart(2, '0');
    if (+mm < 1 || +mm > 12 || +dd < 1 || +dd > 31 || +y < 2000) return null;
    return `${y}-${mm}-${dd}`;
  }
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                   jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const mon = /^(\d{1,2})[\s\-]+([A-Za-z]{3,})[\s\-]+(\d{4})$/.exec(s);
  if (mon) {
    const [, d, mName, y] = mon;
    const mm = months[mName.slice(0, 3).toLowerCase()];
    if (!mm || +y < 2000) return null;
    return `${y}-${mm}-${d.padStart(2, '0')}`;
  }
  return null;
}

// Helper - does this mob belong to a farm owned by req.user?
async function loadOwnedMob(supabase, mobId, userId) {
  const { data } = await supabase
    .from('mobs')
    .select('id, farm_id, mob_name, breed, sex, drop_type, class, origin, birth_date, head_count, avg_weight, updated_at, created_at, farms!inner(owner_id, farm_name, region, farm_type)')
    .eq('id', mobId)
    .eq('farms.owner_id', userId)
    .single();
  return data;
}

// GET /api/mobs/:id - single mob, for the detail view
app.get('/api/mobs/:id', requireAuth, async (req, res) => {
  const mob = await loadOwnedMob(getSupabase(), req.params.id, req.user.id);
  if (!mob) return res.status(404).json({ error: 'Mob not found' });
  res.json(mob);
});

// GET /api/mobs/:id/weigh-history - time series for the chart
app.get('/api/mobs/:id/weigh-history', requireAuth, async (req, res) => {
  const mob = await loadOwnedMob(getSupabase(), req.params.id, req.user.id);
  if (!mob) return res.status(404).json({ error: 'Mob not found' });
  const { data, error } = await getSupabase()
    .from('weigh_history')
    .select('weigh_date, avg_lw, head_count')
    .eq('mob_id', req.params.id)
    .order('weigh_date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/mobs/:id/attrition - loss events
app.get('/api/mobs/:id/attrition', requireAuth, async (req, res) => {
  const mob = await loadOwnedMob(getSupabase(), req.params.id, req.user.id);
  if (!mob) return res.status(404).json({ error: 'Mob not found' });
  const { data, error } = await getSupabase()
    .from('attrition')
    .select('event_date, reason, head_count')
    .eq('mob_id', req.params.id)
    .order('event_date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/mobs/:id/animals — one row per EID with latest weight, recent+lifetime ADG, weigh count.
app.get('/api/mobs/:id/animals', requireAuth, async (req, res) => {
  const mob = await loadOwnedMob(getSupabase(), req.params.id, req.user.id);
  if (!mob) return res.status(404).json({ error: 'Mob not found' });

  // Pull all weighs for this mob, sorted oldest first. We aggregate in Node
  // since pure-SQL ADG across array positions is clumsy without a view.
  const { data, error } = await getSupabase()
    .from('animal_weighs')
    .select('eid, weigh_date, weight, draft')
    .eq('mob_id', req.params.id)
    .order('eid', { ascending: true })
    .order('weigh_date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const byEid = new Map();
  for (const row of data || []) {
    if (!byEid.has(row.eid)) byEid.set(row.eid, []);
    byEid.get(row.eid).push(row);
  }

  const out = [];
  for (const [eid, history] of byEid) {
    const first = history[0];
    const last = history[history.length - 1];
    const nWeighs = history.length;
    const firstDate = new Date(first.weigh_date);
    const lastDate = new Date(last.weigh_date);

    // Lifetime ADG: first to last weigh. Null if only one weigh.
    let lifetimeAdg = null;
    if (nWeighs >= 2) {
      const days = (lastDate - firstDate) / 86400000;
      if (days > 0) lifetimeAdg = +(((Number(last.weight) - Number(first.weight)) / days) * 1000).toFixed(0);
    }

    // Recent ADG: last two weighs.
    let recentAdg = null;
    if (nWeighs >= 2) {
      const prev = history[history.length - 2];
      const days = (lastDate - new Date(prev.weigh_date)) / 86400000;
      if (days > 0) recentAdg = +(((Number(last.weight) - Number(prev.weight)) / days) * 1000).toFixed(0);
    }

    out.push({
      eid,
      latest_weight: Number(last.weight),
      latest_date: last.weigh_date,
      first_weight: Number(first.weight),
      first_date: first.weigh_date,
      n_weighs: nWeighs,
      recent_adg: recentAdg,
      lifetime_adg: lifetimeAdg,
      draft: last.draft || null
    });
  }

  res.json(out);
});

// GET /api/mobs/:id/animals/:eid/weigh-history — single animal's history
app.get('/api/mobs/:id/animals/:eid/weigh-history', requireAuth, async (req, res) => {
  const mob = await loadOwnedMob(getSupabase(), req.params.id, req.user.id);
  if (!mob) return res.status(404).json({ error: 'Mob not found' });

  const { data, error } = await getSupabase()
    .from('animal_weighs')
    .select('weigh_date, weight, draft')
    .eq('mob_id', req.params.id)
    .eq('eid', req.params.eid)
    .order('weigh_date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PATCH /api/mobs/:id — save farmer-editable options (class/origin/birth_date)
app.patch('/api/mobs/:id', requireAuth, async (req, res) => {
  const mob = await loadOwnedMob(getSupabase(), req.params.id, req.user.id);
  if (!mob) return res.status(404).json({ error: 'Mob not found' });

  const body = req.body || {};
  const allowedClass  = ['steer', 'heifer', 'bull'];
  const allowedOrigin = ['dairy', 'beef'];

  const update = { updated_at: new Date().toISOString() };
  if ('class'  in body) {
    const v = (body.class  || '').toString().trim().toLowerCase() || null;
    if (v !== null && !allowedClass.includes(v))  return res.status(400).json({ error: 'class must be steer/heifer/bull' });
    update.class = v;
  }
  if ('origin' in body) {
    const v = (body.origin || '').toString().trim().toLowerCase() || null;
    if (v !== null && !allowedOrigin.includes(v)) return res.status(400).json({ error: 'origin must be dairy/beef' });
    update.origin = v;
  }
  if ('birth_date' in body) {
    const v = body.birth_date;
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v))    return res.status(400).json({ error: 'birth_date must be YYYY-MM-DD' });
    update.birth_date = v || null;
  }

  const { data, error } = await getSupabase()
    .from('mobs')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ───────────────────────────────────────────────────────────────────
// Admin API — platform-wide read-only views. Gated by requireAdmin.
// All queries use the service role key (see getSupabase) so they
// bypass RLS and see every farmer's data. Never add writes here
// without explicit scoping.
// ───────────────────────────────────────────────────────────────────

// Tiny cache so the heavy user list doesn't re-query Auth on every refresh.
let _usersCache = { at: 0, rows: null };
async function listAllAuthUsers() {
  if (_usersCache.rows && Date.now() - _usersCache.at < 30_000) return _usersCache.rows;
  const sb = getSupabase();
  const rows = [];
  let page = 1;
  while (true) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const batch = (data && data.users) || [];
    rows.push(...batch);
    if (batch.length < 1000) break;
    page++;
    if (page > 20) break; // hard stop at 20k users
  }
  _usersCache = { at: Date.now(), rows };
  return rows;
}

// GET /api/admin/overview — platform totals + recent activity
app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sb = getSupabase();
    const [users, farmsR, mobsR, whR, awR] = await Promise.all([
      listAllAuthUsers(),
      sb.from('farms').select('id, owner_id, created_at'),
      sb.from('mobs').select('id, farm_id, head_count, avg_weight, updated_at, created_at'),
      sb.from('weigh_history').select('id, mob_id, weigh_date, created_at'),
      sb.from('animal_weighs').select('eid, weigh_date, created_at')
    ]);
    if (farmsR.error) throw farmsR.error;
    if (mobsR.error)  throw mobsR.error;
    if (whR.error)    throw whR.error;
    if (awR.error)    throw awR.error;

    const now = Date.now();
    const d7  = now - 7  * 86400_000;
    const d30 = now - 30 * 86400_000;
    const since = (iso, cutoff) => iso && new Date(iso).getTime() >= cutoff;

    const farms = farmsR.data || [];
    const mobs  = mobsR.data  || [];
    const wh    = whR.data    || [];
    const aw    = awR.data    || [];

    const totalHead = mobs.reduce((s, m) => s + (Number(m.head_count) || 0), 0);
    const distinctEids = new Set(aw.map(a => a.eid)).size;

    res.json({
      users: users.length,
      users_last_7d:  users.filter(u => since(u.created_at, d7)).length,
      users_last_30d: users.filter(u => since(u.created_at, d30)).length,
      confirmed_users: users.filter(u => u.email_confirmed_at || u.confirmed_at).length,
      farms: farms.length,
      farms_last_7d:  farms.filter(f => since(f.created_at, d7)).length,
      mobs: mobs.length,
      total_head: totalHead,
      weigh_history_rows: wh.length,
      animal_weighs_rows: aw.length,
      distinct_eids: distinctEids,
      uploads_last_7d:  wh.filter(w => since(w.created_at, d7)).length,
      uploads_last_30d: wh.filter(w => since(w.created_at, d30)).length,
      generated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('[admin/overview]', e);
    res.status(500).json({ error: e.message || 'Overview failed' });
  }
});

// GET /api/admin/users — per-user rollup for the platform user table
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sb = getSupabase();
    const [users, farmsR, mobsR, whR, awR] = await Promise.all([
      listAllAuthUsers(),
      sb.from('farms').select('id, owner_id, farm_name, region, farm_type, created_at'),
      sb.from('mobs').select('id, farm_id, head_count, updated_at'),
      sb.from('weigh_history').select('mob_id, weigh_date, created_at'),
      sb.from('animal_weighs').select('mob_id, eid, weigh_date, created_at')
    ]);
    if (farmsR.error) throw farmsR.error;
    if (mobsR.error)  throw mobsR.error;
    if (whR.error)    throw whR.error;
    if (awR.error)    throw awR.error;

    const farmsByOwner = new Map();  // owner_id -> farm[]
    for (const f of farmsR.data || []) {
      if (!farmsByOwner.has(f.owner_id)) farmsByOwner.set(f.owner_id, []);
      farmsByOwner.get(f.owner_id).push(f);
    }

    const mobsByFarm = new Map();    // farm_id -> mob[]
    for (const m of mobsR.data || []) {
      if (!mobsByFarm.has(m.farm_id)) mobsByFarm.set(m.farm_id, []);
      mobsByFarm.get(m.farm_id).push(m);
    }

    const whByMob = new Map();       // mob_id -> weigh_history[]
    for (const w of whR.data || []) {
      if (!whByMob.has(w.mob_id)) whByMob.set(w.mob_id, []);
      whByMob.get(w.mob_id).push(w);
    }

    const awByMob = new Map();       // mob_id -> animal_weighs[]
    for (const a of awR.data || []) {
      if (!awByMob.has(a.mob_id)) awByMob.set(a.mob_id, []);
      awByMob.get(a.mob_id).push(a);
    }

    const out = users.map(u => {
      const farms = farmsByOwner.get(u.id) || [];
      let mobCount = 0, totalHead = 0, weighRows = 0, animalRows = 0;
      const eidSet = new Set();
      let lastActivity = null;
      for (const f of farms) {
        const fMobs = mobsByFarm.get(f.id) || [];
        mobCount += fMobs.length;
        for (const m of fMobs) {
          totalHead += Number(m.head_count) || 0;
          if (m.updated_at && (!lastActivity || m.updated_at > lastActivity)) lastActivity = m.updated_at;
          const whs = whByMob.get(m.id) || [];
          weighRows += whs.length;
          for (const w of whs) {
            if (w.created_at && (!lastActivity || w.created_at > lastActivity)) lastActivity = w.created_at;
          }
          const aws = awByMob.get(m.id) || [];
          animalRows += aws.length;
          for (const a of aws) eidSet.add(a.eid);
        }
      }
      return {
        id: u.id,
        email: u.email || '(no email)',
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at || null,
        email_confirmed_at: u.email_confirmed_at || u.confirmed_at || null,
        farm_count: farms.length,
        mob_count: mobCount,
        total_head: totalHead,
        weigh_rows: weighRows,
        animal_rows: animalRows,
        distinct_eids: eidSet.size,
        last_activity: lastActivity,
        farms: farms.map(f => ({
          id: f.id, farm_name: f.farm_name, region: f.region, farm_type: f.farm_type, created_at: f.created_at,
          mobs: (mobsByFarm.get(f.id) || []).map(m => ({
            id: m.id,
            head_count: m.head_count,
            updated_at: m.updated_at,
            weigh_count: (whByMob.get(m.id) || []).length,
            animal_rows: (awByMob.get(m.id) || []).length
          }))
        }))
      };
    });

    // Sort: most recent activity first, then newest signup
    out.sort((a, b) => {
      const la = a.last_activity || a.created_at || '';
      const lb = b.last_activity || b.created_at || '';
      return lb.localeCompare(la);
    });

    res.json({ users: out, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error('[admin/users]', e);
    res.status(500).json({ error: e.message || 'User list failed' });
  }
});

// Explicit route so /admin serves admin.html (catchall would return index.html)
app.get('/admin', (_req, res) => res.sendFile('admin.html', { root: 'public' }));

app.get('*', (_req, res) => res.sendFile('index.html', { root: 'public' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KaiProva server running on port ${PORT} (admin: /admin)`));
