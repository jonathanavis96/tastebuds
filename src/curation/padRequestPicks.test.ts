import { describe, it, expect } from 'vitest';
import { padRequestPicks, type CurationResult } from './curate.js';
import { buildCurationPrompt, FLAT_CANDIDATE_CAP, MIN_REQUEST_PICKS } from './prompt.js';
import type { CandidateTitle } from '../retrieval/retrieve.js';
import type { ProfileRow, TasteSignatureRow } from '../db/types.js';

function cand(tmdb_id: number): CandidateTitle {
  return {
    id: tmdb_id, tmdb_id, media_type: 'movie', title: `Film ${tmdb_id}`, year: 2015,
    genres: '["Thriller"]', keywords: '[]', cast: '[]', synopsis: 's', poster_path: null,
    embedding: null, updated_at: '', imdb_id: null, imdb_rating: null, rt_rating: null, rt_url: null,
    popularity: 10, vote_count: 1000, rating_checked_at: null, original_language: 'en',
    runtime_minutes: 100, vote_average: 7, status: 'Released', meta_checked_at: null, score: 0.2,
  };
}

const pick = (tmdbId: number): CurationResult => ({ tmdbId, why: 'w', category: 'Based on your request', kind: 'core', predictedRating: 4 });

const profile: ProfileRow = { id: 1, name: 'Alex', media_weighting: 0.5, is_derived: 0, config: '{}' };
const sig: TasteSignatureRow = { profile_id: 1, taste_vector: null, prefs: '{}', refreshed_at: '' };

describe('padRequestPicks', () => {
  it('tops up to the minimum from the reranked candidate order, keeping model picks first', () => {
    const cands = Array.from({ length: 15 }, (_, i) => cand(i + 1));
    const out = padRequestPicks([pick(7), pick(3)], cands, MIN_REQUEST_PICKS);
    expect(out).toHaveLength(10);
    expect(out.slice(0, 2).map(p => p.tmdbId)).toEqual([7, 3]);
    // Padding follows candidate order and never repeats a chosen id.
    expect(out.slice(2).map(p => p.tmdbId)).toEqual([1, 2, 4, 5, 6, 8, 9, 10]);
    expect(out[2].category).toBe('Based on your request');
    expect(out[2].predictedRating).toBeNull();
  });

  it('leaves a full list alone', () => {
    const cands = Array.from({ length: 15 }, (_, i) => cand(i + 1));
    const picks = Array.from({ length: 10 }, (_, i) => pick(i + 1));
    expect(padRequestPicks(picks, cands, MIN_REQUEST_PICKS)).toEqual(picks);
  });

  it('returns everything available when the pool itself is under the minimum', () => {
    const cands = [cand(1), cand(2), cand(3)];
    expect(padRequestPicks([pick(2)], cands, MIN_REQUEST_PICKS).map(p => p.tmdbId)).toEqual([2, 1, 3]);
  });

  it('drops hallucinated tmdb_ids the model invented', () => {
    const cands = [cand(1), cand(2)];
    expect(padRequestPicks([pick(999)], cands, MIN_REQUEST_PICKS).map(p => p.tmdbId)).toEqual([1, 2]);
  });
});

describe('request prompt', () => {
  it('lists up to FLAT_CANDIDATE_CAP candidates and demands at least the minimum picks', () => {
    const cands = Array.from({ length: FLAT_CANDIDATE_CAP + 5 }, (_, i) => cand(i + 1));
    const prompt = buildCurationPrompt(cands, profile, sig, 'scary sci-fi thriller');
    expect(prompt).toContain(`tmdb_id:${FLAT_CANDIDATE_CAP}]`);
    expect(prompt).not.toContain(`tmdb_id:${FLAT_CANDIDATE_CAP + 1}]`);
    expect(prompt).toContain(`Return AT LEAST ${MIN_REQUEST_PICKS} items`);
    expect(prompt).not.toContain('a shorter, on-request list is better');
  });

  it('asks for every candidate when fewer than the minimum exist', () => {
    const prompt = buildCurationPrompt([cand(1), cand(2), cand(3)], profile, sig, 'westerns');
    expect(prompt).toContain('Return AT LEAST 3 items');
  });
});
