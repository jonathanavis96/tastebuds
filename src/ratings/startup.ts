import type Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import type { Config } from '../config.js';
import { imdbRatingsPath, syncImdbGenres, syncImdbRatings } from '../imdb/dataset.js';

/** IMDb publishes its ratings file daily; one older than this is fetched again at startup. */
const RATINGS_FILE_STALE_MS = 36 * 60 * 60 * 1000;

/** Which IMDb syncs a starting server should run: a missing or stale ratings file, and genres never loaded. */
export async function ratingsStartupDue(
  db: InstanceType<typeof Database>,
  config: Pick<Config, 'dbPath'>,
  nowMs = Date.now(),
): Promise<{ ratings: boolean; genres: boolean }> {
  const fileTime = await stat(imdbRatingsPath(config)).then((s) => s.mtimeMs, () => null);
  const hasGenres = db.prepare('SELECT 1 FROM titles WHERE imdb_genres IS NOT NULL LIMIT 1').get() !== undefined;
  return {
    ratings: fileTime === null || nowMs - fileTime > RATINGS_FILE_STALE_MS,
    genres: !hasGenres,
  };
}

/** Run the due syncs one after the other; meant to be started without awaiting it. */
export async function runStartupRatingsSync(
  db: InstanceType<typeof Database>,
  config: Pick<Config, 'dbPath'>,
): Promise<void> {
  try {
    const due = await ratingsStartupDue(db, config);
    if (due.ratings) console.log('[tastebuds] Startup IMDb ratings sync complete:', await syncImdbRatings(db, config));
    if (due.genres) console.log('[tastebuds] Startup IMDb genres sync complete:', await syncImdbGenres(db));
  } catch (err) {
    console.error('[tastebuds] Startup IMDb sync failed:', err);
  }
}
