import type { Database } from 'better-sqlite3';
import type { Config } from '../config.js';
import type { CandidateTitle, CandidatePool } from '../retrieval/retrieve.js';
import type { ProfileRow, TasteSignatureRow } from '../db/types.js';
import { buildCurationPrompt, buildRequestPrompt, CURATION_SYSTEM_PROMPT, type RequestPromptInput } from './prompt.js';
import { upsertRecommendation } from '../db/repos/recommendations.js';
import { ClaudeTimeoutError, runClaudeJson, type SpawnFn } from '../claude/runJson.js';

export type { SpawnFn };

export interface CurationResult {
  tmdbId: number;
  why: string;
  category: string;
  kind: 'core' | 'wildcard' | 'adversarial';
  /** Sonnet's predicted star rating (1–5) for this pick; null if it omitted one. */
  predictedRating: number | null;
}

/** Coerce a model-supplied predicted rating to a half-star value in [1,5], or null. */
function normalizePredictedRating(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const snapped = Math.round(n * 2) / 2; // nearest half-star
  return Math.min(5, Math.max(1, snapped));
}

/** Pinned so curation quality/cost does not drift with the account's default model. */
export const CURATION_MODEL = 'claude-sonnet-5';

/**
 * How long one `claude -p` may run. A stalled CLI would otherwise hold /generate,
 * and the caller's rate-limit slot, with no limit at all.
 */
export const CURATION_TIMEOUT_MS = 5 * 60_000;

/** More items than any prompt lists candidates: anything past this was invented. */
const MAX_RESULT_ITEMS = 60;

/**
 * Structured-output schema passed via `--json-schema`. Top level must be an
 * object, so the array lives under `items`. This is what stops a stray `"`
 * inside `why` from producing unparseable JSON (the prod 500 of 2026-09-05).
 */
export const CURATION_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tmdb_id: { type: 'integer' },
          why: { type: 'string' },
          category: { type: 'string' },
          kind: { type: 'string', enum: ['core', 'wildcard', 'adversarial'] },
          predicted_rating: { type: 'number' },
        },
        required: ['tmdb_id', 'why', 'category'],
      },
    },
  },
  required: ['items'],
} as const;

type RawItem = { tmdb_id?: unknown; why?: unknown; category?: unknown; kind?: unknown; predicted_rating?: unknown };

function toResult(item: RawItem): CurationResult {
  return {
    tmdbId: Number(item.tmdb_id),
    why: String(item.why ?? ''),
    category: String(item.category ?? ''),
    kind: item.kind === 'wildcard' || item.kind === 'adversarial' ? item.kind : 'core',
    predictedRating: normalizePredictedRating(item.predicted_rating),
  };
}

/**
 * One curation call through the lean `claude -p` (runClaudeJson), retried once
 * when it fails for any reason but a timeout (retrying a stall only doubles the
 * wait). Rejects when both attempts fail.
 */
async function runCuration(prompt: string, config: Pick<Config, 'claudeToken'>, spawnFn?: SpawnFn): Promise<CurationResult[]> {
  const MAX_ATTEMPTS = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const out = await runClaudeJson<{ items?: unknown }>({
        prompt,
        system: CURATION_SYSTEM_PROMPT,
        model: CURATION_MODEL,
        schema: CURATION_SCHEMA,
        token: config.claudeToken,
        timeoutMs: CURATION_TIMEOUT_MS,
        spawnFn,
      });
      if (!Array.isArray(out.items)) throw new Error('Unusable claude -p output: no items array');
      return (out.items as RawItem[]).slice(0, MAX_RESULT_ITEMS).map(toResult);
    } catch (err) {
      lastErr = err;
      if (err instanceof ClaudeTimeoutError) break;
    }
  }
  throw lastErr;
}

/**
 * Top up `picks` to `min` from the ranked candidate order, skipping anything the
 * model already chose and anything with a tmdb_id it hallucinated. A padded
 * pick carries `why`. Kept separate (and exported) so the guarantee is
 * unit-testable without a spawn.
 */
export function padRequestPicks(
  picks: CurationResult[],
  candidates: CandidateTitle[],
  min: number,
  why: string,
): CurationResult[] {
  const known = new Set(candidates.map(c => c.tmdb_id));
  const kept = picks.filter(p => known.has(p.tmdbId));
  const chosen = new Set(kept.map(p => p.tmdbId));
  const out = [...kept];
  for (const c of candidates) {
    if (out.length >= min) break;
    if (chosen.has(c.tmdb_id)) continue;
    chosen.add(c.tmdb_id);
    out.push({ tmdbId: c.tmdb_id, why, category: 'Based on your request', kind: 'core', predictedRating: null });
  }
  return out;
}

/**
 * TMDB numbers movies and series separately, so a movie and a series can share a
 * tmdb_id. The model answers with the bare id, which could then land the pick on
 * the wrong title, so only the better-ranked of the two is offered. `seen` spans
 * the groups of a pool.
 */
export function withoutTmdbIdClashes(candidates: CandidateTitle[], seen: Set<number> = new Set()): CandidateTitle[] {
  return candidates.filter((c) => {
    if (seen.has(c.tmdb_id)) return false;
    seen.add(c.tmdb_id);
    return true;
  });
}

/**
 * Curate a pool (a call without a request: Generate More, Surprise Me, cold
 * start) via one `claude -p` call, and store the picks as pending
 * recommendations. Surprise Me keeps 5; a call with film vs series open keeps
 * 5 of each where it can; otherwise the top 10.
 */
export async function curateCandidates(
  candidates: CandidatePool,
  profile: ProfileRow,
  sig: TasteSignatureRow,
  request: string | null,
  config: Config,
  db: Database,
  spawnFn?: SpawnFn,
  balanceMedia = false,
  surprise = false,
): Promise<CurationResult[]> {
  const seenTmdbIds = new Set<number>();
  const pool: CandidatePool = {
    onTaste: withoutTmdbIdClashes(candidates.onTaste, seenTmdbIds),
    wildcards: withoutTmdbIdClashes(candidates.wildcards, seenTmdbIds),
    adversarial: withoutTmdbIdClashes(candidates.adversarial, seenTmdbIds),
  };

  const results = await runCuration(buildCurationPrompt(pool, profile, sig, request, balanceMedia, surprise), config, spawnFn);
  const titleMap = new Map([...pool.onTaste, ...pool.wildcards, ...pool.adversarial].map(c => [c.tmdb_id, c]));

  let finalResults: CurationResult[];
  if (surprise) {
    finalResults = results.slice(0, 5);
  } else if (balanceMedia) {
    // Split by media_type, take top 5 of each, backfill the shortfall from the
    // richer side up to 10 total. Ranking within each type is preserved (the LLM
    // already returned results in ranked order).
    const movies = results.filter(r => titleMap.get(r.tmdbId)?.media_type === 'movie');
    const tvShows = results.filter(r => titleMap.get(r.tmdbId)?.media_type === 'tv');
    const moviePrimary = movies.slice(0, 5);
    const tvPrimary = tvShows.slice(0, 5);
    const needed = 10 - moviePrimary.length - tvPrimary.length;
    const backfill = needed > 0
      ? [...movies.slice(5), ...tvShows.slice(5)].slice(0, needed)
      : [];
    finalResults = [...moviePrimary, ...tvPrimary, ...backfill];
  } else {
    finalResults = results.slice(0, 10);
  }

  for (const result of finalResults) {
    const title = titleMap.get(result.tmdbId);
    if (!title) continue;
    upsertRecommendation(db, {
      profile_id: profile.id,
      title_id: title.id,
      category: result.category,
      score: title.score,
      why_blurb: result.why,
      request_text: request,
      state: 'pending',
      kind: result.kind,
      predicted_rating: result.predictedRating,
    });
  }

  return finalResults;
}

/**
 * Ask the model to order a request's candidates and write the "why" lines.
 * Returns its picks in its order, keeping only tmdb_ids it was shown, each
 * once; storing them is the caller's job. Rejects when the call fails.
 * `input.candidates` and `input.older` must not share a tmdb_id (see
 * withoutTmdbIdClashes).
 */
export async function curateRequest(
  input: RequestPromptInput,
  profile: ProfileRow,
  sig: TasteSignatureRow,
  config: Pick<Config, 'claudeToken'>,
  spawnFn?: SpawnFn,
): Promise<CurationResult[]> {
  const results = await runCuration(buildRequestPrompt(input, profile, sig), config, spawnFn);
  const known = new Set([...input.candidates, ...input.older].map(c => c.tmdb_id));
  const seen = new Set<number>();
  const kept = results.filter((r) => {
    if (!known.has(r.tmdbId) || seen.has(r.tmdbId)) return false;
    seen.add(r.tmdbId);
    return true;
  });
  return kept.map(r => ({ ...r, kind: 'core' as const }));
}

/**
 * The final order of a request's picks. Titles from the request's own year
 * window come first and fill the list up to MIN_REQUEST_PICKS; older titles
 * (offered only when the default window had too few) follow, never more than
 * `olderRoom`. Within each group the model's order leads and the ranked
 * candidates pad what it left out, so a failed or short answer still returns
 * every title the rules allow, in rank order.
 */
export function arrangeRequestPicks(
  chosen: CurationResult[],
  groups: { recent: CandidateTitle[]; older: CandidateTitle[]; olderRoom: number },
  padWhy: string,
  size: number,
): { recent: CurationResult[]; older: CurationResult[] } {
  const recentIds = new Set(groups.recent.map(c => c.tmdb_id));
  const olderIds = new Set(groups.older.map(c => c.tmdb_id));
  const recentTarget = Math.min(size, groups.recent.length);
  const olderTarget = Math.min(groups.olderRoom, groups.older.length, Math.max(0, size - recentTarget));
  const recent = padRequestPicks(chosen.filter(p => recentIds.has(p.tmdbId)).slice(0, recentTarget), groups.recent, recentTarget, padWhy);
  const older = padRequestPicks(chosen.filter(p => olderIds.has(p.tmdbId)).slice(0, olderTarget), groups.older, olderTarget, padWhy);
  return { recent, older };
}
