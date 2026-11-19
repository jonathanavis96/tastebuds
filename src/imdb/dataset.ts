import type Database from 'better-sqlite3';
import type { Config } from '../config.js';

/** IMDb's daily non-commercial data files (https://developer.imdb.com/non-commercial-datasets/). */
export const IMDB_RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
export const IMDB_BASICS_URL = 'https://datasets.imdbws.com/title.basics.tsv.gz';

export interface ImdbRatingsSyncResult {
  /** Titles whose rating or vote count changed. */
  updated: number;
  /** Titles that had a rating which IMDb no longer lists. */
  cleared: number;
  /** Titles with an imdb_id that were compared. */
  checked: number;
  /** True when the file had not changed since the last sync and nothing was read. */
  unchanged: boolean;
}

/**
 * Download IMDb's ratings file and make imdb_rating / imdb_votes match it for
 * every title with an imdb_id, stamping imdb_synced_at. The file is kept beside
 * the database so applyCachedImdbRatings can read it without a download.
 */
export async function syncImdbRatings(
  db: InstanceType<typeof Database>,
  config: Pick<Config, 'dbPath'>,
  fetchImpl: typeof fetch = fetch,
): Promise<ImdbRatingsSyncResult> {
  void db; void config; void fetchImpl;
  throw new Error('not implemented');
}

/**
 * Set imdb_rating / imdb_votes for `titleIds` from the ratings file already on
 * disk (titles added since the last sync). Returns how many got a rating; 0 when
 * there is no file yet.
 */
export async function applyCachedImdbRatings(
  db: InstanceType<typeof Database>,
  config: Pick<Config, 'dbPath'>,
  titleIds: number[],
): Promise<number> {
  void db; void config; void titleIds;
  throw new Error('not implemented');
}

/**
 * Stream IMDb's title.basics file (about 230 MB, not kept) and store each
 * catalogue title's IMDb genres in imdb_genres. Returns how many rows changed.
 */
export async function syncImdbGenres(
  db: InstanceType<typeof Database>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ updated: number }> {
  void db; void fetchImpl;
  throw new Error('not implemented');
}
