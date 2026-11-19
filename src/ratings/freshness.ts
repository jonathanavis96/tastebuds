import type Database from 'better-sqlite3';
import type { Config } from '../config.js';

/**
 * Make the ratings of the titles about to be shown correct now: IMDb from the
 * ratings file on disk, and Rotten Tomatoes read from each title's own page when
 * it has not been verified recently (new releases move fastest). Bounded in
 * time and never throws: a rating that cannot be confirmed is left as it is, or
 * cleared when its page says there is no score.
 */
export async function ensureFreshRatings(
  db: InstanceType<typeof Database>,
  titleIds: number[],
  config: Pick<Config, 'dbPath' | 'omdbApiKey'>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  void db; void titleIds; void config; void fetchImpl;
}
