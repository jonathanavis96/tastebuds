/**
 * Taste models for the offline test. Each model is trained on a profile's
 * earlier events and returns a score for a batch of titles (higher = more
 * likely to be enjoyed). "today" reproduces production exactly by calling the
 * same functions retrieval uses; the variants change one thing each.
 */
import type { EvalEvent, EvalProfile, EvalTitle } from './data.js';
import { unit } from './data.js';
import {
  rocchioVector,
  LIKED_MIN_RATING,
  DISLIKED_MAX_RATING,
  DISLIKE_1STAR_WEIGHT,
  DISLIKE_2STAR_WEIGHT,
  DISMISS_WEIGHT,
  JOINT_OWN_WEIGHT,
} from '../retrieval/retrieve.js';
import { blendVectors } from '../retrieval/blend.js';
import {
  genreAffinityFromRatings,
  genreRatingCounts,
  jointGenreAffinity,
  rerank,
  GENRE_VETO_THRESHOLD,
  type GenreAffinity,
} from '../retrieval/rerank.js';
import { neighbourDistance, blendedNeighbourDistance } from '../retrieval/neighbours.js';
import type { CandidateTitle } from '../retrieval/retrieve.js';
import { learnTasteWeights, type LearnedWeights } from './learnedTaste.js';

export interface ModelOptions {
  /** Similarity from the nearest liked/disliked titles instead of one averaged taste vector. */
  knn?: boolean;
  /** Per-genre and per-keyword weights learned from ratings + dismissals instead of genre means. */
  learned?: boolean;
  /** Separate taste for movies and for series when each has enough ratings. */
  mediaSplit?: boolean;
  /** Joint only: once the couple has rated enough of a genre together, their verdict replaces the partners' veto. */
  vetoOverride?: boolean;
  /** Score with similarity only (the bare taste vector), ignoring affinity, quality and popularity. */
  cosineOnly?: boolean;
}

/** What one profile's training events produce. */
export interface SoloTaste {
  vector: number[] | null;
  liked: Float32Array[];
  negatives: Array<{ weight: number; vec: Float32Array }>;
  affinity: GenreAffinity;
  learned: LearnedWeights | null;
  /** Rated titles per genre (for the Joint veto override). */
  genreCounts: Record<string, number>;
  statedHated: string[];
  /** Per media type, when mediaSplit is on and there is enough data. */
  byMedia?: Partial<Record<'movie' | 'tv', SoloTaste>>;
}

const MEDIA_SPLIT_MIN_LIKED = 8;

export function buildSoloTaste(
  events: EvalEvent[],
  titles: Map<number, EvalTitle>,
  prefs: EvalProfile['prefs'],
  opts: ModelOptions,
  allowSplit = true,
): SoloTaste {
  const liked = events.filter(e => e.rating != null && e.rating >= LIKED_MIN_RATING).map(e => e.vec);
  const negatives: SoloTaste['negatives'] = [];
  for (const e of events) {
    if (e.rating == null) negatives.push({ weight: DISMISS_WEIGHT, vec: e.vec });
    else if (e.rating <= DISLIKED_MAX_RATING) {
      negatives.push({ weight: e.rating <= 1.5 ? DISLIKE_1STAR_WEIGHT : DISLIKE_2STAR_WEIGHT, vec: e.vec });
    }
  }
  const vector = liked.length > 0
    ? rocchioVector(liked.map(v => Array.from(v)), negatives.map(n => ({ weight: n.weight, vec: Array.from(n.vec) })))
    : null;
  const ratedRows = events
    .filter(e => e.rating != null)
    .map(e => ({ genres: titles.get(e.titleId)!.genresJson, rating: e.rating as number }));
  const affinity = genreAffinityFromRatings(ratedRows, prefs);
  const learned = opts.learned
    ? learnTasteWeights(events.map(e => ({ title: titles.get(e.titleId)!, rating: e.rating })))
    : null;

  const taste: SoloTaste = {
    vector, liked, negatives, affinity, learned,
    genreCounts: genreRatingCounts(ratedRows),
    statedHated: prefs.hated_genres ?? [],
  };
  if (opts.mediaSplit && allowSplit) {
    taste.byMedia = {};
    for (const m of ['movie', 'tv'] as const) {
      const sub = events.filter(e => titles.get(e.titleId)!.media_type === m);
      const nLiked = sub.filter(e => e.rating != null && e.rating >= LIKED_MIN_RATING).length;
      if (nLiked >= MEDIA_SPLIT_MIN_LIKED) taste.byMedia[m] = buildSoloTaste(sub, titles, prefs, opts, false);
    }
  }
  return taste;
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function cosineDistance(v: number[], t: Float32Array): number {
  const u = unit(Float32Array.from(v));
  return 1 - dot(u, t);
}

/** Vector-search distance: cosine distance to the averaged taste vector (production's c.score). */
function vectorDistance(taste: SoloTaste, t: EvalTitle): number | null {
  const media = taste.byMedia?.[t.media_type];
  if (media) return vectorDistance(media, t);
  return taste.vector ? cosineDistance(taste.vector, t.vec) : null;
}

/** Nearest-neighbour distance, the production function over the training events. */
function knnDistance(taste: SoloTaste, t: EvalTitle): number | null {
  const media = taste.byMedia?.[t.media_type];
  if (media) return knnDistance(media, t);
  return neighbourDistance(taste, t.vec);
}

function affinityFor(taste: SoloTaste, t: EvalTitle, genres: string[]): number {
  const media = taste.byMedia?.[t.media_type];
  if (media) return affinityFor(media, t, genres);
  if (taste.learned) return taste.learned.predict(t);
  if (genres.length === 0) return 0;
  return genres.reduce((s, g) => s + (taste.affinity[g] ?? 0), 0) / genres.length;
}

/**
 * Production ranking of a batch: rerank() with the same weights, veto and
 * overrides. Titles rerank drops (a vetoed genre) score −Infinity: they would
 * never be shown.
 */
function rankBatch(
  batch: EvalTitle[],
  distance: (t: EvalTitle) => number | null,
  knn: ((t: EvalTitle) => number | null) | null,
  affinityOf: (t: EvalTitle, genres: string[]) => number,
  vetoed: Set<string>,
  opts: ModelOptions,
): number[] {
  if (opts.cosineOnly) return batch.map(t => -((knn?.(t) ?? distance(t)) ?? 1));
  type Cand = CandidateTitle & { _t: EvalTitle };
  const cands = batch.map(t => ({ ...t, genres: t.genresJson, score: distance(t), _t: t }) as unknown as Cand);
  const ranked = rerank<Cand>(cands, {}, vetoed, undefined, {
    affinityOf: (c, genres) => affinityOf(c._t, genres),
    distanceOf: knn ? c => knn(c._t) : undefined,
  });
  const byId = new Map(ranked.map(r => [r.id, r.rank_score]));
  return batch.map(t => byId.get(t.id) ?? -Infinity);
}

function soloVetoes(affinity: GenreAffinity): Set<string> {
  return new Set(Object.entries(affinity).filter(([, v]) => v <= GENRE_VETO_THRESHOLD).map(([g]) => g));
}

export function scoreSolo(taste: SoloTaste, batch: EvalTitle[], opts: ModelOptions): number[] {
  return rankBatch(
    batch,
    t => vectorDistance(taste, t),
    opts.knn ? t => knnDistance(taste, t) : null,
    (t, genres) => affinityFor(taste, t, genres),
    soloVetoes(taste.affinity),
    opts,
  );
}

export interface JointWeights {
  /** Share of the couple's own together-rated taste (today 0.65). */
  own: number;
}

export const TODAY_JOINT: JointWeights = { own: JOINT_OWN_WEIGHT };

/**
 * Joint scoring as production does it: vector = own (0.65) ⊕ equal partner blend (0.35);
 * affinity = 0.65 own + 0.175 each partner, minus vetoed genres (jointGenreAffinity).
 * `w.own` moves both shares together so the two stay consistent.
 */
export function scoreJoint(
  own: SoloTaste,
  a: SoloTaste,
  b: SoloTaste,
  batch: EvalTitle[],
  opts: ModelOptions,
  w: JointWeights = TODAY_JOINT,
): number[] {
  const partnerShare = 1 - w.own;
  const { affinity, vetoed } = jointGenreAffinity(a.affinity, b.affinity, own.affinity, {
    ownCounts: opts.vetoOverride ? own.genreCounts : undefined,
    statedHated: [...own.statedHated, ...a.statedHated, ...b.statedHated],
  }, w.own);
  const partnerVec = blendOrNull(a.vector, 0.5, b.vector, 0.5);
  const jointVec = own.vector && partnerVec && w.own < 1 && w.own > 0
    ? blendVectors(own.vector, w.own, partnerVec, partnerShare)
    : w.own >= 1 ? own.vector ?? partnerVec : w.own <= 0 ? partnerVec : own.vector ?? partnerVec;

  const distance = (t: EvalTitle): number | null => (jointVec ? cosineDistance(jointVec, t.vec) : null);
  const knn = opts.knn
    ? (t: EvalTitle) => blendedNeighbourDistance([
      { neighbours: own, weight: w.own },
      { neighbours: a, weight: partnerShare / 2 },
      { neighbours: b, weight: partnerShare / 2 },
    ], t.vec)
    : null;
  const affinityOf = (t: EvalTitle, genres: string[]): number => {
    if (opts.learned) {
      const parts = [own, a, b].map(s => (s.learned ? s.learned.predict(t) : 0));
      return w.own * parts[0] + (partnerShare / 2) * (parts[1] + parts[2]);
    }
    if (genres.length === 0) return 0;
    return genres.reduce((s, g) => s + (affinity[g] ?? 0), 0) / genres.length;
  };
  return rankBatch(batch, distance, knn, affinityOf, vetoed, opts);
}

function blendOrNull(v1: number[] | null, w1: number, v2: number[] | null, w2: number): number[] | null {
  if (!v1 && !v2) return null;
  return blendVectors(v1 ?? [], w1, v2 ?? [], w2);
}
