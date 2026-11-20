/**
 * Backfill job: fills the four TMDB metadata columns (original_language,
 * runtime_minutes, vote_average, status) — plus a fresh popularity/vote_count
 * snapshot — for catalogue titles that have never had TMDB meta fetched
 * (meta_checked_at IS NULL). Covers both the ~17.8k pre-existing rows seeded
 * before these columns existed, and any title a future harvest inserts without
 * populating them.
 *
 * It also reads the metadata again for titles from the recent window
 * (DEFAULT_RECENT_YEARS) once their last read is META_REFRESH_DAYS old. A title
 * stored before its release keeps "Post Production" and a handful of votes
 * until it is read again, and the hard filters drop it as unreleased: on
 * 2026-11-20, 1,244 of 1,818 titles from 2026 still had fewer than 20 TMDB
 * votes from a read made in September.
 *
 * Selection order: never-read titles first, with a NULL vote_count first among
 * them (never harvested with the newer popularity/vote_count columns either —
 * the oldest, least-known rows), then by vote_count DESC (well-known titles
 * next), then id ASC as a stable tiebreak; after them the recent titles whose
 * read is oldest.
 *
 * A TMDB 404 means the title was removed from TMDB — stamp meta_checked_at
 * and status = 'Missing' so it drops out of the candidate pool (not retried
 * nightly). Any other error (network, rate limit, etc.) is left unstamped so
 * it's retried on a later run, and counted separately.
 *
 * Runs with a small worker pool (default concurrency 4) and a ~60ms pause
 * between request starts per worker to stay well under TMDB's ~40 req/s rate
 * limit.
 */

import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { TmdbTitleDetail } from '../tmdb/types.js';
import { getTitleMeta } from '../tmdb/client.js';
import { updateTitleMeta } from '../db/repos/titles.js';
import { DEFAULT_RECENT_YEARS } from '../request/rules.js';

interface MetaBackfillCandidate {
  id: number;
  tmdb_id: number;
  media_type: 'movie' | 'tv';
}

/** A recent title's TMDB metadata is read again once its last read is this many days old. */
export const META_REFRESH_DAYS = 7;

const REQUEST_PAUSE_MS = 60;
const LOG_EVERY = 500;

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /HTTP 404/.test(err.message);
}

function extractMeta(detail: TmdbTitleDetail, mediaType: 'movie' | 'tv') {
  const runtime_minutes =
    mediaType === 'movie'
      ? detail.runtime || null
      : (detail.episode_run_time ?? []).find((r) => r > 0) ?? null;

  return {
    original_language: detail.original_language ?? null,
    runtime_minutes,
    vote_average: detail.vote_average ?? null,
    status: detail.status ?? null,
    popularity: detail.popularity,
    vote_count: detail.vote_count,
  };
}

export async function backfillTitleMeta(
  db: InstanceType<typeof Database>,
  config: Pick<Config, 'tmdbApiKey'>,
  opts: {
    cap: number;
    concurrency?: number;
    fetchDetail?: (
      tmdbId: number,
      mediaType: 'movie' | 'tv',
      config: Pick<Config, 'tmdbApiKey'>,
    ) => Promise<TmdbTitleDetail>;
    now?: Date;
  },
): Promise<{ processed: number; missing: number; errors: number }> {
  const fetchDetail = opts.fetchDetail ?? getTitleMeta;
  const concurrency = opts.concurrency ?? 4;
  const now = opts.now ?? new Date();
  const recentFrom = now.getFullYear() - (DEFAULT_RECENT_YEARS - 1);
  const staleBefore = Math.floor(now.getTime() / 1000) - META_REFRESH_DAYS * 86_400;

  const candidates = db
    .prepare<[number, number, number], MetaBackfillCandidate>(
      `SELECT id, tmdb_id, media_type
       FROM titles
       WHERE meta_checked_at IS NULL OR (year >= ? AND meta_checked_at < ?)
       ORDER BY (meta_checked_at IS NOT NULL), meta_checked_at, (vote_count IS NULL), vote_count DESC, id ASC
       LIMIT ?`,
    )
    .all(recentFrom, staleBefore, opts.cap);

  let processed = 0;
  let missing = 0;
  let errors = 0;
  let nextIndex = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= candidates.length) return;
      const t = candidates[i];

      await new Promise((resolve) => setTimeout(resolve, REQUEST_PAUSE_MS));

      try {
        const detail = await fetchDetail(t.tmdb_id, t.media_type, config);
        const meta = extractMeta(detail, t.media_type);
        updateTitleMeta(db, t.id, {
          ...meta,
          meta_checked_at: Math.floor(Date.now() / 1000),
        });
        processed++;
      } catch (err) {
        if (isNotFoundError(err)) {
          updateTitleMeta(db, t.id, {
            original_language: null,
            runtime_minutes: null,
            vote_average: null,
            status: 'Missing',
            meta_checked_at: Math.floor(Date.now() / 1000),
          });
          missing++;
        } else {
          errors++;
        }
      }

      completed++;
      if (completed % LOG_EVERY === 0) {
        console.log(`[tastebuds] Meta backfill progress: ${completed}/${candidates.length}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker());
  await Promise.all(workers);

  return { processed, missing, errors };
}
