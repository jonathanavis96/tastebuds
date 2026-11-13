import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import { chartGenres, chooseAxes, genreStats, tasteChartForProfile } from './tasteChart.js';

describe('chartGenres', () => {
  it('merges movie and series names and reads series horror from keywords', () => {
    expect(chartGenres('["Sci-Fi & Fantasy","Drama"]', '["supernatural horror"]', 'tv').sort())
      .toEqual(['Drama', 'Horror', 'Sci-Fi']);
    expect(chartGenres('["Science Fiction"]', '["horror"]', 'movie')).toEqual(['Sci-Fi']);
  });
});

describe('chooseAxes', () => {
  it('prefers genres that split likes from dislikes, needs enough titles, and gives up below three', () => {
    const rows = (g: string, ys: number[]) => ys.map(y => ({ genres: JSON.stringify([g]), keywords: '[]', media_type: 'movie', y }));
    const stats = genreStats([
      ...rows('Comedy', [1, 1, 2, 1, 2, 1, 2, 1]),
      ...rows('Horror', [5, 5, 5, 4, 5, 5, 5, 5]),
      ...rows('Drama', [3, 4, 3, 4, 3, 4, 3, 4]),
      ...rows('Western', [5]),
    ]);
    const axes = chooseAxes([stats]);
    expect(axes).toEqual(expect.arrayContaining(['Comedy', 'Horror', 'Drama']));
    expect(axes).not.toContain('Western');
    expect(chooseAxes([genreStats(rows('Comedy', [1, 2, 3]))])).toEqual([]);
  });
});

describe('tasteChartForProfile', () => {
  it('shows one shape for a solo profile and both people plus Together for Joint', () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);
    for (const [name, derived] of [['A', 0], ['B', 0], ['Joint', 1]] as const) {
      upsertProfile(db, { name, media_weighting: 0.5, is_derived: derived, config: '{}' });
    }
    const pid = (n: string) => (db.prepare('SELECT id FROM profiles WHERE name = ?').get(n) as { id: number }).id;
    let tmdb = 1;
    const rate = (profile: string, genre: string, rating: number) => {
      upsertTitle(db, {
        tmdb_id: tmdb++, media_type: 'movie', title: 't', year: 2020, genres: JSON.stringify([genre]), keywords: '[]',
        cast: '[]', synopsis: null, poster_path: null, embedding: null, updated_at: '',
      });
      const tid = (db.prepare('SELECT max(id) AS id FROM titles').get() as { id: number }).id;
      upsertWatchEvent(db, { profile_id: pid(profile), title_id: tid, status: 'watched', rating, watched_at: null });
    };
    for (const p of ['A', 'B', 'Joint']) {
      for (let i = 0; i < 4; i++) { rate(p, 'Comedy', p === 'A' ? 1 : 5); rate(p, 'Horror', p === 'A' ? 5 : 2); rate(p, 'Drama', 3); }
    }
    const solo = tasteChartForProfile(db, pid('A'))!;
    expect(solo.series).toHaveLength(1);
    expect(solo.axes).toEqual(expect.arrayContaining(['Comedy', 'Horror', 'Drama']));
    const ci = solo.axes.indexOf('Comedy');
    expect(solo.series[0].lifts[ci]!).toBeLessThan(0);

    const joint = tasteChartForProfile(db, pid('Joint'))!;
    expect(joint.series.map(s => s.label)).toEqual(['A', 'B', 'Together']);
    expect(joint.series[2].kind).toBe('together');
    expect(tasteChartForProfile(db, 999)).toBeNull();
  });
});
