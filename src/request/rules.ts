/**
 * A free-text request ("thriller new 2025", "scary movie, no nuns") is turned
 * into RequestRules, and every pick returned for it must satisfy all of them.
 * Similarity and taste only ORDER the titles that already pass.
 *
 * The rules are enforced in code (src/request/enforce.ts), never by asking the
 * model to respect them. The model may help read the request (modelParse.ts),
 * but what it returns is validated here and then checked title by title.
 */

/** One name per genre, whatever TMDB (film or TV) or IMDb calls it. */
export const CANON_GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'History',
  'Horror',
  'Music',
  'Mystery',
  'Reality',
  'Romance',
  'Science Fiction',
  'Thriller',
  'War',
  'Western',
] as const;

export type CanonGenre = (typeof CANON_GENRES)[number];

/**
 * One thing a title must (or must not) be. Satisfied when the title carries
 * ANY of `genres` (see titleTags), or when ANY of `terms` appears in its
 * keywords or synopsis, or is the full name of a cast member. The title's own
 * name counts only for an exclusion or a named subject (see enforce.ts). A clause
 * with neither can never be satisfied, so the parsers never emit one.
 */
export interface RuleClause {
  /** What the viewer asked for, in their words: "thriller", "scary", "medical", "nuns". */
  label: string;
  genres: CanonGenre[];
  /** Lowercase words or short phrases, matched on word boundaries (a trailing "s" is tolerated). */
  terms: string[];
}

/**
 * Where the year window came from, which decides whether it may ever be relaxed:
 *  - 'stated':  a year, a range or a decade was written ("2025", "post 2020", "90s"). Never relaxed.
 *  - 'recent':  "new", "recent", "latest". Never relaxed.
 *  - 'default': nothing was said, so the window is the recent default. It may be
 *               widened when too few titles pass, and each older pick says why.
 *  - 'any':     the request asked for older titles ("classic", "of all time",
 *               an older film named as the reference). No year limit.
 */
export type YearSource = 'stated' | 'recent' | 'default' | 'any';

export interface RequestRules {
  /** 'movie' / 'tv' when the request says film or series; null when it does not. */
  mediaType: 'movie' | 'tv' | null;
  /** Inclusive release-year window; null = open on that side. */
  yearMin: number | null;
  yearMax: number | null;
  yearSource: YearSource;
  /** Every clause must be satisfied. */
  must: RuleClause[];
  /** No clause may be satisfied. */
  mustNot: RuleClause[];
  /** Minimum IMDb rating asked for ("top rated", "good reviews"), 0–10. */
  minImdb: number | null;
  /** Film runtime bounds in minutes ("under 90 minutes"). Series are exempt. */
  minRuntime: number | null;
  maxRuntime: number | null;
  /** ISO 639-1 original language ("in English" → 'en'). */
  language: string | null;
  /** "Hidden gem" / "underrated": keep to titles few people have voted on. */
  hiddenGem: boolean;
  /** Titles named as a reference ("like Inception"). Used for ordering, never as a filter. */
  similarTo: string[];
  /**
   * The tone asked for ("Feel-good", "Light", "Cosy"), shown as a chip. It is
   * enforced through `must`/`mustNot` (never Horror), not by this label.
   */
  tone: string | null;
}

/** With no year in the request, picks come from this many years back, counting the current one. */
export const DEFAULT_RECENT_YEARS = 6;
/** "new" / "latest" means the current year and the one before. */
export const NEW_YEARS = 2;
/** "recent" means the current year and the two before. */
export const RECENT_YEARS = 3;

/** IMDb floors for rating words: "good reviews" / "high rated" vs "top rated" / "best". */
export const GOOD_RATING_FLOOR = 7.0;
export const TOP_RATING_FLOOR = 7.5;

/** A "hidden gem" has at most this many IMDb votes. */
export const HIDDEN_GEM_MAX_IMDB_VOTES = 50_000;

/** Rules for an empty request: recent by default, nothing else. */
export function defaultRules(now: Date = new Date()): RequestRules {
  return {
    mediaType: null,
    yearMin: now.getFullYear() - (DEFAULT_RECENT_YEARS - 1),
    yearMax: null,
    yearSource: 'default',
    must: [],
    mustNot: [],
    minImdb: null,
    minRuntime: null,
    maxRuntime: null,
    language: null,
    hiddenGem: false,
    similarTo: [],
    tone: null,
  };
}

/**
 * What the viewer is told was understood, and what came of it. Stored with each
 * pick of the batch (recommendations.request_summary) and returned by the API.
 */
export interface RequestSummary {
  /** The request as typed. */
  text: string;
  /** One short chip per rule, in reading order: ["Thriller", "Films", "2025 or newer", "IMDb 7.0+"]. */
  understood: string[];
  /** How many titles in the library satisfy every rule (before taking the top picks). */
  matched: number;
  /** A plain sentence when fewer than a full set matched or the year window was widened; null otherwise. */
  note: string | null;
}
