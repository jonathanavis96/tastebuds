/**
 * Fills missing imdb_id values from TMDB's external ids. Without an imdb_id a
 * title can never get an IMDb rating from IMDb's ratings file, and a new release
 * often has no IMDb id on TMDB yet when it is first stored, so titles without one
 * are asked again every 14 days.
 */
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { TmdbTitleDetail } from '../tmdb/types.js';
import { getTitleDetails } from '../tmdb/client.js';
import { markTitleImdbIdChecked } from '../db/repos/titles.js';

export const IMDB_ID_FILL_CAP_DEFAULT = 1500;
const RECHECK_AFTER_SECONDS = 14 * 24 * 60 * 60;
/** At most 20 requests a second, well under TMDB's limit. */
const MIN_REQUEST_INTERVAL_MS = 50;

interface Candidate {
  id: number;
  tmdb_id: number;
  media_type: 'movie' | 'tv';
}

/** The IMDb id TMDB lists for a title: films carry it top-level, series under external_ids. */
function imdbIdOf(detail: TmdbTitleDetail): string | null {
  const id = detail.imdb_id || detail.external_ids?.imdb_id;
  return id && /^tt\d+$/.test(id) ? id : null;
}

/**
 * Ask TMDB for the imdb_id of up to `cap` titles that have none, never-asked
 * titles first. Every answered title is stamped imdb_id_checked_at, a 404 too
 * (TMDB removed it); a failed request is left for the next run.
 */
export async function fillMissingImdbIds(
  db: InstanceType<typeof Database>,
  config: Pick<Config, 'tmdbApiKey'>,
  opts: {
    cap: number;
    fetchDetail?: typeof getTitleDetails;
  },
): Promise<{ checked: number; found: number; errors: number }> {
  const fetchDetail = opts.fetchDetail ?? getTitleDetails;
  const now = Math.floor(Date.now() / 1000);
  const candidates = db
    .prepare<[number, number], Candidate>(
      `SELECT id, tmdb_id, media_type FROM titles
       WHERE imdb_id IS NULL AND (imdb_id_checked_at IS NULL OR imdb_id_checked_at < ?)
       ORDER BY imdb_id_checked_at IS NOT NULL, imdb_id_checked_at, popularity DESC, id
       LIMIT ?`,
    )
    .all(now - RECHECK_AFTER_SECONDS, opts.cap);

  let checked = 0;
  let found = 0;
  let errors = 0;
  let lastStart = 0;

  for (const t of candidates) {
    const wait = lastStart + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastStart = Date.now();

    try {
      const imdbId = imdbIdOf(await fetchDetail(t.tmdb_id, t.media_type, config));
      markTitleImdbIdChecked(db, t.id, imdbId);
      checked++;
      if (imdbId) found++;
    } catch (err) {
      if (err instanceof Error && /HTTP 404/.test(err.message)) {
        markTitleImdbIdChecked(db, t.id, null);
        checked++;
      } else {
        errors++;
      }
    }
  }

  return { checked, found, errors };
}
