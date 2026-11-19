/**
 * On-demand request coverage — ensures the DB contains titles relevant to a
 * user's free-text request BEFORE retrieval runs.
 *
 * When a user types "scary thrillers" and the DB has no horror/thriller series,
 * the retrieval step finds nothing. This module plugs that gap by:
 *   1. Parsing the request text into canonical genre names (Horror, Thriller, …)
 *   2. For each media type in scope, resolving genres → TMDB genre ids + keyword terms
 *   3. Discovering titles via genre ids, keyword ids, and a direct title search
 *   4. For new (not-yet-in-DB) titles: fetch details → embed → upsert
 *   5. Enforcing the daily request_added budget so we never spam TMDB
 *
 * All TMDB + embed calls are injectable via a `deps` param so tests never hit
 * the network (pattern mirrors how retrieve.ts injects embedFn).
 */

import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { DiscoverOpts, TmdbTitle, TmdbTitleDetail } from '../tmdb/types.js';
import { getTitleByTmdbId, upsertTitle } from '../db/repos/titles.js';
import { getUsage, bumpRequestAdded, today } from '../db/repos/apiUsage.js';
import {
  discoverTitles,
  getTitleDetails,
  searchTitles,
  searchKeyword,
} from '../tmdb/client.js';
import { mapTmdbToTitleRow } from '../tmdb/mappers.js';
import { embedText } from '../ollama/embed.js';
import { resolveGenreNames, tmdbQueryForGenre } from '../tmdb/taxonomy.js';
import { getTasteSignature, upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import { applyCachedImdbRatings } from '../imdb/dataset.js';
import type { RequestRules, RuleClause } from '../request/rules.js';

// ── Synonym table ─────────────────────────────────────────────────────────────
// Maps vibe words → canonical TMDB genre names. Matched case-insensitively on
// word boundaries in the request string. Canonical names must match MOVIE_GENRE_MAP
// keys (and/or TV_KEYWORD_GENRES keys for TV-only vibes).
const SYNONYM_MAP: Array<{ terms: string[]; genre: string }> = [
  {
    terms: ['scary', 'spooky', 'creepy', 'frightening', 'chilling', 'haunting', 'horror'],
    genre: 'Horror',
  },
  {
    terms: ['thriller', 'tense', 'gripping', 'suspense', 'suspenseful', 'edge-of-your-seat', 'thrilling'],
    genre: 'Thriller',
  },
  {
    terms: ['funny', 'hilarious', 'comedy', 'lighthearted', 'comedic', 'laugh'],
    genre: 'Comedy',
  },
  {
    terms: ['romantic', 'romance', 'love story', 'love'],
    genre: 'Romance',
  },
  {
    terms: ['mind-bending', 'sci-fi', 'science fiction', 'space', 'futuristic', 'scifi'],
    genre: 'Science Fiction',
  },
  {
    terms: ['crime', 'heist', 'detective', 'gangster', 'mob'],
    genre: 'Crime',
  },
  {
    terms: ['mystery', 'whodunit', 'whodunnit', 'puzzling', 'enigmatic'],
    genre: 'Mystery',
  },
  {
    terms: ['drama', 'dramatic', 'emotional', 'moving', 'poignant'],
    genre: 'Drama',
  },
  {
    terms: ['action', 'action-packed', 'explosive', 'adrenaline'],
    genre: 'Action',
  },
  {
    terms: ['adventure', 'adventurous', 'quest', 'journey', 'epic'],
    genre: 'Adventure',
  },
  {
    terms: ['animated', 'animation', 'cartoon'],
    genre: 'Animation',
  },
  {
    terms: ['documentary', 'docuseries', 'doc', 'real story', 'true story'],
    genre: 'Documentary',
  },
  {
    terms: ['fantasy', 'magical', 'fantastical', 'fairy tale'],
    genre: 'Fantasy',
  },
];

/**
 * Parse a free-text request into a set of canonical genre names by matching
 * vibe-word synonyms. Returns an array of unique canonical genre names found.
 *
 * Matching is case-insensitive and uses word-boundary checks so "action-packed"
 * doesn't falsely match "action" in "inaction".
 */
export function resolveRequestToGenres(request: string): string[] {
  const lower = request.toLowerCase();
  const found = new Set<string>();

  for (const { terms, genre } of SYNONYM_MAP) {
    for (const term of terms) {
      // Word-boundary match: the term must be preceded and followed by a
      // non-word character (or start/end of string). We use a simple approach:
      // check if the lowercased request contains the term as a whole word.
      const termLower = term.toLowerCase();
      const idx = lower.indexOf(termLower);
      if (idx === -1) continue;

      const before = idx === 0 ? '' : lower[idx - 1];
      // Allow a trailing 's' for plurals (e.g. "thrillers" matches "thriller",
      // "horrors" matches "horror") — an 's' after the term still counts as a
      // word boundary end if the next char after the 's' is non-word or EOL.
      const afterIdx = idx + termLower.length;
      let afterPos = afterIdx;
      if (afterPos < lower.length && lower[afterPos] === 's') afterPos++;
      const after = afterPos >= lower.length ? '' : lower[afterPos];

      const boundaryBefore = before === '' || /[\W_]/.test(before);
      const boundaryAfter = after === '' || /[\W_]/.test(after);
      if (boundaryBefore && boundaryAfter) {
        found.add(genre);
        break; // already matched this entry, move to next
      }
    }
  }

  return [...found];
}

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

/**
 * Ensure the DB contains titles relevant to the given free-text request.
 *
 * This is called from /generate before retrieval. It's a best-effort, non-fatal
 * operation: errors are collected and returned (never thrown), so a TMDB blip
 * can't break /generate.
 *
 * @param db       - SQLite database
 * @param request  - Free-text user request ("scary thrillers", "mind-bending sci-fi")
 * @param mediaType - Optional filter: 'movie'|'tv'. When undefined, both are searched.
 * @param config   - App config (budget limits, api keys, ollama url)
 * @param deps     - Injectable TMDB/embed functions for testing (defaults to real impls)
 */
export async function ensureRequestCoverage(
  db: InstanceType<typeof Database>,
  request: string,
  mediaType: 'movie' | 'tv' | undefined,
  config: Config,
  deps: OnDemandDeps = realDeps,
): Promise<OnDemandResult> {
  const result: OnDemandResult = { added: 0, errors: [] };

  // ── Budget gate ─────────────────────────────────────────────────────────
  const runDay = today();
  const usage = getUsage(db, runDay);
  let remaining = Math.max(0, config.requestLookupDailyBudget - usage.request_added);
  if (remaining === 0) return result;

  // ── Resolve request to genre names ──────────────────────────────────────
  const genreNames = resolveRequestToGenres(request);
  if (genreNames.length === 0) {
    // No genre clues — still run a title search so literal matches land in the DB
  }

  // ── Determine which media types to search ───────────────────────────────
  const mediaTypes: Array<'movie' | 'tv'> =
    mediaType != null ? [mediaType] : ['movie', 'tv'];

  // Collect (tmdbId, mediaType) pairs from all discovery paths, then dedup
  const candidates = new Map<string, { tmdbId: number; mediaType: 'movie' | 'tv' }>();

  const addCandidate = (t: TmdbTitle, mt: 'movie' | 'tv') => {
    const key = `${t.id}:${mt}`;
    if (!candidates.has(key)) candidates.set(key, { tmdbId: t.id, mediaType: mt });
  };

  for (const mt of mediaTypes) {
    // Resolve genre names to ids + keyword terms for this media type
    const { genreIds, keywordTerms } = resolveGenreNames(genreNames, mt);

    // ── Genre-based discovery ────────────────────────────────────────────
    if (genreIds.length > 0) {
      try {
        const titles = await deps.discoverTitles(
          { mediaType: mt, genreIds, sortBy: 'vote_count.desc', voteCountGte: mt === 'movie' ? 100 : 50 },
          config,
        );
        for (const t of titles) addCandidate(t, mt);
      } catch (err) {
        result.errors.push(`discoverTitles(${mt}, genres) failed: ${String(err)}`);
      }
    }

    // ── Keyword-based discovery (TV Horror/Thriller workaround) ──────────
    for (const term of keywordTerms) {
      try {
        const kwId = await resolveKeywordId(term, config, deps);
        if (kwId == null) {
          result.errors.push(`Could not resolve keyword id for "${term}"`);
          continue;
        }
        const titles = await deps.discoverTitles(
          { mediaType: mt, keywordIds: [kwId], sortBy: 'vote_count.desc', voteCountGte: 50 },
          config,
        );
        for (const t of titles) addCandidate(t, mt);
      } catch (err) {
        result.errors.push(`discoverTitles(${mt}, keyword="${term}") failed: ${String(err)}`);
      }
    }

    // ── Literal title search (catches exact name matches) ────────────────
    try {
      const titles = await deps.searchTitles(request, mt, config);
      for (const t of titles) addCandidate(t, mt);
    } catch (err) {
      result.errors.push(`searchTitles(${mt}) failed: ${String(err)}`);
    }
  }

  // ── Ingest new titles up to the remaining budget ─────────────────────────
  for (const [, { tmdbId, mediaType: mt }] of candidates.entries()) {
    if (remaining <= 0) break;

    // Skip titles already in the DB — budget is for new content only
    const existing = getTitleByTmdbId(db, tmdbId, mt);
    if (existing) continue;

    if ((await ingestTitle(db, { tmdbId, mediaType: mt }, config, deps, result.errors)) != null) {
      result.added++;
      remaining--;
    }
  }

  // Persist the request_added counter so subsequent calls and harvest runs know
  // how much of today's budget has been consumed.
  if (result.added > 0) {
    bumpRequestAdded(db, runDay, result.added);
  }

  return result;
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
 * details, embedding and IMDb rating. Best effort and budgeted like
 * ensureRequestCoverage: errors are collected, never thrown.
 *
 * `uiMediaType` is the Films/Series filter chosen in the app; the rules' own
 * media type wins when the request states one. `requestText` is not searched
 * as a title: whole sentences matched unrelated titles, and the references a
 * request names are already in `rules.similarTo`.
 */
export async function ensureRulesCoverage(
  db: InstanceType<typeof Database>,
  rules: RequestRules,
  requestText: string,
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
 * When a user makes a free-text request that resolves to ≥1 canonical genre,
 * those genres are merged into `prefs.loved_genres` so the affinity persists
 * into future passive browsing (retrieval reads `loved_genres` to bias the
 * candidate pool).
 *
 * Merge semantics:
 *   - Existing genres are kept in their current order (oldest first).
 *   - New genres are appended after dedup (case-insensitive comparison).
 *   - If the total exceeds MAX_LOVED_GENRES, the oldest entries are dropped
 *     from the front so the most-recent 12 are kept.
 *   - All other prefs keys (hated_genres, loved_themes, etc.) are untouched.
 *   - The existing taste_vector and refreshed_at are preserved; only `prefs`
 *     is written back, so a vector refresh isn't triggered.
 *   - No-ops when resolveRequestToGenres returns [] (no recognised genre vibe).
 */
export function mergeRequestGenresToProfile(
  db: InstanceType<typeof Database>,
  profileId: number,
  request: string,
): void {
  const genres = resolveRequestToGenres(request);
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
