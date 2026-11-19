import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import type { TmdbTitleDetail } from '../tmdb/types.js';
import { fillMissingImdbIds } from './fillIds.js';

const config = { tmdbApiKey: 'test-key' };
const DAY = 24 * 60 * 60;

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertTitle(
  db: InstanceType<typeof Database>,
  tmdbId: number,
  opts: { imdbId?: string | null; mediaType?: 'movie' | 'tv'; checkedAt?: number | null } = {},
): void {
  upsertTitle(db, {
    tmdb_id: tmdbId,
    media_type: opts.mediaType ?? 'movie',
    title: `Title ${tmdbId}`,
    year: 2026,
    genres: '[]',
    keywords: '[]',
    cast: '[]',
    synopsis: null,
    poster_path: null,
    embedding: null,
    updated_at: new Date().toISOString(),
    imdb_id: opts.imdbId ?? null,
  });
  if (opts.checkedAt != null) {
    db.prepare('UPDATE titles SET imdb_id_checked_at = ? WHERE tmdb_id = ?').run(opts.checkedAt, tmdbId);
  }
}

function detail(overrides: Partial<TmdbTitleDetail>): TmdbTitleDetail {
  return { id: 1, genre_ids: [], genres: [], overview: '', poster_path: null, ...overrides };
}

function row(db: InstanceType<typeof Database>, tmdbId: number) {
  return db.prepare('SELECT imdb_id, imdb_id_checked_at FROM titles WHERE tmdb_id = ?').get(tmdbId) as {
    imdb_id: string | null;
    imdb_id_checked_at: number | null;
  };
}

describe('fillMissingImdbIds', () => {
  it('stores the id from a film or a series and stamps every answered title', async () => {
    const db = createTestDb();
    insertTitle(db, 1);
    insertTitle(db, 2, { mediaType: 'tv' });
    insertTitle(db, 3);
    const fetchDetail = vi.fn(async (tmdbId: number) => {
      if (tmdbId === 1) return detail({ imdb_id: 'tt0000001' });
      if (tmdbId === 2) return detail({ external_ids: { imdb_id: 'tt0000002' } });
      return detail({ imdb_id: '' });
    });

    const result = await fillMissingImdbIds(db, config, { cap: 10, fetchDetail });

    expect(result).toEqual({ checked: 3, found: 2, errors: 0 });
    expect(row(db, 1).imdb_id).toBe('tt0000001');
    expect(row(db, 2).imdb_id).toBe('tt0000002');
    expect(row(db, 3)).toMatchObject({ imdb_id: null });
    expect(row(db, 3).imdb_id_checked_at).not.toBeNull();
    expect(fetchDetail).toHaveBeenCalledWith(2, 'tv', config);
  });

  it('asks again only after 14 days and never asks about a title that has an id', async () => {
    const db = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    insertTitle(db, 1, { checkedAt: now - 3 * DAY });
    insertTitle(db, 2, { checkedAt: now - 15 * DAY });
    insertTitle(db, 3, { imdbId: 'tt0000003' });
    const fetchDetail = vi.fn().mockResolvedValue(detail({}));

    await fillMissingImdbIds(db, config, { cap: 10, fetchDetail });

    expect(fetchDetail.mock.calls.map((c) => c[0])).toEqual([2]);
  });

  it('asks about never-checked titles first and stops at the cap', async () => {
    const db = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    insertTitle(db, 1, { checkedAt: now - 20 * DAY });
    insertTitle(db, 2);
    const fetchDetail = vi.fn().mockResolvedValue(detail({}));

    await fillMissingImdbIds(db, config, { cap: 1, fetchDetail });

    expect(fetchDetail.mock.calls.map((c) => c[0])).toEqual([2]);
  });

  it('stamps a title TMDB no longer has, and leaves a failed request for the next run', async () => {
    const db = createTestDb();
    insertTitle(db, 1);
    insertTitle(db, 2);
    const fetchDetail = vi.fn(async (tmdbId: number) => {
      throw new Error(tmdbId === 1 ? 'TMDB request failed with HTTP 404: gone' : 'TMDB request failed with HTTP 500: oops');
    });

    const result = await fillMissingImdbIds(db, config, { cap: 10, fetchDetail });

    expect(result).toEqual({ checked: 1, found: 0, errors: 1 });
    expect(row(db, 1).imdb_id_checked_at).not.toBeNull();
    expect(row(db, 2).imdb_id_checked_at).toBeNull();
  });

  it('keeps to about 20 requests a second', async () => {
    const db = createTestDb();
    for (let i = 1; i <= 5; i++) insertTitle(db, i);
    const starts: number[] = [];
    const fetchDetail = vi.fn(async () => {
      starts.push(Date.now());
      return detail({});
    });

    await fillMissingImdbIds(db, config, { cap: 10, fetchDetail });

    expect(starts[starts.length - 1] - starts[0]).toBeGreaterThanOrEqual(4 * 50 - 5);
  });
});
