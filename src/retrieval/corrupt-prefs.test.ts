/**
 * A corrupt prefs row must not crash prompt building or retrieval: it falls
 * back to empty prefs and logs a warning.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertTasteSignature } from '../db/repos/tasteSignatures.js';
import {
  retrieveColdStartPool,
  retrieveJointCandidatePool,
  retrieveJointRequestCandidates,
  retrieveCandidatePool,
} from './retrieve.js';
import { buildCurationPrompt } from '../curation/prompt.js';
import { genreAffinityForProfile } from './rerank.js';
import type { ProfileRow, TasteSignatureRow } from '../db/types.js';

const cfg = { ollamaUrl: 'http://localhost:9' };
const BAD = '{not json';

function oneHot(i: number, dim = 8): Buffer {
  const a = new Float32Array(dim); a[i] = 1; return Buffer.from(a.buffer);
}

function setup() {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  runMigrations(db);
  const ids: number[] = [];
  for (const name of ['Alex', 'Sam']) {
    upsertProfile(db, { name, media_weighting: 0.5, is_derived: 0, config: '{}' });
    const id = (db.prepare('SELECT id FROM profiles WHERE name=?').get(name) as { id: number }).id;
    upsertTasteSignature(db, { profile_id: id, taste_vector: oneHot(1), prefs: BAD, refreshed_at: new Date().toISOString() });
    ids.push(id);
  }
  for (let i = 0; i < 4; i++) {
    upsertTitle(db, {
      tmdb_id: 700 + i, media_type: 'movie', title: `C${i}`, year: 2020, genres: '["Drama"]',
      keywords: '[]', cast: '[]', synopsis: 's', poster_path: null,
      embedding: oneHot(i), updated_at: new Date().toISOString(),
    });
  }
  return { db, a: ids[0], b: ids[1] };
}

const embed = async () => Array.from(new Float32Array(oneHot(1).buffer));

describe('corrupt prefs row', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retrieval falls back to empty prefs and logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, a, b } = setup();
    expect((await retrieveCandidatePool(db, a, {}, cfg)).onTaste.length).toBeGreaterThan(0);
    expect((await retrieveColdStartPool(db, a, {}, cfg)).onTaste.length).toBeGreaterThan(0);
    expect((await retrieveJointCandidatePool(db, a, b, {}, cfg)).onTaste.length).toBeGreaterThan(0);
    expect((await retrieveJointRequestCandidates(db, a, b, 'x', {}, cfg, embed)).length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
  });

  it('prompt building falls back to empty prefs and logs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const profile = { id: 1, name: 'Alex', media_weighting: 0.5, is_derived: 0, config: '{}' } as unknown as ProfileRow;
    const sig = { profile_id: 1, taste_vector: null, prefs: BAD, refreshed_at: '' } as unknown as TasteSignatureRow;
    const prompt = buildCurationPrompt([], profile, sig, null);
    expect(prompt).toContain('Hated genres: none');
    expect(warn).toHaveBeenCalled();
  });

  it('genre affinity falls back to empty prefs', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, a } = setup();
    expect(genreAffinityForProfile(db, a)).toEqual({});
  });
});
