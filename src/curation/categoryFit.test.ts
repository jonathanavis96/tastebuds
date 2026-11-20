import { describe, it, expect } from 'vitest';
import { fittingCategory } from './categoryFit.js';

const title = (over: Partial<Record<string, unknown>> = {}) => ({
  media_type: 'movie' as const, genres: '["Comedy"]', keywords: '[]', imdb_genres: '["Comedy"]', imdb_votes: 12_000, ...over,
});

describe('fittingCategory', () => {
  it('keeps "Hidden gem" for a title few have voted on', () => {
    expect(fittingCategory('Hidden gem', title({ imdb_votes: 50_000 }), 'Top pick')).toBe('Hidden gem');
  });

  it('drops "Hidden gem" for a well-known title or one with no vote count', () => {
    expect(fittingCategory('Hidden gem', title({ imdb_votes: 50_001 }), 'Top pick')).toBe('Top pick');
    expect(fittingCategory('Hidden gem', title({ imdb_votes: null }), 'Based on your request')).toBe('Based on your request');
  });

  it('keeps "Comfort watch" for an easy genre with nothing dark in it', () => {
    expect(fittingCategory('Comfort watch', title({ genres: '["Family","Animation"]', imdb_genres: '[]' }), 'Top pick')).toBe('Comfort watch');
  });

  it('drops "Comfort watch" for a horror film, a thriller, a war film, or a drama with no easy genre', () => {
    const pearl = title({ genres: '["Horror","Drama"]', imdb_genres: '["Drama","Horror"]' });
    expect(fittingCategory('Comfort watch', pearl, 'Top pick')).toBe('Top pick');
    expect(fittingCategory('Comfort watch', title({ genres: '["Comedy","Thriller"]' }), 'Top pick')).toBe('Top pick');
    expect(fittingCategory('Comfort watch', title({ genres: '["War","Comedy"]' }), 'Top pick')).toBe('Top pick');
    expect(fittingCategory('Comfort watch', title({ genres: '["Drama"]', imdb_genres: '["Drama"]' }), 'Top pick')).toBe('Top pick');
  });

  it('drops "Comfort watch" for a series its keywords call horror', () => {
    const series = title({ media_type: 'tv', genres: '["Drama","Mystery","Comedy"]', imdb_genres: '[]', keywords: '["supernatural horror"]' });
    expect(fittingCategory('Comfort watch', series, 'Top pick')).toBe('Top pick');
  });

  it('keeps every other label as written', () => {
    expect(fittingCategory('Surprise pick', title({ genres: '["Horror"]' }), 'Top pick')).toBe('Surprise pick');
    expect(fittingCategory('Based on your request', title(), 'Top pick')).toBe('Based on your request');
  });
});
