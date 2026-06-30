import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { upsertTitle, getTitleById, getTitleByTmdbId, getUnwatchedTitles, updateTitleRatings } from './titles.js';
import { upsertProfile, getProfile, getAllProfiles } from './profiles.js';
import { upsertTasteSignature, getTasteSignature } from './tasteSignatures.js';
import { upsertWatchEvent, getWatchEvents, getRatedTitles } from './watchEvents.js';
import {
  upsertRecommendation,
  getRecommendations,
  updateRecommendationState,
  getCalibration,
} from './recommendations.js';

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const baseTitle = {
  tmdb_id: 12345,
  media_type: 'movie' as const,
  title: 'Test Movie',
  year: 2023,
  genres: '["Action","Drama"]',
  keywords: '["heist","thriller"]',
  cast: '["Actor One","Actor Two"]',
  synopsis: 'A test movie synopsis.',
  poster_path: '/abc123.jpg',
  embedding: null,
  updated_at: new Date().toISOString(),
  imdb_id: null,
  imdb_rating: null,
  rt_rating: null,
};

const baseProfile = {
  name: 'Alex',
  media_weighting: 0.4,
  is_derived: 0,
  config: '{}',
};

describe('titles repo', () => {
  it('upsertTitle + getTitleByTmdbId returns inserted row', () => {
    const db = createTestDb();
    upsertTitle(db, baseTitle);
    const found = getTitleByTmdbId(db, 12345);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Test Movie');
    expect(found!.tmdb_id).toBe(12345);
    expect(found!.media_type).toBe('movie');
    expect(found!.year).toBe(2023);
  });

  it('upsertTitle is idempotent — updates on conflict', () => {
    const db = createTestDb();
    upsertTitle(db, baseTitle);
    upsertTitle(db, { ...baseTitle, title: 'Updated Movie' });
    const found = getTitleByTmdbId(db, 12345);
    expect(found!.title).toBe('Updated Movie');
  });

  it('getTitleById returns row by primary key', () => {
    const db = createTestDb();
    upsertTitle(db, baseTitle);
    const byTmdb = getTitleByTmdbId(db, 12345);
    const byId = getTitleById(db, byTmdb!.id);
    expect(byId).not.toBeNull();
    expect(byId!.tmdb_id).toBe(12345);
  });

  it('getTitleByTmdbId returns null for missing id', () => {
    const db = createTestDb();
    expect(getTitleByTmdbId(db, 99999)).toBeNull();
  });

  it('upsertTitle persists imdb_id, imdb_rating, rt_rating', () => {
    const db = createTestDb();
    upsertTitle(db, { ...baseTitle, imdb_id: 'tt0137523', imdb_rating: '8.8', rt_rating: '79%' });
    const found = getTitleByTmdbId(db, 12345)!;
    expect(found.imdb_id).toBe('tt0137523');
    expect(found.imdb_rating).toBe('8.8');
    expect(found.rt_rating).toBe('79%');
  });

  it('updateTitleRatings sets imdb_rating and rt_rating by id', () => {
    const db = createTestDb();
    upsertTitle(db, baseTitle);
    const inserted = getTitleByTmdbId(db, 12345)!;
    expect(inserted.imdb_rating).toBeNull();
    updateTitleRatings(db, inserted.id, { imdb: '7.5', rt: '85%' });
    const updated = getTitleById(db, inserted.id)!;
    expect(updated.imdb_rating).toBe('7.5');
    expect(updated.rt_rating).toBe('85%');
  });

  it('upsert does not overwrite existing imdb_id with null', () => {
    const db = createTestDb();
    upsertTitle(db, { ...baseTitle, imdb_id: 'tt0137523' });
    // Re-upsert without imdb_id
    upsertTitle(db, { ...baseTitle, imdb_id: null, title: 'Updated' });
    const found = getTitleByTmdbId(db, 12345)!;
    expect(found.imdb_id).toBe('tt0137523'); // preserved via COALESCE
    expect(found.title).toBe('Updated');
  });

  it('upsertTitle persists popularity and vote_count', () => {
    const db = createTestDb();
    upsertTitle(db, { ...baseTitle, popularity: 123.45, vote_count: 5000 });
    const found = getTitleByTmdbId(db, 12345)!;
    expect(found.popularity).toBeCloseTo(123.45);
    expect(found.vote_count).toBe(5000);
  });

  it('upsertTitle ON CONFLICT refreshes popularity and vote_count', () => {
    const db = createTestDb();
    upsertTitle(db, { ...baseTitle, popularity: 50.0, vote_count: 1000 });
    upsertTitle(db, { ...baseTitle, popularity: 99.9, vote_count: 9999 });
    const found = getTitleByTmdbId(db, 12345)!;
    expect(found.popularity).toBeCloseTo(99.9);
    expect(found.vote_count).toBe(9999);
  });

  it('upsertTitle stores null for popularity and vote_count when not provided', () => {
    const db = createTestDb();
    upsertTitle(db, baseTitle);
    const found = getTitleByTmdbId(db, 12345)!;
    expect(found.popularity).toBeNull();
    expect(found.vote_count).toBeNull();
  });

  it('getUnwatchedTitles excludes titles in watch_events for profile', () => {
    const db = createTestDb();
    upsertProfile(db, baseProfile);
    upsertTitle(db, baseTitle);
    upsertTitle(db, { ...baseTitle, tmdb_id: 99999, title: 'Another Movie' });

    const profile = getProfile(db, 1)!;
    const title = getTitleByTmdbId(db, 12345)!;

    upsertWatchEvent(db, {
      profile_id: profile.id,
      title_id: title.id,
      status: 'watched',
      rating: 4,
      watched_at: new Date().toISOString(),
    });

    const unwatched = getUnwatchedTitles(db, profile.id, {});
    expect(unwatched.some((t) => t.tmdb_id === 12345)).toBe(false);
    expect(unwatched.some((t) => t.tmdb_id === 99999)).toBe(true);
  });
});

describe('profiles repo', () => {
  it('upsertProfile + getProfile returns inserted row', () => {
    const db = createTestDb();
    upsertProfile(db, baseProfile);
    const profile = getProfile(db, 1);
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe('Alex');
    expect(profile!.media_weighting).toBe(0.4);
    expect(profile!.is_derived).toBe(0);
  });

  it('getAllProfiles returns all inserted profiles', () => {
    const db = createTestDb();
    upsertProfile(db, { name: 'Alex', media_weighting: 0.4, is_derived: 0, config: '{}' });
    upsertProfile(db, { name: 'Sam', media_weighting: 0.3, is_derived: 0, config: '{}' });
    upsertProfile(db, { name: 'Joint', media_weighting: 0.35, is_derived: 1, config: '{}' });
    const all = getAllProfiles(db);
    expect(all).toHaveLength(3);
    expect(all.map((p) => p.name)).toEqual(expect.arrayContaining(['Alex', 'Sam', 'Joint']));
  });

  it('getProfile returns null for missing id', () => {
    const db = createTestDb();
    expect(getProfile(db, 999)).toBeNull();
  });
});

describe('tasteSignatures repo', () => {
  it('upsertTasteSignature + getTasteSignature roundtrips', () => {
    const db = createTestDb();
    upsertProfile(db, baseProfile);

    const sig = {
      profile_id: 1,
      taste_vector: null,
      prefs: JSON.stringify({
        loved_genres: ['Drama', 'Crime'],
        hated_genres: ['Horror'],
        loved_themes: ['redemption'],
        hated_themes: [],
        preferred_era: '2000s-present',
        media_weighting: 0.4,
      }),
      refreshed_at: new Date().toISOString(),
    };

    upsertTasteSignature(db, sig);
    const found = getTasteSignature(db, 1);
    expect(found).not.toBeNull();
    expect(found!.profile_id).toBe(1);
    const prefs = JSON.parse(found!.prefs);
    expect(prefs.loved_genres).toContain('Drama');
    expect(prefs.hated_genres).toContain('Horror');
  });

  it('getTasteSignature returns null for unknown profile', () => {
    const db = createTestDb();
    expect(getTasteSignature(db, 999)).toBeNull();
  });
});

describe('watchEvents repo', () => {
  it('upsertWatchEvent + getWatchEvents roundtrips', () => {
    const db = createTestDb();
    upsertProfile(db, baseProfile);
    upsertTitle(db, baseTitle);

    upsertWatchEvent(db, {
      profile_id: 1,
      title_id: 1,
      status: 'watchlist',
      rating: null,
      watched_at: null,
    });

    const events = getWatchEvents(db, 1);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('watchlist');
    expect(events[0].rating).toBeNull();
  });

  it('upsertWatchEvent updates on conflict (idempotent)', () => {
    const db = createTestDb();
    upsertProfile(db, baseProfile);
    upsertTitle(db, baseTitle);

    upsertWatchEvent(db, {
      profile_id: 1,
      title_id: 1,
      status: 'watchlist',
      rating: null,
      watched_at: null,
    });
    upsertWatchEvent(db, {
      profile_id: 1,
      title_id: 1,
      status: 'watched',
      rating: 5,
      watched_at: new Date().toISOString(),
    });

    const events = getWatchEvents(db, 1);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('watched');
    expect(events[0].rating).toBe(5);
  });

  it('getRatedTitles returns only events with rating >= minRating', () => {
    const db = createTestDb();
    upsertProfile(db, baseProfile);
    upsertTitle(db, baseTitle);
    upsertTitle(db, { ...baseTitle, tmdb_id: 99999, title: 'Low Rated' });

    upsertWatchEvent(db, {
      profile_id: 1,
      title_id: 1,
      status: 'watched',
      rating: 4,
      watched_at: new Date().toISOString(),
    });
    upsertWatchEvent(db, {
      profile_id: 1,
      title_id: 2,
      status: 'watched',
      rating: 2,
      watched_at: new Date().toISOString(),
    });

    const rated = getRatedTitles(db, 1, 3);
    expect(rated).toHaveLength(1);
    expect(rated[0].title_id).toBe(1);
  });

  it('stores and reads back half-star ratings (3.5) via the INTEGER-affinity column', () => {
    const db = createTestDb();
    upsertProfile(db, baseProfile);
    upsertTitle(db, baseTitle);
    upsertWatchEvent(db, {
      profile_id: 1,
      title_id: 1,
      status: 'watched',
      rating: 3.5,
      watched_at: new Date().toISOString(),
    });
    const events = getWatchEvents(db, 1);
    expect(events[0].rating).toBe(3.5);
    // 3.5★ counts as liked at the 3-star floor but not at the 4-star floor.
    expect(getRatedTitles(db, 1, 3)).toHaveLength(1);
    expect(getRatedTitles(db, 1, 4)).toHaveLength(0);
  });
});

describe('recommendations repo', () => {
  it('upsertRecommendation + getRecommendations roundtrips', () => {
    const db = createTestDb();
    upsertProfile(db, baseProfile);
    upsertTitle(db, baseTitle);

    upsertRecommendation(db, {
      profile_id: 1,
      title_id: 1,
      category: 'For You',
      score: 0.87,
      why_blurb: 'You loved crime dramas like this.',
      request_text: null,
      state: 'pending',
    });

    const recs = getRecommendations(db, 1);
    expect(recs).toHaveLength(1);
    expect(recs[0].score).toBeCloseTo(0.87);
    expect(recs[0].why_blurb).toBe('You loved crime dramas like this.');
    expect(recs[0].state).toBe('pending');
  });

  it('getRecommendations filters by state', () => {
    const db = createTestDb();
    upsertProfile(db, baseProfile);
    upsertTitle(db, baseTitle);
    upsertTitle(db, { ...baseTitle, tmdb_id: 99999, title: 'Another' });

    upsertRecommendation(db, {
      profile_id: 1,
      title_id: 1,
      category: 'For You',
      score: 0.9,
      why_blurb: 'Great pick.',
      request_text: null,
      state: 'pending',
    });
    upsertRecommendation(db, {
      profile_id: 1,
      title_id: 2,
      category: 'Trending',
      score: 0.7,
      why_blurb: 'Popular now.',
      request_text: null,
      state: 'shown',
    });

    const pending = getRecommendations(db, 1, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].state).toBe('pending');
  });

  it('updateRecommendationState changes the state', () => {
    const db = createTestDb();
    upsertProfile(db, baseProfile);
    upsertTitle(db, baseTitle);

    upsertRecommendation(db, {
      profile_id: 1,
      title_id: 1,
      category: 'For You',
      score: 0.9,
      why_blurb: 'You will love this.',
      request_text: null,
      state: 'pending',
    });

    const rec = getRecommendations(db, 1)[0];
    updateRecommendationState(db, rec.id, 'dismissed');

    const updated = getRecommendations(db, 1)[0];
    expect(updated.state).toBe('dismissed');
  });
});

describe('getCalibration', () => {
  function setup() {
    const db = createTestDb();
    upsertProfile(db, baseProfile);
    for (const i of [1, 2, 3, 4]) {
      upsertTitle(db, { ...baseTitle, tmdb_id: 1000 + i, title: `T${i}` });
    }
    return db;
  }

  it('returns zeroed calibration when nothing is both predicted and rated', () => {
    const db = setup();
    expect(getCalibration(db, 1)).toEqual({ count: 0, avgError: null, withinOne: null });
  });

  it('compares predicted vs actual over watched+rated titles only', () => {
    const db = setup();
    // title1: predicted 4, actual 5 → error 1 (within 1)
    upsertRecommendation(db, { profile_id: 1, title_id: 1, category: 'c', score: 0.9, why_blurb: 'w', request_text: null, state: 'shown', predicted_rating: 4 });
    upsertWatchEvent(db, { profile_id: 1, title_id: 1, status: 'watched', rating: 5, watched_at: new Date().toISOString() });
    // title2: predicted 2, actual 4 → error 2 (NOT within 1)
    upsertRecommendation(db, { profile_id: 1, title_id: 2, category: 'c', score: 0.5, why_blurb: 'w', request_text: null, state: 'shown', predicted_rating: 2 });
    upsertWatchEvent(db, { profile_id: 1, title_id: 2, status: 'watched', rating: 4, watched_at: new Date().toISOString() });
    // title3: predicted 5, actual 5 → error 0 (within 1)
    upsertRecommendation(db, { profile_id: 1, title_id: 3, category: 'c', score: 0.9, why_blurb: 'w', request_text: null, state: 'shown', predicted_rating: 5 });
    upsertWatchEvent(db, { profile_id: 1, title_id: 3, status: 'watched', rating: 5, watched_at: new Date().toISOString() });
    // title4: predicted but only watchlisted (no actual rating) → excluded
    upsertRecommendation(db, { profile_id: 1, title_id: 4, category: 'c', score: 0.9, why_blurb: 'w', request_text: null, state: 'pending', predicted_rating: 3 });
    upsertWatchEvent(db, { profile_id: 1, title_id: 4, status: 'watchlist', rating: null, watched_at: null });

    const cal = getCalibration(db, 1);
    expect(cal.count).toBe(3);
    expect(cal.avgError).toBeCloseTo((1 + 2 + 0) / 3);
    expect(cal.withinOne).toBeCloseTo(2 / 3);
  });

  it('excludes watched titles that had no prediction', () => {
    const db = setup();
    upsertWatchEvent(db, { profile_id: 1, title_id: 1, status: 'watched', rating: 5, watched_at: new Date().toISOString() });
    expect(getCalibration(db, 1).count).toBe(0);
  });
});
