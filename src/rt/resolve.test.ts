/**
 * Unit tests for slugifyRtTitle, parseTomatometer, and resolveRtUrl.
 * Network is never hit — fetch is injected as a mock.
 */
import { describe, it, expect, vi } from 'vitest';
import { slugifyRtTitle, parseTomatometer, resolveRtUrl, parsePageIdentity, normaliseTitle } from './resolve.js';

// ─── slugifyRtTitle ───────────────────────────────────────────────────────────

describe('slugifyRtTitle', () => {
  it('lowercases the title', () => {
    expect(slugifyRtTitle('HEAT')).toBe('heat');
  });

  it('replaces & with " and "', () => {
    expect(slugifyRtTitle('Law & Order')).toBe('law_and_order');
  });

  it('removes straight apostrophes', () => {
    expect(slugifyRtTitle("It's Complicated")).toBe('its_complicated');
  });

  it('removes curly apostrophes', () => {
    expect(slugifyRtTitle('’s Complicated')).toBe('s_complicated');
  });

  it('replaces runs of non-alphanumeric chars with a single underscore', () => {
    expect(slugifyRtTitle('Spider-Man: No Way Home')).toBe('spider_man_no_way_home');
  });

  it('trims leading and trailing underscores', () => {
    expect(slugifyRtTitle('!Title!')).toBe('title');
  });

  it('example: They Cloned Tyrone', () => {
    expect(slugifyRtTitle('They Cloned Tyrone')).toBe('they_cloned_tyrone');
  });

  it('example: Spider-Man: No Way Home', () => {
    expect(slugifyRtTitle('Spider-Man: No Way Home')).toBe('spider_man_no_way_home');
  });

  it('handles multiple consecutive non-alphanumeric chars as a single underscore', () => {
    expect(slugifyRtTitle('A  --  B')).toBe('a_b');
  });
});

// ─── parseTomatometer ────────────────────────────────────────────────────────

describe('parseTomatometer', () => {
  it('parses tomatometer score from page body', () => {
    const body = 'some html "tomatometer":91 more html';
    expect(parseTomatometer(body)).toBe('91%');
  });

  it('parses nested tomatometer object (e.g. Oppenheimer pattern)', () => {
    const body = '"tomatometer":{"tomatometer":98}';
    // First match is the outer key with value starting { — not digits; second is 98
    // The regex matches the first `"tomatometer":<digits>` pattern, so we need to test
    // what the actual match produces: the outer `"tomatometer":{"tomatometer":98}` the
    // first `"tomatometer":` is followed by `{`, not digits — regex won't match.
    // The second `"tomatometer":98` will match.
    expect(parseTomatometer(body)).toBe('98%');
  });

  it('returns null when tomatometer is not present', () => {
    expect(parseTomatometer('<html>no score here</html>')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseTomatometer('')).toBeNull();
  });
});

// ─── resolveRtUrl ────────────────────────────────────────────────────────────

function makeFetch(responses: Array<{ status: number; url: string; body?: string }>): typeof fetch {
  let callIndex = 0;
  return vi.fn().mockImplementation(() => {
    const resp = responses[callIndex++] ?? { status: 404, url: '', body: '' };
    return Promise.resolve({
      status: resp.status,
      url: resp.url,
      text: () => Promise.resolve(resp.body ?? ''),
    });
  }) as unknown as typeof fetch;
}

describe('resolveRtUrl', () => {
  it('returns the final url and score when the first attempt is 200', async () => {
    const fetchMock = makeFetch([{
      status: 200,
      url: 'https://www.rottentomatoes.com/m/they_cloned_tyrone',
      body: '<meta property="og:title" content="They Cloned Tyrone (2023) - Rotten Tomatoes" /> data "tomatometer":91 more',
    }]);
    const result = await resolveRtUrl('They Cloned Tyrone', 2023, 'movie', fetchMock);
    expect(result).toEqual({
      url: 'https://www.rottentomatoes.com/m/they_cloned_tyrone',
      score: '91%',
      verified: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns score null when page body has no tomatometer', async () => {
    const fetchMock = makeFetch([{
      status: 200,
      url: 'https://www.rottentomatoes.com/m/some_film',
      body: '<meta property="og:title" content="Some Film (2020) - Rotten Tomatoes" /><html>no score</html>',
    }]);
    const result = await resolveRtUrl('Some Film', 2020, 'movie', fetchMock);
    expect(result).toEqual({
      url: 'https://www.rottentomatoes.com/m/some_film',
      score: null,
      verified: true,
    });
  });

  it('returns null when both attempts return 404', async () => {
    const fetchMock = makeFetch([
      { status: 404, url: '' },
      { status: 404, url: '' },
    ]);
    const result = await resolveRtUrl('Unknown Title', 2020, 'movie', fetchMock);
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns year-suffixed url when first is 404 and second is 200', async () => {
    const fetchMock = makeFetch([
      { status: 404, url: '' },
      { status: 200, url: 'https://www.rottentomatoes.com/m/heat_1995', body: '<meta property="og:title" content="Heat (1995) - Rotten Tomatoes" />"tomatometer":98' },
    ]);
    const result = await resolveRtUrl('Heat', 1995, 'movie', fetchMock);
    expect(result).toEqual({
      url: 'https://www.rottentomatoes.com/m/heat_1995',
      score: '98%',
      verified: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null without making a year-suffix attempt when year is null', async () => {
    const fetchMock = makeFetch([{ status: 404, url: '' }]);
    const result = await resolveRtUrl('Some Film', null, 'movie', fetchMock);
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses "tv" path for tv media type', async () => {
    const fetchMock = makeFetch([{ status: 200, url: 'https://www.rottentomatoes.com/tv/severance', body: '' }]);
    await resolveRtUrl('Severance', 2022, 'tv', fetchMock);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.rottentomatoes.com/tv/severance',
      expect.anything(),
    );
  });

  it('uses "m" path for movie media type', async () => {
    const fetchMock = makeFetch([{ status: 200, url: 'https://www.rottentomatoes.com/m/oppenheimer', body: '"tomatometer":99' }]);
    await resolveRtUrl('Oppenheimer', 2023, 'movie', fetchMock);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.rottentomatoes.com/m/oppenheimer',
      expect.anything(),
    );
  });

  it('returns null when fetch throws a network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch;
    const result = await resolveRtUrl('Some Film', 2020, 'movie', fetchMock);
    expect(result).toBeNull();
  });
});

// ─── normaliseTitle ──────────────────────────────────────────────────────────

describe('normaliseTitle', () => {
  it('lowercases and trims', () => {
    expect(normaliseTitle('  HEAT  ')).toBe('heat');
  });

  it('replaces punctuation with spaces and collapses whitespace', () => {
    expect(normaliseTitle('Spider-Man: No Way Home')).toBe('spider man no way home');
  });

  it('preserves numbers', () => {
    expect(normaliseTitle('The 100')).toBe('the 100');
  });
});

// ─── parsePageIdentity ───────────────────────────────────────────────────────

describe('parsePageIdentity', () => {
  it('extracts title from og:title and strips RT suffix', () => {
    const body = '<meta property="og:title" content="Heat - Rotten Tomatoes" />';
    expect(parsePageIdentity(body).title).toBe('Heat');
  });

  it('extracts title and year when parenthesized year is in og:title', () => {
    const body = '<meta property="og:title" content="Heat (1995) - Rotten Tomatoes" />';
    const result = parsePageIdentity(body);
    expect(result.title).toBe('Heat');
    expect(result.year).toBe(1995);
  });

  it('falls back to releaseYear JSON when og:title has no year', () => {
    const body = '<meta property="og:title" content="Heat - Rotten Tomatoes" /> "releaseYear":"1995"';
    const result = parsePageIdentity(body);
    expect(result.year).toBe(1995);
  });

  it('returns null title when no og:title present', () => {
    expect(parsePageIdentity('<html>no meta</html>').title).toBeNull();
  });

  it('returns null year when no year source is found', () => {
    const body = '<meta property="og:title" content="Heat - Rotten Tomatoes" />';
    expect(parsePageIdentity(body).year).toBeNull();
  });

  it('handles content attribute before property attribute', () => {
    const body = '<meta content="Heat (1995) - Rotten Tomatoes" property="og:title" />';
    const result = parsePageIdentity(body);
    expect(result.title).toBe('Heat');
    expect(result.year).toBe(1995);
  });

  it('extracts title and year when extra attributes appear between property and content', () => {
    const body = '<meta property="og:title" data-x="y" content="Heat (1995) - Rotten Tomatoes" />';
    const result = parsePageIdentity(body);
    expect(result.title).toBe('Heat');
    expect(result.year).toBe(1995);
  });
});

// ─── resolveRtUrl identity verification ──────────────────────────────────────

describe('resolveRtUrl identity verification', () => {
  it('returns verified=true when og:title matches input title and year', async () => {
    const body = '<meta property="og:title" content="Heat (1995) - Rotten Tomatoes" />"tomatometer":98';
    const fetchMock = makeFetch([{ status: 200, url: 'https://www.rottentomatoes.com/m/heat', body }]);
    const result = await resolveRtUrl('Heat', 1995, 'movie', fetchMock);
    expect(result).toEqual({ url: 'https://www.rottentomatoes.com/m/heat', score: '98%', verified: true });
  });

  it('returns verified=false with search URL when page title does not match input', async () => {
    const body = '<meta property="og:title" content="Heist (2015) - Rotten Tomatoes" />"tomatometer":60';
    const fetchMock = makeFetch([{ status: 200, url: 'https://www.rottentomatoes.com/m/heat', body }]);
    const result = await resolveRtUrl('Heat', 1995, 'movie', fetchMock);
    expect(result).toEqual({
      url: 'https://www.rottentomatoes.com/search?search=Heat',
      score: null,
      verified: false,
    });
  });

  it('returns verified=false when page year differs from input by more than 1', async () => {
    const body = '<meta property="og:title" content="Heat (2010) - Rotten Tomatoes" />"tomatometer":60';
    const fetchMock = makeFetch([{ status: 200, url: 'https://www.rottentomatoes.com/m/heat', body }]);
    const result = await resolveRtUrl('Heat', 1995, 'movie', fetchMock);
    expect(result).toEqual({
      url: 'https://www.rottentomatoes.com/search?search=Heat',
      score: null,
      verified: false,
    });
  });

  it('returns verified=true when year is within ±1 tolerance', async () => {
    const body = '<meta property="og:title" content="Heat (1996) - Rotten Tomatoes" />"tomatometer":98';
    const fetchMock = makeFetch([{ status: 200, url: 'https://www.rottentomatoes.com/m/heat', body }]);
    const result = await resolveRtUrl('Heat', 1995, 'movie', fetchMock);
    expect(result).toEqual({ url: 'https://www.rottentomatoes.com/m/heat', score: '98%', verified: true });
  });

  it('returns verified=false with search URL when no og:title in page', async () => {
    const body = '"tomatometer":98';
    const fetchMock = makeFetch([{ status: 200, url: 'https://www.rottentomatoes.com/m/heat', body }]);
    const result = await resolveRtUrl('Heat', 1995, 'movie', fetchMock);
    expect(result).toEqual({
      url: 'https://www.rottentomatoes.com/search?search=Heat',
      score: null,
      verified: false,
    });
  });

  it('verifies by title only when input year is null (any page year accepted)', async () => {
    const body = '<meta property="og:title" content="Heat (1995) - Rotten Tomatoes" />"tomatometer":98';
    const fetchMock = makeFetch([{ status: 200, url: 'https://www.rottentomatoes.com/m/heat', body }]);
    const result = await resolveRtUrl('Heat', null, 'movie', fetchMock);
    expect(result).toEqual({ url: 'https://www.rottentomatoes.com/m/heat', score: '98%', verified: true });
  });

  it('verifies case-insensitively and ignores punctuation differences', async () => {
    const body = '<meta property="og:title" content="Spider-Man: No Way Home (2021) - Rotten Tomatoes" />"tomatometer":90';
    const fetchMock = makeFetch([{ status: 200, url: 'https://www.rottentomatoes.com/m/spider_man_no_way_home', body }]);
    const result = await resolveRtUrl('Spider-Man: No Way Home', 2021, 'movie', fetchMock);
    expect(result).toEqual({
      url: 'https://www.rottentomatoes.com/m/spider_man_no_way_home',
      score: '90%',
      verified: true,
    });
  });

  it('tries year-suffixed url2 when url1 returns 200 but identity mismatches', async () => {
    const url1Body = '<meta property="og:title" content="Heist (2015) - Rotten Tomatoes" />';
    const url2Body = '<meta property="og:title" content="Heat (1995) - Rotten Tomatoes" />"tomatometer":98';
    const fetchMock = makeFetch([
      { status: 200, url: 'https://www.rottentomatoes.com/m/heat', body: url1Body },
      { status: 200, url: 'https://www.rottentomatoes.com/m/heat_1995', body: url2Body },
    ]);
    const result = await resolveRtUrl('Heat', 1995, 'movie', fetchMock);
    expect(result).toEqual({
      url: 'https://www.rottentomatoes.com/m/heat_1995',
      score: '98%',
      verified: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns search-URL shape when url1 is 200+mismatch and url2 is also unverified', async () => {
    const mismatchBody = '<meta property="og:title" content="Heist (2015) - Rotten Tomatoes" />';
    const fetchMock = makeFetch([
      { status: 200, url: 'https://www.rottentomatoes.com/m/heat', body: mismatchBody },
      { status: 200, url: 'https://www.rottentomatoes.com/m/heat_1995', body: mismatchBody },
    ]);
    const result = await resolveRtUrl('Heat', 1995, 'movie', fetchMock);
    expect(result).toEqual({
      url: 'https://www.rottentomatoes.com/search?search=Heat',
      score: null,
      verified: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
