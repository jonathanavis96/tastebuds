import type Database from 'better-sqlite3';
import { getTasteSignature } from '../db/repos/tasteSignatures.js';
import { parsePrefs, type PrefsJson } from './prefs.js';
import type { CandidateTitle } from './retrieve.js';

/** Per-genre taste in [-1, 1]: +1 loves it, −1 hates it, 0 / absent = no signal. */
export type GenreAffinity = Record<string, number>;

/** A genre at or below this affinity is vetoed (solo, and for Joint see jointGenreAffinity). */
export const GENRE_VETO_THRESHOLD = -0.35;

/** Ratings a genre needs before its affinity is fully trusted (Bayesian shrinkage). */
const AFFINITY_SHRINK_K = 3;
/** Stated loved_genres prefs contribute this much when no ratings exist for the genre. */
const LOVED_PREF_AFFINITY = 0.4;

/** Mirrors the taste-vector blend: what the couple rated together dominates; the rest is split between the partners. */
const JOINT_OWN_WEIGHT = 0.65;

export interface RerankWeights {
  similarity: number;
  affinity: number;
  quality: number;
  popularity: number;
}

/**
 * Cosine similarity still leads (it carries the request and the free-text notes),
 * but genre affinity from the actual star ratings is a close second so that voting
 * visibly moves what comes out. Quality and popularity are tie-breakers that keep
 * well-known, well-rated titles ahead of obscure ones at equal taste fit.
 */
export const DEFAULT_RERANK_WEIGHTS: RerankWeights = {
  similarity: 0.40,
  affinity: 0.30,
  quality: 0.20,
  popularity: 0.10,
};

/** Prior mean and vote mass for the Bayesian quality estimate. */
const QUALITY_PRIOR_MEAN = 6.5;
const QUALITY_PRIOR_VOTES = { movie: 300, tv: 50 } as const;
/** Popularity saturates here (TMDB popularity of a current mainstream hit is ~50–200). */
const POPULARITY_SATURATION = 500;

interface RatedGenreRow {
  genres: string;
  rating: number;
}

/**
 * Genre affinity learned from a profile's own star ratings. For each genre:
 * (mean rating of titles in that genre − the profile's overall mean) shrunk by
 * n/(n+K) so one 5★ western doesn't declare a lifelong love of westerns, then
 * scaled from the ±2-star range to ±1. Stated prefs fill in genres with no ratings
 * (hated → −1 always, so a "not my genre" tile is a real veto).
 */
export function genreAffinityForProfile(
  db: InstanceType<typeof Database>,
  profileId: number,
): GenreAffinity {
  const rows = db.prepare(`
    SELECT t.genres AS genres, we.rating AS rating
    FROM watch_events we JOIN titles t ON t.id = we.title_id
    WHERE we.profile_id = ? AND we.rating IS NOT NULL
  `).all(profileId) as RatedGenreRow[];
  const sig = getTasteSignature(db, profileId);
  return genreAffinityFromRatings(rows, sig ? parsePrefs(sig.prefs) : {});
}

/**
 * The pure half of genreAffinityForProfile: the same maths over rows already in
 * memory, so the offline evaluation (src/eval) scores exactly what production does.
 */
export function genreAffinityFromRatings(
  rows: Array<{ genres: string; rating: number }>,
  prefs: Pick<PrefsJson, 'loved_genres' | 'hated_genres'>,
): GenreAffinity {
  const affinity: GenreAffinity = {};
  if (rows.length > 0) {
    const overall = rows.reduce((s, r) => s + r.rating, 0) / rows.length;
    const perGenre = new Map<string, { sum: number; n: number }>();
    for (const r of rows) {
      for (const g of parseGenres(r.genres)) {
        const acc = perGenre.get(g) ?? { sum: 0, n: 0 };
        acc.sum += r.rating;
        acc.n += 1;
        perGenre.set(g, acc);
      }
    }
    for (const [g, { sum, n }] of perGenre) {
      const lift = sum / n - overall;
      const shrunk = (n / (n + AFFINITY_SHRINK_K)) * lift;
      affinity[g] = clamp(shrunk / 2, -1, 1);
    }
  }

  for (const g of prefs.hated_genres ?? []) affinity[g] = -1;
  for (const g of prefs.loved_genres ?? []) {
    if (!(g in affinity)) affinity[g] = LOVED_PREF_AFFINITY;
  }
  return affinity;
}

/**
 * Together-ratings of a genre the couple needs before their OWN verdict on it
 * replaces the partners' solo verdicts in the Joint veto.
 */
export const JOINT_VETO_MIN_TOGETHER = 5;

export interface JointVetoEvidence {
  /** How many titles of each genre the couple has rated together. */
  ownCounts?: Record<string, number>;
  /** Genres someone listed as hated (prefs): always vetoed, whatever the ratings say. */
  statedHated?: Iterable<string>;
}

/**
 * Joint affinity with mutual veto. A genre is excluded from Joint picks when
 * either partner sits at or below the veto threshold, EXCEPT once the couple
 * has rated at least JOINT_VETO_MIN_TOGETHER titles of that genre together:
 * from then on their together-ratings decide (vetoed only if the couple's own
 * affinity is at or below the threshold). Why: a solo dislike measured on one
 * kind of title (sitcoms watched alone) was vetoing the same genre for films
 * the couple rates highly together (comedy-thrillers, dark comedies). A stated
 * hated genre stays an absolute veto. The rest blend the couple's own
 * together-rated affinity with each partner's solo affinity.
 */
export function jointGenreAffinity(
  a: GenreAffinity,
  b: GenreAffinity,
  own: GenreAffinity,
  evidence: JointVetoEvidence = {},
  ownWeight: number = JOINT_OWN_WEIGHT,
): { affinity: GenreAffinity; vetoed: Set<string> } {
  const genres = new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(own)]);
  const stated = new Set([...(evidence.statedHated ?? [])].map(g => g.toLowerCase()));
  const partnerWeight = (1 - ownWeight) / 2;
  const affinity: GenreAffinity = {};
  const vetoed = new Set<string>();
  for (const g of genres) {
    const av = a[g] ?? 0;
    const bv = b[g] ?? 0;
    const together = evidence.ownCounts?.[g] ?? 0;
    const veto = stated.has(g.toLowerCase())
      || (together >= JOINT_VETO_MIN_TOGETHER
        ? (own[g] ?? 0) <= GENRE_VETO_THRESHOLD
        : av <= GENRE_VETO_THRESHOLD || bv <= GENRE_VETO_THRESHOLD);
    if (veto) {
      vetoed.add(g);
      continue;
    }
    affinity[g] = ownWeight * (own[g] ?? 0) + partnerWeight * av + partnerWeight * bv;
  }
  return { affinity, vetoed };
}

/** How many rated titles carry each genre. */
export function genreRatingCounts(rows: Array<{ genres: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rows) for (const g of parseGenres(r.genres)) counts[g] = (counts[g] ?? 0) + 1;
  return counts;
}

/** genreRatingCounts over a profile's rated watch events. */
export function genreRatingCountsForProfile(db: InstanceType<typeof Database>, profileId: number): Record<string, number> {
  const rows = db.prepare(`
    SELECT t.genres AS genres
    FROM watch_events we JOIN titles t ON t.id = we.title_id
    WHERE we.profile_id = ? AND we.rating IS NOT NULL
  `).all(profileId) as Array<{ genres: string }>;
  return genreRatingCounts(rows);
}

/**
 * Bayesian-average quality in [0, 1]: vote_average pulled toward the prior mean
 * by the media type's prior vote mass, so a 9.0 from 30 votes lands near 6.5
 * while a 9.0 from 5,000 votes stays a 9. Unknown values yield the prior.
 */
export function qualityScore(
  voteAverage: number | null | undefined,
  voteCount: number | null | undefined,
  mediaType: 'movie' | 'tv',
): number {
  const m = QUALITY_PRIOR_VOTES[mediaType];
  const v = Math.max(0, voteCount ?? 0);
  const r = voteAverage ?? QUALITY_PRIOR_MEAN;
  const bayes = (v / (v + m)) * r + (m / (v + m)) * QUALITY_PRIOR_MEAN;
  // Map the useful 5–9 band onto 0–1.
  return clamp((bayes - 5) / 4, 0, 1);
}

function popularityScore(popularity: number | null | undefined): number {
  const p = Math.max(0, popularity ?? 0);
  return clamp(Math.log1p(p) / Math.log1p(POPULARITY_SATURATION), 0, 1);
}

function titleAffinity(genres: string[], affinity: GenreAffinity): number {
  if (genres.length === 0) return 0;
  let sum = 0;
  for (const g of genres) sum += affinity[g] ?? 0;
  return sum / genres.length;
}

export interface RerankOverrides<T> {
  /** Per-title taste in [-1, 1]; defaults to the mean genre affinity of the title's genres. */
  affinityOf?: (c: T, genres: string[]) => number;
  /** Distance-like taste score (lower = closer) replacing c.score in the similarity slot; null = use c.score. */
  distanceOf?: (c: T) => number | null;
}

export type RankedCandidate<T extends CandidateTitle = CandidateTitle> = T & { rank_score: number };

/**
 * Rerank hard-filtered candidates by taste. `score` (cosine distance, lower =
 * closer) is preserved for the callers that persist it; the combined score is
 * attached as `rank_score` (higher = better) and the list is returned best-first.
 * Titles carrying any vetoed genre are dropped.
 */
export function rerank<T extends CandidateTitle>(
  candidates: T[],
  affinity: GenreAffinity,
  vetoed: Set<string>,
  weights: RerankWeights = DEFAULT_RERANK_WEIGHTS,
  overrides: RerankOverrides<T> = {},
): RankedCandidate<T>[] {
  const affinityOf = overrides.affinityOf ?? ((_c: T, genres: string[]) => titleAffinity(genres, affinity));
  const ranked: RankedCandidate<T>[] = [];
  // Same exact, case-insensitive match as hatedGenreClause in retrieve.ts.
  const vetoedLower = new Set([...vetoed].map(g => g.toLowerCase()));
  const kept = candidates.filter(c => !parseGenres(c.genres).some(g => vetoedLower.has(g.toLowerCase())));
  // Cosine distances from the embedder cluster in a narrow band (≈0.25–0.45 for
  // nomic-embed-text), so raw 1−distance would leave similarity nearly constant
  // and let quality/popularity decide everything. Rescale within the batch:
  // the closest candidate scores 1, the farthest 0.
  // A missing distance (NULL from SQLite, or NaN) means "no similarity signal":
  // it must not join the min/max (null would read as distance 0, the best match).
  const hasDist = (d: unknown): d is number => typeof d === 'number' && Number.isFinite(d);
  // The similarity slot uses overrides.distanceOf when it gives a value (nearest-
  // neighbour taste), else the vector-search distance in c.score.
  const distOf = new Map<T, unknown>(kept.map(c => {
    const d = overrides.distanceOf?.(c);
    return [c, hasDist(d) ? d : c.score];
  }));
  const dists = kept.map(c => distOf.get(c)).filter(hasDist);
  const minDist = Math.min(...dists);
  const maxDist = Math.max(...dists);
  const range = maxDist - minDist;
  for (const c of kept) {
    const genres = parseGenres(c.genres);
    const d = distOf.get(c);
    const similarity = !hasDist(d) ? 0
      : range > 1e-9 ? (maxDist - d) / range : clamp(1 - d, 0, 1);
    const aff = (clamp(affinityOf(c, genres), -1, 1) + 1) / 2; // [-1,1] → [0,1]
    const quality = qualityScore(c.vote_average, c.vote_count, c.media_type);
    const pop = popularityScore(c.popularity);
    const rank_score =
      weights.similarity * similarity +
      weights.affinity * aff +
      weights.quality * quality +
      weights.popularity * pop;
    ranked.push({ ...c, rank_score });
  }
  ranked.sort((x, y) => y.rank_score - x.rank_score);
  return ranked;
}

function parseGenres(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
