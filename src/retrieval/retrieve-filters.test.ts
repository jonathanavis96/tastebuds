/**
 * End-to-end: hard filters + widening + rerank through the real retrieval paths.
 * Seeds a catalogue of "good" titles alongside the exact kinds of junk that used
 * to leak into picks (unreleased, zero-vote, non-English, shorts, pre-1980) and
 * checks none of it comes back through any path.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import { DEFAULT_HARD_FILTERS } from './filters.js';
import {
  retrieveCandidatePool,
  retrieveJointCandidatePool,
  retrieveRequestCandidates,
  retrieveJointRequestCandidates,
  retrieveColdStartPool,
  REQUEST_CANDIDATE_LIMIT,
  MIN_POOL_ROWS,
} from './retrieve.js';
import type { Config } from '../config.js';

const mockConfig: Pick<Config, 'ollamaUrl'> = { ollamaUrl: 'http://localhost:11434' };
const DIM = 8;

function vec(hot: number, spread = 0): Buffer {
  const arr = new Float32Array(DIM);
  arr[hot] = 1;
  if (spread) arr[(hot + 1) % DIM] = spread;
  return Buffer.from(arr.buffer);
}

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  runMigrations(db);
  return db;
}

let nextTmdb = 1;
function seedTitle(db: InstanceType<typeof Database>, title: string, overrides: Record<string, unknown> = {}): number {
  upsertTitle(db, {
    tmdb_id: nextTmdb++, media_type: 'movie', title, year: 2012,
    genres: '["Thriller"]', keywords: '[]', cast: '[]', synopsis: title, poster_path: null,
    embedding: vec(0, 0.2), updated_at: '2026-01-01',
    original_language: 'en', runtime_minutes: 105, vote_average: 7.2, vote_count: 1500,
    status: 'Released', popularity: 30,
    ...overrides,
  });
  return (db.prepare('SELECT id FROM titles WHERE title = ?').get(title) as { id: number }).id;
}

function seedProfile(db: InstanceType<typeof Database>, name: string, isDerived = 0, withVector = true): number {
  upsertProfile(db, { name, media_weighting: 0.5, is_derived: isDerived, config: '{}' });
  const id = (db.prepare('SELECT id FROM profiles WHERE name = ?').get(name) as { id: number }).id;
  upsertTasteSignature(db, {
    profile_id: id, taste_vector: withVector ? vec(0) : null,
    prefs: JSON.stringify({ loved_genres: ['Thriller'], hated_genres: [] }), refreshed_at: '',
  });
  return id;
}

/** 30 good movies + 30 good series, all close to the taste vector. */
function seedGoodCatalogue(db: InstanceType<typeof Database>): void {
  for (let i = 0; i < 30; i++) {
    seedTitle(db, `Good Movie ${i}`, { embedding: vec(0, i / 100) });
    seedTitle(db, `Good Series ${i}`, { media_type: 'tv', runtime_minutes: 45, vote_count: 400, status: 'Ended', embedding: vec(0, i / 100) });
  }
}

/** The junk that used to reach picks — every row is CLOSER to taste than the good ones. */
const JUNK: Array<[string, Record<string, unknown>]> = [
  ['Unreleased 2027', { year: 2027, status: 'Post Production', vote_count: 0, vote_average: 0 }],
  ['Zero Votes', { vote_count: 0 }],
  ['Obscure', { vote_count: 40 }],
  ['Mandarin Drama', { original_language: 'zh' }],
  ['Fourteen Minute Short', { runtime_minutes: 14 }],
  ['Silent Era', { year: 1927 }],
  ['Low Rated', { vote_average: 4.8 }],
  ['No Metadata', { original_language: null, runtime_minutes: null, vote_average: null, vote_count: null, status: null }],
  ['Announced Series', { media_type: 'tv', status: 'Planned', vote_count: 0 }],
];

function seedJunk(db: InstanceType<typeof Database>): string[] {
  return JUNK.map(([title, o]) => { seedTitle(db, title, { ...o, embedding: vec(0) }); return title; });
}

const embedFn = async () => Array.from(vec(0, 0.1).buffer.byteLength ? new Float32Array(vec(0, 0.1).buffer) : []);

describe('hard filters through the real retrieval paths', () => {
  it('solo pool: no junk in any group, and the groups are full', async () => {
    const db = createTestDb();
    const pid = seedProfile(db, 'A');
    seedGoodCatalogue(db);
    const junk = seedJunk(db);
    const pool = await retrieveCandidatePool(db, pid, { hardFilters: DEFAULT_HARD_FILTERS }, mockConfig);
    const all = [...pool.onTaste, ...pool.wildcards, ...pool.adversarial].map(c => c.title);
    for (const j of junk) expect(all).not.toContain(j);
    expect(pool.onTaste).toHaveLength(20);
    expect(pool.onTaste.filter(c => c.media_type === 'movie')).toHaveLength(10);
    expect(pool.wildcards).toHaveLength(12);
    expect(pool.adversarial).toHaveLength(8);
  });

  it('joint pool and joint request: no junk, and titles engaged by either partner are out', async () => {
    const db = createTestDb();
    const a = seedProfile(db, 'A');
    const b = seedProfile(db, 'B');
    const j = seedProfile(db, 'J', 1, false);
    seedGoodCatalogue(db);
    const junk = seedJunk(db);
    const seenByB = seedTitle(db, 'Seen By B', { embedding: vec(0) });
    upsertWatchEvent(db, { profile_id: b, title_id: seenByB, status: 'watched', rating: 5, watched_at: null });

    const opts = { hardFilters: DEFAULT_HARD_FILTERS, jointProfileId: j };
    const pool = await retrieveJointCandidatePool(db, a, b, opts, mockConfig);
    const req = await retrieveJointRequestCandidates(db, a, b, 'thriller', opts, mockConfig, embedFn);
    const all = [...pool.onTaste, ...pool.wildcards, ...pool.adversarial, ...req].map(c => c.title);
    for (const jk of junk) expect(all).not.toContain(jk);
    expect(all).not.toContain('Seen By B');
    expect(req.length).toBeGreaterThanOrEqual(10);
    expect(req.length).toBeLessThanOrEqual(REQUEST_CANDIDATE_LIMIT);
  });

  it('cold start pool honours the filters too', async () => {
    const db = createTestDb();
    const pid = seedProfile(db, 'A', 0, false);
    seedGoodCatalogue(db);
    const junk = seedJunk(db);
    const pool = await retrieveColdStartPool(db, pid, { hardFilters: DEFAULT_HARD_FILTERS }, mockConfig);
    const all = [...pool.onTaste, ...pool.wildcards].map(c => c.title);
    for (const j of junk) expect(all).not.toContain(j);
    expect(pool.onTaste.length).toBeGreaterThan(0);
  });

  it('skips the stage entirely when hardFilters is undefined (legacy callers)', async () => {
    const db = createTestDb();
    const pid = seedProfile(db, 'A');
    seedJunk(db);
    const pool = await retrieveCandidatePool(db, pid, {}, mockConfig);
    expect(pool.onTaste.length).toBeGreaterThan(0);
  });
});

describe('widening through the request path', () => {
  it('widens year → runtime → votes in order until the pool minimum is met, and reports the steps', async () => {
    const db = createTestDb();
    const pid = seedProfile(db, 'A');
    // 4 strict-passing movies, 4 more unlocked at year>=1985, 4 more at runtime>=40,
    // 8 more at votes>=100 — 20 in total, which is MIN_POOL_ROWS, so the ladder stops there.
    for (let i = 0; i < 4; i++) seedTitle(db, `Strict ${i}`);
    for (let i = 0; i < 4; i++) seedTitle(db, `Eighties ${i}`, { year: 1986 });
    for (let i = 0; i < 4; i++) seedTitle(db, `Short ${i}`, { runtime_minutes: 45 });
    for (let i = 0; i < 8; i++) seedTitle(db, `Lesser Known ${i}`, { vote_count: 120 });
    seedTitle(db, 'Still Junk', { vote_count: 3 });

    let steps: string[] = [];
    const req = await retrieveRequestCandidates(
      db, pid, 'thriller',
      { hardFilters: DEFAULT_HARD_FILTERS, mediaType: 'movie', onWidened: s => { steps = s; } },
      mockConfig, embedFn,
    );
    const titles = req.map(c => c.title);
    expect(steps).toEqual(['year>=1990', 'year>=1985', 'year>=1980', 'runtime>=40', 'votes>=100/25']);
    expect(titles.filter(t => t.startsWith('Strict'))).toHaveLength(4);
    expect(titles.filter(t => t.startsWith('Eighties'))).toHaveLength(4);
    expect(titles.filter(t => t.startsWith('Short'))).toHaveLength(4);
    expect(titles.filter(t => t.startsWith('Lesser'))).toHaveLength(8);
    expect(titles).not.toContain('Still Junk');
    expect(req.length).toBe(MIN_POOL_ROWS);
  });

  it('does not widen when the strict pool is already big enough', async () => {
    const db = createTestDb();
    const pid = seedProfile(db, 'A');
    seedGoodCatalogue(db);
    let steps: string[] | undefined;
    await retrieveRequestCandidates(db, pid, 'thriller', { hardFilters: DEFAULT_HARD_FILTERS, onWidened: s => { steps = s; } }, mockConfig, embedFn);
    expect(steps).toEqual([]);
  });
});

describe('votes change the output (rerank proof)', () => {
  it('the same catalogue orders differently once a genre is rated low', async () => {
    const db = createTestDb();
    const pid = seedProfile(db, 'A');
    // Equal similarity, equal quality: only genre affinity can separate these.
    for (let i = 0; i < 6; i++) seedTitle(db, `Romance ${i}`, { genres: '["Romance"]', embedding: vec(0) });
    for (let i = 0; i < 6; i++) seedTitle(db, `Thriller ${i}`, { genres: '["Thriller"]', embedding: vec(0) });
    // Extra rated titles (not candidates): 5 thrillers loved, 5 romances hated.
    for (let i = 0; i < 5; i++) {
      const t = seedTitle(db, `Rated Thriller ${i}`, { genres: '["Thriller"]', embedding: vec(3) });
      upsertWatchEvent(db, { profile_id: pid, title_id: t, status: 'watched', rating: 5, watched_at: null });
      const r = seedTitle(db, `Rated Romance ${i}`, { genres: '["Romance"]', embedding: vec(3) });
      upsertWatchEvent(db, { profile_id: pid, title_id: r, status: 'watched', rating: 1, watched_at: null });
    }
    const pool = await retrieveCandidatePool(db, pid, { hardFilters: DEFAULT_HARD_FILTERS, mediaType: 'movie' }, mockConfig);
    const titles = pool.onTaste.map(c => c.title);
    // Romance is now vetoed outright (rated consistently 1★), thrillers fill the slate.
    expect(titles.every(t => t.startsWith('Thriller'))).toBe(true);
    expect(titles).toHaveLength(6);
  });
});
