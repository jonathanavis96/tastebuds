import type Database from 'better-sqlite3';
import { getTasteSignature, upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import { getTitleById } from '../db/repos/titles.js';

/**
 * Dismiss-reason tile keys, in tile display order: not my genre · too
 * dark/violent · seen enough like it · cast/vibe · not in the mood.
 */
export type DismissReason =
  | 'not_my_genre'
  | 'too_dark'
  | 'seen_enough'
  | 'cast_vibe'
  | 'not_in_mood';

export interface DismissReasonTile {
  key: DismissReason;
  label: string;
}

/** The ≤5 tiles shown after a dismiss, in display order. */
export const DISMISS_REASON_TILES: DismissReasonTile[] = [
  { key: 'not_my_genre', label: 'Not my genre' },
  { key: 'too_dark', label: 'Too dark/violent' },
  { key: 'seen_enough', label: 'Seen enough like it' },
  { key: 'cast_vibe', label: 'Cast/vibe' },
  { key: 'not_in_mood', label: 'Not in the mood' },
];

/** Fixed theme tag written to hated_themes for the "too dark/violent" reason (titles have no per-item theme field to derive from). */
const DARK_VIOLENT_THEME = 'dark/violent';

/** Cap on hated_genres / hated_themes entries, matching mergeRequestGenresToProfile's MAX_LOVED_GENRES convention. */
const MAX_HATED_ENTRIES = 12;

/**
 * Merge `additions` into `existing`, deduped case-insensitively, existing
 * entries kept in order and new ones appended, then capped by dropping the
 * oldest from the front. Mirrors mergeRequestGenresToProfile's merge semantics
 * (src/harvest/onDemand.ts) so loved_genres and hated_genres/hated_themes grow
 * the same way.
 */
function mergeCapped(existing: string[], additions: string[], cap: number): string[] {
  const seen = new Set(existing.map((g) => g.toLowerCase()));
  const merged = [...existing];
  for (const a of additions) {
    if (!seen.has(a.toLowerCase())) {
      seen.add(a.toLowerCase());
      merged.push(a);
    }
  }
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/**
 * Persist a chosen dismiss-reason tile into the profile's taste signature prefs —
 * the "learning loop" write-back that lets a dismissed rec steer future picks.
 *
 * Mapping:
 *   - 'not_my_genre'  → merge the dismissed title's genres into prefs.hated_genres.
 *   - 'seen_enough'   → same field — over-saturation of a genre reads the same
 *                       way to retrieval's hated-genre veto as an outright dislike.
 *   - 'too_dark'      → merge the fixed 'dark/violent' tag into prefs.hated_themes.
 *   - 'cast_vibe' / 'not_in_mood' → no write-back (title-specific / mood-specific,
 *                       not a durable taste signal — neither is a genre/theme
 *                       derivable from the title).
 *
 * Other prefs keys, taste_vector and refreshed_at are left untouched (a prefs-only
 * write must not look like a fresh vector refresh to callers reading refreshed_at).
 * No-ops silently if the title can't be found or has no genres — dismissing is
 * never blocked by a failed write-back (callers should treat this as non-fatal).
 */
export function applyDismissReasonToPrefs(
  db: InstanceType<typeof Database>,
  profileId: number,
  titleId: number,
  reason: DismissReason,
): void {
  if (reason === 'cast_vibe' || reason === 'not_in_mood') return;

  const existing = getTasteSignature(db, profileId);
  let prefs: Record<string, unknown> = {};
  try {
    prefs = existing ? (JSON.parse(existing.prefs || '{}') as Record<string, unknown>) : {};
  } catch {
    prefs = {};
  }

  const prefsKey = reason === 'too_dark' ? 'hated_themes' : 'hated_genres';
  const additions =
    reason === 'too_dark' ? [DARK_VIOLENT_THEME] : genresForTitle(db, titleId);
  if (additions.length === 0) return;

  const current: string[] = Array.isArray(prefs[prefsKey]) ? (prefs[prefsKey] as string[]) : [];
  const merged = mergeCapped(current, additions, MAX_HATED_ENTRIES);

  upsertTasteSignature(db, {
    profile_id: profileId,
    taste_vector: existing?.taste_vector ?? null,
    prefs: JSON.stringify({ ...prefs, [prefsKey]: merged }),
    refreshed_at: existing?.refreshed_at ?? new Date().toISOString(),
  });
}

/**
 * Reverse a previously-applied `applyDismissReasonToPrefs` write-back — called on
 * undismiss so a negative signal doesn't outlive the dismissal it came from.
 * Best-effort and title-scoped: it removes only the entries THIS dismissal would
 * have added (the title's genres, or the fixed dark/violent theme), not the
 * whole hated_genres/hated_themes list. It does not track provenance, so if
 * another dismissal independently added the same genre, that entry is removed
 * here too — undoing one dismissal can drop a genre another dismissal still
 * justifies. Acceptable for this best-effort cleanup; a no-op if the prefs
 * don't currently contain anything to remove.
 */
export function removeDismissReasonFromPrefs(
  db: InstanceType<typeof Database>,
  profileId: number,
  titleId: number,
  reason: DismissReason,
): void {
  if (reason === 'cast_vibe' || reason === 'not_in_mood') return;

  const existing = getTasteSignature(db, profileId);
  if (!existing) return;
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(existing.prefs || '{}') as Record<string, unknown>;
  } catch {
    return;
  }

  const prefsKey = reason === 'too_dark' ? 'hated_themes' : 'hated_genres';
  const toRemove = reason === 'too_dark' ? [DARK_VIOLENT_THEME] : genresForTitle(db, titleId);
  if (toRemove.length === 0) return;

  const current: string[] = Array.isArray(prefs[prefsKey]) ? (prefs[prefsKey] as string[]) : [];
  if (current.length === 0) return;
  const removeSet = new Set(toRemove.map((g) => g.toLowerCase()));
  const filtered = current.filter((g) => !removeSet.has(g.toLowerCase()));
  if (filtered.length === current.length) return; // nothing of this dismissal's was present

  upsertTasteSignature(db, {
    profile_id: profileId,
    taste_vector: existing.taste_vector,
    prefs: JSON.stringify({ ...prefs, [prefsKey]: filtered }),
    refreshed_at: existing.refreshed_at,
  });
}

/** The dismissed title's genres (JSON array string on titles.genres), or []. */
function genresForTitle(db: InstanceType<typeof Database>, titleId: number): string[] {
  const title = getTitleById(db, titleId);
  if (!title) return [];
  try {
    const genres = JSON.parse(title.genres || '[]') as unknown;
    return Array.isArray(genres) ? genres.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}
