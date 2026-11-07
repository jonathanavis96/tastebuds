import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getOmdbRatings, OmdbUnavailableError } from './client.js';

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
      expect.anything(),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('apikey=test-omdb-key'),
      expect.anything(),
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

  it('reports a 401 as a refusal, so a used-up quota is never stored as "no ratings"', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ Response: 'False', Error: 'Request limit reached!' }), { status: 401 }),
    );
    await expect(getOmdbRatings('tt0137523', mockConfig)).rejects.toMatchObject({
      name: 'OmdbUnavailableError',
      refused: true,
    });
  });

  it.each(['Request limit reached!', 'Invalid API key!', 'No API key provided.'])(
    'reports a 200 carrying "%s" as a refusal',
    async (Error) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ Response: 'False', Error }), { status: 200 }),
      );
      await expect(getOmdbRatings('tt0137523', mockConfig)).rejects.toMatchObject({ refused: true });
    },
  );

  it('reports a server error as unavailable, not as a title with no ratings', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('oops', { status: 503 }));
    const err = await getOmdbRatings('tt0137523', mockConfig).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OmdbUnavailableError);
    expect((err as OmdbUnavailableError).refused).toBe(false);
  });

  it('reports an unreadable body as unavailable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<html>down</html>', { status: 200 }));
    await expect(getOmdbRatings('tt0137523', mockConfig)).rejects.toBeInstanceOf(OmdbUnavailableError);
  });

  it('never puts the API key in an error message', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network failure'));
    const err = await getOmdbRatings('tt0137523', mockConfig).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('test-omdb-key');
  });

  it('gives up on a stalled request instead of waiting on it', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(fullResponse), { status: 200 }));
    await getOmdbRatings('tt0137523', mockConfig);
    const init = vi.mocked(fetch).mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns all-null when omdbApiKey is undefined', async () => {
    const result = await getOmdbRatings('tt0137523', { omdbApiKey: undefined });
    expect(result.imdb).toBeNull();
    expect(result.rottenTomatoes).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a network error as unavailable', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network failure'));
    await expect(getOmdbRatings('tt0137523', mockConfig)).rejects.toMatchObject({
      name: 'OmdbUnavailableError',
      refused: false,
    });
  });
});
