import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { upsertTasteSignature, getTasteSignature } from '../db/repos/tasteSignatures.js';
import { applyDismissReasonToPrefs, DISMISS_REASON_TILES } from './dismissFeedback.js';

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  return db;
}

function insertTestProfile(db: InstanceType<typeof Database>): number {
  db.prepare(
    `INSERT INTO profiles (name, media_weighting, is_derived, config) VALUES (?, 0.5, 0, '{}')`,
  ).run('TestProfile_' + Math.random().toString(36).slice(2));
  return (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
}

/** Insert a title with the given genres (JSON array) and return its id. */
function insertTestTitle(db: InstanceType<typeof Database>, genres: string[]): number {
  db.prepare(
    `INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
     VALUES (?, 'movie', 'Test Title', 2024, ?, '[]', '[]', null, null, datetime('now'))`,
  ).run(Math.floor(Math.random() * 1_000_000), JSON.stringify(genres));
  return (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
}

function prefsFor(db: InstanceType<typeof Database>, profileId: number): Record<string, unknown> {
  const sig = getTasteSignature(db, profileId);
  return sig ? (JSON.parse(sig.prefs) as Record<string, unknown>) : {};
}

describe('DISMISS_REASON_TILES', () => {
  it('has the 5 tiles from the Phase-1.5 step-3 spec, in order', () => {
    expect(DISMISS_REASON_TILES.map(t => t.key)).toEqual([
      'not_my_genre', 'too_dark', 'seen_enough', 'cast_vibe', 'not_in_mood',
    ]);
  });
});

describe('applyDismissReasonToPrefs', () => {
  it('"not_my_genre" merges the title\'s genres into hated_genres', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);
    const titleId = insertTestTitle(db, ['Horror', 'Thriller']);

    applyDismissReasonToPrefs(db, profileId, titleId, 'not_my_genre');

    expect(prefsFor(db, profileId).hated_genres).toEqual(['Horror', 'Thriller']);
  });

  it('"seen_enough" also merges the title\'s genres into hated_genres', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);
    const titleId = insertTestTitle(db, ['Romance']);

    applyDismissReasonToPrefs(db, profileId, titleId, 'seen_enough');

    expect(prefsFor(db, profileId).hated_genres).toEqual(['Romance']);
  });

  it('"too_dark" merges a fixed dark/violent tag into hated_themes, not hated_genres', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);
    const titleId = insertTestTitle(db, ['Horror']);

    applyDismissReasonToPrefs(db, profileId, titleId, 'too_dark');

    const prefs = prefsFor(db, profileId);
    expect(prefs.hated_themes).toEqual(['dark/violent']);
    expect(prefs.hated_genres).toBeUndefined();
  });

  it('"cast_vibe" writes back nothing', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);
    const titleId = insertTestTitle(db, ['Comedy']);

    applyDismissReasonToPrefs(db, profileId, titleId, 'cast_vibe');

    expect(getTasteSignature(db, profileId)).toBeNull();
  });

  it('"not_in_mood" writes back nothing', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);
    const titleId = insertTestTitle(db, ['Comedy']);

    applyDismissReasonToPrefs(db, profileId, titleId, 'not_in_mood');

    expect(getTasteSignature(db, profileId)).toBeNull();
  });

  it('dedupes case-insensitively and preserves existing order, appending new genres', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);
    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: null,
      prefs: JSON.stringify({ hated_genres: ['horror'] }),
      refreshed_at: new Date().toISOString(),
    });
    const titleId = insertTestTitle(db, ['Horror', 'Action']);

    applyDismissReasonToPrefs(db, profileId, titleId, 'not_my_genre');

    expect(prefsFor(db, profileId).hated_genres).toEqual(['horror', 'Action']);
  });

  it('caps hated_genres at 12, dropping the oldest from the front', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);
    const existingGenres = Array.from({ length: 12 }, (_, i) => `Genre${i}`);
    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: null,
      prefs: JSON.stringify({ hated_genres: existingGenres }),
      refreshed_at: new Date().toISOString(),
    });
    const titleId = insertTestTitle(db, ['NewGenre']);

    applyDismissReasonToPrefs(db, profileId, titleId, 'not_my_genre');

    const result = prefsFor(db, profileId).hated_genres as string[];
    expect(result).toHaveLength(12);
    expect(result[0]).toBe('Genre1'); // Genre0 dropped
    expect(result[11]).toBe('NewGenre');
  });

  it('preserves other prefs keys and the existing taste_vector/refreshed_at', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);
    const refreshedAt = '2026-01-01T00:00:00.000Z';
    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: null,
      prefs: JSON.stringify({ loved_genres: ['Drama'], preferred_era: '2010s' }),
      refreshed_at: refreshedAt,
    });
    const titleId = insertTestTitle(db, ['Horror']);

    applyDismissReasonToPrefs(db, profileId, titleId, 'not_my_genre');

    const sig = getTasteSignature(db, profileId)!;
    const prefs = JSON.parse(sig.prefs);
    expect(prefs.loved_genres).toEqual(['Drama']);
    expect(prefs.preferred_era).toBe('2010s');
    expect(sig.refreshed_at).toBe(refreshedAt);
  });

  it('no-ops silently when the title has no genres', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);
    const titleId = insertTestTitle(db, []);

    applyDismissReasonToPrefs(db, profileId, titleId, 'not_my_genre');

    expect(getTasteSignature(db, profileId)).toBeNull();
  });

  it('no-ops silently when the title does not exist', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);

    expect(() => applyDismissReasonToPrefs(db, profileId, 999_999, 'not_my_genre')).not.toThrow();
    expect(getTasteSignature(db, profileId)).toBeNull();
  });
});
