import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import {
  applyCachedImdbRatings,
  imdbRatingsPath,
  syncImdbGenres,
  syncImdbRatings,
  IMDB_BASICS_URL,
  IMDB_RATINGS_URL,
} from './dataset.js';

const RATINGS_TSV = [
  'tconst\taverageRating\tnumVotes',
  'tt0000001\t7.4\t2500',
  'tt0000002\t10\t12',
  'tt0000003\t6.1\t800',
  'tt9999999\t5.0\t40',
].join('\n') + '\n';

const BASICS_TSV = [
  'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres',
  'tt0000001\tmovie\tOne\tOne\t0\t2020\t\\N\t100\tCrime,Drama,Thriller',
  'tt0000002\ttvSeries\tTwo\tTwo\t0\t2021\t\\N\t45\tSci-Fi',
  'tt0000003\tmovie\tThree\tThree\t0\t2022\t\\N\t90\t\\N',
  'tt8888888\tmovie\tElse\tElse\t0\t2022\t\\N\t90\tComedy',
].join('\n') + '\n';

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertTitle(
  db: InstanceType<typeof Database>,
  tmdbId: number,
  imdbId: string | null,
  imdbRating: string | null = null,
): number {
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
  return (db.prepare('SELECT id FROM titles WHERE tmdb_id = ?').get(tmdbId) as { id: number }).id;
}

function ratingsRow(db: InstanceType<typeof Database>, tmdbId: number) {
  return db
    .prepare('SELECT imdb_rating, imdb_votes, imdb_synced_at FROM titles WHERE tmdb_id = ?')
    .get(tmdbId) as { imdb_rating: string | null; imdb_votes: number | null; imdb_synced_at: number | null };
}

function gzResponse(text: string, headers: Record<string, string> = {}): Response {
  return new Response(gzipSync(Buffer.from(text)), { status: 200, headers });
}

describe('IMDb ratings file', () => {
  let dir: string;
  let config: { dbPath: string };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tastebuds-imdb-'));
    config = { dbPath: join(dir, 'tastebuds.db') };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('makes every rating match the file, clears titles it does not list, and stamps them all', async () => {
    const db = createTestDb();
    insertTitle(db, 1, 'tt0000001', '6.9');
    insertTitle(db, 2, 'tt0000002');
    insertTitle(db, 3, 'tt0000004', '8.0');
    insertTitle(db, 4, null, '5.5');
    const fetchMock = vi.fn().mockResolvedValue(gzResponse(RATINGS_TSV, { etag: '"v1"' }));

    const result = await syncImdbRatings(db, config, fetchMock as unknown as typeof fetch);

    expect(result).toEqual({ updated: 2, cleared: 1, checked: 3, unchanged: false });
    expect(ratingsRow(db, 1)).toMatchObject({ imdb_rating: '7.4', imdb_votes: 2500 });
    expect(ratingsRow(db, 2)).toMatchObject({ imdb_rating: '10.0', imdb_votes: 12 });
    expect(ratingsRow(db, 3)).toMatchObject({ imdb_rating: null, imdb_votes: null });
    expect(ratingsRow(db, 3).imdb_synced_at).not.toBeNull();
    expect(ratingsRow(db, 4)).toEqual({ imdb_rating: '5.5', imdb_votes: null, imdb_synced_at: null });
    expect(fetchMock).toHaveBeenCalledWith(IMDB_RATINGS_URL, expect.anything());
  });

  it('keeps the file beside the database and names itself without contact details', async () => {
    const db = createTestDb();
    const fetchMock = vi.fn().mockResolvedValue(gzResponse(RATINGS_TSV, { etag: '"v1"' }));

    await syncImdbRatings(db, config, fetchMock as unknown as typeof fetch);

    const path = imdbRatingsPath(config);
    expect(path).toBe(join(dir, 'imdb', 'title.ratings.tsv.gz'));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(`${path}.etag`, 'utf8')).toBe('"v1"');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/TasteBuds/);
    expect(headers['User-Agent']).not.toMatch(/@/);
    expect(headers['If-None-Match']).toBeUndefined();
  });

  it('counts a title unchanged when its rating and votes already match', async () => {
    const db = createTestDb();
    insertTitle(db, 1, 'tt0000001');
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(gzResponse(RATINGS_TSV)));

    await syncImdbRatings(db, config, fetchMock as unknown as typeof fetch);
    const second = await syncImdbRatings(db, config, fetchMock as unknown as typeof fetch);

    expect(second).toEqual({ updated: 0, cleared: 0, checked: 1, unchanged: false });
  });

  it('sends the stored ETag and, on 304, compares only titles never synced against the file on disk', async () => {
    const db = createTestDb();
    insertTitle(db, 1, 'tt0000001', '1.0');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(gzResponse(RATINGS_TSV, { etag: '"v1"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    await syncImdbRatings(db, config, fetchMock as unknown as typeof fetch);
    db.prepare("UPDATE titles SET imdb_rating = '1.0' WHERE tmdb_id = 1").run();
    insertTitle(db, 2, 'tt0000003');

    const result = await syncImdbRatings(db, config, fetchMock as unknown as typeof fetch);

    expect(result).toEqual({ updated: 1, cleared: 0, checked: 1, unchanged: true });
    const headers = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('"v1"');
    expect(ratingsRow(db, 1).imdb_rating).toBe('1.0');
    expect(ratingsRow(db, 2)).toMatchObject({ imdb_rating: '6.1', imdb_votes: 800 });
  });

  it('keeps the last good file and writes nothing when a download is damaged', async () => {
    const db = createTestDb();
    insertTitle(db, 1, 'tt0000001');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(gzResponse(RATINGS_TSV))
      .mockResolvedValueOnce(new Response('not gzip at all', { status: 200 }));
    await syncImdbRatings(db, config, fetchMock as unknown as typeof fetch);
    const before = readFileSync(imdbRatingsPath(config));
    db.prepare('UPDATE titles SET imdb_synced_at = NULL').run();

    await expect(syncImdbRatings(db, config, fetchMock as unknown as typeof fetch)).rejects.toThrow();

    expect(readFileSync(imdbRatingsPath(config))).toEqual(before);
    expect(ratingsRow(db, 1).imdb_synced_at).toBeNull();
  });

  it('keeps the stored ratings when a well-formed file lists far fewer titles than are rated', async () => {
    const db = createTestDb();
    insertTitle(db, 1, 'tt0000001', '7.4');
    insertTitle(db, 2, 'tt0000002', '9.0');
    insertTitle(db, 3, 'tt0000003', '6.1');
    const headerOnly = gzResponse('tconst\taverageRating\tnumVotes\n');

    await expect(syncImdbRatings(db, config, vi.fn().mockResolvedValueOnce(headerOnly) as unknown as typeof fetch))
      .rejects.toThrow('only 0 of 3 rated titles');

    expect([1, 2, 3].map((id) => ratingsRow(db, id).imdb_rating)).toEqual(['7.4', '9.0', '6.1']);
    expect(existsSync(imdbRatingsPath(config))).toBe(false);
  });

  it('fails on an HTTP error without touching ratings', async () => {
    const db = createTestDb();
    insertTitle(db, 1, 'tt0000001', '6.9');
    const fetchMock = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));

    await expect(syncImdbRatings(db, config, fetchMock as unknown as typeof fetch)).rejects.toThrow('HTTP 503');
    expect(ratingsRow(db, 1)).toMatchObject({ imdb_rating: '6.9', imdb_synced_at: null });
  });

  describe('applyCachedImdbRatings', () => {
    it('returns 0 when there is no file yet', async () => {
      const db = createTestDb();
      const id = insertTitle(db, 1, 'tt0000001');
      expect(await applyCachedImdbRatings(db, config, [id])).toBe(0);
      expect(ratingsRow(db, 1).imdb_synced_at).toBeNull();
    });

    it('rates only the titles asked for, from the file on disk, stamped with the file time', async () => {
      const db = createTestDb();
      const one = insertTitle(db, 1, 'tt0000001');
      const two = insertTitle(db, 2, 'tt0000004', '7.7');
      insertTitle(db, 3, 'tt0000003');
      const path = imdbRatingsPath(config);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, gzipSync(Buffer.from(RATINGS_TSV)));
      utimesSync(path, 1_700_000_000, 1_700_000_000);

      const rated = await applyCachedImdbRatings(db, config, [one, two]);

      expect(rated).toBe(1);
      expect(ratingsRow(db, 1)).toEqual({ imdb_rating: '7.4', imdb_votes: 2500, imdb_synced_at: 1_700_000_000 });
      // Not in the file on disk, which may be a day old: left as it is for the nightly sync to decide.
      expect(ratingsRow(db, 2)).toEqual({ imdb_rating: '7.7', imdb_votes: null, imdb_synced_at: null });
      expect(ratingsRow(db, 3).imdb_synced_at).toBeNull();
    });
  });
});

describe('syncImdbGenres', () => {
  it("stores each catalogue title's IMDb genres as a JSON array and leaves \\N alone", async () => {
    const db = createTestDb();
    insertTitle(db, 1, 'tt0000001');
    insertTitle(db, 2, 'tt0000002');
    insertTitle(db, 3, 'tt0000003');
    insertTitle(db, 4, null);
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(gzResponse(BASICS_TSV)));

    const result = await syncImdbGenres(db, fetchMock as unknown as typeof fetch);

    expect(result).toEqual({ updated: 2 });
    expect(fetchMock).toHaveBeenCalledWith(IMDB_BASICS_URL, expect.anything());
    const rows = db.prepare('SELECT tmdb_id, imdb_genres FROM titles ORDER BY tmdb_id').all();
    expect(rows).toEqual([
      { tmdb_id: 1, imdb_genres: '["Crime","Drama","Thriller"]' },
      { tmdb_id: 2, imdb_genres: '["Sci-Fi"]' },
      { tmdb_id: 3, imdb_genres: null },
      { tmdb_id: 4, imdb_genres: null },
    ]);

    expect(await syncImdbGenres(db, fetchMock as unknown as typeof fetch)).toEqual({ updated: 0 });
  });

  it('fails on an HTTP error', async () => {
    const db = createTestDb();
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    await expect(syncImdbGenres(db, fetchMock as unknown as typeof fetch)).rejects.toThrow('HTTP 500');
  });
});
