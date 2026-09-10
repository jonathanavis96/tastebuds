import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle, getTitleById, getTitleByTmdbId } from '../db/repos/titles.js';
import { backfillTitleMeta } from './backfillMeta.js';
import type { TmdbTitleDetail } from '../tmdb/types.js';

const mockConfig = { tmdbApiKey: 'test-key' };

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  try {
    sqliteVec.load(db);
  } catch {
    // vec extension not required for these tests
  }
  runMigrations(db);
  return db;
}

function insertTitle(
  db: InstanceType<typeof Database>,
  {
    tmdbId,
    mediaType = 'movie',
    voteCount = null,
  }: { tmdbId: number; mediaType?: 'movie' | 'tv'; voteCount?: number | null },
): void {
  upsertTitle(db, {
    tmdb_id: tmdbId,
    media_type: mediaType,
    title: `Title ${tmdbId}`,
    year: 2020,
    genres: '[]',
    keywords: '[]',
    cast: '[]',
    synopsis: null,
    poster_path: null,
    embedding: null,
    updated_at: new Date().toISOString(),
    vote_count: voteCount,
  });
}

function baseDetail(overrides: Partial<TmdbTitleDetail> = {}): TmdbTitleDetail {
  return {
    id: 1,
    genre_ids: [],
    genres: [],
    overview: '',
    poster_path: null,
    original_language: 'en',
    runtime: 100,
    vote_average: 7.5,
    status: 'Released',
    popularity: 42,
    vote_count: 1000,
    ...overrides,
  };
}

describe('backfillTitleMeta', () => {
  it('fills original_language, runtime_minutes, vote_average, status and stamps meta_checked_at', async () => {
    const db = createTestDb();
    insertTitle(db, { tmdbId: 1 });
    const title = getTitleByTmdbId(db, 1)!;

    const fetchDetail = vi.fn().mockResolvedValue(baseDetail());
    const before = Math.floor(Date.now() / 1000);
    const result = await backfillTitleMeta(db, mockConfig, { cap: 10, concurrency: 1, fetchDetail });
    const after = Math.floor(Date.now() / 1000);

    expect(result).toEqual({ processed: 1, missing: 0, errors: 0 });
    const updated = getTitleById(db, title.id)!;
    expect(updated.original_language).toBe('en');
    expect(updated.runtime_minutes).toBe(100);
    expect(updated.vote_average).toBeCloseTo(7.5);
    expect(updated.status).toBe('Released');
    expect(updated.meta_checked_at).not.toBeNull();
    expect(updated.meta_checked_at!).toBeGreaterThanOrEqual(before);
    expect(updated.meta_checked_at!).toBeLessThanOrEqual(after);
  });

  it('maps tv episode_run_time to the first positive entry', async () => {
    const db = createTestDb();
    insertTitle(db, { tmdbId: 2, mediaType: 'tv' });
    const title = getTitleByTmdbId(db, 2)!;

    const fetchDetail = vi.fn().mockResolvedValue(
      baseDetail({ runtime: undefined, episode_run_time: [0, 42, 50] }),
    );
    await backfillTitleMeta(db, mockConfig, { cap: 10, concurrency: 1, fetchDetail });

    const updated = getTitleById(db, title.id)!;
    expect(updated.runtime_minutes).toBe(42);
  });

  it('a 404 counts as missing and stamps status=Missing + meta_checked_at', async () => {
    const db = createTestDb();
    insertTitle(db, { tmdbId: 3 });
    const title = getTitleByTmdbId(db, 3)!;

    const fetchDetail = vi.fn().mockRejectedValue(new Error('TMDB request failed with HTTP 404: not found'));
    const result = await backfillTitleMeta(db, mockConfig, { cap: 10, concurrency: 1, fetchDetail });

    expect(result).toEqual({ processed: 0, missing: 1, errors: 0 });
    const updated = getTitleById(db, title.id)!;
    expect(updated.status).toBe('Missing');
    expect(updated.meta_checked_at).not.toBeNull();
  });

  it('a non-404 error counts as errors and does NOT stamp meta_checked_at', async () => {
    const db = createTestDb();
    insertTitle(db, { tmdbId: 4 });
    const title = getTitleByTmdbId(db, 4)!;

    const fetchDetail = vi.fn().mockRejectedValue(new Error('network error'));
    const result = await backfillTitleMeta(db, mockConfig, { cap: 10, concurrency: 1, fetchDetail });

    expect(result).toEqual({ processed: 0, missing: 0, errors: 1 });
    const updated = getTitleById(db, title.id)!;
    expect(updated.meta_checked_at).toBeNull();
    expect(updated.status).toBeNull();
  });

  it('respects the cap', async () => {
    const db = createTestDb();
    for (let i = 1; i <= 5; i++) {
      insertTitle(db, { tmdbId: i });
    }
    const fetchDetail = vi.fn().mockResolvedValue(baseDetail());

    const result = await backfillTitleMeta(db, mockConfig, { cap: 2, concurrency: 1, fetchDetail });

    expect(result.processed).toBe(2);
    expect(fetchDetail).toHaveBeenCalledTimes(2);
  });

  it('orders candidates with non-null vote_count before null, then vote_count DESC', async () => {
    const db = createTestDb();
    // A: null vote_count (never harvested with popularity cols)
    insertTitle(db, { tmdbId: 10, voteCount: null });
    // B: high vote_count
    insertTitle(db, { tmdbId: 11, voteCount: 9000 });
    // C: low vote_count
    insertTitle(db, { tmdbId: 12, voteCount: 100 });

    const fetchDetail = vi.fn().mockResolvedValue(baseDetail());
    await backfillTitleMeta(db, mockConfig, { cap: 3, concurrency: 1, fetchDetail });

    const calledIds = fetchDetail.mock.calls.map((c) => c[0]);
    // (vote_count IS NULL) ASC puts non-null rows (0) before null rows (1);
    // among non-null rows, vote_count DESC → B (9000) then C (100); A (null) last.
    expect(calledIds).toEqual([11, 12, 10]);
  });

  it('does not overwrite popularity/vote_count when the response omits them', async () => {
    const db = createTestDb();
    insertTitle(db, { tmdbId: 20, voteCount: 500 });
    const title = getTitleByTmdbId(db, 20)!;

    const fetchDetail = vi.fn().mockResolvedValue(
      baseDetail({ popularity: undefined, vote_count: undefined }),
    );
    await backfillTitleMeta(db, mockConfig, { cap: 10, concurrency: 1, fetchDetail });

    const updated = getTitleById(db, title.id)!;
    expect(updated.vote_count).toBe(500);
  });
});
