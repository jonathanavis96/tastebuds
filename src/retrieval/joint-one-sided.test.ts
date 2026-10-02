/**
 * Joint retrieval with only one partner's taste vector falls back to that
 * partner; it returns nothing only when neither partner has one.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import {
  retrieveJointCandidatePool,
  retrieveJointRequestCandidates,
  retrieveJointCandidates,
} from './retrieve.js';

const cfg = { ollamaUrl: 'http://localhost:9' };

function oneHot(i: number, dim = 8): Buffer {
  const a = new Float32Array(dim); a[i] = 1; return Buffer.from(a.buffer);
}

function setup(alexVec: Buffer | null, samVec: Buffer | null) {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  runMigrations(db);
  const ids: number[] = [];
  for (const [name, vec] of [['Alex', alexVec], ['Sam', samVec]] as const) {
    upsertProfile(db, { name, media_weighting: 0.5, is_derived: 0, config: '{}' });
    const id = (db.prepare('SELECT id FROM profiles WHERE name=?').get(name) as { id: number }).id;
    upsertTasteSignature(db, { profile_id: id, taste_vector: vec, prefs: '{}', refreshed_at: new Date().toISOString() });
    ids.push(id);
  }
  for (let i = 0; i < 8; i++) {
    upsertTitle(db, {
      tmdb_id: 900 + i, media_type: 'movie', title: `F${i}`, year: 2020, genres: '["Drama"]',
      keywords: '[]', cast: '[]', synopsis: 's', poster_path: null,
      embedding: oneHot(i), updated_at: new Date().toISOString(),
    });
  }
  return { db, a: ids[0], b: ids[1] };
}

const embed = async () => Array.from(new Float32Array(oneHot(3).buffer));

describe('Joint retrieval with one partner missing a taste vector', () => {
  it('pool ranks by the partner who has a vector', async () => {
    const { db, a, b } = setup(null, oneHot(5));
    const pool = await retrieveJointCandidatePool(db, a, b, { mediaType: 'movie' }, cfg);
    expect(pool.onTaste[0]?.title).toBe('F5');
  });

  it('request path and joint candidates also fall back', async () => {
    const { db, a, b } = setup(oneHot(2), null);
    expect((await retrieveJointRequestCandidates(db, a, b, 'x', { mediaType: 'movie' }, cfg, embed)).length).toBeGreaterThan(0);
    expect((await retrieveJointCandidates(db, a, b, {}, cfg))[0]?.title).toBe('F2');
  });

  it('returns nothing when neither partner has a vector', async () => {
    const { db, a, b } = setup(null, null);
    const pool = await retrieveJointCandidatePool(db, a, b, {}, cfg);
    expect(pool.onTaste).toEqual([]);
    expect(await retrieveJointRequestCandidates(db, a, b, 'x', {}, cfg, embed)).toEqual([]);
    expect(await retrieveJointCandidates(db, a, b, {}, cfg)).toEqual([]);
  });
});
