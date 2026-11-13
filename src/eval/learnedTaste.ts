/**
 * Learned taste weights: one weight per genre and per TMDB keyword, fitted to a
 * profile's own star ratings and "Not interested" dismissals by ridge regression.
 *
 * Today's genre affinity averages ratings per genre on its own, so a title's
 * keywords ("slow burn", "found footage", "time loop") never count and genres
 * that usually come together (Crime + Thriller) are judged separately. Fitting
 * all features together lets each one take only the credit it earns, and the
 * ridge penalty keeps a feature seen once or twice near zero.
 *
 * Pure maths over rows already in memory: no database, no network, no model call.
 */

export interface LearnSample {
  title: { genres: string[]; keywords: string[] };
  /** Star rating, or null for a dismissal. */
  rating: number | null;
}

export interface LearnedWeights {
  /** Taste in [-1, 1] for a title (same scale as genre affinity). */
  predict(title: { genres: string[]; keywords: string[] }): number;
  /** The fitted weight per feature, in stars relative to the profile's mean. */
  weights: Map<string, number>;
  mean: number;
}

/** A keyword must appear on this many of the profile's titles to get its own weight. */
const MIN_KEYWORD_COUNT = 3;
/** Ridge penalty: how many "average" observations a weight needs before it moves freely. */
const RIDGE_LAMBDA = 3;
/** A dismissal counts as this rating ("not for me", a touch above a flat 2★). */
const DISMISS_AS_RATING = 2.5;
/** At least this many samples before weights are fitted; fewer returns a flat model. */
const MIN_SAMPLES = 8;

const genreKey = (g: string) => `g:${g}`;
const keywordKey = (k: string) => `k:${k.toLowerCase()}`;

function featuresOf(title: { genres: string[]; keywords: string[] }, vocab: Map<string, number>): number[] {
  const idx = new Set<number>();
  for (const g of title.genres) { const i = vocab.get(genreKey(g)); if (i != null) idx.add(i); }
  for (const k of title.keywords) { const i = vocab.get(keywordKey(k)); if (i != null) idx.add(i); }
  return [...idx];
}

export function learnTasteWeights(samples: LearnSample[]): LearnedWeights {
  const ys = samples.map(s => s.rating ?? DISMISS_AS_RATING);
  const mean = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
  const flat: LearnedWeights = { predict: () => 0, weights: new Map(), mean };
  if (samples.length < MIN_SAMPLES) return flat;

  const counts = new Map<string, number>();
  for (const s of samples) {
    const keys = new Set([...s.title.genres.map(genreKey), ...s.title.keywords.map(keywordKey)]);
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const vocab = new Map<string, number>();
  for (const [k, n] of counts) {
    if (k.startsWith('g:') || n >= MIN_KEYWORD_COUNT) vocab.set(k, vocab.size);
  }
  const d = vocab.size;
  if (d === 0) return flat;

  // Normal equations (XᵀX + λI) w = Xᵀy with each row scaled by 1/√(features on the row),
  // so a title with 30 keywords does not outvote one with 3.
  const A = Array.from({ length: d }, () => new Float64Array(d));
  const b = new Float64Array(d);
  samples.forEach((s, r) => {
    const f = featuresOf(s.title, vocab);
    if (f.length === 0) return;
    const x = 1 / Math.sqrt(f.length);
    const y = ys[r] - mean;
    for (const i of f) {
      b[i] += x * y;
      for (const j of f) A[i][j] += x * x;
    }
  });
  for (let i = 0; i < d; i++) A[i][i] += RIDGE_LAMBDA;
  const w = solveSymmetric(A, b);

  const weights = new Map<string, number>();
  for (const [k, i] of vocab) weights.set(k, w[i]);
  return {
    mean,
    weights,
    predict(title) {
      const f = featuresOf(title, vocab);
      if (f.length === 0) return 0;
      const x = 1 / Math.sqrt(f.length);
      let y = 0;
      for (const i of f) y += x * w[i];
      // ±2 stars from the mean maps to ±1, the genre-affinity scale.
      return Math.max(-1, Math.min(1, y / 2));
    },
  };
}

/** Cholesky solve of a symmetric positive-definite system (A is overwritten). */
function solveSymmetric(A: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length;
  for (let j = 0; j < n; j++) {
    let s = A[j][j];
    for (let k = 0; k < j; k++) s -= A[j][k] * A[j][k];
    const ljj = Math.sqrt(Math.max(s, 1e-12));
    A[j][j] = ljj;
    for (let i = j + 1; i < n; i++) {
      let t = A[i][j];
      for (let k = 0; k < j; k++) t -= A[i][k] * A[j][k];
      A[i][j] = t / ljj;
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= A[i][k] * y[k];
    y[i] = s / A[i][i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= A[k][i] * x[k];
    x[i] = s / A[i][i];
  }
  return x;
}
