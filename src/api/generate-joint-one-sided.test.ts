/**
 * POST /generate for a Joint profile where one partner has no taste vector:
 * the route ranks by the other partner instead of treating Joint as a cold start.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import { createApiRoutes } from './routes.js';
import { curateCandidates } from '../curation/curate.js';
import type { CandidatePool } from '../retrieval/retrieve.js';
import type { Config } from '../config.js';

vi.mock('../rt/resolve.js', () => ({ resolveRtUrl: vi.fn() }));
vi.mock('../curation/curate.js', () => ({ curateCandidates: vi.fn() }));
vi.mock('../omdb/client.js', () => ({ getOmdbRatings: vi.fn() }));

const config: Config = {
  tmdbApiKey: 'test', ollamaUrl: 'http://localhost:9',
  claudeToken: 'test-token', port: 8094, dbPath: ':memory:',
  omdbApiKey: undefined, harvestDailyTarget: 500, requestLookupDailyBudget: 500, harvestMaxPage: 30,
};

function oneHot(i: number, dim = 8): Buffer {
  const a = new Float32Array(dim); a[i] = 1; return Buffer.from(a.buffer);
}

describe('POST /generate, Joint with one partner lacking a taste vector', () => {
  afterEach(() => vi.resetAllMocks());

  it('curates a pool ranked by the partner who has a vector, not a cold-start pool', async () => {
    let captured: CandidatePool | undefined;
    vi.mocked(curateCandidates).mockImplementation(async (pool) => {
      captured = pool as CandidatePool;
      return [];
    });
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);
    upsertProfile(db, { name: 'Alex', media_weighting: 0.5, is_derived: 0, config: '{}' });
    upsertProfile(db, { name: 'Sam', media_weighting: 0.5, is_derived: 0, config: '{}' });
    upsertProfile(db, { name: 'Joint', media_weighting: 0.5, is_derived: 1, config: '{}' });
    const now = new Date().toISOString();
    upsertTasteSignature(db, { profile_id: 1, taste_vector: null, prefs: '{}', refreshed_at: now });
    upsertTasteSignature(db, { profile_id: 2, taste_vector: oneHot(5), prefs: '{}', refreshed_at: now });
    for (let i = 0; i < 8; i++) {
      upsertTitle(db, {
        tmdb_id: 500 + i, media_type: 'movie', title: `G${i}`, year: 2020, genres: '["Drama"]',
        keywords: '[]', cast: '[]', synopsis: 's', poster_path: null,
        embedding: oneHot(i), updated_at: now,
        vote_count: 2000, vote_average: 7, original_language: 'en', runtime_minutes: 100, status: 'Released',
      });
    }

    const app = new Hono().route('/api', createApiRoutes(db, config));
    const res = await app.request('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 3, mediaType: 'movie' }),
    });

    expect(res.status).toBe(200);
    expect(captured?.onTaste[0]?.title).toBe('G5');
    // A taste pool scores titles by distance from the vector; the cold-start
    // pool gives every title a score of 0 and orders at random.
    expect(captured?.onTaste.some(t => t.score > 0.1)).toBe(true);
  });
});
