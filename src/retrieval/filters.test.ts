import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import {
  DEFAULT_HARD_FILTERS,
  HARD_FLOOR,
  WIDENING_STEPS,
  hardFilterSql,
  withWidening,
  languagesFromHistory,
  type HardFilters,
} from './filters.js';

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  runMigrations(db);
  return db;
}

/** A title that passes every default filter unless overridden. */
function goodTitle(overrides: Record<string, unknown> = {}) {
  return {
    tmdb_id: Math.floor(Math.random() * 1e9), media_type: 'movie' as const, title: 'Good', year: 2015,
    genres: '["Thriller"]', keywords: '[]', cast: '[]', synopsis: 's', poster_path: null,
    embedding: Buffer.from(new Float32Array([1, 0]).buffer), updated_at: '2026-01-01',
    original_language: 'en', runtime_minutes: 110, vote_average: 7.1, vote_count: 2000,
    status: 'Released', popularity: 20,
    ...overrides,
  };
}

function survivors(db: InstanceType<typeof Database>, f: HardFilters): string[] {
  const { sql, params } = hardFilterSql(f);
  return (db.prepare(`SELECT title FROM titles t WHERE 1=1 ${sql} ORDER BY title`).all(...params) as Array<{ title: string }>)
    .map(r => r.title);
}

describe('hardFilterSql', () => {
  it('keeps a title that satisfies every default filter', () => {
    const db = createTestDb();
    upsertTitle(db, goodTitle({ title: 'Keep' }));
    expect(survivors(db, DEFAULT_HARD_FILTERS)).toEqual(['Keep']);
  });

  it('drops titles below the vote count, rating, year and runtime floors', () => {
    const db = createTestDb();
    upsertTitle(db, goodTitle({ title: 'Keep' }));
    upsertTitle(db, goodTitle({ title: 'FewVotes', vote_count: 12 }));
    upsertTitle(db, goodTitle({ title: 'LowRated', vote_average: 4.9 }));
    upsertTitle(db, goodTitle({ title: 'TooOld', year: 1975 }));
    upsertTitle(db, goodTitle({ title: 'Short', runtime_minutes: 14 }));
    expect(survivors(db, DEFAULT_HARD_FILTERS)).toEqual(['Keep']);
  });

  it('drops non-English and unreleased titles by default', () => {
    const db = createTestDb();
    upsertTitle(db, goodTitle({ title: 'Keep' }));
    upsertTitle(db, goodTitle({ title: 'Mandarin', original_language: 'zh' }));
    upsertTitle(db, goodTitle({ title: 'Unreleased', status: 'Post Production', year: 2027, vote_count: 0 }));
    expect(survivors(db, DEFAULT_HARD_FILTERS)).toEqual(['Keep']);
  });

  it('treats unknown metadata as failing, not passing', () => {
    const db = createTestDb();
    upsertTitle(db, goodTitle({ title: 'Keep' }));
    upsertTitle(db, goodTitle({ title: 'NoVotes', vote_count: null }));
    upsertTitle(db, goodTitle({ title: 'NoRating', vote_average: null }));
    upsertTitle(db, goodTitle({ title: 'NoYear', year: null }));
    upsertTitle(db, goodTitle({ title: 'NoLang', original_language: null }));
    upsertTitle(db, goodTitle({ title: 'NoStatus', status: null }));
    upsertTitle(db, goodTitle({ title: 'NoRuntime', runtime_minutes: null }));
    expect(survivors(db, DEFAULT_HARD_FILTERS)).toEqual(['Keep']);
  });

  it('exempts series from the runtime floor and uses the TV vote floor', () => {
    const db = createTestDb();
    upsertTitle(db, goodTitle({ title: 'Series', media_type: 'tv', runtime_minutes: 22, vote_count: 60, status: 'Ended' }));
    upsertTitle(db, goodTitle({ title: 'Running', media_type: 'tv', runtime_minutes: null, vote_count: 60, status: 'Returning Series' }));
    upsertTitle(db, goodTitle({ title: 'ObscureSeries', media_type: 'tv', vote_count: 12, status: 'Ended' }));
    upsertTitle(db, goodTitle({ title: 'Announced', media_type: 'tv', vote_count: 60, status: 'Planned' }));
    expect(survivors(db, DEFAULT_HARD_FILTERS)).toEqual(['Running', 'Series']);
  });

  it('accepts additional languages when configured', () => {
    const db = createTestDb();
    upsertTitle(db, goodTitle({ title: 'Korean', original_language: 'ko' }));
    upsertTitle(db, goodTitle({ title: 'French', original_language: 'fr' }));
    expect(survivors(db, { ...DEFAULT_HARD_FILTERS, languages: ['en', 'ko'] })).toEqual(['Korean']);
  });

  it('applies no language filter when the list is empty', () => {
    const db = createTestDb();
    upsertTitle(db, goodTitle({ title: 'Korean', original_language: 'ko' }));
    expect(survivors(db, { ...DEFAULT_HARD_FILTERS, languages: [] })).toEqual(['Korean']);
  });
});

describe('WIDENING_STEPS', () => {
  it('relaxes year first, then runtime, then vote counts, and never below the hard floor', () => {
    let f = DEFAULT_HARD_FILTERS;
    const seen: HardFilters[] = [];
    for (const step of WIDENING_STEPS) {
      f = step.apply(f);
      seen.push(f);
    }
    // First steps only move the year.
    expect(seen[0].minYear).toBeLessThan(DEFAULT_HARD_FILTERS.minYear);
    expect(seen[0].minRuntimeMovie).toBe(DEFAULT_HARD_FILTERS.minRuntimeMovie);
    expect(seen[0].minVotesMovie).toBe(DEFAULT_HARD_FILTERS.minVotesMovie);
    // Runtime relaxes only after the year has bottomed out.
    const firstRuntimeStep = seen.findIndex(s => s.minRuntimeMovie < DEFAULT_HARD_FILTERS.minRuntimeMovie);
    expect(seen[firstRuntimeStep].minYear).toBe(HARD_FLOOR.minYear);
    // Votes relax only after runtime has bottomed out.
    const firstVoteStep = seen.findIndex(s => s.minVotesMovie < DEFAULT_HARD_FILTERS.minVotesMovie);
    expect(firstVoteStep).toBeGreaterThan(firstRuntimeStep);
    expect(seen[firstVoteStep].minRuntimeMovie).toBe(HARD_FLOOR.minRuntimeMovie);
    // Final state sits exactly on the hard floor.
    const last = seen[seen.length - 1];
    expect(last.minYear).toBe(HARD_FLOOR.minYear);
    expect(last.minRuntimeMovie).toBe(HARD_FLOOR.minRuntimeMovie);
    expect(last.minVotesMovie).toBe(HARD_FLOOR.minVotesMovie);
    expect(last.minVotesTv).toBe(HARD_FLOOR.minVotesTv);
    // Rating, language and release status are never relaxed.
    expect(last.minVoteAverage).toBe(DEFAULT_HARD_FILTERS.minVoteAverage);
    expect(last.languages).toEqual(DEFAULT_HARD_FILTERS.languages);
    expect(last.releasedOnly).toBe(true);
  });

  it('never tightens a filter that already starts looser than the step target', () => {
    const loose: HardFilters = { ...DEFAULT_HARD_FILTERS, minYear: 1970, minVotesMovie: 5 };
    let f = loose;
    for (const step of WIDENING_STEPS) f = step.apply(f);
    expect(f.minYear).toBe(1970);
    expect(f.minVotesMovie).toBe(5);
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
    // Only the year floor matters to this fake catalogue: 1985 unlocks enough rows.
    const res = withWidening(DEFAULT_HARD_FILTERS, 10, f =>
      f.minYear <= 1985 ? Array.from({ length: 12 }, (_, i) => i) : [1, 2],
    );
    expect(res.rows).toHaveLength(12);
    expect(res.filters.minYear).toBe(1985);
    expect(res.filters.minRuntimeMovie).toBe(DEFAULT_HARD_FILTERS.minRuntimeMovie);
    expect(res.stepsApplied).toEqual(['year>=1990', 'year>=1985']);
  });

  it('exhausts every step and returns the best effort when the catalogue is thin', () => {
    const res = withWidening(DEFAULT_HARD_FILTERS, 10, () => [1, 2]);
    expect(res.rows).toEqual([1, 2]);
    expect(res.stepsApplied).toHaveLength(WIDENING_STEPS.length);
    expect(res.filters.minYear).toBe(HARD_FLOOR.minYear);
    expect(res.filters.minVotesMovie).toBe(HARD_FLOOR.minVotesMovie);
  });
});

describe('languagesFromHistory', () => {
  it('always includes English and adds any language with enough liked titles', () => {
    const db = createTestDb();
    upsertProfile(db, { name: 'A', media_weighting: 0.5, is_derived: 0, config: '{}' });
    const pid = (db.prepare("SELECT id FROM profiles WHERE name='A'").get() as { id: number }).id;
    const ids: number[] = [];
    const add = (lang: string, rating: number) => {
      upsertTitle(db, goodTitle({ title: `${lang}${ids.length}`, original_language: lang }));
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
