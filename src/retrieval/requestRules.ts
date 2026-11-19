/**
 * Retrieval for a typed request: the titles that satisfy every rule of the
 * request, ranked by closeness to the request (blended with taste), genre
 * affinity, quality and popularity. Nothing outside the rules can be returned;
 * similarity and taste only order what passes.
 */
import type Database from 'better-sqlite3';
import type { RequestRules } from '../request/rules.js';
import { rulesSql, titleObeys } from '../request/enforce.js';
import { hardFilterSql, type HardFilters } from './filters.js';
import { rerank, type GenreAffinity } from './rerank.js';
import { REQUEST_WEIGHTS, type CandidateTitle } from './retrieve.js';

/** A request comes back with this many picks when enough titles satisfy it. */
export const FULL_SET = 10;
/** Candidates the model is shown for a request; when film vs series is open, this many of each. */
export const SLATE_SIZE = 40;
export const SLATE_PER_MEDIA = 30;
/** Older titles offered per free place in the list, so the model has a choice among them. */
const OLDER_CHOICE_PER_PLACE = 2;
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
  const hard = hardFilterSql({ ...q.hardFilters, minYear: null });
  const own = rulesSql(rules);
  const rows = db.prepare(`
    SELECT ${titleColumns(db)}, NULL AS embedding, vec_distance_cosine(t.embedding, ?) AS score
    FROM titles t
    WHERE t.embedding IS NOT NULL
      AND t.id NOT IN (SELECT title_id FROM watch_events WHERE profile_id IN (SELECT value FROM json_each(?)))
      AND t.id NOT IN (SELECT value FROM json_each(?))
      ${hard.sql}${own.sql}
  `).all(
    q.queryVec,
    JSON.stringify(q.vetoProfileIds),
    JSON.stringify(q.excludeTitleIds),
    ...hard.params,
    ...own.params,
  ) as CandidateTitle[];
  const passing = rows.filter((r) => titleObeys(rules, r).ok);
  return rerank(passing, q.affinity, new Set(), REQUEST_WEIGHTS).map(({ rank_score: _r, ...rest }) => rest as unknown as CandidateTitle);
}

export interface RulesRetrieval {
  /** The rules every title in `inWindow` satisfies. */
  rules: RequestRules;
  /** Titles satisfying every rule, best first. */
  inWindow: CandidateTitle[];
  /**
   * Older titles that satisfy every rule but the default year window, best
   * first; offered only to fill the list when `inWindow` is short. Empty unless
   * the default window had to be widened.
   */
  older: CandidateTitle[];
  /** The rules the older titles satisfy (the widened year floor); null when none were needed. */
  olderRules: RequestRules | null;
}

/**
 * Retrieve under `rules`. Only a default year window (no year in the request)
 * is ever widened, and only when fewer than FULL_SET titles pass: the floor
 * moves back to ten years before the current year, then twenty, then away,
 * until the list can be filled. A stated, recent or "any" window is never
 * widened: fewer titles come back.
 */
export function retrieveUnderRules(
  db: InstanceType<typeof Database>,
  rules: RequestRules,
  q: RulesQuery,
  now: Date,
): RulesRetrieval {
  const inWindow = titlesObeying(db, rules, q);
  const floor = rules.yearMin;
  if (rules.yearSource !== 'default' || floor === null || inWindow.length >= FULL_SET) {
    return { rules, inWindow, older: [], olderRules: null };
  }
  const cy = now.getFullYear();
  for (const yearMin of [cy - 10, cy - 20, null]) {
    if (yearMin !== null && yearMin >= floor) continue;
    const olderRules: RequestRules = { ...rules, yearMin };
    const older = titlesObeying(db, olderRules, q).filter((t) => t.year !== null && t.year < floor);
    if (inWindow.length + older.length >= FULL_SET || yearMin === null) {
      return { rules, inWindow, older, olderRules: older.length > 0 ? olderRules : null };
    }
  }
  return { rules, inWindow, older: [], olderRules: null };
}

/** How many older titles may join the list: only the places the window left free. */
export function olderRoom(r: RulesRetrieval): number {
  return r.older.length > 0 ? Math.max(0, FULL_SET - r.inWindow.length) : 0;
}

/**
 * The candidates shown to the model: the best SLATE_SIZE in the window (or the
 * best SLATE_PER_MEDIA films and series each, so both can be offered, when the
 * request leaves that open), and a choice of older titles for the free places.
 */
export function requestSlate(r: RulesRetrieval, mediaOpen: boolean): { recent: CandidateTitle[]; older: CandidateTitle[] } {
  let recent: CandidateTitle[];
  if (mediaOpen) {
    const count = { movie: 0, tv: 0 };
    recent = r.inWindow.filter((t) => ++count[t.media_type] <= SLATE_PER_MEDIA);
  } else {
    recent = r.inWindow.slice(0, SLATE_SIZE);
  }
  return { recent, older: r.older.slice(0, olderRoom(r) * OLDER_CHOICE_PER_PLACE) };
}

export interface ReferenceTitle {
  id: number;
  title: string;
  year: number | null;
  embedding: Buffer;
}

/** "inception something on those lines" → that phrase, then each shorter word-prefix down to "inception". */
function titlePrefixes(phrase: string): string[] {
  const words = phrase.trim().split(/\s+/).filter(Boolean).slice(0, MAX_REFERENCE_WORDS);
  return words
    .map((_, i) => words.slice(0, words.length - i).join(' ').toLowerCase().replace(/[.,!?;:]+$/, ''))
    .filter((prefix) => prefix.length > 0 && !ARTICLES.has(prefix));
}

/**
 * The catalogue titles a request names as references ("like Inception"): for
 * each phrase, the longest word-prefix that equals a stored title (ignoring
 * case), the one with the most IMDb votes when several share the name. Titles
 * without an embedding cannot steer the ranking and are skipped.
 */
export function findReferenceTitles(db: InstanceType<typeof Database>, phrases: string[]): ReferenceTitle[] {
  const found = new Map<number, ReferenceTitle>();
  const lookup = db.prepare(`
    SELECT id, title, year, embedding, lower(title) AS name
    FROM titles
    WHERE embedding IS NOT NULL AND lower(title) IN (SELECT value FROM json_each(?))
    ORDER BY imdb_votes DESC
  `);
  for (const phrase of phrases) {
    const prefixes = titlePrefixes(phrase);
    if (prefixes.length === 0) continue;
    const rows = lookup.all(JSON.stringify(prefixes)) as Array<ReferenceTitle & { name: string }>;
    for (const prefix of prefixes) {
      const hit = rows.find((r) => r.name === prefix);
      if (hit) {
        found.set(hit.id, { id: hit.id, title: hit.title, year: hit.year, embedding: hit.embedding });
        break;
      }
    }
  }
  return [...found.values()];
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
