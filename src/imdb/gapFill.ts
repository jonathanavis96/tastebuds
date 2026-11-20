/**
 * IMDb gap fill: adds the films and series that IMDb rates well enough to be
 * picked but the TMDB harvest never reached. The harvest walks TMDB's popular
 * and most-voted lists, which leave out well-rated titles with modest TMDB
 * traffic: on 2026-11-20 the catalogue lacked 1,075 English titles from 2021 on
 * with an IMDb rating of 7.0 or more (Air, Belfast, Tár, Blue Lights).
 *
 * One pass over IMDb's basics file (shared with the genre sync) names every
 * film and series released from OLDER_YEARS_BACK years before the current one
 * on, whose rating and vote
 * count, in the ratings file on disk, clear the hard filters' IMDb floors and
 * that the catalogue does not hold. Each is looked up on TMDB by its IMDb id;
 * one in a language the household watches is fetched, embedded and stored like
 * a harvested title, with its IMDb rating and genres. Every lookup is recorded
 * in imdb_gap_checks so the next run skips it for GAP_RECHECK_DAYS.
 */
import type Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import type { Config } from '../config.js';
import { applyImdbGenres, applyImdbRatings, getTitleByTmdbId, markTitleImdbIdChecked } from '../db/repos/titles.js';
import { ingestTitle, type Candidate } from '../harvest/onDemand.js';
import { embedText } from '../ollama/embed.js';
import { defaultHardFilters } from '../retrieval/filters.js';
import { OLDER_YEARS_BACK } from '../retrieval/requestRules.js';
import { hardFiltersFor } from '../api/feed.js';
import { findByImdbId, getTitleDetails } from '../tmdb/client.js';
import type { TmdbFindResult } from '../tmdb/types.js';
import { imdbRatingsPath, readRatedTitles, syncImdbGenres, type ImdbBasicsRow, type ImdbRating } from './dataset.js';

/** A looked-up id is not asked about again for this many days. */
export const GAP_RECHECK_DAYS = 60;
/** Lookups per run. The first run on a catalogue makes about 14,000; a weekly run after it a few hundred. */
export const GAP_FILL_CAP_DEFAULT = 20_000;
const CONCURRENCY = 4;
/** Pause before each lookup per worker, to stay well under TMDB's rate limit. */
const REQUEST_PAUSE_MS = 60;
const LOG_EVERY = 1000;
/** This many failed lookups in a row (TMDB or the embedder down) end the run; the rest wait for the next one. */
const MAX_ERRORS_IN_A_ROW = 20;

/** A run still going (the startup run can outlast a Sunday night); a second one waits for the next week. */
let running = false;

const MEDIA_OF: Record<string, 'movie' | 'tv'> = { movie: 'movie', tvSeries: 'tv', tvMiniSeries: 'tv' };

export interface GapFillDeps {
  fetchImpl: typeof fetch;
  findByImdbId: typeof findByImdbId;
  getTitleDetails: typeof getTitleDetails;
  embedText: typeof embedText;
}

const realDeps: GapFillDeps = { fetchImpl: fetch, findByImdbId, getTitleDetails, embedText };

export interface GapFillResult {
  /** Catalogue titles whose IMDb genres changed (the genre sync this pass also does). */
  genresUpdated: number;
  /** Uncatalogued titles inside the window and the IMDb floors. */
  candidates: number;
  /** How the lookups ended: added, in-catalogue, not-on-tmdb, language:<code>, error. */
  outcomes: Record<string, number>;
  /** Why the run stopped early, if it did. */
  stopped: string | null;
}

interface GapTitle {
  imdbId: string;
  mediaType: 'movie' | 'tv';
  rating: ImdbRating;
  genres: string[];
}

/**
 * Run the gap fill: refresh IMDb genres for the catalogue, then look up and add
 * the uncatalogued titles, most-voted first, at most `cap` of them.
 */
export async function fillImdbGaps(
  db: InstanceType<typeof Database>,
  config: Config,
  opts: { cap?: number; now?: Date; deps?: GapFillDeps } = {},
): Promise<GapFillResult> {
  if (running) return { genresUpdated: 0, candidates: 0, outcomes: {}, stopped: 'another run is in progress' };
  running = true;
  try {
    return await runGapFill(db, config, opts.deps ?? realDeps, opts.now ?? new Date(), opts.cap ?? GAP_FILL_CAP_DEFAULT);
  } finally {
    running = false;
  }
}

async function runGapFill(
  db: InstanceType<typeof Database>,
  config: Config,
  deps: GapFillDeps,
  now: Date,
  cap: number,
): Promise<GapFillResult> {
  const floors = defaultHardFilters(now);
  const minVotes = { movie: floors.minImdbVotesMovie, tv: floors.minImdbVotesTv };

  const rated = await readRatedTitles(config, floors.minImdbRating, Math.min(minVotes.movie, minVotes.tv), knownIds(db, now));
  const basics = await syncImdbGenres(db, deps.fetchImpl, new Set(rated.keys()));
  if (rated.size === 0) return { genresUpdated: basics.updated, candidates: 0, outcomes: {}, stopped: null };
  // Ratings written from the file carry the file's time, as the nightly sync's do.
  const ratedAt = Math.floor((await stat(imdbRatingsPath(config))).mtimeMs / 1000);

  const yearFrom = now.getFullYear() - OLDER_YEARS_BACK;
  const gaps: GapTitle[] = [];
  for (const [imdbId, row] of basics.read) {
    const mediaType = inWindow(row, yearFrom, now.getFullYear());
    const rating = rated.get(imdbId)!;
    if (mediaType && rating.votes >= minVotes[mediaType]) gaps.push({ imdbId, mediaType, rating, genres: row.genres });
  }
  gaps.sort((a, b) => b.rating.votes - a.rating.votes);

  const run: Run = { db, config, deps, languages: householdLanguages(db, config), ratedAt };
  const { outcomes, stopped } = await lookUpAll(run, gaps.slice(0, cap));
  return { genresUpdated: basics.updated, candidates: gaps.length, outcomes, stopped };
}

/** IMDb ids the catalogue holds, or that were looked up within GAP_RECHECK_DAYS. */
function knownIds(db: InstanceType<typeof Database>, now: Date): Set<string> {
  const since = Math.floor(now.getTime() / 1000) - GAP_RECHECK_DAYS * 86_400;
  const rows = db.prepare(`
    SELECT imdb_id FROM titles WHERE imdb_id IS NOT NULL
    UNION SELECT imdb_id FROM imdb_gap_checks WHERE checked_at >= ?
  `).all(since) as Array<{ imdb_id: string }>;
  return new Set(rows.map((r) => r.imdb_id));
}

/** The media type of a film or series released inside [from, to]; null for anything else. */
function inWindow(row: ImdbBasicsRow, from: number, to: number): 'movie' | 'tv' | null {
  const mediaType = MEDIA_OF[row.titleType] ?? null;
  if (!mediaType || row.startYear === null || row.startYear < from || row.startYear > to) return null;
  return mediaType;
}

/** The languages any profile's hard filters admit (English always). */
function householdLanguages(db: InstanceType<typeof Database>, config: Config): Set<string> {
  const ids = (db.prepare('SELECT id FROM profiles').all() as Array<{ id: number }>).map((p) => p.id);
  return new Set(hardFiltersFor(db, config, ids).languages);
}

interface Run {
  db: InstanceType<typeof Database>;
  config: Config;
  deps: GapFillDeps;
  languages: Set<string>;
  /** imdb_synced_at for the ratings this run writes. */
  ratedAt: number;
}

async function lookUpAll(run: Run, gaps: GapTitle[]): Promise<{ outcomes: Record<string, number>; stopped: string | null }> {
  const outcomes: Record<string, number> = {};
  const record = run.db.prepare('INSERT OR REPLACE INTO imdb_gap_checks (imdb_id, outcome, checked_at) VALUES (?, ?, ?)');
  let next = 0;
  let completed = 0;
  let errorsInARow = 0;
  let stopped: string | null = null;
  const worker = async () => {
    while (next < gaps.length && stopped === null) {
      const gap = gaps[next++];
      await new Promise((resolve) => setTimeout(resolve, REQUEST_PAUSE_MS));
      const outcome = await lookUp(run, gap).catch((err: unknown) => {
        console.warn(`[tastebuds] IMDb gap fill: ${gap.imdbId} failed: ${String(err)}`);
        return 'error';
      });
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      // A failed lookup is not recorded, so the next run tries it again.
      if (outcome === 'error') {
        if (++errorsInARow >= MAX_ERRORS_IN_A_ROW) stopped = `${MAX_ERRORS_IN_A_ROW} lookups in a row failed`;
      } else {
        errorsInARow = 0;
        record.run(gap.imdbId, outcome, Math.floor(Date.now() / 1000));
      }
      if (++completed % LOG_EVERY === 0) console.log(`[tastebuds] IMDb gap fill progress: ${completed}/${gaps.length}`, outcomes);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { outcomes, stopped };
}

/** Look one title up on TMDB and add it when it belongs; returns the outcome to record. */
async function lookUp(run: Run, gap: GapTitle): Promise<string> {
  const { db, config, deps } = run;
  let found: TmdbFindResult;
  try {
    found = await deps.findByImdbId(gap.imdbId, config);
  } catch {
    return 'error';
  }
  const match = pickMatch(found, gap.mediaType);
  if (!match) return 'not-on-tmdb';

  const stored = getTitleByTmdbId(db, match.tmdbId, match.mediaType);
  if (stored) {
    // The catalogue has it under no IMDb id: link the one /find matched on.
    if (!stored.imdb_id) linkImdb(run, stored.id, gap);
    return 'in-catalogue';
  }
  if (!run.languages.has(match.language)) return `language:${match.language || '?'}`;

  const errors: string[] = [];
  const id = await ingestTitle(db, match, config, deps, errors);
  if (id === null) return 'error';
  // A title without an embedding can never be retrieved, and nothing embeds it
  // later: take it out again so the next run adds it whole.
  if (errors.length > 0) {
    db.prepare('DELETE FROM titles WHERE id = ? AND embedding IS NULL').run(id);
    return 'error';
  }
  linkImdb(run, id, gap);
  if (gap.genres.length > 0) applyImdbGenres(db, [{ id, genres: JSON.stringify(gap.genres) }]);
  return 'added';
}

/** Give a stored title the IMDb id /find matched on (TMDB's details can omit it), with its rating from the file. */
function linkImdb(run: Run, titleId: number, gap: GapTitle): void {
  markTitleImdbIdChecked(run.db, titleId, gap.imdbId);
  applyImdbRatings(run.db, [{ id: titleId, rating: gap.rating.rating, votes: gap.rating.votes }], run.ratedAt);
}

/** TMDB's entry for the id, of IMDb's media type when TMDB has one, else of the other. */
function pickMatch(found: TmdbFindResult, mediaType: 'movie' | 'tv'): (Candidate & { language: string }) | null {
  const lists = { movie: found.movie_results ?? [], tv: found.tv_results ?? [] };
  const other = mediaType === 'movie' ? 'tv' : 'movie';
  const type = lists[mediaType].length > 0 ? mediaType : lists[other].length > 0 ? other : null;
  if (!type) return null;
  const hit = lists[type][0];
  return { tmdbId: hit.id, mediaType: type, language: hit.original_language ?? '' };
}
