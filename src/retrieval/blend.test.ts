import { describe, it, expect } from 'vitest';
import { blendVectors } from './blend.js';

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe('blendVectors', () => {
  it('is invariant to input magnitude (normalises each input before weighting)', () => {
    const taste = [3, 4]; // |taste| = 5
    const tasteScaled = [30, 40]; // same direction, |.| = 50
    const req = [0, 1];
    const a = blendVectors(taste, 0.3, req, 0.7);
    const b = blendVectors(tasteScaled, 0.3, req, 0.7);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 10);
  });

  it('lets the higher-weighted input dominate regardless of raw magnitude', () => {
    // taste has huge magnitude but a small weight; the request has a small
    // magnitude but the dominant weight — the blend must lean toward the request.
    const taste = [1000, 0];
    const req = [0, 1];
    const blended = blendVectors(taste, 0.3, req, 0.7);
    expect(cosine(blended, req)).toBeGreaterThan(cosine(blended, taste));
  });

  it('averages the two unit directions under equal weights', () => {
    const v1 = [2, 0]; // unit dir [1, 0]
    const v2 = [0, 5]; // unit dir [0, 1]
    const blended = blendVectors(v1, 0.5, v2, 0.5);
    expect(blended[0]).toBeCloseTo(0.5, 10);
    expect(blended[1]).toBeCloseTo(0.5, 10);
  });

  it('handles a zero-length input without producing NaN', () => {
    const blended = blendVectors([0, 0], 0.5, [3, 4], 0.5);
    expect(blended.every((x) => Number.isFinite(x))).toBe(true);
  });
});
