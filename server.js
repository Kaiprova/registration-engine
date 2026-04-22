const express = require('express');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { parseAnimalCSV } = require('./csv-validator');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted'));
    }
  }
});

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
  req.user = user;
  next();
}

app.post('/api/farms', requireAuth, async (req, res) => {
  const { farm_name, region, farm_type } = req.body;
  const errors = [];
  if (!farm_name) errors.push('Farm name is required');
  if (!region) errors.push('Region is required');
  if (!farm_type) errors.push('Farm type is required');
  if (errors.length > 0) return res.status(400).json({ success: false, errors });

  const { data, error } = await supabase
    .from('farms')
    .insert({ farm_name, region, farm_type, owner_id: req.user.id })
    .select()
    .single();

  if (error) {
    console.error('Farm insert error:', error);
    return res.status(500).json({ success: false, errors: ['Failed to register farm'] });
  }
  res.json({ success: true, farm_id: data.id, farm: data });
});

app.get('/api/farms', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('farms')
    .select('*')
    .eq('owner_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ success: false, error: 'Failed to load farms' });
  }
  res.json({ success: true, farms: data });
});

app.get('/api/farms/:id', requireAuth, async (req, res) => {
  const { data: farm, error } = await supabase
    .from('farms')
    .select('*')
    .eq('id', req.params.id)
    .eq('owner_id', req.user.id)
    .single();

  if (error || !farm) {
    return res.status(404).json({ success: false, error: 'Farm not found' });
  }

  const { data: mobs } = await supabase
    .from('mobs')
    .select('*')
    .eq('farm_id', req.params.id)
    .order('created_at', { ascending: false });

  res.json({ success: true, farm, mobs: mobs || [] });
});

app.post('/api/farms/:id/animals/upload', requireAuth, upload.single('csv'), async (req, res) => {
  const { data: farm, error: farmError } = await supabase
    .from('farms')
    .select('id')
    .eq('id', req.params.id)
    .eq('owner_id', req.user.id)
    .single();

  if (farmError || !farm) {
    return res.status(404).json({ success: false, error: 'Farm not found' });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No CSV file uploaded' });
  }

  const csvContent = req.file.buffer.toString('utf-8');
  const parseResult = parseAnimalCSV(csvContent, 'NZ');

  if (!parseResult.success) {
    return res.status(400).json({ success: false, error: parseResult.error });
  }

  const validRows = parseResult.results.filter(r => r.valid && r.data);
  const mobRecords = validRows.map(r => ({
    farm_id: req.params.id,
    mob_name: r.data.eid,
  }));

  let inserted = 0;
  if (mobRecords.length > 0) {
    const { data, error } = await supabase.from('mobs').insert(mobRecords).select();
    if (!error && data) inserted = data.length;
    if (error) console.error('Mob insert error:', error);
  }

  res.json({
    success: true,
    summary: {
      total_rows: parseResult.total,
      inserted,
      rejected: parseResult.rejected,
    },
  });
});

app.get('/api/farms/:id/animals', requireAuth, async (req, res) => {
  const { data: farm, error: farmError } = await supabase
    .from('farms')
    .select('id')
    .eq('id', req.params.id)
    .eq('owner_id', req.user.id)
    .single();

  if (farmError || !farm) {
    return res.status(404).json({ success: false, error: 'Farm not found' });
  }

  const { data: mobs, error } = await supabase
    .from('mobs')
    .select('*')
    .eq('farm_id', req.params.id)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ success: false, error: 'Failed to load animals' });
  }
  res.json({ success: true, mobs: mobs || [] });
});

app.get('/api/stats', requireAuth, async (req, res) => {
  const { data: farms, error: farmError } = await supabase
    .from('farms')
    .select('id')
    .eq('owner_id', req.user.id);

  if (farmError) {
    return res.status(500).json({ success: false, error: 'Failed to load stats' });
  }

  const farmIds = (farms || []).map(f => f.id);
  let mobCount = 0;
  if (farmIds.length > 0) {
    const { count } = await supabase
      .from('mobs')
      .select('*', { count: 'exact', head: true })
      .in('farm_id', farmIds);
    mobCount = count || 0;
  }

  res.json({
    success: true,
    stats: {
      total_farms: farmIds.length,
      total_mobs: mobCount,
    },
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('KaiProva registration engine running on port ' + PORT);
});
