/**
 * Unit tests for backfillRatings.
 * OMDb client and resolveRtUrl are mocked — no network calls made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { backfillRatings } from './backfillRatings.js';

vi.mock('../omdb/client.js', () => ({
  getOmdbRatings: vi.fn(),
}));

vi.mock('../rt/resolve.js', () => ({
  resolveRtUrl: vi.fn(),
}));

import { getOmdbRatings } from '../omdb/client.js';
import { resolveRtUrl } from '../rt/resolve.js';

const mockConfig = { omdbApiKey: 'test-key' };

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertTitle(
  db: InstanceType<typeof Database>,
  { tmdbId, imdbId, imdbRating = null }: { tmdbId: number; imdbId: string | null; imdbRating?: string | null },
): void {
  upsertTitle(db, {
    tmdb_id: tmdbId,
    media_type: 'movie',
    title: `Title ${tmdbId}`,
    year: 2020,
    genres: '[]',
    keywords: '[]',
    cast: '[]',
    synopsis: null,
    poster_path: null,
    embedding: null,
    updated_at: new Date().toISOString(),
    imdb_id: imdbId,
    imdb_rating: imdbRating,
  });
}

describe('backfillRatings', () => {
  beforeEach(() => {
    vi.mocked(getOmdbRatings).mockResolvedValue({ imdb: '8.5', rottenTomatoes: '90%' });
    vi.mocked(resolveRtUrl).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('processes up to dailyCap unrated titles and returns the count', async () => {
    const db = createTestDb();
    for (let i = 1; i <= 5; i++) {
      insertTitle(db, { tmdbId: i, imdbId: `tt000000${i}` });
    }

    const result = await backfillRatings(db, mockConfig, { dailyCap: 3 });

    expect(result.processed).toBe(3);
    expect(vi.mocked(getOmdbRatings)).toHaveBeenCalledTimes(3);
  });

  it('writes imdb_rating to processed titles', async () => {
    const db = createTestDb();
    insertTitle(db, { tmdbId: 1, imdbId: 'tt0000001' });

    await backfillRatings(db, mockConfig, { dailyCap: 1 });

    const row = db
      .prepare('SELECT imdb_rating FROM titles WHERE tmdb_id = 1')
      .get() as { imdb_rating: string | null };
    expect(row.imdb_rating).toBe('8.5');
  });

  it('skips titles that already have imdb_rating set', async () => {
    const db = createTestDb();
    insertTitle(db, { tmdbId: 1, imdbId: 'tt0000001', imdbRating: '7.0' }); // already rated
    insertTitle(db, { tmdbId: 2, imdbId: 'tt0000002' });
    insertTitle(db, { tmdbId: 3, imdbId: 'tt0000003' });

    const result = await backfillRatings(db, mockConfig, { dailyCap: 10 });

    expect(result.processed).toBe(2);
    expect(vi.mocked(getOmdbRatings)).not.toHaveBeenCalledWith('tt0000001', expect.anything());
  });

  it('skips titles without imdb_id', async () => {
    const db = createTestDb();
    insertTitle(db, { tmdbId: 1, imdbId: null }); // no imdb_id → not a candidate
    insertTitle(db, { tmdbId: 2, imdbId: 'tt0000002' });

    const result = await backfillRatings(db, mockConfig, { dailyCap: 10 });

    expect(result.processed).toBe(1);
    expect(vi.mocked(getOmdbRatings)).toHaveBeenCalledTimes(1);
  });

  it('persists verified rt_url and score when OMDb provides no RT rating', async () => {
    const db = createTestDb();
    insertTitle(db, { tmdbId: 1, imdbId: 'tt0000001' });

    vi.mocked(getOmdbRatings).mockResolvedValue({ imdb: '8.5', rottenTomatoes: null });
    vi.mocked(resolveRtUrl).mockResolvedValue({
      url: 'https://www.rottentomatoes.com/m/title_1',
      score: '88%',
      verified: true,
    });

    await backfillRatings(db, mockConfig, { dailyCap: 1 });

    const row = db
      .prepare('SELECT rt_url, rt_rating FROM titles WHERE tmdb_id = 1')
      .get() as { rt_url: string | null; rt_rating: string | null };
    expect(row.rt_url).toBe('https://www.rottentomatoes.com/m/title_1');
    expect(row.rt_rating).toBe('88%');
  });

  it('does NOT persist rt_url when resolveRtUrl returns unverified', async () => {
    const db = createTestDb();
    insertTitle(db, { tmdbId: 1, imdbId: 'tt0000001' });

    vi.mocked(getOmdbRatings).mockResolvedValue({ imdb: '8.5', rottenTomatoes: null });
    vi.mocked(resolveRtUrl).mockResolvedValue({
      url: 'https://www.rottentomatoes.com/search?search=Title+1',
      score: null,
      verified: false,
    });

    await backfillRatings(db, mockConfig, { dailyCap: 1 });

    const row = db
      .prepare('SELECT rt_url FROM titles WHERE tmdb_id = 1')
      .get() as { rt_url: string | null };
    expect(row.rt_url).toBeNull();
  });

  it('does NOT call resolveRtUrl when OMDb provides a RT rating', async () => {
    const db = createTestDb();
    insertTitle(db, { tmdbId: 1, imdbId: 'tt0000001' });

    // OMDb returns RT → resolveRtUrl should be skipped
    vi.mocked(getOmdbRatings).mockResolvedValue({ imdb: '8.5', rottenTomatoes: '90%' });

    await backfillRatings(db, mockConfig, { dailyCap: 1 });

    expect(vi.mocked(resolveRtUrl)).not.toHaveBeenCalled();
  });

  it('skips a failing title and continues processing the rest', async () => {
    const db = createTestDb();
    insertTitle(db, { tmdbId: 1, imdbId: 'tt0000001' });
    insertTitle(db, { tmdbId: 2, imdbId: 'tt0000002' });

    vi.mocked(getOmdbRatings)
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ imdb: '8.5', rottenTomatoes: null });

    const result = await backfillRatings(db, mockConfig, { dailyCap: 10 });

    // First title threw → not counted; second succeeded → counted
    expect(result.processed).toBe(1);
  });

  it('returns processed: 0 when no unrated titles exist', async () => {
    const db = createTestDb();

    const result = await backfillRatings(db, mockConfig, { dailyCap: 100 });

    expect(result.processed).toBe(0);
    expect(vi.mocked(getOmdbRatings)).not.toHaveBeenCalled();
  });
});
