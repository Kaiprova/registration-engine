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

  while (lineIndex < allLines.length && metaPattern.test(allLines[lineIndex])) {
    const line = allLines[lineIndex];
    const colonIdx = line.indexOf(':');
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    // Strip trailing commas (metadata values are padded with commas to match column count).
    // trim() first so \r doesn't sit after the commas and fool the regex anchor.
    const value = line.slice(colonIdx + 1).trim().replace(/,+$/, '').trim();
    if (key === 'name') metaName = value;
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
      ...(avg_weight !== null ? { avg_weight } : {})
    };

    // Requires a unique constraint on (farm_id, mob_name) in Supabase:
    //   ALTER TABLE mobs ADD CONSTRAINT mobs_farm_id_mob_name_key UNIQUE (farm_id, mob_name);
    const { data, error } = await getSupabase().from('mobs').upsert([mob], { onConflict: 'farm_id,mob_name' }).select();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({
      inserted: data.length,
      mobs: data.map(m => ({ name: m.mob_name, head_count: m.head_count })),
      total: head_count,
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

  const mobs = Object.entries(groups).map(([mobName, g]) => ({
    farm_id: req.params.id,
    mob_name: mobName,
    breed: g.breed,
    sex: g.sex,
    drop_type: null,
    head_count: g.count
  }));

  // Requires a unique constraint on (farm_id, mob_name) in Supabase:
  //   ALTER TABLE mobs ADD CONSTRAINT mobs_farm_id_mob_name_key UNIQUE (farm_id, mob_name);
  const { data, error } = await getSupabase().from('mobs').upsert(mobs, { onConflict: 'farm_id,mob_name' }).select();
  if (error) return res.status(500).json({ error: error.message });
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
    .select('*, weigh_events(*)')
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

app.get('*', (_req, res) => res.sendFile('index.html', { root: 'public' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KaiProva server running on port ${PORT}`));
