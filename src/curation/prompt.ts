import type { CandidateTitle } from '../retrieval/retrieve.js';
import type { CandidatePool } from '../retrieval/retrieve.js';
import type { ProfileRow, TasteSignatureRow } from '../db/types.js';

function buildPrefsBlock(sig: TasteSignatureRow): string {
  const prefs = JSON.parse(sig.prefs) as Partial<{
    loved_genres: string[];
    hated_genres: string[];
    loved_themes: string[];
    hated_themes: string[];
    preferred_era: string;
    media_weighting: number;
  }>;
  // Defensive: a derived (Joint) profile may have sparse/empty prefs ({}) — never assume arrays exist.
  return [
    `Loved genres: ${(prefs.loved_genres ?? []).join(', ') || 'none specified'}`,
    `Hated genres: ${(prefs.hated_genres ?? []).join(', ') || 'none'}`,
    `Loved themes: ${(prefs.loved_themes ?? []).join(', ') || 'none specified'}`,
    `Hated themes: ${(prefs.hated_themes ?? []).join(', ') || 'none'}`,
    `Preferred era: ${prefs.preferred_era || 'any'}`,
  ].join('\n');
}

function formatCandidate(c: CandidateTitle, i: number): string {
  const genres = JSON.parse(c.genres) as string[];
  const synopsis = (c.synopsis ?? '').slice(0, 100);
  return `${i + 1}. [tmdb_id:${c.tmdb_id}] "${c.title}" (${c.year ?? 'unknown'}) [${genres.join(', ')}] — ${synopsis}`;
}

/**
 * Build a curation prompt.
 *
 * Overload 1 (legacy): accepts a flat CandidateTitle[] — returns the original
 *   10-pick prompt (backwards compatible, used by older callers / tests).
 *
 * Overload 2 (new): accepts a CandidatePool — returns a 7+2+1 structured prompt
 *   that instructs the model to pick exactly 7 on-taste, 2 wildcards, 1 adversarial.
 *
 * balanceMedia: when true, adds an instruction to aim for ~5 movies and ~5 series
 *   across the 10 picks (used when mediaType is not filtered).
 *
 * surprise: when true (only valid with a CandidatePool), returns a 5-item Top-pick-only
 *   prompt using only the ON-TASTE group — no wildcards or adversarial picks at all.
 */
export function buildCurationPrompt(
  candidates: CandidateTitle[] | CandidatePool,
  profile: ProfileRow,
  sig: TasteSignatureRow,
  request: string | null,
  balanceMedia = false,
  surprise = false,
): string {
  const prefsBlock = buildPrefsBlock(sig);
  const requestBlock = request ? `\nUser request: "${request}"\n` : '';

  // ── pool (3-group) overload ────────────────────────────────────────────────
  if (!Array.isArray(candidates)) {
    const pool = candidates as CandidatePool;

    const onTasteList = pool.onTaste
      .slice(0, 20)
      .map((c, i) => formatCandidate(c, i))
      .join('\n');

    // ── Surprise Me mode: 5 Top picks from ON-TASTE only ──────────────────
    if (surprise) {
      return `You are a taste-matching assistant for ${profile.name}. Your job is to select the 5 best on-taste matches from the candidates below.

## Viewer taste profile
${prefsBlock}
${requestBlock}## ON-TASTE candidates (closest to ${profile.name}'s taste vector)
${onTasteList || '(none)'}

## Instructions
Return ONLY a valid JSON array (no markdown, no explanation) of exactly 5 items. Return exactly 5 items, ALL with kind "core" and category "Top pick" — the 5 best on-taste matches for ${profile.name}. Do NOT include any wildcard or adversarial picks.

Each item MUST have exactly these fields:
- "tmdb_id": number (from the candidate list above)
- "why": string (≤120 chars, plain text — do NOT use double-quote (") characters inside it; use single quotes if needed)
- "category": string — must be "Top pick" for all items
- "kind": string — must be "core" for all items

Example output:
[{"tmdb_id":12345,"why":"Matches your love of slow-burn mystery.","category":"Top pick","kind":"core"}]`;
    }

    const wildcardList = pool.wildcards
      .slice(0, 12)
      .map((c, i) => formatCandidate(c, i))
      .join('\n');

    const adversarialList = pool.adversarial
      .slice(0, 8)
      .map((c, i) => formatCandidate(c, i))
      .join('\n');

    const balanceMediaLine = balanceMedia
      ? '\n- Aim for a roughly even split between movies and series — about 5 of each across the 10 picks.'
      : '';

    return `You are a taste-matching assistant for ${profile.name}. Your job is to curate a recommendation set of exactly 10 titles from three labelled groups below.

## Viewer taste profile
${prefsBlock}
${requestBlock}## ON-TASTE candidates (closest to ${profile.name}'s taste vector)
${onTasteList || '(none)'}

## WILDCARD candidates (off-profile, but plausibly interesting)
${wildcardList || '(none)'}

## ADVERSARIAL candidates (furthest from taste vector)
${adversarialList || '(none)'}

## Instructions
Return ONLY a valid JSON array (no markdown, no explanation) of exactly 10 items composed as follows:
- 7 picks from the ON-TASTE group (kind: "core")
- 2 picks from the WILDCARD group (kind: "wildcard") — these are discovery picks ${profile.name} wouldn't normally choose but might enjoy
- 1 pick from the ADVERSARIAL group (kind: "adversarial") — a title you predict ${profile.name} will dislike; in the "why" field briefly explain the mismatch and note that a high rating (3+ on the 5-star scale) means the model should recalibrate${balanceMediaLine}

Each item MUST have exactly these fields:
- "tmdb_id": number (from the candidate list above)
- "why": string (≤120 chars, plain text — do NOT use double-quote (") characters inside it; use single quotes if needed)
- "category": string (one of: "Top pick", "Hidden gem", "Comfort watch", "Surprise pick", "Based on your request")
- "kind": string (one of: "core", "wildcard", "adversarial")

Example output:
[{"tmdb_id":12345,"why":"Matches your love of slow-burn mystery.","category":"Top pick","kind":"core"},{"tmdb_id":67890,"why":"Off-profile sci-fi you might enjoy.","category":"Surprise pick","kind":"wildcard"},{"tmdb_id":11111,"why":"Predicted dislike — heavy gore contradicts hated themes; recalibrate if rated 3+.","category":"Surprise pick","kind":"adversarial"}]`;
  }

  // ── flat array (legacy) overload ───────────────────────────────────────────
  const candidateList = (candidates as CandidateTitle[])
    .slice(0, 30)
    .map((c, i) => formatCandidate(c, i))
    .join('\n');

  const requestInstruction = request
    ? `\n- The viewer specifically requested: "${request}". Prioritise titles that genuinely match this request ABOVE general taste fit. These candidates were pre-filtered for relevance, but if some don't truly fit the request, leave them out — a shorter, on-request list is better than padding to 10 with off-request titles. Use category "Based on your request" for direct matches.`
    : '';

  return `You are a taste-matching assistant for ${profile.name}. Your job is to ${request ? 'pick the titles that best satisfy the viewer\'s request, ordered best-first' : 'rank the following candidate titles by how well they match this viewer\'s taste profile'}.

## Viewer taste profile
${prefsBlock}
${requestBlock}## Candidate titles
${candidateList}

## Instructions
Return ONLY a valid JSON array (no markdown, no explanation) of your top picks ranked best-first, maximum 10 items.${requestInstruction}
Each item MUST have exactly these fields:
- "tmdb_id": number (from the candidate list above)
- "why": string (≤120 chars, plain text — do NOT use double-quote (") characters inside it; use single quotes if needed)
- "category": string (one of: "Top pick", "Hidden gem", "Comfort watch", "Surprise pick", "Based on your request")

Example output:
[{"tmdb_id":12345,"why":"Matches your love of slow-burn mystery with strong female leads.","category":"Top pick"}]`;
}
