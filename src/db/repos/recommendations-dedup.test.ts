/**
 * TDD test — at most ONE pending recommendation per (profile_id, title_id).
 *
 * Regression: two overlapping /generate calls each read the pending set before
 * either inserted, so the read-time excludeTitleIds didn't see the other's picks
 * → the same title was inserted as two pending rows (duplicates on the page).
 * The DB now enforces uniqueness on pending recs and upsertRecommendation skips
 * a conflicting pending insert instead of duplicating (or throwing).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { upsertProfile } from './profiles.js';
import { upsertTitle } from './titles.js';
import { upsertRecommendation, getRecommendations } from './recommendations.js';

const baseTitle = {
  tmdb_id: 88801,
  media_type: 'movie' as const,
  title: 'Dedup Test Film',
  year: 2024,
  genres: '["Romance"]',
  keywords: '[]',
  cast: '[]',
  synopsis: 'A test.',
  poster_path: null,
  embedding: null,
  updated_at: new Date().toISOString(),
};

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const pendingRec = {
  profile_id: 1, title_id: 1,
  category: 'Based on your request', score: 0.9,
  why_blurb: 'Great', request_text: 'rom-com',
  state: 'pending' as const, kind: 'core' as const,
};

describe('recommendations repo — pending dedup', () => {
  it('inserting the same (profile, title) pending twice yields ONE pending row', () => {
    const db = createTestDb();
    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    upsertTitle(db, baseTitle);

    upsertRecommendation(db, pendingRec);
    // second insert (e.g. a racing /generate that read the pending set too early)
    upsertRecommendation(db, { ...pendingRec, why_blurb: 'Great again', request_text: 'romantic comedy' });

    const pending = getRecommendations(db, 1, 'pending');
    expect(pending).toHaveLength(1);
    // the original row is preserved (DO NOTHING, not overwrite)
    expect(pending[0].why_blurb).toBe('Great');
  });

  it('a dismissed row and a pending row for the same title can coexist', () => {
    const db = createTestDb();
    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    upsertTitle(db, baseTitle);

    upsertRecommendation(db, { ...pendingRec, state: 'dismissed' });
    upsertRecommendation(db, pendingRec);

    expect(getRecommendations(db, 1, 'dismissed')).toHaveLength(1);
    expect(getRecommendations(db, 1, 'pending')).toHaveLength(1);
  });

  it('migration removes pre-existing duplicate pending rows (keeps earliest)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    upsertTitle(db, baseTitle);

    // Drop the guard index, inject duplicates the way the old buggy code did, then re-migrate.
    db.exec('DROP INDEX IF EXISTS idx_rec_pending_unique');
    const raw = db.prepare(`
      INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, kind)
      VALUES (1, 1, 'c', 0.9, ?, null, 'pending', 'core')
    `);
    raw.run('first');
    raw.run('second');
    expect(getRecommendations(db, 1, 'pending')).toHaveLength(2);

    runMigrations(db);

    const pending = getRecommendations(db, 1, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].why_blurb).toBe('first');
  });
});
