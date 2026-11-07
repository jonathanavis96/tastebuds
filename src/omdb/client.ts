import type { Config } from '../config.js';

const OMDB_BASE = 'https://www.omdbapi.com/';
/** One lookup, not the whole /generate, waits this long on a stalled OMDb. */
const OMDB_TIMEOUT_MS = 10_000;

/**
 * OMDb gave no answer about the title, so nothing is known about its ratings and
 * callers must not mark it checked. `refused` means the key or the daily quota was
 * turned down: every other lookup would fail the same way, so callers stop asking.
 */
export class OmdbUnavailableError extends Error {
  constructor(message: string, readonly refused: boolean) {
    super(message);
    this.name = 'OmdbUnavailableError';
  }
}

/**
 * Resolves with OMDb's answer, which is all-null when it does not know the title.
 * Rejects with OmdbUnavailableError when it did not answer at all.
 */
export async function getOmdbRatings(
  imdbId: string,
  config: Pick<Config, 'omdbApiKey'>,
): Promise<{ imdb: string | null; rottenTomatoes: string | null }> {
  const none = { imdb: null, rottenTomatoes: null };

  if (!config.omdbApiKey) return none;

  const url = `${OMDB_BASE}?i=${encodeURIComponent(imdbId)}&apikey=${config.omdbApiKey}`;
  let data: {
    Response?: string;
    Error?: string;
    imdbRating?: string;
    Ratings?: Array<{ Source: string; Value: string }>;
  };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(OMDB_TIMEOUT_MS) });
    // OMDb sends 401 for both a bad key and a used-up daily quota.
    if (response.status === 401) throw new OmdbUnavailableError('OMDb refused the request (HTTP 401)', true);
    if (!response.ok) throw new OmdbUnavailableError(`OMDb returned HTTP ${response.status}`, false);
    data = await response.json() as typeof data;
  } catch (err) {
    if (err instanceof OmdbUnavailableError) throw err;
    // The message is the error's name only: the request URL carries the API key.
    throw new OmdbUnavailableError(`OMDb request failed: ${(err as Error).name}`, false);
  }

  if (data.Response === 'False') {
    if (/limit|api key/i.test(data.Error ?? '')) {
      throw new OmdbUnavailableError(`OMDb refused the request: ${data.Error}`, true);
    }
    return none; // "Movie not found!" and the like: a real answer.
  }

  const imdb =
    data.imdbRating && data.imdbRating !== 'N/A' ? data.imdbRating : null;

  const rtEntry = (data.Ratings ?? []).find((r) => r.Source === 'Rotten Tomatoes');
  const rottenTomatoes =
    rtEntry && rtEntry.Value !== 'N/A' ? rtEntry.Value : null;

  return { imdb, rottenTomatoes };
}
