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
