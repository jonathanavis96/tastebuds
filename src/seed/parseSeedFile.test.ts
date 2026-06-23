import { describe, it, expect } from 'vitest';
import { parseSeedJson } from './parseSeedFile.js';
import sampleData from './fixtures/sample-seed.json' with { type: 'json' };

describe('parseSeedJson', () => {
  it('parses valid sample fixture', () => {
    const result = parseSeedJson(sampleData);
    expect(result).toHaveLength(6);
    expect(result[0]).toEqual({
      title: 'Dark', year: 2017, mediaType: 'tv', rating: 5, status: 'watched', profile: 'alex',
    });
    expect(result[5].status).toBe('watchlist');
    expect(result[5].rating).toBeUndefined();
  });

  it('throws when input is not an array', () => {
    expect(() => parseSeedJson({ title: 'Dark' })).toThrow('Seed data must be a JSON array');
  });

  it('throws on invalid mediaType', () => {
    expect(() => parseSeedJson([{ title: 'X', mediaType: 'anime', status: 'watched', profile: 'alex' }]))
      .toThrow("mediaType must be 'movie' or 'tv'");
  });

  it('accepts any non-empty profile name (profiles are user-defined)', () => {
    const result = parseSeedJson([{ title: 'X', mediaType: 'tv', status: 'watched', profile: 'luke' }]);
    expect(result[0].profile).toBe('luke');
  });

  it('throws on a missing or empty profile', () => {
    expect(() => parseSeedJson([{ title: 'X', mediaType: 'tv', status: 'watched', profile: '' }]))
      .toThrow('profile must be a non-empty string');
  });
});
