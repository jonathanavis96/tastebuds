import { describe, it, expect } from 'vitest';
import { mapTmdbToTitleRow } from './mappers.js';
import type { TmdbTitleDetail } from './types.js';

const baseDetail: TmdbTitleDetail = {
  id: 42,
  title: 'Test Film',
  release_date: '2021-05-01',
  genre_ids: [],
  genres: [{ id: 28, name: 'Action' }],
  overview: 'A test overview.',
  poster_path: '/poster.jpg',
  popularity: 87.6,
  vote_count: 3200,
};

describe('mapTmdbToTitleRow', () => {
  it('maps basic fields correctly', () => {
    const row = mapTmdbToTitleRow(baseDetail, 'movie');
    expect(row.tmdb_id).toBe(42);
    expect(row.title).toBe('Test Film');
    expect(row.year).toBe(2021);
    expect(row.media_type).toBe('movie');
  });

  it('carries popularity and vote_count through to the row', () => {
    const row = mapTmdbToTitleRow(baseDetail, 'movie');
    expect(row.popularity).toBeCloseTo(87.6);
    expect(row.vote_count).toBe(3200);
  });

  it('maps missing popularity to null', () => {
    const { popularity: _p, ...rest } = baseDetail;
    const row = mapTmdbToTitleRow(rest as TmdbTitleDetail, 'movie');
    expect(row.popularity).toBeNull();
  });

  it('maps missing vote_count to null', () => {
    const { vote_count: _vc, ...rest } = baseDetail;
    const row = mapTmdbToTitleRow(rest as TmdbTitleDetail, 'movie');
    expect(row.vote_count).toBeNull();
  });

  it('maps both missing popularity and vote_count to null', () => {
    const { popularity: _p, vote_count: _vc, ...rest } = baseDetail;
    const row = mapTmdbToTitleRow(rest as TmdbTitleDetail, 'movie');
    expect(row.popularity).toBeNull();
    expect(row.vote_count).toBeNull();
  });
});
