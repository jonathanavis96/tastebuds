import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { TitleRow } from '../db/types.js';
import type { Config } from '../config.js';
import { embedText } from '../ollama/embed.js';
import { getTasteSignature, upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import { getRatedTitles, getDislikedTitles } from '../db/repos/watchEvents.js';
import { getTitleById } from '../db/repos/titles.js';
import { getRecommendations } from '../db/repos/recommendations.js';
import { getCachedEmbedding, putCachedEmbedding } from '../db/repos/embeddingCache.js';
import { blendVectors } from './blend.js';
import { hardFilterSql, withWidening, type HardFilters } from './filters.js';
import {
  genreAffinityForProfile,
  jointGenreAffinity,
  rerank,
  GENRE_VETO_THRESHOLD,
  type GenreAffinity,
  type RerankWeights,
} from './rerank.js';

/** Deserialise a little-endian Float32 embedding Buffer to a number[]. */
function bufferToVec(buf: Buffer): number[] {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
}

export interface RetrieveOpts {
  mediaType?: 'movie' | 'tv';
  limit?: number;
  genreIds?: number[];
  excludeTitleIds?: number[];
  /**
   * The Joint (derived) profile's own id. When set on a Joint retrieval, the blend
   * leans on what the couple actually rated TOGETHER (their own taste vector, which
   * also absorbs their joint notes) over each person's solo taste, and excludes
   * titles the couple has already watched together.
   */
  jointProfileId?: number;
  /**
   * Minimum IMDb rating threshold. Titles with imdb_rating < minImdbRating are
   * excluded from all candidate pools. Titles with imdb_rating IS NULL are still
   * included (lenient: unrated ≠ bad).
   */
  minImdbRating?: number;
  /**
   * Hard metadata filters (year / runtime / votes / rating / language / release
   * status) applied in SQL before similarity. routes.ts always sets this; when
   * undefined the stage is skipped (tests only).
   */
  hardFilters?: HardFilters;
  /**
   * Called with the widening steps that had to be applied to reach the minimum
   * pool size (empty array = strict filters were enough). For logging.
   */
  onWidened?: (stepsApplied: string[]) => void;
}

/**
 * How much the Joint recommendation leans on the couple's OWN together-watched
 * ratings/notes vs. the blend of each person's solo taste. Jonathan's call:
 * what you rate after watching together is the major signal (~65%); the rest
 * (~35%) is your individual tastes — because a film you'd each skip alone can
 * still be a great joint watch.
 */
const JOINT_OWN_WEIGHT = 0.65;
const JOINT_INDIVIDUAL_WEIGHT = 0.35;

/**
 * Taste vector = (mean of liked titles) − NEGATIVE_WEIGHT × (mean of disliked titles).
 * This is Rocchio relevance feedback: the "Not Your Thing" tiles (low ratings + their
 * notes) pull the taste vector AWAY from what you didn't enjoy, so similar titles sink
 * in the cosine ranking. Jonathan: negatives should count as much as — if not more than
 * — positives, hence a strong 0.6 weight (tunable). Anything in between the two
 * thresholds (a 3) is treated as neutral and ignored.
 */
const LIKED_MIN_RATING = 4;
const DISLIKED_MAX_RATING = 2;
const NEGATIVE_WEIGHT = 0.6;

/**
 * Per-item weights inside the negative term — how hard each kind of "no" pushes.
 * A 1★ is the strongest signal, a 2★ milder, and "Not interested" (a dismissed
 * recommendation) milder still — Jonathan's call: a touch under a 2★. These are
 * relative weights blended into the weighted-mean negative direction.
 */
const DISLIKE_1STAR_WEIGHT = 1.0;
const DISLIKE_2STAR_WEIGHT = 0.5;
const DISMISS_WEIGHT = 0.3;

/**
 * When the user types a free-text request ("mind-bending sci-fi"), the candidate
 * pool is retrieved against a blend of their taste vector and the EMBEDDED request,
 * instead of the taste vector alone. Request-dominant (0.7) so results genuinely
 * match the ask, but still personalised (0.3) so the ordering leans toward the kind
 * of sci-fi/thriller/etc. this viewer actually likes. Tunable.
 */
const REQUEST_WEIGHT = 0.7;
const REQUEST_TASTE_WEIGHT = 0.3;

/** Deserialise a stored Float32 taste-vector Buffer to number[]. */
function vecFromBuffer(buf: Buffer): number[] {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
}

export interface CandidateTitle extends TitleRow {
  score: number;
}

/** Mean of a non-empty list of equal-length vectors. */
function meanVector(vectors: number[][]): number[] {
  const dim = vectors[0].length;
  const mean = new Array<number>(dim).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) mean[i] += vec[i];
  }
  for (let i = 0; i < dim; i++) mean[i] /= vectors.length;
  return mean;
}

/**
 * Rebuild the taste vector for a profile via Rocchio relevance feedback:
 *   taste = mean(liked, rating >= 4) − NEGATIVE_WEIGHT × mean(disliked, rating <= 2)
 * Liked + disliked both fold the user's free-text note into the embedded text. The
 * disliked ("Not Your Thing") side steers recommendations away from what they didn't
 * enjoy. Accepts an optional embedFn to allow test injection without module mocking.
 */
export async function refreshTasteVector(
  db: InstanceType<typeof Database>,
  profileId: number,
  config: Pick<Config, 'ollamaUrl'>,
  embedFn: (text: string, config: Pick<Config, 'ollamaUrl'>) => Promise<number[]> = embedText,
): Promise<void> {
  // Resolve a title's taste vector. The common case — a rating with NO free-text note —
  // reuses the title's stored embedding (computed once at harvest from "title synopsis"),
  // so a rating spree no longer re-embeds the whole history through Ollama on every click
  // (that was pegging the local nomic-embed-text model). Only when the user added a note
  // — which changes the embedded text — do we round-trip to the embedder. Titles missing a
  // stored embedding (harvest embed failed) also fall back to a fresh embed.
  const vectorForTitle = async (
    title: TitleRow,
    note: string | null | undefined,
  ): Promise<number[]> => {
    if (!note && title.embedding) {
      return bufferToVec(title.embedding);
    }
    // Fold the user's free-text note into the embedded text so the taste vector captures
    // the specifics they called out (pacing, mood, a performance…), not just the synopsis.
    // The note-augmented text is content-addressed in embedding_cache: it's embedded once
    // and reused on every later refresh, so a "Not interested" click no longer re-embeds
    // the ~half of rated titles that carry notes. Only an EDITED note (new text) re-embeds.
    const text = [title.title, title.synopsis, note].filter(Boolean).join(' — ');
    const hash = createHash('sha256').update(text).digest('hex');
    const cached = getCachedEmbedding(db, hash);
    if (cached) return bufferToVec(cached);
    const vec = await embedFn(text, config);
    putCachedEmbedding(db, hash, Buffer.from(new Float32Array(vec).buffer));
    return vec;
  };

  const embedEvents = async (events: ReturnType<typeof getRatedTitles>): Promise<number[][]> => {
    const vectors: number[][] = [];
    for (const event of events) {
      const title = getTitleById(db, event.title_id);
      if (!title) continue;
      vectors.push(await vectorForTitle(title, event.note));
    }
    return vectors;
  };

  const likedVecs = await embedEvents(getRatedTitles(db, profileId, LIKED_MIN_RATING));
  // Without any liked titles there's no direction to seek toward, so leave the existing
  // vector untouched (negatives alone can't define what to recommend).
  if (likedVecs.length === 0) return;

  // Collect weighted negatives: low-rated titles (≤1★ stronger than 2★) plus
  // "Not interested" (dismissed recs) as a mild push. Dedupe so a title that's
  // both low-rated and dismissed isn't counted twice (the rating wins).
  const negatives: Array<{ weight: number; vec: number[] }> = [];
  const seenNeg = new Set<number>();
  for (const ev of getDislikedTitles(db, profileId, DISLIKED_MAX_RATING)) {
    const title = getTitleById(db, ev.title_id);
    if (!title) continue;
    seenNeg.add(ev.title_id);
    // ≤1★ (incl. half-stars: 0.5/1) is a stronger negative than 1.5–2★.
    const weight = (ev.rating ?? 0) <= 1.5 ? DISLIKE_1STAR_WEIGHT : DISLIKE_2STAR_WEIGHT;
    negatives.push({ weight, vec: await vectorForTitle(title, ev.note) });
  }
  for (const rec of getRecommendations(db, profileId, 'dismissed')) {
    if (seenNeg.has(rec.title_id)) continue;
    const title = getTitleById(db, rec.title_id);
    if (!title) continue;
    seenNeg.add(rec.title_id);
    // A dismissed rec carries no note, so its stored embedding is reused (no Ollama call).
    negatives.push({ weight: DISMISS_WEIGHT, vec: await vectorForTitle(title, null) });
  }

  const likedMean = meanVector(likedVecs);
  const dim = likedMean.length;
  const meanVec = likedMean.slice();
  // Subtract the weighted-mean negative direction (count-independent, like the liked mean).
  const totalNegWeight = negatives.reduce((sum, n) => sum + n.weight, 0);
  if (totalNegWeight > 0) {
    for (let i = 0; i < dim; i++) {
      let neg = 0;
      for (const n of negatives) neg += n.weight * n.vec[i];
      meanVec[i] -= NEGATIVE_WEIGHT * (neg / totalNegWeight);
    }
  }

  const tasteVectorBuf = Buffer.from(new Float32Array(meanVec).buffer);

  const existing = getTasteSignature(db, profileId);
  upsertTasteSignature(db, {
    profile_id: profileId,
    taste_vector: tasteVectorBuf,
    prefs: existing?.prefs ?? '{}',
    refreshed_at: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate retrieval
//
// Every path below runs the same three stages:
//   1. HARD FILTERS (src/retrieval/filters.ts) — applied in SQL before anything
//      else, so unreleased, unrated, too-short, too-old or wrong-language titles
//      never reach ranking. Passed in via opts.hardFilters (routes always sets
//      it; leaving it undefined disables the stage, which only tests rely on).
//   2. SIMILARITY — cosine distance to the taste (⊕ request) vector via sqlite-vec,
//      fetching a wider slate than is returned.
//   3. RERANK (src/retrieval/rerank.ts) — genre affinity learned from the
//      profiles' own star ratings (mutual veto for Joint), Bayesian quality and
//      popularity, so votes visibly change what comes out.
// A thin pool is widened (year → runtime → votes) rather than returned short.
// ─────────────────────────────────────────────────────────────────────────────

/** How many rows similarity fetches per returned row, before rerank trims. */
const RERANK_FETCH_MULTIPLIER = 4;
/** On-taste / request pools are widened until they hold at least this many rows. */
export const MIN_POOL_ROWS = 20;
/** Flat request candidates handed to curation (was 30; the request prompt now asks for ≥10 picks). */
export const REQUEST_CANDIDATE_LIMIT = 60;

/** Wildcards are "off-taste but real": rank them by quality + popularity, not similarity. */
const WILDCARD_WEIGHTS: RerankWeights = { similarity: 0, affinity: 0.2, quality: 0.5, popularity: 0.3 };
/** Explicit requests are request-dominant (mirrors the 0.7/0.3 vector blend): relevance leads, taste and quality tie-break. */
const REQUEST_WEIGHTS: RerankWeights = { similarity: 0.55, affinity: 0.15, quality: 0.20, popularity: 0.10 };

/** SQL fragment + params for opts.hardFilters (or the widened variant `f`). Empty when disabled. */
function filterClause(f: HardFilters | undefined): { sql: string; params: unknown[] } {
  return f ? hardFilterSql(f) : { sql: '', params: [] };
}

/** Genres a solo profile has effectively vetoed: rated consistently low, or a stated hated genre. */
function soloVetoes(affinity: GenreAffinity): Set<string> {
  return new Set(Object.entries(affinity).filter(([, v]) => v <= GENRE_VETO_THRESHOLD).map(([g]) => g));
}

interface TasteContext {
  affinity: GenreAffinity;
  vetoed: Set<string>;
}

function soloTaste(db: InstanceType<typeof Database>, profileId: number): TasteContext {
  const affinity = genreAffinityForProfile(db, profileId);
  return { affinity, vetoed: soloVetoes(affinity) };
}

function jointTaste(
  db: InstanceType<typeof Database>,
  alexId: number,
  samId: number,
  jointId: number | undefined,
): TasteContext {
  return jointGenreAffinity(
    genreAffinityForProfile(db, alexId),
    genreAffinityForProfile(db, samId),
    jointId != null ? genreAffinityForProfile(db, jointId) : {},
  );
}

/** Rerank then trim, dropping the rank_score so callers see plain CandidateTitle rows (score = distance). */
function top<T extends CandidateTitle>(rows: T[], taste: TasteContext, limit: number, weights?: RerankWeights): T[] {
  return rerank(rows, taste.affinity, taste.vetoed, weights).slice(0, limit).map(({ rank_score: _r, ...rest }) => rest as unknown as T);
}

/**
 * Run `query` for movies and series separately (balanced), or once for a fixed
 * media type, widening the shared filters until the combined pool is big enough.
 */
function balancedWithWidening(
  opts: RetrieveOpts,
  perSideLimit: number,
  query: (f: HardFilters | undefined, mediaType: 'movie' | 'tv' | undefined, limit: number) => CandidateTitle[],
): { movie: CandidateTitle[]; tv: CandidateTitle[]; single: CandidateTitle[]; filters: HardFilters | undefined } {
  if (!opts.hardFilters) {
    return opts.mediaType
      ? { movie: [], tv: [], single: query(undefined, opts.mediaType, perSideLimit), filters: undefined }
      : { movie: query(undefined, 'movie', perSideLimit), tv: query(undefined, 'tv', perSideLimit), single: [], filters: undefined };
  }
  const minRows = Math.min(MIN_POOL_ROWS, opts.mediaType ? perSideLimit : perSideLimit * 2);
  if (opts.mediaType) {
    const res = withWidening(opts.hardFilters, minRows, f => query(f, opts.mediaType, perSideLimit));
    opts.onWidened?.(res.stepsApplied);
    return { movie: [], tv: [], single: res.rows, filters: res.filters };
  }
  const res = withWidening(opts.hardFilters, minRows, f => [
    ...query(f, 'movie', perSideLimit).map(r => ({ ...r, _side: 'movie' as const })),
    ...query(f, 'tv', perSideLimit).map(r => ({ ...r, _side: 'tv' as const })),
  ]);
  opts.onWidened?.(res.stepsApplied);
  const strip = (r: CandidateTitle & { _side: string }) => { const { _side: _s, ...rest } = r; return rest as CandidateTitle; };
  return {
    movie: res.rows.filter(r => r._side === 'movie').map(strip),
    tv: res.rows.filter(r => r._side === 'tv').map(strip),
    single: [],
    filters: res.filters,
  };
}

/**
 * Retrieve candidate titles for a single profile using cosine similarity via sqlite-vec.
 */
export async function retrieveCandidates(
  db: InstanceType<typeof Database>,
  profileId: number,
  opts: RetrieveOpts,
  _config: Pick<Config, 'ollamaUrl'>,
): Promise<CandidateTitle[]> {
  const sig = getTasteSignature(db, profileId);
  if (!sig?.taste_vector) return [];

  const tasteVec = sig.taste_vector;
  const limit = opts.limit ?? 20;
  const taste = soloTaste(db, profileId);

  const run = (f: HardFilters | undefined): CandidateTitle[] => {
    const fc = filterClause(f);
    let sql = `
      SELECT t.*, vec_distance_cosine(t.embedding, ?) AS score
      FROM titles t
      WHERE t.embedding IS NOT NULL
        AND t.id NOT IN (
          SELECT title_id FROM watch_events WHERE profile_id = ?
        )
        ${fc.sql}
    `;
    const params: unknown[] = [tasteVec, profileId, ...fc.params];
    if (opts.mediaType) { sql += ' AND t.media_type = ?'; params.push(opts.mediaType); }
    if (opts.minImdbRating != null) {
      sql += ' AND (t.imdb_rating IS NULL OR CAST(t.imdb_rating AS REAL) >= ?)';
      params.push(opts.minImdbRating);
    }
    sql += ' ORDER BY score ASC LIMIT ?';
    params.push(limit * RERANK_FETCH_MULTIPLIER);
    return db.prepare(sql).all(...params) as CandidateTitle[];
  };

  let rows: CandidateTitle[];
  if (opts.hardFilters) {
    const res = withWidening(opts.hardFilters, Math.min(MIN_POOL_ROWS, limit), run);
    opts.onWidened?.(res.stepsApplied);
    rows = res.rows;
  } else {
    rows = run(undefined);
  }
  return top(rows, taste, limit);
}

export interface CandidatePool {
  onTaste: CandidateTitle[];
  wildcards: CandidateTitle[];
  adversarial: CandidateTitle[];
}

interface PrefsJson {
  loved_genres?: string[];
  hated_genres?: string[];
  loved_themes?: string[];
  hated_themes?: string[];
  preferred_era?: string;
  media_weighting?: number;
}

/**
 * Retrieve candidates for the Joint profile.
 * Blends Alex + Sam vectors (equal weights) and applies mutual veto:
 *   - exclude titles in watch_events for EITHER profile
 *   - exclude titles whose genres overlap with EITHER profile's hated_genres,
 *     OR the Joint profile's own hated_genres (e.g. from a dismiss-reason tile
 *     picked while browsing in Joint view — that write lands on the Joint
 *     profile's own taste_signatures row, not Alex's or Sam's, so it must be
 *     read from here too or it's silently inert for future joint recs).
 *   - exclude any genre either partner has rated consistently low (rerank veto).
 */
export async function retrieveJointCandidates(
  db: InstanceType<typeof Database>,
  alexId: number,
  samId: number,
  opts: RetrieveOpts,
  _config: Pick<Config, 'ollamaUrl'>,
): Promise<CandidateTitle[]> {
  const alexSig = getTasteSignature(db, alexId);
  const samSig = getTasteSignature(db, samId);

  if (!alexSig?.taste_vector || !samSig?.taste_vector) return [];

  const blended = blendVectors(vecFromBuffer(alexSig.taste_vector), 0.5, vecFromBuffer(samSig.taste_vector), 0.5);
  const blendedBuf = Buffer.from(new Float32Array(blended).buffer);

  const alexPrefs: PrefsJson = JSON.parse(alexSig.prefs ?? '{}');
  const samPrefs: PrefsJson = JSON.parse(samSig.prefs ?? '{}');
  const jointId = opts.jointProfileId;
  const jointSig = jointId != null ? getTasteSignature(db, jointId) : undefined;
  const jointPrefs: PrefsJson = jointSig ? JSON.parse(jointSig.prefs ?? '{}') : {};
  const allHated = [...new Set([
    ...(alexPrefs.hated_genres ?? []),
    ...(samPrefs.hated_genres ?? []),
    ...(jointPrefs.hated_genres ?? []),
  ])];

  const limit = opts.limit ?? 20;
  const taste = jointTaste(db, alexId, samId, jointId);

  const run = (f: HardFilters | undefined): CandidateTitle[] => {
    const fc = filterClause(f);
    let sql = `
      SELECT t.*, vec_distance_cosine(t.embedding, ?) AS score
      FROM titles t
      WHERE t.embedding IS NOT NULL
        AND t.id NOT IN (
          SELECT title_id FROM watch_events WHERE profile_id = ? OR profile_id = ?
        )
        ${fc.sql}
    `;
    const params: unknown[] = [blendedBuf, alexId, samId, ...fc.params];
    if (opts.mediaType) { sql += ' AND t.media_type = ?'; params.push(opts.mediaType); }
    for (const genre of allHated) { sql += ' AND t.genres NOT LIKE ?'; params.push(`%${genre}%`); }
    if (opts.minImdbRating != null) {
      sql += ' AND (t.imdb_rating IS NULL OR CAST(t.imdb_rating AS REAL) >= ?)';
      params.push(opts.minImdbRating);
    }
    sql += ' ORDER BY score ASC LIMIT ?';
    params.push(limit * RERANK_FETCH_MULTIPLIER);
    return db.prepare(sql).all(...params) as CandidateTitle[];
  };

  let rows: CandidateTitle[];
  if (opts.hardFilters) {
    const res = withWidening(opts.hardFilters, Math.min(MIN_POOL_ROWS, limit), run);
    opts.onWidened?.(res.stepsApplied);
    rows = res.rows;
  } else {
    rows = run(undefined);
  }
  return top(rows, taste, limit);
}

/** Build a NOT IN clause safe from the NULL trap: when ids is empty, use `SELECT 0`. */
function notInClause(ids: number[]): [string, number[]] {
  if (ids.length === 0) return ['SELECT 0', []];
  return [ids.map(() => '?').join(','), ids];
}

type OrderDir = 'ASC' | 'DESC' | 'RANDOM';

/**
 * Shared pool query for the solo and Joint pools: taste vector distance over
 * titles not engaged by any of `vetoProfileIds`, minus explicit excludes, under
 * hard filters `f`, optional media type, hated-genre LIKE vetoes and IMDb floor.
 */
function runPoolQuery(
  db: InstanceType<typeof Database>,
  vec: Buffer,
  vetoProfileIds: number[],
  excludeIds: number[],
  opts: RetrieveOpts,
  f: HardFilters | undefined,
  mediaType: 'movie' | 'tv' | undefined,
  orderDir: OrderDir,
  limit: number,
  hatedGenres: string[] = [],
): CandidateTitle[] {
  const [vetoPh, vetoIds] = notInClause(vetoProfileIds);
  const [excPh, excIds] = notInClause(excludeIds);
  const fc = filterClause(f);
  let sql = `
    SELECT t.*, vec_distance_cosine(t.embedding, ?) AS score
    FROM titles t
    WHERE t.embedding IS NOT NULL
      AND t.id NOT IN (SELECT title_id FROM watch_events WHERE profile_id IN (${vetoPh}))
      AND t.id NOT IN (${excPh})
      ${fc.sql}
  `;
  const params: unknown[] = [vec, ...vetoIds, ...excIds, ...fc.params];
  if (mediaType) { sql += ' AND t.media_type = ?'; params.push(mediaType); }
  for (const genre of hatedGenres) { sql += ' AND t.genres NOT LIKE ?'; params.push(`%${genre}%`); }
  if (opts.minImdbRating != null) {
    sql += ' AND (t.imdb_rating IS NULL OR CAST(t.imdb_rating AS REAL) >= ?)';
    params.push(opts.minImdbRating);
  }
  sql += orderDir === 'RANDOM' ? ' ORDER BY RANDOM()' : ` ORDER BY score ${orderDir}`;
  sql += ' LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params) as CandidateTitle[];
}

/**
 * Assemble the 3-group pool (on-taste / wildcards / adversarial) from a taste
 * vector, given who has engaged (veto) and what to exclude. Used by both the solo
 * and Joint pools, which differ only in vector, veto set and affinity context.
 *
 * - onTaste: closest by cosine after hard filters, reranked; 20 (or 10 movies +
 *   10 series when mediaType is unset). Widened when thin.
 * - adversarial: farthest by cosine under the SAME (possibly widened) filters,
 *   not in onTaste; 8 (4+4). Genre veto is NOT applied — this is the deliberate
 *   "predicted dislike" pick — but hard filters are, so it's still a real film.
 * - wildcards: random under the filters, minus hated genres and the other
 *   groups, then ranked by quality/popularity; 12 (6+6).
 */
function assemblePool(
  db: InstanceType<typeof Database>,
  vec: Buffer,
  vetoProfileIds: number[],
  opts: RetrieveOpts,
  taste: TasteContext,
  hatedGenres: string[],
): CandidatePool {
  const extraExclude: number[] = opts.excludeTitleIds ?? [];
  const q = (f: HardFilters | undefined, mt: 'movie' | 'tv' | undefined, order: OrderDir, limit: number, exclude: number[], hated: string[] = []) =>
    runPoolQuery(db, vec, vetoProfileIds, [...extraExclude, ...exclude], opts, f, mt, order, limit, hated);

  const sideLimit = opts.mediaType ? 20 : 10;
  const fetched = balancedWithWidening(opts, sideLimit * RERANK_FETCH_MULTIPLIER, (f, mt, limit) => q(f, mt, 'ASC', limit, []));
  const f = fetched.filters;

  let onTaste: CandidateTitle[];
  let adversarial: CandidateTitle[];
  let wildcards: CandidateTitle[];

  if (opts.mediaType) {
    onTaste = top(fetched.single, taste, 20);
    const onIds = onTaste.map(c => c.id);
    adversarial = top(q(f, opts.mediaType, 'DESC', 8 * 3, onIds), { affinity: {}, vetoed: new Set() }, 8, WILDCARD_WEIGHTS);
    const exWild = [...onIds, ...adversarial.map(c => c.id)];
    wildcards = top(q(f, opts.mediaType, 'RANDOM', 12 * 3, exWild, hatedGenres), taste, 12, WILDCARD_WEIGHTS);
  } else {
    onTaste = [...top(fetched.movie, taste, 10), ...top(fetched.tv, taste, 10)];
    const onIds = onTaste.map(c => c.id);
    const noTaste: TasteContext = { affinity: {}, vetoed: new Set() };
    adversarial = [
      ...top(q(f, 'movie', 'DESC', 4 * 3, onIds), noTaste, 4, WILDCARD_WEIGHTS),
      ...top(q(f, 'tv', 'DESC', 4 * 3, onIds), noTaste, 4, WILDCARD_WEIGHTS),
    ];
    const exWild = [...onIds, ...adversarial.map(c => c.id)];
    wildcards = [
      ...top(q(f, 'movie', 'RANDOM', 6 * 3, exWild, hatedGenres), taste, 6, WILDCARD_WEIGHTS),
      ...top(q(f, 'tv', 'RANDOM', 6 * 3, exWild, hatedGenres), taste, 6, WILDCARD_WEIGHTS),
    ];
  }

  return { onTaste, wildcards, adversarial };
}

/**
 * Retrieve a structured candidate pool for a single profile (see assemblePool).
 *
 * opts.excludeTitleIds: additional title ids to exclude from all groups (e.g.
 * already-pending recommendations — prevents accumulation of duplicates).
 */
export async function retrieveCandidatePool(
  db: InstanceType<typeof Database>,
  profileId: number,
  opts: RetrieveOpts,
  _config: Pick<Config, 'ollamaUrl'>,
): Promise<CandidatePool> {
  const sig = getTasteSignature(db, profileId);
  if (!sig?.taste_vector) return { onTaste: [], wildcards: [], adversarial: [] };

  const prefs: PrefsJson = JSON.parse(sig.prefs ?? '{}');
  const hatedGenres: string[] = prefs.hated_genres ?? [];
  return assemblePool(db, sig.taste_vector, [profileId], opts, soloTaste(db, profileId), hatedGenres);
}

/**
 * Cold-start candidate pool for a profile that has prefs but NO taste vector yet —
 * a freshly seeded profile that has never rated anything, so refreshTasteVector
 * left taste_vector null. There's nothing to compute cosine distance against, so we
 * fall back to the profile's stated loved_genres, drawn at random under the hard
 * filters and then ranked by quality/popularity, with the hated-genre veto and the
 * watched/exclude filters still applied. This lets a brand-new user bootstrap:
 * /generate surfaces ratable titles, the first ratings build the real taste vector,
 * and subsequent runs use the normal vector path.
 *
 *   onTaste     = titles in a loved genre (or general when none stated)
 *   wildcards   = general titles (minus hated), excluding onTaste
 *   adversarial = [] (no taste vector → no meaningful "farthest" pick)
 */
export async function retrieveColdStartPool(
  db: InstanceType<typeof Database>,
  profileId: number,
  opts: RetrieveOpts,
  _config: Pick<Config, 'ollamaUrl'>,
): Promise<CandidatePool> {
  const sig = getTasteSignature(db, profileId);
  const prefs: PrefsJson = JSON.parse(sig?.prefs ?? '{}');
  const lovedGenres = prefs.loved_genres ?? [];
  const hatedGenres = prefs.hated_genres ?? [];
  const extraExclude: number[] = opts.excludeTitleIds ?? [];
  const taste = soloTaste(db, profileId);

  const watchedSubquery = 'SELECT title_id FROM watch_events WHERE profile_id = ?';

  // genres is a JSON array string (e.g. ["Drama","Sci-Fi"]) — match the quoted
  // genre name so "Drama" can't partial-hit a longer genre.
  const runRandomQuery = (
    f: HardFilters | undefined,
    mediaType: 'movie' | 'tv' | undefined,
    limit: number,
    extraIds: number[],
    lovedOnly: boolean,
  ): CandidateTitle[] => {
    const [excPh, excIds] = notInClause([...extraExclude, ...extraIds]);
    const fc = filterClause(f);
    let sql = `
      SELECT t.*, 0 AS score
      FROM titles t
      WHERE t.embedding IS NOT NULL
        AND t.id NOT IN (${watchedSubquery})
        AND t.id NOT IN (${excPh})
        ${fc.sql}
    `;
    const params: unknown[] = [profileId, ...excIds, ...fc.params];
    if (mediaType) { sql += ' AND t.media_type = ?'; params.push(mediaType); }
    if (lovedOnly && lovedGenres.length > 0) {
      sql += ' AND (' + lovedGenres.map(() => 't.genres LIKE ?').join(' OR ') + ')';
      for (const g of lovedGenres) params.push(`%"${g}"%`);
    }
    for (const g of hatedGenres) { sql += ' AND t.genres NOT LIKE ?'; params.push(`%"${g}"%`); }
    sql += ' ORDER BY RANDOM() LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params) as CandidateTitle[];
  };

  const hasLoved = lovedGenres.length > 0;
  const sideLimit = opts.mediaType ? 20 : 10;
  const fetched = balancedWithWidening(opts, sideLimit * 3, (f, mt, limit) => runRandomQuery(f, mt, limit, [], hasLoved));
  const f = fetched.filters;

  let onTaste: CandidateTitle[];
  let wildcards: CandidateTitle[];

  if (opts.mediaType) {
    onTaste = top(fetched.single, taste, 20, WILDCARD_WEIGHTS);
    wildcards = top(runRandomQuery(f, opts.mediaType, 36, onTaste.map(c => c.id), false), taste, 12, WILDCARD_WEIGHTS);
  } else {
    onTaste = [...top(fetched.movie, taste, 10, WILDCARD_WEIGHTS), ...top(fetched.tv, taste, 10, WILDCARD_WEIGHTS)];
    const ex = onTaste.map(c => c.id);
    wildcards = [
      ...top(runRandomQuery(f, 'movie', 18, ex, false), taste, 6, WILDCARD_WEIGHTS),
      ...top(runRandomQuery(f, 'tv', 18, ex, false), taste, 6, WILDCARD_WEIGHTS),
    ];
  }

  return { onTaste, wildcards, adversarial: [] };
}

/**
 * Run a single flat request-pool query: titles ranked by cosine distance to a
 * pre-built query vector (taste ⊕ request), excluding titles in watch_events for
 * any vetoProfileIds plus opts.excludeTitleIds, optionally filtered by media type.
 * Hated-genre veto is intentionally NOT applied — the user asked for this explicitly.
 */
function runRequestQuery(
  db: InstanceType<typeof Database>,
  queryBuf: Buffer,
  vetoProfileIds: number[],
  opts: RetrieveOpts,
  f: HardFilters | undefined,
  mediaType: 'movie' | 'tv' | undefined,
  limit: number,
): CandidateTitle[] {
  return runPoolQuery(db, queryBuf, vetoProfileIds, opts.excludeTitleIds ?? [], opts, f, mediaType, 'ASC', limit);
}

/** Build the query buffer from a base taste vector blended with the embedded request. */
function blendRequestQueryBuf(baseVec: number[], reqVec: number[]): Buffer {
  const queryVec = blendVectors(baseVec, REQUEST_TASTE_WEIGHT, reqVec, REQUEST_WEIGHT);
  return Buffer.from(new Float32Array(queryVec).buffer);
}

/**
 * Shared tail of the two request paths: fetch a wide slate under (widened)
 * filters, rerank by taste WITHOUT the genre veto (an explicit request overrides
 * a passive dislike — soft affinity still orders the list), and trim.
 */
function finishRequest(
  db: InstanceType<typeof Database>,
  queryBuf: Buffer,
  vetoIds: number[],
  opts: RetrieveOpts,
  taste: TasteContext,
): CandidateTitle[] {
  const softTaste: TasteContext = { affinity: taste.affinity, vetoed: new Set() };
  const total = opts.limit ?? REQUEST_CANDIDATE_LIMIT;
  const half = Math.ceil(total / 2);
  const sideLimit = opts.mediaType ? total : half;
  const fetched = balancedWithWidening(opts, sideLimit * RERANK_FETCH_MULTIPLIER, (f, mt, limit) =>
    runRequestQuery(db, queryBuf, vetoIds, opts, f, mt, limit));
  if (opts.mediaType) return top(fetched.single, softTaste, total, REQUEST_WEIGHTS);
  return [...top(fetched.movie, softTaste, half, REQUEST_WEIGHTS), ...top(fetched.tv, softTaste, half, REQUEST_WEIGHTS)];
}

/**
 * Retrieve a flat, request-relevant candidate list for a single profile.
 *
 * Used when the viewer types a free-text request. The request is embedded and
 * blended with the taste vector (request-dominant), then titles are ranked by
 * cosine distance to that blend — so "mind-bending sci-fi" actually returns sci-fi,
 * ordered toward the viewer's taste. When mediaType is unset the result is balanced
 * across movies + series. Returns a flat array (→ legacy "rank by request" prompt),
 * NOT a 7+2+1 pool: a specific ask shouldn't be diluted with random/adversarial picks.
 */
export async function retrieveRequestCandidates(
  db: InstanceType<typeof Database>,
  profileId: number,
  requestText: string,
  opts: RetrieveOpts,
  config: Pick<Config, 'ollamaUrl'>,
  embedFn: (text: string, config: Pick<Config, 'ollamaUrl'>) => Promise<number[]> = embedText,
): Promise<CandidateTitle[]> {
  const sig = getTasteSignature(db, profileId);
  if (!sig?.taste_vector) return [];
  const tasteVec = vecFromBuffer(sig.taste_vector);
  const reqVec = await embedFn(requestText, config);
  const queryBuf = blendRequestQueryBuf(tasteVec, reqVec);
  return finishRequest(db, queryBuf, [profileId], opts, soloTaste(db, profileId));
}

/**
 * Retrieve a flat, request-relevant candidate list for the Joint profile.
 * Same as retrieveRequestCandidates but the base vector is the Joint blend
 * (couple-own ⊕ solo-blend) and the watch veto spans Alex OR Sam OR Joint.
 */
export async function retrieveJointRequestCandidates(
  db: InstanceType<typeof Database>,
  alexId: number,
  samId: number,
  requestText: string,
  opts: RetrieveOpts,
  config: Pick<Config, 'ollamaUrl'>,
  embedFn: (text: string, config: Pick<Config, 'ollamaUrl'>) => Promise<number[]> = embedText,
): Promise<CandidateTitle[]> {
  const alexSig = getTasteSignature(db, alexId);
  const samSig = getTasteSignature(db, samId);
  if (!alexSig?.taste_vector || !samSig?.taste_vector) return [];

  const individualBlend = blendVectors(
    vecFromBuffer(alexSig.taste_vector), 0.5,
    vecFromBuffer(samSig.taste_vector), 0.5,
  );
  const jointId = opts.jointProfileId;
  const jointSig = jointId != null ? getTasteSignature(db, jointId) : undefined;
  const baseVec = jointSig?.taste_vector
    ? blendVectors(vecFromBuffer(jointSig.taste_vector), JOINT_OWN_WEIGHT, individualBlend, JOINT_INDIVIDUAL_WEIGHT)
    : individualBlend;

  const reqVec = await embedFn(requestText, config);
  const queryBuf = blendRequestQueryBuf(baseVec, reqVec);
  const vetoIds = [alexId, samId, ...(jointId != null ? [jointId] : [])];
  return finishRequest(db, queryBuf, vetoIds, opts, jointTaste(db, alexId, samId, jointId));
}

/**
 * Retrieve a structured candidate pool for the Joint (blended) profile — the
 * same 3-group assembly as the solo pool, with:
 *   - the blended vector (couple-own ⊕ solo-blend when the couple has rated
 *     together, else the equal solo blend);
 *   - engagement veto across Alex, Sam AND the Joint profile (so a film they just
 *     rated jointly leaves the Picks feed — "it should move into rated");
 *   - mutual genre veto: hated_genres of either partner or the Joint profile's
 *     own row, plus any genre either partner has rated consistently low.
 *
 * opts.excludeTitleIds: additional ids to exclude from all groups.
 */
export async function retrieveJointCandidatePool(
  db: InstanceType<typeof Database>,
  alexId: number,
  samId: number,
  opts: RetrieveOpts,
  _config: Pick<Config, 'ollamaUrl'>,
): Promise<CandidatePool> {
  const alexSig = getTasteSignature(db, alexId);
  const samSig = getTasteSignature(db, samId);

  if (!alexSig?.taste_vector || !samSig?.taste_vector) {
    return { onTaste: [], wildcards: [], adversarial: [] };
  }

  const alexVec = vecFromBuffer(alexSig.taste_vector);
  const samVec = vecFromBuffer(samSig.taste_vector);

  // Solo blend of the two people, equal weight.
  const individualBlend = blendVectors(alexVec, 0.5, samVec, 0.5);

  // If the couple has its OWN taste vector (built from what they rated together,
  // incl. their joint notes), lean on it heavily; otherwise fall back to the solo
  // blend until they've rated enough together.
  const jointId = opts.jointProfileId;
  const jointSig = jointId != null ? getTasteSignature(db, jointId) : undefined;
  const blended = jointSig?.taste_vector
    ? blendVectors(vecFromBuffer(jointSig.taste_vector), JOINT_OWN_WEIGHT, individualBlend, JOINT_INDIVIDUAL_WEIGHT)
    : individualBlend;
  const blendedBuf = Buffer.from(new Float32Array(blended).buffer);

  const alexPrefs: PrefsJson = JSON.parse(alexSig.prefs ?? '{}');
  const samPrefs: PrefsJson = JSON.parse(samSig.prefs ?? '{}');
  // Also honor the Joint profile's OWN hated_genres — a dismiss-reason tile
  // picked while browsing in Joint view writes back to the Joint profile's own
  // taste_signatures row (not Alex's or Sam's), so it must be read from here
  // too or it's silently inert for future joint recs.
  const jointPrefs: PrefsJson = jointSig ? JSON.parse(jointSig.prefs ?? '{}') : {};
  const allHated = [...new Set([
    ...(alexPrefs.hated_genres ?? []),
    ...(samPrefs.hated_genres ?? []),
    ...(jointPrefs.hated_genres ?? []),
  ])];

  const vetoIds = [alexId, samId, ...(jointId != null ? [jointId] : [])];
  return assemblePool(db, blendedBuf, vetoIds, opts, jointTaste(db, alexId, samId, jointId), allHated);
}
