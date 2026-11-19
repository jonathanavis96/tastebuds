import { parsePrefs } from '../retrieval/prefs.js';
import type { CandidateTitle, CandidatePool } from '../retrieval/retrieve.js';
import type { ProfileRow, TasteSignatureRow } from '../db/types.js';
import { titleTags } from '../request/tags.js';

/** A request comes back with this many picks when enough titles satisfy it. */
export const MIN_REQUEST_PICKS = 10;

/** Replaces the CLI's default system prompt on every curation call. */
export const CURATION_SYSTEM_PROMPT =
  'You choose and order film and TV recommendations from the candidates given, and answer only with JSON matching the given schema.';

function buildPrefsBlock(sig: TasteSignatureRow): string {
  const prefs = parsePrefs(sig.prefs);
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
 * Build the curation prompt for a call without a request: a 7+2+1 structured
 * prompt that instructs the model to pick exactly 7 on-taste, 2 wildcards and
 * 1 adversarial title from the pool.
 *
 * balanceMedia: when true, adds an instruction to aim for ~5 movies and ~5 series
 *   across the 10 picks (used when mediaType is not filtered).
 *
 * surprise: when true, returns a 5-item Top-pick-only
 *   prompt using only the ON-TASTE group — no wildcards or adversarial picks at all.
 */
export function buildCurationPrompt(
  pool: CandidatePool,
  profile: ProfileRow,
  sig: TasteSignatureRow,
  request: string | null,
  balanceMedia = false,
  surprise = false,
): string {
  const prefsBlock = buildPrefsBlock(sig);
  const requestBlock = request ? `\nUser request: "${request}"\n` : '';

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
Return ONLY a JSON object of the form {"items":[...]} where "items" is a JSON array of exactly 5 items. Return exactly 5 items, ALL with kind "core" and category "Top pick" — the 5 best on-taste matches for ${profile.name}. Do NOT include any wildcard or adversarial picks.

Each item MUST have exactly these fields:
- "tmdb_id": number (from the candidate list above)
- "why": string (≤120 chars, plain text — do NOT use double-quote (") characters inside it; use single quotes if needed)
- "category": string — must be "Top pick" for all items
- "kind": string — must be "core" for all items

Example output:
{"items":[{"tmdb_id":12345,"why":"Matches your love of slow-burn mystery.","category":"Top pick","kind":"core"}]}`;
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
Return ONLY a JSON object of the form {"items":[...]} where "items" is a JSON array of exactly 10 items composed as follows:
- 7 picks from the ON-TASTE group (kind: "core")
- 2 picks from the WILDCARD group (kind: "wildcard") — these are discovery picks ${profile.name} wouldn't normally choose but might enjoy
- 1 pick from the ADVERSARIAL group (kind: "adversarial") — a title you predict ${profile.name} will dislike; in the "why" field briefly explain the mismatch and note that a high rating (3+ on the 5-star scale) means the model should recalibrate${balanceMediaLine}

Each item MUST have exactly these fields:
- "tmdb_id": number (from the candidate list above)
- "why": string (≤120 chars, plain text — do NOT use double-quote (") characters inside it; use single quotes if needed)
- "category": string (one of: "Top pick", "Hidden gem", "Comfort watch", "Surprise pick", "Based on your request")
- "kind": string (one of: "core", "wildcard", "adversarial")
- "predicted_rating": number — your honest prediction of the star rating (1–5, halves allowed e.g. 4.5) ${profile.name} will give this title after watching. Core picks should generally be high (4–5), the adversarial pick low (1–2.5). Be calibrated, not optimistic — this is checked against their real ratings.

Example output:
{"items":[{"tmdb_id":12345,"why":"Matches your love of slow-burn mystery.","category":"Top pick","kind":"core","predicted_rating":4.5},{"tmdb_id":67890,"why":"Off-profile sci-fi you might enjoy.","category":"Surprise pick","kind":"wildcard","predicted_rating":3.5},{"tmdb_id":11111,"why":"Predicted dislike — heavy gore contradicts hated themes; recalibrate if rated 3+.","category":"Surprise pick","kind":"adversarial","predicted_rating":2}]}`;
}

/** What the request prompt shows of one candidate: its canonical genres and IMDb rating beside the usual line. */
function formatRequestCandidate(c: CandidateTitle, i: number): string {
  const kind = c.media_type === 'tv' ? 'series' : 'film';
  const tags = [...titleTags(c)].join(', ') || 'no genre';
  const synopsis = (c.synopsis ?? '').slice(0, 100);
  return `${i + 1}. [tmdb_id:${c.tmdb_id}] "${c.title}" (${c.year ?? 'unknown'}, ${kind}) [${tags}] IMDb ${c.imdb_rating ?? 'none'} — ${synopsis}`;
}

export interface RequestPromptInput {
  /** The request as typed. */
  text: string;
  /** describeRules of the rules every candidate satisfies. */
  understood: string[];
  /** Candidates inside the request's year window, best ranked first. */
  candidates: CandidateTitle[];
  /** Older candidates offered only to fill the list (default window widened), and how many of them may be used. */
  older: CandidateTitle[];
  olderRoom: number;
  /** True when the request leaves film vs series open. */
  mediaOpen: boolean;
}

/**
 * The prompt for a typed request. Every candidate already satisfies the
 * request's rules (checked in code), so the model only orders them and writes
 * the "why" lines: it cannot add a title, and it is not asked to judge whether
 * one fits.
 */
export function buildRequestPrompt(input: RequestPromptInput, profile: ProfileRow, sig: TasteSignatureRow): string {
  const olderUsed = Math.min(input.olderRoom, input.older.length);
  const count = Math.min(MIN_REQUEST_PICKS, input.candidates.length + olderUsed);
  const rules = input.understood.map((u) => `- ${u}`).join('\n') || '- (no rules beyond the request itself)';
  const list = input.candidates.map(formatRequestCandidate).join('\n');
  const olderBlock = olderUsed > 0
    ? `\n\n## Older candidates (too few recent titles matched; use at most ${olderUsed} of these, after the ones above)\n${input.older.map((c, i) => formatRequestCandidate(c, input.candidates.length + i)).join('\n')}`
    : '';
  const mediaLine = input.mediaOpen ? '\n- The request leaves film or series open: include both when both fit it well.' : '';

  return `${profile.name} asked for: "${input.text}"

Every candidate below already satisfies all of the request's rules, which were checked title by title:
${rules}
Do not judge whether a candidate fits those rules. Your job is to choose the ${count} best of them for this request and this viewer, best first, and to say in one line why each one suits.

## Viewer taste profile
${buildPrefsBlock(sig)}

## Candidates (ranked by closeness to the request and to ${profile.name}'s taste)
${list || '(none)'}${olderBlock}

## Instructions
Return ONLY a JSON object of the form {"items":[...]} where "items" holds exactly ${count} candidates, best first, each from the lists above and none twice.${mediaLine}
Each item MUST have exactly these fields:
- "tmdb_id": number (from the lists above)
- "why": string (≤120 chars, plain text — do NOT use double-quote (") characters inside it; use single quotes if needed)
- "category": string (one of: "Based on your request", "Top pick", "Hidden gem", "Comfort watch")
- "predicted_rating": number — your honest prediction of the star rating (1–5, halves allowed) ${profile.name} will give this title after watching. Be calibrated, not optimistic.

Example output:
{"items":[{"tmdb_id":12345,"why":"A tense cat-and-mouse thriller in the vein of the ones you rated highest.","category":"Based on your request","predicted_rating":4}]}`;
}
