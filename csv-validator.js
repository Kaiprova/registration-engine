const { parse } = require('csv-parse/sync');

// Validation rules
const VALID_SEX = ['bull', 'steer', 'heifer'];
const EID_PATTERN = /^982\s?\d{12,15}$/;
const MIN_BIRTH_WEIGHT = 25;
const MAX_BIRTH_WEIGHT = 55;
const MAX_AGE_MONTHS = 24;

function normalizeEid(eid) {
  if (!eid) return null;
  // Normalize: ensure space after 982
  const cleaned = eid.toString().trim().replace(/\s+/g, ' ');
  if (cleaned.startsWith('982') && !cleaned.includes(' ')) {
    return '982 ' + cleaned.substring(3);
  }
  return cleaned;
}

function validateAnimalRow(row, rowIndex, country) {
  const errors = [];
  const warnings = [];

  // Required fields
  if (!row.eid || !row.eid.trim()) {
    errors.push({ field: 'eid', message: 'Electronic ID is required' });
  } else {
    const normalized = normalizeEid(row.eid);
    if (!EID_PATTERN.test(normalized.replace(/\s/g, ''))) {
      errors.push({ field: 'eid', message: `Invalid EID format: "${row.eid}". Expected format: 982 XXXXXXXXXXXX` });
    }
  }

  if (!row.sex || !row.sex.trim()) {
    errors.push({ field: 'sex', message: 'Sex is required' });
  } else if (!VALID_SEX.includes(row.sex.trim().toLowerCase())) {
    errors.push({ field: 'sex', message: `Invalid sex: "${row.sex}". Must be one of: ${VALID_SEX.join(', ')}` });
  }

  if (!row.birth_date || !row.birth_date.trim()) {
    errors.push({ field: 'birth_date', message: 'Birth date is required' });
  } else {
    const bd = new Date(row.birth_date.trim());
    if (isNaN(bd.getTime())) {
      errors.push({ field: 'birth_date', message: `Invalid date format: "${row.birth_date}". Use YYYY-MM-DD` });
    } else {
      const ageMonths = (Date.now() - bd.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
      if (ageMonths > MAX_AGE_MONTHS) {
        errors.push({ field: 'birth_date', message: `Animal is over ${MAX_AGE_MONTHS} months old. KaiProva is for young dairy beef (10-18 months)` });
      }
      if (bd > new Date()) {
        errors.push({ field: 'birth_date', message: 'Birth date cannot be in the future' });
      }
    }
  }

  // Optional but validated fields
  if (row.birth_weight_kg && row.birth_weight_kg.trim()) {
    const bw = parseFloat(row.birth_weight_kg);
    if (isNaN(bw)) {
      errors.push({ field: 'birth_weight_kg', message: `Invalid birth weight: "${row.birth_weight_kg}"` });
    } else if (bw < MIN_BIRTH_WEIGHT || bw > MAX_BIRTH_WEIGHT) {
      warnings.push({ field: 'birth_weight_kg', message: `Birth weight ${bw} kg is outside typical range (${MIN_BIRTH_WEIGHT}-${MAX_BIRTH_WEIGHT} kg)` });
    }
  }

  return {
    row: rowIndex + 1,
    valid: errors.length === 0,
    errors,
    warnings,
    data: errors.length === 0 ? {
      eid: normalizeEid(row.eid),
      vid: (row.vid || '').trim() || null,
      sex: row.sex.trim().toLowerCase(),
      breed: (row.breed || '').trim() || null,
      birth_date: row.birth_date.trim(),
      birth_weight_kg: row.birth_weight_kg ? parseFloat(row.birth_weight_kg) : null,
      birth_farm_id: (row.birth_farm_id || '').trim() || null,
      dam_eid: row.dam_eid ? normalizeEid(row.dam_eid) : null,
      sire_breed: (row.sire_breed || '').trim() || null,
      collection_date: (row.collection_date || '').trim() || null,
      collection_weight_kg: row.collection_weight_kg ? parseFloat(row.collection_weight_kg) : null,
      notes: (row.notes || '').trim() || null,
    } : null
  };
}

function parseAnimalCSV(csvBuffer, country) {
  let records;
  try {
    records = parse(csvBuffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (err) {
    return {
      success: false,
      error: `CSV parsing failed: ${err.message}`,
      results: []
    };
  }

  if (records.length === 0) {
    return {
      success: false,
      error: 'CSV file is empty or has no data rows',
      results: []
    };
  }

  // Check for required columns
  const columns = Object.keys(records[0]);
  const required = ['eid', 'sex', 'birth_date'];
  const missing = required.filter(col => !columns.includes(col));
  if (missing.length > 0) {
    return {
      success: false,
      error: `Missing required columns: ${missing.join(', ')}. Required: eid, sex, birth_date`,
      results: []
    };
  }

  const results = records.map((row, i) => validateAnimalRow(row, i, country));

  return {
    success: true,
    total: results.length,
    accepted: results.filter(r => r.valid).length,
    rejected: results.filter(r => !r.valid).length,
    results
  };
}

module.exports = { parseAnimalCSV, normalizeEid };
