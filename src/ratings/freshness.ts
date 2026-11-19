import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { applyCachedImdbRatings } from '../imdb/dataset.js';
import { readRtScore, resolveRtUrl } from '../rt/resolve.js';
import { markTitleRtChecked, setTitleRtFromPage } from '../db/repos/titles.js';

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
/** IMDb publishes its ratings file daily; a rating older than this is re-read from the file. */
const IMDB_STALE_SECONDS = 36 * HOUR;
/** New releases gather reviews fast, so their Rotten Tomatoes score is re-read sooner. */
const RT_STALE_RECENT_SECONDS = 7 * DAY;
const RT_STALE_OLDER_SECONDS = 60 * DAY;
const PAGE_TIMEOUT_MS = 6_000;
const OVERALL_TIMEOUT_MS = 8_000;

interface ShownTitle {
  id: number;
  title: string;
  year: number | null;
  media_type: 'movie' | 'tv';
  imdb_id: string | null;
  imdb_synced_at: number | null;
  rt_url: string | null;
  rt_verified_at: number | null;
  rt_checked_at: number | null;
}

function rtStaleAfter(year: number | null, now: number): number {
  const currentYear = new Date(now * 1000).getUTCFullYear();
  return year != null && year >= currentYear - 1 ? RT_STALE_RECENT_SECONDS : RT_STALE_OLDER_SECONDS;
}

/** True when the title's Rotten Tomatoes score should be read from its page now. */
function rtDue(t: ShownTitle, now: number): boolean {
  const staleAfter = rtStaleAfter(t.year, now);
  if (t.rt_verified_at != null) return now - t.rt_verified_at >= staleAfter;
  // Finding a page costs up to three requests: a title tried recently whose
  // page was not found is not tried again on every showing.
  return t.rt_checked_at == null || now - t.rt_checked_at >= staleAfter;
}

async function refreshRt(
  db: InstanceType<typeof Database>,
  t: ShownTitle,
  fetchImpl: typeof fetch,
  isOpen: () => boolean,
): Promise<void> {
  if (t.rt_url) {
    const page = await readRtScore(t.rt_url, t.title, t.year, fetchImpl);
    if (!isOpen() || page === null) return;
    if (page.verified) {
      setTitleRtFromPage(db, t.id, page);
      return;
    }
    // The stored page is another title (often an older film of the same name):
    // look for the title's own page, which may carry the year in its address.
  }
  const found = await resolveRtUrl(t.title, t.year, t.media_type, fetchImpl);
  if (!isOpen()) return;
  if (found?.verified) setTitleRtFromPage(db, t.id, found);
  else markTitleRtChecked(db, t.id);
}

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
  if (titleIds.length === 0) return;
  let open = true;
  let timer: NodeJS.Timeout | undefined;
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = db
      .prepare(
        `SELECT id, title, year, media_type, imdb_id, imdb_synced_at, rt_url, rt_verified_at, rt_checked_at
         FROM titles WHERE id IN (${titleIds.map(() => '?').join(',')})`,
      )
      .all(...titleIds) as ShownTitle[];

    const imdbStale = rows
      .filter((t) => t.imdb_id && (t.imdb_synced_at == null || now - t.imdb_synced_at >= IMDB_STALE_SECONDS))
      .map((t) => t.id);

    // Every page request gets its own limit and all of them stop at the overall one.
    const deadline = new AbortController();
    const boundedFetch: typeof fetch = (input, init) =>
      fetchImpl(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(PAGE_TIMEOUT_MS), deadline.signal]) });

    const work = Promise.allSettled([
      imdbStale.length > 0 ? applyCachedImdbRatings(db, config, imdbStale) : Promise.resolve(0),
      ...rows.filter((t) => rtDue(t, now)).map((t) => refreshRt(db, t, boundedFetch, () => open)),
    ]);
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        deadline.abort();
        resolve();
      }, OVERALL_TIMEOUT_MS);
    });
    await Promise.race([work, expired]);
  } catch (err) {
    console.warn('[tastebuds] Rating refresh skipped:', err);
  } finally {
    open = false;
    clearTimeout(timer);
  }
}
