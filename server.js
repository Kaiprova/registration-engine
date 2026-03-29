const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('./db');
const { parseAnimalCSV } = require('./csv-validator');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.post('/api/farms', (req, res) => {
  const { farm_name, contact_name, email, phone, country, region, traceability_id, farm_type, calving_season, non_replacements_available, notes } = req.body;
  const errors = [];
  if (!farm_name) errors.push('Farm name is required');
  if (!contact_name) errors.push('Contact name is required');
  if (!email) errors.push('Email is required');
  if (!country || !['NZ', 'AU'].includes(country)) errors.push('Country must be NZ or AU');
  if (!region) errors.push('Region is required');
  if (!traceability_id) errors.push(country === 'AU' ? 'NLIS PIC is required' : 'NAIT number is required');
  if (!farm_type) errors.push('Farm type is required');
  if (errors.length > 0) return res.status(400).json({ success: false, errors });
  try {
    const stmt = db.prepare('INSERT INTO farms (farm_name, contact_name, email, phone, country, region, traceability_id, farm_type, calving_season, non_replacements_available, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const result = stmt.run(farm_name, contact_name, email, phone || null, country, region, traceability_id, farm_type, calving_season || null, non_replacements_available ? parseInt(non_replacements_available) : null, notes || null);
    res.json({ success: true, farm_id: result.lastInsertRowid, message: 'Farm registered successfully.' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ success: false, errors: ['A farm with this traceability ID already exists'] });
    console.error('Farm registration error:', err);
    res.status(500).json({ success: false, errors: ['Internal server error'] });
  }
});

app.get('/api/farms/:id', (req, res) => {
  const farm = db.prepare('SELECT * FROM farms WHERE id = ?').get(req.params.id);
  if (!farm) return res.status(404).json({ success: false, error: 'Farm not found' });
  const mobs = db.prepare('SELECT * FROM mobs WHERE farm_id = ? ORDER BY created_at DESC').all(req.params.id);
  const animalCount = db.prepare('SELECT COUNT(*) as count FROM animals WHERE farm_id = ?').get(req.params.id);
  const uploads = db.prepare('SELECT * FROM csv_uploads WHERE farm_id = ? ORDER BY created_at DESC LIMIT 10').all(req.params.id);
  res.json({ success: true, farm, mobs, total_animals: animalCount.count, recent_uploads: uploads });
});

app.post('/api/farms/:id/animals/upload', upload.single('csv'), (req, res) => {
  const farm = db.prepare('SELECT * FROM farms WHERE id = ?').get(req.params.id);
  if (!farm) return res.status(404).json({ success: false, error: 'Farm not found' });
  if (!req.file) return res.status(400).json({ success: false, error: 'No CSV file uploaded' });
  const csvContent = req.file.buffer.toString('utf-8');
  const parseResult = parseAnimalCSV(csvContent, farm.country);
  if (!parseResult.success) return res.status(400).json({ success: false, error: parseResult.error });
  const insertAnimal = db.prepare('INSERT OR IGNORE INTO animals (farm_id, eid, vid, sex, breed, birth_date, birth_weight_kg, birth_farm_id, dam_eid, sire_breed, collection_date, collection_weight_kg, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let inserted = 0;
  let duplicates = 0;
  const insertMany = db.transaction((rows) => {
    for (const result of rows) {
      if (!result.valid || !result.data) continue;
      const d = result.data;
      try {
        const r = insertAnimal.run(farm.id, d.eid, d.vid, d.sex, d.breed, d.birth_date, d.birth_weight_kg, d.birth_farm_id, d.dam_eid, d.sire_breed, d.collection_date, d.collection_weight_kg, d.notes);
        if (r.changes > 0) inserted++;
        else duplicates++;
      } catch (err) { duplicates++; }
    }
  });
  insertMany(parseResult.results);
  const errorDetails = parseResult.results.filter(r => !r.valid).map(r => ({ row: r.row, errors: r.errors }));
  db.prepare('INSERT INTO csv_uploads (farm_id, filename, upload_type, rows_total, rows_accepted, rows_rejected, errors) VALUES (?, ?, ?, ?, ?, ?, ?)').run(farm.id, req.file.originalname, 'animal_registration', parseResult.total, inserted, parseResult.rejected + duplicates, JSON.stringify(errorDetails));
  res.json({ success: true, summary: { total_rows: parseResult.total, inserted, duplicates, rejected: parseResult.rejected } });
});

app.get('/api/farms/:id/animals', (req, res) => {
  const farm = db.prepare('SELECT * FROM farms WHERE id = ?').get(req.params.id);
  if (!farm) return res.status(404).json({ success: false, error: 'Farm not found' });
  const animals = db.prepare('SELECT a.*, m.mob_name FROM animals a LEFT JOIN mobs m ON a.mob_id = m.id WHERE a.farm_id = ? ORDER BY a.birth_date DESC').all(req.params.id);
  const stats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN sex = 'bull' THEN 1 ELSE 0 END) as bulls, SUM(CASE WHEN sex = 'steer' THEN 1 ELSE 0 END) as steers, SUM(CASE WHEN sex = 'heifer' THEN 1 ELSE 0 END) as heifers, AVG(birth_weight_kg) as avg_birth_weight FROM animals WHERE farm_id = ?").get(req.params.id);
  res.json({ success: true, animals, stats });
});

app.get('/api/farms', (req, res) => {
  const farms = db.prepare('SELECT f.*, (SELECT COUNT(*) FROM animals WHERE farm_id = f.id) as animal_count, (SELECT COUNT(*) FROM mobs WHERE farm_id = f.id) as mob_count FROM farms f ORDER BY f.created_at DESC').all();
  res.json({ success: true, farms });
});

app.get('/api/stats', (req, res) => {
  try {
    const farmCount = db.prepare('SELECT COUNT(*) as count FROM farms').get();
    const animalCount = db.prepare('SELECT COUNT(*) as count FROM animals').get();
    const nzFarms = db.prepare("SELECT COUNT(*) as count FROM farms WHERE country = 'NZ'").get();
    const auFarms = db.prepare("SELECT COUNT(*) as count FROM farms WHERE country = 'AU'").get();
    res.json({ success: true, stats: { total_farms: farmCount.count, total_animals: animalCount.count, nz_farms: nzFarms.count, au_farms: auFarms.count } });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ success: false, error: 'Failed to load stats' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('KaiProva registration engine running on port ' + PORT);
});
