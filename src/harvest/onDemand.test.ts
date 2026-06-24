/**
 * TDD tests for ensureRequestCoverage and resolveRequestToGenres.
 *
 * All TMDB and embed calls are injected via the deps parameter — no network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { getTitleByTmdbId } from '../db/repos/titles.js';
import { getUsage, bumpRequestAdded } from '../db/repos/apiUsage.js';
import { ensureRequestCoverage, resolveRequestToGenres, type OnDemandDeps } from './onDemand.js';
import type { Config } from '../config.js';
import type { TmdbTitle, TmdbTitleDetail } from '../tmdb/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const mockConfig: Config = {
  tmdbApiKey: 'test-key',
  ollamaUrl: 'http://localhost:11434',
  claudeToken: 'test-token',
  port: 8094,
  dbPath: ':memory:',
  omdbApiKey: undefined,
  harvestDailyTarget: 500,
  requestLookupDailyBudget: 10,
};

/** A horror TV series returned by the keyword discovery path. */
const horrorTvTitle: TmdbTitle = {
  id: 87108,
  name: 'The Terror',
  first_air_date: '2018-03-26',
  genre_ids: [9648, 18],
  overview: 'A crew is trapped in the Arctic, stalked by a monster.',
  poster_path: '/terror.jpg',
};

const horrorTvDetail: TmdbTitleDetail = {
  ...horrorTvTitle,
  genres: [{ id: 9648, name: 'Mystery' }, { id: 18, name: 'Drama' }],
  keywords: { results: [{ name: 'horror' }, { name: 'survival' }] },
  credits: { cast: [{ name: 'Jared Harris' }] },
};

/** Build a minimal stub deps object. All fns are vi.fn() stubs by default. */
function makeDeps(overrides: Partial<OnDemandDeps> = {}): OnDemandDeps {
  return {
    discoverTitles: vi.fn().mockResolvedValue([]),
    getTitleDetails: vi.fn().mockResolvedValue(horrorTvDetail),
    searchTitles: vi.fn().mockResolvedValue([]),
    searchKeyword: vi.fn().mockResolvedValue([{ id: 315058, name: 'horror' }]),
    embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    ...overrides,
  };
}

// ── resolveRequestToGenres ────────────────────────────────────────────────────

describe('resolveRequestToGenres', () => {
  it('maps "scary thrillers" to Horror and Thriller', () => {
    const genres = resolveRequestToGenres('scary thrillers');
    expect(genres).toContain('Horror');
    expect(genres).toContain('Thriller');
  });

  it('maps "funny comedy" to Comedy', () => {
    const genres = resolveRequestToGenres('funny comedy');
    expect(genres).toContain('Comedy');
  });

  it('matches case-insensitively', () => {
    const genres = resolveRequestToGenres('SCARY THRILLER');
    expect(genres).toContain('Horror');
    expect(genres).toContain('Thriller');
  });

  it('matches "science fiction" as multi-word term', () => {
    const genres = resolveRequestToGenres('mind-bending science fiction');
    expect(genres).toContain('Science Fiction');
  });

  it('returns empty array for unrecognised vibes', () => {
    const genres = resolveRequestToGenres('something completely unrelated xyz');
    expect(genres).toHaveLength(0);
  });

  it('does not double-count a genre matched by two synonyms', () => {
    // "horror" and "scary" both map to Horror
    const genres = resolveRequestToGenres('scary horror movies');
    const count = genres.filter((g) => g === 'Horror').length;
    expect(count).toBe(1);
  });
});

// ── ensureRequestCoverage — keyword path ─────────────────────────────────────

describe('ensureRequestCoverage — keyword path (TV Horror)', () => {
  beforeEach(() => {
    // Clear the in-process keyword cache between tests so keyword ids don't bleed
    // across test runs. We do this by re-importing — but since ESM caches modules,
    // we instead rely on the vi.fn() reset per makeDeps() call.
    vi.clearAllMocks();
  });

  it('upserts a horror TV series via keyword discovery and returns added >= 1', async () => {
    const db = createTestDb();
    const deps = makeDeps({
      // Keyword search resolves "horror" → 315058
      searchKeyword: vi.fn().mockResolvedValue([{ id: 315058, name: 'horror' }]),
      // Keyword discover returns the horror series
      discoverTitles: vi.fn().mockImplementation(async (opts) => {
        if (opts.keywordIds?.includes(315058)) return [horrorTvTitle];
        return [];
      }),
      getTitleDetails: vi.fn().mockResolvedValue(horrorTvDetail),
      embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    });

    const result = await ensureRequestCoverage(db, 'scary thrillers', 'tv', mockConfig, deps);

    // The horror series should be in the DB
    const saved = getTitleByTmdbId(db, 87108);
    expect(saved).not.toBeNull();
    expect(saved!.title).toBe('The Terror');
    expect(result.added).toBeGreaterThanOrEqual(1);
    expect(result.errors).toHaveLength(0);
  });

  it('bumps the request_added usage counter after ingestion', async () => {
    const db = createTestDb();
    const deps = makeDeps({
      searchKeyword: vi.fn().mockResolvedValue([{ id: 315058, name: 'horror' }]),
      discoverTitles: vi.fn().mockImplementation(async (opts) => {
        if (opts.keywordIds?.includes(315058)) return [horrorTvTitle];
        return [];
      }),
      getTitleDetails: vi.fn().mockResolvedValue(horrorTvDetail),
    });

    const today = new Date().toISOString().slice(0, 10);
    await ensureRequestCoverage(db, 'scary thrillers', 'tv', mockConfig, deps);

    const usage = getUsage(db, today);
    expect(usage.request_added).toBeGreaterThanOrEqual(1);
  });

  it('skips a title already in the DB (no duplicate ingest)', async () => {
    const db = createTestDb();

    // Pre-seed the title
    db.prepare(`
      INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, updated_at)
      VALUES (87108, 'tv', 'The Terror', 2018, '[]', '[]', '[]', null, null, datetime('now'))
    `).run();

    const deps = makeDeps({
      searchKeyword: vi.fn().mockResolvedValue([{ id: 315058, name: 'horror' }]),
      discoverTitles: vi.fn().mockResolvedValue([horrorTvTitle]),
      getTitleDetails: vi.fn().mockResolvedValue(horrorTvDetail),
    });

    const result = await ensureRequestCoverage(db, 'scary thrillers', 'tv', mockConfig, deps);

    // Title was already in DB — getTitleDetails should NOT have been called
    expect(vi.mocked(deps.getTitleDetails)).not.toHaveBeenCalled();
    expect(result.added).toBe(0);
  });
});

// ── ensureRequestCoverage — budget enforcement ────────────────────────────────

describe('ensureRequestCoverage — daily budget', () => {
  it('returns added:0 and makes no TMDB calls when budget is already exhausted', async () => {
    const db = createTestDb();
    const today = new Date().toISOString().slice(0, 10);

    // Pre-exhaust the budget
    bumpRequestAdded(db, today, mockConfig.requestLookupDailyBudget);

    const deps = makeDeps({
      discoverTitles: vi.fn().mockResolvedValue([horrorTvTitle]),
      getTitleDetails: vi.fn().mockResolvedValue(horrorTvDetail),
    });

    const result = await ensureRequestCoverage(db, 'scary thrillers', 'tv', mockConfig, deps);

    expect(result.added).toBe(0);
    // No TMDB detail calls when budget is 0
    expect(vi.mocked(deps.getTitleDetails)).not.toHaveBeenCalled();
  });

  it('stops ingesting once the remaining budget is reached mid-run', async () => {
    const db = createTestDb();

    // Budget of only 1 title
    const tinyBudgetConfig: Config = { ...mockConfig, requestLookupDailyBudget: 1 };

    // Return 3 discovery results
    const titles: TmdbTitle[] = [
      { ...horrorTvTitle, id: 1001 },
      { ...horrorTvTitle, id: 1002 },
      { ...horrorTvTitle, id: 1003 },
    ];
    const makeDetail = (id: number): TmdbTitleDetail => ({
      ...horrorTvDetail,
      id,
      name: `Horror Show ${id}`,
    });

    const deps = makeDeps({
      searchKeyword: vi.fn().mockResolvedValue([{ id: 315058, name: 'horror' }]),
      discoverTitles: vi.fn().mockImplementation(async (opts) => {
        if (opts.keywordIds?.includes(315058)) return titles;
        return [];
      }),
      getTitleDetails: vi.fn().mockImplementation(async (id) => makeDetail(id as number)),
    });

    const result = await ensureRequestCoverage(db, 'scary thrillers', 'tv', tinyBudgetConfig, deps);

    // Should have added exactly 1 (the budget limit)
    expect(result.added).toBe(1);
  });
});

// ── ensureRequestCoverage — both media types ─────────────────────────────────

describe('ensureRequestCoverage — both media types', () => {
  it('searches both movie and tv when mediaType is undefined', async () => {
    const db = createTestDb();

    const deps = makeDeps({
      discoverTitles: vi.fn().mockResolvedValue([]),
      searchTitles: vi.fn().mockResolvedValue([]),
    });

    await ensureRequestCoverage(db, 'scary thrillers', undefined, mockConfig, deps);

    // searchTitles should have been called for both movie and tv
    const searchCalls = vi.mocked(deps.searchTitles).mock.calls.map((c) => c[1]);
    expect(searchCalls).toContain('movie');
    expect(searchCalls).toContain('tv');
  });

  it('only searches tv when mediaType is tv', async () => {
    const db = createTestDb();

    const deps = makeDeps({
      discoverTitles: vi.fn().mockResolvedValue([]),
      searchTitles: vi.fn().mockResolvedValue([]),
    });

    await ensureRequestCoverage(db, 'scary thrillers', 'tv', mockConfig, deps);

    const searchCalls = vi.mocked(deps.searchTitles).mock.calls.map((c) => c[1]);
    expect(searchCalls).not.toContain('movie');
    expect(searchCalls).toContain('tv');
  });
});
