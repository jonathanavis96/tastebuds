import { describe, it, expect, vi } from 'vitest';
import { buildCurationPrompt } from './prompt.js';
import { curateCandidates } from './curate.js';
import type { CandidateTitle } from '../retrieval/retrieve.js';
import type { ProfileRow, TasteSignatureRow } from '../db/types.js';
import type { Database } from 'better-sqlite3';
import type { Config } from '../config.js';

const mockProfile: ProfileRow = {
  id: 1, name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}',
};

const mockSig: TasteSignatureRow = {
  profile_id: 1,
  taste_vector: null,
  prefs: JSON.stringify({
    loved_genres: ['Drama', 'Thriller'],
    hated_genres: ['Horror'],
    loved_themes: ['mystery'],
    hated_themes: [],
    preferred_era: '2010s-present',
    media_weighting: 0.3,
  }),
  refreshed_at: new Date().toISOString(),
};

const mockCandidates: CandidateTitle[] = [
  {
    id: 1, tmdb_id: 101, media_type: 'tv', title: 'Dark', year: 2017,
    genres: '["Drama","Sci-Fi"]', keywords: '[]', cast: '[]',
    synopsis: 'A family saga with a time-travel conspiracy.', poster_path: null,
    embedding: null, updated_at: '2026-01-01T00:00:00Z', score: 0.12,
    imdb_id: null, imdb_rating: null, rt_rating: null, rt_url: null,
    popularity: null, vote_count: null, rating_checked_at: null,
  },
];

describe('buildCurationPrompt', () => {
  it('includes profile name and candidate tmdb_id', () => {
    const prompt = buildCurationPrompt(mockCandidates, mockProfile, mockSig, null);
    expect(prompt).toContain('Alex');
    expect(prompt).toContain('tmdb_id:101');
    expect(prompt).toContain('"Dark"');
  });

  it('includes loved and hated genres', () => {
    const prompt = buildCurationPrompt(mockCandidates, mockProfile, mockSig, null);
    expect(prompt).toContain('Drama');
    expect(prompt).toContain('Horror');
  });

  it('includes user request when provided', () => {
    const prompt = buildCurationPrompt(mockCandidates, mockProfile, mockSig, 'something like Severance');
    expect(prompt).toContain('something like Severance');
  });

  it('omits user request block when null', () => {
    const prompt = buildCurationPrompt(mockCandidates, mockProfile, mockSig, null);
    expect(prompt).not.toContain('User request:');
  });

  it('truncates synopsis to 100 chars', () => {
    const longSynopsis = 'A'.repeat(200);
    const candidates: CandidateTitle[] = [{
      ...mockCandidates[0], synopsis: longSynopsis,
    }];
    const prompt = buildCurationPrompt(candidates, mockProfile, mockSig, null);
    // The synopsis in the prompt should be at most 100 chars of 'A's
    expect(prompt).toContain('A'.repeat(100));
    expect(prompt).not.toContain('A'.repeat(101));
  });

  it('caps candidate list at 30 items', () => {
    const manyCandidates: CandidateTitle[] = Array.from({ length: 40 }, (_, i) => ({
      ...mockCandidates[0], id: i + 1, tmdb_id: 100 + i, title: `Film ${i}`,
    }));
    const prompt = buildCurationPrompt(manyCandidates, mockProfile, mockSig, null);
    // Item 30 present (index 29, tmdb_id 129), item 31 not present (index 30, tmdb_id 130)
    expect(prompt).toContain('[tmdb_id:129]');
    expect(prompt).not.toContain('[tmdb_id:130]');
  });
});

describe('curateCandidates', () => {
  const mockConfig: Config = {
    tmdbApiKey: 'test-key',
    ollamaUrl: 'http://localhost:11434',
    claudeToken: 'test-token',
    port: 8094,
    dbPath: ':memory:',
    omdbApiKey: undefined,
    harvestDailyTarget: 500,
    requestLookupDailyBudget: 500,
    harvestMaxPage: 30,
  };

  const mockDb = {
    prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
  } as unknown as Database;

  function makeSpawnMock(stdout: string, exitCode: number = 0) {
    return vi.fn().mockReturnValue({
      stdout: {
        on: vi.fn((evt: string, cb: (data: Buffer) => void) => {
          if (evt === 'data') cb(Buffer.from(stdout));
        }),
      },
      stderr: {
        on: vi.fn(),
      },
      on: vi.fn((evt: string, cb: (code: number) => void) => {
        if (evt === 'close') cb(exitCode);
      }),
    });
  }

  it('parses valid claude output (outer wrapper) and caps at 10 results', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      tmdb_id: 101, why: `Reason ${i}`, category: 'Top pick',
    }));
    const claudeOutput = JSON.stringify({ result: JSON.stringify(items) });
    const spawnMock = makeSpawnMock(claudeOutput);

    const candidates: CandidateTitle[] = Array.from({ length: 12 }, (_, i) => ({
      ...mockCandidates[0], id: i + 1, tmdb_id: 101,
    }));

    const results = await curateCandidates(candidates, mockProfile, mockSig, null, mockConfig, mockDb, spawnMock);
    expect(results).toHaveLength(10);
    expect(results[0]).toMatchObject({ tmdbId: 101, why: 'Reason 0', category: 'Top pick' });
  });

  it('spawns claude with stdin ignored so it does not wait ~3s for stdin', async () => {
    const claudeOutput = JSON.stringify({ result: JSON.stringify([{ tmdb_id: 101, why: 'x', category: 'y' }]) });
    const spawnMock = makeSpawnMock(claudeOutput);
    await curateCandidates(mockCandidates, mockProfile, mockSig, null, mockConfig, mockDb, spawnMock);
    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-p']),
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('parses raw JSON array output (no outer wrapper)', async () => {
    const items = [{ tmdb_id: 101, why: 'Great drama', category: 'Hidden gem' }];
    // When outer.result is undefined, inner = stdout itself
    // But JSON.parse(stdout) would try to parse the array as the outer...
    // Actually: outer = JSON.parse('[...]') = array; outer.result = undefined; inner = stdout
    const claudeOutput = JSON.stringify(items);
    const spawnMock = makeSpawnMock(claudeOutput);

    const results = await curateCandidates(mockCandidates, mockProfile, mockSig, null, mockConfig, mockDb, spawnMock);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ tmdbId: 101, why: 'Great drama', category: 'Hidden gem' });
  });

  it('rejects when claude exits with non-zero code', async () => {
    const spawnMock = vi.fn().mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: {
        on: vi.fn((evt: string, cb: (data: Buffer) => void) => {
          if (evt === 'data') cb(Buffer.from('auth error'));
        }),
      },
      on: vi.fn((evt: string, cb: (code: number) => void) => {
        if (evt === 'close') cb(1);
      }),
    });

    await expect(
      curateCandidates(mockCandidates, mockProfile, mockSig, null, mockConfig, mockDb, spawnMock),
    ).rejects.toThrow('claude -p exited with code 1');
  });

  it('rejects on invalid JSON output', async () => {
    const spawnMock = makeSpawnMock('not valid json at all');

    await expect(
      curateCandidates(mockCandidates, mockProfile, mockSig, null, mockConfig, mockDb, spawnMock),
    ).rejects.toThrow('Failed to parse claude -p output');
  });

  it('rejects when spawn errors', async () => {
    const spawnMock = vi.fn().mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((evt: string, cb: (err: Error) => void) => {
        if (evt === 'error') cb(new Error('ENOENT: claude not found'));
      }),
    });

    await expect(
      curateCandidates(mockCandidates, mockProfile, mockSig, null, mockConfig, mockDb, spawnMock),
    ).rejects.toThrow('Failed to spawn claude');
  });

  it('calls upsertRecommendation for each matched result', async () => {
    const items = [{ tmdb_id: 101, why: 'Excellent', category: 'Top pick' }];
    const claudeOutput = JSON.stringify({ result: JSON.stringify(items) });
    const spawnMock = makeSpawnMock(claudeOutput);

    const runMock = vi.fn();
    const db = {
      prepare: vi.fn().mockReturnValue({ run: runMock }),
    } as unknown as Database;

    await curateCandidates(mockCandidates, mockProfile, mockSig, null, mockConfig, db, spawnMock);
    expect(runMock).toHaveBeenCalledOnce();
    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({
      profile_id: 1,
      title_id: 1,
      category: 'Top pick',
      why_blurb: 'Excellent',
      state: 'pending',
    }));
  });

  it('skips upsert when tmdb_id not found in candidates', async () => {
    const items = [{ tmdb_id: 999, why: 'Unknown', category: 'Top pick' }];
    const claudeOutput = JSON.stringify({ result: JSON.stringify(items) });
    const spawnMock = makeSpawnMock(claudeOutput);

    const runMock = vi.fn();
    const db = {
      prepare: vi.fn().mockReturnValue({ run: runMock }),
    } as unknown as Database;

    const results = await curateCandidates(mockCandidates, mockProfile, mockSig, null, mockConfig, db, spawnMock);
    expect(results).toHaveLength(1);
    expect(runMock).not.toHaveBeenCalled();
  });

  // ── media-balance tests ────────────────────────────────────────────────────

  it('balanceMedia:true inserts exactly 5 movie + 5 tv when both sides are plentiful', async () => {
    // 10 movie candidates then 10 tv candidates; LLM returns all 20
    const movieCandidates: CandidateTitle[] = Array.from({ length: 10 }, (_, i) => ({
      ...mockCandidates[0],
      id: 101 + i,
      tmdb_id: 1001 + i,
      media_type: 'movie' as const,
      title: `Movie ${i + 1}`,
    }));
    const tvCandidates: CandidateTitle[] = Array.from({ length: 10 }, (_, i) => ({
      ...mockCandidates[0],
      id: 201 + i,
      tmdb_id: 2001 + i,
      media_type: 'tv' as const,
      title: `TV Show ${i + 1}`,
    }));
    const allCands = [...movieCandidates, ...tvCandidates];

    const llmItems = allCands.map((c, i) => ({ tmdb_id: c.tmdb_id, why: `Reason ${i}`, category: 'Top pick' }));
    const spawnMock = makeSpawnMock(JSON.stringify({ result: JSON.stringify(llmItems) }));

    const runMock = vi.fn();
    const db = { prepare: vi.fn().mockReturnValue({ run: runMock }) } as unknown as Database;

    const results = await curateCandidates(allCands, mockProfile, mockSig, null, mockConfig, db, spawnMock, true);

    expect(results).toHaveLength(10);
    expect(runMock).toHaveBeenCalledTimes(10);
    // Verify 5 movie + 5 tv inserted by checking title_ids (movie ids 101-110, tv ids 201-210)
    const insertedTitleIds: number[] = runMock.mock.calls.map((call: unknown[]) => (call[0] as { title_id: number }).title_id);
    expect(insertedTitleIds.filter(id => id >= 101 && id <= 110)).toHaveLength(5);
    expect(insertedTitleIds.filter(id => id >= 201 && id <= 210)).toHaveLength(5);
  });

  it('balanceMedia:false inserts top 10 of a single-type candidate set', async () => {
    // 15 tv candidates; LLM returns all 15; we want exactly 10 inserted
    const tvCandidates: CandidateTitle[] = Array.from({ length: 15 }, (_, i) => ({
      ...mockCandidates[0],
      id: 301 + i,
      tmdb_id: 3001 + i,
      media_type: 'tv' as const,
      title: `Series ${i + 1}`,
    }));

    const llmItems = tvCandidates.map((c, i) => ({ tmdb_id: c.tmdb_id, why: `Reason ${i}`, category: 'Top pick' }));
    const spawnMock = makeSpawnMock(JSON.stringify({ result: JSON.stringify(llmItems) }));

    const runMock = vi.fn();
    const db = { prepare: vi.fn().mockReturnValue({ run: runMock }) } as unknown as Database;

    const results = await curateCandidates(tvCandidates, mockProfile, mockSig, null, mockConfig, db, spawnMock, false);

    expect(results).toHaveLength(10);
    expect(runMock).toHaveBeenCalledTimes(10);
  });

  it('balanceMedia:true backfills from movie side when tv is short (3 tv + 10 movie = 10 total)', async () => {
    // 10 movie candidates then 3 tv; LLM returns all 13 (movies first)
    const movieCandidates: CandidateTitle[] = Array.from({ length: 10 }, (_, i) => ({
      ...mockCandidates[0],
      id: 401 + i,
      tmdb_id: 4001 + i,
      media_type: 'movie' as const,
      title: `Film ${i + 1}`,
    }));
    const tvCandidates: CandidateTitle[] = Array.from({ length: 3 }, (_, i) => ({
      ...mockCandidates[0],
      id: 501 + i,
      tmdb_id: 5001 + i,
      media_type: 'tv' as const,
      title: `Show ${i + 1}`,
    }));
    const allCands = [...movieCandidates, ...tvCandidates];

    const llmItems = allCands.map((c, i) => ({ tmdb_id: c.tmdb_id, why: `Reason ${i}`, category: 'Top pick' }));
    const spawnMock = makeSpawnMock(JSON.stringify({ result: JSON.stringify(llmItems) }));

    const runMock = vi.fn();
    const db = { prepare: vi.fn().mockReturnValue({ run: runMock }) } as unknown as Database;

    const results = await curateCandidates(allCands, mockProfile, mockSig, null, mockConfig, db, spawnMock, true);

    expect(results).toHaveLength(10);
    expect(runMock).toHaveBeenCalledTimes(10);
    // 3 tv (ids 501-503) + 7 movie (ids 401-407) = 10 total; rank order preserved within each type
    const insertedTitleIds: number[] = runMock.mock.calls.map((call: unknown[]) => (call[0] as { title_id: number }).title_id);
    expect(insertedTitleIds.filter(id => id >= 401 && id <= 410)).toHaveLength(7);
    expect(insertedTitleIds.filter(id => id >= 501 && id <= 503)).toHaveLength(3);
  });
});
