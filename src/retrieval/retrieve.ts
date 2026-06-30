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

  let sql = `
    SELECT t.*, vec_distance_cosine(t.embedding, ?) AS score
    FROM titles t
    WHERE t.embedding IS NOT NULL
      AND t.id NOT IN (
        SELECT title_id FROM watch_events WHERE profile_id = ?
      )
  `;
  const params: unknown[] = [tasteVec, profileId];

  if (opts.mediaType) {
    sql += ' AND t.media_type = ?';
    params.push(opts.mediaType);
  }

  sql += ' ORDER BY score ASC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as CandidateTitle[];
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
 *   - exclude titles whose genres overlap with EITHER profile's hated_genres
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

  // Deserialise Buffers to number[]
  const alexVec = Array.from(
    new Float32Array(alexSig.taste_vector.buffer, alexSig.taste_vector.byteOffset, alexSig.taste_vector.length / 4),
  );
  const samVec = Array.from(
    new Float32Array(samSig.taste_vector.buffer, samSig.taste_vector.byteOffset, samSig.taste_vector.length / 4),
  );

  const blended = blendVectors(alexVec, 0.5, samVec, 0.5);
  const blendedBuf = Buffer.from(new Float32Array(blended).buffer);

  const alexPrefs: PrefsJson = JSON.parse(alexSig.prefs ?? '{}');
  const samPrefs: PrefsJson = JSON.parse(samSig.prefs ?? '{}');

  const alexHated: string[] = alexPrefs.hated_genres ?? [];
  const samHated: string[] = samPrefs.hated_genres ?? [];
  const allHated = [...new Set([...alexHated, ...samHated])];

  const limit = opts.limit ?? 20;

  // Build SQL — exclude both watch_event lists and any hated-genre overlap
  let sql = `
    SELECT t.*, vec_distance_cosine(t.embedding, ?) AS score
    FROM titles t
    WHERE t.embedding IS NOT NULL
      AND t.id NOT IN (
        SELECT title_id FROM watch_events WHERE profile_id = ? OR profile_id = ?
      )
  `;
  const params: unknown[] = [blendedBuf, alexId, samId];

  if (opts.mediaType) {
    sql += ' AND t.media_type = ?';
    params.push(opts.mediaType);
  }

  // Hated genre veto — LIKE filter per hated genre
  for (const genre of allHated) {
    sql += ' AND t.genres NOT LIKE ?';
    params.push(`%${genre}%`);
  }

  sql += ' ORDER BY score ASC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as CandidateTitle[];
}

/** Build a NOT IN clause safe from the NULL trap: when ids is empty, use `SELECT 0`. */
function notInClause(ids: number[]): [string, number[]] {
  if (ids.length === 0) return ['SELECT 0', []];
  return [ids.map(() => '?').join(','), ids];
}

/**
 * Retrieve a structured candidate pool for a single profile.
 *
 * - onTaste: ~20 closest by cosine distance (score ASC); when mediaType is unset,
 *   balanced as top 10 movies + top 10 series.
 * - adversarial: ~8 farthest (score DESC), not in onTaste; when mediaType is unset,
 *   balanced as 4 movies + 4 series.
 * - wildcards: ~12 random, not in onTaste/adversarial, not hated genre; when
 *   mediaType is unset, balanced as 6 movies + 6 series.
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

  const tasteVec = sig.taste_vector;
  const prefs: PrefsJson = JSON.parse(sig.prefs ?? '{}');
  const hatedGenres: string[] = prefs.hated_genres ?? [];
  const extraExclude: number[] = opts.excludeTitleIds ?? [];

  const watchedSubquery = 'SELECT title_id FROM watch_events WHERE profile_id = ?';

  // Helper: run a single-media-type or all-media query.
  const runOnTasteQuery = (mediaType: 'movie' | 'tv' | undefined, limit: number, extraIds: number[]): CandidateTitle[] => {
    const [excPh, excIds] = notInClause([...extraExclude, ...extraIds]);
    let sql = `
      SELECT t.*, vec_distance_cosine(t.embedding, ?) AS score
      FROM titles t
      WHERE t.embedding IS NOT NULL
        AND t.id NOT IN (${watchedSubquery})
        AND t.id NOT IN (${excPh})
    `;
    const params: unknown[] = [tasteVec, profileId, ...excIds];
    if (mediaType) { sql += ' AND t.media_type = ?'; params.push(mediaType); }
    sql += ' ORDER BY score ASC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params) as CandidateTitle[];
  };

  const runAdversarialQuery = (mediaType: 'movie' | 'tv' | undefined, limit: number, extraIds: number[]): CandidateTitle[] => {
    const [excPh, excIds] = notInClause([...extraExclude, ...extraIds]);
    let sql = `
      SELECT t.*, vec_distance_cosine(t.embedding, ?) AS score
      FROM titles t
      WHERE t.embedding IS NOT NULL
        AND t.id NOT IN (${watchedSubquery})
        AND t.id NOT IN (${excPh})
    `;
    const params: unknown[] = [tasteVec, profileId, ...excIds];
    if (mediaType) { sql += ' AND t.media_type = ?'; params.push(mediaType); }
    sql += ' ORDER BY score DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params) as CandidateTitle[];
  };

  const runWildcardQuery = (mediaType: 'movie' | 'tv' | undefined, limit: number, extraIds: number[]): CandidateTitle[] => {
    const [excPh, excIds] = notInClause([...extraExclude, ...extraIds]);
    let sql = `
      SELECT t.*, vec_distance_cosine(t.embedding, ?) AS score
      FROM titles t
      WHERE t.embedding IS NOT NULL
        AND t.id NOT IN (${watchedSubquery})
        AND t.id NOT IN (${excPh})
    `;
    const params: unknown[] = [tasteVec, profileId, ...excIds];
    if (mediaType) { sql += ' AND t.media_type = ?'; params.push(mediaType); }
    for (const genre of hatedGenres) {
      sql += ' AND t.genres NOT LIKE ?';
      params.push(`%${genre}%`);
    }
    sql += ' ORDER BY RANDOM() LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params) as CandidateTitle[];
  };

  let onTaste: CandidateTitle[];
  let adversarial: CandidateTitle[];
  let wildcards: CandidateTitle[];

  if (opts.mediaType) {
    // ── single media type: original behaviour ──────────────────────────────
    onTaste = runOnTasteQuery(opts.mediaType, 20, []);
    adversarial = runAdversarialQuery(opts.mediaType, 8, onTaste.map(c => c.id));
    wildcards = runWildcardQuery(opts.mediaType, 12, [...onTaste.map(c => c.id), ...adversarial.map(c => c.id)]);
  } else {
    // ── balanced across media types ────────────────────────────────────────
    const onTasteMovies = runOnTasteQuery('movie', 10, []);
    const onTasteTv = runOnTasteQuery('tv', 10, []);
    onTaste = [...onTasteMovies, ...onTasteTv];

    const onTasteIds = onTaste.map(c => c.id);
    const adversarialMovies = runAdversarialQuery('movie', 4, onTasteIds);
    const adversarialTv = runAdversarialQuery('tv', 4, onTasteIds);
    adversarial = [...adversarialMovies, ...adversarialTv];

    const excludeWildcard = [...onTasteIds, ...adversarial.map(c => c.id)];
    const wildcardMovies = runWildcardQuery('movie', 6, excludeWildcard);
    const wildcardTv = runWildcardQuery('tv', 6, excludeWildcard);
    wildcards = [...wildcardMovies, ...wildcardTv];
  }

  return { onTaste, wildcards, adversarial };
}

/**
 * Cold-start candidate pool for a profile that has prefs but NO taste vector yet —
 * a freshly seeded profile that has never rated anything, so refreshTasteVector
 * left taste_vector null. There's nothing to compute cosine distance against, so we
 * fall back to the profile's stated loved_genres, ordered RANDOM (there's no
 * popularity/vote column on titles to rank by), with the hated-genre veto and the
 * watched/exclude filters still applied. This lets a brand-new user bootstrap:
 * /generate surfaces ratable titles, the first ratings build the real taste vector,
 * and subsequent runs use the normal vector path.
 *
 *   onTaste     = RANDOM titles in a loved genre (or general RANDOM when none stated)
 *   wildcards   = general RANDOM titles (minus hated), excluding onTaste
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

  const watchedSubquery = 'SELECT title_id FROM watch_events WHERE profile_id = ?';

  // genres is a JSON array string (e.g. ["Drama","Sci-Fi"]) — match the quoted
  // genre name so "Drama" can't partial-hit a longer genre.
  const runRandomQuery = (
    mediaType: 'movie' | 'tv' | undefined,
    limit: number,
    extraIds: number[],
    lovedOnly: boolean,
  ): CandidateTitle[] => {
    const [excPh, excIds] = notInClause([...extraExclude, ...extraIds]);
    let sql = `
      SELECT t.*, 0 AS score
      FROM titles t
      WHERE t.embedding IS NOT NULL
        AND t.id NOT IN (${watchedSubquery})
        AND t.id NOT IN (${excPh})
    `;
    const params: unknown[] = [profileId, ...excIds];
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
  let onTaste: CandidateTitle[];
  let wildcards: CandidateTitle[];

  if (opts.mediaType) {
    onTaste = runRandomQuery(opts.mediaType, 20, [], hasLoved);
    wildcards = runRandomQuery(opts.mediaType, 12, onTaste.map(c => c.id), false);
  } else {
    const onTasteMovies = runRandomQuery('movie', 10, [], hasLoved);
    const onTasteTv = runRandomQuery('tv', 10, [], hasLoved);
    onTaste = [...onTasteMovies, ...onTasteTv];
    const ex = onTaste.map(c => c.id);
    const wildcardMovies = runRandomQuery('movie', 6, ex, false);
    const wildcardTv = runRandomQuery('tv', 6, ex, false);
    wildcards = [...wildcardMovies, ...wildcardTv];
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
  mediaType: 'movie' | 'tv' | undefined,
  limit: number,
): CandidateTitle[] {
  const extraExclude = opts.excludeTitleIds ?? [];
  const [vetoPh, vetoIds] = notInClause(vetoProfileIds);
  const [excPh, excIds] = notInClause(extraExclude);
  let sql = `
    SELECT t.*, vec_distance_cosine(t.embedding, ?) AS score
    FROM titles t
    WHERE t.embedding IS NOT NULL
      AND t.id NOT IN (SELECT title_id FROM watch_events WHERE profile_id IN (${vetoPh}))
      AND t.id NOT IN (${excPh})
  `;
  const params: unknown[] = [queryBuf, ...vetoIds, ...excIds];
  if (mediaType) { sql += ' AND t.media_type = ?'; params.push(mediaType); }
  sql += ' ORDER BY score ASC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params) as CandidateTitle[];
}

/** Build the query buffer from a base taste vector blended with the embedded request. */
function blendRequestQueryBuf(baseVec: number[], reqVec: number[]): Buffer {
  const queryVec = blendVectors(baseVec, REQUEST_TASTE_WEIGHT, reqVec, REQUEST_WEIGHT);
  return Buffer.from(new Float32Array(queryVec).buffer);
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

  const total = opts.limit ?? 30;
  if (opts.mediaType) return runRequestQuery(db, queryBuf, [profileId], opts, opts.mediaType, total);
  const half = Math.ceil(total / 2);
  const movies = runRequestQuery(db, queryBuf, [profileId], opts, 'movie', half);
  const tv = runRequestQuery(db, queryBuf, [profileId], opts, 'tv', half);
  return [...movies, ...tv];
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

  const total = opts.limit ?? 30;
  if (opts.mediaType) return runRequestQuery(db, queryBuf, vetoIds, opts, opts.mediaType, total);
  const half = Math.ceil(total / 2);
  const movies = runRequestQuery(db, queryBuf, vetoIds, opts, 'movie', half);
  const tv = runRequestQuery(db, queryBuf, vetoIds, opts, 'tv', half);
  return [...movies, ...tv];
}

/**
 * Retrieve a structured candidate pool for the Joint (blended) profile.
 * Uses the same blended-vector + mutual-veto logic as retrieveJointCandidates.
 *
 * When opts.mediaType is unset, produces a balanced split:
 *   onTaste = top 10 movies + top 10 series; adversarial = 4+4; wildcards = 6+6.
 * When opts.mediaType is set, single-type behaviour is unchanged.
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
  const allHated = [...new Set([...(alexPrefs.hated_genres ?? []), ...(samPrefs.hated_genres ?? [])])];

  const extraExclude: number[] = opts.excludeTitleIds ?? [];

  // Exclude titles watched by EITHER person AND by the couple together (so a film
  // they just rated jointly leaves the Picks feed — "it should move into rated").
  const [vetoPh, vetoIds] = notInClause([alexId, samId, ...(jointId != null ? [jointId] : [])]);

  const buildBase = (extraExcludeIds: number[]): [string, unknown[]] => {
    const allExclude = [...extraExclude, ...extraExcludeIds];
    const [excPh, excIds] = notInClause(allExclude);
    const sql = `
      SELECT t.*, vec_distance_cosine(t.embedding, ?) AS score
      FROM titles t
      WHERE t.embedding IS NOT NULL
        AND t.id NOT IN (SELECT title_id FROM watch_events WHERE profile_id IN (${vetoPh}))
        AND t.id NOT IN (${excPh})
    `;
    const params: unknown[] = [blendedBuf, ...vetoIds, ...excIds];
    return [sql, params];
  };

  const runQuery = (
    extraExcludeIds: number[],
    mediaType: 'movie' | 'tv' | undefined,
    orderDir: 'ASC' | 'DESC' | 'RANDOM',
    limit: number,
    extraFilters?: Array<[string, unknown]>,
  ): CandidateTitle[] => {
    let [sql, params] = buildBase(extraExcludeIds);
    if (mediaType) { sql += ' AND t.media_type = ?'; params.push(mediaType); }
    if (extraFilters) {
      for (const [clause, val] of extraFilters) {
        sql += ` ${clause}`;
        params.push(val);
      }
    }
    if (orderDir === 'RANDOM') sql += ' ORDER BY RANDOM()';
    else sql += ` ORDER BY score ${orderDir}`;
    sql += ' LIMIT ?'; params.push(limit);
    return db.prepare(sql).all(...params) as CandidateTitle[];
  };

  const hatedFilters: Array<[string, unknown]> = allHated.map(g => [`AND t.genres NOT LIKE ?`, `%${g}%`]);

  let onTaste: CandidateTitle[];
  let adversarial: CandidateTitle[];
  let wildcards: CandidateTitle[];

  if (opts.mediaType) {
    // ── single media type: original behaviour ──────────────────────────────
    onTaste = runQuery([], opts.mediaType, 'ASC', 20);
    adversarial = runQuery(onTaste.map(c => c.id), opts.mediaType, 'DESC', 8);
    wildcards = runQuery(
      [...onTaste.map(c => c.id), ...adversarial.map(c => c.id)],
      opts.mediaType, 'RANDOM', 12, hatedFilters,
    );
  } else {
    // ── balanced across media types ────────────────────────────────────────
    const onTasteMovies = runQuery([], 'movie', 'ASC', 10);
    const onTasteTv = runQuery([], 'tv', 'ASC', 10);
    onTaste = [...onTasteMovies, ...onTasteTv];

    const onTasteIds = onTaste.map(c => c.id);
    const adversarialMovies = runQuery(onTasteIds, 'movie', 'DESC', 4);
    const adversarialTv = runQuery(onTasteIds, 'tv', 'DESC', 4);
    adversarial = [...adversarialMovies, ...adversarialTv];

    const excludeWildcard = [...onTasteIds, ...adversarial.map(c => c.id)];
    const wildcardMovies = runQuery(excludeWildcard, 'movie', 'RANDOM', 6, hatedFilters);
    const wildcardTv = runQuery(excludeWildcard, 'tv', 'RANDOM', 6, hatedFilters);
    wildcards = [...wildcardMovies, ...wildcardTv];
  }

  return { onTaste, wildcards, adversarial };
}
