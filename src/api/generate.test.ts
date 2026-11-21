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

  it('stores nothing and keeps the older picks when nothing matches, heading the list with what was asked', async () => {
    const db = setupDb();
    const kept = seed(db, 'Earlier Pick');
    upsertRecommendation(db, { profile_id: 1, title_id: kept, category: 'Top pick', score: 0.1, why_blurb: 'w', request_text: null, state: 'pending' });
    const { spawn, curationCalls } = fakeClaude();

    const out = await generatePicks(db, config, { profileId: 1, request: 'Western 2025' }, deps({ spawnFn: spawn }));

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const summary = expect.objectContaining({ text: 'Western 2025', matched: 0, note: expect.stringContaining('Nothing in the library matches') });
    expect(out.feed.request).toEqual(summary);
    expect(out.feed.sections).toEqual([
      { text: 'Western 2025', summary, recIds: [] },
      { text: null, summary: null, recIds: [expect.any(Number)] },
    ]);
    expect(out.feed.recs.map(r => r.title)).toEqual(['Earlier Pick']);
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
    // Farther from the request than the recent ones, so a feed sorted by distance alone would show them first.
    for (let i = 0; i < 12; i++) seed(db, `Older ${i}`, { year: 2010, embedding: vec(3) });
    // The model puts older titles first; the code puts the recent ones ahead.
    const { spawn } = fakeClaude({ order: ids => [...ids].reverse() });

    const out = await generatePicks(db, config, { profileId: 1, request: 'thriller' }, deps({ spawnFn: spawn }));

    // Three recent titles, and no more than three older ones however many would fit.
    const rows = stored(db);
    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 3).every(r => r.year === 2024 && r.rule_note === null)).toBe(true);
    expect(rows.slice(3).every(r => r.year === 2010 && r.rule_note === 'Older pick: only 3 titles from 2015 on matched.')).toBe(true);
    expect(out.ok && out.feed.request).toMatchObject({
      matched: 3,
      note: 'Only 3 titles from 2015 on matched, so 3 from 2005 to 2014 were added. Say "any year" to see older ones.',
    });
    // The feed shows them in the stored order: recent first.
    expect(out.ok && out.feed.recs.map(r => r.year)).toEqual([2024, 2024, 2024, 2010, 2010, 2010]);
  });

  it('never reaches further back than ten years before the window for an unstated year', async () => {
    const db = setupDb();
    seed(db, 'Recent', { year: 2024 });
    for (let i = 0; i < 12; i++) seed(db, `Old ${i}`, { year: 2004 });
    const { spawn } = fakeClaude();

    const out = await generatePicks(db, config, { profileId: 1, request: 'thriller' }, deps({ spawnFn: spawn }));

    expect(stored(db).map(r => r.year)).toEqual([2024]);
    expect(out.ok && out.feed.request?.note).toBe('Only 1 title matches all of this. Asking for any year or fewer genres or themes would show more.');
  });

  it('fills a short list with close matches that miss a mood word, after the strict ones, each saying what it misses', async () => {
    const db = setupDb();
    const series = (title: string, o: Record<string, unknown>) =>
      seed(db, title, { media_type: 'tv', status: 'Ended', imdb_rating: '8.0', year: 2022, ...o });
    series('Strict Show', { genres: '["Science Fiction","Horror"]', keywords: '["time loop"]', embedding: vec(4) });
    for (let i = 0; i < 6; i++) series(`Not Scary ${i}`, { genres: '["Science Fiction"]', keywords: '["alternate reality"]' });
    for (let i = 0; i < 3; i++) series(`Neither ${i}`, { genres: '["Science Fiction"]' });
    for (let i = 0; i < 4; i++) series(`Too Old ${i}`, { genres: '["Science Fiction","Horror"]', keywords: '["time loop"]', year: 2010 });
    series('Not Sci-fi', { genres: '["Horror"]', keywords: '["time loop"]' });
    // The model puts the close matches first; the code puts the strict one ahead.
    const { spawn, calls } = fakeClaude({ order: ids => [...ids].reverse() });

    const out = await generatePicks(db, config, { profileId: 1, request: 'Sci-fi mind bending scary', mediaType: 'tv' }, deps({ spawnFn: spawn }));

    const rows = stored(db);
    expect(rows.map(r => r.title)).toHaveLength(10);
    expect(rows[0]).toMatchObject({ title: 'Strict Show', rule_note: null });
    expect(rows.slice(1, 7).every(r => r.title.startsWith('Not Scary') && r.rule_note === 'Close match: not tagged Scary.')).toBe(true);
    expect(rows.slice(7).every(r => r.title.startsWith('Neither') && r.rule_note === 'Close match: not tagged Mind-bending or Scary.')).toBe(true);
    // The list was full after the close matches, so no older titles were reached for.
    expect(rows.some(r => r.title.startsWith('Too Old') || r.title === 'Not Sci-fi')).toBe(false);
    expect(out.ok && out.feed.request).toMatchObject({
      understood: ['Sci-fi', 'Mind-bending', 'Scary', 'Series', '2015 or newer'],
      matched: 1,
      note: 'Only 1 title matched every word, so 9 close matches were added. Each card says what it misses.',
    });
    const prompt = calls.map(a => a[a.indexOf('-p') + 1]).find(p => p.includes('## Close matches'))!;
    expect(prompt).toContain('(misses: Scary)');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('older=0 close=9'));
  });

  it('adds older titles after close matches when the list is still short, keeping both notes', async () => {
    const db = setupDb();
    seed(db, 'Strict', { genres: '["Horror"]' });
    for (let i = 0; i < 2; i++) seed(db, `Close ${i}`, { genres: '["Drama"]', embedding: vec(2) });
    for (let i = 0; i < 4; i++) seed(db, `Older ${i}`, { genres: '["Horror"]', year: 2010 });

    const out = await generatePicks(db, config, { profileId: 1, request: 'scary', mediaType: 'movie' }, deps());

    const rows = stored(db);
    expect(rows.map(r => r.title.replace(/ \d$/, ''))).toEqual(['Strict', 'Close', 'Close', 'Older', 'Older', 'Older']);
    expect(rows.slice(1, 3).every(r => r.rule_note === 'Close match: not tagged Scary.')).toBe(true);
    expect(rows.slice(3).every(r => r.rule_note === 'Older pick: only 1 title from 2015 on matched.')).toBe(true);
    expect(out.ok && out.feed.request?.note).toBe(
      'Only 1 title matched every word, so 2 close matches were added. Each card says what it misses. ' +
      'Only 1 title from 2015 on matched, so 3 from 2005 to 2014 were added. Say "any year" to see older ones.',
    );
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

  it('returns the picks of a request for a language the household does not usually watch', async () => {
    const db = setupDb();
    for (let i = 0; i < 3; i++) seed(db, `Korean ${i}`, { original_language: 'ko' });
    seed(db, 'English One');
    const { spawn } = fakeClaude();

    const out = await generatePicks(db, config, { profileId: 1, request: 'Korean thriller' }, deps({ spawnFn: spawn }));

    expect(stored(db).map(r => r.title).sort()).toEqual(['Korean 0', 'Korean 1', 'Korean 2']);
    // The feed shows them: it does not filter them by the household's languages again.
    expect(out.ok && out.feed.recs.map(r => r.title).sort()).toEqual(['Korean 0', 'Korean 1', 'Korean 2']);
    expect(out.ok && out.feed.request?.understood).toContain('Korean');
  });

  it('takes film or series from the app filter when the request names neither', async () => {
    const db = setupDb();
    for (let i = 0; i < 3; i++) seed(db, `Film ${i}`);
    for (let i = 0; i < 3; i++) seed(db, `Series ${i}`, { media_type: 'tv', status: 'Ended' });

    const out = await generatePicks(db, config, { profileId: 1, request: 'thriller', mediaType: 'tv' }, deps());

    expect(stored(db).every(r => r.title.startsWith('Series'))).toBe(true);
    expect(out.ok && out.feed.request?.understood).toContain('Series');
  });

  describe('the list grows', () => {
    const ask = (db: InstanceType<typeof Database>, request = 'Thriller new 2025') =>
      generatePicks(db, config, { profileId: 1, request, mediaType: 'movie' }, deps());

    it('asked again, adds the next new titles above the earlier ones', async () => {
      const db = setupDb();
      for (let i = 0; i < 24; i++) seed(db, `Thriller ${i}`);

      const first = await ask(db);
      const second = await ask(db);

      if (!first.ok || !second.ok) throw new Error('generate failed');
      const firstIds = first.feed.sections[0].recIds;
      expect(firstIds).toHaveLength(10);
      expect(second.feed.sections).toHaveLength(1);
      const ids = second.feed.sections[0].recIds;
      expect(ids).toHaveLength(20);
      expect(ids.slice(10)).toEqual(firstIds);
      expect(new Set(stored(db).map(r => r.title)).size).toBe(20);
      expect(second.feed.request).toMatchObject({ matched: 24, note: null });
    });

    it('asked again with every match already listed, says so instead of "nothing matches"', async () => {
      const db = setupDb();
      for (let i = 0; i < 6; i++) seed(db, `Thriller ${i}`);
      await ask(db);
      const before = stored(db).map(r => r.id);
      const { spawn, curationCalls } = fakeClaude();

      const out = await generatePicks(db, config, { profileId: 1, request: 'Thriller new 2025', mediaType: 'movie' }, deps({ spawnFn: spawn }));

      expect(stored(db).map(r => r.id)).toEqual(before);
      expect(curationCalls()).toBe(0);
      expect(out.ok && out.feed.request).toMatchObject({
        matched: 6,
        note: 'All 6 titles that match this are already in your list. Asking for a wider year range, fewer genres or themes, or both films and series would show more.',
      });
      expect(out.ok && out.feed.sections[0].recIds).toHaveLength(6);
    });

    it('asked again with no year stated, adds a few older titles, each saying why, once the recent ones are listed', async () => {
      const db = setupDb();
      for (let i = 0; i < 10; i++) seed(db, `Recent ${i}`, { year: 2024 });
      for (let i = 0; i < 5; i++) seed(db, `Older ${i}`, { year: 2012 });
      const thriller = () => generatePicks(db, config, { profileId: 1, request: 'thriller', mediaType: 'movie' }, deps());

      await thriller();
      expect(stored(db).every(r => r.title.startsWith('Recent'))).toBe(true);
      const out = await thriller();

      const added = stored(db).filter(r => r.title.startsWith('Older'));
      expect(added).toHaveLength(3);
      expect(added.every(r => r.rule_note === 'Older pick: no new titles from 2015 on matched.')).toBe(true);
      expect(out.ok && out.feed.request?.note).toBe('No new titles from 2015 on matched, so 3 from 2005 to 2014 were added. Say "any year" to see older ones.');
      expect(out.ok && out.feed.sections[0].recIds).toHaveLength(13);
    });

    it('puts a different request on top and keeps the earlier picks below it', async () => {
      const db = setupDb();
      for (let i = 0; i < 12; i++) seed(db, `Thriller ${i}`);
      for (let i = 0; i < 12; i++) seed(db, `Comedy ${i}`, { genres: '["Comedy"]' });

      await ask(db);
      const out = await ask(db, 'comedy');

      if (!out.ok) throw new Error('generate failed');
      expect(out.feed.sections.map(s => s.text)).toEqual(['comedy', 'Thriller new 2025']);
      expect(out.feed.recs.slice(0, 10).every(r => String(r.title).startsWith('Comedy'))).toBe(true);
      expect(out.feed.recs.slice(10).every(r => String(r.title).startsWith('Thriller'))).toBe(true);
    });
  });
});
