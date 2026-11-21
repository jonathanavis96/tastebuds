import { describe, it, expect } from 'vitest';
import { arrangeRequestPicks, closeByTier, padRequestPicks, type CurationResult } from './curate.js';
import { buildRequestPrompt, MIN_REQUEST_PICKS, type RequestPromptInput } from './prompt.js';
import type { CandidateTitle } from '../retrieval/retrieve.js';
import type { ProfileRow, TasteSignatureRow } from '../db/types.js';

function cand(tmdb_id: number): CandidateTitle {
  return {
    id: tmdb_id, tmdb_id, media_type: 'movie', title: `Film ${tmdb_id}`, year: 2015,
    genres: '["Thriller"]', keywords: '[]', cast: '[]', synopsis: 's', poster_path: null,
    embedding: null, updated_at: '', imdb_id: null, imdb_rating: null, rt_rating: null, rt_url: null,
    popularity: 10, vote_count: 1000, rating_checked_at: null, rt_checked_at: null, original_language: 'en',
    runtime_minutes: 100, vote_average: 7, status: 'Released', meta_checked_at: null,
    imdb_votes: null, imdb_synced_at: null, imdb_genres: null, imdb_id_checked_at: null, rt_verified_at: null, score: 0.2,
  };
}

const WHY = 'Matches your request: Thriller, 2015 or newer.';
const pick = (tmdbId: number): CurationResult => ({ tmdbId, why: 'w', category: 'Based on your request', kind: 'core', predictedRating: 4 });

const profile: ProfileRow = { id: 1, name: 'Alex', media_weighting: 0.5, is_derived: 0, config: '{}' };
const sig: TasteSignatureRow = { profile_id: 1, taste_vector: null, prefs: '{}', refreshed_at: '' };

describe('padRequestPicks', () => {
  it('tops up to the minimum from the reranked candidate order, keeping model picks first', () => {
    const cands = Array.from({ length: 15 }, (_, i) => cand(i + 1));
    const out = padRequestPicks([pick(7), pick(3)], cands, MIN_REQUEST_PICKS, WHY);
    expect(out).toHaveLength(10);
    expect(out.slice(0, 2).map(p => p.tmdbId)).toEqual([7, 3]);
    // Padding follows candidate order and never repeats a chosen id.
    expect(out.slice(2).map(p => p.tmdbId)).toEqual([1, 2, 4, 5, 6, 8, 9, 10]);
    expect(out[2].category).toBe('Based on your request');
    expect(out[2].why).toBe(WHY);
    expect(out[2].predictedRating).toBeNull();
  });

  it('leaves a full list alone', () => {
    const cands = Array.from({ length: 15 }, (_, i) => cand(i + 1));
    const picks = Array.from({ length: 10 }, (_, i) => pick(i + 1));
    expect(padRequestPicks(picks, cands, MIN_REQUEST_PICKS, WHY)).toEqual(picks);
  });

  it('returns everything available when the pool itself is under the minimum', () => {
    const cands = [cand(1), cand(2), cand(3)];
    expect(padRequestPicks([pick(2)], cands, MIN_REQUEST_PICKS, WHY).map(p => p.tmdbId)).toEqual([2, 1, 3]);
  });

  it('drops hallucinated tmdb_ids the model invented', () => {
    const cands = [cand(1), cand(2)];
    expect(padRequestPicks([pick(999)], cands, MIN_REQUEST_PICKS, WHY).map(p => p.tmdbId)).toEqual([1, 2]);
  });
});

describe('arrangeRequestPicks', () => {
  const recent = Array.from({ length: 4 }, (_, i) => cand(i + 1));
  const older = Array.from({ length: 12 }, (_, i) => cand(100 + i));

  it('keeps every recent title ahead of any older one, and older ones never past the room left', () => {
    const chosen = [pick(103), pick(2), pick(100), pick(101), pick(102), pick(104), pick(105), pick(106), pick(107), pick(108)];
    const out = arrangeRequestPicks(chosen, { recent, older, olderRoom: 6 }, WHY, MIN_REQUEST_PICKS);
    expect(out.recent.map(p => p.tmdbId)).toEqual([2, 1, 3, 4]);
    expect(out.older.map(p => p.tmdbId)).toEqual([103, 100, 101, 102, 104, 105]);
  });

  it('pads in rank order with the rules line when the model returned nothing', () => {
    const out = arrangeRequestPicks([], { recent, older, olderRoom: 6 }, WHY, MIN_REQUEST_PICKS);
    expect(out.recent.map(p => p.tmdbId)).toEqual([1, 2, 3, 4]);
    expect(out.older.map(p => p.tmdbId)).toEqual([100, 101, 102, 103, 104, 105]);
    expect([...out.recent, ...out.older].every(p => p.why === WHY)).toBe(true);
  });

  it('takes the model\'s best ten recent titles and no older ones when the window is full', () => {
    const many = Array.from({ length: 30 }, (_, i) => cand(i + 1));
    const chosen = Array.from({ length: 12 }, (_, i) => pick(30 - i));
    const out = arrangeRequestPicks(chosen, { recent: many, older: [], olderRoom: 0 }, WHY, MIN_REQUEST_PICKS);
    expect(out.recent.map(p => p.tmdbId)).toEqual([30, 29, 28, 27, 26, 25, 24, 23, 22, 21]);
    expect(out.older).toEqual([]);
  });
});

describe('arrangeRequestPicks with close matches', () => {
  it('puts strict matches first, then close matches up to their room, then older titles in the room left', () => {
    const recent = [cand(1), cand(2)];
    const close = Array.from({ length: 10 }, (_, i) => cand(20 + i));
    const older = Array.from({ length: 5 }, (_, i) => cand(100 + i));
    // The model leads with close matches and older titles; the code keeps the groups in order.
    const chosen = [pick(25), pick(100), pick(21), pick(2)];
    const out = arrangeRequestPicks(chosen, { recent, close, closeRoom: 6, older, olderRoom: 2 }, WHY, MIN_REQUEST_PICKS);
    expect(out.recent.map(p => p.tmdbId)).toEqual([2, 1]);
    expect(out.close.map(p => p.tmdbId)).toEqual([25, 21, 20, 22, 23, 24]);
    expect(out.older.map(p => p.tmdbId)).toEqual([100, 101]);
  });
});

describe('request prompt', () => {
  const input = (over: Partial<RequestPromptInput> = {}): RequestPromptInput => ({
    text: 'Thriller new 2025',
    understood: ['Thriller', 'Films', '2025 or newer'],
    candidates: Array.from({ length: 15 }, (_, i) => cand(i + 1)),
    older: [],
    olderRoom: 0,
    mediaOpen: false,
    ...over,
  });

  it('says every candidate already satisfies the listed rules and asks for the best ten in order', () => {
    const prompt = buildRequestPrompt(input(), profile, sig);
    expect(prompt).toContain('"Thriller new 2025"');
    expect(prompt).toContain('already satisfies all of the request\'s rules');
    expect(prompt).toContain('- Thriller\n- Films\n- 2025 or newer');
    expect(prompt).toContain('choose the 10 best');
    expect(prompt).toContain('exactly 10 candidates');
  });

  it('shows each candidate\'s canonical tags and IMDb rating', () => {
    const c = { ...cand(1), media_type: 'tv' as const, genres: '["Sci-Fi & Fantasy","Drama"]', imdb_genres: '["Sci-Fi","Drama"]', imdb_rating: '8.1' };
    const prompt = buildRequestPrompt(input({ candidates: [c] }), profile, sig);
    expect(prompt).toContain('(2015, series) [Science Fiction, Drama] IMDb 8.1');
  });

  it('asks for every candidate when fewer than ten exist', () => {
    const prompt = buildRequestPrompt(input({ candidates: [cand(1), cand(2), cand(3)] }), profile, sig);
    expect(prompt).toContain('exactly 3 candidates');
  });

  it('lists close matches apart, each with the mood words it misses, before older fill-ins', () => {
    const prompt = buildRequestPrompt(input({
      candidates: [cand(1)],
      close: [cand(30), cand(31)],
      closeRoom: 2,
      closeMissed: new Map([[30, ['Scary']], [31, ['Mind-bending', 'Scary']]]),
      older: [cand(50)],
      olderRoom: 1,
    }), profile, sig);
    expect(prompt).toContain('## Close matches');
    expect(prompt).toContain('2. [tmdb_id:30]');
    expect(prompt).toMatch(/\[tmdb_id:30\].*\(misses: Scary\)/);
    expect(prompt).toMatch(/\[tmdb_id:31\].*\(misses: Mind-bending, Scary\)/);
    expect(prompt).toContain('4. [tmdb_id:50]');
    expect(prompt.indexOf('## Close matches')).toBeLessThan(prompt.indexOf('## Older candidates'));
    expect(prompt).toContain('exactly 4 candidates');
  });

  it('lists older fill-ins apart, with how many may be used', () => {
    const prompt = buildRequestPrompt(input({ candidates: [cand(1), cand(2)], older: [cand(50), cand(51), cand(52)], olderRoom: 2 }), profile, sig);
    expect(prompt).toContain('use at most 2 of these');
    expect(prompt).toContain('3. [tmdb_id:50]');
    expect(prompt).toContain('exactly 4 candidates');
  });
});

describe('closeByTier', () => {
  // 8 strict matches leave 2 places: titles 11 and 12 miss one mood word, 21 and 22 miss two.
  const close = [cand(11), cand(12), cand(21), cand(22)];
  const missed = new Map([[11, 1], [12, 1], [21, 2], [22, 2]]);
  const groups = (closeOrder: CurationResult[]) => arrangeRequestPicks(
    [...Array.from({ length: 8 }, (_, i) => pick(i + 1)), ...closeOrder],
    { recent: Array.from({ length: 8 }, (_, i) => cand(i + 1)), close, closeRoom: 2, older: [], olderRoom: 0 },
    WHY, 10,
  );

  it('keeps the titles missing fewer words when the model puts the others first', () => {
    const reversed = [pick(22), pick(21), pick(12), pick(11)];
    expect(groups(closeByTier(reversed, close, missed, WHY)).close.map(p => p.tmdbId)).toEqual([12, 11]);
  });

  it('brings back a better tier the model left out, padded with the plain line', () => {
    const out = closeByTier([pick(22), pick(21)], close, missed, WHY);
    expect(out.map(p => p.tmdbId)).toEqual([11, 12, 22, 21]);
    expect(out[0].why).toBe(WHY);
    expect(groups(out).close.map(p => p.tmdbId)).toEqual([11, 12]);
  });

  it('leaves out picks that are not close candidates', () => {
    expect(closeByTier([pick(1), pick(21)], close, missed, WHY).map(p => p.tmdbId)).toEqual([11, 12, 21, 22]);
  });
});
