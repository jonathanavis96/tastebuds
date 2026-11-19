/**
 * Nightly backfill job: asks OMDb once about each catalogue title.
 *
 * IMDb ratings now come from IMDb's own ratings file (src/imdb/dataset.ts), so
 * OMDb is the source of two things only: a film's Rotten Tomatoes score, and a
 * first IMDb rating for a title the ratings file has not covered yet
 * (imdb_synced_at NULL). updateTitleRatings never lets OMDb replace a rating the
 * file confirmed or a score read from the title's own page. OMDb also lists
 * IMDb's genres, which are stored when the title has none yet.
 *
 * Strategy:
 *  1. Select up to `dailyCap` titles that have an imdb_id and no
 *     rating_checked_at (OMDb has never been asked). The stamp keeps a title OMDb
 *     knows nothing about from being asked again every night, which would drain
 *     the free-tier quota. Ordered by vote_count DESC, popularity DESC so the
 *     most-established titles go first.
 *  2. If OMDb provides no RT rating AND the title has no rt_url yet, attempt
 *     resolveRtUrl. A verified page is saved with its score (rt_verified_at);
 *     an unverified search-URL fallback is NOT written so the title can be
 *     resolved later.
 *  3. A per-title exception never aborts the batch: OMDb not answering leaves the
 *     title unchecked for the next run. The one exception is OMDb refusing the key
 *     or quota, which ends the batch because every other title would be refused too.
 *
 * Without an OMDb key the job does nothing, so that adding a key later still reaches
 * every title. The cap defaults to ~800 (RATINGS_BACKFILL_CAP), leaving ~200 of the
 * free tier's ~1 000/day for live /generate calls.
 */

import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { getOmdbRatings, OmdbUnavailableError } from '../omdb/client.js';
import { resolveRtUrl } from '../rt/resolve.js';
import { fillTitleImdbGenres, setTitleRtFromPage, updateTitleRatings } from '../db/repos/titles.js';

interface BackfillCandidate {
  id: number;
  imdb_id: string;
  title: string;
  year: number | null;
  media_type: 'movie' | 'tv';
  imdb_rating: string | null;
  rt_url: string | null;
  rt_rating: string | null;
}

/**
 * Ask OMDb about titles it has never been asked about, up to `dailyCap`.
 *
 * @returns `{ processed }` — number of titles for which an OMDb call completed
 *   without throwing (regardless of whether OMDb returned data). Titles that
 *   throw (network crash) are skipped and NOT counted so they are retried on
 *   the next nightly run.
 */
export async function backfillRatings(
  db: InstanceType<typeof Database>,
  config: Pick<Config, 'omdbApiKey'>,
  { dailyCap }: { dailyCap: number },
): Promise<{ processed: number }> {
  if (!config.omdbApiKey) return { processed: 0 };

  const candidates = db
    .prepare<[number], BackfillCandidate>(
      `SELECT id, imdb_id, title, year, media_type, imdb_rating, rt_url, rt_rating
       FROM titles
       WHERE imdb_id IS NOT NULL AND rating_checked_at IS NULL
       ORDER BY vote_count DESC, popularity DESC
       LIMIT ?`,
    )
    .all(dailyCap);

  let processed = 0;

  for (const t of candidates) {
    try {
      const ratings = await getOmdbRatings(t.imdb_id, config);

      // Scoped try/catch: RT scraping is fragile, but a scrape failure must NOT
      // skip the rating_checked_at stamp below, or the title re-enters the pool
      // every night (the very quota drain this column exists to stop).
      if (!t.rt_url && ratings.rottenTomatoes == null) {
        try {
          const result = await resolveRtUrl(t.title, t.year, t.media_type);
          if (result?.verified) setTitleRtFromPage(db, t.id, result);
        } catch {
          // RT resolution failed: fall through and still stamp the OMDb check.
        }
      }

      updateTitleRatings(db, t.id, { imdb: ratings.imdb ?? t.imdb_rating, rt: ratings.rottenTomatoes ?? t.rt_rating });
      if (ratings.genres) fillTitleImdbGenres(db, t.id, ratings.genres);

      processed++;
    } catch (err) {
      if (err instanceof OmdbUnavailableError && err.refused) {
        console.warn(`[tastebuds] Ratings backfill stopped: ${err.message}`);
        break;
      }
      // One title failure must never abort the batch — skip and continue.
    }
  }

  return { processed };
}
