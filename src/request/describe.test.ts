import { describe, it, expect } from 'vitest';
import { describeRules } from './describe.js';
import { defaultRules } from './rules.js';
import type { RequestRules } from './rules.js';

const NOW = new Date('2026-11-19T12:00:00Z');

function rules(over: Partial<RequestRules>): RequestRules {
  return { ...defaultRules(NOW), ...over };
}

describe('describeRules', () => {
  it('describes the default window, since it filters', () => {
    expect(describeRules(defaultRules(NOW))).toEqual(['2015 or newer']);
  });

  it('lists every rule in reading order', () => {
    expect(describeRules(rules({
      must: [{ label: 'Thriller', genres: ['Thriller'], terms: [] }, { label: 'Medical', genres: [], terms: ['hospital'] }],
      mediaType: 'movie',
      yearMin: 2025,
      yearSource: 'stated',
      minImdb: 7,
      hiddenGem: true,
      maxRuntime: 90,
      language: 'en',
      mustNot: [{ label: 'nuns', genres: [], terms: ['nun'] }],
      similarTo: ['Inception'],
    }))).toEqual([
      'Thriller', 'Medical', 'Films', '2025 or newer', 'IMDb 7.0+', 'Hidden gems', 'Under 90 min', 'English',
      'No nuns', 'Like Inception',
    ]);
  });

  it.each([
    [{ yearMin: 2010, yearMax: 2015 }, '2010–2015'],
    [{ yearMin: 1990, yearMax: 1999 }, '1990s'],
    [{ yearMin: null, yearMax: 1999 }, 'Up to 1999'],
    [{ yearMin: 2025, yearMax: 2025 }, '2025'],
    [{ yearMin: null, yearMax: null, yearSource: 'any' as const }, 'Any year'],
  ])('describes the window %j as %s', (window, chip) => {
    expect(describeRules(rules({ yearSource: 'stated', ...window }))).toEqual([chip]);
  });

  it('names series, a minimum runtime and other languages', () => {
    expect(describeRules(rules({ mediaType: 'tv', minRuntime: 120, language: 'ko' })))
      .toEqual(['Series', '2015 or newer', 'Over 120 min', 'Korean']);
  });
});
