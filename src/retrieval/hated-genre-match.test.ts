/**
 * Hated genres must match a title's genre exactly (case-insensitive), in every
 * retrieval query: hating "Action" must not drop "Action & Adventure".
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import {
  hatedGenreClause,
  retrieveColdStartPool,
  retrieveJointCandidates,
  type CandidatePool,
} from './retrieve.js';

const cfg = { ollamaUrl: 'http://localhost:9' };

function oneHot(i: number, dim = 8): Buffer {
  const a = new Float32Array(dim); a[i] = 1; return Buffer.from(a.buffer);
}

const GENRES: Record<string, string> = {
  'Plain Action': '["action"]',
  'Action Adventure': '["Action & Adventure"]',
  'War Film': '["War"]',
  'War Politics': '["War & Politics"]',
  'Drama Film': '["Drama"]',
};

function setup(withVectors: boolean) {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  runMigrations(db);
  const prefs = JSON.stringify({ hated_genres: ['Action', 'war'] });
  const ids: number[] = [];
  for (const name of ['Alex', 'Sam']) {
    upsertProfile(db, { name, media_weighting: 0.5, is_derived: 0, config: '{}' });
    const id = (db.prepare('SELECT id FROM profiles WHERE name=?').get(name) as { id: number }).id;
    upsertTasteSignature(db, {
      profile_id: id, taste_vector: withVectors ? oneHot(0) : null, prefs,
      refreshed_at: new Date().toISOString(),
    });
    ids.push(id);
  }
  let n = 0;
  for (const [title, genres] of Object.entries(GENRES)) {
    upsertTitle(db, {
      tmdb_id: 500 + n, media_type: 'movie', title, year: 2020, genres,
      keywords: '[]', cast: '[]', synopsis: 's', poster_path: null,
      embedding: oneHot(n++ % 8), updated_at: new Date().toISOString(),
    });
  }
  return { db, ids };
}

const titles = (rows: { title: string }[]) => rows.map(r => r.title).sort();
const poolTitles = (p: CandidatePool) => titles([...p.onTaste, ...p.wildcards]);
const EXPECTED = ['Action Adventure', 'Drama Film', 'War Politics'];

describe('hated genre match is exact and case-insensitive', () => {
  it('shared clause used by the solo and Joint pool query', () => {
    const { db } = setup(true);
    const c = hatedGenreClause(['Action', 'war']);
    const rows = db.prepare(`SELECT t.title FROM titles t WHERE 1=1${c.sql}`).all(...c.params) as { title: string }[];
    expect(titles(rows)).toEqual(EXPECTED);
  });

  it('joint candidates query', async () => {
    const { db, ids } = setup(true);
    const rows = await retrieveJointCandidates(db, ids[0], ids[1], {}, cfg);
    expect(titles(rows)).toEqual(EXPECTED);
  });

  it('cold-start query', async () => {
    const { db, ids } = setup(false);
    const pool = await retrieveColdStartPool(db, ids[0], {}, cfg);
    expect(poolTitles(pool)).toEqual(EXPECTED);
  });
});
