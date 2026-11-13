/**
 * Nearest-neighbour taste similarity.
 *
 * The taste vector averages every liked title into one direction. Someone who
 * loves both slow dramas and horror ends up pointing between the two, near
 * neither. Here a candidate is instead compared with the liked titles it is
 * closest to: its similarity is the mean of its K best matches among the
 * profile's liked titles, minus NEIGHBOUR_NEG_WEIGHT × the mean of its K best
 * matches among the disliked and dismissed ones (each weighted like the taste
 * vector weights them). In the offline taste test (src/eval) this ordered
 * hidden titles better than the averaged vector in every repeat, for every profile.
 *
 * Used at rerank time on the candidates the vector search already fetched, so
 * the cost is a few hundred dot products per candidate. Database-only: note
 * embeddings are read from embedding_cache and never computed here.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export interface TasteNeighbours {
  liked: Float32Array[];
  negatives: Array<{ weight: number; vec: Float32Array }>;
}

/** How many nearest titles on each side are averaged. */
export const NEIGHBOUR_K = 5;
/** How hard the nearest disliked titles pull a candidate down (mirrors NEGATIVE_WEIGHT). */
export const NEIGHBOUR_NEG_WEIGHT = 0.6;

/** A unit-length copy of a stored Float32 embedding (Buffer) or vector. */
export function unitVec(v: Buffer | Float32Array): Float32Array {
  const src = v instanceof Float32Array
    ? v
    : new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.length));
  let s = 0;
  for (const x of src) s += x * x;
  const n = Math.sqrt(s);
  const out = new Float32Array(src.length);
  if (n === 0 || !Number.isFinite(n)) return out;
  for (let i = 0; i < src.length; i++) out[i] = src[i] / n;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function meanTopK(values: number[], k: number): number {
  if (values.length === 0) return 0;
  const top = values.sort((x, y) => y - x).slice(0, k);
  return top.reduce((s, x) => s + x, 0) / top.length;
}

/**
 * A distance-like score for a unit-length title embedding (lower = closer), so it
 * drops into rerank's similarity slot unchanged. Null when there are no liked titles.
 */
export function neighbourDistance(n: TasteNeighbours, vec: Float32Array): number | null {
  if (n.liked.length === 0) return null;
  const pos = meanTopK(n.liked.map(v => dot(v, vec)), NEIGHBOUR_K);
  const neg = meanTopK(n.negatives.map(x => x.weight * dot(x.vec, vec)), NEIGHBOUR_K);
  return 1 - (pos - NEIGHBOUR_NEG_WEIGHT * neg);
}

/** Weighted mean of several profiles' neighbour distances (Joint), skipping any with no liked titles. */
export function blendedNeighbourDistance(
  parts: Array<{ neighbours: TasteNeighbours; weight: number }>,
  vec: Float32Array,
): number | null {
  let sum = 0;
  let total = 0;
  for (const p of parts) {
    const d = neighbourDistance(p.neighbours, vec);
    if (d == null || !(p.weight > 0)) continue;
    sum += p.weight * d;
    total += p.weight;
  }
  return total > 0 ? sum / total : null;
}

interface EventRow {
  title_id: number;
  rating: number | null;
  note: string | null;
  title: string;
  synopsis: string | null;
  embedding: Buffer | null;
}

/**
 * The liked and disliked titles of a profile, chosen and weighted exactly as
 * refreshTasteVector chooses them (liked ≥ likedMin; disliked ≤ dislikedMax, 1★
 * stronger than 2★; "Not interested" milder still; a rating outranks a dismissal).
 * A rating with a note uses the note-aware embedding when it is cached, else the
 * title's own embedding.
 */
export function loadTasteNeighbours(
  db: InstanceType<typeof Database>,
  profileId: number,
  w: { likedMin: number; dislikedMax: number; oneStar: number; twoStar: number; dismissed: number },
): TasteNeighbours {
  const rated = db.prepare(`
    SELECT we.title_id, we.rating, we.note, t.title, t.synopsis, t.embedding
    FROM watch_events we JOIN titles t ON t.id = we.title_id
    WHERE we.profile_id = ? AND we.rating IS NOT NULL
  `).all(profileId) as EventRow[];
  const cache = db.prepare('SELECT vec FROM embedding_cache WHERE text_hash = ?');
  const vecFor = (r: EventRow): Float32Array | null => {
    if (r.note) {
      const text = [r.title, r.synopsis, r.note].filter(Boolean).join(' — ');
      const hit = cache.get(createHash('sha256').update(text).digest('hex')) as { vec: Buffer } | undefined;
      if (hit) return unitVec(hit.vec);
    }
    return r.embedding ? unitVec(r.embedding) : null;
  };

  const out: TasteNeighbours = { liked: [], negatives: [] };
  const seen = new Set<number>();
  for (const r of rated) {
    // Any rating, even a neutral 3★, outranks a dismissal of the same title.
    seen.add(r.title_id);
    const rating = r.rating as number;
    if (rating < w.likedMin && rating > w.dislikedMax) continue;
    const vec = vecFor(r);
    if (!vec) continue;
    if (rating >= w.likedMin) out.liked.push(vec);
    else out.negatives.push({ weight: rating <= 1.5 ? w.oneStar : w.twoStar, vec });
  }
  const dismissed = db.prepare(`
    SELECT DISTINCT r.title_id, t.embedding
    FROM recommendations r JOIN titles t ON t.id = r.title_id
    WHERE r.profile_id = ? AND r.state = 'dismissed'
  `).all(profileId) as Array<{ title_id: number; embedding: Buffer | null }>;
  for (const d of dismissed) {
    if (seen.has(d.title_id) || !d.embedding) continue;
    seen.add(d.title_id);
    out.negatives.push({ weight: w.dismissed, vec: unitVec(d.embedding) });
  }
  return out;
}
