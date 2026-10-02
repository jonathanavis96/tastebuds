/**
 * New rows store ISO-8601 UTC timestamps (the JS toISOString format). Older rows
 * hold SQLite's "YYYY-MM-DD HH:MM:SS"; readers must order the two correctly.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { upsertProfile } from './profiles.js';
import { upsertTitle } from './titles.js';
import { upsertWatchEvent, getWatchEvents } from './watchEvents.js';
import { upsertRecommendation, getRecommendations } from './recommendations.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function setup() {
  const db = new Database(':memory:');
  runMigrations(db);
  upsertProfile(db, { name: 'Alex', media_weighting: 0.5, is_derived: 0, config: '{}' });
  for (let i = 1; i <= 2; i++) {
    upsertTitle(db, {
      tmdb_id: i, media_type: 'movie', title: `T${i}`, year: 2020, genres: '[]',
      keywords: '[]', cast: '[]', synopsis: 's', poster_path: null, embedding: null,
      updated_at: new Date().toISOString(),
    });
  }
  return db;
}

describe('timestamp format', () => {
  it('new watch_events and recommendations rows use ISO UTC', () => {
    const db = setup();
    upsertWatchEvent(db, { profile_id: 1, title_id: 1, status: 'watchlist', rating: null, watched_at: null });
    upsertRecommendation(db, {
      profile_id: 1, title_id: 1, category: 'c', score: 1, why_blurb: 'w', request_text: null, state: 'pending',
    });
    expect(getWatchEvents(db, 1)[0].created_at).toMatch(ISO);
    expect(getRecommendations(db, 1)[0].created_at).toMatch(ISO);
  });

  it('fresh schema default is ISO UTC', () => {
    const db = setup();
    db.prepare("INSERT INTO watch_events (profile_id, title_id, status) VALUES (1, 2, 'watchlist')").run();
    const row = db.prepare('SELECT created_at FROM watch_events WHERE title_id = 2').get() as { created_at: string };
    expect(row.created_at).toMatch(ISO);
  });

  it('readers order old and new formats by actual time', () => {
    const db = setup();
    // Old format, later in time; new format, earlier in time, same day.
    db.prepare("INSERT INTO watch_events (profile_id, title_id, status, created_at) VALUES (1, 1, 'watchlist', '2026-10-01 20:00:00')").run();
    db.prepare("INSERT INTO watch_events (profile_id, title_id, status, created_at) VALUES (1, 2, 'watchlist', '2026-10-01T08:00:00.000Z')").run();
    expect(getWatchEvents(db, 1).map(e => e.title_id)).toEqual([1, 2]);

    for (const [t, at] of [[1, '2026-10-01 20:00:00'], [2, '2026-10-01T08:00:00.000Z']] as const) {
      db.prepare("INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, state, created_at) VALUES (1, ?, 'c', 1, 'w', 'pending', ?)").run(t, at);
    }
    expect(getRecommendations(db, 1, 'pending').map(r => r.title_id)).toEqual([1, 2]);
  });
});
