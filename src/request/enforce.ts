import type { TitleRow } from '../db/types.js';
import type { RequestRules } from './rules.js';

export type CheckableTitle = Pick<
  TitleRow,
  | 'media_type' | 'title' | 'year' | 'genres' | 'keywords' | 'synopsis' | 'imdb_genres'
  | 'imdb_rating' | 'imdb_votes' | 'runtime_minutes' | 'original_language'
>;

export interface RuleCheck {
  ok: boolean;
  /** One short reason per broken rule ("released 2008, asked for 2025 or newer"); empty when ok. */
  failed: string[];
}

/**
 * Whether `title` satisfies every rule. This is the one definition of "obeys the
 * request": retrieval filters with it, and /generate checks each pick with it
 * again before storing. Unknown metadata fails a rule that needs it (no year
 * fails a year window, no IMDb rating fails a rating floor).
 */
export function titleObeys(rules: RequestRules, title: CheckableTitle): RuleCheck {
  void rules; void title;
  throw new Error('not implemented');
}

/**
 * SQL fragment (leading " AND …") plus params for the rules a column comparison
 * can decide: media type, year window, IMDb floor, film runtime, language and
 * the hidden-gem vote cap. A cheap prefilter only: every row it admits must
 * still pass titleObeys, which also checks the genre and term clauses.
 */
export function rulesSql(rules: RequestRules, alias = 't'): { sql: string; params: unknown[] } {
  void rules; void alias;
  throw new Error('not implemented');
}
