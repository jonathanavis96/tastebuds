import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import type { Config } from '../config.js';
import type { TmdbFindResult, TmdbTitleDetail } from '../tmdb/types.js';
import { imdbRatingsPath } from './dataset.js';
import { fillImdbGaps, GAP_RECHECK_DAYS, type GapFillDeps } from './gapFill.js';

const NOW = new Date('2026-11-20T12:00:00Z');

const RATINGS_TSV = [
  'tconst\taverageRating\tnumVotes',
  'tt0000001\t7.8\t25000', // English film, 2023: added
  'tt0000002\t8.1\t9000', // Korean series: language
  'tt0000003\t7.0\t4000', // not on TMDB
  'tt0000004\t7.5\t90000', // 2012 film: before the window, never asked about
  'tt0000005\t7.2\t800', // film under 1,000 votes: never asked about
  'tt0000006\t6.4\t700', // series, 500+ votes: asked about, already stored without an IMDb id
  'tt0000007\t5.1\t50000', // under the 6.0 floor: never asked about
  'tt0000008\t8.0\t3000', // an episode: never asked about
  'tt0000009\t7.9\t60000', // in the catalogue already: never asked about
].join('\n') + '\n';

const BASICS_TSV = [
  'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres',
  'tt0000001\tmovie\tOne\tOne\t0\t2023\t\\N\t100\tDrama,Thriller',
  'tt0000002\ttvSeries\tTwo\tTwo\t0\t2024\t\\N\t60\tCrime,Drama',
  'tt0000003\tmovie\tThree\tThree\t0\t2022\t\\N\t90\tComedy',
  'tt0000004\tmovie\tFour\tFour\t0\t2012\t\\N\t90\tDrama',
  'tt0000005\tmovie\tFive\tFive\t0\t2022\t\\N\t90\tDrama',
  'tt0000006\ttvMiniSeries\tSix\tSix\t0\t2025\t2025\t50\tMystery',
  'tt0000007\tmovie\tSeven\tSeven\t0\t2022\t\\N\t90\tDrama',
  'tt0000008\ttvEpisode\tEight\tEight\t0\t2022\t\\N\t50\tDrama',
  'tt0000009\tmovie\tNine\tNine\t0\t2021\t\\N\t110\tAction',
].join('\n') + '\n';

const FOUND: Record<string, TmdbFindResult> = {
  tt0000001: { movie_results: [{ id: 101, original_language: 'en' }], tv_results: [] },
  tt0000002: { movie_results: [], tv_results: [{ id: 102, original_language: 'ko' }] },
  tt0000003: { movie_results: [], tv_results: [] },
  tt0000006: { movie_results: [], tv_results: [{ id: 106, original_language: 'en' }] },
};

function detail(id: number): TmdbTitleDetail {
  return {
    id,
    title: `Film ${id}`,
    release_date: '2023-05-01',
    genre_ids: [],
    genres: [{ id: 18, name: 'Drama' }],
    overview: 'A film.',
    poster_path: null,
    original_language: 'en',
    runtime: 100,
    vote_average: 7.4,
    vote_count: 900,
    status: 'Released',
    external_ids: { imdb_id: null },
  };
}

function store(db: InstanceType<typeof Database>, tmdbId: number, mediaType: 'movie' | 'tv', imdbId: string | null): void {
  upsertTitle(db, {
    tmdb_id: tmdbId,
    media_type: mediaType,
    title: `Stored ${tmdbId}`,
    year: 2025,
    genres: '[]',
    keywords: '[]',
    cast: '[]',
    synopsis: null,
    poster_path: null,
    embedding: null,
    updated_at: new Date().toISOString(),
    imdb_id: imdbId,
  });
}

describe('fillImdbGaps', () => {
  let dir: string;
  let config: Config;
  let db: InstanceType<typeof Database>;
  let deps: GapFillDeps & { findByImdbId: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'tastebuds-gaps-'));
    config = { dbPath: join(dir, 'tastebuds.db'), tmdbApiKey: 'k', ollamaUrl: 'http://ollama' } as Config;
    const path = imdbRatingsPath(config);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, gzipSync(Buffer.from(RATINGS_TSV)));
    db = new Database(':memory:');
    runMigrations(db);
    store(db, 106, 'tv', null);
    store(db, 109, 'movie', 'tt0000009');
    deps = {
      fetchImpl: vi.fn().mockImplementation(async () => new Response(gzipSync(Buffer.from(BASICS_TSV)))),
      findByImdbId: vi.fn().mockImplementation(async (imdbId: string) => FOUND[imdbId]),
      getTitleDetails: vi.fn().mockImplementation(async (id: number) => detail(id)),
      embedText: vi.fn().mockResolvedValue([0.1, 0.2]),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('adds the uncatalogued titles in the window, at the floors, in a household language', async () => {
    const result = await fillImdbGaps(db, config, { now: NOW, deps });

    expect(result.candidates).toBe(4);
    expect(result.outcomes).toEqual({ added: 1, 'language:ko': 1, 'not-on-tmdb': 1, 'in-catalogue': 1 });
    expect(deps.findByImdbId.mock.calls.map((c) => c[0]).sort()).toEqual(['tt0000001', 'tt0000002', 'tt0000003', 'tt0000006']);

    const added = db.prepare('SELECT imdb_id, imdb_rating, imdb_votes, imdb_genres, embedding IS NOT NULL AS embedded FROM titles WHERE tmdb_id = 101').get();
    expect(added).toEqual({ imdb_id: 'tt0000001', imdb_rating: '7.8', imdb_votes: 25000, imdb_genres: '["Drama","Thriller"]', embedded: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM titles WHERE tmdb_id = 102').get()).toEqual({ n: 0 });
  });

  it('links an IMDb id to a stored title that lacked one, and rates it', async () => {
    await fillImdbGaps(db, config, { now: NOW, deps });

    expect(db.prepare('SELECT imdb_id, imdb_rating FROM titles WHERE tmdb_id = 106').get()).toEqual({ imdb_id: 'tt0000006', imdb_rating: '6.4' });
  });

  it('does not ask about an id again until its check is GAP_RECHECK_DAYS old', async () => {
    await fillImdbGaps(db, config, { now: NOW, deps });
    deps.findByImdbId.mockClear();

    await fillImdbGaps(db, config, { now: new Date(NOW.getTime() + (GAP_RECHECK_DAYS - 1) * 86_400_000), deps });
    expect(deps.findByImdbId).not.toHaveBeenCalled();

    await fillImdbGaps(db, config, { now: new Date(NOW.getTime() + (GAP_RECHECK_DAYS + 1) * 86_400_000), deps });
    expect(deps.findByImdbId.mock.calls.map((c) => c[0]).sort()).toEqual(['tt0000002', 'tt0000003']);
  });

  it('records no check for a lookup that failed, so the next run tries again', async () => {
    deps.findByImdbId.mockImplementation(async () => { throw new Error('TMDB request failed with HTTP 429'); });

    const result = await fillImdbGaps(db, config, { now: NOW, deps });

    expect(result.outcomes).toEqual({ error: 4 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM imdb_gap_checks').get()).toEqual({ n: 0 });
  });

  it('looks up the most-voted titles first, at most cap of them', async () => {
    const result = await fillImdbGaps(db, config, { now: NOW, deps, cap: 2 });

    expect(result.candidates).toBe(4);
    expect(deps.findByImdbId.mock.calls.map((c) => c[0]).sort()).toEqual(['tt0000001', 'tt0000002']);
  });
});
