import { describe, it, expect } from 'vitest';
import {
  refreshTasteVector,
  retrieveCandidates,
  retrieveJointCandidates,
  retrieveJointCandidatePool,
  retrieveColdStartPool,
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

// blendVectors has its own dedicated, magnitude-aware test suite in blend.test.ts.

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

    // Both carry a note so they take the FRESH-embed path (notes change the embedded
    // text), letting the injected mock drive the vectors — exercising the Rocchio math
    // directly rather than the stored-embedding reuse shortcut.
    upsertWatchEvent(db, { profile_id: profileId, title_id: likedId, status: 'watched', rating: 5, watched_at: new Date().toISOString(), note: 'great' });
    upsertWatchEvent(db, { profile_id: profileId, title_id: dislikedId, status: 'watched', rating: 1, watched_at: new Date().toISOString(), note: 'bad' });

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

    const mkTitle = (tmdb: number, title: string, embedding: number[] = [0, 0, 0]) => {
      upsertTitle(db, {
        tmdb_id: tmdb, media_type: 'movie', title, year: 2020,
        genres: '[]', keywords: '[]', cast: '[]', synopsis: title, poster_path: null,
        embedding: Buffer.from(new Float32Array(embedding).buffer), updated_at: new Date().toISOString(),
      });
      return (db.prepare('SELECT id FROM titles WHERE tmdb_id = ?').get(tmdb) as any).id;
    };
    const likedId = mkTitle(301, 'Loved');
    // A dismissed rec carries no note, so refreshTasteVector reuses its STORED embedding —
    // seed it as the negative direction [0,1,0].
    const dismissedId = mkTitle(302, 'Meh', [0, 1, 0]);

    // Liked carries a note → fresh-embed path, so the mock controls its vector.
    upsertWatchEvent(db, { profile_id: profileId, title_id: likedId, status: 'watched', rating: 5, watched_at: new Date().toISOString(), note: 'loved it' });
    // A dismissed recommendation (no watch_event, no rating).
    db.prepare("INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, state) VALUES (?, ?, 'core', 0, '', 'dismissed')")
      .run(profileId, dismissedId);

    // liked → [1,0,0]; dismissed (stored) → [0,1,0]. Expected: [1,0,0] − 0.6·[0,1,0] = [1,-0.6,0]
    // BUT the weight only matters relative to other negatives; with a single negative the
    // weighted mean is just its own vector, so the dismiss pushes the full NEGATIVE_WEIGHT.
    const embedMock = async (text: string) => (text.startsWith('Loved') ? [1, 0, 0] : [0, 1, 0]);
    await refreshTasteVector(db, profileId, mockConfig, embedMock);

    const solo = Array.from(new Float32Array(getTasteSignature(db, profileId)!.taste_vector!.buffer));
    expect(solo[1]).toBeCloseTo(-0.6);

    // Now add a 1★ rating on a THIRD title in the same direction as the dismiss: the 1★
    // (weight 1.0) should dominate the dismiss (weight 0.3) in the blended negative.
    // Re-seed the dismiss onto the z-axis so the 1★ (y-axis) and dismiss (z-axis) are distinct.
    mkTitle(302, 'Meh', [0, 0, 1]);
    const oneStarId = mkTitle(303, 'Hated');
    upsertWatchEvent(db, { profile_id: profileId, title_id: oneStarId, status: 'watched', rating: 1, watched_at: new Date().toISOString(), note: 'hated it' });
    const embedMock2 = async (text: string) =>
      text.startsWith('Loved') ? [1, 0, 0] : text.startsWith('Hated') ? [0, 1, 0] : [0, 0, 1];
    await refreshTasteVector(db, profileId, mockConfig, embedMock2);
    const blended = Array.from(new Float32Array(getTasteSignature(db, profileId)!.taste_vector!.buffer));
    // 1★ axis (y, w=1.0) pushed harder than dismiss axis (z, w=0.3).
    expect(Math.abs(blended[1])).toBeGreaterThan(Math.abs(blended[2]));
  });

  it('reuses the stored title embedding and skips Ollama when a rating has no note', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare('SELECT id FROM profiles WHERE name = ?').get('Alex') as any).id;

    // Stored embedding is the source of truth for a note-less rating.
    upsertTitle(db, {
      tmdb_id: 401, media_type: 'movie', title: 'Stored', year: 2020,
      genres: '[]', keywords: '[]', cast: '[]', synopsis: 'from harvest', poster_path: null,
      embedding: Buffer.from(new Float32Array([0.7, 0.1, 0.2]).buffer), updated_at: new Date().toISOString(),
    });
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id = 401').get() as any).id;
    upsertWatchEvent(db, { profile_id: profileId, title_id: titleId, status: 'watched', rating: 5, watched_at: new Date().toISOString() });

    let calls = 0;
    const spy = async (_t: string, _c: Pick<Config, 'ollamaUrl'>) => { calls++; return [9, 9, 9]; };
    await refreshTasteVector(db, profileId, mockConfig, spy);

    expect(calls).toBe(0); // no Ollama round-trip for a note-less rating
    const result = Array.from(new Float32Array(getTasteSignature(db, profileId)!.taste_vector!.buffer));
    expect(result[0]).toBeCloseTo(0.7); // taste vector came from the stored embedding
  });

  it('embeds fresh (one Ollama call) when a rating carries a note', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare('SELECT id FROM profiles WHERE name = ?').get('Alex') as any).id;

    upsertTitle(db, {
      tmdb_id: 402, media_type: 'movie', title: 'Noted', year: 2020,
      genres: '[]', keywords: '[]', cast: '[]', synopsis: 'syn', poster_path: null,
      embedding: Buffer.from(new Float32Array([0.7, 0.1, 0.2]).buffer), updated_at: new Date().toISOString(),
    });
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id = 402').get() as any).id;
    upsertWatchEvent(db, { profile_id: profileId, title_id: titleId, status: 'watched', rating: 5, watched_at: new Date().toISOString(), note: 'the third act lands' });

    let calls = 0;
    const spy = async (_t: string, _c: Pick<Config, 'ollamaUrl'>) => { calls++; return [0.3, 0.3, 0.3]; };
    await refreshTasteVector(db, profileId, mockConfig, spy);

    expect(calls).toBe(1); // the note changes the text, so a fresh embed is required
    const result = Array.from(new Float32Array(getTasteSignature(db, profileId)!.taste_vector!.buffer));
    expect(result[0]).toBeCloseTo(0.3); // taste vector came from the fresh embed
  });

  it('caches a noted title embedding so a later refresh makes zero Ollama calls', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare('SELECT id FROM profiles WHERE name = ?').get('Alex') as any).id;

    upsertTitle(db, {
      tmdb_id: 403, media_type: 'movie', title: 'Cached', year: 2020,
      genres: '[]', keywords: '[]', cast: '[]', synopsis: 'syn', poster_path: null,
      embedding: Buffer.from(new Float32Array([0.7, 0.1, 0.2]).buffer), updated_at: new Date().toISOString(),
    });
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id = 403').get() as any).id;
    upsertWatchEvent(db, { profile_id: profileId, title_id: titleId, status: 'watched', rating: 5, watched_at: new Date().toISOString(), note: 'rewatchable' });

    let calls = 0;
    const spy = async (_t: string, _c: Pick<Config, 'ollamaUrl'>) => { calls++; return [0.5, 0.5, 0.5]; };

    // First refresh: cold cache → one embed; the vector is now persisted in embedding_cache.
    await refreshTasteVector(db, profileId, mockConfig, spy);
    expect(calls).toBe(1);

    // A subsequent refresh (e.g. a "Not interested" click that recomputes the taste vector)
    // must NOT re-embed the unchanged noted title — it reads the cached vector.
    await refreshTasteVector(db, profileId, mockConfig, spy);
    expect(calls).toBe(1); // still 1 — cache hit, no second Ollama call

    const result = Array.from(new Float32Array(getTasteSignature(db, profileId)!.taste_vector!.buffer));
    expect(result[0]).toBeCloseTo(0.5);
  });
});

describe('retrieveColdStartPool (no taste vector yet)', () => {
  const mkTitle = (db: InstanceType<typeof Database>, tmdb: number, title: string, genres: string, media: 'movie' | 'tv' = 'movie') => {
    upsertTitle(db, {
      tmdb_id: tmdb, media_type: media, title, year: 2020,
      genres, keywords: '[]', cast: '[]', synopsis: title, poster_path: null,
      embedding: Buffer.from(new Float32Array([0, 0, 0]).buffer), updated_at: new Date().toISOString(),
    });
    return (db.prepare('SELECT id FROM titles WHERE tmdb_id = ?').get(tmdb) as any).id;
  };

  it('returns loved-genre titles and vetoes hated genres when the profile has no taste vector', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;

    // Cold start: a signature row with prefs but NO taste_vector (never rated anything).
    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: null,
      prefs: JSON.stringify({ loved_genres: ['Drama'], hated_genres: ['Horror'] }),
      refreshed_at: new Date().toISOString(),
    });

    mkTitle(db, 901, 'Loved Drama', '["Drama"]');
    mkTitle(db, 902, 'Scary One', '["Horror"]');
    mkTitle(db, 903, 'Random Comedy', '["Comedy"]');

    const pool = await retrieveColdStartPool(db, profileId, {}, mockConfig);
    const onTasteTitles = pool.onTaste.map(c => c.title);
    const allTitles = [...pool.onTaste, ...pool.wildcards, ...pool.adversarial].map(c => c.title);

    expect(onTasteTitles).toContain('Loved Drama'); // loved genre surfaces
    expect(onTasteTitles).not.toContain('Random Comedy'); // not a loved genre → not on-taste
    expect(allTitles).not.toContain('Scary One'); // hated genre vetoed everywhere
  });

  it('excludes watched and explicitly-excluded titles', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;
    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: null,
      prefs: JSON.stringify({ loved_genres: ['Drama'], hated_genres: [] }),
      refreshed_at: new Date().toISOString(),
    });

    const watchedId = mkTitle(db, 911, 'Already Seen', '["Drama"]');
    const excludedId = mkTitle(db, 912, 'Pending Rec', '["Drama"]');
    mkTitle(db, 913, 'Fresh Pick', '["Drama"]');

    upsertWatchEvent(db, { profile_id: profileId, title_id: watchedId, status: 'watched', rating: 5, watched_at: new Date().toISOString() });

    const pool = await retrieveColdStartPool(db, profileId, { excludeTitleIds: [excludedId] }, mockConfig);
    const titles = [...pool.onTaste, ...pool.wildcards, ...pool.adversarial].map(c => c.title);

    expect(titles).toContain('Fresh Pick');
    expect(titles).not.toContain('Already Seen');
    expect(titles).not.toContain('Pending Rec');
  });

  it('still returns titles (as wildcards) when the profile has no loved genres', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;
    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: null,
      prefs: JSON.stringify({ loved_genres: [], hated_genres: ['Horror'] }),
      refreshed_at: new Date().toISOString(),
    });

    mkTitle(db, 921, 'Any Drama', '["Drama"]');
    mkTitle(db, 922, 'Any Horror', '["Horror"]');

    const pool = await retrieveColdStartPool(db, profileId, {}, mockConfig);
    const titles = [...pool.onTaste, ...pool.wildcards, ...pool.adversarial].map(c => c.title);

    expect(titles).toContain('Any Drama'); // no loved-genre filter → general pool still flows
    expect(titles).not.toContain('Any Horror'); // hated still vetoed
  });
});

describe('IMDb rating filter (minImdbRating)', () => {
  /** Seed a title with a given imdb_rating (TEXT column; null = no value written). */
  function mkTitleWithRating(
    db: InstanceType<typeof Database>,
    tmdbId: number,
    titleStr: string,
    imdbRating: string | null,
    vec: number[] = [0.5, 0.5, 0],
  ): number {
    upsertTitle(db, {
      tmdb_id: tmdbId,
      media_type: 'movie',
      title: titleStr,
      year: 2020,
      genres: '[]',
      keywords: '[]',
      cast: '[]',
      synopsis: titleStr,
      poster_path: null,
      embedding: Buffer.from(new Float32Array(vec).buffer),
      updated_at: new Date().toISOString(),
    });
    if (imdbRating !== null) {
      db.prepare('UPDATE titles SET imdb_rating = ? WHERE tmdb_id = ?').run(imdbRating, tmdbId);
    }
    return (db.prepare('SELECT id FROM titles WHERE tmdb_id = ?').get(tmdbId) as { id: number }).id;
  }

  it('retrieveCandidates: excludes 5.0, includes 7.5 and NULL when minImdbRating=7', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);

    upsertProfile(db, { name: 'RatingTester', media_weighting: 0.5, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='RatingTester'").get() as { id: number }).id;

    const tasteVec = Buffer.from(new Float32Array([0.5, 0.5, 0]).buffer);
    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: tasteVec,
      prefs: '{}',
      refreshed_at: new Date().toISOString(),
    });

    mkTitleWithRating(db, 3001, 'Low Rating', '5.0');   // should be excluded
    mkTitleWithRating(db, 3002, 'High Rating', '7.5');   // should be included
    mkTitleWithRating(db, 3003, 'Unrated Title', null);  // NULL → lenient, included

    const results = await retrieveCandidates(db, profileId, { minImdbRating: 7 }, mockConfig);
    const titles = results.map(r => r.title);

    expect(titles).not.toContain('Low Rating');   // 5.0 < 7 → excluded
    expect(titles).toContain('High Rating');        // 7.5 >= 7 → included
    expect(titles).toContain('Unrated Title');      // NULL → included (lenient)
  });

  it('retrieveCandidates: returns all three when no minImdbRating is set', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);

    upsertProfile(db, { name: 'NoFilter', media_weighting: 0.5, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='NoFilter'").get() as { id: number }).id;

    const tasteVec = Buffer.from(new Float32Array([0.5, 0.5, 0]).buffer);
    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: tasteVec,
      prefs: '{}',
      refreshed_at: new Date().toISOString(),
    });

    mkTitleWithRating(db, 3101, 'Low', '5.0');
    mkTitleWithRating(db, 3102, 'High', '7.5');
    mkTitleWithRating(db, 3103, 'Unrated', null);

    const results = await retrieveCandidates(db, profileId, {}, mockConfig);
    const titles = results.map(r => r.title);

    expect(titles).toContain('Low');
    expect(titles).toContain('High');
    expect(titles).toContain('Unrated');
  });

  it('retrieveJointCandidatePool: excludes 5.0, includes 7.5 and NULL when minImdbRating=7', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);

    upsertProfile(db, { name: 'JointA', media_weighting: 0.5, is_derived: 0, config: '{}' });
    upsertProfile(db, { name: 'JointB', media_weighting: 0.5, is_derived: 0, config: '{}' });
    const alexId = (db.prepare("SELECT id FROM profiles WHERE name='JointA'").get() as { id: number }).id;
    const samId = (db.prepare("SELECT id FROM profiles WHERE name='JointB'").get() as { id: number }).id;

    const tasteVec = Buffer.from(new Float32Array([0.5, 0.5, 0]).buffer);
    upsertTasteSignature(db, { profile_id: alexId, taste_vector: tasteVec, prefs: '{}', refreshed_at: new Date().toISOString() });
    upsertTasteSignature(db, { profile_id: samId, taste_vector: tasteVec, prefs: '{}', refreshed_at: new Date().toISOString() });

    mkTitleWithRating(db, 3201, 'Joint Low', '5.0');
    mkTitleWithRating(db, 3202, 'Joint High', '7.5');
    mkTitleWithRating(db, 3203, 'Joint Unrated', null);

    const pool = await retrieveJointCandidatePool(db, alexId, samId, { minImdbRating: 7 }, mockConfig);
    const allTitles = [...pool.onTaste, ...pool.wildcards, ...pool.adversarial].map(r => r.title);

    expect(allTitles).not.toContain('Joint Low');        // 5.0 < 7 → excluded
    expect(allTitles.some(t => t === 'Joint High')).toBe(true);    // 7.5 >= 7 → included
    expect(allTitles.some(t => t === 'Joint Unrated')).toBe(true); // NULL → included
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
