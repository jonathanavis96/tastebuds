/**
 * Harvest page cursor — persists how deep the nightly harvest has paged through
 * each TMDB discovery "bucket" so it sweeps the catalogue instead of re-listing
 * page 1 every night (which mostly returns titles already in the DB).
 *
 * A "bucket" is a stable key for one recurring discover query, e.g.
 *   "movie:broad"          — global most-voted movies
 *   "tv:genre:18"          — TV drama round-robin slice
 *   "movie:loved:18,28"    — a profile's loved-genre movie discover
 *
 * Each harvest claims the bucket's current page (starting at 1) and advances the
 * stored cursor by one, wrapping back to 1 once it passes maxPage. Over many
 * nights this walks pages 1 → maxPage → 1 → … so every run fetches a fresh slice.
 */

import type Database from 'better-sqlite3';

interface CursorRow {
  next_page: number;
}

/**
 * Return the page this bucket should fetch NOW, and atomically advance its
 * stored cursor to the next page (wrapping to 1 after maxPage).
 *
 * First ever call for a bucket returns page 1. Buckets are independent.
 */
export function claimPage(
  db: InstanceType<typeof Database>,
  bucket: string,
  maxPage: number,
): number {
  const row = db
    .prepare('SELECT next_page FROM harvest_cursor WHERE bucket = ?')
    .get(bucket) as CursorRow | undefined;

  // Clamp the stored page into [1, maxPage] in case maxPage shrank since last run.
  const page = Math.min(Math.max(1, row?.next_page ?? 1), maxPage);
  const advanced = page >= maxPage ? 1 : page + 1;

  db.prepare(`
    INSERT INTO harvest_cursor (bucket, next_page)
    VALUES (?, ?)
    ON CONFLICT (bucket) DO UPDATE SET next_page = excluded.next_page
  `).run(bucket, advanced);

  return page;
}

/** Read a bucket's stored next_page without advancing it (defaults to 1). */
export function peekNextPage(
  db: InstanceType<typeof Database>,
  bucket: string,
): number {
  const row = db
    .prepare('SELECT next_page FROM harvest_cursor WHERE bucket = ?')
    .get(bucket) as CursorRow | undefined;
  return row?.next_page ?? 1;
}
