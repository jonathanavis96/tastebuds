import type Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import type { Config } from '../config.js';
import { imdbRatingsPath, syncImdbRatings } from '../imdb/dataset.js';
import { fillImdbGaps } from '../imdb/gapFill.js';

/** IMDb publishes its ratings file daily; one older than this is fetched again at startup. */
const RATINGS_FILE_STALE_MS = 36 * 60 * 60 * 1000;

/**
 * Which IMDb syncs a starting server should run: a missing or stale ratings
 * file, and the basics pass (genres and gap fill) when genres were never loaded
 * or the gap fill has never run.
 */
export async function ratingsStartupDue(
  db: InstanceType<typeof Database>,
  config: Pick<Config, 'dbPath'>,
  nowMs = Date.now(),
): Promise<{ ratings: boolean; basics: boolean }> {
  const fileTime = await stat(imdbRatingsPath(config)).then((s) => s.mtimeMs, () => null);
  const hasGenres = db.prepare('SELECT 1 FROM titles WHERE imdb_genres IS NOT NULL LIMIT 1').get() !== undefined;
  const gapFillRan = db.prepare('SELECT 1 FROM imdb_gap_checks LIMIT 1').get() !== undefined;
  return {
    ratings: fileTime === null || nowMs - fileTime > RATINGS_FILE_STALE_MS,
    basics: !hasGenres || !gapFillRan,
  };
}

/** Run the due syncs one after the other; meant to be started without awaiting it. */
export async function runStartupRatingsSync(
  db: InstanceType<typeof Database>,
  config: Config,
): Promise<void> {
  try {
    const due = await ratingsStartupDue(db, config);
    if (due.ratings) console.log('[tastebuds] Startup IMDb ratings sync complete:', await syncImdbRatings(db, config));
    if (due.basics) console.log('[tastebuds] Startup IMDb genres and gap fill complete:', await fillImdbGaps(db, config));
  } catch (err) {
    console.error('[tastebuds] Startup IMDb sync failed:', err);
  }
}
