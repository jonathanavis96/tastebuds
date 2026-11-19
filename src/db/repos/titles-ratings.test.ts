import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import {
  applyImdbGenres,
  applyImdbRatings,
  fillTitleImdbGenres,
  getTitleByTmdbId,
  markTitleImdbIdChecked,
  setTitleRtFromPage,
  updateTitleRatings,
  upsertTitle,
} from './titles.js';

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

const base = {
  tmdb_id: 7,
  media_type: 'movie' as const,
  title: 'Title 7',
  year: 2026,
  genres: '[]',
  keywords: '[]',
  cast: '[]',
  synopsis: null,
  poster_path: null,
  embedding: null,
  updated_at: '2026-11-19T00:00:00.000Z',
};

function insert(db: InstanceType<typeof Database>): number {
  upsertTitle(db, { ...base, imdb_id: 'tt0000007' });
  return getTitleByTmdbId(db, 7, 'movie')!.id;
}

describe('title rating writes', () => {
  it('upsertTitle keeps the rating-source columns on conflict', () => {
    const db = createTestDb();
    const id = insert(db);
    db.prepare(
      `UPDATE titles SET imdb_votes = 900, imdb_synced_at = 1, imdb_genres = '["Drama"]', imdb_id_checked_at = 2, rt_verified_at = 3 WHERE id = ?`,
    ).run(id);

    upsertTitle(db, { ...base, title: 'Title 7 renamed', updated_at: '2026-11-20T00:00:00.000Z' });

    expect(getTitleByTmdbId(db, 7, 'movie')).toMatchObject({
      title: 'Title 7 renamed',
      imdb_votes: 900,
      imdb_synced_at: 1,
      imdb_genres: '["Drama"]',
      imdb_id_checked_at: 2,
      rt_verified_at: 3,
    });
  });

  it('updateTitleRatings leaves a file-confirmed IMDb rating and a page-verified RT score alone', () => {
    const db = createTestDb();
    const id = insert(db);
    applyImdbRatings(db, [{ id, rating: '7.4', votes: 1200 }], 100);
    setTitleRtFromPage(db, id, { url: 'https://rt.test/7', score: '91%' });

    updateTitleRatings(db, id, { imdb: '6.0', rt: '50%' });

    expect(getTitleByTmdbId(db, 7, 'movie')).toMatchObject({ imdb_rating: '7.4', rt_rating: '91%' });
    expect(getTitleByTmdbId(db, 7, 'movie')!.rating_checked_at).not.toBeNull();
  });

  it('updateTitleRatings writes both when neither source has confirmed them', () => {
    const db = createTestDb();
    const id = insert(db);
    updateTitleRatings(db, id, { imdb: '6.0', rt: '50%' });
    expect(getTitleByTmdbId(db, 7, 'movie')).toMatchObject({ imdb_rating: '6.0', rt_rating: '50%' });
  });

  it('applyImdbRatings writes, clears and stamps', () => {
    const db = createTestDb();
    const id = insert(db);
    applyImdbRatings(db, [{ id, rating: '8.1', votes: 5000 }], 100);
    expect(getTitleByTmdbId(db, 7, 'movie')).toMatchObject({ imdb_rating: '8.1', imdb_votes: 5000, imdb_synced_at: 100 });
    applyImdbRatings(db, [{ id, rating: null, votes: null }], 200);
    expect(getTitleByTmdbId(db, 7, 'movie')).toMatchObject({ imdb_rating: null, imdb_votes: null, imdb_synced_at: 200 });
  });

  it('fillTitleImdbGenres fills only an empty column; applyImdbGenres replaces', () => {
    const db = createTestDb();
    const id = insert(db);
    fillTitleImdbGenres(db, id, ['Crime', 'Drama']);
    fillTitleImdbGenres(db, id, ['Comedy']);
    expect(getTitleByTmdbId(db, 7, 'movie')!.imdb_genres).toBe('["Crime","Drama"]');
    applyImdbGenres(db, [{ id, genres: '["Thriller"]' }]);
    expect(getTitleByTmdbId(db, 7, 'movie')!.imdb_genres).toBe('["Thriller"]');
  });

  it('markTitleImdbIdChecked stores a found id and never erases one', () => {
    const db = createTestDb();
    upsertTitle(db, base);
    const id = getTitleByTmdbId(db, 7, 'movie')!.id;
    markTitleImdbIdChecked(db, id, 'tt0000007');
    markTitleImdbIdChecked(db, id, null);
    const row = getTitleByTmdbId(db, 7, 'movie')!;
    expect(row.imdb_id).toBe('tt0000007');
    expect(row.imdb_id_checked_at).not.toBeNull();
  });

  it('setTitleRtFromPage saves the page URL and score, or clears the score', () => {
    const db = createTestDb();
    const id = insert(db);
    setTitleRtFromPage(db, id, { url: 'https://rt.test/7', score: '88%' });
    expect(getTitleByTmdbId(db, 7, 'movie')).toMatchObject({ rt_url: 'https://rt.test/7', rt_rating: '88%' });
    setTitleRtFromPage(db, id, { url: 'https://rt.test/7', score: null });
    const row = getTitleByTmdbId(db, 7, 'movie')!;
    expect(row.rt_rating).toBeNull();
    expect(row.rt_verified_at).not.toBeNull();
    expect(row.rt_checked_at).not.toBeNull();
  });
});
