import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import { defaultHardFilters } from './filters.js';
import { defaultRules, DEFAULT_RECENT_YEARS, type RequestRules, type RuleClause } from '../request/rules.js';
import { parseRequest } from '../request/parse.js';
import { titleObeys } from '../request/enforce.js';
import {
  closeRoom,
  countObeying,
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

describe('countObeying', () => {
  it('counts the given titles that titlesObeying would return, and only those', () => {
    const db = createDb();
    const a = seed(db, 'Listed Thriller A');
    const b = seed(db, 'Listed Thriller B');
    const comedy = seed(db, 'Listed Comedy', { genres: '["Comedy"]' });
    const old = seed(db, 'Listed Old Thriller', { year: 1995 });
    const dismissed = seed(db, 'Dismissed Thriller');
    seed(db, 'Unlisted Thriller');
    const r = rules({ must: [genre('Thriller')] });
    const q = query({ excludeTitleIds: [dismissed] });

    expect(countObeying(db, r, q, [a, b, comedy, old, dismissed])).toBe(2);
    expect(countObeying(db, r, q, [])).toBe(0);
    const all = titlesObeying(db, r, q).map(t => t.id);
    expect([a, b].every(id => all.includes(id))).toBe(true);
  });
});

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
    for (let i = 0; i < 4; i++) seed(db, `Before Window ${i}`, { year: 2010 });
    for (let i = 0; i < 6; i++) seed(db, `Too Old ${i}`, { year: 2003 });
  }

  it('reaches the ten years before the window\'s floor for a short default window, and offers a few older titles for the free places', () => {
    const db = createDb();
    catalogue(db, 3);
    const r = retrieveUnderRules(db, rules({ must: [genre('Thriller')] }), query());

    expect(r.inWindow).toHaveLength(3);
    // 2005 to 2014 only: the 2003 titles are for a request that asks for them.
    expect([r.olderRules?.yearMin, r.olderRules?.yearMax]).toEqual([2005, 2014]);
    expect(r.older.map(t => t.year)).toEqual([2010, 2010, 2010, 2010]);
    expect(olderRoom(r)).toBe(MAX_OLDER_PICKS);
    const slate = requestSlate(r, false);
    expect(slate.recent).toHaveLength(3);
    expect(slate.older).toHaveLength(4);
  });

  it('offers no more older titles than the list has free places', () => {
    const db = createDb();
    catalogue(db, FULL_SET - 1);
    expect(olderRoom(retrieveUnderRules(db, rules({}), query()))).toBe(1);
  });

  it('does not widen once the default window holds a full set', () => {
    const db = createDb();
    catalogue(db, FULL_SET);
    const r = retrieveUnderRules(db, rules({}), query());
    expect(r.older).toEqual([]);
    expect(r.olderRules).toBeNull();
    expect(olderRoom(r)).toBe(0);
  });

  it('never widens a stated, recent or any-year window: fewer titles come back', () => {
    for (const yearSource of ['stated', 'recent'] as const) {
      const db = createDb();
      catalogue(db, 3);
      const r = retrieveUnderRules(db, rules({ yearMin: 2023, yearSource }), query());
      expect(r.inWindow).toHaveLength(3);
      expect(r.older).toEqual([]);
    }
  });
});

describe('the default year window', () => {
  it('is the last twelve calendar years: the current year minus 11', () => {
    expect(DEFAULT_RECENT_YEARS).toBe(12);
    expect(defaultRules(NOW).yearMin).toBe(NOW.getFullYear() - 11);
    expect(parseRequest('thriller', NOW).yearMin).toBe(2015);
    expect(defaultRules(new Date('2030-03-01T12:00:00Z')).yearMin).toBe(2019);
  });
});

describe('retrieveUnderRules: close matches for soft (mood) clauses', () => {
  const scary: RuleClause = { label: 'Scary', genres: ['Horror'], terms: [], soft: true };
  const bending: RuleClause = { label: 'Mind-bending', genres: [], terms: ['twist ending', 'time loop'], soft: true };
  const scifi = genre('Science Fiction');
  const moody = rules({ must: [scifi, bending, scary] });

  it('returns the strict matches, then close matches ordered by fewest soft clauses missed, then by rank', () => {
    const db = createDb();
    seed(db, 'Strict', { genres: '["Science Fiction","Horror"]', keywords: '["time loop"]' });
    // Nearest to the query, but misses both moods: last among the close matches.
    seed(db, 'Misses Both Near', { genres: '["Science Fiction"]', embedding: vec(0) });
    seed(db, 'Misses Scary Far', { genres: '["Science Fiction"]', keywords: '["twist ending"]', embedding: vec(5) });
    seed(db, 'Misses Scary Near', { genres: '["Science Fiction"]', keywords: '["time loop"]', embedding: vec(0) });
    seed(db, 'Misses Bending', { genres: '["Science Fiction","Horror"]', embedding: vec(5) });
    // Hard rules still hold: not sci-fi, too old, excluded.
    seed(db, 'Horror Only', { genres: '["Horror"]', keywords: '["time loop"]' });
    seed(db, 'Old Sci-fi', { genres: '["Science Fiction","Horror"]', keywords: '["time loop"]', year: 2001 });
    seed(db, 'Nun Sci-fi', { genres: '["Science Fiction"]', keywords: '["time loop","nun"]' });

    const r = retrieveUnderRules(db, { ...moody, mustNot: [term('nuns', 'nun')] }, query());

    expect(r.inWindow.map(t => t.title)).toEqual(['Strict']);
    expect(r.close.map(t => t.title)).toEqual(['Misses Scary Near', 'Misses Scary Far', 'Misses Bending', 'Misses Both Near']);
    expect(r.closeRules?.must).toEqual([scifi]);
    expect(r.close.every(t => titleObeys(r.closeRules!, t).ok)).toBe(true);
    expect(closeRoom(r)).toBe(4);
    const slate = requestSlate(r, false);
    expect(slate.recent.map(t => t.title)).toEqual(['Strict']);
    expect(slate.close).toHaveLength(4);
  });

  it('offers no close matches when ten or more titles match every rule', () => {
    const db = createDb();
    for (let i = 0; i < FULL_SET; i++) seed(db, `Strict ${i}`, { genres: '["Science Fiction","Horror"]', keywords: '["time loop"]' });
    seed(db, 'Close', { genres: '["Science Fiction"]', keywords: '["time loop"]' });
    const r = retrieveUnderRules(db, moody, query());
    expect(r.inWindow).toHaveLength(FULL_SET);
    expect(r.close).toEqual([]);
    expect(r.closeRules).toBeNull();
  });

  it('offers no close matches when the request has no soft clauses', () => {
    const db = createDb();
    seed(db, 'Sci-fi Horror', { genres: '["Science Fiction","Horror"]' });
    seed(db, 'Sci-fi Only', { genres: '["Science Fiction"]' });
    const r = retrieveUnderRules(db, rules({ must: [scifi, genre('Horror')] }), query());
    expect(r.inWindow.map(t => t.title)).toEqual(['Sci-fi Horror']);
    expect(r.close).toEqual([]);
  });

  it('reaches for older titles only when the list is still short after the close matches', () => {
    const fill = (db: InstanceType<typeof Database>, close: number) => {
      seed(db, 'Strict', { genres: '["Science Fiction","Horror"]', keywords: '["time loop"]' });
      for (let i = 0; i < close; i++) seed(db, `Close ${i}`, { genres: '["Science Fiction"]', keywords: '["time loop"]' });
      for (let i = 0; i < 5; i++) seed(db, `Older ${i}`, { genres: '["Science Fiction","Horror"]', keywords: '["time loop"]', year: 2010 });
    };
    const full = createDb();
    fill(full, 9);
    const enough = retrieveUnderRules(full, moody, query());
    expect([enough.inWindow.length, enough.close.length]).toEqual([1, 9]);
    expect(enough.older).toEqual([]);
    expect(olderRoom(enough)).toBe(0);

    const short = createDb();
    fill(short, 7);
    const r = retrieveUnderRules(short, moody, query());
    expect([r.inWindow.length, r.close.length, closeRoom(r)]).toEqual([1, 7, 7]);
    expect([r.olderRules?.yearMin, r.olderRules?.yearMax]).toEqual([2005, 2014]);
    // Older titles obey every rule, moods included; two places are left.
    expect(r.older).toHaveLength(5);
    expect(olderRoom(r)).toBe(2);
  });

  it('reproduces the reported case in miniature: sci-fi mind bending scary series', () => {
    const db = createDb();
    const series = (title: string, o: Record<string, unknown>) =>
      seed(db, title, { media_type: 'tv', status: 'Ended', imdb_rating: '8.0', year: 2022, ...o });
    series('Strict Show', { genres: '["Science Fiction","Horror"]', keywords: '["time loop"]' });
    for (const name of ['Severed', 'Pantheonic', 'Dark Matters', 'Loki-ish', 'Bodies Found', 'Peripheral Vision']) {
      series(name, { genres: '["Science Fiction","Drama"]', keywords: '["alternate reality"]' });
    }
    series('Plain Drama', { genres: '["Drama"]', keywords: '["alternate reality"]' });
    series('Low Rated', { genres: '["Science Fiction"]', keywords: '["time loop"]', imdb_rating: '6.5' });
    series('A Film', { media_type: 'movie', status: 'Released', genres: '["Science Fiction"]', keywords: '["time loop"]' });

    const asked = { ...parseRequest('Sci-fi mind bending scary', NOW), mediaType: 'tv' as const, minImdb: 7.0 };
    expect(asked.must.map(c => [c.label, c.soft === true])).toEqual([['Sci-fi', false], ['Mind-bending', true], ['Scary', true]]);

    const r = retrieveUnderRules(db, asked, query());
    expect(r.inWindow.map(t => t.title)).toEqual(['Strict Show']);
    expect(r.close.map(t => t.title).sort()).toEqual(['Bodies Found', 'Dark Matters', 'Loki-ish', 'Pantheonic', 'Peripheral Vision', 'Severed']);
  });
});

describe('requestSlate', () => {
  it('offers both films and series, up to SLATE_PER_MEDIA of each, when film vs series is open', () => {
    const db = createDb();
    for (let i = 0; i < SLATE_PER_MEDIA + 5; i++) seed(db, `Film ${i}`);
    for (let i = 0; i < 5; i++) seed(db, `Series ${i}`, { media_type: 'tv', status: 'Ended', embedding: vec(4) });
    const r = retrieveUnderRules(db, rules({}), query());
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
