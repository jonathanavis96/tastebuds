import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import { putCachedEmbedding } from '../db/repos/embeddingCache.js';
import { createHash } from 'node:crypto';
import { NEIGHBOUR_K, neighbourDistance, blendedNeighbourDistance, loadTasteNeighbours, unitVec } from './neighbours.js';

const SEL = { likedMin: 4, dislikedMax: 2, oneStar: 1, twoStar: 0.5, dismissed: 0.3 };
const v = (...xs: number[]) => unitVec(Float32Array.from(xs));

describe('neighbourDistance', () => {
  it('is null with no liked titles', () => {
    expect(neighbourDistance({ liked: [], negatives: [] }, v(1, 0))).toBeNull();
  });

  it('scores a title close to ONE liked cluster as near, where an averaged vector would not', () => {
    // Two opposite tastes (more titles each than NEIGHBOUR_K): their mean points nowhere.
    const cluster = (sign: number) => Array.from({ length: NEIGHBOUR_K + 1 }, (_, i) => v(sign, 0.01 * i));
    const n = { liked: [...cluster(1), ...cluster(-1)], negatives: [] };
    const nearCluster = neighbourDistance(n, v(1, 0.1))!;
    const between = neighbourDistance(n, v(0, 1))!;
    expect(nearCluster).toBeLessThan(between);
  });

  it('pushes a title near a disliked one further away', () => {
    const liked = [v(1, 1)];
    const clean = neighbourDistance({ liked, negatives: [] }, v(1, 0))!;
    const nearNo = neighbourDistance({ liked, negatives: [{ weight: 1, vec: v(1, 0) }] }, v(1, 0))!;
    expect(nearNo).toBeGreaterThan(clean);
  });

  it('blends profiles by weight and skips one with nothing liked', () => {
    const a = { liked: [v(1, 0)], negatives: [] };
    const empty = { liked: [], negatives: [] };
    const t = v(1, 0);
    expect(blendedNeighbourDistance([{ neighbours: a, weight: 0.3 }, { neighbours: empty, weight: 0.7 }], t))
      .toBeCloseTo(neighbourDistance(a, t)!, 6);
  });
});

describe('loadTasteNeighbours', () => {
  it('selects liked, disliked and dismissed titles like the taste vector does, rating before dismissal', () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);
    upsertProfile(db, { name: 'P', media_weighting: 0.5, is_derived: 0, config: '{}' });
    const pid = (db.prepare('SELECT id FROM profiles').get() as { id: number }).id;
    const title = (n: number, vec: number[]) => {
      upsertTitle(db, {
        tmdb_id: n, media_type: 'movie', title: `t${n}`, year: 2015, genres: '[]', keywords: '[]', cast: '[]',
        synopsis: null, poster_path: null, embedding: Buffer.from(new Float32Array(vec).buffer), updated_at: '',
      });
      return (db.prepare('SELECT id FROM titles WHERE tmdb_id = ?').get(n) as { id: number }).id;
    };
    const liked = title(1, [1, 0]);
    const neutral = title(2, [0, 1]);
    const oneStar = title(3, [-1, 0]);
    const dismissedOnly = title(4, [0, -1]);
    upsertWatchEvent(db, { profile_id: pid, title_id: liked, status: 'watched', rating: 5, watched_at: null });
    upsertWatchEvent(db, { profile_id: pid, title_id: neutral, status: 'watched', rating: 3, watched_at: null });
    upsertWatchEvent(db, { profile_id: pid, title_id: oneStar, status: 'watched', rating: 1, watched_at: null });
    const dismiss = (tid: number) => db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, state)
      VALUES (?, ?, 'core', 0, '', 'dismissed')`).run(pid, tid);
    dismiss(neutral); // rated 3★: the rating wins, so no negative
    dismiss(dismissedOnly);

    const n = loadTasteNeighbours(db, pid, SEL);
    expect(n.liked).toHaveLength(1);
    expect(n.negatives.map(x => x.weight).sort()).toEqual([0.3, 1]);
  });

  it('uses the cached embedding for a title with no stored embedding, rated or dismissed', () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    runMigrations(db);
    upsertProfile(db, { name: 'P', media_weighting: 0.5, is_derived: 0, config: '{}' });
    const pid = (db.prepare('SELECT id FROM profiles').get() as { id: number }).id;
    const title = (n: number, synopsis: string) => {
      upsertTitle(db, {
        tmdb_id: n, media_type: 'movie', title: `t${n}`, year: 2015, genres: '[]', keywords: '[]', cast: '[]',
        synopsis, poster_path: null, embedding: null, updated_at: '',
      });
      const hash = createHash('sha256').update(`t${n} — ${synopsis}`).digest('hex');
      putCachedEmbedding(db, hash, Buffer.from(new Float32Array([n, 1]).buffer));
      return (db.prepare('SELECT id FROM titles WHERE tmdb_id = ?').get(n) as { id: number }).id;
    };
    const liked = title(1, 'a');
    const disliked = title(2, 'b');
    const dismissed = title(3, 'c');
    upsertWatchEvent(db, { profile_id: pid, title_id: liked, status: 'watched', rating: 5, watched_at: null });
    upsertWatchEvent(db, { profile_id: pid, title_id: disliked, status: 'watched', rating: 1, watched_at: null });
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, state)
      VALUES (?, ?, 'core', 0, '', 'dismissed')`).run(pid, dismissed);

    const n = loadTasteNeighbours(db, pid, SEL);
    expect(n.liked).toHaveLength(1);
    expect(n.negatives.map(x => x.weight).sort()).toEqual([0.3, 1]);
  });
});
