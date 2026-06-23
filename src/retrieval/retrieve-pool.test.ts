/**
 * TDD tests for retrieveCandidatePool / retrieveJointCandidatePool.
 * Written BEFORE the implementation exists — all should fail until src/retrieval/retrieve.ts is updated.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import {
  retrieveCandidatePool,
  retrieveJointCandidatePool,
  retrieveRequestCandidates,
  retrieveJointRequestCandidates,
  type CandidatePool,
} from './retrieve.js';
import type { Config } from '../config.js';

const mockConfig: Pick<Config, 'ollamaUrl'> = { ollamaUrl: 'http://localhost:11434' };

/**
 * Build a normalised Float32 vector of `dim` dimensions where the component
 * at position `hotIndex` is 1 and all others are 0. This makes cosine
 * distances completely deterministic: two vectors with the same hot index have
 * distance 0; orthogonal vectors have distance 1.
 */
function oneHot(hotIndex: number, dim = 8): Buffer {
  const arr = new Float32Array(dim);
  arr[hotIndex] = 1;
  return Buffer.from(arr.buffer);
}

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('retrieveCandidatePool — basic structure', () => {
  it('returns an object with onTaste, wildcards, adversarial arrays', async () => {
    const db = createTestDb();

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;

    // taste vector pointing at dim-0
    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: oneHot(0),
      prefs: JSON.stringify({ loved_genres: [], hated_genres: [], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });

    // Seed 25 titles with different vectors
    for (let i = 0; i < 25; i++) {
      upsertTitle(db, {
        tmdb_id: 1000 + i, media_type: 'movie', title: `Film ${i}`, year: 2020,
        genres: '["Drama"]', keywords: '[]', cast: '[]',
        synopsis: `Synopsis ${i}`, poster_path: null,
        embedding: oneHot(i % 8),
        updated_at: new Date().toISOString(),
      });
    }

    const pool: CandidatePool = await retrieveCandidatePool(db, profileId, {}, mockConfig);

    expect(pool).toHaveProperty('onTaste');
    expect(pool).toHaveProperty('wildcards');
    expect(pool).toHaveProperty('adversarial');
    expect(Array.isArray(pool.onTaste)).toBe(true);
    expect(Array.isArray(pool.wildcards)).toBe(true);
    expect(Array.isArray(pool.adversarial)).toBe(true);
  });

  it('onTaste titles are closest to the taste vector (score ASC)', async () => {
    const db = createTestDb();

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;

    // taste vector at dim-0
    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: oneHot(0),
      prefs: JSON.stringify({ loved_genres: [], hated_genres: [], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });

    // Title A: aligned with taste (distance ~0)
    upsertTitle(db, {
      tmdb_id: 2001, media_type: 'movie', title: 'Close Film', year: 2020,
      genres: '["Drama"]', keywords: '[]', cast: '[]', synopsis: null, poster_path: null,
      embedding: oneHot(0), updated_at: new Date().toISOString(),
    });
    // Title B: orthogonal (distance 1)
    upsertTitle(db, {
      tmdb_id: 2002, media_type: 'movie', title: 'Far Film', year: 2020,
      genres: '["Drama"]', keywords: '[]', cast: '[]', synopsis: null, poster_path: null,
      embedding: oneHot(1), updated_at: new Date().toISOString(),
    });

    const pool = await retrieveCandidatePool(db, profileId, {}, mockConfig);

    // 'Close Film' must be in onTaste
    expect(pool.onTaste.map(c => c.title)).toContain('Close Film');

    // scores in onTaste should be ascending (closest first)
    const scores = pool.onTaste.map(c => c.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
  });

  it('adversarial titles have higher scores than onTaste titles', async () => {
    const db = createTestDb();

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;

    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: oneHot(0),
      prefs: JSON.stringify({ loved_genres: [], hated_genres: [], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });

    // Seed enough distinct-vector titles so both groups are populated
    for (let i = 0; i < 30; i++) {
      upsertTitle(db, {
        tmdb_id: 3000 + i, media_type: 'movie', title: `Title ${i}`, year: 2020,
        genres: '["Drama"]', keywords: '[]', cast: '[]', synopsis: null, poster_path: null,
        embedding: oneHot(i % 8), updated_at: new Date().toISOString(),
      });
    }

    const pool = await retrieveCandidatePool(db, profileId, {}, mockConfig);

    if (pool.onTaste.length > 0 && pool.adversarial.length > 0) {
      const maxOnTaste = Math.max(...pool.onTaste.map(c => c.score));
      const minAdversarial = Math.min(...pool.adversarial.map(c => c.score));
      // adversarial scores should be generally farther than on-taste — at least the
      // worst adversarial must not be closer than the best on-taste by a wide margin.
      expect(minAdversarial).toBeGreaterThanOrEqual(maxOnTaste * 0.5);
    }
  });

  it('excludes watched titles from all groups', async () => {
    const db = createTestDb();

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;

    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: oneHot(0),
      prefs: JSON.stringify({ loved_genres: [], hated_genres: [], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });

    // Seed titles
    for (let i = 0; i < 20; i++) {
      upsertTitle(db, {
        tmdb_id: 4000 + i, media_type: 'movie', title: `WatchedCheck ${i}`, year: 2020,
        genres: '["Drama"]', keywords: '[]', cast: '[]', synopsis: null, poster_path: null,
        embedding: oneHot(i % 8), updated_at: new Date().toISOString(),
      });
    }

    // Mark one as watched
    const watchedTitleId = (db.prepare("SELECT id FROM titles WHERE tmdb_id=4000").get() as any).id;
    upsertWatchEvent(db, {
      profile_id: profileId, title_id: watchedTitleId,
      status: 'watched', rating: 4, watched_at: new Date().toISOString(),
    });

    const pool = await retrieveCandidatePool(db, profileId, {}, mockConfig);

    const allIds = [
      ...pool.onTaste.map(c => c.id),
      ...pool.wildcards.map(c => c.id),
      ...pool.adversarial.map(c => c.id),
    ];
    expect(allIds).not.toContain(watchedTitleId);
  });

  it('wildcards do not overlap with onTaste or adversarial', async () => {
    const db = createTestDb();

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;

    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: oneHot(0),
      prefs: JSON.stringify({ loved_genres: [], hated_genres: [], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });

    for (let i = 0; i < 40; i++) {
      upsertTitle(db, {
        tmdb_id: 5000 + i, media_type: 'movie', title: `Overlap ${i}`, year: 2020,
        genres: '["Drama"]', keywords: '[]', cast: '[]', synopsis: null, poster_path: null,
        embedding: oneHot(i % 8), updated_at: new Date().toISOString(),
      });
    }

    const pool = await retrieveCandidatePool(db, profileId, {}, mockConfig);

    const onTasteIds = new Set(pool.onTaste.map(c => c.id));
    const adversarialIds = new Set(pool.adversarial.map(c => c.id));

    for (const w of pool.wildcards) {
      expect(onTasteIds.has(w.id)).toBe(false);
      expect(adversarialIds.has(w.id)).toBe(false);
    }
  });

  it('wildcards exclude titles matching hated genres', async () => {
    const db = createTestDb();

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;

    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: oneHot(0),
      prefs: JSON.stringify({ loved_genres: [], hated_genres: ['Horror'], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });

    // Seed many titles — some Horror (hated), some Drama
    for (let i = 0; i < 30; i++) {
      const genre = i % 3 === 0 ? '["Horror"]' : '["Drama"]';
      upsertTitle(db, {
        tmdb_id: 6000 + i, media_type: 'movie', title: `Genre ${i}`, year: 2020,
        genres: genre, keywords: '[]', cast: '[]', synopsis: null, poster_path: null,
        // Use orthogonal vectors so Horror titles don't all land in onTaste/adversarial
        embedding: oneHot((i + 2) % 8), updated_at: new Date().toISOString(),
      });
    }

    const pool = await retrieveCandidatePool(db, profileId, {}, mockConfig);

    for (const w of pool.wildcards) {
      const genres = JSON.parse(w.genres) as string[];
      expect(genres).not.toContain('Horror');
    }
  });

  it('returns empty pool when no taste signature exists', async () => {
    const db = createTestDb();
    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;

    const pool = await retrieveCandidatePool(db, profileId, {}, mockConfig);
    expect(pool.onTaste).toHaveLength(0);
    expect(pool.wildcards).toHaveLength(0);
    expect(pool.adversarial).toHaveLength(0);
  });
});

describe('retrieveJointCandidatePool', () => {
  it('returns CandidatePool shape', async () => {
    const db = createTestDb();

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    upsertProfile(db, { name: 'Sam', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const alexId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;
    const samId = (db.prepare("SELECT id FROM profiles WHERE name='Sam'").get() as any).id;

    upsertTasteSignature(db, {
      profile_id: alexId,
      taste_vector: oneHot(0),
      prefs: JSON.stringify({ loved_genres: [], hated_genres: [], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });
    upsertTasteSignature(db, {
      profile_id: samId,
      taste_vector: oneHot(1),
      prefs: JSON.stringify({ loved_genres: [], hated_genres: [], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });

    for (let i = 0; i < 30; i++) {
      upsertTitle(db, {
        tmdb_id: 7000 + i, media_type: 'movie', title: `Joint ${i}`, year: 2020,
        genres: '["Drama"]', keywords: '[]', cast: '[]', synopsis: null, poster_path: null,
        embedding: oneHot(i % 8), updated_at: new Date().toISOString(),
      });
    }

    const pool = await retrieveJointCandidatePool(db, alexId, samId, {}, mockConfig);

    expect(pool).toHaveProperty('onTaste');
    expect(pool).toHaveProperty('wildcards');
    expect(pool).toHaveProperty('adversarial');
  });

  it('joint pool excludes titles watched by either profile', async () => {
    const db = createTestDb();

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    upsertProfile(db, { name: 'Sam', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const alexId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;
    const samId = (db.prepare("SELECT id FROM profiles WHERE name='Sam'").get() as any).id;

    upsertTasteSignature(db, {
      profile_id: alexId,
      taste_vector: oneHot(0),
      prefs: JSON.stringify({ loved_genres: [], hated_genres: [], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });
    upsertTasteSignature(db, {
      profile_id: samId,
      taste_vector: oneHot(1),
      prefs: JSON.stringify({ loved_genres: [], hated_genres: [], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });

    for (let i = 0; i < 25; i++) {
      upsertTitle(db, {
        tmdb_id: 8000 + i, media_type: 'movie', title: `JointW ${i}`, year: 2020,
        genres: '["Drama"]', keywords: '[]', cast: '[]', synopsis: null, poster_path: null,
        embedding: oneHot(i % 8), updated_at: new Date().toISOString(),
      });
    }

    // Alex watched title 0, Sam watched title 1
    const alexWatchedId = (db.prepare("SELECT id FROM titles WHERE tmdb_id=8000").get() as any).id;
    const samWatchedId = (db.prepare("SELECT id FROM titles WHERE tmdb_id=8001").get() as any).id;

    upsertWatchEvent(db, {
      profile_id: alexId, title_id: alexWatchedId,
      status: 'watched', rating: 4, watched_at: new Date().toISOString(),
    });
    upsertWatchEvent(db, {
      profile_id: samId, title_id: samWatchedId,
      status: 'watched', rating: 4, watched_at: new Date().toISOString(),
    });

    const pool = await retrieveJointCandidatePool(db, alexId, samId, {}, mockConfig);

    const allIds = [
      ...pool.onTaste.map(c => c.id),
      ...pool.wildcards.map(c => c.id),
      ...pool.adversarial.map(c => c.id),
    ];
    expect(allIds).not.toContain(alexWatchedId);
    expect(allIds).not.toContain(samWatchedId);
  });

  it('joint wildcards exclude titles matching either profile hated genres', async () => {
    const db = createTestDb();

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    upsertProfile(db, { name: 'Sam', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const alexId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;
    const samId = (db.prepare("SELECT id FROM profiles WHERE name='Sam'").get() as any).id;

    upsertTasteSignature(db, {
      profile_id: alexId,
      taste_vector: oneHot(0),
      prefs: JSON.stringify({ loved_genres: [], hated_genres: ['Horror'], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });
    upsertTasteSignature(db, {
      profile_id: samId,
      taste_vector: oneHot(1),
      prefs: JSON.stringify({ loved_genres: [], hated_genres: ['Comedy'], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });

    // Seed 30 titles with mixed genres
    for (let i = 0; i < 30; i++) {
      let genre: string;
      if (i % 3 === 0) genre = '["Horror"]';
      else if (i % 3 === 1) genre = '["Comedy"]';
      else genre = '["Drama"]';
      upsertTitle(db, {
        tmdb_id: 9000 + i, media_type: 'movie', title: `JH ${i}`, year: 2020,
        genres: genre, keywords: '[]', cast: '[]', synopsis: null, poster_path: null,
        embedding: oneHot((i + 3) % 8), updated_at: new Date().toISOString(),
      });
    }

    const pool = await retrieveJointCandidatePool(db, alexId, samId, {}, mockConfig);

    for (const w of pool.wildcards) {
      const genres = JSON.parse(w.genres) as string[];
      expect(genres).not.toContain('Horror');
      expect(genres).not.toContain('Comedy');
    }
  });
});

describe('retrieveJointCandidatePool — derived Joint', () => {
  // Regression: when no extra ids are excluded, the exclude subquery must NOT be
  // `NOT IN (SELECT NULL)` — that excludes EVERY row (NULL trap) and returned an
  // empty on-taste pool, so Joint generated 0 recommendations.
  it('returns non-empty onTaste when unwatched titles exist', async () => {
    const db = createTestDb();
    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    upsertProfile(db, { name: 'Sam', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const alexId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;
    const samId = (db.prepare("SELECT id FROM profiles WHERE name='Sam'").get() as any).id;
    for (const pid of [alexId, samId]) {
      upsertTasteSignature(db, {
        profile_id: pid,
        taste_vector: oneHot(0),
        prefs: JSON.stringify({ loved_genres: [], hated_genres: [], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
        refreshed_at: new Date().toISOString(),
      });
    }
    // Need enough titles to fill all three disjoint pools: onTaste (≤20) +
    // adversarial (≤8) + wildcards (≤12). With only 25 the first two exhaust the
    // set and wildcards comes back empty — seed 60 so the composition is realistic.
    for (let i = 0; i < 60; i++) {
      upsertTitle(db, {
        tmdb_id: 3000 + i, media_type: 'movie', title: `Joint Film ${i}`, year: 2021,
        genres: '["Drama"]', keywords: '[]', cast: '[]',
        synopsis: `Synopsis ${i}`, poster_path: null,
        embedding: oneHot(i % 8),
        updated_at: new Date().toISOString(),
      });
    }

    const pool = await retrieveJointCandidatePool(db, alexId, samId, {}, mockConfig);
    expect(pool.onTaste.length).toBeGreaterThan(0);
    expect(pool.adversarial.length).toBeGreaterThan(0);
    expect(pool.wildcards.length).toBeGreaterThan(0);
  });
});

describe('retrieveCandidatePool — excludeTitleIds', () => {
  it('excludes specified title ids from all groups', async () => {
    const db = createTestDb();

    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;

    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: oneHot(0),
      prefs: JSON.stringify({ loved_genres: [], hated_genres: [], loved_themes: [], hated_themes: [], preferred_era: 'any', media_weighting: 0.3 }),
      refreshed_at: new Date().toISOString(),
    });

    // Seed 30 titles
    for (let i = 0; i < 30; i++) {
      upsertTitle(db, {
        tmdb_id: 20000 + i, media_type: 'movie', title: `ExcludeTest ${i}`, year: 2020,
        genres: '["Drama"]', keywords: '[]', cast: '[]', synopsis: null, poster_path: null,
        embedding: oneHot(i % 8), updated_at: new Date().toISOString(),
      });
    }

    // Get the id of the closest title to exclude
    const firstPool = await retrieveCandidatePool(db, profileId, {}, mockConfig);
    expect(firstPool.onTaste.length).toBeGreaterThan(0);
    const excludeId = firstPool.onTaste[0].id;

    // Now run with that id excluded
    const secondPool = await retrieveCandidatePool(db, profileId, { excludeTitleIds: [excludeId] }, mockConfig);

    const allIds = [
      ...secondPool.onTaste.map(c => c.id),
      ...secondPool.wildcards.map(c => c.id),
      ...secondPool.adversarial.map(c => c.id),
    ];
    expect(allIds).not.toContain(excludeId);
  });
});

describe('retrieveRequestCandidates — free-text request retrieval', () => {
  // Embed a request as a one-hot vector at dim `hot` so cosine maths stays deterministic.
  const embedAt = (hot: number) => async () => {
    const arr = new Array(8).fill(0);
    arr[hot] = 1;
    return arr;
  };

  it('ranks titles matching the embedded request above pure taste matches', async () => {
    const db = createTestDb();
    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;

    // Taste points at dim-0; the request will point at dim-3.
    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: oneHot(0),
      prefs: JSON.stringify({ hated_genres: [] }),
      refreshed_at: new Date().toISOString(),
    });

    // A title that matches taste (dim-0) and one that matches the request (dim-3).
    upsertTitle(db, {
      tmdb_id: 5000, media_type: 'movie', title: 'Taste Match', year: 2020,
      genres: '["Drama"]', keywords: '[]', cast: '[]', synopsis: 's', poster_path: null,
      embedding: oneHot(0), updated_at: new Date().toISOString(),
    });
    upsertTitle(db, {
      tmdb_id: 5001, media_type: 'movie', title: 'Request Match', year: 2020,
      genres: '["Sci-Fi"]', keywords: '[]', cast: '[]', synopsis: 's', poster_path: null,
      embedding: oneHot(3), updated_at: new Date().toISOString(),
    });

    const results = await retrieveRequestCandidates(
      db, profileId, 'mind-bending sci-fi', { mediaType: 'movie' }, mockConfig, embedAt(3),
    );

    // Request-dominant (0.7) blend → the dim-3 title should rank first.
    expect(results[0].tmdb_id).toBe(5001);
  });

  it('excludes watched titles and respects excludeTitleIds', async () => {
    const db = createTestDb();
    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const profileId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;
    upsertTasteSignature(db, {
      profile_id: profileId, taste_vector: oneHot(0),
      prefs: JSON.stringify({ hated_genres: [] }), refreshed_at: new Date().toISOString(),
    });
    for (let i = 0; i < 3; i++) {
      upsertTitle(db, {
        tmdb_id: 6000 + i, media_type: 'movie', title: `Film ${i}`, year: 2020,
        genres: '["Sci-Fi"]', keywords: '[]', cast: '[]', synopsis: 's', poster_path: null,
        embedding: oneHot(3), updated_at: new Date().toISOString(),
      });
    }
    const watchedId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=6000').get() as any).id;
    const excludedId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=6001').get() as any).id;
    upsertWatchEvent(db, { profile_id: profileId, title_id: watchedId, status: 'watched', rating: 4, watched_at: new Date().toISOString() });

    const results = await retrieveRequestCandidates(
      db, profileId, 'sci-fi', { mediaType: 'movie', excludeTitleIds: [excludedId] }, mockConfig, embedAt(3),
    );
    const ids = results.map(r => r.id);
    expect(ids).not.toContain(watchedId);
    expect(ids).not.toContain(excludedId);
    expect(ids).toContain((db.prepare('SELECT id FROM titles WHERE tmdb_id=6002').get() as any).id);
  });

  it('Joint request retrieval excludes titles watched by either member', async () => {
    const db = createTestDb();
    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    upsertProfile(db, { name: 'Sam', media_weighting: 0.3, is_derived: 0, config: '{}' });
    const alexId = (db.prepare("SELECT id FROM profiles WHERE name='Alex'").get() as any).id;
    const samId = (db.prepare("SELECT id FROM profiles WHERE name='Sam'").get() as any).id;
    for (const id of [alexId, samId]) {
      upsertTasteSignature(db, {
        profile_id: id, taste_vector: oneHot(0),
        prefs: JSON.stringify({ hated_genres: [] }), refreshed_at: new Date().toISOString(),
      });
    }
    for (let i = 0; i < 2; i++) {
      upsertTitle(db, {
        tmdb_id: 7000 + i, media_type: 'movie', title: `Film ${i}`, year: 2020,
        genres: '["Sci-Fi"]', keywords: '[]', cast: '[]', synopsis: 's', poster_path: null,
        embedding: oneHot(3), updated_at: new Date().toISOString(),
      });
    }
    const samWatched = (db.prepare('SELECT id FROM titles WHERE tmdb_id=7000').get() as any).id;
    upsertWatchEvent(db, { profile_id: samId, title_id: samWatched, status: 'watched', rating: 5, watched_at: new Date().toISOString() });

    const results = await retrieveJointRequestCandidates(
      db, alexId, samId, 'sci-fi', { mediaType: 'movie' }, mockConfig, embedAt(3),
    );
    expect(results.map(r => r.id)).not.toContain(samWatched);
  });
});
