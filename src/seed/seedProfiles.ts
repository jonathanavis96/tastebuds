import { openDb } from '../db/open.js';
import { runMigrations } from '../db/migrate.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import { loadConfig } from '../config.js';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

const config = loadConfig();
const db = openDb(config.dbPath);
runMigrations(db);

// Seed base profiles. This is a couple model: two solo profiles plus a derived
// "Joint" profile (a live query-time blend of the two solos — no stored vector).
// Rename "Alex"/"Sam" to whatever you like; the code resolves the solo profiles
// by is_derived=0, not by name, so renaming here is all that's needed.
// (For a single-user setup, keep one solo profile and drop the Joint one.)
const SOLO_A = 'Alex';
const SOLO_B = 'Sam';

upsertProfile(db, { name: SOLO_A, media_weighting: 0.3, is_derived: 0, config: '{}' });
upsertProfile(db, { name: SOLO_B, media_weighting: 0.3, is_derived: 0, config: '{}' });
upsertProfile(db, { name: 'Joint', media_weighting: 0.7, is_derived: 1, config: '{}' });

const soloAId = (db.prepare('SELECT id FROM profiles WHERE name=?').get(SOLO_A) as { id: number }).id;
const soloBId = (db.prepare('SELECT id FROM profiles WHERE name=?').get(SOLO_B) as { id: number }).id;

const defaultPrefs = (
  lovedGenres: string[],
  hatedGenres: string[],
  era: string,
  mediaWeighting: number,
) =>
  JSON.stringify({
    loved_genres: lovedGenres,
    hated_genres: hatedGenres,
    loved_themes: [],
    hated_themes: [],
    preferred_era: era,
    media_weighting: mediaWeighting,
  });

upsertTasteSignature(db, {
  profile_id: soloAId,
  taste_vector: null,
  prefs: defaultPrefs(['Drama', 'Thriller', 'Science Fiction', 'Mystery'], ['Horror'], '2010s-present', 0.3),
  refreshed_at: new Date().toISOString(),
});

upsertTasteSignature(db, {
  profile_id: soloBId,
  taste_vector: null,
  prefs: defaultPrefs(['Drama', 'Romance', 'Comedy', 'Mystery'], ['Gore', 'Violence'], 'any', 0.3),
  refreshed_at: new Date().toISOString(),
});

console.log(`Profiles seeded: ${SOLO_A}, ${SOLO_B}, Joint`);
console.log('Next: run `npm run harvest` to populate titles, then import watch history.');
