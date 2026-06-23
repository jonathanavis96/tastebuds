import type { Config } from '../config.js';

const OMDB_BASE = 'https://www.omdbapi.com/';

export async function getOmdbRatings(
  imdbId: string,
  config: Pick<Config, 'omdbApiKey'>,
): Promise<{ imdb: string | null; rottenTomatoes: string | null }> {
  const none = { imdb: null, rottenTomatoes: null };

  if (!config.omdbApiKey) return none;

  try {
    const url = `${OMDB_BASE}?i=${encodeURIComponent(imdbId)}&apikey=${config.omdbApiKey}`;
    const response = await fetch(url);
    if (!response.ok) return none;

    const data = await response.json() as {
      Response?: string;
      imdbRating?: string;
      Ratings?: Array<{ Source: string; Value: string }>;
    };

    if (data.Response === 'False') return none;

    const imdb =
      data.imdbRating && data.imdbRating !== 'N/A' ? data.imdbRating : null;

    const rtEntry = (data.Ratings ?? []).find((r) => r.Source === 'Rotten Tomatoes');
    const rottenTomatoes =
      rtEntry && rtEntry.Value !== 'N/A' ? rtEntry.Value : null;

    return { imdb, rottenTomatoes };
  } catch {
    return none;
  }
}
