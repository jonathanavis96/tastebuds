import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import type { Config } from '../config.js';
import type { CandidateTitle, CandidatePool } from '../retrieval/retrieve.js';
import type { ProfileRow, TasteSignatureRow } from '../db/types.js';
import { buildCurationPrompt } from './prompt.js';
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
      const proc: ChildProcess = spawnFn('claude', ['-p', prompt, '--output-format', 'json'], {
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: config.claudeToken },
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
          // claude --output-format json wraps in {type, subtype, result, ...}
          const outer = JSON.parse(stdout) as { result?: string };
          const inner = outer.result ?? stdout;
          // The model's text may wrap the JSON array in markdown fences or prose,
          // and occasionally emit a trailing comma — extract + sanitise robustly.
          const parsed = extractJsonArray(inner) as Array<{
            tmdb_id: number;
            why: string;
            category: string;
            kind?: string;
            predicted_rating?: number;
          }>;
          if (!Array.isArray(parsed)) throw new Error('Expected JSON array from claude');
          const capped = parsed.slice(0, surprise ? 5 : 10);
          resolve(capped.map(item => ({
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

  // Persist as recommendations
  const titleMap = new Map(allCandidates.map(c => [c.tmdb_id, c]));
  for (const result of results) {
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

  return results;
}
