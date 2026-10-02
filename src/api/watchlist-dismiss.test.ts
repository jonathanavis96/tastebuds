import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { upsertProfile } from '../db/repos/profiles.js';
import { upsertWatchEvent, getWatchEvent } from '../db/repos/watchEvents.js';
import { createApiRoutes } from './routes.js';
import type { Config } from '../config.js';

// Port 9 is unreachable on purpose: these tests must never reach a real Ollama.
const config: Config = {
  tmdbApiKey: 'test', ollamaUrl: 'http://127.0.0.1:9', claudeToken: 'x', port: 0, dbPath: ':memory:',
  omdbApiKey: undefined, harvestDailyTarget: 1, requestLookupDailyBudget: 1, harvestMaxPage: 1,
};

function setup() {
  const db = new Database(':memory:');
  runMigrations(db);
  upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
  upsertProfile(db, { name: 'Sam', media_weighting: 0.3, is_derived: 0, config: '{}' });
  db.prepare(`INSERT INTO titles (tmdb_id, media_type, title, genres, keywords, cast, updated_at)
    VALUES (1, 'movie', 'T', '[]', '[]', '[]', 'now')`).run();
  return { db, app: new Hono().route('/api', createApiRoutes(db, config)) };
}

const post = (a: Hono, path: string, body: unknown) =>
  a.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/watchlist on a title already rated', () => {
  it('keeps the rating and watched status', async () => {
    const { db, app } = setup();
    upsertWatchEvent(db, { profile_id: 1, title_id: 1, status: 'watched', rating: 4.5, watched_at: '2026-01-01T00:00:00Z' });
    const res = await post(app, '/api/watchlist', { profileId: 1, titleId: 1 });
    expect(res.status).toBe(200);
    const ev = getWatchEvent(db, 1, 1)!;
    expect(ev.rating).toBe(4.5);
    expect(ev.status).toBe('watched');
    expect(ev.watched_at).toBe('2026-01-01T00:00:00Z');
  });
});

describe('POST /api/dismiss ownership', () => {
  it("returns 404 and leaves another profile's recommendation untouched", async () => {
    const { db, app } = setup();
    db.prepare(`INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, created_at)
      VALUES (1, 1, 'Top pick', 0.9, 'x', null, 'pending', datetime('now'))`).run();
    const recId = (db.prepare('SELECT id FROM recommendations').get() as { id: number }).id;
    const res = await post(app, '/api/dismiss', { profileId: 2, recommendationId: recId });
    expect(res.status).toBe(404);
    const rec = db.prepare('SELECT state FROM recommendations WHERE id=?').get(recId) as { state: string };
    expect(rec.state).toBe('pending');
  });
});
