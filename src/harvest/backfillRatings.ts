/**
 * Nightly backfill job: fills missing OMDb ratings for catalogue titles.
 *
 * Strategy (mirrors the OMDb-first enrichment loop in src/api/routes.ts):
 *  1. Select up to `dailyCap` titles that have an imdb_id but no imdb_rating,
 *     ordered by id ASC (insertion order). The titles table has no popularity
 *     column; insertion order is a reasonable proxy since the harvest sweeps
 *     popular titles from TMDB first.
 *  2. For each, fetch OMDb ratings (authority for both imdb + RT).
 *  3. If OMDb provides no RT rating AND the title has no rt_url yet, attempt
 *     resolveRtUrl — persist url/score ONLY when verified === true (unverified
 *     search-URL fallbacks are NOT written so the title can be retried later).
 *  4. A per-title exception never aborts the batch — skip and continue.
 *
 * The cap is set to ~800 by default (RATINGS_BACKFILL_CAP env) leaving ~200
 * of the OMDb free tier's ~1 000/day quota available for live /generate calls.
 */

import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { getOmdbRatings } from '../omdb/client.js';
import { resolveRtUrl } from '../rt/resolve.js';
import { updateTitleRatings, updateTitleRtUrl } from '../db/repos/titles.js';

interface BackfillCandidate {
  id: number;
  imdb_id: string;
  title: string;
  year: number | null;
  media_type: 'movie' | 'tv';
  rt_url: string | null;
}

/**
 * Fill in missing ratings for catalogue titles, OMDb-first, up to `dailyCap`.
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
  const candidates = db
    .prepare<[number], BackfillCandidate>(
      `SELECT id, imdb_id, title, year, media_type, rt_url
       FROM titles
       WHERE imdb_id IS NOT NULL AND imdb_rating IS NULL
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(dailyCap);

  let processed = 0;

  for (const t of candidates) {
    try {
      // OMDb is the authority for both imdb and RT ratings.
      const ratings = await getOmdbRatings(t.imdb_id, config);
      let rt = ratings.rottenTomatoes;

      // RT URL: only resolve when no URL is stored yet and OMDb provided no RT.
      // This mirrors the logic in src/api/routes.ts lines ~241-253.
      if (!t.rt_url && rt == null) {
        const result = await resolveRtUrl(t.title, t.year, t.media_type);
        // Only persist when verified — storing an unverified search-URL would
        // block future re-resolution (the !t.rt_url guard above would trip).
        if (result?.verified) {
          updateTitleRtUrl(db, t.id, result.url);
          if (result.score) rt = result.score;
        }
      }

      // Single write per title — final rt is OMDb's value, or a verified RT scrape.
      updateTitleRatings(db, t.id, { imdb: ratings.imdb, rt });

      processed++;
    } catch {
      // One title failure must never abort the batch — skip and continue.
    }
  }

  return { processed };
}
