import type { RecKind, Recommendation } from './types.js';

/**
 * Two orthogonal labels describe a recommendation:
 *   - `kind` (core | wildcard | adversarial) — the STRUCTURAL role from the 7+2+1
 *     composition. Reliable, set by retrieval. This drives the badge.
 *   - `category` — a soft FLAVOUR label the model writes (Top pick / Hidden gem /
 *     Comfort watch / Surprise pick / Based on your request). Shown as a subtle chip.
 *
 * We badge primarily off `kind` so the adversarial pick is never mistaken for an
 * ordinary "Surprise pick".
 */

export interface KindMeta {
  /** Friendly badge label shown on the card. */
  label: string;
  icon: string;
  /** CSS accent colour for the badge + modal highlight. */
  color: string;
  /** Text colour that reads well on top of `color`. */
  text: string;
  /** One-line explanation for the modal + legend. */
  blurb: string;
}

export const KIND_META: Record<RecKind, KindMeta> = {
  // Semantic traffic-light: green = we think you'll like it, yellow = a surprise,
  // red = we predict you won't.
  core: {
    label: 'Top pick',
    icon: '★',
    color: '#3ecf8e', // green = good
    text: '#06281a',
    blurb: 'A strong match for your taste — the bread-and-butter of your picks.',
  },
  wildcard: {
    label: 'Surprise pick',
    icon: '🎲',
    color: '#f5c518', // yellow
    text: '#1a1500',
    blurb: "Off your usual path on purpose — a discovery you wouldn't normally choose but might love.",
  },
  adversarial: {
    label: 'Not your thing',
    icon: '👎',
    color: '#e94560', // red
    text: '#ffffff',
    blurb: "We actually predict you'll skip this one. Rate it 3★ or higher and you've taught the model something — it recalibrates.",
  },
};

/** Soft flavour labels the model assigns. Used for the legend explainer. */
export const CATEGORY_BLURBS: Record<string, string> = {
  'Top pick': 'Closest match to your taste right now.',
  'Hidden gem': "Lesser-known, but right up your alley.",
  'Comfort watch': 'Easy, familiar, low-risk — a safe night in.',
  'Surprise pick': 'An off-profile discovery (a wildcard 🎲).',
  'Based on your request': 'Chosen to match what you typed in the request box.',
};

export function kindOf(rec: Pick<Recommendation, 'kind'>): RecKind {
  return rec.kind ?? 'core';
}

export function kindMeta(rec: Pick<Recommendation, 'kind'>): KindMeta {
  return KIND_META[kindOf(rec)];
}

/** Parse a JSON-string column (genres / cast) into a string[] safely. */
export function parseList(raw: string | null | undefined, limit = 999): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(String).slice(0, limit);
  } catch {
    /* not JSON — ignore */
  }
  return [];
}
