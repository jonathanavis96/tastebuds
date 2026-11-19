import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { imdbRatingsPath } from '../imdb/dataset.js';
import { ensureFreshRatings } from './freshness.js';

const DAY = 24 * 60 * 60;
const NOW = Math.floor(Date.now() / 1000);
const THIS_YEAR = new Date().getUTCFullYear();
const ELEMENTARY = 'https://www.rottentomatoes.com/tv/elementary';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../rt/fixtures/${name}.html`, import.meta.url)), 'utf8');
}

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

interface Seed {
  title?: string;
  year?: number;
  imdbId?: string | null;
  imdbRating?: string | null;
  imdbSyncedAt?: number | null;
  rtUrl?: string | null;
  rtRating?: string | null;
  rtVerifiedAt?: number | null;
  rtCheckedAt?: number | null;
}

let nextTmdbId = 1;
function insertTitle(db: InstanceType<typeof Database>, seed: Seed): number {
  const tmdbId = nextTmdbId++;
  upsertTitle(db, {
    tmdb_id: tmdbId,
    media_type: 'tv',
    title: seed.title ?? 'Elementary',
    year: seed.year ?? 2012,
    genres: '[]',
    keywords: '[]',
    cast: '[]',
    synopsis: null,
    poster_path: null,
    embedding: null,
    updated_at: new Date().toISOString(),
    imdb_id: seed.imdbId ?? null,
    imdb_rating: seed.imdbRating ?? null,
  });
  db.prepare(
    'UPDATE titles SET imdb_synced_at = ?, rt_url = ?, rt_rating = ?, rt_verified_at = ?, rt_checked_at = ? WHERE tmdb_id = ?',
  ).run(seed.imdbSyncedAt ?? null, seed.rtUrl ?? null, seed.rtRating ?? null, seed.rtVerifiedAt ?? null, seed.rtCheckedAt ?? null, tmdbId);
  return (db.prepare('SELECT id FROM titles WHERE tmdb_id = ?').get(tmdbId) as { id: number }).id;
}

function row(db: InstanceType<typeof Database>, id: number) {
  return db.prepare('SELECT imdb_rating, imdb_votes, imdb_synced_at, rt_url, rt_rating, rt_verified_at FROM titles WHERE id = ?').get(id) as {
    imdb_rating: string | null;
    imdb_votes: number | null;
    imdb_synced_at: number | null;
    rt_url: string | null;
    rt_rating: string | null;
    rt_verified_at: number | null;
  };
}

function pageFetch(pages: Record<string, string>) {
  return vi.fn(async (url: string | URL | Request) => {
    const body = pages[String(url)];
    return { status: body ? 200 : 404, url: String(url), text: async () => body ?? '' } as Response;
  });
}

describe('ensureFreshRatings', () => {
  let dir: string;
  let config: { dbPath: string; omdbApiKey: undefined };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tastebuds-fresh-'));
    config = { dbPath: join(dir, 'tastebuds.db'), omdbApiKey: undefined };
    const path = imdbRatingsPath(config);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, gzipSync('tconst\taverageRating\tnumVotes\ntt0000001\t7.9\t4200\ntt0000002\t6.0\t900\n'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-reads IMDb from the file on disk only for titles not synced within 36 hours', async () => {
    const db = createTestDb();
    const stale = insertTitle(db, { imdbId: 'tt0000001', imdbRating: '7.0', imdbSyncedAt: NOW - 2 * DAY, rtVerifiedAt: NOW });
    const fresh = insertTitle(db, { imdbId: 'tt0000002', imdbRating: '5.0', imdbSyncedAt: NOW - 3600, rtVerifiedAt: NOW });

    await ensureFreshRatings(db, [stale, fresh], config, pageFetch({}));

    expect(row(db, stale)).toMatchObject({ imdb_rating: '7.9', imdb_votes: 4200 });
    expect(row(db, fresh).imdb_rating).toBe('5.0');
  });

  it("reads Rotten Tomatoes from the title's own page when never verified", async () => {
    const db = createTestDb();
    const id = insertTitle(db, { rtUrl: ELEMENTARY, rtRating: '80%' });
    const fetchImpl = pageFetch({ [ELEMENTARY]: fixture('tv_elementary') });

    await ensureFreshRatings(db, [id], config, fetchImpl);

    expect(row(db, id)).toMatchObject({ rt_rating: '96%', rt_url: ELEMENTARY });
    expect(row(db, id).rt_verified_at).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-reads a recent release after 7 days and an older title only after 60', async () => {
    const db = createTestDb();
    const recent = insertTitle(db, { title: 'Recent', year: THIS_YEAR - 1, rtUrl: 'https://rt.test/recent', rtVerifiedAt: NOW - 8 * DAY });
    const olderDue = insertTitle(db, { title: 'Older Due', year: 2010, rtUrl: 'https://rt.test/older-due', rtVerifiedAt: NOW - 61 * DAY });
    const olderFresh = insertTitle(db, { title: 'Older Fresh', year: 2010, rtUrl: 'https://rt.test/older-fresh', rtVerifiedAt: NOW - 30 * DAY });
    const recentFresh = insertTitle(db, { title: 'Recent Fresh', year: THIS_YEAR, rtUrl: 'https://rt.test/recent-fresh', rtVerifiedAt: NOW - 2 * DAY });
    const fetchImpl = pageFetch({});

    await ensureFreshRatings(db, [recent, olderDue, olderFresh, recentFresh], config, fetchImpl);

    const storedPagesRead = fetchImpl.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('https://rt.test/'));
    expect(storedPagesRead.sort()).toEqual(['https://rt.test/older-due', 'https://rt.test/recent']);
  });

  it('finds the page when none is stored, and keeps what a title has when its page cannot be confirmed', async () => {
    const db = createTestDb();
    const found = insertTitle(db, {});
    const unconfirmed = insertTitle(db, { title: 'Happy Valley', year: 2014, rtUrl: ELEMENTARY, rtRating: '91%' });
    const fetchImpl = pageFetch({ [ELEMENTARY]: fixture('tv_elementary') });

    await ensureFreshRatings(db, [found, unconfirmed], config, fetchImpl);

    expect(row(db, found)).toMatchObject({ rt_url: ELEMENTARY, rt_rating: '96%' });
    expect(row(db, unconfirmed)).toMatchObject({ rt_url: ELEMENTARY, rt_rating: '91%', rt_verified_at: null });
  });

  it("looks for the title's own page when the stored one is another title", async () => {
    const db = createTestDb();
    const id = insertTitle(db, { title: 'Happy Valley', year: 2014, rtUrl: ELEMENTARY, rtRating: '91%' });
    const ownPage = 'https://www.rottentomatoes.com/tv/happy_valley';
    const fetchImpl = pageFetch({ [ELEMENTARY]: fixture('tv_elementary'), [ownPage]: fixture('tv_happy_valley') });

    await ensureFreshRatings(db, [id], config, fetchImpl);

    expect(row(db, id)).toMatchObject({ rt_url: ownPage, rt_rating: '98%' });
  });

  it('does not look for a page again soon after none was found', async () => {
    const db = createTestDb();
    const id = insertTitle(db, { title: 'Nowhere', year: 2010 });
    const stale = insertTitle(db, { title: 'Wrong Page', year: 2010, rtUrl: ELEMENTARY, rtCheckedAt: NOW - DAY });
    const fetchImpl = pageFetch({});

    await ensureFreshRatings(db, [id, stale], config, fetchImpl);
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://www.rottentomatoes.com/tv/nowhere',
      'https://www.rottentomatoes.com/tv/nowhere_2010',
    ]);

    fetchImpl.mockClear();
    await ensureFreshRatings(db, [id, stale], config, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('puts a limit on each page and returns by the overall limit when a page never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const db = createTestDb();
    const id = insertTitle(db, { rtUrl: ELEMENTARY, rtRating: '80%' });
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));

    let done = false;
    const run = ensureFreshRatings(db, [id], config, fetchImpl as unknown as typeof fetch).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(7_900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await run;

    expect(done).toBe(true);
    expect(((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(row(db, id).rt_rating).toBe('80%');
  });

  it('never throws', async () => {
    const db = createTestDb();
    const id = insertTitle(db, {});
    db.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(ensureFreshRatings(db, [id], config, pageFetch({}))).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
