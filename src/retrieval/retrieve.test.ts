import { describe, it, expect } from 'vitest';
import { blendVectors } from './blend.js';
import {
  refreshTasteVector,
  retrieveJointCandidates,
} from './retrieve.js';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTasteSignature, getTasteSignature } from '../db/repos/tasteSignatures.js';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import type { Config } from '../config.js';

const mockConfig: Pick<Config, 'ollamaUrl'> = { ollamaUrl: 'http://localhost:11434' };

describe('blendVectors', () => {
  it('blends orthogonal unit vectors with equal weights', () => {
    const v1 = [1, 0];
    const v2 = [0, 1];
    const result = blendVectors(v1, 0.5, v2, 0.5);
    expect(result).toEqual([0.5, 0.5]);
  });

  it('respects unequal weights', () => {
    const v1 = [2, 0];
    const v2 = [0, 2];
    const result = blendVectors(v1, 0.75, v2, 0.25);
    expect(result[0]).toBeCloseTo(1.5);
    expect(result[1]).toBeCloseTo(0.5);
  });
});

describe('refreshTasteVector', () => {
  it('computes mean embedding from rated titles and upserts', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);

    // seed profile
    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare('SELECT id FROM profiles WHERE name = ?').get('Alex') as any).id;

    // seed a title with embedding
    const vec = new Float32Array([0.1, 0.2, 0.3]);
    upsertTitle(db, {
      tmdb_id: 101, media_type: 'tv', title: 'Dark', year: 2017,
      genres: '["Drama","Sci-Fi"]', keywords: '[]', cast: '[]',
      synopsis: 'Time travel mystery', poster_path: null,
      embedding: Buffer.from(vec.buffer), updated_at: new Date().toISOString(),
    });
    const title = db.prepare('SELECT id FROM titles WHERE tmdb_id = 101').get() as any;

    upsertWatchEvent(db, { profile_id: profileId, title_id: title.id, status: 'watched', rating: 5, watched_at: new Date().toISOString() });

    // Inject a mock embedFn directly — avoids ESM module mocking complexity
    const embedMock = async (_text: string, _config: Pick<Config, 'ollamaUrl'>) => [0.1, 0.2, 0.3];

    await refreshTasteVector(db, profileId, mockConfig, embedMock);

    const sig = getTasteSignature(db, profileId);
    expect(sig).not.toBeNull();
    expect(sig!.taste_vector).toBeInstanceOf(Buffer);
    const result = Array.from(new Float32Array(sig!.taste_vector!.buffer));
    expect(result[0]).toBeCloseTo(0.1);
  });

  it('subtracts a disliked (low-rated) title as a negative signal (Rocchio)', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare('SELECT id FROM profiles WHERE name = ?').get('Alex') as any).id;

    const mkTitle = (tmdb: number, title: string) => {
      upsertTitle(db, {
        tmdb_id: tmdb, media_type: 'movie', title, year: 2020,
        genres: '[]', keywords: '[]', cast: '[]',
        synopsis: title, poster_path: null,
        embedding: Buffer.from(new Float32Array([0, 0, 0]).buffer),
        updated_at: new Date().toISOString(),
      });
      return (db.prepare('SELECT id FROM titles WHERE tmdb_id = ?').get(tmdb) as any).id;
    };
    const likedId = mkTitle(201, 'Loved');
    const dislikedId = mkTitle(202, 'Hated');

    upsertWatchEvent(db, { profile_id: profileId, title_id: likedId, status: 'watched', rating: 5, watched_at: new Date().toISOString() });
    upsertWatchEvent(db, { profile_id: profileId, title_id: dislikedId, status: 'watched', rating: 1, watched_at: new Date().toISOString() });

    // liked → [1,0,0]; disliked → [0,1,0]. Expected: [1,0,0] − 0.6·[0,1,0] = [1,-0.6,0].
    const embedMock = async (text: string) => (text.startsWith('Loved') ? [1, 0, 0] : [0, 1, 0]);

    await refreshTasteVector(db, profileId, mockConfig, embedMock);

    const result = Array.from(new Float32Array(getTasteSignature(db, profileId)!.taste_vector!.buffer));
    expect(result[0]).toBeCloseTo(1);
    expect(result[1]).toBeCloseTo(-0.6); // pushed away from the disliked title
  });

  it('treats a dismissed ("Not interested") title as a mild negative', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare('SELECT id FROM profiles WHERE name = ?').get('Alex') as any).id;

    const mkTitle = (tmdb: number, title: string) => {
      upsertTitle(db, {
        tmdb_id: tmdb, media_type: 'movie', title, year: 2020,
        genres: '[]', keywords: '[]', cast: '[]', synopsis: title, poster_path: null,
        embedding: Buffer.from(new Float32Array([0, 0, 0]).buffer), updated_at: new Date().toISOString(),
      });
      return (db.prepare('SELECT id FROM titles WHERE tmdb_id = ?').get(tmdb) as any).id;
    };
    const likedId = mkTitle(301, 'Loved');
    const dismissedId = mkTitle(302, 'Meh');

    upsertWatchEvent(db, { profile_id: profileId, title_id: likedId, status: 'watched', rating: 5, watched_at: new Date().toISOString() });
    // A dismissed recommendation (no watch_event, no rating).
    db.prepare("INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, state) VALUES (?, ?, 'core', 0, '', 'dismissed')")
      .run(profileId, dismissedId);

    // liked → [1,0,0]; dismissed → [0,1,0]. Expected: [1,0,0] − 0.6·(0.3·[0,1,0])/0.3 = [1,-0.6,0]
    // BUT the weight only matters relative to other negatives; with a single negative the
    // weighted mean is just its own vector, so the dismiss pushes the full NEGATIVE_WEIGHT.
    const embedMock = async (text: string) => (text.startsWith('Loved') ? [1, 0, 0] : [0, 1, 0]);
    await refreshTasteVector(db, profileId, mockConfig, embedMock);

    const solo = Array.from(new Float32Array(getTasteSignature(db, profileId)!.taste_vector!.buffer));
    expect(solo[1]).toBeCloseTo(-0.6);

    // Now add a 1★ rating on a THIRD title in the same direction as the dismiss: the 1★
    // (weight 1.0) should dominate the dismiss (weight 0.3) in the blended negative.
    const oneStarId = mkTitle(303, 'Hated');
    upsertWatchEvent(db, { profile_id: profileId, title_id: oneStarId, status: 'watched', rating: 1, watched_at: new Date().toISOString() });
    const embedMock2 = async (text: string) =>
      text.startsWith('Loved') ? [1, 0, 0] : text.startsWith('Hated') ? [0, 1, 0] : [0, 0, 1];
    await refreshTasteVector(db, profileId, mockConfig, embedMock2);
    const blended = Array.from(new Float32Array(getTasteSignature(db, profileId)!.taste_vector!.buffer));
    // 1★ axis (y, w=1.0) pushed harder than dismiss axis (z, w=0.3).
    expect(Math.abs(blended[1])).toBeGreaterThan(Math.abs(blended[2]));
  });
});

describe('retrieveJointCandidates mutual veto', () => {
  it('excludes titles hated by either profile', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    upsertProfile(db, { name: 'Sam', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const alexId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;
    const samId = (db.prepare("SELECT id FROM profiles WHERE name='Sam'").get() as any).id;

    const alexVec = Buffer.from(new Float32Array([1, 0, 0]).buffer);
    const samVec = Buffer.from(new Float32Array([0, 1, 0]).buffer);

    upsertTasteSignature(db, {
      profile_id: alexId,
      taste_vector: alexVec,
      prefs: JSON.stringify({ loved_genres: [], hated_genres: ['Horror'], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });
    upsertTasteSignature(db, {
      profile_id: samId,
      taste_vector: samVec,
      prefs: JSON.stringify({ loved_genres: [], hated_genres: [], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });

    const titleVec = Buffer.from(new Float32Array([0.5, 0.5, 0]).buffer);
    upsertTitle(db, {
      tmdb_id: 200, media_type: 'movie', title: 'Horror Film', year: 2020,
      genres: '["Horror"]', keywords: '[]', cast: '[]',
      synopsis: 'Scary movie', poster_path: null,
      embedding: titleVec, updated_at: new Date().toISOString(),
    });
    upsertTitle(db, {
      tmdb_id: 201, media_type: 'movie', title: 'Good Film', year: 2021,
      genres: '["Drama"]', keywords: '[]', cast: '[]',
      synopsis: 'Good movie', poster_path: null,
      embedding: titleVec, updated_at: new Date().toISOString(),
    });

    const results = await retrieveJointCandidates(db, alexId, samId, { limit: 10 }, mockConfig);
    const titles = results.map(r => r.title);
    expect(titles).not.toContain('Horror Film'); // excluded by Alex's hated_genres
    expect(titles).toContain('Good Film');
  });
});
