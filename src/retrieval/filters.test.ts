import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import {
  defaultHardFilters,
  floorFilters,
  HARD_FLOOR,
  WIDENING_STEPS,
  hardFilterSql,
  withWidening,
  languagesFromHistory,
  titleIdsPassing,
  type HardFilters,
} from './filters.js';

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  runMigrations(db);
  return db;
}

/** Fixed clock for the rolling year floor: recent means 2015 or newer. */
const NOW = new Date('2026-06-01T00:00:00Z');
const DEFAULT_HARD_FILTERS = defaultHardFilters(NOW);

/** A title that passes every default filter unless overridden. */
function goodTitle(overrides: Record<string, unknown> = {}) {
  return {
    tmdb_id: Math.floor(Math.random() * 1e9), media_type: 'movie' as const, title: 'Good', year: 2024,
    genres: '["Thriller"]', keywords: '[]', cast: '[]', synopsis: 's', poster_path: null,
    embedding: Buffer.from(new Float32Array([1, 0]).buffer), updated_at: '2026-01-01',
    original_language: 'en', runtime_minutes: 110, vote_average: 7.1, vote_count: 2000,
    status: 'Released', popularity: 20, imdb_rating: '7.2', imdb_votes: 5000,
    ...overrides,
  };
}

/** Insert goodTitle(overrides). upsertTitle does not write imdb_votes, so it is set here. */
function addTitle(db: InstanceType<typeof Database>, overrides: Record<string, unknown> = {}): void {
  const t = goodTitle(overrides);
  upsertTitle(db, t);
  db.prepare('UPDATE titles SET imdb_votes = ? WHERE tmdb_id = ? AND media_type = ?').run(t.imdb_votes, t.tmdb_id, t.media_type);
}

function survivors(db: InstanceType<typeof Database>, f: HardFilters): string[] {
  const { sql, params } = hardFilterSql(f);
  return (db.prepare(`SELECT title FROM titles t WHERE 1=1 ${sql} ORDER BY title`).all(...params) as Array<{ title: string }>)
    .map(r => r.title);
}

describe('hardFilterSql', () => {
  it('keeps a title that satisfies every default filter', () => {
    const db = createTestDb();
    addTitle(db, { title: 'Keep' });
    expect(survivors(db, DEFAULT_HARD_FILTERS)).toEqual(['Keep']);
  });

  it('drops titles below the vote count, rating, year and runtime floors', () => {
    const db = createTestDb();
    addTitle(db, { title: 'Keep' });
    addTitle(db, { title: 'FewVotes', vote_count: 12 });
    addTitle(db, { title: 'LowRated', vote_average: 4.9 });
    addTitle(db, { title: 'TooOld', year: 2014 });
    addTitle(db, { title: 'Short', runtime_minutes: 14 });
    expect(survivors(db, DEFAULT_HARD_FILTERS)).toEqual(['Keep']);
  });

  it('requires a real IMDb rating: 6.0 or more, with 1,000 votes for a film and 500 for a series', () => {
    const db = createTestDb();
    addTitle(db, { title: 'Keep' });
    addTitle(db, { title: 'JustRated', imdb_rating: '6.0', imdb_votes: 1000 });
    addTitle(db, { title: 'LowImdb', imdb_rating: '5.9' });
    addTitle(db, { title: 'FewImdbVotes', imdb_votes: 999 });
    addTitle(db, { title: 'NotNumeric', imdb_rating: 'N/A' });
    addTitle(db, { title: 'SeriesKeep', media_type: 'tv', status: 'Ended', imdb_votes: 500 });
    addTitle(db, { title: 'SeriesFewVotes', media_type: 'tv', status: 'Ended', imdb_votes: 499 });
    expect(survivors(db, DEFAULT_HARD_FILTERS)).toEqual(['JustRated', 'Keep', 'SeriesKeep']);
  });

  it('applies no year limit when minYear is null', () => {
    const db = createTestDb();
    addTitle(db, { title: 'Seventies', year: 1975 });
    addTitle(db, { title: 'NoYear', year: null });
    expect(survivors(db, { ...DEFAULT_HARD_FILTERS, minYear: null })).toEqual(['NoYear', 'Seventies']);
  });

  it('drops non-English and unreleased titles by default', () => {
    const db = createTestDb();
    addTitle(db, { title: 'Keep' });
    addTitle(db, { title: 'Mandarin', original_language: 'zh' });
    addTitle(db, { title: 'Unreleased', status: 'Post Production', year: 2027, vote_count: 0 });
    expect(survivors(db, DEFAULT_HARD_FILTERS)).toEqual(['Keep']);
  });

  it('treats unknown metadata as failing, not passing', () => {
    const db = createTestDb();
    addTitle(db, { title: 'Keep' });
    addTitle(db, { title: 'NoVotes', vote_count: null });
    addTitle(db, { title: 'NoRating', vote_average: null });
    addTitle(db, { title: 'NoYear', year: null });
    addTitle(db, { title: 'NoLang', original_language: null });
    addTitle(db, { title: 'NoStatus', status: null });
    addTitle(db, { title: 'NoRuntime', runtime_minutes: null });
    addTitle(db, { title: 'NoImdbRating', imdb_rating: null });
    addTitle(db, { title: 'NoImdbVotes', imdb_votes: null });
    expect(survivors(db, DEFAULT_HARD_FILTERS)).toEqual(['Keep']);
  });

  it('exempts series from the runtime floor and uses the TV vote floor', () => {
    const db = createTestDb();
    addTitle(db, { title: 'Series', media_type: 'tv', runtime_minutes: 22, vote_count: 60, status: 'Ended' });
    addTitle(db, { title: 'Running', media_type: 'tv', runtime_minutes: null, vote_count: 60, status: 'Returning Series' });
    addTitle(db, { title: 'ObscureSeries', media_type: 'tv', vote_count: 12, status: 'Ended' });
    addTitle(db, { title: 'Announced', media_type: 'tv', vote_count: 60, status: 'Planned' });
    expect(survivors(db, DEFAULT_HARD_FILTERS)).toEqual(['Running', 'Series']);
  });

  it('accepts additional languages when configured', () => {
    const db = createTestDb();
    addTitle(db, { title: 'Korean', original_language: 'ko' });
    addTitle(db, { title: 'French', original_language: 'fr' });
    expect(survivors(db, { ...DEFAULT_HARD_FILTERS, languages: ['en', 'ko'] })).toEqual(['Korean']);
  });

  it('applies no language filter when the list is empty', () => {
    const db = createTestDb();
    addTitle(db, { title: 'Korean', original_language: 'ko' });
    expect(survivors(db, { ...DEFAULT_HARD_FILTERS, languages: [] })).toEqual(['Korean']);
  });
});

describe('defaultHardFilters', () => {
  it('admits the last twelve calendar years, counting the current one', () => {
    expect(defaultHardFilters(new Date('2026-01-01T12:00:00Z')).minYear).toBe(2015);
    expect(defaultHardFilters(new Date('2031-07-01T12:00:00Z')).minYear).toBe(2020);
  });
});

describe('WIDENING_STEPS', () => {
  it('moves the year back 10, then 20, then to the floor; then runtime, IMDb votes, TMDB votes', () => {
    let f = DEFAULT_HARD_FILTERS;
    const seen: HardFilters[] = [];
    for (const step of WIDENING_STEPS) {
      f = step.apply(f);
      seen.push(f);
    }
    expect(seen.map(s => s.minYear)).toEqual([2005, 1995, 1980, 1980, 1980, 1980]);
    expect(seen.map(s => s.minRuntimeMovie)).toEqual([60, 60, 60, 40, 40, 40]);
    expect(seen.map(s => [s.minImdbVotesMovie, s.minImdbVotesTv])).toEqual([
      [1000, 500], [1000, 500], [1000, 500], [1000, 500], [300, 150], [300, 150],
    ]);
    expect(seen.map(s => [s.minVotesMovie, s.minVotesTv])).toEqual([
      [50, 20], [50, 20], [50, 20], [50, 20], [50, 20], [HARD_FLOOR.minVotesMovie, HARD_FLOOR.minVotesTv],
    ]);
    // Rating, language and release status are never relaxed.
    const last = seen[seen.length - 1];
    expect(last.minVoteAverage).toBe(DEFAULT_HARD_FILTERS.minVoteAverage);
    expect(last.minImdbRating).toBe(DEFAULT_HARD_FILTERS.minImdbRating);
    expect(last.languages).toEqual(DEFAULT_HARD_FILTERS.languages);
    expect(last.releasedOnly).toBe(true);
  });

  it('never moves the year past the hard floor, and leaves no year limit alone', () => {
    const fromYear = (minYear: number | null) => {
      let f: HardFilters = { ...DEFAULT_HARD_FILTERS, minYear };
      const years: Array<number | null> = [];
      for (const step of WIDENING_STEPS.slice(0, 3)) years.push((f = step.apply(f)).minYear);
      return years;
    };
    expect(fromYear(1995)).toEqual([1985, 1980, 1980]);
    expect(fromYear(null)).toEqual([null, null, null]);
  });

  it('never tightens a filter that already starts looser than the step target', () => {
    const loose: HardFilters = { ...DEFAULT_HARD_FILTERS, minYear: 1970, minVotesMovie: 5, minImdbVotesTv: 100 };
    let f = loose;
    for (const step of WIDENING_STEPS) f = step.apply(f);
    expect(f.minYear).toBe(1970);
    expect(f.minVotesMovie).toBe(5);
    expect(f.minImdbVotesTv).toBe(100);
  });
});

describe('withWidening', () => {
  it('returns the strict result untouched when it already meets the minimum', () => {
    const calls: HardFilters[] = [];
    const res = withWidening(DEFAULT_HARD_FILTERS, 2, f => { calls.push(f); return [1, 2, 3]; });
    expect(res.rows).toEqual([1, 2, 3]);
    expect(res.stepsApplied).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('widens in order and stops at the first step that meets the minimum', () => {
    // Only the year floor matters to this fake catalogue: 1995 unlocks enough rows.
    const res = withWidening(DEFAULT_HARD_FILTERS, 10, f =>
      f.minYear != null && f.minYear <= 1995 ? Array.from({ length: 12 }, (_, i) => i) : [1, 2],
    );
    expect(res.rows).toHaveLength(12);
    expect(res.filters.minYear).toBe(1995);
    expect(res.filters.minRuntimeMovie).toBe(DEFAULT_HARD_FILTERS.minRuntimeMovie);
    expect(res.stepsApplied).toEqual(['year>=2005', 'year>=1995']);
  });

  it('exhausts every step and returns the best effort when the catalogue is thin', () => {
    const res = withWidening(DEFAULT_HARD_FILTERS, 10, () => [1, 2]);
    expect(res.rows).toEqual([1, 2]);
    expect(res.stepsApplied).toHaveLength(WIDENING_STEPS.length);
    expect(res.filters.minYear).toBe(HARD_FLOOR.minYear);
    expect(res.filters.minVotesMovie).toBe(HARD_FLOOR.minVotesMovie);
    expect(res.filters.minImdbVotesMovie).toBe(HARD_FLOOR.minImdbVotesMovie);
    expect(res.stepsApplied).toEqual([
      'year>=2005', 'year>=1995', 'year>=1980', 'runtime>=40', 'imdbVotes>=300/150', 'votes>=20/10',
    ]);
  });

  it('names only the steps that actually lowered a filter', () => {
    // Year starts at 1985, so the first step reaches the floor and the next two
    // change nothing; IMDb votes already sit on their floor.
    const start: HardFilters = { ...DEFAULT_HARD_FILTERS, minYear: 1985, minImdbVotesMovie: 300, minImdbVotesTv: 150 };
    const res = withWidening(start, 10, () => [1, 2]);
    expect(res.stepsApplied).toEqual([
      `year>=${HARD_FLOOR.minYear}`,
      `runtime>=${HARD_FLOOR.minRuntimeMovie}`,
      `votes>=${HARD_FLOOR.minVotesMovie}/${HARD_FLOOR.minVotesTv}`,
    ]);
    expect(res.filters.minYear).toBe(HARD_FLOOR.minYear);
    expect(res.filters.minVotesMovie).toBe(HARD_FLOOR.minVotesMovie);
    expect(res.filters.minVotesTv).toBe(HARD_FLOOR.minVotesTv);
  });

  it('names no step at all when every filter already sits on the hard floor', () => {
    const floor: HardFilters = { ...DEFAULT_HARD_FILTERS, ...HARD_FLOOR };
    const res = withWidening(floor, 10, () => [1, 2]);
    expect(res.rows).toEqual([1, 2]);
    expect(res.stepsApplied).toEqual([]);
    expect(res.filters).toEqual(floor);
  });
});

describe('languagesFromHistory', () => {
  it('always includes English and adds any language with enough liked titles', () => {
    const db = createTestDb();
    upsertProfile(db, { name: 'A', media_weighting: 0.5, is_derived: 0, config: '{}' });
    const pid = (db.prepare("SELECT id FROM profiles WHERE name='A'").get() as { id: number }).id;
    const ids: number[] = [];
    const add = (lang: string, rating: number) => {
      addTitle(db, { title: `${lang}${ids.length}`, original_language: lang });
      const id = (db.prepare('SELECT max(id) AS id FROM titles').get() as { id: number }).id;
      ids.push(id);
      upsertWatchEvent(db, { profile_id: pid, title_id: id, status: 'watched', rating, watched_at: null });
    };
    for (let i = 0; i < 20; i++) add('en', 5);
    add('ko', 5); add('ko', 4); add('ko', 4);   // 3 liked → in
    add('fr', 5);                               // 1 liked → out
    add('de', 2); add('de', 2); add('de', 1);   // disliked → out
    expect(languagesFromHistory(db, [pid])).toEqual(['en', 'ko']);
  });

  it('returns just English when there is no history', () => {
    const db = createTestDb();
    expect(languagesFromHistory(db, [1, 2])).toEqual(['en']);
  });
});

describe('floorFilters', () => {
  it('drops the year limit and lowers votes and runtime to the floor, but keeps the rating gate', () => {
    const db = createTestDb();
    addTitle(db, { title: 'Seventies', year: 1975 });
    addTitle(db, { title: 'Widened', runtime_minutes: 45, vote_count: 25, imdb_votes: 300 });
    addTitle(db, { title: 'Unrated', imdb_rating: null });
    addTitle(db, { title: 'LowImdb', imdb_rating: '5.5' });
    addTitle(db, { title: 'TooFewImdbVotes', imdb_votes: 299 });
    const floor = floorFilters(DEFAULT_HARD_FILTERS);
    expect(floor.minYear).toBeNull();
    expect(survivors(db, floor)).toEqual(['Seventies', 'Widened']);
  });
});

describe('titleIdsPassing', () => {
  function seed(db: InstanceType<typeof Database>): { good: number[]; bad: number } {
    const good: number[] = [];
    for (let i = 0; i < 3; i++) {
      addTitle(db, { title: `ok${i}` });
      good.push((db.prepare('SELECT max(id) AS id FROM titles').get() as { id: number }).id);
    }
    addTitle(db, { title: 'tiny', vote_count: 1 });
    const bad = (db.prepare('SELECT max(id) AS id FROM titles').get() as { id: number }).id;
    return { good, bad };
  }

  it('returns the passing ids of a small set', () => {
    const db = createTestDb();
    const { good, bad } = seed(db);
    expect([...titleIdsPassing(db, DEFAULT_HARD_FILTERS, [...good, bad, 999_999])].sort()).toEqual([...good].sort());
  });

  it('handles more ids than SQLite allows as bound variables in one statement', () => {
    const db = createTestDb();
    const { good, bad } = seed(db);
    const small = titleIdsPassing(db, DEFAULT_HARD_FILTERS, [...good, bad]);
    // 40,000 ids: the real titles plus unknown ids that must simply not match.
    const many = [...good, bad, ...Array.from({ length: 40_000 - 4 }, (_, i) => 1_000_000 + i)];
    const result = titleIdsPassing(db, DEFAULT_HARD_FILTERS, many);
    expect([...result].sort()).toEqual([...small].sort());
  });
});
