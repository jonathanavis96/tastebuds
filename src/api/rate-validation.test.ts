import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { createApiRoutes } from './routes.js';
import type { Config } from '../config.js';

const config: Config = {
  tmdbApiKey: 'test', ollamaUrl: 'http://127.0.0.1:9', claudeToken: 'x', port: 0, dbPath: ':memory:',
  omdbApiKey: undefined, harvestDailyTarget: 1, requestLookupDailyBudget: 1, harvestMaxPage: 1,
};

function app() {
  const db = new Database(':memory:');
  runMigrations(db);
  upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
  db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, genres, keywords, cast, updated_at)
    VALUES (1, 'movie', 'T', '[]', '[]', '[]', 'now')`).run();
  return new Hono().route('/api', createApiRoutes(db, config));
}

const post = (a: Hono, path: string, body: unknown) =>
  a.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('rating validation', () => {
  for (const rating of ['4', 'abc', 3.3, true]) {
    it(`/rate rejects ${JSON.stringify(rating)} with 400`, async () => {
      const res = await post(app(), '/api/rate', { profileId: 1, titleId: 1, rating });
      expect(res.status).toBe(400);
    });
  }
  for (const rating of [0, 7, 'x', 2.2]) {
    it(`/mark-watched rejects ${JSON.stringify(rating)} with 400`, async () => {
      const res = await post(app(), '/api/mark-watched', { profileId: 1, titleId: 1, rating });
      expect(res.status).toBe(400);
    });
  }
});
