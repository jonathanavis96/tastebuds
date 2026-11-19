/**
 * Nightly Rotten Tomatoes refresh: re-reads the critics score from the stored
 * page of titles that have an rt_url. Scores move as reviews come in, and every
 * score scraped before migration 015 was dropped because it came from another
 * title, so titles never verified go first, then the ones verified longest ago.
 */
import type Database from 'better-sqlite3';
import { markTitleRtChecked, setTitleRtFromPage } from '../db/repos/titles.js';
import { readRtScore } from './resolve.js';

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
  rt_url: string;
}

export interface RtRefreshResult {
  /** Pages confirmed as the title; their score (or its absence) was saved. */
  verified: number;
  /** Of those, pages that show no critics score (the stored score is cleared). */
  noScore: number;
  /** Pages that answered but are not the title (gone, or another title): left as they were. */
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
  // rows by when they were verified. An unconfirmed page waits a week before it
  // is tried again, so dead pages cannot hold the front of the queue.
  const candidates = db
    .prepare<[number, number], Candidate>(
      `SELECT id, title, year, rt_url FROM titles
       WHERE rt_url IS NOT NULL
         AND (rt_verified_at IS NOT NULL OR rt_checked_at IS NULL OR rt_checked_at < ?)
       ORDER BY rt_verified_at IS NOT NULL, COALESCE(rt_verified_at, rt_checked_at, 0), id
       LIMIT ?`,
    )
    .all(now - UNCONFIRMED_RETRY_SECONDS, opts.cap);

  const result: RtRefreshResult = { verified: 0, noScore: 0, unconfirmed: 0, failed: 0, blocked: false };
  let consecutiveFailures = 0;

  for (const [i, t] of candidates.entries()) {
    if (i > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));

    const page = await readRtScore(t.rt_url, t.title, t.year, opts.fetchImpl);
    if (page === null) {
      result.failed++;
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        result.blocked = true;
        break;
      }
      continue;
    }
    consecutiveFailures = 0;

    if (page.verified) {
      setTitleRtFromPage(db, t.id, page);
      result.verified++;
      if (page.score === null) result.noScore++;
    } else {
      markTitleRtChecked(db, t.id);
      result.unconfirmed++;
    }
  }

  return result;
}
