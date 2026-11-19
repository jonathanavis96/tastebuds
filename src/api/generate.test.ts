/**
 * generatePicks for a typed request, end to end on a real database with the
 * model, the embedder, TMDB and Rotten Tomatoes injected: every stored pick
 * obeys the request's rules.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTitle, getTitleById } from '../db/repos/titles.js';
import { upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import { upsertRecommendation } from '../db/repos/recommendations.js';
import { generatePicks, type GenerateDeps } from './generate.js';
import { parseRequest } from '../request/parse.js';
import { titleObeys } from '../request/enforce.js';
import type { OnDemandDeps } from '../harvest/onDemand.js';
import type { SpawnFn } from '../claude/runJson.js';
import type { Config } from '../config.js';
import type { RecommendationRow } from '../db/types.js';
import type { RequestSummary } from '../request/rules.js';

const NOW = new Date('2026-11-19T12:00:00Z');
const DIM = 8;

const config: Config = {
  tmdbApiKey: 'test', ollamaUrl: 'http://localhost:9', claudeToken: '', port: 8094, dbPath: ':memory:',
  omdbApiKey: undefined, harvestDailyTarget: 500, requestLookupDailyBudget: 500, harvestMaxPage: 30,
};

function vec(hot: number): Buffer {
  const a = new Float32Array(DIM);
  a[hot] = 1;
  return Buffer.from(a.buffer);
}

function setupDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  runMigrations(db);
  upsertProfile(db, { name: 'Alex', media_weighting: 0.5, is_derived: 0, config: '{}' });
  upsertProfile(db, { name: 'Sam', media_weighting: 0.5, is_derived: 0, config: '{}' });
  upsertProfile(db, { name: 'Joint', media_weighting: 0.5, is_derived: 1, config: '{}' });
  upsertTasteSignature(db, { profile_id: 1, taste_vector: vec(0), prefs: '{}', refreshed_at: '' });
  return db;
}

let nextTmdb = 1;
function seed(db: InstanceType<typeof Database>, title: string, o: Record<string, unknown> = {}): number {
  const { imdb_votes = 5000, ...rest } = o;
  upsertTitle(db, {
    tmdb_id: nextTmdb++, media_type: 'movie', title, year: 2025,
    genres: '["Thriller"]', keywords: '[]', cast: '[]', synopsis: `${title}.`, poster_path: null,
    embedding: vec(0), updated_at: '2026-01-01',
    original_language: 'en', runtime_minutes: 105, vote_average: 7.0, vote_count: 900,
    status: 'Released', popularity: 30, imdb_rating: '7.2', rt_url: null,
    ...rest,
  });
  const id = (db.prepare('SELECT id FROM titles WHERE title = ?').get(title) as { id: number }).id;
  // Ratings already confirmed, so the refresh does not try the (absent) IMDb file.
  db.prepare('UPDATE titles SET imdb_votes = ?, imdb_synced_at = ?, rt_checked_at = ? WHERE id = ?')
    .run(imdb_votes, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), id);
  return id;
}

/** A `claude -p` stand-in: answers the request reading with nothing, and curation with `order` applied to the ids in the prompt. */
function fakeClaude(opts: { order?: (ids: number[]) => number[]; fail?: boolean; onCurate?: () => void } = {}) {
  const calls: string[][] = [];
  const spawn = vi.fn((_cmd: string, args: string[]) => {
    calls.push(args);
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    const model = args[args.indexOf('--model') + 1];
    const prompt = args[args.indexOf('-p') + 1];
    setImmediate(() => {
      if (opts.fail && model !== 'claude-haiku-5-5') {
        proc.emit('close', 1);
        return;
      }
      let structured: unknown;
      if (model === 'claude-haiku-5-5') {
        structured = { subjects: [], exclude: [], references: [], corrections: {} };
      } else {
        opts.onCurate?.();
        const ids = [...prompt.matchAll(/\[tmdb_id:(\d+)\]/g)].map(m => Number(m[1]));
        structured = { items: (opts.order ?? (x => x))(ids).map(id => ({ tmdb_id: id, why: `Picked ${id}`, category: 'Based on your request', predicted_rating: 4 })) };
      }
      proc.stdout.emit('data', Buffer.from(JSON.stringify({ structured_output: structured })));
      proc.emit('close', 0);
    });
    return proc;
  });
  return { spawn: spawn as unknown as SpawnFn, calls, curationCalls: () => calls.filter(a => a[a.indexOf('--model') + 1] === 'claude-sonnet-5').length };
}

function discoveryDeps(): OnDemandDeps {
  return {
    discoverTitles: vi.fn().mockResolvedValue([]),
    getTitleDetails: vi.fn(),
    searchTitles: vi.fn().mockResolvedValue([]),
    searchKeyword: vi.fn().mockResolvedValue([]),
    embedText: vi.fn(),
    applyCachedImdbRatings: vi.fn().mockResolvedValue(0),
    now: () => NOW.getTime(),
  };
}

function deps(over: Partial<GenerateDeps> = {}): GenerateDeps {
  return {
    spawnFn: fakeClaude().spawn,
    embedFn: async () => Array.from(new Float32Array(vec(0).buffer)),
    onDemandDeps: discoveryDeps(),
    fetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch,
    now: () => NOW,
    ...over,
  };
}

function stored(db: InstanceType<typeof Database>, profileId = 1): Array<RecommendationRow & { title: string; year: number }> {
  return db.prepare(`SELECT r.*, t.title, t.year FROM recommendations r JOIN titles t ON t.id = r.title_id
    WHERE r.profile_id = ? AND r.state = 'pending' ORDER BY r.id`).all(profileId) as Array<RecommendationRow & { title: string; year: number }>;
}

describe('generatePicks for a request', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('stores only picks that obey every rule, with the summary, and returns it', async () => {
    const db = setupDb();
    for (let i = 0; i < 14; i++) seed(db, `Thriller 2025 #${i}`, { year: i % 2 ? 2025 : 2026 });
    seed(db, 'Thriller 1995', { year: 1995 });
    seed(db, 'Comedy 2025', { genres: '["Comedy"]' });
    seed(db, 'Thriller Series 2025', { media_type: 'tv', status: 'Ended' });
    seed(db, 'Unrated Thriller 2025', { imdb_rating: null });

    const out = await generatePicks(db, config, { profileId: 1, request: '  Thriller new 2025 ', mediaType: 'movie' }, deps());

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const rules = { ...parseRequest('Thriller new 2025', NOW), mediaType: 'movie' as const };
    const rows = stored(db);
    expect(rows).toHaveLength(10);
    for (const r of rows) {
      expect(titleObeys(rules, getTitleById(db, r.title_id)!).ok).toBe(true);
      expect(r.request_text).toBe('Thriller new 2025');
      expect(r.rule_note).toBeNull();
    }
    const summary = JSON.parse(rows[0].request_summary!) as RequestSummary;
    expect(summary).toEqual({ text: 'Thriller new 2025', understood: ['Thriller', 'Films', '2025 or newer'], matched: 14, note: null });
    expect(out.feed.request).toEqual(summary);
    expect(out.feed.recs).toHaveLength(10);
    expect(out.feed.recs.every(r => r.request_text === 'Thriller new 2025')).toBe(true);
    expect(out.feed.recs[0].tags).toEqual(['Thriller']);
  });

  it('stores nothing and keeps the older picks when nothing matches, but returns an empty feed with the summary', async () => {
    const db = setupDb();
    const kept = seed(db, 'Earlier Pick');
    upsertRecommendation(db, { profile_id: 1, title_id: kept, category: 'Top pick', score: 0.1, why_blurb: 'w', request_text: null, state: 'pending' });
    const { spawn, curationCalls } = fakeClaude();

    const out = await generatePicks(db, config, { profileId: 1, request: 'Western 2025' }, deps({ spawnFn: spawn }));

    expect(out.ok && out.feed).toEqual({
      recs: [],
      request: expect.objectContaining({ text: 'Western 2025', matched: 0, note: expect.stringContaining('Nothing in the library matches') }),
    });
    expect(stored(db).map(r => r.title)).toEqual(['Earlier Pick']);
    expect(curationCalls()).toBe(0);
  });

  it('keeps the ranked picks with a plain rules line when the curation call fails', async () => {
    const db = setupDb();
    for (let i = 0; i < 12; i++) seed(db, `Thriller ${i}`, { embedding: vec(i % DIM) });
    const { spawn, curationCalls } = fakeClaude({ fail: true });

    const out = await generatePicks(db, config, { profileId: 1, request: 'Thriller new 2025', mediaType: 'movie' }, deps({ spawnFn: spawn }));

    expect(out.ok).toBe(true);
    expect(curationCalls()).toBe(2); // tried, then retried once
    const rows = stored(db);
    expect(rows).toHaveLength(10);
    expect(rows.every(r => r.why_blurb === 'Matches your request: Thriller, Films, 2025 or newer.')).toBe(true);
    expect(rows[0].title).toBe('Thriller 0'); // closest to the request vector comes first
  });

  it('fills a short default window with older titles, after the recent ones, each saying why', async () => {
    const db = setupDb();
    for (let i = 0; i < 3; i++) seed(db, `Recent ${i}`, { year: 2024 });
    for (let i = 0; i < 12; i++) seed(db, `Older ${i}`, { year: 2018 });
    // The model puts older titles first; the code puts the recent ones ahead.
    const { spawn } = fakeClaude({ order: ids => [...ids].reverse() });

    const out = await generatePicks(db, config, { profileId: 1, request: 'thriller' }, deps({ spawnFn: spawn }));

    const rows = stored(db);
    expect(rows).toHaveLength(10);
    expect(rows.slice(0, 3).every(r => r.year === 2024 && r.rule_note === null)).toBe(true);
    expect(rows.slice(3).every(r => r.year === 2018 && r.rule_note === 'Older pick: only 3 titles from 2021 on matched.')).toBe(true);
    expect(out.ok && out.feed.request).toMatchObject({ matched: 3, note: expect.stringContaining('7 older ones were added') });
  });

  it('never widens a stated year: fewer picks come back, with a note on what would show more', async () => {
    const db = setupDb();
    for (let i = 0; i < 4; i++) seed(db, `This Year ${i}`, { year: 2026 });
    for (let i = 0; i < 8; i++) seed(db, `Older ${i}`, { year: 2019 });

    const out = await generatePicks(db, config, { profileId: 1, request: 'thriller 2026' }, deps());

    expect(stored(db).map(r => r.year)).toEqual([2026, 2026, 2026, 2026]);
    expect(out.ok && out.feed.request?.note).toBe('Only 4 titles match all of this. Asking for a wider year range or fewer genres or themes would show more.');
  });

  it('uses a named older film as a reference: no year window, and the film itself is never a pick', async () => {
    const db = setupDb();
    seed(db, 'Heat', { year: 1995, genres: '["Crime"]', embedding: vec(3), imdb_votes: 800_000 });
    seed(db, 'Crime 1990s', { year: 1997, genres: '["Crime"]', embedding: vec(3) });
    seed(db, 'Crime Today', { year: 2025, genres: '["Crime"]', embedding: vec(6) });

    const out = await generatePicks(db, config, { profileId: 1, request: 'crime like Heat' }, deps());

    const titles = stored(db).map(r => r.title);
    expect(titles).not.toContain('Heat');
    expect(titles[0]).toBe('Crime 1990s'); // pulled up by the reference's embedding
    expect(out.ok && out.feed.request?.understood).toEqual(['Crime', 'Any year', 'Like Heat']);
  });

  it('asks TMDB only when fewer than 30 titles match', async () => {
    const thin = setupDb();
    for (let i = 0; i < 12; i++) seed(thin, `Thin ${i}`);
    const thinDeps = discoveryDeps();
    await generatePicks(thin, config, { profileId: 1, request: 'Thriller new 2025' }, deps({ onDemandDeps: thinDeps }));
    expect(thinDeps.discoverTitles).toHaveBeenCalled();

    const rich = setupDb();
    for (let i = 0; i < 30; i++) seed(rich, `Rich ${i}`);
    const richDeps = discoveryDeps();
    await generatePicks(rich, config, { profileId: 1, request: 'Thriller new 2025' }, deps({ onDemandDeps: richDeps }));
    expect(richDeps.discoverTitles).not.toHaveBeenCalled();
    expect(richDeps.searchKeyword).not.toHaveBeenCalled();
  });

  it('replaces a pick whose fresh rating falls under the floor with the next ranked title', async () => {
    const db = setupDb();
    const ids = Array.from({ length: 12 }, (_, i) => seed(db, `Thriller ${i}`, { embedding: vec(i % DIM) }));
    // The rating changes after retrieval, as a refresh would find it.
    const { spawn } = fakeClaude({ onCurate: () => db.prepare("UPDATE titles SET imdb_rating = '5.1' WHERE id = ?").run(ids[0]) });

    await generatePicks(db, config, { profileId: 1, request: 'Thriller new 2025', mediaType: 'movie' }, deps({ spawnFn: spawn }));

    const titles = stored(db).map(r => r.title);
    expect(titles).toHaveLength(10);
    expect(titles).not.toContain('Thriller 0');
  });

  it('takes film or series from the app filter when the request names neither', async () => {
    const db = setupDb();
    for (let i = 0; i < 3; i++) seed(db, `Film ${i}`);
    for (let i = 0; i < 3; i++) seed(db, `Series ${i}`, { media_type: 'tv', status: 'Ended' });

    const out = await generatePicks(db, config, { profileId: 1, request: 'thriller', mediaType: 'tv' }, deps());

    expect(stored(db).every(r => r.title.startsWith('Series'))).toBe(true);
    expect(out.ok && out.feed.request?.understood).toContain('Series');
  });
});
