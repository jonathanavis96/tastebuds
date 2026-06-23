import { describe, it, expect } from 'vitest';
import { extractJsonArray } from './curate.js';

describe('extractJsonArray (robust LLM JSON parsing)', () => {
  it('parses a clean array', () => {
    expect(extractJsonArray('[{"tmdb_id":1,"why":"x","category":"c","kind":"core"}]')).toEqual([
      { tmdb_id: 1, why: 'x', category: 'c', kind: 'core' },
    ]);
  });

  it('strips ```json markdown fences', () => {
    const t = '```json\n[{"tmdb_id":2}]\n```';
    expect(extractJsonArray(t)).toEqual([{ tmdb_id: 2 }]);
  });

  it('strips bare ``` fences', () => {
    expect(extractJsonArray('```\n[{"tmdb_id":3}]\n```')).toEqual([{ tmdb_id: 3 }]);
  });

  it('ignores surrounding prose', () => {
    const t = 'Here are your picks:\n[{"tmdb_id":4}]\nHope you enjoy!';
    expect(extractJsonArray(t)).toEqual([{ tmdb_id: 4 }]);
  });

  it('tolerates a trailing comma', () => {
    expect(extractJsonArray('[{"tmdb_id":5},]')).toEqual([{ tmdb_id: 5 }]);
  });

  it('throws on genuinely unparseable input', () => {
    expect(() => extractJsonArray('not json at all')).toThrow();
  });
});
