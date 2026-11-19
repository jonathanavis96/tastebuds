import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { refreshRtScores } from './refresh.js';

const DAY = 24 * 60 * 60;

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}.html`, import.meta.url)), 'utf8');
}

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertTitle(
  db: InstanceType<typeof Database>,
  tmdbId: number,
  title: string,
  year: number,
  rt: { url: string | null; rating?: string | null; verifiedAt?: number | null; checkedAt?: number | null },
): void {
  upsertTitle(db, {
    tmdb_id: tmdbId,
    media_type: 'tv',
    title,
    year,
    genres: '[]',
    keywords: '[]',
    cast: '[]',
    synopsis: null,
    poster_path: null,
    embedding: null,
    updated_at: new Date().toISOString(),
  });
  db.prepare('UPDATE titles SET rt_url = ?, rt_rating = ?, rt_verified_at = ?, rt_checked_at = ? WHERE tmdb_id = ?').run(
    rt.url,
    rt.rating ?? null,
    rt.verifiedAt ?? null,
    rt.checkedAt ?? null,
    tmdbId,
  );
}

function rtRow(db: InstanceType<typeof Database>, tmdbId: number) {
  return db.prepare('SELECT rt_url, rt_rating, rt_verified_at, rt_checked_at FROM titles WHERE tmdb_id = ?').get(tmdbId) as {
    rt_url: string | null;
    rt_rating: string | null;
    rt_verified_at: number | null;
    rt_checked_at: number | null;
  };
}

/** Serves each URL's page; anything else is a 404. */
function siteFetch(pages: Record<string, { status?: number; body?: string }>) {
  return vi.fn(async (url: string | URL | Request) => {
    const page = pages[String(url)];
    return {
      status: page ? page.status ?? 200 : 404,
      url: String(url),
      text: async () => page?.body ?? '',
    } as Response;
  });
}

const ELEMENTARY = 'https://www.rottentomatoes.com/tv/elementary';
const HAPPY_VALLEY = 'https://www.rottentomatoes.com/tv/happy_valley';

describe('refreshRtScores', () => {
  it("saves each page's own score and stamps it verified", async () => {
    const db = createTestDb();
    insertTitle(db, 1, 'Elementary', 2012, { url: ELEMENTARY, rating: '80%' });
    insertTitle(db, 2, 'Happy Valley', 2014, { url: HAPPY_VALLEY });
    const fetchImpl = siteFetch({ [ELEMENTARY]: { body: fixture('tv_elementary') }, [HAPPY_VALLEY]: { body: fixture('tv_happy_valley') } });

    const result = await refreshRtScores(db, { cap: 10, fetchImpl, pauseMs: 0 });

    expect(result).toEqual({ verified: 2, noScore: 0, unconfirmed: 0, failed: 0, blocked: false });
    expect(rtRow(db, 1)).toMatchObject({ rt_rating: '96%', rt_url: ELEMENTARY });
    expect(rtRow(db, 2).rt_rating).toBe('98%');
    expect(rtRow(db, 1).rt_verified_at).not.toBeNull();
  });

  it('clears the score of a confirmed page that shows none', async () => {
    const db = createTestDb();
    insertTitle(db, 1, 'Elementary', 2012, { url: ELEMENTARY, rating: '80%' });
    const body = fixture('tv_elementary')
      .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '')
      .replace(/<script\s+id="media-scorecard-json"[\s\S]*?<\/script>/, '');

    const result = await refreshRtScores(db, { cap: 10, fetchImpl: siteFetch({ [ELEMENTARY]: { body } }), pauseMs: 0 });

    expect(result.noScore).toBe(1);
    expect(rtRow(db, 1).rt_rating).toBeNull();
    expect(rtRow(db, 1).rt_verified_at).not.toBeNull();
  });

  it('keeps what a title has when its page is gone or is another title, and waits a week to retry', async () => {
    const db = createTestDb();
    insertTitle(db, 1, 'Relay', 2025, { url: 'https://www.rottentomatoes.com/m/relay_2025', rating: '71%' });
    insertTitle(db, 2, 'Elementary', 2012, { url: HAPPY_VALLEY, rating: '50%' });
    const fetchImpl = siteFetch({ [HAPPY_VALLEY]: { body: fixture('tv_happy_valley') } });

    const result = await refreshRtScores(db, { cap: 10, fetchImpl, pauseMs: 0 });

    expect(result).toMatchObject({ verified: 0, unconfirmed: 2 });
    expect(rtRow(db, 1)).toMatchObject({ rt_rating: '71%', rt_verified_at: null });
    expect(rtRow(db, 2)).toMatchObject({ rt_rating: '50%', rt_verified_at: null });
    expect(rtRow(db, 1).rt_checked_at).not.toBeNull();

    fetchImpl.mockClear();
    await refreshRtScores(db, { cap: 10, fetchImpl, pauseMs: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads never-verified titles first, then the oldest verified, up to the cap', async () => {
    const db = createTestDb();
    const now = Math.floor(Date.now() / 1000);
    insertTitle(db, 1, 'Verified Old', 2010, { url: 'https://rt.test/old', verifiedAt: now - 90 * DAY });
    insertTitle(db, 2, 'Verified New', 2010, { url: 'https://rt.test/new', verifiedAt: now - 1 * DAY });
    insertTitle(db, 3, 'Never', 2010, { url: 'https://rt.test/never' });
    insertTitle(db, 4, 'Tried Before', 2010, { url: 'https://rt.test/tried', checkedAt: now - 30 * DAY });
    insertTitle(db, 5, 'No Page', 2010, { url: null });
    const fetchImpl = siteFetch({});

    await refreshRtScores(db, { cap: 3, fetchImpl, pauseMs: 0 });

    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://rt.test/never',
      'https://rt.test/tried',
      'https://rt.test/old',
    ]);
  });

  it('stops after five failures in a row and leaves those titles untouched', async () => {
    const db = createTestDb();
    for (let i = 1; i <= 8; i++) insertTitle(db, i, `Title ${i}`, 2020, { url: `https://rt.test/${i}`, rating: '70%' });
    const fetchImpl = vi.fn().mockResolvedValue({ status: 403, url: '', text: async () => '' } as Response);

    const result = await refreshRtScores(db, { cap: 10, fetchImpl, pauseMs: 0 });

    expect(result).toMatchObject({ failed: 5, blocked: true });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(rtRow(db, 1)).toMatchObject({ rt_rating: '70%', rt_checked_at: null });
  });

  it('waits between pages', async () => {
    const db = createTestDb();
    insertTitle(db, 1, 'A', 2020, { url: 'https://rt.test/a' });
    insertTitle(db, 2, 'B', 2020, { url: 'https://rt.test/b' });
    const fetchImpl = siteFetch({});
    const started = Date.now();

    await refreshRtScores(db, { cap: 10, fetchImpl, pauseMs: 40 });

    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });
});

describe('refreshRtScores order among titles never tried', () => {
  it('reads the newest released titles first and unreleased ones last', async () => {
    const db = createTestDb();
    const thisYear = new Date().getUTCFullYear();
    insertTitle(db, 1, 'Older Show', thisYear - 14, { url: 'https://www.rottentomatoes.com/tv/older_show' });
    insertTitle(db, 2, 'Unreleased Show', thisYear + 2, { url: 'https://www.rottentomatoes.com/tv/unreleased_show' });
    insertTitle(db, 3, 'Newer Show', thisYear, { url: 'https://www.rottentomatoes.com/tv/newer_show' });
    const asked: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      asked.push(String(url).replace('https://www.rottentomatoes.com/tv/', ''));
      return new Response('', { status: 404 });
    }) as typeof fetch;

    await refreshRtScores(db, { cap: 3, fetchImpl, pauseMs: 0 });

    expect(asked).toEqual(['newer_show', 'older_show', 'unreleased_show']);
  });
});

