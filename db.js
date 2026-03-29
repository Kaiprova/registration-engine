const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'kaiprova.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS farms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_name TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    country TEXT NOT NULL CHECK (country IN ('NZ', 'AU')),
    region TEXT NOT NULL,
    traceability_id TEXT NOT NULL,  -- NAIT number (NZ) or NLIS PIC (AU)
    farm_type TEXT NOT NULL CHECK (farm_type IN ('dairy_birth', 'rearer', 'finisher', 'rearer_finisher')),
    calving_season TEXT CHECK (calving_season IN ('spring', 'autumn', 'split')),
    non_replacements_available INTEGER,  -- head per season
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'active', 'suspended')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS mobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL REFERENCES farms(id),
    mob_name TEXT NOT NULL,
    sex TEXT NOT NULL CHECK (sex IN ('bull', 'steer', 'heifer', 'mixed')),
    breed TEXT,
    head_count INTEGER NOT NULL,
    avg_birth_date DATE,
    avg_birth_weight_kg REAL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'contracted', 'processed', 'archived')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(farm_id, mob_name)
  );

  CREATE TABLE IF NOT EXISTS animals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL REFERENCES farms(id),
    mob_id INTEGER REFERENCES mobs(id),
    eid TEXT NOT NULL UNIQUE,  -- Electronic ID (RFID tag)
    vid TEXT,  -- Visual ID (ear tag)
    sex TEXT NOT NULL CHECK (sex IN ('bull', 'steer', 'heifer')),
    breed TEXT,
    birth_date DATE NOT NULL,
    birth_weight_kg REAL,
    birth_farm_id TEXT,  -- NAIT/NLIS of birth property
    collection_date DATE,
    collection_weight_kg REAL,
    dam_eid TEXT,
    sire_breed TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'deceased', 'processed')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS weigh_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    animal_id INTEGER NOT NULL REFERENCES animals(id),
    eid TEXT NOT NULL,
    weigh_date DATE NOT NULL,
    live_weight_kg REAL NOT NULL,
    location_id TEXT,  -- NAIT/NLIS of weigh location
    method TEXT CHECK (method IN ('platform_scale', 'walk_over', 'estimate')),
    condition_score REAL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS csv_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL REFERENCES farms(id),
    filename TEXT NOT NULL,
    upload_type TEXT NOT NULL CHECK (upload_type IN ('animal_registration', 'weigh_record', 'movement_event')),
    rows_total INTEGER,
    rows_accepted INTEGER,
    rows_rejected INTEGER,
    errors TEXT,  -- JSON array of error details
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_animals_farm ON animals(farm_id);
  CREATE INDEX IF NOT EXISTS idx_animals_mob ON animals(mob_id);
  CREATE INDEX IF NOT EXISTS idx_animals_eid ON animals(eid);
  CREATE INDEX IF NOT EXISTS idx_weigh_records_animal ON weigh_records(animal_id);
  CREATE INDEX IF NOT EXISTS idx_mobs_farm ON mobs(farm_id);
`);

module.exports = db;
