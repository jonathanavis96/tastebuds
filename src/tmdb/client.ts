import type { Config } from '../config.js';
import type { DiscoverOpts, IdMatch, TmdbTitle, TmdbTitleDetail } from './types.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
/** Per call: harvest and /generate loop over these, so a stall must fail fast. */
const TMDB_TIMEOUT_MS = 15_000;

async function tmdbFetch<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TMDB_TIMEOUT_MS) });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`TMDB request failed with HTTP ${response.status}: ${body}`);
  }
  return response.json() as Promise<T>;
}

function joinIds(ids: number[] | undefined, match: IdMatch = 'all'): string | undefined {
  return ids?.length ? ids.join(match === 'any' ? '|' : ',') : undefined;
}

export async function discoverTitles(
  opts: DiscoverOpts,
  config: Pick<Config, 'tmdbApiKey'>,
): Promise<TmdbTitle[]> {
  const dateField = opts.mediaType === 'movie' ? 'primary_release_date' : 'first_air_date';
  const params: Array<[string, string | number | undefined]> = [
    ['with_genres', joinIds(opts.genreIds, opts.genreMatch)],
    ['without_genres', joinIds(opts.withoutGenreIds, 'any')],
    ['with_keywords', joinIds(opts.keywordIds, opts.keywordMatch)],
    ['without_keywords', joinIds(opts.withoutKeywordIds, 'any')],
    [`${dateField}.gte`, opts.releasedFrom],
    [`${dateField}.lte`, opts.releasedTo],
    ['with_original_language', opts.originalLanguage],
    ['page', opts.page ?? 1],
    ['sort_by', opts.sortBy],
    ['vote_count.gte', opts.voteCountGte],
  ];
  const query = params
    .filter((p): p is [string, string | number] => p[1] !== undefined)
    .map(([key, value]) => `&${key}=${encodeURIComponent(String(value))}`)
    .join('');
  const url = `${TMDB_BASE}/discover/${opts.mediaType}?api_key=${config.tmdbApiKey}${query}`;
  const data = await tmdbFetch<{ results: TmdbTitle[] }>(url);
  return data.results;
}

/**
 * Search TMDB for a keyword by name and return the matching results.
 * Used to resolve vibe words (e.g. "horror", "thriller") into TMDB keyword ids
 * for TV discovery, where those genres don't exist in the TV genre taxonomy.
 */
export async function searchKeyword(
  query: string,
  config: Pick<Config, 'tmdbApiKey'>,
): Promise<Array<{ id: number; name: string }>> {
  const url = `${TMDB_BASE}/search/keyword?api_key=${config.tmdbApiKey}&query=${encodeURIComponent(query)}`;
  const data = await tmdbFetch<{ results: Array<{ id: number; name: string }> }>(url);
  return data.results;
}

export async function getTrendingTitles(
  mediaType: 'movie' | 'tv',
  config: Pick<Config, 'tmdbApiKey'>,
): Promise<TmdbTitle[]> {
  const url = `${TMDB_BASE}/trending/${mediaType}/week?api_key=${config.tmdbApiKey}`;
  const data = await tmdbFetch<{ results: TmdbTitle[] }>(url);
  return data.results;
}

export async function getTitleDetails(
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  config: Pick<Config, 'tmdbApiKey'>,
): Promise<TmdbTitleDetail> {
  const endpoint = mediaType === 'movie' ? 'movie' : 'tv';
  const url = `${TMDB_BASE}/${endpoint}/${tmdbId}?api_key=${config.tmdbApiKey}&append_to_response=keywords,credits,external_ids`;
  return tmdbFetch<TmdbTitleDetail>(url);
}

/**
 * Lightweight metadata-only fetch (NO append_to_response) — used by the
 * backfillTitleMeta job, which only needs original_language, runtime,
 * vote_average and status, not the full keywords/credits/external_ids payload
 * that getTitleDetails pulls for harvest/curation.
 */
export async function getTitleMeta(
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  config: Pick<Config, 'tmdbApiKey'>,
): Promise<TmdbTitleDetail> {
  const endpoint = mediaType === 'movie' ? 'movie' : 'tv';
  const url = `${TMDB_BASE}/${endpoint}/${tmdbId}?api_key=${config.tmdbApiKey}`;
  return tmdbFetch<TmdbTitleDetail>(url);
}

export async function searchTitles(
  query: string,
  mediaType: 'movie' | 'tv',
  config: Pick<Config, 'tmdbApiKey'>,
  year?: number,
): Promise<TmdbTitle[]> {
  const yearParam =
    year !== undefined
      ? mediaType === 'movie'
        ? `&year=${year}`
        : `&first_air_date_year=${year}`
      : '';
  const url = `${TMDB_BASE}/search/${mediaType}?api_key=${config.tmdbApiKey}&query=${encodeURIComponent(query)}${yearParam}`;
  const data = await tmdbFetch<{ results: TmdbTitle[] }>(url);
  return data.results;
}
