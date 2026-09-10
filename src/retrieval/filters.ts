import type Database from 'better-sqlite3';

/**
 * Hard filters applied to EVERY candidate set before similarity ranking runs.
 *
 * Unknown metadata FAILS a filter rather than passing it: a title with no vote
 * count, no language or no release status is exactly the kind of row that used to
 * leak into picks (unreleased 2027 titles with 0 votes, 14-minute shorts, dubbed
 * TV from a language nobody in the house speaks). Metadata is filled by the TMDB
 * meta backfill (src/harvest/backfillMeta.ts), which runs at boot and nightly.
 */
export interface HardFilters {
  /** Earliest release year admitted (inclusive). */
  minYear: number;
  /** Minimum runtime for MOVIES in minutes. Series are exempt (episode runtimes vary). */
  minRuntimeMovie: number;
  /** Minimum TMDB vote_count for movies. */
  minVotesMovie: number;
  /** Minimum TMDB vote_count for series (TV accrues far fewer votes than film). */
  minVotesTv: number;
  /** Minimum TMDB vote_average (0–10). */
  minVoteAverage: number;
  /** ISO 639-1 original-language codes admitted. Empty = no language filter. */
  languages: string[];
  /** Admit only released films / aired series (drops announced, in-production, rumoured). */
  releasedOnly: boolean;
}

/**
 * Defaults derived from the liked history on 2026-09-10: 5th percentile of liked
 * release years was 1995, average liked IMDb rating 7.5 with a floor of 5.9, and
 * the harvest's own discover floor is 100 movie / 50 TV votes. 300 movie votes
 * keeps films that at least a small audience has seen; TV needs the lower bar.
 */
export const DEFAULT_HARD_FILTERS: HardFilters = {
  minYear: 1995,
  minRuntimeMovie: 60,
  minVotesMovie: 300,
  minVotesTv: 50,
  minVoteAverage: 6.0,
  languages: ['en'],
  releasedOnly: true,
};

/** Widening never goes past these, whatever the request. */
export const HARD_FLOOR = {
  minYear: 1980,
  minRuntimeMovie: 40,
  minVotesMovie: 20,
  minVotesTv: 10,
} as const;

/** Film statuses TMDB reports for something you can actually watch. */
const RELEASED_MOVIE_STATUSES = ['Released'];
/** Series statuses for something with aired episodes. */
const RELEASED_TV_STATUSES = ['Returning Series', 'Ended', 'Canceled'];

export interface WideningStep {
  label: string;
  apply(f: HardFilters): HardFilters;
}

/** Lower `key` to `target`, never raising a value that is already looser. */
function lowerTo(key: 'minYear' | 'minRuntimeMovie' | 'minVotesMovie' | 'minVotesTv', target: number) {
  return (f: HardFilters): HardFilters => (f[key] <= target ? f : { ...f, [key]: target });
}

/**
 * The order a thin pool is widened in: release year first (a good 1988 film is
 * a smaller compromise than an obscure one), then runtime, then vote count.
 * Rating, language and release status are never relaxed — those are the
 * filters that separate "a film" from "junk", not "our taste" from "wider taste".
 */
export const WIDENING_STEPS: WideningStep[] = [
  { label: 'year>=1990', apply: lowerTo('minYear', 1990) },
  { label: 'year>=1985', apply: lowerTo('minYear', 1985) },
  { label: `year>=${HARD_FLOOR.minYear}`, apply: lowerTo('minYear', HARD_FLOOR.minYear) },
  { label: `runtime>=${HARD_FLOOR.minRuntimeMovie}`, apply: lowerTo('minRuntimeMovie', HARD_FLOOR.minRuntimeMovie) },
  {
    label: 'votes>=100/25',
    apply: f => lowerTo('minVotesTv', 25)(lowerTo('minVotesMovie', 100)(f)),
  },
  {
    label: `votes>=${HARD_FLOOR.minVotesMovie}/${HARD_FLOOR.minVotesTv}`,
    apply: f => lowerTo('minVotesTv', HARD_FLOOR.minVotesTv)(lowerTo('minVotesMovie', HARD_FLOOR.minVotesMovie)(f)),
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

  parts.push(`${alias}.year >= ?`);
  params.push(f.minYear);

  parts.push(`(${alias}.media_type = 'tv' OR ${alias}.runtime_minutes >= ?)`);
  params.push(f.minRuntimeMovie);

  parts.push(`((${alias}.media_type = 'movie' AND ${alias}.vote_count >= ?) OR (${alias}.media_type = 'tv' AND ${alias}.vote_count >= ?))`);
  params.push(f.minVotesMovie, f.minVotesTv);

  parts.push(`${alias}.vote_average >= ?`);
  params.push(f.minVoteAverage);

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
    filters = step.apply(filters);
    stepsApplied.push(step.label);
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
 * The loosest filters the widening ladder can ever reach, given a strict set:
 * what a stored pick must still satisfy to be shown. Rating, language and
 * release state are never relaxed by the ladder, so they stay as given.
 */
export function floorFilters(f: HardFilters): HardFilters {
  return {
    ...f,
    minYear: Math.min(f.minYear, HARD_FLOOR.minYear),
    minRuntimeMovie: Math.min(f.minRuntimeMovie, HARD_FLOOR.minRuntimeMovie),
    minVotesMovie: Math.min(f.minVotesMovie, HARD_FLOOR.minVotesMovie),
    minVotesTv: Math.min(f.minVotesTv, HARD_FLOOR.minVotesTv),
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
  const rows = db.prepare(
    `SELECT t.id AS id FROM titles t WHERE t.id IN (${ids.map(() => '?').join(',')})${sql}`,
  ).all(...ids, ...params) as Array<{ id: number }>;
  return new Set(rows.map(r => r.id));
}
