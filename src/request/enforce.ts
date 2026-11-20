import type { TitleRow } from '../db/types.js';
import { HIDDEN_GEM_MAX_IMDB_VOTES } from './rules.js';
import type { CanonGenre, RequestRules, RuleClause } from './rules.js';
import { describeRuntime, describeYearWindow, languageName } from './describe.js';
import { jsonStrings, titleTags } from './tags.js';
import { THEMES } from './vocabulary.js';

export type CheckableTitle = Pick<
  TitleRow,
  | 'media_type' | 'title' | 'year' | 'genres' | 'keywords' | 'synopsis' | 'cast' | 'imdb_genres'
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
  const failed = [
    mediaFailure(rules, title),
    yearFailure(rules, title),
    ratingFailure(rules, title),
    runtimeFailure(rules, title),
    languageFailure(rules, title),
    hiddenGemFailure(rules, title),
  ].filter((f): f is string => f !== null);
  if (rules.must.length > 0 || rules.mustNot.length > 0) {
    const facts: TitleFacts = {
      tags: titleTags(title),
      texts: [...jsonStrings(title.keywords), title.synopsis ?? ''].map(flatten),
      name: flatten(title.title),
      cast: jsonStrings(title.cast).map(flatten),
    };
    for (const c of rules.must) if (!clauseHolds(c, facts, namesASubject(c))) failed.push(`not ${c.label}`);
    for (const c of rules.mustNot) if (clauseHolds(c, facts, true)) failed.push(`excluded: ${c.label}`);
  }
  return { ok: failed.length === 0, failed };
}

function mediaFailure(rules: RequestRules, t: CheckableTitle): string | null {
  if (!rules.mediaType || t.media_type === rules.mediaType) return null;
  return rules.mediaType === 'movie' ? 'a series, asked for films' : 'a film, asked for series';
}

function yearFailure(rules: RequestRules, t: CheckableTitle): string | null {
  if (rules.yearMin === null && rules.yearMax === null) return null;
  const asked = describeYearWindow(rules);
  if (t.year === null) return `release year unknown, asked for ${asked}`;
  const inside = (rules.yearMin === null || t.year >= rules.yearMin) && (rules.yearMax === null || t.year <= rules.yearMax);
  return inside ? null : `released ${t.year}, asked for ${asked}`;
}

function ratingFailure(rules: RequestRules, t: CheckableTitle): string | null {
  if (rules.minImdb === null) return null;
  const asked = `asked for IMDb ${rules.minImdb.toFixed(1)}+`;
  const rating = t.imdb_rating === null ? NaN : parseFloat(t.imdb_rating);
  if (Number.isNaN(rating)) return `no IMDb rating, ${asked}`;
  return rating >= rules.minImdb ? null : `IMDb ${rating.toFixed(1)}, ${asked}`;
}

/** Runtime bounds are for films; a series has no single length to compare. */
function runtimeFailure(rules: RequestRules, t: CheckableTitle): string | null {
  if (t.media_type !== 'movie' || (rules.minRuntime === null && rules.maxRuntime === null)) return null;
  const asked = `asked for ${describeRuntime(rules)!.toLowerCase()}`;
  const mins = t.runtime_minutes;
  if (mins === null) return `runtime unknown, ${asked}`;
  const inside = (rules.minRuntime === null || mins >= rules.minRuntime) && (rules.maxRuntime === null || mins <= rules.maxRuntime);
  return inside ? null : `runs ${mins} min, ${asked}`;
}

function languageFailure(rules: RequestRules, t: CheckableTitle): string | null {
  if (!rules.language || t.original_language === rules.language) return null;
  const asked = `asked for ${languageName(rules.language)}`;
  return t.original_language ? `in ${languageName(t.original_language)}, ${asked}` : `language unknown, ${asked}`;
}

function hiddenGemFailure(rules: RequestRules, t: CheckableTitle): string | null {
  if (!rules.hiddenGem) return null;
  if (t.imdb_votes === null) return 'IMDb votes unknown, asked for a hidden gem';
  if (t.imdb_votes <= HIDDEN_GEM_MAX_IMDB_VOTES) return null;
  return `${t.imdb_votes.toLocaleString('en-US')} IMDb votes, too well known for a hidden gem`;
}

/** What a clause is checked against, each text lowercased with hyphens as spaces. */
interface TitleFacts {
  tags: Set<CanonGenre>;
  /** Each keyword and the synopsis. */
  texts: string[];
  /**
   * The title's own name. It counts for an exclusion ("no nuns" keeps out The Nun)
   * and for a named subject ("Star Wars": Solo: A Star Wars Story has only "space
   * opera" in its keywords), never on its own for one of the built-in themes: on the
   * live catalogue most titles that matched a theme only by name were wrong ("Based
   * on a True Story", a comedy; "Killers of the Flower Moon" as space; "Santa Clarita
   * Diet" as Christmas).
   */
  name: string;
  /** Cast names, matched whole: a term names a person only when it is the full name. */
  cast: string[];
}

function flatten(s: string): string {
  return s.toLowerCase().replace(/-/g, ' ');
}

/** Every term of the built-in themes (space, time, true story, christmas, ...). */
const THEME_TERMS = new Set(Object.values(THEMES).flatMap((t) => t.terms.map(flatten)));

/**
 * Whether a must-clause names a particular thing (a franchise, a character, a
 * place) rather than one of the built-in themes: some of its words are not theme
 * words. Only then may a title's name satisfy it.
 */
function namesASubject(c: RuleClause): boolean {
  return c.terms.some((t) => !THEME_TERMS.has(flatten(t)));
}

function clauseHolds(c: RuleClause, facts: TitleFacts, nameCounts: boolean): boolean {
  if (c.genres.some((g) => facts.tags.has(g))) return true;
  const re = termPattern(c);
  if (re !== null && facts.texts.some((s) => re.test(s))) return true;
  if (re !== null && nameCounts && re.test(facts.name)) return true;
  return facts.cast.length > 0 && c.terms.some((t) => facts.cast.includes(flatten(t)));
}

const patterns = new WeakMap<RuleClause, RegExp | null>();

/** One regex per clause: any term, on word boundaries, with an optional trailing "s"/"es". */
function termPattern(c: RuleClause): RegExp | null {
  if (!patterns.has(c)) {
    const terms = c.terms.map(flatten).filter((t) => t.trim().length > 0);
    const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    patterns.set(c, terms.length ? new RegExp(`(?<![a-z0-9])(?:${escaped.join('|')})(?:s|es)?(?![a-z0-9])`) : null);
  }
  return patterns.get(c)!;
}

/**
 * SQL fragment (leading " AND …") plus params for the rules a column comparison
 * can decide: media type, year window, IMDb floor, film runtime, language and
 * the hidden-gem vote cap. A cheap prefilter only: every row it admits must
 * still pass titleObeys, which also checks the genre and term clauses.
 */
export function rulesSql(rules: RequestRules, alias = 't'): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (cond: string, value: unknown) => { where.push(cond); params.push(value); };
  if (rules.mediaType) add(`${alias}.media_type = ?`, rules.mediaType);
  if (rules.yearMin !== null) add(`${alias}.year >= ?`, rules.yearMin);
  if (rules.yearMax !== null) add(`${alias}.year <= ?`, rules.yearMax);
  if (rules.minImdb !== null) add(`CAST(${alias}.imdb_rating AS REAL) >= ?`, rules.minImdb);
  if (rules.minRuntime !== null) add(`(${alias}.media_type = 'tv' OR ${alias}.runtime_minutes >= ?)`, rules.minRuntime);
  if (rules.maxRuntime !== null) add(`(${alias}.media_type = 'tv' OR ${alias}.runtime_minutes <= ?)`, rules.maxRuntime);
  if (rules.language) add(`${alias}.original_language = ?`, rules.language);
  if (rules.hiddenGem) add(`${alias}.imdb_votes <= ?`, HIDDEN_GEM_MAX_IMDB_VOTES);
  return { sql: where.map((w) => ` AND ${w}`).join(''), params };
}
