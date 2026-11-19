import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SpawnFn } from '../claude/runJson.js';
import { REQUEST_PARSE_MODEL, REQUEST_PARSE_TIMEOUT_MS, refineRulesWithModel } from './modelParse.js';
import { parseRequest } from './parse.js';

const NOW = new Date('2026-11-19T12:00:00Z');
const CONFIG = { claudeToken: 'tok' };

/** A claude -p that answers with `reading` as its structured output. */
function answering(reading: unknown) {
  return printing(JSON.stringify({ structured_output: reading }));
}

function printing(stdout: string, code = 0) {
  return vi.fn().mockReturnValue({
    stdout: { on: vi.fn((evt: string, cb: (d: Buffer) => void) => { if (evt === 'data') cb(Buffer.from(stdout)); }) },
    stderr: { on: vi.fn() },
    on: vi.fn((evt: string, cb: (code: number) => void) => { if (evt === 'close') cb(code); }),
    kill: vi.fn(),
  });
}

const EMPTY = { subjects: [], exclude: [], references: [], corrections: {} };

async function refine(text: string, spawn: ReturnType<typeof vi.fn>) {
  const base = parseRequest(text, NOW);
  const rules = await refineRulesWithModel(text, base, CONFIG, NOW, spawn as unknown as SpawnFn);
  return { base, rules };
}

describe('refineRulesWithModel', () => {
  afterEach(() => vi.useRealTimers());

  it('makes no call when the parser understood every word', async () => {
    const spawn = answering(EMPTY);
    const { base, rules } = await refine('Thriller new 2025', spawn);
    expect(spawn).not.toHaveBeenCalled();
    expect(rules).toBe(base);
  });

  it('asks the cheap model about the leftover words only, with what was understood', async () => {
    const spawn = answering(EMPTY);
    await refine('Stephen King series', spawn);
    const args = spawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--model') + 1]).toBe(REQUEST_PARSE_MODEL);
    const prompt = args[args.indexOf('-p') + 1];
    expect(prompt).toContain('Today is 2026-11-19.');
    expect(prompt).toContain('Request: "Stephen King series"');
    expect(prompt).toContain('Already understood: Series, 2021 or newer');
    expect(prompt).toContain('Words not yet understood: stephen, king');
    expect(prompt).toMatch(/Add nothing the request does not say/);
  });

  it('merges a subject as a term clause and keeps what the request stated', async () => {
    const spawn = answering({
      subjects: [{ label: 'Stephen King', terms: ['Stephen King', 'based on novel by stephen king', 'stephen king adaptation'] }],
      exclude: [],
      references: [],
      corrections: { mediaType: 'movie', yearMin: 1990, genres: ['Horror', 'Spooky'] },
    });
    const { base, rules } = await refine('Stephen King series', spawn);
    expect(rules.must).toEqual([
      { label: 'Stephen King', genres: [], terms: ['stephen king', 'based on novel by stephen king', 'stephen king adaptation'] },
      { label: 'Horror', genres: ['Horror'], terms: [] },
    ]);
    expect(rules.mediaType).toBe('tv'); // "series" was stated
    expect([rules.yearMin, rules.yearSource]).toEqual([1990, 'stated']); // the parser had only the default
    expect(base.must).toEqual([]); // base is not mutated
  });

  it('joins subjects to the request\'s one theme clause', async () => {
    const spawn = answering({ ...EMPTY, subjects: [{ label: 'chess', terms: ['chess', 'grandmaster', 'chess player'] }] });
    const { rules } = await refine('mind-bending films about chess', spawn);
    expect(rules.must).toHaveLength(1);
    expect(rules.must[0].label).toBe('Mind-bending, chess');
    expect(rules.must[0].terms).toEqual(expect.arrayContaining(['time loop', 'chess', 'grandmaster']));
  });

  it('adds exclusions and references the request names', async () => {
    const spawn = answering({
      subjects: [],
      exclude: [{ label: 'clowns', terms: ['clown', 'killer clown'] }],
      references: ['Zodiac', 'Some Film Nobody Named'],
      corrections: {},
    });
    const { rules } = await refine('creepy one, keep clowns out of it, a Zodiac vibe', spawn);
    expect(rules.mustNot.map((c) => c.label)).toEqual(['clowns']);
    expect(rules.similarTo).toEqual(['Zodiac']);
  });

  it('drops what fails validation', async () => {
    const spawn = answering({
      subjects: [
        { label: 'chess', terms: ['C', 'x'.repeat(41), ...Array.from({ length: 20 }, (_, i) => `chess term ${i}`)] },
        { label: 'politics', terms: ['election'] }, // not in the request
        { label: 'chess openings', terms: [] },
      ],
      exclude: 'not a list',
      references: [42],
      corrections: { yearMin: 1700, minImdb: 42, language: 'English', genres: ['Sci-Fi'] },
    });
    const { base, rules } = await refine('a film about chess', spawn);
    expect(rules.must).toHaveLength(1);
    expect(rules.must[0].terms).toHaveLength(12);
    expect(rules.must[0].terms.every((t) => t.length >= 2 && t.length <= 40)).toBe(true);
    expect({ ...rules, must: base.must }).toEqual(base);
  });

  it('adds at most six clauses', async () => {
    const many = Array.from({ length: 10 }, () => ({ label: 'chess', terms: ['chess'] }));
    const spawn = answering({ subjects: many, exclude: many, references: [], corrections: { genres: ['Drama'] } });
    const { rules } = await refine('a film about chess', spawn);
    expect(rules.must).toHaveLength(1); // six subjects, merged into one clause; no room left for the genre
    expect(rules.mustNot).toHaveLength(0);
  });

  it.each([
    ['garbage output', printing('this is not json')],
    ['a refusal', printing(JSON.stringify({ is_error: true, result: 'refused' }))],
    ['a failed CLI', printing('', 1)],
  ])('returns the parsed rules on %s', async (_name, spawn) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { base, rules } = await refine('Stephen King series', spawn);
    expect(rules).toBe(base);
    warn.mockRestore();
  });

  it('returns the parsed rules when the call times out', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawn = vi.fn().mockReturnValue({ stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() });
    const pending = refine('Stephen King series', spawn);
    await vi.advanceTimersByTimeAsync(REQUEST_PARSE_TIMEOUT_MS);
    const { base, rules } = await pending;
    expect(rules).toBe(base);
    expect(spawn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
