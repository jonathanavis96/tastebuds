import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import PosterFeed from './PosterFeed.svelte';
import type { Recommendation } from '../lib/types.js';

function makeRec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: 1,
    profile_id: 1,
    title_id: 101,
    category: 'Drama',
    score: 0.9,
    why_blurb: 'A great watch.',
    request_text: null,
    state: 'active',
    created_at: '2026-01-01T00:00:00Z',
    title: 'Test Title',
    year: 2024,
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('PosterFeed — media_type pill on tiles', () => {
  it('shows "Series" pill for media_type tv', () => {
    const { getByText } = render(PosterFeed, {
      recommendations: [makeRec({ media_type: 'tv' })],
    });
    expect(getByText('Series')).toBeTruthy();
  });

  it('shows "Movie" pill for media_type movie', () => {
    const { getByText } = render(PosterFeed, {
      recommendations: [makeRec({ media_type: 'movie' })],
    });
    expect(getByText('Movie')).toBeTruthy();
  });

  it('shows no type pill when media_type is null', () => {
    const { queryByText } = render(PosterFeed, {
      recommendations: [makeRec({ media_type: null })],
    });
    expect(queryByText('Series')).toBeNull();
    expect(queryByText('Movie')).toBeNull();
  });
});

describe('PosterFeed — ratings, tags and rule note on tiles', () => {
  it('shows the IMDb rating and the Rotten Tomatoes score when both are present', () => {
    const { getByText } = render(PosterFeed, {
      recommendations: [makeRec({ imdb_rating: '7.4', rt_rating: '91%' })],
    });
    expect(getByText('IMDb 7.4')).toBeTruthy();
    expect(getByText('🍅 91%')).toBeTruthy();
  });

  it('shows no score at all for a title with no ratings', () => {
    const { queryByText } = render(PosterFeed, {
      recommendations: [makeRec({ imdb_rating: null, rt_rating: null })],
    });
    expect(queryByText(/IMDb/)).toBeNull();
    expect(queryByText(/🍅/)).toBeNull();
  });

  it('shows at most three genre tags beside the type pill', () => {
    const { container } = render(PosterFeed, {
      recommendations: [makeRec({ media_type: 'movie', tags: ['Thriller', 'Crime', 'Mystery', 'Drama'] })],
    });
    const pills = [...container.querySelectorAll('.pill')].map(el => el.textContent);
    expect(pills).toEqual(['Movie', 'Thriller', 'Crime', 'Mystery']);
  });

  it('shows the rule note of a pick that bends the request', () => {
    const { getByText } = render(PosterFeed, {
      recommendations: [makeRec({ rule_note: 'Older pick: only 7 from 2021–2026 matched' })],
    });
    expect(getByText('Older pick: only 7 from 2021–2026 matched')).toBeTruthy();
  });

  it('keeps a dismissed pick in place with its Not-interested badge', () => {
    const { getByText, getByRole } = render(PosterFeed, {
      recommendations: [makeRec({ id: 7, title: 'Gone Girl', tags: ['Thriller'] })],
      dismissedIds: [7],
    });
    expect(getByText('✗ Not interested')).toBeTruthy();
    expect(getByRole('button', { name: /Not interested — Gone Girl/ })).toBeTruthy();
  });
});

