import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTitle, getTitleByTmdbId } from '../db/repos/titles.js';
import { importFromSeedJson, toAppRating } from './importWatchHistory.js';
import type { Config } from '../config.js';
import type { SeedItem } from './parseSeedFile.js';

describe('toAppRating (0–10 seed scale → 1–5 app scale)', () => {
  it('maps boundaries and clamps', () => {
    expect(toAppRating(10)).toBe(5);
    expect(toAppRating(9.5)).toBe(5); // round(4.75)
    expect(toAppRating(8)).toBe(4);
    expect(toAppRating(5)).toBe(3); // round(2.5) → 3
    expect(toAppRating(2)).toBe(1);
    expect(toAppRating(0)).toBe(1); // clamped up to min 1
    expect(toAppRating(11)).toBe(5); // clamped down to max 5
  });
});

// Mock TMDB client module
vi.mock('../tmdb/client.js', () => ({
  searchTitles: vi.fn(),
  getTitleDetails: vi.fn(),
  discoverTitles: vi.fn(),
  getTrendingTitles: vi.fn(),
}));

// Mock Ollama embed module
vi.mock('../ollama/embed.js', () => ({
  embedText: vi.fn(),
}));

// Mock refreshTasteVector so it doesn't need a real DB or embedding
vi.mock('../retrieval/retrieve.js', () => ({
  refreshTasteVector: vi.fn().mockResolvedValue(undefined),
}));

import { searchTitles, getTitleDetails } from '../tmdb/client.js';
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
  harvestMaxPage: 30,
};

const mockTmdbSearchResult = {
  id: 550,
  title: 'Fight Club',
  release_date: '1999-10-15',
  genre_ids: [18, 53],
  overview: 'An insomniac office worker forms an underground fight club.',
  poster_path: '/fight_club.jpg',
};

const mockTmdbDetail = {
  ...mockTmdbSearchResult,
  genres: [{ id: 18, name: 'Drama' }, { id: 53, name: 'Thriller' }],
  keywords: { keywords: [{ name: 'fight' }] },
  credits: { cast: [{ name: 'Brad Pitt' }] },
};

const mockTvSearchResult = {
  id: 1396,
  name: 'Breaking Bad',
  first_air_date: '2008-01-20',
  genre_ids: [18, 80],
  overview: 'A chemistry teacher becomes a drug kingpin.',
  poster_path: '/breaking_bad.jpg',
};

const mockTvDetail = {
  ...mockTvSearchResult,
  genres: [{ id: 18, name: 'Drama' }, { id: 80, name: 'Crime' }],
  keywords: { results: [{ name: 'drugs' }] },
  credits: { cast: [{ name: 'Bryan Cranston' }] },
};

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedProfiles(db: InstanceType<typeof Database>) {
  upsertProfile(db, { name: 'Alex', media_weighting: 0.4, is_derived: 0, config: '{}' });
  upsertProfile(db, { name: 'Sam', media_weighting: 0.4, is_derived: 0, config: '{}' });
  upsertProfile(db, { name: 'Joint', media_weighting: 0.5, is_derived: 1, config: '{}' });
}

describe('importFromSeedJson', () => {
  beforeEach(() => {
    vi.mocked(embedText).mockResolvedValue([0.1, 0.2, 0.3]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('(a) item already in local titles — links without searching', () => {
    it('links watch_event without calling searchTitles', async () => {
      const db = createTestDb();
      seedProfiles(db);

      // Pre-insert the title
      upsertTitle(db, {
        tmdb_id: 550,
        media_type: 'movie',
        title: 'Fight Club',
        year: 1999,
        genres: '["Drama","Thriller"]',
        keywords: '["fight"]',
        cast: '["Brad Pitt"]',
        synopsis: 'An insomniac office worker.',
        poster_path: '/fight_club.jpg',
        embedding: null,
        updated_at: new Date().toISOString(),
      });

      const seedItems: SeedItem[] = [
        { title: 'Fight Club', year: 1999, mediaType: 'movie', rating: 5, status: 'watched', profile: 'alex' },
      ];

      const result = await importFromSeedJson(db, mockConfig, seedItems);

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.notFound).toHaveLength(0);
      expect(result.resolved).toBe(0);
      expect(vi.mocked(searchTitles)).not.toHaveBeenCalled();
    });
  });

  describe('(b) item missing locally but found via search — ingests and links', () => {
    it('calls searchTitles, upserts title, links watch_event, increments resolved', async () => {
      const db = createTestDb();
      seedProfiles(db);

      vi.mocked(searchTitles).mockResolvedValueOnce([mockTmdbSearchResult]);
      vi.mocked(getTitleDetails).mockResolvedValueOnce(mockTmdbDetail);

      const seedItems: SeedItem[] = [
        { title: 'Fight Club', year: 1999, mediaType: 'movie', rating: 5, status: 'watched', profile: 'alex' },
      ];

      const result = await importFromSeedJson(db, mockConfig, seedItems);

      expect(result.imported).toBe(1);
      expect(result.resolved).toBe(1);
      expect(result.notFound).toHaveLength(0);
      expect(vi.mocked(searchTitles)).toHaveBeenCalledWith('Fight Club', 'movie', mockConfig, 1999);
      expect(vi.mocked(getTitleDetails)).toHaveBeenCalledWith(550, 'movie', mockConfig);

      // Title should now be in the DB
      const saved = getTitleByTmdbId(db, 550);
      expect(saved).not.toBeNull();
      expect(saved!.title).toBe('Fight Club');
    });

    it('picks result matching item year when multiple results returned', async () => {
      const db = createTestDb();
      seedProfiles(db);

      const wrongYear = { ...mockTmdbSearchResult, id: 9999, release_date: '2005-01-01' };
      const rightYear = { ...mockTmdbSearchResult, id: 550, release_date: '1999-10-15' };
      vi.mocked(searchTitles).mockResolvedValueOnce([wrongYear, rightYear]);
      vi.mocked(getTitleDetails).mockResolvedValueOnce(mockTmdbDetail);

      const seedItems: SeedItem[] = [
        { title: 'Fight Club', year: 1999, mediaType: 'movie', rating: 4, status: 'watched', profile: 'alex' },
      ];

      await importFromSeedJson(db, mockConfig, seedItems);

      // Should have picked tmdb_id 550 (year 1999 matches)
      expect(vi.mocked(getTitleDetails)).toHaveBeenCalledWith(550, 'movie', mockConfig);
    });

    it('skips re-fetching detail if tmdb_id already in titles table', async () => {
      const db = createTestDb();
      seedProfiles(db);

      // Pre-insert the title by tmdb_id (different title text to ensure local lookup by title fails)
      upsertTitle(db, {
        tmdb_id: 550,
        media_type: 'movie',
        title: 'Fight Club (alt)',
        year: 1999,
        genres: '[]',
        keywords: '[]',
        cast: '[]',
        synopsis: null,
        poster_path: null,
        embedding: null,
        updated_at: new Date().toISOString(),
      });

      vi.mocked(searchTitles).mockResolvedValueOnce([mockTmdbSearchResult]);
      // getTitleDetails should NOT be called since tmdb_id 550 is already in DB

      const seedItems: SeedItem[] = [
        { title: 'Fight Club', year: 1999, mediaType: 'movie', status: 'watched', profile: 'alex' },
      ];

      const result = await importFromSeedJson(db, mockConfig, seedItems);

      expect(vi.mocked(getTitleDetails)).not.toHaveBeenCalled();
      expect(result.imported).toBe(1);
      // resolved should be 0 since we didn't need to ingest a new title
      expect(result.resolved).toBe(0);
    });
  });

  describe('(c) search returns nothing — goes to notFound', () => {
    it('pushes to notFound when searchTitles returns empty array', async () => {
      const db = createTestDb();
      seedProfiles(db);

      vi.mocked(searchTitles).mockResolvedValueOnce([]);

      const seedItems: SeedItem[] = [
        { title: 'Obscure Film Nobody Made', year: 2099, mediaType: 'movie', status: 'watched', profile: 'alex' },
      ];

      const result = await importFromSeedJson(db, mockConfig, seedItems);

      expect(result.imported).toBe(0);
      expect(result.notFound).toHaveLength(1);
      expect(result.notFound[0]).toContain('Obscure Film Nobody Made');
      expect(result.resolved).toBe(0);
    });
  });

  describe('(d) embed failure — title ingested with null embedding, import continues', () => {
    it('still upserts title and links watch_event when embedText throws', async () => {
      const db = createTestDb();
      seedProfiles(db);

      vi.mocked(searchTitles).mockResolvedValueOnce([mockTvSearchResult]);
      vi.mocked(getTitleDetails).mockResolvedValueOnce(mockTvDetail);
      vi.mocked(embedText).mockRejectedValueOnce(new Error('Ollama connection refused'));

      const seedItems: SeedItem[] = [
        { title: 'Breaking Bad', year: 2008, mediaType: 'tv', rating: 5, status: 'watched', profile: 'alex' },
      ];

      const result = await importFromSeedJson(db, mockConfig, seedItems);

      // Import should not be aborted
      expect(result.imported).toBe(1);
      expect(result.resolved).toBe(1);
      expect(result.notFound).toHaveLength(0);

      // Title should exist in DB but with null embedding
      const saved = getTitleByTmdbId(db, 1396);
      expect(saved).not.toBeNull();
      expect(saved!.embedding).toBeNull();
    });
  });

  describe('ImportResult shape', () => {
    it('includes resolved field in result', async () => {
      const db = createTestDb();
      seedProfiles(db);

      const result = await importFromSeedJson(db, mockConfig, []);

      expect(result).toHaveProperty('imported');
      expect(result).toHaveProperty('skipped');
      expect(result).toHaveProperty('notFound');
      expect(result).toHaveProperty('resolved');
      expect(result.resolved).toBe(0);
    });
  });
});
