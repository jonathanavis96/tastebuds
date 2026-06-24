import type { Config } from '../config.js';
import type { DiscoverOpts, TmdbTitle, TmdbTitleDetail } from './types.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';

async function tmdbFetch<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`TMDB request failed with HTTP ${response.status}: ${body}`);
  }
  return response.json() as Promise<T>;
}

export async function discoverTitles(
  opts: DiscoverOpts,
  config: Pick<Config, 'tmdbApiKey'>,
): Promise<TmdbTitle[]> {
  const genreParam = opts.genreIds?.length ? `&with_genres=${opts.genreIds.join(',')}` : '';
  const keywordParam = opts.keywordIds?.length ? `&with_keywords=${opts.keywordIds.join(',')}` : '';
  const pageParam = `&page=${opts.page ?? 1}`;
  const sortParam = opts.sortBy ? `&sort_by=${encodeURIComponent(opts.sortBy)}` : '';
  const voteParam = opts.voteCountGte != null ? `&vote_count.gte=${opts.voteCountGte}` : '';
  const url = `${TMDB_BASE}/discover/${opts.mediaType}?api_key=${config.tmdbApiKey}${genreParam}${keywordParam}${pageParam}${sortParam}${voteParam}`;
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
