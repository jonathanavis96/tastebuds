/**
 * TDD tests for harvest budget enforcement.
 *
 * Verifies that runHarvest stops ingesting new titles once harvestDailyTarget
 * new titles have been added for the day.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import { getUsage } from '../db/repos/apiUsage.js';
import { runHarvest } from './harvest.js';
import type { Config } from '../config.js';

// Mock TMDB client — all exports must be listed; onDemand.ts (imported
// transitively by harvest.ts) also uses searchTitles and searchKeyword.
vi.mock('../tmdb/client.js', () => ({
  discoverTitles: vi.fn(),
  getTrendingTitles: vi.fn(),
  getTitleDetails: vi.fn(),
  searchTitles: vi.fn(),
  searchKeyword: vi.fn(),
}));

vi.mock('../ollama/embed.js', () => ({
  embedText: vi.fn(),
}));

import { discoverTitles, getTrendingTitles, getTitleDetails, searchKeyword } from '../tmdb/client.js';
import { embedText } from '../ollama/embed.js';
import { keywordIdCache } from './onDemand.js';

// A tight budget config — only 2 new titles allowed per day
const tinyBudgetConfig: Config = {
  tmdbApiKey: 'test-key',
  ollamaUrl: 'http://localhost:11434',
  claudeToken: 'test-token',
  port: 8094,
  dbPath: ':memory:',
  omdbApiKey: undefined,
  harvestDailyTarget: 2,
  requestLookupDailyBudget: 500,
  harvestMaxPage: 30,
};

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedProfile(db: InstanceType<typeof Database>) {
  upsertProfile(db, { name: 'Alex', media_weighting: 0.4, is_derived: 0, config: '{}' });
  upsertTasteSignature(db, {
    profile_id: 1,
    taste_vector: null,
    prefs: JSON.stringify({ loved_genres: ['Drama'] }),
    refreshed_at: new Date().toISOString(),
  });
}

/** Build a fake TmdbTitle stub for the given numeric id. */
function makeFakeTitle(id: number) {
  return {
    id,
    title: `Movie ${id}`,
    release_date: '2020-01-01',
    genre_ids: [18],
    overview: `Synopsis for movie ${id}`,
    poster_path: null,
  };
}

/** Build a fake TmdbTitleDetail for the given numeric id. */
function makeFakeDetail(id: number) {
  return {
    ...makeFakeTitle(id),
    genres: [{ id: 18, name: 'Drama' }],
    keywords: { keywords: [] },
    credits: { cast: [] },
  };
}

describe('runHarvest — budget enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: searchKeyword returns empty so keyword-term profiles don't error out.
    // The seeded profile uses 'Drama' (a real TV genre id), so this is only a safety net.
    vi.mocked(searchKeyword).mockResolvedValue([]);
    // Clear the shared in-process keyword id cache between tests
    keywordIdCache.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    keywordIdCache.clear();
  });

  it('ingests at most harvestDailyTarget new titles (budget=2, 5 candidates)', async () => {
    const db = createTestDb();
    seedProfile(db);

    // Provide 5 distinct movie titles and 5 TV titles from discover
    const movieTitles = [1001, 1002, 1003, 1004, 1005].map(makeFakeTitle);
    const tvTitles = [2001, 2002, 2003, 2004, 2005].map((id) => ({
      ...makeFakeTitle(id),
      title: undefined,
      name: `Show ${id}`,
      first_air_date: '2020-01-01',
    }));

    vi.mocked(discoverTitles).mockImplementation(async (opts) => {
      if (opts.mediaType === 'movie') return movieTitles;
      return tvTitles;
    });
    vi.mocked(getTrendingTitles).mockResolvedValue([]);
    vi.mocked(getTitleDetails).mockImplementation(async (id, mediaType) => {
      if (mediaType === 'tv') {
        const tv = tvTitles.find((t) => t.id === id);
        return { ...(tv ?? makeFakeTitle(id)), genres: [], keywords: { results: [] }, credits: { cast: [] } };
      }
      return makeFakeDetail(id as number);
    });
    vi.mocked(embedText).mockResolvedValue([0.1, 0.2, 0.3]);

    const result = await runHarvest(db, tinyBudgetConfig);

    // Budget is 2 — exactly 2 titles should be added
    expect(result.titlesAdded).toBe(2);
    expect(result.errors).toHaveLength(0);

    // The budget counter should be persisted
    const today = new Date().toISOString().slice(0, 10);
    const usage = getUsage(db, today);
    expect(usage.harvest_added).toBe(2);
  });

  it('returns immediately with titlesAdded=0 when today\'s budget is already spent', async () => {
    const db = createTestDb();
    seedProfile(db);

    // Pre-exhaust the budget for today
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO api_usage (day, harvest_added, request_added) VALUES (?, ?, 0)
    `).run(today, tinyBudgetConfig.harvestDailyTarget);

    vi.mocked(discoverTitles).mockResolvedValue([makeFakeTitle(9001)]);
    vi.mocked(getTrendingTitles).mockResolvedValue([]);
    vi.mocked(getTitleDetails).mockResolvedValue(makeFakeDetail(9001));
    vi.mocked(embedText).mockResolvedValue([0.1, 0.2, 0.3]);

    const result = await runHarvest(db, tinyBudgetConfig);

    expect(result.titlesAdded).toBe(0);
    // getTitleDetails must not have been called — we bailed out before processing
    expect(vi.mocked(getTitleDetails)).not.toHaveBeenCalled();
  });
});
