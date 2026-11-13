/**
 * Loads a COPY of a TasteBuds database into memory for the offline taste test.
 * The database is opened read-only; nothing here writes to it.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { parsePrefs, type PrefsJson } from '../retrieval/prefs.js';
import { parseTimestamp } from './time.js';

export interface EvalTitle {
  id: number;
  title: string;
  media_type: 'movie' | 'tv';
  genresJson: string;
  genres: string[];
  keywords: string[];
  /** The title's stored embedding, unit length. */
  vec: Float32Array;
  vote_average: number | null;
  vote_count: number | null;
  popularity: number | null;
}

export interface EvalEvent {
  titleId: number;
  /** Star rating, or null for a "Not interested" dismissal. */
  rating: number | null;
  /** Embedding used for the taste vector: note-aware when a note exists and is cached. */
  vec: Float32Array;
  time: number;
  order: number;
}

export interface EvalProfile {
  id: number;
  name: string;
  isDerived: boolean;
  prefs: PrefsJson;
  events: EvalEvent[];
}

export interface EvalData {
  profiles: EvalProfile[];
  titles: Map<number, EvalTitle>;
  /** Notes whose note-aware embedding was not in embedding_cache (fell back to the title embedding). */
  noteMisses: number;
}

function toVec(buf: Buffer): Float32Array {
  const v = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  return unit(v);
}

export function unit(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function parseList(json: string | null): string[] {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function loadEvalData(dbPath: string): EvalData {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const titles = new Map<number, EvalTitle>();
    const titleStmt = db.prepare(`SELECT id, title, media_type, genres, keywords, synopsis, embedding,
      vote_average, vote_count, popularity FROM titles WHERE id = ?`);
    const cacheStmt = db.prepare('SELECT vec FROM embedding_cache WHERE text_hash = ?');
    let noteMisses = 0;

    const getTitle = (id: number): { t: EvalTitle; synopsis: string | null } | null => {
      const r = titleStmt.get(id) as Record<string, unknown> | undefined;
      if (!r || !r.embedding) return null;
      const t: EvalTitle = {
        id,
        title: r.title as string,
        media_type: r.media_type as 'movie' | 'tv',
        genresJson: (r.genres as string) ?? '[]',
        genres: parseList(r.genres as string),
        keywords: parseList(r.keywords as string),
        vec: toVec(r.embedding as Buffer),
        vote_average: r.vote_average as number | null,
        vote_count: r.vote_count as number | null,
        popularity: r.popularity as number | null,
      };
      titles.set(id, t);
      return { t, synopsis: r.synopsis as string | null };
    };

    const profiles: EvalProfile[] = [];
    const profRows = db.prepare('SELECT id, name, is_derived FROM profiles ORDER BY id').all() as Array<{
      id: number; name: string; is_derived: number;
    }>;
    for (const p of profRows) {
      const sig = db.prepare('SELECT prefs FROM taste_signatures WHERE profile_id = ?').get(p.id) as
        { prefs: string } | undefined;
      const events: EvalEvent[] = [];
      const seen = new Set<number>();
      const rated = db.prepare(`SELECT id, title_id, rating, note, created_at FROM watch_events
        WHERE profile_id = ? AND rating IS NOT NULL`).all(p.id) as Array<{
        id: number; title_id: number; rating: number; note: string | null; created_at: string;
      }>;
      for (const ev of rated) {
        const got = getTitle(ev.title_id);
        if (!got) continue;
        let vec = got.t.vec;
        if (ev.note) {
          const text = [got.t.title, got.synopsis, ev.note].filter(Boolean).join(' — ');
          const hash = createHash('sha256').update(text).digest('hex');
          const cached = cacheStmt.get(hash) as { vec: Buffer } | undefined;
          if (cached) vec = toVec(cached.vec);
          else noteMisses++;
        }
        seen.add(ev.title_id);
        events.push({ titleId: ev.title_id, rating: ev.rating, vec, time: parseTimestamp(ev.created_at), order: ev.id });
      }
      const dismissed = db.prepare(`SELECT id, title_id, created_at FROM recommendations
        WHERE profile_id = ? AND state = 'dismissed'`).all(p.id) as Array<{
        id: number; title_id: number; created_at: string;
      }>;
      for (const d of dismissed) {
        if (seen.has(d.title_id)) continue; // a rating outranks a dismissal of the same title
        const got = getTitle(d.title_id);
        if (!got) continue;
        seen.add(d.title_id);
        // Offset so a dismissal never shares an order key with a rating.
        events.push({ titleId: d.title_id, rating: null, vec: got.t.vec, time: parseTimestamp(d.created_at), order: 1e9 + d.id });
      }
      events.sort((a, b) => a.time - b.time || a.order - b.order);
      profiles.push({ id: p.id, name: p.name, isDerived: p.is_derived === 1, prefs: parsePrefs(sig?.prefs), events });
    }
    return { profiles, titles, noteMisses };
  } finally {
    db.close();
  }
}
