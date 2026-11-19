/**
 * recommendations repo stores what a request was understood to mean
 * (request_summary) and why a pick is an exception to it (rule_note).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { upsertProfile } from './profiles.js';
import { upsertTitle } from './titles.js';
import { upsertRecommendation, getRecommendations } from './recommendations.js';
import type { RequestSummary } from '../../request/rules.js';

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
  for (const tmdbId of [1, 2]) {
    upsertTitle(db, {
      tmdb_id: tmdbId, media_type: 'movie', title: `Film ${tmdbId}`, year: 2024, genres: '["Thriller"]',
      keywords: '[]', cast: '[]', synopsis: 's', poster_path: null, embedding: null, updated_at: '2026-01-01',
    });
  }
  return db;
}

const pick = { profile_id: 1, category: 'Top pick', score: 0.8, why_blurb: 'w', request_text: 'thriller', state: 'pending' as const };

describe('recommendations repo — request summary and rule note', () => {
  it('stores the request summary and rule note given with a pick', () => {
    const db = createTestDb();
    const summary: RequestSummary = { text: 'thriller', understood: ['Thriller', '2021 or newer'], matched: 7, note: 'Only 7 titles match.' };
    upsertRecommendation(db, {
      ...pick, title_id: 1,
      request_summary: JSON.stringify(summary),
      rule_note: 'Released 2014: too few recent thrillers matched.',
    });

    const [row] = getRecommendations(db, 1, 'pending');
    expect(JSON.parse(row.request_summary!)).toEqual(summary);
    expect(row.rule_note).toBe('Released 2014: too few recent thrillers matched.');
  });

  it('stores null for both when a pick is made without them', () => {
    const db = createTestDb();
    upsertRecommendation(db, { ...pick, title_id: 2 });

    const [row] = getRecommendations(db, 1, 'pending');
    expect(row.request_summary).toBeNull();
    expect(row.rule_note).toBeNull();
  });
});
