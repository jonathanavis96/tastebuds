/**
 * On-demand request coverage: makes sure the library holds titles that can
 * satisfy a request's rules before retrieval runs (ensureRulesCoverage), and
 * carries the genres a request named into the profile's loved genres.
 *
 * All TMDB and embed calls are injectable via a `deps` param so tests never hit
 * the network (pattern mirrors how retrieve.ts injects embedFn).
 */

import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { DiscoverOpts, TmdbTitle, TmdbTitleDetail } from '../tmdb/types.js';
import { getTitleByTmdbId, upsertTitle } from '../db/repos/titles.js';
import { getUsage, bumpRequestAdded, today } from '../db/repos/apiUsage.js';
import { discoverTitles, getTitleDetails, searchTitles, searchKeyword } from '../tmdb/client.js';
import { mapTmdbToTitleRow } from '../tmdb/mappers.js';
import { embedText } from '../ollama/embed.js';
import { tmdbQueryForGenre } from '../tmdb/taxonomy.js';
import { getTasteSignature, upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import { applyCachedImdbRatings } from '../imdb/dataset.js';
import type { RequestRules, RuleClause } from '../request/rules.js';

/**
 * Injectable dependencies — real implementations are the default; tests inject
 * stubs so network calls never happen during testing.
 */
export interface OnDemandDeps {
  discoverTitles: typeof discoverTitles;
  getTitleDetails: (
    tmdbId: number,
    mediaType: 'movie' | 'tv',
    config: Pick<Config, 'tmdbApiKey'>,
  ) => Promise<TmdbTitleDetail>;
  searchTitles: (
    query: string,
    mediaType: 'movie' | 'tv',
    config: Pick<Config, 'tmdbApiKey'>,
  ) => Promise<TmdbTitle[]>;
  searchKeyword: (
    query: string,
    config: Pick<Config, 'tmdbApiKey'>,
  ) => Promise<Array<{ id: number; name: string }>>;
  embedText: (text: string, config: Pick<Config, 'ollamaUrl'>) => Promise<number[]>;
  applyCachedImdbRatings: typeof applyCachedImdbRatings;
  /** Milliseconds since the epoch; the time budget and "today" are read from it. */
  now: () => number;
}

const realDeps: OnDemandDeps = {
  discoverTitles,
  getTitleDetails,
  searchTitles,
  searchKeyword,
  embedText,
  applyCachedImdbRatings,
  now: Date.now,
};

// In-process keyword id cache — persists across requests within one server
// lifetime so we don't re-resolve "horror" → 315058 on every /generate call.
// Exported so the daily harvest can share the same cache and avoid duplicate
// keyword lookups when both harvest and on-demand run in the same process.
export const keywordIdCache = new Map<string, number | null>();

/**
 * Resolve a keyword term to its TMDB keyword id via searchKeyword.
 * Returns null if no exact match is found. Caches results in keywordIdCache
 * (shared with the daily harvest to avoid redundant lookups).
 *
 * Exported so harvest.ts can reuse the same resolution logic + cache without
 * duplicating the implementation.
 */
export async function resolveKeywordId(
  term: string,
  config: Pick<Config, 'tmdbApiKey'>,
  deps: Pick<OnDemandDeps, 'searchKeyword'>,
): Promise<number | null> {
  const cached = keywordIdCache.get(term);
  if (cached !== undefined) return cached;

  const results = await deps.searchKeyword(term, config);
  // Prefer an exact name match; fall back to the first result
  const exact = results.find((r) => r.name.toLowerCase() === term.toLowerCase());
  const id = exact?.id ?? results[0]?.id ?? null;
  keywordIdCache.set(term, id);
  return id;
}

interface Candidate {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
}

/**
 * Fetch a title's details, embed it and store it. Returns the new row id, or
 * null when it could not be fetched (the reason is added to `errors`). A failed
 * embedding still stores the title, without a vector.
 */
async function ingestTitle(
  db: InstanceType<typeof Database>,
  { tmdbId, mediaType }: Candidate,
  config: Config,
  deps: OnDemandDeps,
  errors: string[],
): Promise<number | null> {
  try {
    const detail = await deps.getTitleDetails(tmdbId, mediaType, config);
    const mapped = mapTmdbToTitleRow(detail, mediaType);

    const embedInput = `${mapped.title} ${mapped.synopsis ?? ''}`.slice(0, 500);
    let embedding: Buffer | null = null;

    try {
      const vec = await deps.embedText(embedInput, config);
      embedding = Buffer.from(new Float32Array(vec).buffer);
    } catch (embedErr) {
      errors.push(`embed failed for ${mapped.title}: ${String(embedErr)}`);
    }

    upsertTitle(db, { ...mapped, embedding });
    return getTitleByTmdbId(db, tmdbId, mediaType)?.id ?? null;
  } catch (err) {
    errors.push(`Failed to process tmdb_id=${tmdbId} (${mediaType}): ${String(err)}`);
    return null;
  }
}

export interface OnDemandResult {
  added: number;
  errors: string[];
}

// ── Rules-driven discovery ───────────────────────────────────────────────────

/** New titles one request may add, so a single /generate stays quick. */
const RULES_MAX_NEW = 40;
/** Titles fetched and embedded at the same time. */
const RULES_CONCURRENCY = 6;
/** No new title is started this long after the call began. */
const RULES_TIME_BUDGET_MS = 10_000;
/** Theme terms looked up as TMDB keywords, per clause. */
const THEME_KEYWORD_LIMIT = 6;
/** Distinct genre/keyword combinations asked for per media type (see filterShapes). */
const MAX_FILTER_SHAPES = 4;
/** Most popular finds the well-known titles, most voted the well-rated ones. */
const RULES_SORTS = ['popularity.desc', 'vote_count.desc'] as const;
const RULES_PAGES = [1, 2] as const;
const RULES_MIN_VOTES: Record<'movie' | 'tv', number> = { movie: 50, tv: 20 };
/** Words in a reference phrase tried as a title, longest prefix first. */
const MAX_REFERENCE_WORDS = 6;
const ARTICLES = new Set(['the', 'a', 'an']);

// Theme words must name a TMDB keyword exactly: the first search hit for
// "medical" or "nun" is often an unrelated keyword. Kept apart from
// keywordIdCache, which falls back to the first hit.
export const exactKeywordIdCache = new Map<string, number | null>();

async function exactKeywordId(
  term: string,
  config: Pick<Config, 'tmdbApiKey'>,
  deps: Pick<OnDemandDeps, 'searchKeyword'>,
): Promise<number | null> {
  const cached = exactKeywordIdCache.get(term);
  if (cached !== undefined) return cached;
  const results = await deps.searchKeyword(term, config);
  const id = results.find((r) => r.name.toLowerCase() === term.toLowerCase())?.id ?? null;
  exactKeywordIdCache.set(term, id);
  return id;
}

/** TMDB ids a clause can be asked for by, split by parameter; either list may be empty. */
interface ClauseIds {
  genres: number[];
  keywords: number[];
}

/** A keyword that cannot be looked up is left out of the query (recorded in `errors`), not fatal. */
async function clauseIds(
  clause: RuleClause,
  mediaType: 'movie' | 'tv',
  config: Config,
  deps: OnDemandDeps,
  errors: string[],
): Promise<ClauseIds> {
  const genres: number[] = [];
  const keywordLookups: Array<Promise<number | null>> = [];
  const lookup = (term: string, find: Promise<number | null>) =>
    keywordLookups.push(
      find.catch((err) => {
        errors.push(`Keyword lookup for "${term}" failed: ${String(err)}`);
        return null;
      }),
    );
  for (const genre of clause.genres) {
    const query = tmdbQueryForGenre(genre, mediaType);
    if (query == null) continue;
    if ('genreId' in query) genres.push(query.genreId);
    else lookup(query.keyword, resolveKeywordId(query.keyword, config, deps));
  }
  for (const term of clause.terms.slice(0, THEME_KEYWORD_LIMIT)) {
    lookup(term, exactKeywordId(term, config, deps));
  }
  const keywords = (await Promise.all(keywordLookups)).filter((id): id is number => id != null);
  return { genres: [...new Set(genres)], keywords: [...new Set(keywords)] };
}

/** One way to ask TMDB for the must clauses: per parameter, an AND of OR groups. */
interface FilterShape {
  genres: number[][];
  keywords: number[][];
}

function* product<T>(lists: T[][]): Generator<T[]> {
  if (lists.length === 0) {
    yield [];
    return;
  }
  const [first, ...rest] = lists;
  for (const item of first) {
    for (const tail of product(rest)) yield [item, ...tail];
  }
}

/**
 * TMDB reads one parameter as all-AND (comma) or all-OR (pipe), never a mix:
 * a single OR group is sent whole, several groups are split into every
 * combination of single ids.
 */
function* sendable(groups: number[][]): Generator<number[][]> {
  if (groups.length <= 1) {
    yield groups;
    return;
  }
  for (const ids of product(groups)) yield ids.map((id) => [id]);
}

/**
 * The genre/keyword combinations that together cover every must clause. A
 * clause holding both genre and keyword ids (a series "Thriller or Drama") is
 * tried each way, since TMDB cannot OR across parameters. Clauses TMDB cannot
 * express are left out: the query is wider and retrieval enforces them.
 */
function filterShapes(clauses: ClauseIds[]): FilterShape[] {
  const choices = clauses
    .map((c) => [
      ...(c.genres.length > 0 ? [{ genres: c.genres, keywords: null }] : []),
      ...(c.keywords.length > 0 ? [{ genres: null, keywords: c.keywords }] : []),
    ])
    .filter((options) => options.length > 0);

  const shapes: FilterShape[] = [];
  for (const choice of product(choices)) {
    const genreGroups = choice.flatMap((c) => (c.genres ? [c.genres] : []));
    const keywordGroups = choice.flatMap((c) => (c.keywords ? [c.keywords] : []));
    for (const genres of sendable(genreGroups)) {
      for (const keywords of sendable(keywordGroups)) {
        shapes.push({ genres, keywords });
        if (shapes.length === MAX_FILTER_SHAPES) return shapes;
      }
    }
  }
  return shapes;
}

function shapeOpts(shape: FilterShape): Pick<DiscoverOpts, 'genreIds' | 'genreMatch' | 'keywordIds' | 'keywordMatch'> {
  return {
    genreIds: shape.genres.flat(),
    genreMatch: shape.genres.length === 1 ? 'any' : 'all',
    keywordIds: shape.keywords.flat(),
    keywordMatch: shape.keywords.length === 1 ? 'any' : 'all',
  };
}

/** Inclusive date bounds for the rules' years, never past today; null when the window lies in the future. */
function releaseWindow(rules: RequestRules, todayIso: string): { releasedFrom?: string; releasedTo: string } | null {
  const yearEnd = rules.yearMax != null ? `${rules.yearMax}-12-31` : null;
  const releasedTo = yearEnd != null && yearEnd < todayIso ? yearEnd : todayIso;
  const releasedFrom = rules.yearMin != null ? `${rules.yearMin}-01-01` : undefined;
  if (releasedFrom != null && releasedFrom > releasedTo) return null;
  return { releasedFrom, releasedTo };
}

/** Exclusions for one media type: genres where TMDB has them, keywords otherwise. */
async function exclusionOpts(
  mustNot: RuleClause[],
  mediaType: 'movie' | 'tv',
  config: Config,
  deps: OnDemandDeps,
  errors: string[],
): Promise<Pick<DiscoverOpts, 'withoutGenreIds' | 'withoutKeywordIds'>> {
  const ids = await Promise.all(mustNot.map((c) => clauseIds(c, mediaType, config, deps, errors)));
  return {
    withoutGenreIds: [...new Set(ids.flatMap((c) => c.genres))],
    withoutKeywordIds: [...new Set(ids.flatMap((c) => c.keywords))],
  };
}

/** Every TMDB result list for one media type: each filter shape × ordering × page. */
async function discoverForRules(
  rules: RequestRules,
  mediaType: 'movie' | 'tv',
  todayIso: string,
  config: Config,
  deps: OnDemandDeps,
  errors: string[],
): Promise<Candidate[][]> {
  const window = releaseWindow(rules, todayIso);
  if (window == null) return [];

  const [clauses, exclusions] = await Promise.all([
    Promise.all(rules.must.map((c) => clauseIds(c, mediaType, config, deps, errors))),
    exclusionOpts(rules.mustNot, mediaType, config, deps, errors),
  ]);

  const base: DiscoverOpts = {
    mediaType,
    ...window,
    ...exclusions,
    originalLanguage: rules.language ?? 'en',
    voteCountGte: RULES_MIN_VOTES[mediaType],
  };
  const calls = filterShapes(clauses).flatMap((shape) =>
    RULES_SORTS.flatMap((sortBy) =>
      RULES_PAGES.map((page): DiscoverOpts => ({ ...base, ...shapeOpts(shape), sortBy, page })),
    ),
  );
  return Promise.all(
    calls.map(async (opts) => {
      try {
        const titles = await deps.discoverTitles(opts, config);
        return titles.map((t) => ({ tmdbId: t.id, mediaType }));
      } catch (err) {
        errors.push(`discoverTitles(${mediaType}, ${opts.sortBy} p${opts.page}) failed: ${String(err)}`);
        return [];
      }
    }),
  );
}

function normalTitle(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** "inception something on those lines" → that phrase, then each shorter prefix down to "inception". */
function titlePrefixes(phrase: string): string[] {
  const words = phrase.trim().split(/\s+/).filter(Boolean).slice(0, MAX_REFERENCE_WORDS);
  return words
    .map((_, i) => words.slice(0, words.length - i).join(' '))
    .filter((prefix) => !ARTICLES.has(prefix.toLowerCase()));
}

/**
 * Find the title a reference phrase names, as a film or a series: the first
 * prefix of the phrase that some search result matches exactly wins.
 */
async function findReference(phrase: string, config: Config, deps: OnDemandDeps): Promise<Candidate[]> {
  for (const prefix of titlePrefixes(phrase)) {
    const wanted = normalTitle(prefix);
    const hits = await Promise.all(
      (['movie', 'tv'] as const).map(async (mediaType) => {
        const results = await deps.searchTitles(prefix, mediaType, config);
        const match = results.find((t) => normalTitle(t.title ?? t.name ?? '') === wanted);
        return match ? [{ tmdbId: match.id, mediaType }] : [];
      }),
    );
    if (hits.flat().length > 0) return hits.flat();
  }
  return [];
}

async function findReferences(rules: RequestRules, config: Config, deps: OnDemandDeps, errors: string[]): Promise<Candidate[]> {
  const found = await Promise.all(
    rules.similarTo.map((phrase) =>
      findReference(phrase, config, deps).catch((err) => {
        errors.push(`Reference search for "${phrase}" failed: ${String(err)}`);
        return [];
      }),
    ),
  );
  return found.flat();
}

/** Take one item from each list in turn, so every ordering and page is represented near the front. */
function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out;
}

/**
 * Ingest `queue` in order, RULES_CONCURRENCY at a time, until `cap` titles
 * were added or the time budget since `startedAt` is spent. Returns the new row ids.
 */
async function ingestBounded(
  db: InstanceType<typeof Database>,
  queue: Candidate[],
  cap: number,
  startedAt: number,
  config: Config,
  deps: OnDemandDeps,
  errors: string[],
): Promise<number[]> {
  const added: number[] = [];
  let next = 0;
  let inFlight = 0;
  const canStart = () =>
    next < queue.length && added.length + inFlight < cap && deps.now() - startedAt < RULES_TIME_BUDGET_MS;

  const worker = async () => {
    while (canStart()) {
      const candidate = queue[next++];
      inFlight++;
      try {
        const id = await ingestTitle(db, candidate, config, deps, errors);
        if (id != null) added.push(id);
      } finally {
        inFlight--;
      }
    }
  };
  await Promise.all(Array.from({ length: RULES_CONCURRENCY }, worker));
  return added;
}

/**
 * Make sure the library holds titles that can satisfy `rules` before retrieval
 * runs: ask TMDB for titles inside the rules' year window, genres, exclusions,
 * language and media type (most popular and most voted first), look up the
 * reference titles by name, and add the ones not stored yet with their
 * details, embedding and IMDb rating. Best effort and bounded by the daily
 * request budget: errors are collected, never thrown.
 *
 * `uiMediaType` is the Films/Series filter chosen in the app; the rules' own
 * media type wins when the request states one. The request text itself is not
 * searched as a title: whole sentences matched unrelated titles, and the
 * references a request names are already in `rules.similarTo`.
 */
export async function ensureRulesCoverage(
  db: InstanceType<typeof Database>,
  rules: RequestRules,
  uiMediaType: 'movie' | 'tv' | undefined,
  config: Config,
  deps: OnDemandDeps = realDeps,
): Promise<OnDemandResult> {
  const result: OnDemandResult = { added: 0, errors: [] };
  const startedAt = deps.now();

  const runDay = today();
  const remaining = Math.max(0, config.requestLookupDailyBudget - getUsage(db, runDay).request_added);
  if (remaining === 0) return result;

  const mediaTypes: Array<'movie' | 'tv'> =
    rules.mediaType != null ? [rules.mediaType] : uiMediaType != null ? [uiMediaType] : ['movie', 'tv'];
  const todayIso = new Date(startedAt).toISOString().slice(0, 10);

  const [references, ...discovered] = await Promise.all([
    findReferences(rules, config, deps, result.errors),
    ...mediaTypes.map((mt) => discoverForRules(rules, mt, todayIso, config, deps, result.errors)),
  ]);

  const seen = new Set<string>();
  const queue = [...references, ...interleave(discovered.flat())].filter((c) => {
    const key = `${c.tmdbId}:${c.mediaType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return getTitleByTmdbId(db, c.tmdbId, c.mediaType) == null;
  });

  const cap = Math.min(RULES_MAX_NEW, remaining);
  const newIds = await ingestBounded(db, queue, cap, startedAt, config, deps, result.errors);
  result.added = newIds.length;
  if (result.added === 0) return result;

  bumpRequestAdded(db, runDay, result.added);
  try {
    await deps.applyCachedImdbRatings(db, config, newIds);
  } catch (err) {
    result.errors.push(`IMDb ratings for new titles failed: ${String(err)}`);
  }
  return result;
}

/** Maximum number of loved_genres to store per profile. */
const MAX_LOVED_GENRES = 12;

/**
 * Persist explicit request genre affinity into the profile's taste signature.
 *
 * The genres a request asked for outright (its single-genre must clauses, as
 * read into rules) are merged into `prefs.loved_genres`, so the affinity
 * persists into future passive browsing (retrieval reads `loved_genres` to bias
 * the candidate pool). A clause such as "thriller or horror" names no one genre
 * and adds nothing.
 *
 * Merge semantics:
 *   - Existing genres are kept in their current order (oldest first).
 *   - New genres are appended after dedup (case-insensitive comparison).
 *   - If the total exceeds MAX_LOVED_GENRES, the oldest entries are dropped
 *     from the front so the most-recent 12 are kept.
 *   - All other prefs keys (hated_genres, loved_themes, etc.) are untouched.
 *   - The existing taste_vector and refreshed_at are preserved; only `prefs`
 *     is written back, so a vector refresh isn't triggered.
 *   - No-ops when the rules name no single genre.
 */
export function mergeRequestGenresToProfile(
  db: InstanceType<typeof Database>,
  profileId: number,
  rules: Pick<RequestRules, 'must'>,
): void {
  const genres = [...new Set(rules.must.filter((c) => c.genres.length === 1).map((c) => c.genres[0]))];
  if (genres.length === 0) return;

  const existing = getTasteSignature(db, profileId);
  let prefs: Record<string, unknown> = {};
  try {
    prefs = existing ? (JSON.parse(existing.prefs || '{}') as Record<string, unknown>) : {};
  } catch {
    prefs = {};
  }

  const currentLovedGenres: string[] = Array.isArray(prefs.loved_genres)
    ? (prefs.loved_genres as string[])
    : [];

  // Build deduplicated list: existing order preserved, new genres appended.
  // Case-insensitive comparison guards against "horror" vs "Horror" duplicates.
  const seen = new Set<string>(currentLovedGenres.map((g) => g.toLowerCase()));
  const merged = [...currentLovedGenres];
  for (const g of genres) {
    if (!seen.has(g.toLowerCase())) {
      seen.add(g.toLowerCase());
      merged.push(g);
    }
  }

  // Cap: drop from the front (oldest) to keep at most MAX_LOVED_GENRES entries.
  const capped =
    merged.length > MAX_LOVED_GENRES ? merged.slice(merged.length - MAX_LOVED_GENRES) : merged;

  upsertTasteSignature(db, {
    profile_id: profileId,
    taste_vector: existing?.taste_vector ?? null,
    prefs: JSON.stringify({ ...prefs, loved_genres: capped }),
    // Preserve existing refreshed_at so a prefs-only update doesn't look like a
    // fresh vector refresh to callers that read this timestamp.
    refreshed_at: existing?.refreshed_at ?? new Date().toISOString(),
  });
}
