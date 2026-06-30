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
import type { TmdbTitle, TmdbTitleDetail } from '../tmdb/types.js';
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
import { resolveGenreNames } from '../tmdb/taxonomy.js';
import { getTasteSignature, upsertTasteSignature } from '../db/repos/tasteSignatures.js';

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
}

const realDeps: OnDemandDeps = {
  discoverTitles,
  getTitleDetails,
  searchTitles,
  searchKeyword,
  embedText,
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
    const existing = getTitleByTmdbId(db, tmdbId);
    if (existing) continue;

    try {
      const detail = await deps.getTitleDetails(tmdbId, mt, config);
      const mapped = mapTmdbToTitleRow(detail, mt);

      const embedInput = `${mapped.title} ${mapped.synopsis ?? ''}`.slice(0, 500);
      let embedding: Buffer | null = null;

      try {
        const vec = await deps.embedText(embedInput, config);
        embedding = Buffer.from(new Float32Array(vec).buffer);
      } catch (embedErr) {
        result.errors.push(`embed failed for ${mapped.title}: ${String(embedErr)}`);
      }

      upsertTitle(db, { ...mapped, embedding });
      result.added++;
      remaining--;
    } catch (err) {
      result.errors.push(`Failed to process tmdb_id=${tmdbId} (${mt}): ${String(err)}`);
    }
  }

  // Persist the request_added counter so subsequent calls and harvest runs know
  // how much of today's budget has been consumed.
  if (result.added > 0) {
    bumpRequestAdded(db, runDay, result.added);
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
