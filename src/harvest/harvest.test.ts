import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import { getTitleByTmdbId } from '../db/repos/titles.js';
import { runHarvest } from './harvest.js';
import { keywordIdCache } from './onDemand.js';
import type { Config } from '../config.js';

// Mock TMDB client module — all exports must be listed; onDemand.ts (imported
// transitively by harvest.ts) also uses searchTitles and searchKeyword.
vi.mock('../tmdb/client.js', () => ({
  discoverTitles: vi.fn(),
  getTrendingTitles: vi.fn(),
  getTitleDetails: vi.fn(),
  searchTitles: vi.fn(),
  searchKeyword: vi.fn(),
}));

// Mock Ollama embed module
vi.mock('../ollama/embed.js', () => ({
  embedText: vi.fn(),
}));

import { discoverTitles, getTrendingTitles, getTitleDetails, searchKeyword } from '../tmdb/client.js';
import { embedText } from '../ollama/embed.js';

const mockConfig: Config = {
  tmdbApiKey: 'test-key',
  ollamaUrl: 'http://localhost:11434',
  claudeToken: 'test-token',
  port: 8094,
  dbPath: ':memory:',
  omdbApiKey: undefined,
  harvestDailyTarget: 500,
  requestLookupDailyBudget: 500,
};

const mockTmdbTitle = {
  id: 550,
  title: 'Fight Club',
  release_date: '1999-10-15',
  genre_ids: [18, 53],
  overview: 'An insomniac office worker forms an underground fight club.',
  poster_path: '/fight_club.jpg',
};

const mockTmdbDetail = {
  ...mockTmdbTitle,
  genres: [{ id: 18, name: 'Drama' }, { id: 53, name: 'Thriller' }],
  keywords: { keywords: [{ name: 'fight' }] },
  credits: { cast: [{ name: 'Brad Pitt' }] },
};

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedProfileAndSig(db: InstanceType<typeof Database>) {
  upsertProfile(db, {
    name: 'Alex',
    media_weighting: 0.4,
    is_derived: 0,
    config: '{}',
  });
  upsertTasteSignature(db, {
    profile_id: 1,
    taste_vector: null,
    prefs: JSON.stringify({
      loved_genres: ['Drama', 'Thriller'],
      hated_genres: ['Horror'],
      loved_themes: [],
      hated_themes: [],
      preferred_era: 'any',
      media_weighting: 0.4,
    }),
    refreshed_at: new Date().toISOString(),
  });
}

describe('runHarvest', () => {
  beforeEach(() => {
    vi.mocked(discoverTitles).mockResolvedValue([mockTmdbTitle]);
    vi.mocked(getTrendingTitles).mockResolvedValue([]);
    vi.mocked(getTitleDetails).mockResolvedValue(mockTmdbDetail);
    vi.mocked(embedText).mockResolvedValue([0.1, 0.2, 0.3]);
    // Default: searchKeyword returns a plausible keyword result so resolveKeywordId
    // succeeds without errors. Tests that need specific keyword-id behaviour override
    // this mock themselves. Harvest calls searchKeyword for any TV keyword-only genre
    // (Horror, Thriller) in the profile's loved_genres.
    vi.mocked(searchKeyword).mockResolvedValue([{ id: 99999, name: 'mock-keyword' }]);
    // Clear the in-process keyword id cache so each test starts from a clean slate
    // (otherwise a resolved "horror" id from a prior test would skip the mock call).
    keywordIdCache.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    keywordIdCache.clear();
  });

  it('happy path — upserts titles and returns titlesAdded > 0', async () => {
    const db = createTestDb();
    seedProfileAndSig(db);

    const result = await runHarvest(db, mockConfig);

    expect(result.titlesAdded).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);

    const saved = getTitleByTmdbId(db, 550);
    expect(saved).not.toBeNull();
    expect(saved!.title).toBe('Fight Club');
    expect(saved!.embedding).not.toBeNull();
  });

  it('skips titles already in watch_events for the profile', async () => {
    const db = createTestDb();
    seedProfileAndSig(db);

    // First harvest to insert the title
    await runHarvest(db, mockConfig);

    const title = getTitleByTmdbId(db, 550)!;
    upsertWatchEvent(db, {
      profile_id: 1,
      title_id: title.id,
      status: 'watched',
      rating: 4,
      watched_at: new Date().toISOString(),
    });

    // Reset mock call count
    vi.clearAllMocks();
    vi.mocked(discoverTitles).mockResolvedValue([mockTmdbTitle]);
    vi.mocked(getTrendingTitles).mockResolvedValue([]);
    vi.mocked(getTitleDetails).mockResolvedValue(mockTmdbDetail);
    vi.mocked(embedText).mockResolvedValue([0.1, 0.2, 0.3]);

    const result = await runHarvest(db, mockConfig);

    // embedText should NOT be called for the already-watched title
    expect(vi.mocked(embedText)).not.toHaveBeenCalled();
    expect(result.titlesAdded).toBe(0);
  });

  it('handles TMDB fetch error gracefully — returns error in errors array', async () => {
    const db = createTestDb();
    seedProfileAndSig(db);

    vi.mocked(discoverTitles).mockRejectedValue(new Error('TMDB rate limit exceeded'));
    vi.mocked(getTrendingTitles).mockRejectedValue(new Error('TMDB rate limit exceeded'));

    const result = await runHarvest(db, mockConfig);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('TMDB'))).toBe(true);
    expect(result.titlesAdded).toBe(0);
  });

  it('handles embedText error gracefully — records error, continues', async () => {
    const db = createTestDb();
    seedProfileAndSig(db);

    vi.mocked(embedText).mockRejectedValue(new Error('Ollama connection refused'));

    const result = await runHarvest(db, mockConfig);

    expect(result.errors.some((e) => e.includes('Ollama') || e.includes('embed'))).toBe(true);
  });

  it('issues TV keyword discovery for a profile that loves Horror, ingests the returned series', async () => {
    // Seed a profile that loves Horror (a keyword-only TV genre — no TMDB TV genre id
    // exists for Horror, so discovery must go through keyword search).
    const db = createTestDb();
    upsertProfile(db, { name: 'Alex', media_weighting: 0.4, is_derived: 0, config: '{}' });
    upsertTasteSignature(db, {
      profile_id: 1,
      taste_vector: null,
      prefs: JSON.stringify({
        loved_genres: ['Horror'],
        hated_genres: [],
        loved_themes: [],
        hated_themes: [],
        preferred_era: 'any',
        media_weighting: 0.4,
      }),
      refreshed_at: new Date().toISOString(),
    });

    // A horror TV series returned by the keyword discover path
    const horrorSeries = {
      id: 87108,
      name: 'The Terror',
      first_air_date: '2018-03-26',
      genre_ids: [9648, 18],
      overview: 'A crew trapped in the Arctic is stalked by a supernatural monster.',
      poster_path: '/terror.jpg',
    };
    const horrorSeriesDetail = {
      ...horrorSeries,
      title: undefined,
      genres: [{ id: 9648, name: 'Mystery' }, { id: 18, name: 'Drama' }],
      keywords: { results: [{ name: 'horror' }, { name: 'survival' }] },
      credits: { cast: [{ name: 'Jared Harris' }] },
    };

    // searchKeyword resolves "horror" → TMDB keyword id 315058
    vi.mocked(searchKeyword).mockResolvedValue([{ id: 315058, name: 'horror' }]);

    // discoverTitles: keyword path returns the horror series; all other calls return empty
    vi.mocked(discoverTitles).mockImplementation(async (opts) => {
      if (opts.mediaType === 'tv' && opts.keywordIds?.includes(315058)) {
        return [horrorSeries];
      }
      return [];
    });
    vi.mocked(getTrendingTitles).mockResolvedValue([]);
    vi.mocked(getTitleDetails).mockResolvedValue(horrorSeriesDetail);
    vi.mocked(embedText).mockResolvedValue([0.1, 0.2, 0.3]);

    const result = await runHarvest(db, mockConfig);

    // searchKeyword must have been called to resolve "horror" to a keyword id
    expect(vi.mocked(searchKeyword)).toHaveBeenCalledWith('horror', expect.anything());

    // discoverTitles must have been called with keywordIds for TV
    const keywordCall = vi.mocked(discoverTitles).mock.calls.find(
      ([opts]) => opts.mediaType === 'tv' && opts.keywordIds?.includes(315058),
    );
    expect(keywordCall).toBeDefined();

    // The horror series should be in the DB
    const saved = getTitleByTmdbId(db, 87108);
    expect(saved).not.toBeNull();
    expect(saved!.title).toBe('The Terror');
    expect(result.titlesAdded).toBeGreaterThanOrEqual(1);
    expect(result.errors).toHaveLength(0);
  });
});
