import type Database from 'better-sqlite3';
import { DEFAULT_RECENT_YEARS } from '../request/rules.js';

/**
 * Hard filters applied to EVERY candidate set before similarity ranking runs.
 *
 * Unknown metadata FAILS a filter rather than passing it: a title with no vote
 * count, no IMDb rating, no language or no release status is exactly the kind of
 * row that used to leak into picks (unreleased 2027 titles with 0 votes, 14-minute
 * shorts, dubbed TV from a language nobody in the house speaks, titles shown with
 * no rating at all). Metadata is filled by the TMDB meta backfill
 * (src/harvest/backfillMeta.ts) and IMDb's ratings file (src/imdb/dataset.ts).
 */
export interface HardFilters {
  /** Earliest release year admitted (inclusive); null = no year limit. */
  minYear: number | null;
  /** Minimum runtime for MOVIES in minutes. Series are exempt (episode runtimes vary). */
  minRuntimeMovie: number;
  /** Minimum TMDB vote_count for movies. */
  minVotesMovie: number;
  /** Minimum TMDB vote_count for series (TV accrues far fewer votes than film). */
  minVotesTv: number;
  /** Minimum TMDB vote_average (0–10). */
  minVoteAverage: number;
  /** Minimum IMDb rating (0–10). A title with no IMDb rating fails. */
  minImdbRating: number;
  /** Minimum IMDb votes behind that rating, for movies. */
  minImdbVotesMovie: number;
  /** Minimum IMDb votes behind that rating, for series. */
  minImdbVotesTv: number;
  /** ISO 639-1 original-language codes admitted. Empty = no language filter. */
  languages: string[];
  /** Admit only released films / aired series (drops announced, in-production, rumoured). */
  releasedOnly: boolean;
}

/**
 * The defaults. A pick must have a real rating: an IMDb score of 6.0 or more
 * with 1,000 votes behind it for a film, 500 for a series. With IMDb votes as
 * the real gate, the TMDB vote and score floors only screen out obvious junk.
 * Releases are recent by default: the last DEFAULT_RECENT_YEARS calendar years,
 * counting the current one, so the floor moves on with the calendar.
 */
export function defaultHardFilters(now: Date = new Date()): HardFilters {
  return {
    minYear: now.getFullYear() - (DEFAULT_RECENT_YEARS - 1),
    minRuntimeMovie: 60,
    minVotesMovie: 50,
    minVotesTv: 20,
    minVoteAverage: 5.5,
    minImdbRating: 6.0,
    minImdbVotesMovie: 1000,
    minImdbVotesTv: 500,
    languages: ['en'],
    releasedOnly: true,
  };
}

/** Widening never goes past these, whatever the request. */
export const HARD_FLOOR = {
  minYear: 1980,
  minRuntimeMovie: 40,
  minVotesMovie: 20,
  minVotesTv: 10,
  minImdbVotesMovie: 300,
  minImdbVotesTv: 150,
} as const;

/** Film statuses TMDB reports for something you can actually watch. */
const RELEASED_MOVIE_STATUSES = ['Released'];
/** Series statuses for something with aired episodes. */
const RELEASED_TV_STATUSES = ['Returning Series', 'Ended', 'Canceled'];

export interface WideningStep {
  apply(f: HardFilters): HardFilters;
  /** Log label naming the filter values this step produced, e.g. "year>=2011". */
  label(f: HardFilters): string;
}

type LoweredKey = 'minRuntimeMovie' | 'minVotesMovie' | 'minVotesTv' | 'minImdbVotesMovie' | 'minImdbVotesTv';

/** Lower `key` to `target`, never raising a value that is already looser. */
function lowerTo(key: LoweredKey, target: number) {
  return (f: HardFilters): HardFilters => (f[key] <= target ? f : { ...f, [key]: target });
}

/** Move the year floor `years` further back, never past HARD_FLOOR.minYear. */
function yearBack(years: number) {
  return (f: HardFilters): HardFilters =>
    f.minYear == null || f.minYear <= HARD_FLOOR.minYear
      ? f
      : { ...f, minYear: Math.max(f.minYear - years, HARD_FLOOR.minYear) };
}

const yearLabel = (f: HardFilters) => `year>=${f.minYear}`;

/**
 * The order a thin pool is widened in: release year first, ten years at a time
 * and then to the hard floor (a good older film is a smaller compromise than an
 * obscure one), then runtime, then the IMDb vote count, then the TMDB vote count.
 * Rating, language and release status are never relaxed — those are the filters
 * that separate "a film" from "junk", not "our taste" from "wider taste".
 */
export const WIDENING_STEPS: WideningStep[] = [
  { apply: yearBack(10), label: yearLabel },
  { apply: yearBack(10), label: yearLabel },
  { apply: yearBack(Infinity), label: yearLabel }, // straight to the hard floor
  { apply: lowerTo('minRuntimeMovie', HARD_FLOOR.minRuntimeMovie), label: f => `runtime>=${f.minRuntimeMovie}` },
  {
    apply: f => lowerTo('minImdbVotesTv', HARD_FLOOR.minImdbVotesTv)(lowerTo('minImdbVotesMovie', HARD_FLOOR.minImdbVotesMovie)(f)),
    label: f => `imdbVotes>=${f.minImdbVotesMovie}/${f.minImdbVotesTv}`,
  },
  {
    apply: f => lowerTo('minVotesTv', HARD_FLOOR.minVotesTv)(lowerTo('minVotesMovie', HARD_FLOOR.minVotesMovie)(f)),
    label: f => `votes>=${f.minVotesMovie}/${f.minVotesTv}`,
  },
];

/**
 * SQL fragment (leading ` AND …`) plus bound params enforcing `f` on a titles row
 * aliased `alias`. Every comparison is against a possibly-NULL column, and SQL's
 * NULL comparison is falsy, so unknown metadata is excluded by construction.
 */
export function hardFilterSql(f: HardFilters, alias = 't'): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];

  if (f.minYear != null) {
    parts.push(`${alias}.year >= ?`);
    params.push(f.minYear);
  }

  parts.push(`(${alias}.media_type = 'tv' OR ${alias}.runtime_minutes >= ?)`);
  params.push(f.minRuntimeMovie);

  parts.push(`((${alias}.media_type = 'movie' AND ${alias}.vote_count >= ?) OR (${alias}.media_type = 'tv' AND ${alias}.vote_count >= ?))`);
  params.push(f.minVotesMovie, f.minVotesTv);

  parts.push(`${alias}.vote_average >= ?`);
  params.push(f.minVoteAverage);

  // imdb_rating is stored as TEXT ("7.4"); NULL casts to NULL and fails.
  parts.push(`CAST(${alias}.imdb_rating AS REAL) >= ?`);
  params.push(f.minImdbRating);

  parts.push(`((${alias}.media_type = 'movie' AND ${alias}.imdb_votes >= ?) OR (${alias}.media_type = 'tv' AND ${alias}.imdb_votes >= ?))`);
  params.push(f.minImdbVotesMovie, f.minImdbVotesTv);

  if (f.languages.length > 0) {
    parts.push(`${alias}.original_language IN (${f.languages.map(() => '?').join(',')})`);
    params.push(...f.languages);
  }

  if (f.releasedOnly) {
    const mv = RELEASED_MOVIE_STATUSES.map(() => '?').join(',');
    const tv = RELEASED_TV_STATUSES.map(() => '?').join(',');
    parts.push(`((${alias}.media_type = 'movie' AND ${alias}.status IN (${mv})) OR (${alias}.media_type = 'tv' AND ${alias}.status IN (${tv})))`);
    params.push(...RELEASED_MOVIE_STATUSES, ...RELEASED_TV_STATUSES);
  }

  return { sql: parts.map(p => ` AND ${p}`).join(''), params };
}

export interface WideningResult<T> {
  rows: T[];
  /** The filters that produced `rows`. */
  filters: HardFilters;
  /** Labels of the steps that had to be applied, in order. Empty = strict result was enough. */
  stepsApplied: string[];
}

const WIDENED_KEYS = ['minYear', 'minRuntimeMovie', 'minVotesMovie', 'minVotesTv', 'minImdbVotesMovie', 'minImdbVotesTv'] as const;

/** True when `after` is looser than `before` on at least one widened filter (the steps never set a limit to null). */
function lowersAnything(before: HardFilters, after: HardFilters): boolean {
  return WIDENED_KEYS.some(k => after[k] != null && before[k] != null && after[k] < before[k]);
}

/**
 * Run `query` under `base`; if it yields fewer than `minCount` rows, apply the
 * widening steps one at a time (re-running the query after each) until the
 * minimum is met or the ladder is exhausted. Returns the largest result seen.
 */
export function withWidening<T>(
  base: HardFilters,
  minCount: number,
  query: (f: HardFilters) => T[],
): WideningResult<T> {
  let filters = base;
  let rows = query(filters);
  const stepsApplied: string[] = [];
  let best: WideningResult<T> = { rows, filters, stepsApplied: [] };
  for (const step of WIDENING_STEPS) {
    if (rows.length >= minCount) break;
    const next = step.apply(filters);
    // A filter already at or below this step's target is left as it is; the
    // step changed nothing, so it is neither logged nor re-queried.
    if (!lowersAnything(filters, next)) continue;
    filters = next;
    stepsApplied.push(step.label(filters));
    rows = query(filters);
    if (rows.length >= best.rows.length) best = { rows, filters, stepsApplied: [...stepsApplied] };
  }
  return best;
}

/** A language needs this share of liked titles, and at least this many, to be admitted. */
const HISTORY_LANGUAGE_MIN_SHARE = 0.03;
const HISTORY_LANGUAGE_MIN_COUNT = 3;
const LIKED_MIN_RATING = 4;

/**
 * Languages the household actually enjoys: English always, plus any original
 * language that accounts for a meaningful slice of the liked (4★+) history across
 * `profileIds`. Disliked titles don't count — a 1★ dubbed series shouldn't open
 * the door to more of them.
 */
export function languagesFromHistory(
  db: InstanceType<typeof Database>,
  profileIds: number[],
): string[] {
  if (profileIds.length === 0) return ['en'];
  const ph = profileIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT t.original_language AS lang, COUNT(DISTINCT t.id) AS n
    FROM watch_events we JOIN titles t ON t.id = we.title_id
    WHERE we.profile_id IN (${ph}) AND we.rating >= ? AND t.original_language IS NOT NULL
    GROUP BY t.original_language
  `).all(...profileIds, LIKED_MIN_RATING) as Array<{ lang: string; n: number }>;
  const total = rows.reduce((s, r) => s + r.n, 0);
  const admitted = new Set<string>(['en']);
  for (const r of rows) {
    if (r.n >= HISTORY_LANGUAGE_MIN_COUNT && r.n / total >= HISTORY_LANGUAGE_MIN_SHARE) admitted.add(r.lang);
  }
  return [...admitted].sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)));
}

/**
 * What a stored pick must still satisfy to be shown: the loosest values the
 * widening ladder can reach, and no year limit at all, since a request may
 * legitimately ask for a 1970s film and every pick was checked against its own
 * request before it was stored. Rating, language and release state are never
 * relaxed by the ladder, so they stay as given.
 */
export function floorFilters(f: HardFilters): HardFilters {
  return {
    ...f,
    minYear: null,
    minRuntimeMovie: Math.min(f.minRuntimeMovie, HARD_FLOOR.minRuntimeMovie),
    minVotesMovie: Math.min(f.minVotesMovie, HARD_FLOOR.minVotesMovie),
    minVotesTv: Math.min(f.minVotesTv, HARD_FLOOR.minVotesTv),
    minImdbVotesMovie: Math.min(f.minImdbVotesMovie, HARD_FLOOR.minImdbVotesMovie),
    minImdbVotesTv: Math.min(f.minImdbVotesTv, HARD_FLOOR.minImdbVotesTv),
  };
}

/** Of `titleIds`, the ones whose stored metadata passes `f` (unknown metadata fails). */
export function titleIdsPassing(
  db: InstanceType<typeof Database>,
  f: HardFilters,
  titleIds: number[],
): Set<number> {
  const ids = [...new Set(titleIds)];
  if (ids.length === 0) return new Set();
  const { sql, params } = hardFilterSql(f, 't');
  // Chunk the IN list: a profile can hold tens of thousands of pending recs, and
  // one statement binding them all exceeds SQLite's bound-variable limit.
  const passing = new Set<number>();
  for (let i = 0; i < ids.length; i += TITLE_ID_CHUNK) {
    const chunk = ids.slice(i, i + TITLE_ID_CHUNK);
    const rows = db.prepare(
      `SELECT t.id AS id FROM titles t WHERE t.id IN (${chunk.map(() => '?').join(',')})${sql}`,
    ).all(...chunk, ...params) as Array<{ id: number }>;
    for (const r of rows) passing.add(r.id);
  }
  return passing;
}

/** IDs bound per statement in `titleIdsPassing`; well under SQLite's oldest 999-variable default, leaving room for filter params. */
const TITLE_ID_CHUNK = 500;
