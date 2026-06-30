/**
 * TDD tests for the updated buildCurationPrompt (3-group) and curateCandidates (kind field).
 */
import { describe, it, expect, vi } from 'vitest';
import { buildCurationPrompt } from './prompt.js';
import { curateCandidates } from './curate.js';
import type { CandidatePool } from '../retrieval/retrieve.js';
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

function makeCandidate(id: number, tmdb_id: number, title: string): CandidateTitle {
  return {
    id, tmdb_id, media_type: 'movie', title, year: 2020,
    genres: '["Drama"]', keywords: '[]', cast: '[]',
    synopsis: `Synopsis of ${title}`, poster_path: null,
    embedding: null, updated_at: '2026-01-01T00:00:00Z', score: 0.1 * id,
    imdb_id: null, imdb_rating: null, rt_rating: null, rt_url: null,
    popularity: null, vote_count: null,
  };
}

const onTasteCandidates: CandidateTitle[] = Array.from({ length: 7 }, (_, i) =>
  makeCandidate(i + 1, 100 + i, `OnTaste Film ${i}`),
);

const wildcardCandidates: CandidateTitle[] = Array.from({ length: 3 }, (_, i) =>
  makeCandidate(i + 20, 200 + i, `Wildcard Film ${i}`),
);

const adversarialCandidates: CandidateTitle[] = Array.from({ length: 2 }, (_, i) =>
  makeCandidate(i + 30, 300 + i, `Adversarial Film ${i}`),
);

const mockPool: CandidatePool = {
  onTaste: onTasteCandidates,
  wildcards: wildcardCandidates,
  adversarial: adversarialCandidates,
};

// ─── buildCurationPrompt (3-group overload) ───────────────────────────────────

describe('buildCurationPrompt with CandidatePool', () => {
  it('includes on-taste candidates labelled as ON-TASTE', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, null);
    expect(prompt).toContain('ON-TASTE');
    expect(prompt).toContain('OnTaste Film 0');
  });

  it('includes wildcard candidates labelled as WILDCARD', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, null);
    expect(prompt).toContain('WILDCARD');
    expect(prompt).toContain('Wildcard Film 0');
  });

  it('includes adversarial candidates labelled as ADVERSARIAL', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, null);
    expect(prompt).toContain('ADVERSARIAL');
    expect(prompt).toContain('Adversarial Film 0');
  });

  it('instructs model to return exactly 7 on-taste picks', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, null);
    expect(prompt).toMatch(/7.*on.?taste|on.?taste.*7/i);
  });

  it('instructs model to return exactly 2 wildcard picks', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, null);
    expect(prompt).toMatch(/2.*wildcard|wildcard.*2/i);
  });

  it('instructs model to return exactly 1 adversarial pick', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, null);
    expect(prompt).toMatch(/1.*adversarial|adversarial.*1/i);
  });

  it('instructs model to include a "kind" field in output JSON', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, null);
    expect(prompt).toContain('"kind"');
  });

  it('mentions core/wildcard/adversarial as valid kind values', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, null);
    expect(prompt).toContain('"core"');
    expect(prompt).toContain('"wildcard"');
    expect(prompt).toContain('"adversarial"');
  });

  it('still includes profile name', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, null);
    expect(prompt).toContain('Alex');
  });

  it('includes user request when provided', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, 'something like Severance');
    expect(prompt).toContain('something like Severance');
  });

  it('flat array overload still works (backwards compat)', () => {
    // The existing signature takes CandidateTitle[] — it must still work
    const prompt = buildCurationPrompt(onTasteCandidates, mockProfile, mockSig, null);
    expect(prompt).toContain('Alex');
    expect(prompt).toContain('OnTaste Film 0');
  });
});

// ─── buildCurationPrompt — Surprise Me mode ───────────────────────────────────

describe('buildCurationPrompt — surprise mode', () => {
  it('instructs exactly 5 items all with kind core and category Top pick', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, null, false, true);
    expect(prompt).toContain('exactly 5 items');
    expect(prompt).toContain('"core"');
    expect(prompt).toContain('"Top pick"');
  });

  it('does NOT include wildcard or adversarial candidates', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, null, false, true);
    expect(prompt).not.toContain('Wildcard Film 0');
    expect(prompt).not.toContain('Adversarial Film 0');
    expect(prompt).not.toContain('WILDCARD');
    expect(prompt).not.toContain('ADVERSARIAL');
  });

  it('includes on-taste candidates', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, null, false, true);
    expect(prompt).toContain('OnTaste Film 0');
    expect(prompt).toContain('ON-TASTE');
  });

  it('instructs NOT to include wildcard or adversarial picks', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, null, false, true);
    expect(prompt).toContain('Do NOT include any wildcard or adversarial picks');
  });

  it('still includes profile name', () => {
    const prompt = buildCurationPrompt(mockPool, mockProfile, mockSig, null, false, true);
    expect(prompt).toContain('Alex');
  });
});

// ─── curateCandidates — kind field ───────────────────────────────────────────

describe('curateCandidates — kind field parsing', () => {
  const mockConfig: Config = {
    tmdbApiKey: 'test', ollamaUrl: 'http://localhost:11434',
    claudeToken: 'test-token', port: 8094, dbPath: ':memory:',
    omdbApiKey: undefined,
    harvestDailyTarget: 500,
    requestLookupDailyBudget: 500,
    harvestMaxPage: 30,
  };

  function makeSpawnMock(stdout: string, exitCode = 0) {
    return vi.fn().mockReturnValue({
      stdout: {
        on: vi.fn((evt: string, cb: (data: Buffer) => void) => {
          if (evt === 'data') cb(Buffer.from(stdout));
        }),
      },
      stderr: { on: vi.fn() },
      on: vi.fn((evt: string, cb: (code: number) => void) => {
        if (evt === 'close') cb(exitCode);
      }),
    });
  }

  const allCandidates = [...onTasteCandidates, ...wildcardCandidates, ...adversarialCandidates];

  it('parses kind field when present in model output', async () => {
    const items = [
      { tmdb_id: 100, why: 'Great drama', category: 'Top pick', kind: 'core' },
      { tmdb_id: 200, why: 'Surprise pick', category: 'Wildcard', kind: 'wildcard' },
      { tmdb_id: 300, why: 'Predicted dislike', category: 'Adversarial', kind: 'adversarial' },
    ];
    const spawnMock = makeSpawnMock(JSON.stringify({ result: JSON.stringify(items) }));
    const db = { prepare: vi.fn().mockReturnValue({ run: vi.fn() }) } as unknown as Database;

    const results = await curateCandidates(allCandidates, mockProfile, mockSig, null, mockConfig, db, spawnMock);

    expect(results[0]).toMatchObject({ tmdbId: 100, kind: 'core' });
    expect(results[1]).toMatchObject({ tmdbId: 200, kind: 'wildcard' });
    expect(results[2]).toMatchObject({ tmdbId: 300, kind: 'adversarial' });
  });

  it('defaults kind to "core" when absent from model output', async () => {
    const items = [{ tmdb_id: 100, why: 'Great', category: 'Top pick' }];
    const spawnMock = makeSpawnMock(JSON.stringify({ result: JSON.stringify(items) }));
    const db = { prepare: vi.fn().mockReturnValue({ run: vi.fn() }) } as unknown as Database;

    const results = await curateCandidates(allCandidates, mockProfile, mockSig, null, mockConfig, db, spawnMock);

    expect(results[0].kind).toBe('core');
  });

  it('passes kind to upsertRecommendation', async () => {
    const items = [{ tmdb_id: 200, why: 'Off-profile', category: 'Surprise', kind: 'wildcard' }];
    const spawnMock = makeSpawnMock(JSON.stringify({ result: JSON.stringify(items) }));
    const runMock = vi.fn();
    const db = { prepare: vi.fn().mockReturnValue({ run: runMock }) } as unknown as Database;

    await curateCandidates(allCandidates, mockProfile, mockSig, null, mockConfig, db, spawnMock);

    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wildcard' }));
  });

  it('pool overload: accepts CandidatePool + passes candidates through', async () => {
    const items = [{ tmdb_id: 100, why: 'Great', category: 'Top pick', kind: 'core' }];
    const spawnMock = makeSpawnMock(JSON.stringify({ result: JSON.stringify(items) }));
    const db = { prepare: vi.fn().mockReturnValue({ run: vi.fn() }) } as unknown as Database;

    // curateCandidates should accept a CandidatePool as first arg too
    const results = await curateCandidates(mockPool, mockProfile, mockSig, null, mockConfig, db, spawnMock);

    expect(results[0]).toMatchObject({ tmdbId: 100, kind: 'core' });
  });

  it('surprise mode: caps results at 5 and all results are core', async () => {
    // Model returns 8 items — should be capped at 5 in surprise mode
    const items = Array.from({ length: 8 }, (_, i) => ({
      tmdb_id: 100 + i, why: `Good film ${i}`, category: 'Top pick', kind: 'core',
    }));
    const spawnMock = makeSpawnMock(JSON.stringify({ result: JSON.stringify(items) }));
    const db = { prepare: vi.fn().mockReturnValue({ run: vi.fn() }) } as unknown as Database;

    const results = await curateCandidates(
      mockPool, mockProfile, mockSig, null, mockConfig, db, spawnMock,
      false, true, // balanceMedia=false, surprise=true
    );

    expect(results).toHaveLength(5);
    expect(results.every(r => r.kind === 'core')).toBe(true);
  });
});
