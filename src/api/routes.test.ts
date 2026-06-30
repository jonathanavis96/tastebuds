import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { createApiRoutes } from '../api/routes.js';
import type { Config } from '../config.js';
import { resolveRtUrl } from '../rt/resolve.js';
import { curateCandidates } from '../curation/curate.js';

// Module-level mocks: only affect tests that exercise /generate.
// All other route tests do not call these modules so they are unaffected.
vi.mock('../rt/resolve.js', () => ({ resolveRtUrl: vi.fn() }));
vi.mock('../curation/curate.js', () => ({ curateCandidates: vi.fn() }));

const mockConfig: Config = {
  tmdbApiKey: 'test', ollamaUrl: 'http://localhost:11434',
  claudeToken: 'test-token', port: 8094, dbPath: ':memory:',
  omdbApiKey: undefined,
  harvestDailyTarget: 500,
  requestLookupDailyBudget: 500,
  harvestMaxPage: 30,
};

function setupDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
  upsertProfile(db, { name: 'Sam', media_weighting: 0.3, is_derived: 0, config: '{}' });
  upsertProfile(db, { name: 'Joint', media_weighting: 0.7, is_derived: 1, config: '{}' });
  return db;
}

describe('GET /api/profiles', () => {
  it('returns all seeded profiles', async () => {
    const db = setupDb();
    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/profiles');
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{name: string}>;
    expect(body.map(p => p.name)).toEqual(expect.arrayContaining(['Alex', 'Sam', 'Joint']));
  });
});

describe('GET /api/recommendations/:profileId', () => {
  it('returns empty array for profile with no recommendations', async () => {
    const db = setupDb();
    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/recommendations/1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it('returns 400 for invalid profileId', async () => {
    const db = setupDb();
    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/recommendations/not-a-number');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/watchlist', () => {
  it('adds title to watchlist', async () => {
    const db = setupDb();
    // seed a title (no on_viu column per Decision Override #1)
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
      VALUES (999, 'movie', 'Test Film', 2020, '[]', '[]', '[]', null, null, datetime('now'))`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=999').get() as any).id;

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1, titleId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {ok: boolean};
    expect(body.ok).toBe(true);
  });
});

describe('GET /api/recommendations/:profileId — enrichRec includes rating fields', () => {
  it('returns imdb_rating and rt_rating from joined title', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, imdb_id, imdb_rating, rt_rating)
      VALUES (997, 'movie', 'Rated Film', 2020, '[]', '[]', '[]', null, null, datetime('now'), 'tt0000001', '8.5', '92%')`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=997').get() as any).id;
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Great film', null, 'pending', datetime('now'))`).run(titleId);

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/recommendations/1');
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    expect(body[0].imdb_rating).toBe('8.5');
    expect(body[0].rt_rating).toBe('92%');
  });

  it('returns null imdb_rating and rt_rating when not set', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
      VALUES (996, 'movie', 'Unrated Film', 2020, '[]', '[]', '[]', null, null, datetime('now'))`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=996').get() as any).id;
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Fine film', null, 'pending', datetime('now'))`).run(titleId);

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/recommendations/1');
    const body = await res.json() as Array<Record<string, unknown>>;
    expect(body[0].imdb_rating).toBeNull();
    expect(body[0].rt_rating).toBeNull();
  });
});

describe('GET /api/recommendations/:profileId — watched-title exclusion', () => {
  it('excludes pending recs whose title has been watched by the solo profile', async () => {
    const db = setupDb();
    // Insert two titles
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
      VALUES (991, 'movie', 'Watched Film', 2020, '[]', '[]', '[]', null, null, datetime('now'))`).run();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
      VALUES (992, 'movie', 'Unwatched Film', 2021, '[]', '[]', '[]', null, null, datetime('now'))`).run();
    const watchedId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=991').get() as any).id;
    const unwatchedId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=992').get() as any).id;

    // Both are pending recs for profile 1 (Alex)
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Great', null, 'pending', datetime('now'))`).run(watchedId);
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.8, 'Also great', null, 'pending', datetime('now'))`).run(unwatchedId);

    // Mark 'Watched Film' as watched by profile 1
    upsertWatchEvent(db, { profile_id: 1, title_id: watchedId, status: 'watched', rating: 4, watched_at: new Date().toISOString() });

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/recommendations/1');
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    // Only the unwatched film should appear
    expect(body).toHaveLength(1);
    expect(body[0].tmdb_id).toBe(992);
  });

  it('excludes watchlist-only titles from Picks (already chosen)', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
      VALUES (993, 'movie', 'Watchlist Film', 2022, '[]', '[]', '[]', null, null, datetime('now'))`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=993').get() as any).id;

    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.85, 'Queued', null, 'pending', datetime('now'))`).run(titleId);

    // Only on watchlist — not 'watched'
    upsertWatchEvent(db, { profile_id: 1, title_id: titleId, status: 'watchlist', rating: null, watched_at: null });

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/recommendations/1');
    const body = await res.json() as Array<Record<string, unknown>>;
    // A watchlisted title is already chosen — it must not remain in Picks.
    expect(body).toHaveLength(0);
  });
});

describe('POST /api/dismiss', () => {
  it('dismisses a recommendation', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
      VALUES (998, 'tv', 'Test Show', 2021, '[]', '[]', '[]', null, null, datetime('now'))`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=998').get() as any).id;
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Great show', null, 'pending', datetime('now'))`).run(titleId);
    const recId = (db.prepare('SELECT id FROM recommendations WHERE profile_id=1').get() as any).id;

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1, recommendationId: recId }),
    });
    expect(res.status).toBe(200);
    const rec = db.prepare('SELECT state FROM recommendations WHERE id=?').get(recId) as any;
    expect(rec.state).toBe('dismissed');
  });
});

describe('POST /api/undismiss', () => {
  it('restores a dismissed recommendation to pending', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
      VALUES (994, 'tv', 'Undo Show', 2021, '[]', '[]', '[]', null, null, datetime('now'))`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=994').get() as any).id;
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Great show', null, 'dismissed', datetime('now'))`).run(titleId);
    const recId = (db.prepare('SELECT id FROM recommendations WHERE profile_id=1').get() as any).id;

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/undismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1, recommendationId: recId }),
    });
    expect(res.status).toBe(200);
    const rec = db.prepare('SELECT state FROM recommendations WHERE id=?').get(recId) as any;
    expect(rec.state).toBe('pending');
  });
});

describe('GET /api/stats', () => {
  it('returns the catalogue total plus the movie/series split', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
      VALUES (981, 'movie', 'Film One', 2020, '[]', '[]', '[]', null, null, datetime('now'))`).run();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
      VALUES (982, 'movie', 'Film Two', 2021, '[]', '[]', '[]', null, null, datetime('now'))`).run();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
      VALUES (983, 'tv', 'Series One', 2022, '[]', '[]', '[]', null, null, datetime('now'))`).run();

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/stats');
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; movie: number; tv: number };
    expect(body).toEqual({ total: 3, movie: 2, tv: 1 });
  });
});

// ─── POST /generate — rt_url enrichment: unverified result must not be persisted ─

describe('POST /generate — unverified rt_url is not written to DB', () => {
  beforeEach(() => {
    // curateCandidates: no-op — avoids spawning claude -p in tests
    vi.mocked(curateCandidates).mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('leaves rt_url null when resolveRtUrl returns verified=false', async () => {
    // Simulate RT returning a search-URL (unverified) — the DB must stay clean
    vi.mocked(resolveRtUrl).mockResolvedValue({
      url: 'https://www.rottentomatoes.com/search?search=Test+Film',
      score: null,
      verified: false,
    });

    const db = setupDb();
    // Insert a title with no rt_url, no imdb_id (so OMDb block is skipped)
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
      VALUES (888, 'movie', 'Test Film', 2020, '[]', '[]', '[]', null, null, datetime('now'))`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=888').get() as any).id;
    // Pre-insert a pending rec so the enrichment loop has something to iterate
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Test', null, 'pending', datetime('now'))`).run(titleId);

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1 }),
    });
    expect(res.status).toBe(200);

    // rt_url must remain null — the unverified search URL must not have been written
    const row = db.prepare('SELECT rt_url FROM titles WHERE id = ?').get(titleId) as any;
    expect(row.rt_url).toBeNull();
  });

  it('writes rt_url when resolveRtUrl returns verified=true', async () => {
    vi.mocked(resolveRtUrl).mockResolvedValue({
      url: 'https://www.rottentomatoes.com/m/test_film',
      score: '85%',
      verified: true,
    });

    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
      VALUES (889, 'movie', 'Test Film', 2020, '[]', '[]', '[]', null, null, datetime('now'))`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=889').get() as any).id;
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Test', null, 'pending', datetime('now'))`).run(titleId);

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    await app.request('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1 }),
    });

    const row = db.prepare('SELECT rt_url FROM titles WHERE id = ?').get(titleId) as any;
    expect(row.rt_url).toBe('https://www.rottentomatoes.com/m/test_film');
  });
});
