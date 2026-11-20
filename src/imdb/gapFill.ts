/**
 * IMDb gap fill: adds the films and series that IMDb rates well enough to be
 * picked but the TMDB harvest never reached. The harvest walks TMDB's popular
 * and most-voted lists, which leave out well-rated titles with modest TMDB
 * traffic: on 2026-11-20 the catalogue lacked 1,075 English titles from 2021 on
 * with an IMDb rating of 7.0 or more (Air, Belfast, Tár, Blue Lights).
 *
 * One pass over IMDb's basics file (shared with the genre sync) names every
 * film and series from the last OLDER_YEARS_BACK years whose rating and vote
 * count, in the ratings file on disk, clear the hard filters' IMDb floors and
 * that the catalogue does not hold. Each is looked up on TMDB by its IMDb id;
 * one in a language the household watches is fetched, embedded and stored like
 * a harvested title, with its IMDb rating and genres. Every lookup is recorded
 * in imdb_gap_checks so the next run skips it for GAP_RECHECK_DAYS.
 */
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { applyImdbGenres, getTitleByTmdbId, markTitleImdbIdChecked } from '../db/repos/titles.js';
import { ingestTitle, type Candidate } from '../harvest/onDemand.js';
import { embedText } from '../ollama/embed.js';
import { defaultHardFilters } from '../retrieval/filters.js';
import { OLDER_YEARS_BACK } from '../retrieval/requestRules.js';
import { hardFiltersFor } from '../api/feed.js';
import { findByImdbId, getTitleDetails } from '../tmdb/client.js';
import type { TmdbFindResult } from '../tmdb/types.js';
import { applyCachedImdbRatings, readRatedTitles, syncImdbGenres, type ImdbBasicsRow, type ImdbRating } from './dataset.js';

/** A looked-up id is not asked about again for this many days. */
export const GAP_RECHECK_DAYS = 60;
/** Lookups per run. The first run on a catalogue makes about 14,000; a weekly run after it a few hundred. */
export const GAP_FILL_CAP_DEFAULT = 20_000;
const CONCURRENCY = 4;
/** Pause before each lookup per worker, to stay well under TMDB's rate limit. */
const REQUEST_PAUSE_MS = 60;
const LOG_EVERY = 1000;

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
  const deps = opts.deps ?? realDeps;
  const now = opts.now ?? new Date();
  const floors = defaultHardFilters(now);
  const minVotes = { movie: floors.minImdbVotesMovie, tv: floors.minImdbVotesTv };

  const rated = await readRatedTitles(config, floors.minImdbRating, Math.min(minVotes.movie, minVotes.tv), knownIds(db, now));
  const basics = await syncImdbGenres(db, deps.fetchImpl, new Set(rated.keys()));

  const yearFrom = now.getFullYear() - OLDER_YEARS_BACK;
  const gaps: GapTitle[] = [];
  for (const [imdbId, row] of basics.read) {
    const mediaType = inWindow(row, yearFrom, now.getFullYear());
    const rating = rated.get(imdbId)!;
    if (mediaType && rating.votes >= minVotes[mediaType]) gaps.push({ imdbId, mediaType, rating, genres: row.genres });
  }
  gaps.sort((a, b) => b.rating.votes - a.rating.votes);

  const outcomes = await lookUpAll(db, config, deps, gaps.slice(0, opts.cap ?? GAP_FILL_CAP_DEFAULT), householdLanguages(db, config));
  return { genresUpdated: basics.updated, candidates: gaps.length, outcomes };
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

/** The languages any profile's hard filters admit; empty means every language. */
function householdLanguages(db: InstanceType<typeof Database>, config: Config): Set<string> {
  const ids = (db.prepare('SELECT id FROM profiles').all() as Array<{ id: number }>).map((p) => p.id);
  return new Set(hardFiltersFor(db, config, ids).languages);
}

async function lookUpAll(
  db: InstanceType<typeof Database>,
  config: Config,
  deps: GapFillDeps,
  gaps: GapTitle[],
  languages: Set<string>,
): Promise<Record<string, number>> {
  const outcomes: Record<string, number> = {};
  const record = db.prepare('INSERT OR REPLACE INTO imdb_gap_checks (imdb_id, outcome, checked_at) VALUES (?, ?, ?)');
  let next = 0;
  const worker = async () => {
    while (next < gaps.length) {
      const gap = gaps[next++];
      await new Promise((resolve) => setTimeout(resolve, REQUEST_PAUSE_MS));
      const outcome = await lookUp(db, config, deps, gap, languages);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      if (outcome !== 'error') record.run(gap.imdbId, outcome, Math.floor(Date.now() / 1000));
      if (next % LOG_EVERY === 0) console.log(`[tastebuds] IMDb gap fill progress: ${next}/${gaps.length}`, outcomes);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return outcomes;
}

/** Look one title up on TMDB and add it when it belongs; returns the outcome to record. */
async function lookUp(
  db: InstanceType<typeof Database>,
  config: Config,
  deps: GapFillDeps,
  gap: GapTitle,
  languages: Set<string>,
): Promise<string> {
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
    // The catalogue has it under no IMDb id (or another one): link the missing one.
    if (!stored.imdb_id) {
      markTitleImdbIdChecked(db, stored.id, gap.imdbId);
      await applyCachedImdbRatings(db, config, [stored.id]);
    }
    return 'in-catalogue';
  }
  if (languages.size > 0 && !languages.has(match.language)) return `language:${match.language || '?'}`;

  const errors: string[] = [];
  const id = await ingestTitle(db, match, config, deps, errors);
  if (id === null) return 'error';
  // TMDB's details can omit the IMDb id that /find matched on.
  markTitleImdbIdChecked(db, id, gap.imdbId);
  if (gap.genres.length > 0) applyImdbGenres(db, [{ id, genres: JSON.stringify(gap.genres) }]);
  await applyCachedImdbRatings(db, config, [id]);
  return 'added';
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
