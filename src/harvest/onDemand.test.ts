/**
 * Tests for ensureRulesCoverage and mergeRequestGenresToProfile.
 *
 * All TMDB and embed calls are injected via the deps parameter — no network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { getTitleByTmdbId, upsertTitle } from '../db/repos/titles.js';
import { getUsage, bumpRequestAdded } from '../db/repos/apiUsage.js';
import { getTasteSignature, upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import {
  ensureRulesCoverage,
  exactKeywordIdCache,
  keywordIdCache,
  mergeRequestGenresToProfile,
  type OnDemandDeps,
} from './onDemand.js';
import { defaultRules, type RequestRules, type RuleClause } from '../request/rules.js';
import type { Config } from '../config.js';
import type { DiscoverOpts, TmdbTitle, TmdbTitleDetail } from '../tmdb/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const mockConfig: Config = {
  tmdbApiKey: 'test-key',
  ollamaUrl: 'http://localhost:11434',
  claudeToken: 'test-token',
  port: 8094,
  dbPath: ':memory:',
  omdbApiKey: undefined,
  harvestDailyTarget: 500,
  requestLookupDailyBudget: 10,
  harvestMaxPage: 30,
};

/** A horror TV series returned by the keyword discovery path. */
const horrorTvTitle: TmdbTitle = {
  id: 87108,
  name: 'The Terror',
  first_air_date: '2018-03-26',
  genre_ids: [9648, 18],
  overview: 'A crew is trapped in the Arctic, stalked by a monster.',
  poster_path: '/terror.jpg',
};

const horrorTvDetail: TmdbTitleDetail = {
  ...horrorTvTitle,
  genres: [{ id: 9648, name: 'Mystery' }, { id: 18, name: 'Drama' }],
  keywords: { results: [{ name: 'horror' }, { name: 'survival' }] },
  credits: { cast: [{ name: 'Jared Harris' }] },
};

/** Build a minimal stub deps object. All fns are vi.fn() stubs by default. */
function makeDeps(overrides: Partial<OnDemandDeps> = {}): OnDemandDeps {
  return {
    discoverTitles: vi.fn().mockResolvedValue([]),
    getTitleDetails: vi.fn().mockResolvedValue(horrorTvDetail),
    searchTitles: vi.fn().mockResolvedValue([]),
    searchKeyword: vi.fn().mockResolvedValue([{ id: 315058, name: 'horror' }]),
    embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    applyCachedImdbRatings: vi.fn().mockResolvedValue(0),
    now: () => Date.now(),
    ...overrides,
  };
}

// ── mergeRequestGenresToProfile ───────────────────────────────────────────────

/** Insert a bare profile row and return its auto-assigned id. */
function insertTestProfile(db: InstanceType<typeof Database>): number {
  db.prepare(
    `INSERT INTO profiles (name, media_weighting, is_derived, config) VALUES (?, 0.5, 0, '{}')`,
  ).run('TestProfile_' + Math.random().toString(36).slice(2));
  return (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
}

describe('mergeRequestGenresToProfile', () => {
  it('merges new genre into existing loved_genres (existing first, new appended)', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);

    // Pre-seed a taste signature with Drama in loved_genres
    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: null,
      prefs: JSON.stringify({ loved_genres: ['Drama'] }),
      refreshed_at: new Date().toISOString(),
    });

    // "mind-bending sci-fi": a Science Fiction clause and a theme clause
    mergeRequestGenresToProfile(db, profileId, { must: [genreClause('Science Fiction'), termClause('mind-bending', 'mind bending')] });

    const sig = getTasteSignature(db, profileId);
    const prefs = JSON.parse(sig!.prefs) as { loved_genres: string[] };
    expect(prefs.loved_genres).toEqual(['Drama', 'Science Fiction']);
  });

  it('does not duplicate a genre already in loved_genres', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);

    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: null,
      prefs: JSON.stringify({ loved_genres: ['Drama', 'Science Fiction'] }),
      refreshed_at: new Date().toISOString(),
    });

    // Science Fiction again: no second copy
    mergeRequestGenresToProfile(db, profileId, { must: [genreClause('Science Fiction'), termClause('mind-bending', 'mind bending')] });

    const sig = getTasteSignature(db, profileId);
    const prefs = JSON.parse(sig!.prefs) as { loved_genres: string[] };
    expect(prefs.loved_genres).toEqual(['Drama', 'Science Fiction']);
  });

  it('caps loved_genres at 12, dropping the oldest when over cap', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);

    // 12 filler genres — all unique, not resolvable from request text
    const fillerGenres = ['G1','G2','G3','G4','G5','G6','G7','G8','G9','G10','G11','G12'];
    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: null,
      prefs: JSON.stringify({ loved_genres: fillerGenres }),
      refreshed_at: new Date().toISOString(),
    });

    // Horror would push the list to 13, so the cap kicks in
    mergeRequestGenresToProfile(db, profileId, { must: [genreClause('Horror')] });

    const sig = getTasteSignature(db, profileId);
    const prefs = JSON.parse(sig!.prefs) as { loved_genres: string[] };
    expect(prefs.loved_genres).toHaveLength(12);
    // Horror (newest) must be present; G1 (oldest) must have been dropped
    expect(prefs.loved_genres).toContain('Horror');
    expect(prefs.loved_genres).not.toContain('G1');
  });

  it('does nothing when no clause names a single genre (an either-or clause, a theme)', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);

    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: null,
      prefs: JSON.stringify({ loved_genres: ['Drama'] }),
      refreshed_at: new Date().toISOString(),
    });

    mergeRequestGenresToProfile(db, profileId, { must: [genreClause('Thriller', 'Horror'), termClause('medical', 'hospital')] });

    const sig = getTasteSignature(db, profileId);
    const prefs = JSON.parse(sig!.prefs) as { loved_genres: string[] };
    expect(prefs.loved_genres).toEqual(['Drama']);
  });

  it('preserves other prefs keys (hated_genres, loved_themes, etc.) unchanged', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);

    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: null,
      prefs: JSON.stringify({
        loved_genres: [],
        hated_genres: ['Horror'],
        loved_themes: ['friendship'],
        preferred_era: '2000s',
      }),
      refreshed_at: new Date().toISOString(),
    });

    mergeRequestGenresToProfile(db, profileId, { must: [genreClause('Drama')] });

    const sig = getTasteSignature(db, profileId);
    const prefs = JSON.parse(sig!.prefs) as {
      loved_genres: string[];
      hated_genres: string[];
      loved_themes: string[];
      preferred_era: string;
    };
    expect(prefs.loved_genres).toContain('Drama');
    expect(prefs.hated_genres).toEqual(['Horror']);
    expect(prefs.loved_themes).toEqual(['friendship']);
    expect(prefs.preferred_era).toBe('2000s');
  });

  it('preserves existing taste_vector when updating prefs', () => {
    const db = createTestDb();
    const profileId = insertTestProfile(db);

    const fakeVec = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer);
    upsertTasteSignature(db, {
      profile_id: profileId,
      taste_vector: fakeVec,
      prefs: JSON.stringify({ loved_genres: ['Drama'] }),
      refreshed_at: '2026-01-01T00:00:00.000Z',
    });

    mergeRequestGenresToProfile(db, profileId, { must: [genreClause('Horror')] });

    const sig = getTasteSignature(db, profileId);
    // taste_vector must survive the prefs update
    expect(sig!.taste_vector).toEqual(fakeVec);
    // refreshed_at must not be bumped
    expect(sig!.refreshed_at).toBe('2026-01-01T00:00:00.000Z');
  });
});

// ── ensureRulesCoverage ──────────────────────────────────────────────────────

const NOW = Date.parse('2026-11-19T12:00:00Z');
const TODAY = '2026-11-19';

function rulesWith(overrides: Partial<RequestRules>): RequestRules {
  return { ...defaultRules(new Date(NOW)), ...overrides };
}

const genreClause = (...genres: RuleClause['genres']): RuleClause => ({ label: genres.join('/'), genres, terms: [] });
const termClause = (label: string, ...terms: string[]): RuleClause => ({ label, genres: [], terms });

/** "Thriller new 2025" as the parser reads it, for films. */
const thrillerNew2025 = rulesWith({ mediaType: 'movie', yearMin: 2025, yearSource: 'stated', must: [genreClause('Thriller')] });

const listing = (ids: number[]): TmdbTitle[] =>
  ids.map((id) => ({ id, title: `Title ${id}`, genre_ids: [], overview: '', poster_path: null }));

function detailFor(id: number, mediaType: 'movie' | 'tv'): TmdbTitleDetail {
  return {
    id,
    ...(mediaType === 'movie' ? { title: `Title ${id}`, release_date: '2025-05-01' } : { name: `Title ${id}`, first_air_date: '2025-05-01' }),
    genre_ids: [53],
    overview: 'A tense chase.',
    poster_path: null,
    genres: [{ id: 53, name: 'Thriller' }],
  };
}

/** Deps whose discover returns `perCall` fresh ids on every call, and whose details echo the id asked for. */
function rulesDeps(overrides: Partial<OnDemandDeps> = {}, perCall = 3): OnDemandDeps {
  let nextId = 1000;
  return makeDeps({
    discoverTitles: vi.fn().mockImplementation(async () => listing(Array.from({ length: perCall }, () => nextId++))),
    getTitleDetails: vi.fn().mockImplementation(async (id: number, mt: 'movie' | 'tv') => detailFor(id, mt)),
    searchKeyword: vi.fn().mockImplementation(async (q: string) => [{ id: KEYWORD_IDS[q] ?? 1, name: KEYWORD_IDS[q] ? q : `${q} film` }]),
    now: () => NOW,
    ...overrides,
  });
}

const KEYWORD_IDS: Record<string, number> = { thriller: 316362, horror: 315058, hospital: 1125, doctor: 2132, nun: 745 };

const discoverCalls = (deps: OnDemandDeps): DiscoverOpts[] =>
  vi.mocked(deps.discoverTitles).mock.calls.map(([opts]) => opts);

describe('ensureRulesCoverage — what TMDB is asked for', () => {
  beforeEach(() => {
    keywordIdCache.clear();
    exactKeywordIdCache.clear();
  });

  it('asks for films of genre 53 released from 2025 to today, by popularity and by votes, two pages each', async () => {
    const db = createTestDb();
    const deps = rulesDeps();

    await ensureRulesCoverage(db, thrillerNew2025, undefined, mockConfig, deps);

    const calls = discoverCalls(deps);
    expect(calls.map((c) => `${c.sortBy} p${c.page}`).sort()).toEqual([
      'popularity.desc p1', 'popularity.desc p2', 'vote_count.desc p1', 'vote_count.desc p2',
    ]);
    for (const c of calls) {
      expect(c).toMatchObject({
        mediaType: 'movie', genreIds: [53], releasedFrom: '2025-01-01', releasedTo: TODAY,
        originalLanguage: 'en', voteCountGte: 50,
      });
    }
  });

  it('asks for series by the thriller keyword, since TMDB has no TV thriller genre', async () => {
    const db = createTestDb();
    const deps = rulesDeps();
    const rules = { ...thrillerNew2025, mediaType: 'tv' as const };

    await ensureRulesCoverage(db, rules, undefined, mockConfig, deps);

    const calls = discoverCalls(deps);
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c).toMatchObject({ mediaType: 'tv', genreIds: [], keywordIds: [316362], releasedFrom: '2025-01-01', releasedTo: TODAY, voteCountGte: 20 });
    }
  });

  it('sends the genres of one either-or clause as an OR', async () => {
    const db = createTestDb();
    const deps = rulesDeps();
    const rules = { ...thrillerNew2025, must: [genreClause('Thriller', 'Horror')] };

    await ensureRulesCoverage(db, rules, undefined, mockConfig, deps);

    expect(discoverCalls(deps)[0]).toMatchObject({ genreIds: [53, 27], genreMatch: 'any' });
  });

  it('splits an either-or clause next to another clause into one AND query per choice', async () => {
    const db = createTestDb();
    const deps = rulesDeps();
    const rules = { ...thrillerNew2025, must: [genreClause('Thriller', 'Horror'), genreClause('Science Fiction')] };

    await ensureRulesCoverage(db, rules, undefined, mockConfig, deps);

    const shapes = new Set(discoverCalls(deps).map((c) => `${c.genreIds?.join(',')} ${c.genreMatch}`));
    expect([...shapes].sort()).toEqual(['27,878 all', '53,878 all']);
  });

  it('asks for a theme by the keywords that name up to six of its terms exactly, as an OR', async () => {
    const db = createTestDb();
    const deps = rulesDeps();
    const medical = termClause('medical', 'medical', 'hospital', 'doctor', 'surgeon', 'nurse', 'clinic', 'paramedic', 'er');
    const rules = { ...thrillerNew2025, must: [genreClause('Drama'), medical] };

    await ensureRulesCoverage(db, rules, undefined, mockConfig, deps);

    const searched = vi.mocked(deps.searchKeyword).mock.calls.map(([q]) => q);
    expect(searched).toEqual(['medical', 'hospital', 'doctor', 'surgeon', 'nurse', 'clinic']);
    // "medical" only matched "medical film", so it is not used.
    expect(discoverCalls(deps)[0]).toMatchObject({ genreIds: [18], keywordIds: [1125, 2132], keywordMatch: 'any' });
  });

  it('leaves out excluded genres and excluded words that name a keyword', async () => {
    const db = createTestDb();
    const deps = rulesDeps();
    const rules = rulesWith({
      mediaType: 'movie',
      must: [genreClause('Comedy')],
      mustNot: [genreClause('Horror'), termClause('nun', 'nun', 'nuns', 'convent')],
    });

    await ensureRulesCoverage(db, rules, undefined, mockConfig, deps);

    expect(discoverCalls(deps)[0]).toMatchObject({ genreIds: [35], withoutGenreIds: [27], withoutKeywordIds: [745] });
  });

  it('excludes a series genre that TMDB only has as a keyword through without_keywords', async () => {
    const db = createTestDb();
    const deps = rulesDeps();
    const rules = rulesWith({ mediaType: 'tv', must: [genreClause('Comedy')], mustNot: [genreClause('Horror')] });

    await ensureRulesCoverage(db, rules, undefined, mockConfig, deps);

    expect(discoverCalls(deps)[0]).toMatchObject({ genreIds: [35], withoutGenreIds: [], withoutKeywordIds: [315058] });
  });

  it('uses the language the request names', async () => {
    const db = createTestDb();
    const deps = rulesDeps();

    await ensureRulesCoverage(db, { ...thrillerNew2025, language: 'ko' }, undefined, mockConfig, deps);

    expect(discoverCalls(deps)[0].originalLanguage).toBe('ko');
  });

  it('searches the app filter media type when the request names none, and both when neither does', async () => {
    const rules = { ...thrillerNew2025, mediaType: null };
    const tvOnly = rulesDeps();
    await ensureRulesCoverage(createTestDb(), rules, 'tv', mockConfig, tvOnly);
    expect(new Set(discoverCalls(tvOnly).map((c) => c.mediaType))).toEqual(new Set(['tv']));

    const both = rulesDeps();
    await ensureRulesCoverage(createTestDb(), rules, undefined, mockConfig, both);
    expect(new Set(discoverCalls(both).map((c) => c.mediaType))).toEqual(new Set(['movie', 'tv']));
  });

  it('the request media type wins over the app filter', async () => {
    const deps = rulesDeps();
    await ensureRulesCoverage(createTestDb(), thrillerNew2025, 'tv', mockConfig, deps);
    expect(new Set(discoverCalls(deps).map((c) => c.mediaType))).toEqual(new Set(['movie']));
  });
});

describe('ensureRulesCoverage — nothing unreleased', () => {
  it('caps the window at today even when the rules allow later years', async () => {
    const deps = rulesDeps();
    const rules = rulesWith({ mediaType: 'movie', yearMin: 2025, yearMax: 2030, must: [genreClause('Thriller')] });

    await ensureRulesCoverage(createTestDb(), rules, undefined, mockConfig, deps);

    for (const c of discoverCalls(deps)) expect(c.releasedTo).toBe(TODAY);
  });

  it('keeps a past upper year as the end of that year', async () => {
    const deps = rulesDeps();
    const rules = rulesWith({ mediaType: 'movie', yearMin: 1990, yearMax: 1999, yearSource: 'stated' });

    await ensureRulesCoverage(createTestDb(), rules, undefined, mockConfig, deps);

    expect(discoverCalls(deps)[0]).toMatchObject({ releasedFrom: '1990-01-01', releasedTo: '1999-12-31' });
  });

  it('asks TMDB nothing when the whole window is in the future', async () => {
    const deps = rulesDeps();
    const rules = rulesWith({ mediaType: 'movie', yearMin: 2027, yearSource: 'stated' });

    const result = await ensureRulesCoverage(createTestDb(), rules, undefined, mockConfig, deps);

    expect(deps.discoverTitles).not.toHaveBeenCalled();
    expect(result.added).toBe(0);
  });
});

describe('ensureRulesCoverage — references', () => {
  it('finds a reference by the longest prefix of its phrase that matches a title exactly, and adds it first', async () => {
    const db = createTestDb();
    const searchTitles = vi.fn().mockImplementation(async (q: string, mt: 'movie' | 'tv') => {
      if (q !== 'inception') return listing([5]);
      return mt === 'movie' ? [{ ...listing([27205])[0], title: 'Inception' }] : [{ ...listing([9])[0], name: 'Inception Point' }];
    });
    const deps = rulesDeps({ searchTitles });
    const rules = rulesWith({ mediaType: 'movie', must: [genreClause('Thriller')], similarTo: ['inception something on those lines'] });

    const result = await ensureRulesCoverage(db, rules, undefined, mockConfig, deps);

    const queries = [...new Set(searchTitles.mock.calls.map(([q]) => q))];
    expect(queries).toEqual([
      'inception something on those lines', 'inception something on those', 'inception something on',
      'inception something', 'inception',
    ]);
    expect(vi.mocked(deps.getTitleDetails).mock.calls[0]).toEqual([27205, 'movie', mockConfig]);
    expect(getTitleByTmdbId(db, 27205, 'movie')).not.toBeNull();
    expect(getTitleByTmdbId(db, 9, 'tv')).toBeNull();
    expect(result.errors).toEqual([]);
  });

  it('never searches the request text itself', async () => {
    const deps = rulesDeps();
    await ensureRulesCoverage(createTestDb(), thrillerNew2025, undefined, mockConfig, deps);
    expect(deps.searchTitles).not.toHaveBeenCalled();
  });

  it('does not search a lone article left from a phrase', async () => {
    const deps = rulesDeps();
    const rules = rulesWith({ mediaType: 'movie', similarTo: ['The Drama'] });
    await ensureRulesCoverage(createTestDb(), rules, undefined, mockConfig, deps);
    expect([...new Set(vi.mocked(deps.searchTitles).mock.calls.map(([q]) => q))]).toEqual(['The Drama']);
  });
});

describe('ensureRulesCoverage — bounded ingestion', () => {
  it('adds at most 40 new titles, six at a time, and skips stored ones', async () => {
    const db = createTestDb();
    upsertTitle(db, {
      tmdb_id: 1000, media_type: 'movie', title: 'Stored', year: 2025, genres: '[]', keywords: '[]',
      cast: '[]', synopsis: null, poster_path: null, embedding: null, updated_at: new Date().toISOString(),
    });
    let inFlight = 0;
    let most = 0;
    const getTitleDetails = vi.fn().mockImplementation(async (id: number, mt: 'movie' | 'tv') => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return detailFor(id, mt);
    });
    const deps = rulesDeps({ getTitleDetails }, 20);

    const result = await ensureRulesCoverage(db, thrillerNew2025, undefined, { ...mockConfig, requestLookupDailyBudget: 500 }, deps);

    expect(result.added).toBe(40);
    expect(getTitleDetails).toHaveBeenCalledTimes(40);
    expect(getTitleDetails).not.toHaveBeenCalledWith(1000, 'movie', expect.anything());
    expect(most).toBeLessThanOrEqual(6);
    expect(most).toBeGreaterThan(1);
  });

  it('adds a series whose TMDB id is already taken by a stored movie', async () => {
    const db = createTestDb();
    upsertTitle(db, {
      tmdb_id: 1000, media_type: 'movie', title: 'Some Movie', year: 2001, genres: '[]', keywords: '[]',
      cast: '[]', synopsis: null, poster_path: null, embedding: null, updated_at: new Date().toISOString(),
    });
    const deps = rulesDeps({}, 1);

    const result = await ensureRulesCoverage(db, { ...thrillerNew2025, mediaType: 'tv' }, undefined, mockConfig, deps);

    expect(result.added).toBeGreaterThanOrEqual(1);
    expect(getTitleByTmdbId(db, 1000, 'tv')?.title).toBe('Title 1000');
    expect(getTitleByTmdbId(db, 1000, 'movie')?.title).toBe('Some Movie');
  });

  it('starts no new title once ten seconds have passed', async () => {
    let clock = NOW;
    const getTitleDetails = vi.fn().mockImplementation(async (id: number, mt: 'movie' | 'tv') => {
      clock += 2_500;
      return detailFor(id, mt);
    });
    const deps = rulesDeps({ getTitleDetails, now: () => clock }, 20);

    const result = await ensureRulesCoverage(createTestDb(), thrillerNew2025, undefined, { ...mockConfig, requestLookupDailyBudget: 500 }, deps);

    // Started at +0, +2.5 s, +5 s and +7.5 s; at +10 s nothing more starts.
    expect(result.added).toBe(4);
  });

  it('stops at the remaining daily budget and records what it added', async () => {
    const db = createTestDb();
    bumpRequestAdded(db, new Date().toISOString().slice(0, 10), 7);
    const deps = rulesDeps({}, 20);

    const result = await ensureRulesCoverage(db, thrillerNew2025, undefined, mockConfig, deps);

    expect(result.added).toBe(3);
    expect(getUsage(db, new Date().toISOString().slice(0, 10)).request_added).toBe(10);
  });

  it('asks TMDB nothing when the daily budget is spent', async () => {
    const db = createTestDb();
    bumpRequestAdded(db, new Date().toISOString().slice(0, 10), 10);
    const deps = rulesDeps();

    const result = await ensureRulesCoverage(db, thrillerNew2025, undefined, mockConfig, deps);

    expect(result).toEqual({ added: 0, errors: [] });
    expect(deps.discoverTitles).not.toHaveBeenCalled();
  });

  it('gives the new titles their IMDb rating from the cached file', async () => {
    const db = createTestDb();
    const deps = rulesDeps({}, 1);

    await ensureRulesCoverage(db, thrillerNew2025, undefined, mockConfig, deps);

    const ids = vi.mocked(deps.applyCachedImdbRatings).mock.calls[0][2];
    expect(ids).toHaveLength(4);
    expect(ids.map((id) => db.prepare('SELECT tmdb_id FROM titles WHERE id = ?').pluck().get(id))).toEqual(
      expect.arrayContaining([1000, 1001, 1002, 1003]),
    );
  });

  it('records a ratings failure instead of throwing', async () => {
    const deps = rulesDeps({ applyCachedImdbRatings: vi.fn().mockRejectedValue(new Error('no file')) }, 1);

    const result = await ensureRulesCoverage(createTestDb(), thrillerNew2025, undefined, mockConfig, deps);

    expect(result.added).toBe(4);
    expect(result.errors).toEqual([expect.stringContaining('no file')]);
  });

  it('records a failed TMDB call and keeps the results of the others', async () => {
    let calls = 0;
    const discoverTitles = vi.fn().mockImplementation(async () => {
      if (calls++ === 0) throw new Error('HTTP 500');
      return listing([2000 + calls]);
    });
    const deps = rulesDeps({ discoverTitles });

    const result = await ensureRulesCoverage(createTestDb(), thrillerNew2025, undefined, mockConfig, deps);

    expect(result.added).toBe(3);
    expect(result.errors).toEqual([expect.stringContaining('HTTP 500')]);
  });
});
