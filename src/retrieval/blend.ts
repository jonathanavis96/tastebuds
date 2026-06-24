/** L2-normalise a vector to unit length. A zero-length vector is returned as-is. */
function unit(v: number[]): number[] {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return v.slice();
  return v.map((x) => x / norm);
}

/**
 * Blend two vectors as a weighted mean of their UNIT-NORMALISED directions.
 *
 * Each input is normalised to unit length BEFORE weighting, so the weights
 * (w1, w2) control each input's directional contribution regardless of its raw
 * magnitude. This matters because a taste vector (a Rocchio mean of many
 * embeddings) and a single request embedding can have very different magnitudes;
 * without normalising, the larger-magnitude input dominates even when given the
 * smaller weight — e.g. REQUEST_WEIGHT=0.7 would fail to actually make the
 * request dominate retrieval. Cosine distance on the result ignores the result's
 * own magnitude, so we don't renormalise the output.
 *
 * w1 and w2 are weights (need not sum to 1 — normalised internally).
 */
export function blendVectors(v1: number[], w1: number, v2: number[], w2: number): number[] {
  const total = w1 + w2;
  const n1 = unit(v1);
  const n2 = unit(v2);
  return n1.map((val, i) => (val * w1 + n2[i] * w2) / total);
}
