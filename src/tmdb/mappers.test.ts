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

  it('maps original_language through to the row', () => {
    const row = mapTmdbToTitleRow({ ...baseDetail, original_language: 'en' }, 'movie');
    expect(row.original_language).toBe('en');
  });

  it('maps missing original_language to null', () => {
    const row = mapTmdbToTitleRow(baseDetail, 'movie');
    expect(row.original_language).toBeNull();
  });

  it('maps movie runtime to runtime_minutes', () => {
    const row = mapTmdbToTitleRow({ ...baseDetail, runtime: 118 }, 'movie');
    expect(row.runtime_minutes).toBe(118);
  });

  it('maps movie runtime of 0 to null', () => {
    const row = mapTmdbToTitleRow({ ...baseDetail, runtime: 0 }, 'movie');
    expect(row.runtime_minutes).toBeNull();
  });

  it('maps missing movie runtime to null', () => {
    const row = mapTmdbToTitleRow(baseDetail, 'movie');
    expect(row.runtime_minutes).toBeNull();
  });

  it('maps tv episode_run_time to the first positive entry', () => {
    const row = mapTmdbToTitleRow({ ...baseDetail, episode_run_time: [0, 45, 50] }, 'tv');
    expect(row.runtime_minutes).toBe(45);
  });

  it('maps tv episode_run_time with all zero/empty entries to null', () => {
    const row = mapTmdbToTitleRow({ ...baseDetail, episode_run_time: [0, 0] }, 'tv');
    expect(row.runtime_minutes).toBeNull();
  });

  it('maps missing tv episode_run_time to null', () => {
    const row = mapTmdbToTitleRow(baseDetail, 'tv');
    expect(row.runtime_minutes).toBeNull();
  });

  it('maps vote_average through to the row', () => {
    const row = mapTmdbToTitleRow({ ...baseDetail, vote_average: 7.2 }, 'movie');
    expect(row.vote_average).toBeCloseTo(7.2);
  });

  it('maps missing vote_average to null', () => {
    const row = mapTmdbToTitleRow(baseDetail, 'movie');
    expect(row.vote_average).toBeNull();
  });

  it('maps status through to the row', () => {
    const row = mapTmdbToTitleRow({ ...baseDetail, status: 'Released' }, 'movie');
    expect(row.status).toBe('Released');
  });

  it('maps missing status to null', () => {
    const row = mapTmdbToTitleRow(baseDetail, 'movie');
    expect(row.status).toBeNull();
  });

  it('stamps meta_checked_at with current unix seconds', () => {
    const before = Math.floor(Date.now() / 1000);
    const row = mapTmdbToTitleRow(baseDetail, 'movie');
    const after = Math.floor(Date.now() / 1000);
    expect(row.meta_checked_at).not.toBeNull();
    expect(row.meta_checked_at!).toBeGreaterThanOrEqual(before);
    expect(row.meta_checked_at!).toBeLessThanOrEqual(after);
  });
});
