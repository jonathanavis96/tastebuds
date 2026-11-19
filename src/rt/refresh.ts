/**
 * Nightly Rotten Tomatoes refresh: re-reads the critics score from the stored
 * page of titles that have an rt_url. Scores move as reviews come in, and every
 * score scraped before migration 015 was dropped because it came from another
 * title, so titles never verified go first, then the ones verified longest ago.
 * A stored page that is not the title is replaced by the title's own page when
 * one can be found, and dropped when none can.
 */
import type Database from 'better-sqlite3';
import { setTitleRtFromPage, setTitleRtUnconfirmed } from '../db/repos/titles.js';
import { findRtPage } from './resolve.js';

/** One page a second: the site is scraped, so it is asked politely. */
const PAUSE_MS = 1000;
/** This many failed requests in a row means the site is blocking us; stop for tonight. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** A page that answered but could not be confirmed as the title is tried again after this. */
const UNCONFIRMED_RETRY_SECONDS = 7 * 24 * 60 * 60;

interface Candidate {
  id: number;
  title: string;
  year: number | null;
  media_type: 'movie' | 'tv';
  rt_url: string;
}

export interface RtRefreshResult {
  /** Pages confirmed as the title; their score (or its absence) was saved. */
  verified: number;
  /** Of those, pages that show no critics score (the stored score is cleared). */
  noScore: number;
  /** Titles whose stored page is gone or another title, with no page of their own found: the page is dropped. */
  unconfirmed: number;
  /** Requests that got no answer. */
  failed: number;
  /** True when the run stopped early after repeated failures. */
  blocked: boolean;
}

export async function refreshRtScores(
  db: InstanceType<typeof Database>,
  opts: { cap: number; fetchImpl?: typeof fetch; pauseMs?: number },
): Promise<RtRefreshResult> {
  const pauseMs = opts.pauseMs ?? PAUSE_MS;
  const now = Math.floor(Date.now() / 1000);
  // Never-verified rows sort by their last attempt (never tried first), verified
  // rows by when they were verified. Among equals the newest released, best-known
  // titles go first, since those are the ones shown; a title not out yet has no
  // score to read and waits at the back. An unconfirmed page waits a week before
  // it is tried again, so dead pages cannot hold the front of the queue.
  const candidates = db
    .prepare<[number, number, number], Candidate>(
      `SELECT id, title, year, media_type, rt_url FROM titles
       WHERE rt_url IS NOT NULL
         AND (rt_verified_at IS NOT NULL OR rt_checked_at IS NULL OR rt_checked_at < ?)
       ORDER BY rt_verified_at IS NOT NULL, COALESCE(rt_verified_at, rt_checked_at, 0),
                year IS NULL OR year > ?, year DESC, vote_count DESC, id
       LIMIT ?`,
    )
    .all(now - UNCONFIRMED_RETRY_SECONDS, new Date(now * 1000).getUTCFullYear(), opts.cap);

  const result: RtRefreshResult = { verified: 0, noScore: 0, unconfirmed: 0, failed: 0, blocked: false };
  let consecutiveFailures = 0;

  for (const [i, t] of candidates.entries()) {
    if (i > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));

    const page = await findRtPage(t, opts.fetchImpl);
    if (page === null) {
      result.failed++;
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        result.blocked = true;
        break;
      }
      continue;
    }
    consecutiveFailures = 0;

    if (page === 'unconfirmed') {
      setTitleRtUnconfirmed(db, t.id);
      result.unconfirmed++;
    } else {
      setTitleRtFromPage(db, t.id, page);
      result.verified++;
      if (page.score === null) result.noScore++;
    }
  }

  return result;
}
