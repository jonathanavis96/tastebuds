/**
 * TDD test — recommendations repo round-trips the `kind` column.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { upsertProfile } from './profiles.js';
import { upsertTitle } from './titles.js';
import { upsertRecommendation, getRecommendations } from './recommendations.js';

const baseTitle = {
  tmdb_id: 77701,
  media_type: 'movie' as const,
  title: 'Kind Test Film',
  year: 2024,
  genres: '["Drama"]',
  keywords: '[]',
  cast: '[]',
  synopsis: 'A test.',
  poster_path: null,
  embedding: null,
  updated_at: new Date().toISOString(),
};

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('recommendations repo — kind column', () => {
  it('upsertRecommendation round-trips kind="core"', () => {
    const db = createTestDb();
    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    upsertTitle(db, baseTitle);

    upsertRecommendation(db, {
      profile_id: 1, title_id: 1,
      category: 'Top pick', score: 0.9,
      why_blurb: 'Great', request_text: null,
      state: 'pending', kind: 'core',
    });

    const recs = getRecommendations(db, 1);
    expect(recs[0].kind).toBe('core');
  });

  it('upsertRecommendation round-trips kind="wildcard"', () => {
    const db = createTestDb();
    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    upsertTitle(db, baseTitle);

    upsertRecommendation(db, {
      profile_id: 1, title_id: 1,
      category: 'Surprise', score: 0.5,
      why_blurb: 'Off-profile', request_text: null,
      state: 'pending', kind: 'wildcard',
    });

    const recs = getRecommendations(db, 1);
    expect(recs[0].kind).toBe('wildcard');
  });

  it('upsertRecommendation round-trips kind="adversarial"', () => {
    const db = createTestDb();
    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    upsertTitle(db, baseTitle);

    upsertRecommendation(db, {
      profile_id: 1, title_id: 1,
      category: 'Adversarial', score: 0.2,
      why_blurb: 'You will dislike this', request_text: null,
      state: 'pending', kind: 'adversarial',
    });

    const recs = getRecommendations(db, 1);
    expect(recs[0].kind).toBe('adversarial');
  });

  it('kind defaults to "core" when omitted', () => {
    const db = createTestDb();
    upsertProfile(db, { name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' });
    upsertTitle(db, baseTitle);

    // Insert without kind via raw SQL (simulates old code path / migration default)
    db.prepare(`
      INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state)
      VALUES (1, 1, 'Top pick', 0.8, 'Nice', null, 'pending')
    `).run();

    const recs = getRecommendations(db, 1);
    expect(recs[0].kind).toBe('core');
  });
});
