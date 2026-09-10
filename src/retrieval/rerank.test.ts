import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import {
  DEFAULT_RERANK_WEIGHTS,
  genreAffinityForProfile,
  jointGenreAffinity,
  qualityScore,
  rerank,
  GENRE_VETO_THRESHOLD,
} from './rerank.js';
import type { CandidateTitle } from './retrieve.js';

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  runMigrations(db);
  return db;
}

function cand(overrides: Partial<CandidateTitle> & { title: string }): CandidateTitle {
  return {
    id: 0, tmdb_id: 0, media_type: 'movie', year: 2015, genres: '["Drama"]', keywords: '[]', cast: '[]',
    synopsis: null, poster_path: null, embedding: null, updated_at: '', imdb_id: null, imdb_rating: null,
    rt_rating: null, rt_url: null, popularity: 20, vote_count: 2000, rating_checked_at: null,
    original_language: 'en', runtime_minutes: 100, vote_average: 7, status: 'Released', meta_checked_at: null,
    score: 0.3,
    ...overrides,
  };
}

function seedProfile(db: InstanceType<typeof Database>, name: string, prefs: object = {}): number {
  upsertProfile(db, { name, media_weighting: 0.5, is_derived: 0, config: '{}' });
  const id = (db.prepare('SELECT id FROM profiles WHERE name = ?').get(name) as { id: number }).id;
  upsertTasteSignature(db, { profile_id: id, taste_vector: null, prefs: JSON.stringify(prefs), refreshed_at: '' });
  return id;
}

function rate(db: InstanceType<typeof Database>, pid: number, genres: string[], rating: number): void {
  upsertTitle(db, {
    tmdb_id: Math.floor(Math.random() * 1e9), media_type: 'movie', title: 't', year: 2015,
    genres: JSON.stringify(genres), keywords: '[]', cast: '[]', synopsis: null, poster_path: null,
    embedding: null, updated_at: '',
  });
  const id = (db.prepare('SELECT max(id) AS id FROM titles').get() as { id: number }).id;
  upsertWatchEvent(db, { profile_id: pid, title_id: id, status: 'watched', rating, watched_at: null });
}

describe('genreAffinityForProfile', () => {
  it('is positive for genres rated above the profile mean and negative below it', () => {
    const db = createTestDb();
    const pid = seedProfile(db, 'A');
    for (let i = 0; i < 5; i++) rate(db, pid, ['Thriller'], 5);
    for (let i = 0; i < 5; i++) rate(db, pid, ['Romance'], 1);
    for (let i = 0; i < 5; i++) rate(db, pid, ['Drama'], 3);
    const aff = genreAffinityForProfile(db, pid);
    expect(aff.Thriller).toBeGreaterThan(0.3);
    expect(aff.Romance).toBeLessThan(-0.3);
    expect(Math.abs(aff.Drama)).toBeLessThan(0.1);
  });

  it('shrinks a single rating toward zero', () => {
    const db = createTestDb();
    const pid = seedProfile(db, 'A');
    for (let i = 0; i < 5; i++) rate(db, pid, ['Drama'], 3);
    rate(db, pid, ['Western'], 5);
    const aff = genreAffinityForProfile(db, pid);
    expect(aff.Western).toBeGreaterThan(0);
    expect(aff.Western).toBeLessThan(0.4);
  });

  it('folds stated hated and loved genres in when there are no ratings for them', () => {
    const db = createTestDb();
    const pid = seedProfile(db, 'A', { loved_genres: ['Mystery'], hated_genres: ['Horror'] });
    const aff = genreAffinityForProfile(db, pid);
    expect(aff.Horror).toBe(-1);
    expect(aff.Mystery).toBeGreaterThan(0);
  });

  it('returns an empty map for a profile with no ratings and no prefs', () => {
    const db = createTestDb();
    const pid = seedProfile(db, 'A');
    expect(genreAffinityForProfile(db, pid)).toEqual({});
  });
});

describe('jointGenreAffinity', () => {
  it('vetoes a genre either partner strongly dislikes and blends the rest', () => {
    const { affinity, vetoed } = jointGenreAffinity(
      { Horror: -0.8, Thriller: 0.6, Comedy: 0.2 },
      { Horror: 0.9, Thriller: 0.4 },
      { Thriller: 0.8 },
    );
    expect(vetoed.has('Horror')).toBe(true);
    expect(vetoed.has('Thriller')).toBe(false);
    expect(affinity.Thriller).toBeGreaterThan(affinity.Comedy);
    expect(affinity.Thriller).toBeCloseTo(0.65 * 0.8 + 0.175 * 0.6 + 0.175 * 0.4, 5);
  });

  it('uses the threshold constant, not a mere negative', () => {
    const { vetoed } = jointGenreAffinity({ Drama: GENRE_VETO_THRESHOLD + 0.01 }, {}, {});
    expect(vetoed.size).toBe(0);
  });
});

describe('qualityScore', () => {
  it('rewards high average with many votes and shrinks few-vote ratings toward the prior', () => {
    const strong = qualityScore(8.5, 5000, 'movie');
    const fewVotes = qualityScore(8.5, 30, 'movie');
    const weak = qualityScore(5.5, 5000, 'movie');
    expect(strong).toBeGreaterThan(fewVotes);
    expect(fewVotes).toBeGreaterThan(weak);
    expect(strong).toBeLessThanOrEqual(1);
    expect(weak).toBeGreaterThanOrEqual(0);
  });

  it('returns the neutral prior for unknown values', () => {
    expect(qualityScore(null, null, 'tv')).toBeCloseTo(qualityScore(6.5, 0, 'tv'), 5);
  });
});

describe('rerank', () => {
  it('drops candidates in a vetoed genre', () => {
    const out = rerank([cand({ title: 'Gore', genres: '["Horror"]' }), cand({ title: 'Ok' })], {}, new Set(['Horror']));
    expect(out.map(c => c.title)).toEqual(['Ok']);
  });

  it('votes change the order: the same two titles swap when the genre affinity flips', () => {
    const a = cand({ title: 'Thrill', genres: '["Thriller"]', score: 0.30 });
    const b = cand({ title: 'Rom', genres: '["Romance"]', score: 0.30 });
    const likesThrillers = rerank([a, b], { Thriller: 0.8, Romance: -0.8 }, new Set());
    const likesRomance = rerank([a, b], { Thriller: -0.8, Romance: 0.8 }, new Set());
    expect(likesThrillers.map(c => c.title)).toEqual(['Thrill', 'Rom']);
    expect(likesRomance.map(c => c.title)).toEqual(['Rom', 'Thrill']);
  });

  it('prefers a well-rated popular title over an obscure one at equal similarity and affinity', () => {
    const hit = cand({ title: 'Hit', vote_average: 8.2, vote_count: 9000, popularity: 80 });
    const obscure = cand({ title: 'Obscure', vote_average: 6.1, vote_count: 320, popularity: 2 });
    expect(rerank([obscure, hit], {}, new Set()).map(c => c.title)).toEqual(['Hit', 'Obscure']);
  });

  it('still lets a much closer taste match beat a slightly better-rated one', () => {
    const close = cand({ title: 'Close', score: 0.05, vote_average: 6.8, vote_count: 1000 });
    const far = cand({ title: 'Far', score: 0.6, vote_average: 7.4, vote_count: 1500 });
    expect(rerank([far, close], {}, new Set())[0].title).toBe('Close');
  });

  it('rescales similarity within the batch so the closest candidate always leads at equal taste and quality', () => {
    // Real distances sit in a narrow band; the 0.04 gap must still be decisive when nothing else differs.
    const near = cand({ title: 'Near', score: 0.31 });
    const far = cand({ title: 'Far', score: 0.35 });
    const out = rerank([far, near], {}, new Set());
    expect(out.map(c => c.title)).toEqual(['Near', 'Far']);
    expect(out[0].rank_score - out[1].rank_score).toBeCloseTo(DEFAULT_RERANK_WEIGHTS.similarity, 5);
  });

  it('attaches a rank_score and keeps the cosine distance in score', () => {
    const out = rerank([cand({ title: 'X', score: 0.25 })], {}, new Set());
    expect(out[0].score).toBe(0.25);
    expect(out[0].rank_score).toBeGreaterThan(0);
  });
});
