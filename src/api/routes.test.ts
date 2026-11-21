import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertRecommendation, getCalibration } from '../db/repos/recommendations.js';
import { createApiRoutes } from '../api/routes.js';
import type { Config } from '../config.js';
import { curateCandidates } from '../curation/curate.js';
import { ensureFreshRatings } from '../ratings/freshness.js';
import { PICKS_LIST_LIMIT } from './generate.js';

// Module-level mocks: only affect tests that exercise /generate.
// All other route tests do not call these modules so they are unaffected.
// The request path has its own tests with injected deps (generate.test.ts).
vi.mock('../curation/curate.js', () => ({ curateCandidates: vi.fn() }));
vi.mock('../ratings/freshness.js', () => ({ ensureFreshRatings: vi.fn() }));

const mockConfig: Config = {
  tmdbApiKey: 'test', ollamaUrl: 'http://localhost:11434',
  claudeToken: 'test-token', port: 8094, dbPath: ':memory:',
  omdbApiKey: undefined,
  harvestDailyTarget: 500,
  requestLookupDailyBudget: 500,
  harvestMaxPage: 30,
};

/** A release year inside the feed's rolling recent window, whatever today's date. */
const RECENT_YEAR = new Date().getFullYear() - 1;

/** Feed response from GET /recommendations and POST /generate. */
type Feed = {
  recs: Array<Record<string, unknown>>;
  sections: Array<{ text: string | null; summary: unknown; recIds: number[] }>;
  request: unknown;
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

describe('rate limiting', () => {
  it('returns 429 after exceeding the /generate limit, but leaves other endpoints unaffected', async () => {
    vi.mocked(curateCandidates).mockResolvedValue(undefined as any);
    const db = setupDb();
    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const generateOnce = () => app.request('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1 }),
    });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await generateOnce();
      statuses.push(res.status);
    }
    // The 6th call in the window should be throttled.
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, 5).every(s => s === 200)).toBe(true);

    // A GET (not rate-limited) still works fine while /generate is throttled.
    const profilesRes = await app.request('/api/profiles');
    expect(profilesRes.status).toBe(200);
  });
});

describe('a request that cannot be read', () => {
  it('is answered at once with examples, makes no picks and does not use up the request cap', async () => {
    vi.mocked(curateCandidates).mockClear().mockResolvedValue(undefined as any);
    const db = setupDb();
    const app = new Hono().route('/api', createApiRoutes(db, mockConfig));
    const post = (body: unknown) => app.request('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    for (let i = 0; i < 6; i++) {
      const res = await post({ profileId: 1, request: 'asdkjh qwe zzv' });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toMatch(/^“asdkjh qwe zzv” could not be read, so no picks were made\. Try something like/);
    }
    expect(curateCandidates).not.toHaveBeenCalled();
    expect((await post({ profileId: 1 })).status).toBe(200);
  });
});

describe('GET /api/recommendations/:profileId', () => {
  it('returns empty array for profile with no recommendations', async () => {
    const db = setupDb();
    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/recommendations/1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recs: [], sections: [], request: null });
  });

  it('hides stored picks whose title fails the loosest hard-filter floor, keeps widened-but-legit ones', async () => {
    const db = setupDb();
    const base = {
      media_type: 'movie' as const, genres: '["Thriller"]', keywords: '[]', cast: '[]', synopsis: 's',
      poster_path: null, embedding: null, updated_at: '2026-01-01', year: RECENT_YEAR, original_language: 'en',
      runtime_minutes: 100, vote_average: 7.1, vote_count: 2000, status: 'Released', popularity: 20, imdb_rating: '7.2',
    };
    upsertTitle(db, { ...base, tmdb_id: 1, title: 'Good Recent' });
    upsertTitle(db, { ...base, tmdb_id: 2, title: 'Widened Lesser Known', runtime_minutes: 45, vote_count: 25 });
    upsertTitle(db, { ...base, tmdb_id: 3, title: 'Unreleased Zero Votes', year: RECENT_YEAR + 2, vote_count: 0, vote_average: 0, status: 'Post Production' });
    upsertTitle(db, { ...base, tmdb_id: 4, title: 'Foreign Short', original_language: 'zh', runtime_minutes: 14 });
    // No year floor: a request may ask for an old film, and its pick was checked against that request.
    upsertTitle(db, { ...base, tmdb_id: 5, title: 'Silent Era', year: 1927 });
    upsertTitle(db, { ...base, tmdb_id: 6, title: 'No IMDb Rating', imdb_rating: null });
    upsertTitle(db, { ...base, tmdb_id: 7, title: 'Few IMDb Votes' });
    db.prepare('UPDATE titles SET imdb_votes = ?').run(1500);
    db.prepare("UPDATE titles SET imdb_votes = 299 WHERE title = 'Few IMDb Votes'").run();
    const idOf = (t: string) => (db.prepare('SELECT id FROM titles WHERE title = ?').get(t) as { id: number }).id;
    for (const t of ['Good Recent', 'Widened Lesser Known', 'Unreleased Zero Votes', 'Foreign Short', 'Silent Era', 'No IMDb Rating', 'Few IMDb Votes']) {
      upsertRecommendation(db, { profile_id: 1, title_id: idOf(t), category: 'Top pick', score: 0.3, why_blurb: 'w', request_text: null, state: 'pending' });
    }
    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);
    const res = await app.request('/api/recommendations/1');
    expect(res.status).toBe(200);
    const titles = ((await res.json()) as Feed).recs.map(r => r.title as string).sort();
    expect(titles).toEqual(['Good Recent', 'Silent Era', 'Widened Lesser Known']);
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
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
      VALUES (999, 'movie', 'Test Film', 2020, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run();
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
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status, imdb_id, imdb_rating, imdb_votes, rt_rating)
      VALUES (997, 'movie', 'Rated Film', ?, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released', 'tt0000001', '8.5', 41000, '92%')`).run(RECENT_YEAR);
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=997').get() as any).id;
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Great film', null, 'pending', datetime('now'))`).run(titleId);

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/recommendations/1');
    expect(res.status).toBe(200);
    const { recs } = await res.json() as Feed;
    expect(recs[0].imdb_rating).toBe('8.5');
    expect(recs[0].imdb_votes).toBe(41000);
    expect(recs[0].rt_rating).toBe('92%');
    expect(recs[0].rule_note).toBeNull();
  });

  it('returns a null rt_rating when Rotten Tomatoes has no score', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status, imdb_rating, imdb_votes)
      VALUES (996, 'movie', 'No RT Film', ?, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released', '6.8', 2500)`).run(RECENT_YEAR);
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=996').get() as any).id;
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Fine film', null, 'pending', datetime('now'))`).run(titleId);

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/recommendations/1');
    const { recs } = await res.json() as Feed;
    expect(recs[0].imdb_rating).toBe('6.8');
    expect(recs[0].rt_rating).toBeNull();
  });

  it('never shows a pick whose title has no IMDb rating', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
      VALUES (995, 'movie', 'Unrated Film', ?, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run(RECENT_YEAR);
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=995').get() as any).id;
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Fine film', null, 'pending', datetime('now'))`).run(titleId);

    const app = new Hono().route('/api', createApiRoutes(db, mockConfig));
    const { recs } = await (await app.request('/api/recommendations/1')).json() as Feed;
    expect(recs).toEqual([]);
  });
});

describe('feed response: the picks in one section per request', () => {
  function addPick(db: ReturnType<typeof setupDb>, tmdbId: number, createdAt: string, text: string | null, summary: string | null, ruleNote: string | null = null): number {
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status, imdb_rating, imdb_votes)
      VALUES (?, 'movie', ?, ?, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released', '7.0', 2000)`).run(tmdbId, `Film ${tmdbId}`, RECENT_YEAR);
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id = ?').get(tmdbId) as { id: number }).id;
    return Number(db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, request_summary, rule_note, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'w', ?, 'pending', ?, ?, ?)`).run(titleId, text, summary, ruleNote, createdAt).lastInsertRowid);
  }
  const older = { text: 'comedy', understood: ['Comedy'], matched: 40, note: null };
  const newer = { text: 'thriller new 2025', understood: ['Thriller', '2025 or newer'], matched: 6, note: 'Only 6 titles match.' };

  it('puts the newest request first, gives each section its own summary, and keeps each pick\'s rule note', async () => {
    const db = setupDb();
    const comedy = addPick(db, 801, '2026-11-01T10:00:00.000Z', 'comedy', JSON.stringify(older), 'Released 2012: too few recent comedies matched.');
    const thriller = addPick(db, 802, '2026-11-02T10:00:00.000Z', 'thriller new 2025', JSON.stringify(newer));
    const app = new Hono().route('/api', createApiRoutes(db, mockConfig));

    const feed = await (await app.request('/api/recommendations/1')).json() as Feed;
    expect(feed.request).toBeNull();
    expect(feed.sections).toEqual([
      { text: 'thriller new 2025', summary: newer, recIds: [thriller] },
      { text: 'comedy', summary: older, recIds: [comedy] },
    ]);
    expect(feed.recs.map(r => r.tmdb_id)).toEqual([802, 801]);
    expect(feed.recs.map(r => r.rule_note)).toEqual([null, 'Released 2012: too few recent comedies matched.']);
    for (const r of feed.recs) expect(r).not.toHaveProperty('request_summary');
  });

  it('adds a repeat of a request above its earlier picks, and moves that section to the top', async () => {
    const db = setupDb();
    const first = addPick(db, 841, '2026-11-01T10:00:00.000Z', 'Thriller new 2025', JSON.stringify(newer));
    const comedy = addPick(db, 842, '2026-11-02T10:00:00.000Z', 'comedy', JSON.stringify(older));
    const again = addPick(db, 843, '2026-11-03T10:00:00.000Z', ' thriller NEW 2025', JSON.stringify({ ...newer, note: 'Asked again.' }));
    const app = new Hono().route('/api', createApiRoutes(db, mockConfig));

    const feed = await (await app.request('/api/recommendations/1')).json() as Feed;
    expect(feed.sections.map(s => s.recIds)).toEqual([[again, first], [comedy]]);
    expect(feed.sections[0].summary).toMatchObject({ note: 'Asked again.' });
  });

  it('leaves out a pick that is no longer visible, and a section with nothing left', async () => {
    const db = setupDb();
    const comedy = addPick(db, 811, '2026-11-01T10:00:00.000Z', 'comedy', JSON.stringify(older));
    const watched = addPick(db, 812, '2026-11-02T10:00:00.000Z', 'thriller new 2025', JSON.stringify(newer));
    const watchedTitle = (db.prepare('SELECT title_id FROM recommendations WHERE id = ?').get(watched) as { title_id: number }).title_id;
    upsertWatchEvent(db, { profile_id: 1, title_id: watchedTitle, status: 'watched', rating: 4, watched_at: null });
    const app = new Hono().route('/api', createApiRoutes(db, mockConfig));

    const feed = await (await app.request('/api/recommendations/1')).json() as Feed;
    expect(feed.sections).toEqual([{ text: 'comedy', summary: older, recIds: [comedy] }]);
  });

  it('gives a section a null summary when its picks have none or an unreadable one', async () => {
    for (const stored of [null, '{not json', JSON.stringify({ text: 'x' }), 'null']) {
      const db = setupDb();
      addPick(db, 821, '2026-11-02T10:00:00.000Z', 'x', stored);
      const app = new Hono().route('/api', createApiRoutes(db, mockConfig));
      const feed = await (await app.request('/api/recommendations/1')).json() as Feed;
      expect(feed.sections).toEqual([{ text: 'x', summary: null, recIds: [expect.any(Number)] }]);
    }
  });

  it('POST /generate without a request returns the same feed shape, with no request summary', async () => {
    vi.mocked(curateCandidates).mockResolvedValue([] as any);
    const db = setupDb();
    addPick(db, 831, '2026-11-02T10:00:00.000Z', 'thriller new 2025', JSON.stringify(newer));
    const app = new Hono().route('/api', createApiRoutes(db, mockConfig));

    const res = await app.request('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1 }),
    });
    expect(res.status).toBe(200);
    const feed = await res.json() as Feed;
    expect(feed.request).toBeNull();
    expect(feed.recs.map(r => r.tmdb_id)).toEqual([831]);
    expect(feed.sections).toHaveLength(1);
  });

  it('POST /generate reports a missing or unknown profile', async () => {
    const app = new Hono().route('/api', createApiRoutes(setupDb(), mockConfig));
    const post = (body: unknown) => app.request('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await post({})).status).toBe(400);
    const missing = await post({ profileId: 99 });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Profile not found' });
  });
});

describe('GET /api/recommendations/:profileId — watched-title exclusion', () => {
  it('excludes pending recs whose title has been watched by the solo profile', async () => {
    const db = setupDb();
    // Insert two titles
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status, imdb_rating, imdb_votes)
      VALUES (991, 'movie', 'Watched Film', ?, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released', '7.0', 2000)`).run(RECENT_YEAR);
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status, imdb_rating, imdb_votes)
      VALUES (992, 'movie', 'Unwatched Film', ?, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released', '7.0', 2000)`).run(RECENT_YEAR);
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
    const { recs } = await res.json() as Feed;
    // Only the unwatched film should appear
    expect(recs).toHaveLength(1);
    expect(recs[0].tmdb_id).toBe(992);
  });

  it('excludes watchlist-only titles from Picks (already chosen)', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status, imdb_rating, imdb_votes)
      VALUES (993, 'movie', 'Watchlist Film', ?, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released', '7.0', 2000)`).run(RECENT_YEAR);
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=993').get() as any).id;

    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.85, 'Queued', null, 'pending', datetime('now'))`).run(titleId);

    // Only on watchlist — not 'watched'
    upsertWatchEvent(db, { profile_id: 1, title_id: titleId, status: 'watchlist', rating: null, watched_at: null });

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/recommendations/1');
    const { recs } = await res.json() as Feed;
    // A watchlisted title is already chosen — it must not remain in Picks.
    expect(recs).toHaveLength(0);
  });
});

describe('POST /api/dismiss', () => {
  it('dismisses a recommendation', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
      VALUES (998, 'tv', 'Test Show', 2021, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run();
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

describe('POST /api/dismiss-reason', () => {
  it('stores the reason on the rec and writes back to hated_genres for not_my_genre', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
      VALUES (997, 'movie', 'Horror Flick', 2021, '["Horror"]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=997').get() as any).id;
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Great show', null, 'dismissed', datetime('now'))`).run(titleId);
    const recId = (db.prepare('SELECT id FROM recommendations WHERE profile_id=1').get() as any).id;

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/dismiss-reason', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1, recommendationId: recId, reason: 'not_my_genre' }),
    });
    expect(res.status).toBe(200);

    const rec = db.prepare('SELECT dismiss_reason FROM recommendations WHERE id=?').get(recId) as any;
    expect(rec.dismiss_reason).toBe('not_my_genre');

    const sig = db.prepare('SELECT prefs FROM taste_signatures WHERE profile_id=1').get() as any;
    expect(JSON.parse(sig.prefs).hated_genres).toEqual(['Horror']);
  });

  it('switching tiles reverses the old reason\'s write-back before applying the new one', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
      VALUES (992, 'movie', 'Switch Flick', 2021, '["Horror"]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=992').get() as any).id;
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Great show', null, 'dismissed', datetime('now'))`).run(titleId);
    const recId = (db.prepare('SELECT id FROM recommendations WHERE profile_id=1').get() as any).id;

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);
    const pick = (reason: string) => app.request('/api/dismiss-reason', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1, recommendationId: recId, reason }),
    });

    // First tile: not_my_genre → hated_genres gets Horror.
    expect((await pick('not_my_genre')).status).toBe(200);
    let sig = JSON.parse((db.prepare('SELECT prefs FROM taste_signatures WHERE profile_id=1').get() as any).prefs);
    expect(sig.hated_genres).toEqual(['Horror']);
    expect(sig.hated_themes ?? []).toEqual([]);

    // Switch to too_dark → the earlier hated_genres addition must be reversed,
    // not left stacked alongside the new hated_themes entry.
    expect((await pick('too_dark')).status).toBe(200);
    sig = JSON.parse((db.prepare('SELECT prefs FROM taste_signatures WHERE profile_id=1').get() as any).prefs);
    expect(sig.hated_genres).toEqual([]);
    expect(sig.hated_themes).toEqual(['dark/violent']);
    const rec = db.prepare('SELECT dismiss_reason FROM recommendations WHERE id=?').get(recId) as any;
    expect(rec.dismiss_reason).toBe('too_dark');

    // Switch to a no-write-back reason (cast_vibe) → the hated_themes entry
    // from too_dark must also be reversed, leaving nothing behind.
    expect((await pick('cast_vibe')).status).toBe(200);
    sig = JSON.parse((db.prepare('SELECT prefs FROM taste_signatures WHERE profile_id=1').get() as any).prefs);
    expect(sig.hated_genres).toEqual([]);
    expect(sig.hated_themes).toEqual([]);

    // Re-selecting the SAME tile again is a harmless no-op — no duplication.
    expect((await pick('cast_vibe')).status).toBe(200);
    sig = JSON.parse((db.prepare('SELECT prefs FROM taste_signatures WHERE profile_id=1').get() as any).prefs);
    expect(sig.hated_genres).toEqual([]);
    expect(sig.hated_themes).toEqual([]);
  });

  it('rejects a reason for a recommendation owned by a different profile (IDOR)', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
      VALUES (991, 'movie', 'Owned By Alex', 2021, '["Horror"]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=991').get() as any).id;
    // Owned by profile 1 (Alex).
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Great show', null, 'dismissed', datetime('now'))`).run(titleId);
    const recId = (db.prepare('SELECT id FROM recommendations WHERE profile_id=1').get() as any).id;

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    // Posted as profile 2 (Sam) — must be rejected, not applied to either profile's prefs.
    const res = await app.request('/api/dismiss-reason', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 2, recommendationId: recId, reason: 'not_my_genre' }),
    });
    expect(res.status).toBe(404);

    const rec = db.prepare('SELECT dismiss_reason FROM recommendations WHERE id=?').get(recId) as any;
    expect(rec.dismiss_reason).toBeNull();
    const sigAlex = db.prepare('SELECT prefs FROM taste_signatures WHERE profile_id=1').get() as any;
    expect(sigAlex).toBeUndefined();
    const sigSam = db.prepare('SELECT prefs FROM taste_signatures WHERE profile_id=2').get() as any;
    expect(sigSam).toBeUndefined();
  });

  it('rejects a reason for a recommendation that is not dismissed (still pending)', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
      VALUES (995, 'movie', 'Pending Flick', 2021, '["Horror"]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=995').get() as any).id;
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Great show', null, 'pending', datetime('now'))`).run(titleId);
    const recId = (db.prepare('SELECT id FROM recommendations WHERE profile_id=1').get() as any).id;

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/dismiss-reason', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1, recommendationId: recId, reason: 'not_my_genre' }),
    });
    expect(res.status).toBe(409);

    // No write-back happened for the never-dismissed rec.
    const sig = db.prepare('SELECT prefs FROM taste_signatures WHERE profile_id=1').get() as any;
    expect(sig).toBeUndefined();
    const rec = db.prepare('SELECT dismiss_reason FROM recommendations WHERE id=?').get(recId) as any;
    expect(rec.dismiss_reason).toBeNull();
  });

  it('rejects an unrecognised reason', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
      VALUES (996, 'movie', 'Some Flick', 2021, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=996').get() as any).id;
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Great show', null, 'dismissed', datetime('now'))`).run(titleId);
    const recId = (db.prepare('SELECT id FROM recommendations WHERE profile_id=1').get() as any).id;

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/dismiss-reason', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1, recommendationId: recId, reason: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/undismiss', () => {
  it('rejects undismissing a recommendation owned by a different profile (IDOR)', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
      VALUES (990, 'movie', 'Owned By Alex Undismiss', 2021, '["Horror"]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=990').get() as any).id;
    // Owned by profile 1 (Alex), already dismissed with a reason.
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, dismiss_reason, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Great show', null, 'dismissed', 'not_my_genre', datetime('now'))`).run(titleId);
    const recId = (db.prepare('SELECT id FROM recommendations WHERE profile_id=1').get() as any).id;
    db.prepare(`INSERT INTO taste_signatures (profile_id, prefs, refreshed_at) VALUES (1, ?, datetime('now'))`)
      .run(JSON.stringify({ hated_genres: ['Horror'] }));

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    // Posted as profile 2 (Sam) — must be rejected: rec stays dismissed, its
    // reason stays intact, and Alex's hated_genres is not reversed by Sam's call.
    const res = await app.request('/api/undismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 2, recommendationId: recId }),
    });
    expect(res.status).toBe(404);

    const rec = db.prepare('SELECT state, dismiss_reason FROM recommendations WHERE id=?').get(recId) as any;
    expect(rec.state).toBe('dismissed');
    expect(rec.dismiss_reason).toBe('not_my_genre');
    const sigAlex = db.prepare('SELECT prefs FROM taste_signatures WHERE profile_id=1').get() as any;
    expect(JSON.parse(sigAlex.prefs).hated_genres).toEqual(['Horror']);
  });

  it('reverses the reason-derived prefs write-back and clears dismiss_reason', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
      VALUES (993, 'movie', 'Undo Reason Flick', 2021, '["Horror"]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=993').get() as any).id;
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, ?, 'Top pick', 0.9, 'Great show', null, 'dismissed', datetime('now'))`).run(titleId);
    const recId = (db.prepare('SELECT id FROM recommendations WHERE profile_id=1').get() as any).id;

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    // Dismiss with a reason first — this is the write-back /undismiss must reverse.
    await app.request('/api/dismiss-reason', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1, recommendationId: recId, reason: 'not_my_genre' }),
    });
    expect(JSON.parse((db.prepare('SELECT prefs FROM taste_signatures WHERE profile_id=1').get() as any).prefs).hated_genres)
      .toEqual(['Horror']);

    const res = await app.request('/api/undismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1, recommendationId: recId }),
    });
    expect(res.status).toBe(200);

    const rec = db.prepare('SELECT state, dismiss_reason FROM recommendations WHERE id=?').get(recId) as any;
    expect(rec.state).toBe('pending');
    expect(rec.dismiss_reason).toBeNull();

    const sig = db.prepare('SELECT prefs FROM taste_signatures WHERE profile_id=1').get() as any;
    expect(JSON.parse(sig.prefs).hated_genres).toEqual([]);
  });

  it('restores a dismissed recommendation to pending', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
      VALUES (994, 'tv', 'Undo Show', 2021, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run();
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

describe('a change that saved while the embedder is down', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reports success: the rating is stored even though the taste refresh failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = setupDb();
    // No stored embedding, so rating it high needs a live call to Ollama.
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
      VALUES (777, 'movie', 'Unembedded', 2020, '[]', '[]', '[]', null, null, datetime('now'))`).run();
    const titleId = (db.prepare('SELECT id FROM titles WHERE tmdb_id=777').get() as any).id;
    const app = new Hono().route('/api', createApiRoutes(db, mockConfig));

    const res = await app.request('/api/rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1, titleId, rating: 5 }),
    });

    expect(res.status).toBe(200);
    expect(db.prepare('SELECT rating FROM watch_events WHERE title_id = ?').get(titleId)).toEqual({ rating: 5 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('GET /api/stats', () => {
  it('returns the catalogue total plus the movie/series split', async () => {
    const db = setupDb();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
      VALUES (981, 'movie', 'Film One', 2020, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
      VALUES (982, 'movie', 'Film Two', 2021, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run();
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
      VALUES (983, 'tv', 'Series One', 2022, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run();

    const api = createApiRoutes(db, mockConfig);
    const app = new Hono().route('/api', api);

    const res = await app.request('/api/stats');
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; movie: number; tv: number };
    expect(body).toEqual({ total: 3, movie: 2, tv: 1 });
  });
});

// ─── POST /generate — ratings of the picks just made are refreshed ──────────

describe('POST /generate — ratings', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('refreshes the ratings of the new picks only, in one bounded call', async () => {
    vi.mocked(ensureFreshRatings).mockClear();
    const db = setupDb();
    const add = (tmdbId: number) => {
      db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status)
        VALUES (?, 'movie', ?, 2020, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released')`).run(tmdbId, `Film ${tmdbId}`);
      return (db.prepare('SELECT id FROM titles WHERE tmdb_id = ?').get(tmdbId) as { id: number }).id;
    };
    const [oldT, freshA, freshB] = [861, 862, 863].map(add);
    upsertRecommendation(db, { profile_id: 1, title_id: oldT, category: 'Top pick', score: 0.9, why_blurb: 'old', request_text: null, state: 'pending' });
    vi.mocked(curateCandidates).mockImplementation(async () => {
      for (const t of [freshA, freshB]) {
        upsertRecommendation(db, { profile_id: 1, title_id: t, category: 'Top pick', score: 0.8, why_blurb: 'new', request_text: null, state: 'pending' });
      }
      return [] as any;
    });

    const app = new Hono().route('/api', createApiRoutes(db, mockConfig));
    const res = await app.request('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: 1 }),
    });
    expect(res.status).toBe(200);

    expect(ensureFreshRatings).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ensureFreshRatings).mock.calls[0][1]).toEqual([freshA, freshB]);
  });
});

// ─── POST /generate — the Picks list grows, up to PICKS_LIST_LIMIT ──────────
// Each generate adds its picks; past the limit the oldest move to 'shown', so
// the list never piles up the way it once did, and no row is deleted.

describe('POST /generate — adds to the profile\'s Picks list', () => {
  function addTitle(db: InstanceType<typeof Database>, tmdbId: number): number {
    db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status, rating_checked_at)
      VALUES (?, 'movie', ?, 2020, '[]', '[]', '[]', null, null, datetime('now'), 'en', 100, 7.0, 1000, 'Released', 1700000000)`).run(tmdbId, `T${tmdbId}`);
    return (db.prepare('SELECT id FROM titles WHERE tmdb_id = ?').get(tmdbId) as { id: number }).id;
  }
  function addRec(db: InstanceType<typeof Database>, profileId: number, titleId: number, state: string): number {
    return Number(db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (?, ?, 'Top pick', 0.9, 'Test', null, ?, datetime('now'))`).run(profileId, titleId, state).lastInsertRowid);
  }
  const generate = (app: Hono) => app.request('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: 1 }),
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('adds the new picks and keeps every older one', async () => {
    const db = setupDb();
    const [oldA, oldB, otherT, freshT] = [701, 702, 707, 708].map(id => addTitle(db, id));
    const oldIds = [addRec(db, 1, oldA, 'pending'), addRec(db, 1, oldB, 'pending')];
    const otherId = addRec(db, 2, otherT, 'pending');

    // The curator writes one fresh pick, as the real one does via upsertRecommendation.
    vi.mocked(curateCandidates).mockImplementation(async () => {
      upsertRecommendation(db, { profile_id: 1, title_id: freshT, category: 'Top pick', score: 0.8, why_blurb: 'new', request_text: null, state: 'pending' });
      return [] as any;
    });

    const app = new Hono().route('/api', createApiRoutes(db, mockConfig));
    expect((await generate(app)).status).toBe(200);

    const pending = (db.prepare("SELECT id, title_id FROM recommendations WHERE state = 'pending' ORDER BY id").all() as Array<{ id: number; title_id: number }>);
    expect(pending.map(r => r.id)).toEqual(expect.arrayContaining([...oldIds, otherId]));
    expect(pending.map(r => r.title_id)).toContain(freshT);
  });

  it('keeps the list to its limit: the oldest picks move to shown, with their predicted ratings', async () => {
    const db = setupDb();
    const ids: number[] = [];
    for (let i = 0; i < PICKS_LIST_LIMIT; i++) {
      const t = addTitle(db, 900 + i);
      ids.push(Number(db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, predicted_rating, created_at)
        VALUES (1, ?, 'Top pick', 0.9, 'w', null, 'pending', 4, ?)`).run(t, `2026-10-01T10:${String(i).padStart(2, '0')}:00.000Z`).lastInsertRowid));
    }
    const freshT = addTitle(db, 990);
    vi.mocked(curateCandidates).mockImplementation(async () => {
      upsertRecommendation(db, { profile_id: 1, title_id: freshT, category: 'Top pick', score: 0.8, why_blurb: 'new', request_text: null, state: 'pending' });
      return [] as any;
    });

    const app = new Hono().route('/api', createApiRoutes(db, mockConfig));
    expect((await generate(app)).status).toBe(200);

    const state = (id: number) => (db.prepare('SELECT state, predicted_rating FROM recommendations WHERE id = ?').get(id));
    expect(db.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE profile_id = 1 AND state = 'pending'").get()).toEqual({ n: PICKS_LIST_LIMIT });
    expect(state(ids[0])).toEqual({ state: 'shown', predicted_rating: 4 });
    expect(state(ids[1])).toEqual({ state: 'pending', predicted_rating: 4 });
  });

  it('Clear list empties Picks for that profile only, keeping the rows and their predicted ratings', async () => {
    const db = setupDb();
    const [mineT, ratedT, otherT] = [761, 762, 763].map(id => addTitle(db, id));
    addRec(db, 1, mineT, 'pending');
    upsertRecommendation(db, { profile_id: 1, title_id: ratedT, category: 'Top pick', score: 0.9, why_blurb: 'r', request_text: null, state: 'pending', predicted_rating: 4 });
    upsertWatchEvent(db, { profile_id: 1, title_id: ratedT, status: 'watched', rating: 2, watched_at: new Date().toISOString() });
    const otherId = addRec(db, 2, otherT, 'pending');
    const before = getCalibration(db, 1);

    const app = new Hono().route('/api', createApiRoutes(db, mockConfig));
    const res = await app.request('/api/recommendations/1/clear', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recs: [], sections: [], request: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE profile_id = 1 AND state = 'shown'").get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT state FROM recommendations WHERE id = ?').get(otherId)).toEqual({ state: 'pending' });
    expect(getCalibration(db, 1)).toEqual(before);
    expect((await app.request('/api/recommendations/x/clear', { method: 'POST' })).status).toBe(400);
  });

  it('Surprise Me appends: the old pending rows stay alongside the new picks', async () => {
    const db = setupDb();
    const [oldT, freshT] = [731, 732].map(id => addTitle(db, id));
    const oldId = addRec(db, 1, oldT, 'pending');
    vi.mocked(curateCandidates).mockImplementation(async () => {
      upsertRecommendation(db, { profile_id: 1, title_id: freshT, category: 'Top pick', score: 0.8, why_blurb: 'new', request_text: null, state: 'pending' });
      return [] as any;
    });

    const app = new Hono().route('/api', createApiRoutes(db, mockConfig));
    const res = await app.request('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1, surprise: true }),
    });
    expect(res.status).toBe(200);

    const pending = db.prepare("SELECT id, title_id FROM recommendations WHERE profile_id = 1 AND state = 'pending' ORDER BY id").all() as Array<{ id: number; title_id: number }>;
    expect(pending.map(r => r.id)).toContain(oldId);
    expect(pending.map(r => r.title_id)).toEqual([oldT, freshT]);
  });

  it('an overlapping generate for the same profile does not count the other call\'s picks as its own', async () => {
    const db = setupDb();
    const oldMovieT = addTitle(db, 751);
    for (const [tmdbId, name] of [[752, 'Old Show'], [753, 'New Show']] as const) {
      db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at, original_language, runtime_minutes, vote_average, vote_count, status, rating_checked_at)
        VALUES (?, 'tv', ?, 2020, '[]', '[]', '[]', null, null, datetime('now'), 'en', 45, 7.0, 1000, 'Returning Series', 1700000000)`).run(tmdbId, name);
    }
    const tvId = (tmdbId: number) => (db.prepare("SELECT id FROM titles WHERE tmdb_id = ? AND media_type = 'tv'").get(tmdbId) as { id: number }).id;
    const oldMovieId = addRec(db, 1, oldMovieT, 'pending');
    addRec(db, 1, tvId(752), 'pending');

    // The Movies-only call is slow and finds nothing; the TV-only call writes a new TV pick.
    vi.mocked(curateCandidates).mockImplementation(async () => {
      const calls = vi.mocked(curateCandidates).mock.calls.length;
      if (calls === 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
        return [] as any;
      }
      upsertRecommendation(db, { profile_id: 1, title_id: tvId(753), category: 'Top pick', score: 0.8, why_blurb: 'new', request_text: null, state: 'pending' });
      return [] as any;
    });

    const app = new Hono().route('/api', createApiRoutes(db, mockConfig));
    const post = (mediaType: string) => app.request('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 1, mediaType }),
    });
    const [movieRes, tvRes] = await Promise.all([post('movie'), post('tv')]);
    expect(movieRes.status).toBe(200);
    expect(tvRes.status).toBe(200);

    const pending = (db.prepare("SELECT id FROM recommendations WHERE profile_id = 1 AND state = 'pending'").all() as Array<{ id: number }>).map(r => r.id);
    expect(pending).toContain(oldMovieId);
  });

  it('keeps the old pending rows when the generate produced no new picks', async () => {
    const db = setupDb();
    const oldId = addRec(db, 1, addTitle(db, 711), 'pending');
    vi.mocked(curateCandidates).mockResolvedValue([] as any);

    const app = new Hono().route('/api', createApiRoutes(db, mockConfig));
    expect((await generate(app)).status).toBe(200);

    const pending = (db.prepare("SELECT id FROM recommendations WHERE profile_id = 1 AND state = 'pending'").all() as Array<{ id: number }>).map(r => r.id);
    expect(pending).toEqual([oldId]);
  });
});
