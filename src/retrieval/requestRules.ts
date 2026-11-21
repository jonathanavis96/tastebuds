/**
 * Retrieval for a typed request: the titles that satisfy every rule of the
 * request, ranked by closeness to the request (blended with taste), genre
 * affinity, quality and popularity. Similarity and taste only order what passes.
 * When too few titles pass, two fallbacks may fill the list, each pick saying
 * why: close matches that miss only mood words, then a few older titles.
 */
import type Database from 'better-sqlite3';
import type { RequestRules } from '../request/rules.js';
import { hardRules, hasSoftClauses, missedSoftLabels, rulesSql, titleObeys } from '../request/enforce.js';
import { hardFilterSql, type HardFilters } from './filters.js';
import { rerank, type GenreAffinity } from './rerank.js';
import { REQUEST_WEIGHTS, type CandidateTitle } from './retrieve.js';

/** A request comes back with this many picks when enough titles satisfy it. */
export const FULL_SET = 10;
/**
 * With no year in the request, a list still short after close matches may take
 * a few titles from before the recent window: at most this many, from the
 * OLDER_YEARS_BACK years just before the window's floor (2005 to 2014 when the
 * window starts in 2015). They are exceptions that say why, never the bulk of a
 * list; anything older is for a request that asks for it ("any year", "90s").
 */
export const MAX_OLDER_PICKS = 3;
export const OLDER_YEARS_BACK = 10;
/** Candidates the model is shown for a request; when film vs series is open, this many of each. */
export const SLATE_SIZE = 40;
export const SLATE_PER_MEDIA = 30;
/** Close matches and older titles offered per free place in the list, so the model has a choice among them. */
const CHOICE_PER_PLACE = 2;
/** Words in a reference phrase tried as a title, longest prefix first. */
const MAX_REFERENCE_WORDS = 6;
const ARTICLES = new Set(['the', 'a', 'an']);

export interface RulesQuery {
  /** Float32 query vector: the request (and its references) blended with taste. */
  queryVec: Buffer;
  /** The household's hard filters; their year floor is ignored, since the rules own the year. */
  hardFilters: HardFilters;
  /** Profiles whose watch history hides a title. */
  vetoProfileIds: number[];
  /** Titles never returned: pending, dismissed, engaged, and the request's references. */
  excludeTitleIds: number[];
  affinity: GenreAffinity;
}

/** Every titles column but the 3 KB embedding, quoted ("cast" is an SQL keyword). */
const columnLists = new WeakMap<object, string>();
function titleColumns(db: InstanceType<typeof Database>): string {
  let cols = columnLists.get(db);
  if (cols === undefined) {
    const names = (db.prepare("SELECT name FROM pragma_table_info('titles')").all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((n) => n !== 'embedding');
    cols = names.map((n) => `t."${n}"`).join(', ');
    columnLists.set(db, cols);
  }
  return cols;
}

/**
 * The titles that satisfy every rule in `rules`, best first. One SQL query
 * applies what columns can decide (hard filters without their year floor, the
 * rules' own column checks, the exclusions) and computes the distance to the
 * query vector; titleObeys then checks every row, including the genre and term
 * clauses, and only the rows that pass are ranked.
 */
export function titlesObeying(db: InstanceType<typeof Database>, rules: RequestRules, q: RulesQuery): CandidateTitle[] {
  const passing = candidateRows(db, rules, q, null).filter((r) => titleObeys(rules, r).ok);
  return rerank(passing, q.affinity, new Set(), REQUEST_WEIGHTS).map(({ rank_score: _r, ...rest }) => rest as unknown as CandidateTitle);
}

/**
 * How many of `ids` titlesObeying would return under the same rules and query:
 * the titles already in the list that match. Reads only those rows.
 */
export function countObeying(db: InstanceType<typeof Database>, rules: RequestRules, q: RulesQuery, ids: number[]): number {
  if (ids.length === 0) return 0;
  return candidateRows(db, rules, q, ids).filter((r) => titleObeys(rules, r).ok).length;
}

/** The rows the column checks admit, with their distance to the query; only `onlyIds` when given. */
function candidateRows(db: InstanceType<typeof Database>, rules: RequestRules, q: RulesQuery, onlyIds: number[] | null): CandidateTitle[] {
  const hard = hardFilterSql({ ...q.hardFilters, minYear: null });
  const own = rulesSql(rules);
  const only = onlyIds === null ? { sql: '', params: [] } : { sql: ' AND t.id IN (SELECT value FROM json_each(?))', params: [JSON.stringify(onlyIds)] };
  return db.prepare(`
    SELECT ${titleColumns(db)}, NULL AS embedding, vec_distance_cosine(t.embedding, ?) AS score
    FROM titles t
    WHERE t.embedding IS NOT NULL
      AND t.id NOT IN (SELECT title_id FROM watch_events WHERE profile_id IN (SELECT value FROM json_each(?)))
      AND t.id NOT IN (SELECT value FROM json_each(?))
      ${hard.sql}${own.sql}${only.sql}
  `).all(
    q.queryVec,
    JSON.stringify(q.vetoProfileIds),
    JSON.stringify(q.excludeTitleIds),
    ...hard.params,
    ...own.params,
    ...only.params,
  ) as CandidateTitle[];
}

export interface RulesRetrieval {
  /** The rules every title in `inWindow` satisfies. */
  rules: RequestRules;
  /** Titles satisfying every rule, best first. */
  inWindow: CandidateTitle[];
  /**
   * Close matches: titles in the same year window that satisfy every hard rule
   * but miss one or more soft (mood) clauses, fewest missed first, then by rank.
   * Offered only to fill the list when `inWindow` is short; empty otherwise or
   * when the request has no soft clauses.
   */
  close: CandidateTitle[];
  /** The rules the close matches satisfy (`rules` without its soft clauses); null when there are none. */
  closeRules: RequestRules | null;
  /**
   * Titles from just before the default year window that satisfy every rule
   * but the year, best first; offered only when the list is still short after
   * the close matches. Empty unless the default window came up short.
   */
  older: CandidateTitle[];
  /** The rules the older titles satisfy (the years just before the window); null when there are none. */
  olderRules: RequestRules | null;
}

/**
 * Titles that obey every hard rule of `rules` but miss at least one soft
 * clause, leaving out `strictIds`: fewest soft clauses missed first, then in
 * the usual request ranking.
 */
function closeMatches(
  db: InstanceType<typeof Database>,
  rules: RequestRules,
  relaxed: RequestRules,
  q: RulesQuery,
  strictIds: Set<number>,
): CandidateTitle[] {
  const misses = new Map<number, number>();
  const rows = candidateRows(db, relaxed, q, null).filter((r) => {
    if (strictIds.has(r.id) || !titleObeys(relaxed, r).ok) return false;
    const missed = missedSoftLabels(rules, r).length;
    misses.set(r.id, missed);
    return missed > 0;
  });
  const ranked = rerank(rows, q.affinity, new Set(), REQUEST_WEIGHTS).map(({ rank_score: _r, ...rest }) => rest as unknown as CandidateTitle);
  // Array.prototype.sort is stable, so the ranking holds among equal misses.
  return ranked.sort((a, b) => misses.get(a.id)! - misses.get(b.id)!);
}

/**
 * Retrieve under `rules`. When fewer than FULL_SET titles pass every rule:
 *  1. a request with soft (mood) clauses is offered close matches, titles in
 *     the same year window that pass every hard rule and miss some mood words;
 *  2. only if the list is still short, and only for a default year window (no
 *     year in the request), the OLDER_YEARS_BACK years before the window's
 *     floor are searched for a few more titles under the unchanged rules.
 * A stated, recent or "any" window is never widened: fewer titles come back.
 */
export function retrieveUnderRules(
  db: InstanceType<typeof Database>,
  rules: RequestRules,
  q: RulesQuery,
): RulesRetrieval {
  const inWindow = titlesObeying(db, rules, q);
  const none = { rules, inWindow, close: [], closeRules: null, older: [], olderRules: null };
  if (inWindow.length >= FULL_SET) return none;

  let close: CandidateTitle[] = [];
  let closeRules: RequestRules | null = null;
  if (hasSoftClauses(rules)) {
    const relaxed = hardRules(rules);
    close = closeMatches(db, rules, relaxed, q, new Set(inWindow.map((t) => t.id)));
    closeRules = close.length > 0 ? relaxed : null;
  }
  const withClose = { ...none, close, closeRules };

  const floor = rules.yearMin;
  const filled = inWindow.length + Math.min(close.length, FULL_SET - inWindow.length);
  if (rules.yearSource !== 'default' || floor === null || filled >= FULL_SET) return withClose;
  const olderRules: RequestRules = { ...rules, yearMin: floor - OLDER_YEARS_BACK, yearMax: floor - 1 };
  const older = titlesObeying(db, olderRules, q);
  return { ...withClose, older, olderRules: older.length > 0 ? olderRules : null };
}

/** How many close matches may join the list: the places the strict matches left free. */
export function closeRoom(r: RulesRetrieval): number {
  return Math.min(r.close.length, Math.max(0, FULL_SET - r.inWindow.length));
}

/** How many older titles may join the list: the places still free after the close matches, MAX_OLDER_PICKS at most. */
export function olderRoom(r: RulesRetrieval): number {
  if (r.older.length === 0) return 0;
  return Math.min(MAX_OLDER_PICKS, Math.max(0, FULL_SET - r.inWindow.length - closeRoom(r)));
}

/**
 * The candidates shown to the model: the best SLATE_SIZE in the window (or the
 * best SLATE_PER_MEDIA films and series each, so both can be offered, when the
 * request leaves that open), and a choice of close matches and older titles
 * for the free places.
 */
export function requestSlate(
  r: RulesRetrieval,
  mediaOpen: boolean,
): { recent: CandidateTitle[]; close: CandidateTitle[]; older: CandidateTitle[] } {
  let recent: CandidateTitle[];
  if (mediaOpen) {
    const count = { movie: 0, tv: 0 };
    recent = r.inWindow.filter((t) => ++count[t.media_type] <= SLATE_PER_MEDIA);
  } else {
    recent = r.inWindow.slice(0, SLATE_SIZE);
  }
  return {
    recent,
    close: r.close.slice(0, closeRoom(r) * CHOICE_PER_PLACE),
    older: r.older.slice(0, olderRoom(r) * CHOICE_PER_PLACE),
  };
}

export interface ReferenceTitle {
  id: number;
  title: string;
  year: number | null;
  embedding: Buffer;
}

/** Letters and digits only, single spaces: "Spider-Man: No Way Home" → "spider man no way home". */
function plain(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** "inception something on those lines" → that phrase, then each shorter word-prefix down to "inception". */
function titlePrefixes(phrase: string): string[] {
  const words = plain(phrase).split(' ').filter(Boolean).slice(0, MAX_REFERENCE_WORDS);
  return words.map((_, i) => words.slice(0, words.length - i).join(' ')).filter((prefix) => !ARTICLES.has(prefix));
}

/**
 * The catalogue titles a request names as references ("like Inception"): for
 * each phrase, the longest word-prefix that equals a stored title, the one with
 * the most IMDb votes when several share the name. Case and punctuation are
 * ignored ("spider man" is "Spider-Man"), which SQL cannot do, so the titles'
 * names are read once: a few milliseconds, and only for a request that names a
 * reference. Titles without an embedding cannot steer the ranking and are skipped.
 */
export function findReferenceTitles(db: InstanceType<typeof Database>, phrases: string[]): ReferenceTitle[] {
  const wanted = phrases.map(titlePrefixes).filter((prefixes) => prefixes.length > 0);
  if (wanted.length === 0) return [];
  const idByName = new Map<string, number>();
  const names = db.prepare('SELECT id, title FROM titles WHERE embedding IS NOT NULL ORDER BY imdb_votes DESC, id').all() as Array<{ id: number; title: string }>;
  for (const n of names) {
    const name = plain(n.title);
    if (!idByName.has(name)) idByName.set(name, n.id);
  }
  const ids = new Set<number>();
  for (const prefixes of wanted) {
    const id = prefixes.map((prefix) => idByName.get(prefix)).find((found) => found !== undefined);
    if (id !== undefined) ids.add(id);
  }
  if (ids.size === 0) return [];
  return db
    .prepare('SELECT id, title, year, embedding FROM titles WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify([...ids])) as ReferenceTitle[];
}

/**
 * The rules once the references are known: a request that names an older film
 * as its example ("like Heat") is asking for that kind of film, so a default
 * year window is dropped. A window the request stated is kept.
 */
export function withReferences(rules: RequestRules, refs: ReferenceTitle[]): RequestRules {
  const floor = rules.yearMin;
  if (rules.yearSource !== 'default' || floor === null) return rules;
  if (!refs.some((r) => r.year !== null && r.year < floor)) return rules;
  return { ...rules, yearMin: null, yearMax: null, yearSource: 'any' };
}

/** The request vector: the mean of the request embedding and the references' stored embeddings of the same size. */
export function requestVector(requestVec: number[], refs: ReferenceTitle[]): number[] {
  const vectors = [
    requestVec,
    ...refs
      .map((r) => Array.from(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.length / 4)))
      .filter((v) => v.length === requestVec.length),
  ];
  return requestVec.map((_, i) => vectors.reduce((sum, v) => sum + v[i], 0) / vectors.length);
}
