import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import { defaultHardFilters } from './filters.js';
import { defaultRules, type RequestRules, type RuleClause } from '../request/rules.js';
import { titleObeys } from '../request/enforce.js';
import {
  findReferenceTitles,
  olderRoom,
  requestSlate,
  requestVector,
  retrieveUnderRules,
  titlesObeying,
  withReferences,
  FULL_SET,
  MAX_OLDER_PICKS,
  SLATE_PER_MEDIA,
  type RulesQuery,
} from './requestRules.js';

const NOW = new Date('2026-11-19T12:00:00Z');
const DIM = 8;

function vec(hot: number): Buffer {
  const a = new Float32Array(DIM);
  a[hot] = 1;
  return Buffer.from(a.buffer);
}

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  runMigrations(db);
  return db;
}

let nextTmdb = 1;
/** A title passing every hard filter unless overridden. */
function seed(db: InstanceType<typeof Database>, title: string, o: Record<string, unknown> = {}): number {
  const { imdb_votes = 5000, imdb_genres = null, ...rest } = o;
  upsertTitle(db, {
    tmdb_id: nextTmdb++, media_type: 'movie', title, year: 2025,
    genres: '["Thriller"]', keywords: '[]', cast: '[]', synopsis: `${title} synopsis`, poster_path: null,
    embedding: vec(0), updated_at: '2026-01-01',
    original_language: 'en', runtime_minutes: 105, vote_average: 7.0, vote_count: 900,
    status: 'Released', popularity: 30, imdb_rating: '7.2',
    ...rest,
  });
  const id = (db.prepare('SELECT id FROM titles WHERE title = ?').get(title) as { id: number }).id;
  db.prepare('UPDATE titles SET imdb_votes = ?, imdb_genres = ? WHERE id = ?').run(imdb_votes, imdb_genres, id);
  return id;
}

const genre = (...genres: RuleClause['genres']): RuleClause => ({ label: genres.join('/'), genres, terms: [] });
const term = (label: string, ...terms: string[]): RuleClause => ({ label, genres: [], terms });
const rules = (o: Partial<RequestRules>): RequestRules => ({ ...defaultRules(NOW), ...o });

function query(o: Partial<RulesQuery> = {}): RulesQuery {
  return {
    queryVec: vec(0),
    hardFilters: defaultHardFilters(NOW),
    vetoProfileIds: [],
    excludeTitleIds: [],
    affinity: {},
    ...o,
  };
}

const titles = (rows: Array<{ title: string }>) => rows.map(r => r.title).sort();

describe('titlesObeying', () => {
  it('returns only titles that satisfy every rule, each passing titleObeys', () => {
    const db = createDb();
    seed(db, 'New Thriller Film');
    seed(db, 'Old Thriller Film', { year: 1995 });
    seed(db, 'New Comedy Film', { genres: '["Comedy"]' });
    seed(db, 'New Thriller Series', { media_type: 'tv', status: 'Ended' });
    seed(db, 'New Thriller Short', { runtime_minutes: 20 });
    const r = rules({ mediaType: 'movie', yearMin: 2025, yearSource: 'stated', must: [genre('Thriller')] });

    const out = titlesObeying(db, r, query());

    expect(titles(out)).toEqual(['New Thriller Film']);
    for (const t of out) expect(titleObeys(r, t).ok).toBe(true);
    expect(out[0].embedding).toBeNull(); // the embedding column is never read
  });

  it('applies term clauses and exclusions to keywords, title and synopsis', () => {
    const db = createDb();
    seed(db, 'Ward Nine', { keywords: '["hospital"]' });
    seed(db, 'Nun Ward', { keywords: '["hospital","nun"]' });
    seed(db, 'Car Chase', { keywords: '["car"]' });
    const r = rules({ must: [genre('Thriller'), term('medical', 'hospital', 'doctor')], mustNot: [term('nuns', 'nun', 'convent')] });

    expect(titles(titlesObeying(db, r, query()))).toEqual(['Ward Nine']);
  });

  it('holds the rating floor strictly: just below fails, the floor passes, no rating fails', () => {
    const db = createDb();
    seed(db, 'At Floor', { imdb_rating: '7.0' });
    seed(db, 'Just Below', { imdb_rating: '6.9' });
    seed(db, 'Unrated', { imdb_rating: null });
    expect(titles(titlesObeying(db, rules({ minImdb: 7.0 }), query()))).toEqual(['At Floor']);
  });

  it('lets the rules own the year: the hard filters\' recent floor does not apply', () => {
    const db = createDb();
    seed(db, 'Nineties Action', { year: 1994, genres: '["Action"]' });
    const r = rules({ yearMin: 1990, yearMax: 1999, yearSource: 'stated', must: [genre('Action')] });
    expect(titles(titlesObeying(db, r, query()))).toEqual(['Nineties Action']);
  });

  it('keeps the other hard filters: too few IMDb votes or another language fails', () => {
    const db = createDb();
    seed(db, 'Few Votes', { imdb_votes: 200 });
    seed(db, 'French', { original_language: 'fr' });
    seed(db, 'Fine');
    expect(titles(titlesObeying(db, rules({}), query()))).toEqual(['Fine']);
  });

  it('leaves out excluded titles and titles a vetoing profile has watched', () => {
    const db = createDb();
    upsertProfile(db, { name: 'Alex', media_weighting: 0.5, is_derived: 0, config: '{}' });
    const watched = seed(db, 'Watched');
    const excluded = seed(db, 'Excluded');
    seed(db, 'Free');
    upsertWatchEvent(db, { profile_id: 1, title_id: watched, status: 'watched', rating: 4, watched_at: null });
    const out = titlesObeying(db, rules({}), query({ vetoProfileIds: [1], excludeTitleIds: [excluded] }));
    expect(titles(out)).toEqual(['Free']);
  });

  it('ranks the titles closest to the query vector first', () => {
    const db = createDb();
    seed(db, 'Far', { embedding: vec(5) });
    seed(db, 'Near', { embedding: vec(2) });
    expect(titlesObeying(db, rules({}), query({ queryVec: vec(2) }))[0].title).toBe('Near');
  });
});

describe('retrieveUnderRules: recent by default', () => {
  function catalogue(db: InstanceType<typeof Database>, recent: number) {
    for (let i = 0; i < recent; i++) seed(db, `Recent ${i}`, { year: 2023 });
    for (let i = 0; i < 4; i++) seed(db, `Twenty Tens ${i}`, { year: 2018 });
    for (let i = 0; i < 6; i++) seed(db, `Noughties ${i}`, { year: 2008 });
  }

  it('reaches ten years back for a short default window, and offers a few older titles for the free places', () => {
    const db = createDb();
    catalogue(db, 3);
    const r = retrieveUnderRules(db, rules({ must: [genre('Thriller')] }), query(), NOW);

    expect(r.inWindow).toHaveLength(3);
    // 2016 to 2020 only: the 2008 titles are for a request that asks for them.
    expect([r.olderRules?.yearMin, r.olderRules?.yearMax]).toEqual([2016, 2020]);
    expect(r.older.map(t => t.year)).toEqual([2018, 2018, 2018, 2018]);
    expect(olderRoom(r)).toBe(MAX_OLDER_PICKS);
    const slate = requestSlate(r, false);
    expect(slate.recent).toHaveLength(3);
    expect(slate.older).toHaveLength(4);
  });

  it('offers no more older titles than the list has free places', () => {
    const db = createDb();
    catalogue(db, FULL_SET - 1);
    expect(olderRoom(retrieveUnderRules(db, rules({}), query(), NOW))).toBe(1);
  });

  it('does not widen once the default window holds a full set', () => {
    const db = createDb();
    catalogue(db, FULL_SET);
    const r = retrieveUnderRules(db, rules({}), query(), NOW);
    expect(r.older).toEqual([]);
    expect(r.olderRules).toBeNull();
    expect(olderRoom(r)).toBe(0);
  });

  it('never widens a stated, recent or any-year window: fewer titles come back', () => {
    for (const yearSource of ['stated', 'recent'] as const) {
      const db = createDb();
      catalogue(db, 3);
      const r = retrieveUnderRules(db, rules({ yearMin: 2023, yearSource }), query(), NOW);
      expect(r.inWindow).toHaveLength(3);
      expect(r.older).toEqual([]);
    }
  });
});

describe('requestSlate', () => {
  it('offers both films and series, up to SLATE_PER_MEDIA of each, when film vs series is open', () => {
    const db = createDb();
    for (let i = 0; i < SLATE_PER_MEDIA + 5; i++) seed(db, `Film ${i}`);
    for (let i = 0; i < 5; i++) seed(db, `Series ${i}`, { media_type: 'tv', status: 'Ended', embedding: vec(4) });
    const r = retrieveUnderRules(db, rules({}), query(), NOW);
    const slate = requestSlate(r, true);
    expect(slate.recent.filter(t => t.media_type === 'movie')).toHaveLength(SLATE_PER_MEDIA);
    expect(slate.recent.filter(t => t.media_type === 'tv')).toHaveLength(5);
  });
});

describe('references', () => {
  it('finds the longest word-prefix of a phrase that names a title, the most-voted when names repeat', () => {
    const db = createDb();
    seed(db, 'Inception', { year: 2010, imdb_votes: 2_500_000 });
    upsertTitle(db, {
      tmdb_id: 9999, media_type: 'tv', title: 'Inception', year: 2020, genres: '[]', keywords: '[]', cast: '[]',
      synopsis: null, poster_path: null, embedding: vec(3), updated_at: '',
    });
    db.prepare("UPDATE titles SET imdb_votes = 900 WHERE tmdb_id = 9999").run();
    seed(db, 'The Invite', { year: 2023 });

    const refs = findReferenceTitles(db, ['inception something on those lines', 'The invite', 'the']);
    expect(refs.map(r => [r.title, r.year])).toEqual([['Inception', 2010], ['The Invite', 2023]]);
  });

  it('finds a title typed without its punctuation', () => {
    const db = createDb();
    seed(db, 'Spider-Man: No Way Home', { year: 2021 });
    seed(db, '2001: A Space Odyssey', { year: 1968 });
    const refs = findReferenceTitles(db, ['spider man no way home', '2001 a space odyssey']);
    expect(refs.map(r => r.title).sort()).toEqual(['2001: A Space Odyssey', 'Spider-Man: No Way Home']);
  });

  it('drops a default year window when a reference is older, and keeps a stated one', () => {
    const old = [{ id: 1, title: 'Heat', year: 1995, embedding: vec(1) }];
    expect(withReferences(rules({}), old)).toMatchObject({ yearMin: null, yearMax: null, yearSource: 'any' });
    expect(withReferences(rules({}), [{ ...old[0], year: 2024 }]).yearSource).toBe('default');
    expect(withReferences(rules({ yearMin: 2024, yearSource: 'stated' }), old).yearMin).toBe(2024);
  });

  it('blends the references into the request vector', () => {
    const v = requestVector([1, 0, 0, 0, 0, 0, 0, 0], [{ id: 1, title: 'X', year: 2000, embedding: vec(1) }]);
    expect(v.slice(0, 2)).toEqual([0.5, 0.5]);
  });
});
