import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import type { Config } from '../config.js';
import type { CandidateTitle, CandidatePool } from '../retrieval/retrieve.js';
import type { ProfileRow, TasteSignatureRow } from '../db/types.js';
import { buildCurationPrompt, FLAT_CANDIDATE_CAP, MIN_REQUEST_PICKS } from './prompt.js';
import { upsertRecommendation } from '../db/repos/recommendations.js';

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

export type SpawnFn = typeof nodeSpawn;

/** Pinned so curation quality/cost does not drift with the account's default model. */
export const CURATION_MODEL = 'claude-sonnet-5';

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

/**
 * Robustly extract a JSON array from an LLM text response that may wrap it in
 * markdown fences (```json ... ```), surround it with prose, or include a
 * trailing comma. Throws if no parseable array is found.
 */
export function extractJsonArray(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start !== -1 && end > start) t = t.slice(start, end + 1);
  t = t.replace(/,(\s*[\]}])/g, '$1'); // strip trailing commas
  return JSON.parse(t);
}

/**
 * Top up a request's picks to `min` from the reranked candidate order, skipping
 * anything the model already chose and anything with a tmdb_id it hallucinated.
 * Kept separate (and exported) so the guarantee is unit-testable without a spawn.
 */
export function padRequestPicks(
  picks: CurationResult[],
  candidates: CandidateTitle[],
  min: number,
): CurationResult[] {
  const known = new Set(candidates.map(c => c.tmdb_id));
  const kept = picks.filter(p => known.has(p.tmdbId));
  const chosen = new Set(kept.map(p => p.tmdbId));
  const out = [...kept];
  for (const c of candidates) {
    if (out.length >= min) break;
    if (chosen.has(c.tmdb_id)) continue;
    chosen.add(c.tmdb_id);
    out.push({
      tmdbId: c.tmdb_id,
      why: 'Strong match for your request by rating and taste fit.',
      category: 'Based on your request',
      kind: 'core',
      predictedRating: null,
    });
  }
  return out;
}

/**
 * Curate candidates via the claude -p subprocess.
 *
 * Accepts either:
 *   - CandidateTitle[]  — legacy flat list (backwards compatible)
 *   - CandidatePool     — new 3-group pool (7+2+1 composition)
 */
export async function curateCandidates(
  candidates: CandidateTitle[] | CandidatePool,
  profile: ProfileRow,
  sig: TasteSignatureRow,
  request: string | null,
  config: Config,
  db: Database,
  spawnFn: SpawnFn = nodeSpawn,
  balanceMedia = false,
  surprise = false,
): Promise<CurationResult[]> {
  const prompt = buildCurationPrompt(candidates, profile, sig, request, balanceMedia, surprise);

  // Flatten pool → map for tmdb_id lookup
  const allCandidates: CandidateTitle[] = Array.isArray(candidates)
    ? (candidates as CandidateTitle[])
    : [
        ...(candidates as CandidatePool).onTaste,
        ...(candidates as CandidatePool).wildcards,
        ...(candidates as CandidatePool).adversarial,
      ];

  // One claude -p call → parsed CurationResult[]. Rejects on spawn/exit/parse failure.
  const runOnce = (): Promise<CurationResult[]> =>
    new Promise<CurationResult[]>((resolve, reject) => {
      const proc: ChildProcess = spawnFn('claude', [
        '-p', prompt,
        '--model', CURATION_MODEL,
        '--output-format', 'json',
        '--json-schema', JSON.stringify(CURATION_SCHEMA),
      ], {
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: config.claudeToken },
        // Ignore stdin: the prompt is passed as an arg, so claude has no stdin to read.
        // Without this it warns and blocks ~3s ("no stdin data received in 3s") on every call.
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`claude -p exited with code ${code}: ${stderr}`));
          return;
        }
        try {
          // claude --output-format json wraps in {type, subtype, result, ...}.
          // With --json-schema the CLI also returns `structured_output`, already
          // parsed and quote-safe — prefer it. Fall back to the text path for
          // older CLIs (or tests) that only provide `result`.
          const outer = JSON.parse(stdout) as { result?: string; structured_output?: { items?: unknown } };
          type RawItem = {
            tmdb_id: number;
            why: string;
            category: string;
            kind?: string;
            predicted_rating?: number;
          };
          let parsed: RawItem[];
          if (outer.structured_output && Array.isArray(outer.structured_output.items)) {
            parsed = outer.structured_output.items as RawItem[];
          } else {
            const inner = outer.result ?? stdout;
            // The model's text may wrap the JSON array in markdown fences or prose,
            // and occasionally emit a trailing comma — extract + sanitise robustly.
            parsed = extractJsonArray(inner) as RawItem[];
          }
          if (!Array.isArray(parsed)) throw new Error('Expected JSON array from claude');
          // No cap here — balance/surprise cap is applied in the outer scope after
          // media_type lookup via titleMap. Guard against runaway LLM responses (more
          // candidates than FLAT_CANDIDATE_CAP were never sent, so extra picks are hallucinated).
          resolve(parsed.slice(0, FLAT_CANDIDATE_CAP).map(item => ({
            tmdbId: item.tmdb_id,
            why: item.why,
            category: item.category,
            kind: (item.kind === 'wildcard' || item.kind === 'adversarial') ? item.kind : 'core',
            predictedRating: normalizePredictedRating(item.predicted_rating),
          })));
        } catch (err) {
          reject(new Error(`Failed to parse claude -p output: ${(err as Error).message}\nOutput: ${stdout.slice(0, 200)}`));
        }
      });

      proc.on('error', (err: Error) => reject(new Error(`Failed to spawn claude: ${err.message}`)));
    });

  // The model occasionally emits unparseable JSON (unescaped quotes etc.) — retry once before failing.
  const MAX_ATTEMPTS = 2;
  let results: CurationResult[] | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      results = await runOnce();
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!results) throw lastErr;

  // Apply surprise / balance / plain cap before persisting.
  // titleMap is needed for media_type lookup so this block sits here (not inside runOnce).
  const titleMap = new Map(allCandidates.map(c => [c.tmdb_id, c]));

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

  // A free-text request must come back with at least MIN_REQUEST_PICKS titles
  // whenever the (already filtered + reranked) flat list allows it. If the model
  // still under-delivers, pad from the retrieval order — DB-only, no second
  // claude -p call — so the user never sees "2 options" again.
  if (request && Array.isArray(candidates) && !surprise) {
    finalResults = padRequestPicks(finalResults, candidates as CandidateTitle[], MIN_REQUEST_PICKS);
  }

  // Persist as recommendations
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
