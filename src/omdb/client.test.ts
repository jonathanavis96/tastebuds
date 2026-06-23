import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getOmdbRatings } from './client.js';

const mockConfig = { omdbApiKey: 'test-omdb-key' };

const fullResponse = {
  imdbID: 'tt0137523',
  Title: 'Fight Club',
  Response: 'True',
  imdbRating: '8.8',
  Ratings: [
    { Source: 'Internet Movie Database', Value: '8.8/10' },
    { Source: 'Rotten Tomatoes', Value: '79%' },
    { Source: 'Metacritic', Value: '66/100' },
  ],
};

describe('getOmdbRatings', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('parses imdbRating and Rotten Tomatoes from full response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(fullResponse), { status: 200 }),
    );
    const result = await getOmdbRatings('tt0137523', mockConfig);
    expect(result.imdb).toBe('8.8');
    expect(result.rottenTomatoes).toBe('79%');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('i=tt0137523'),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('apikey=test-omdb-key'),
    );
  });

  it('returns null for imdb when imdbRating is "N/A"', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...fullResponse, imdbRating: 'N/A' }),
        { status: 200 },
      ),
    );
    const result = await getOmdbRatings('tt0137523', mockConfig);
    expect(result.imdb).toBeNull();
    expect(result.rottenTomatoes).toBe('79%');
  });

  it('returns null for rottenTomatoes when RT source is absent', async () => {
    const noRt = {
      ...fullResponse,
      Ratings: [{ Source: 'Internet Movie Database', Value: '8.8/10' }],
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(noRt), { status: 200 }),
    );
    const result = await getOmdbRatings('tt0137523', mockConfig);
    expect(result.imdb).toBe('8.8');
    expect(result.rottenTomatoes).toBeNull();
  });

  it('returns null for rottenTomatoes when RT Value is "N/A"', async () => {
    const rtNA = {
      ...fullResponse,
      Ratings: [
        { Source: 'Internet Movie Database', Value: '8.8/10' },
        { Source: 'Rotten Tomatoes', Value: 'N/A' },
      ],
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(rtNA), { status: 200 }),
    );
    const result = await getOmdbRatings('tt0137523', mockConfig);
    expect(result.rottenTomatoes).toBeNull();
  });

  it('returns all-null when Response is "False"', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ Response: 'False', Error: 'Movie not found!' }),
        { status: 200 },
      ),
    );
    const result = await getOmdbRatings('tt9999999', mockConfig);
    expect(result.imdb).toBeNull();
    expect(result.rottenTomatoes).toBeNull();
  });

  it('returns all-null on non-200 response and does not throw', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );
    await expect(getOmdbRatings('tt0137523', mockConfig)).resolves.toEqual({
      imdb: null,
      rottenTomatoes: null,
    });
  });

  it('returns all-null when omdbApiKey is undefined', async () => {
    const result = await getOmdbRatings('tt0137523', { omdbApiKey: undefined });
    expect(result.imdb).toBeNull();
    expect(result.rottenTomatoes).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns all-null on fetch network error and does not throw', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network failure'));
    await expect(getOmdbRatings('tt0137523', mockConfig)).resolves.toEqual({
      imdb: null,
      rottenTomatoes: null,
    });
  });
});
