/**
 * Blend two vectors as a weighted mean.
 * w1 and w2 are weights (do not need to sum to 1 — they are normalised internally).
 */
export function blendVectors(v1: number[], w1: number, v2: number[], w2: number): number[] {
  const total = w1 + w2;
  return v1.map((val, i) => (val * w1 + v2[i] * w2) / total);
}
