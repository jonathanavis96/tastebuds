import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import { getTitleByTmdbId } from '../db/repos/titles.js';
import { runHarvest } from './harvest.js';
import type { Config } from '../config.js';

// Mock TMDB client module
vi.mock('../tmdb/client.js', () => ({
  discoverTitles: vi.fn(),
  getTrendingTitles: vi.fn(),
  getTitleDetails: vi.fn(),
}));

// Mock Ollama embed module
vi.mock('../ollama/embed.js', () => ({
  embedText: vi.fn(),
}));

import { discoverTitles, getTrendingTitles, getTitleDetails } from '../tmdb/client.js';
import { embedText } from '../ollama/embed.js';

const mockConfig: Config = {
  tmdbApiKey: 'test-key',
  ollamaUrl: 'http://localhost:11434',
  claudeToken: 'test-token',
  port: 8094,
  dbPath: ':memory:',
  omdbApiKey: undefined,
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
  });

  afterEach(() => {
    vi.clearAllMocks();
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
});
