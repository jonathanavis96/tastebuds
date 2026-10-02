import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { mapTmdbToTitleRow } from './mappers.js';
import type { TmdbTitleDetail } from './types.js';

describe('mapTmdbToTitleRow with partial TMDB payloads', () => {
  it('maps a sparse detail (no poster, no genres, no dates) to a row the DB accepts', () => {
    const sparse = { id: 7, name: 'Bare Show' } as unknown as TmdbTitleDetail;
    const row = mapTmdbToTitleRow(sparse, 'tv');
    expect(row.poster_path).toBeNull();
    expect(row.year).toBeNull();
    expect(row.genres).toBe('[]');
    const db = new Database(':memory:');
    runMigrations(db);
    upsertTitle(db, { ...row, embedding: null });
    const got = db.prepare('SELECT title, poster_path FROM titles WHERE tmdb_id = 7').get();
    expect(got).toEqual({ title: 'Bare Show', poster_path: null });
  });

  it('drops genre, keyword and cast entries that have no name instead of storing null', () => {
    const detail = {
      id: 8, title: 'X', release_date: '',
      genres: [{ id: 1, name: 'Drama' }, { id: 2 }],
      keywords: { keywords: [{ id: 1 }, { id: 2, name: 'heist' }] },
      credits: { cast: [{ name: null }, { name: 'Ann' }] },
    } as unknown as TmdbTitleDetail;
    const row = mapTmdbToTitleRow(detail, 'movie');
    expect(JSON.parse(row.genres)).toEqual(['Drama']);
    expect(JSON.parse(row.keywords)).toEqual(['heist']);
    expect(JSON.parse(row.cast)).toEqual(['Ann']);
  });

  it('treats a year of 0000 as unknown', () => {
    const d = { id: 9, title: 'Y', release_date: '0000-01-01' } as unknown as TmdbTitleDetail;
    expect(mapTmdbToTitleRow(d, 'movie').year).toBeNull();
  });
});
