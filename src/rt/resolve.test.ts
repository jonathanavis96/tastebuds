/**
 * Unit tests for slugifyRtTitle, parseTomatometer, and resolveRtUrl.
 * Network is never hit — fetch is injected as a mock.
 */
import { describe, it, expect, vi } from 'vitest';
import { slugifyRtTitle, parseTomatometer, resolveRtUrl } from './resolve.js';

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
      body: 'data "tomatometer":91 more',
    }]);
    const result = await resolveRtUrl('They Cloned Tyrone', 2023, 'movie', fetchMock);
    expect(result).toEqual({
      url: 'https://www.rottentomatoes.com/m/they_cloned_tyrone',
      score: '91%',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns score null when page body has no tomatometer', async () => {
    const fetchMock = makeFetch([{
      status: 200,
      url: 'https://www.rottentomatoes.com/m/some_film',
      body: '<html>no score</html>',
    }]);
    const result = await resolveRtUrl('Some Film', 2020, 'movie', fetchMock);
    expect(result).toEqual({
      url: 'https://www.rottentomatoes.com/m/some_film',
      score: null,
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
      { status: 200, url: 'https://www.rottentomatoes.com/m/heat_1995', body: '"tomatometer":98' },
    ]);
    const result = await resolveRtUrl('Heat', 1995, 'movie', fetchMock);
    expect(result).toEqual({
      url: 'https://www.rottentomatoes.com/m/heat_1995',
      score: '98%',
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
