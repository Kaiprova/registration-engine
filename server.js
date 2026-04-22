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
    .select('id')
    .eq('id', req.params.id)
    .eq('owner_id', req.user.id)
    .single();
  if (farmError || !farm) return res.status(404).json({ error: 'Farm not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let rows;
  try {
    rows = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).json({ error: 'Invalid CSV format' });
  }

  if (rows.length === 0) return res.status(400).json({ error: 'CSV contains no rows' });

  const mobs = rows.map(row => ({
    farm_id: req.params.id,
    mob_name: row.mob_name || row.name || `Mob ${Date.now()}`,
    breed: row.breed || null,
    sex: row.sex || null,
    drop_type: row.drop_type || null,
    head_count: parseInt(row.head_count || row.count || '0', 10) || 0
  }));

  const { data, error } = await getSupabase().from('mobs').insert(mobs).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ inserted: data.length, total: rows.length });
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
