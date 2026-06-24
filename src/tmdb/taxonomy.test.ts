/**
 * TDD tests for the genre taxonomy — genre/keyword resolution for movies and TV.
 *
 * Key facts verified:
 *  - TV: Horror → keywordTerms (not genreIds), Thriller → keywordTerms
 *  - TV: Thriller id 53 (movie-only) never appears in TV genreIds
 *  - TV: Drama (18) and Science Fiction (→ Sci-Fi & Fantasy, 10765) resolve to genreIds
 *  - Movie: Horror (27) and Thriller (53) resolve to genreIds
 */

import { describe, it, expect } from 'vitest';
import { resolveGenreNames } from './taxonomy.js';

describe('resolveGenreNames — TV', () => {
  it('puts Drama and Science Fiction in genreIds, not keywordTerms', () => {
    const { genreIds, keywordTerms } = resolveGenreNames(['Drama', 'Science Fiction'], 'tv');
    expect(genreIds).toContain(18);   // Drama
    expect(genreIds).toContain(10765); // Sci-Fi & Fantasy (alias for Science Fiction)
    expect(keywordTerms).toHaveLength(0);
  });

  it('puts Horror and Thriller in keywordTerms, not genreIds', () => {
    const { genreIds, keywordTerms } = resolveGenreNames(['Horror', 'Thriller'], 'tv');
    expect(genreIds).not.toContain(53);  // 53 is movie-only Thriller id
    expect(genreIds).not.toContain(27);  // 27 is movie-only Horror id
    expect(keywordTerms).toContain('horror');
    expect(keywordTerms).toContain('thriller');
  });

  it('correctly splits a mixed list of 4 genres', () => {
    const { genreIds, keywordTerms } = resolveGenreNames(
      ['Horror', 'Thriller', 'Drama', 'Science Fiction'],
      'tv',
    );
    // Genre ids: Drama + Sci-Fi & Fantasy
    expect(genreIds).toContain(18);
    expect(genreIds).toContain(10765);
    // No movie-only ids
    expect(genreIds).not.toContain(53);
    expect(genreIds).not.toContain(27);
    // Keyword terms: horror + thriller
    expect(keywordTerms).toContain('horror');
    expect(keywordTerms).toContain('thriller');
  });

  it('resolves Sci-Fi & Fantasy by its canonical TV name', () => {
    const { genreIds } = resolveGenreNames(['Sci-Fi & Fantasy'], 'tv');
    expect(genreIds).toContain(10765);
  });

  it('ignores unknown genre names silently', () => {
    const { genreIds, keywordTerms } = resolveGenreNames(['Nonexistent Genre'], 'tv');
    expect(genreIds).toHaveLength(0);
    expect(keywordTerms).toHaveLength(0);
  });

  it('returns empty results for empty input', () => {
    const { genreIds, keywordTerms } = resolveGenreNames([], 'tv');
    expect(genreIds).toHaveLength(0);
    expect(keywordTerms).toHaveLength(0);
  });
});

describe('resolveGenreNames — movie', () => {
  it('puts Horror and Thriller in genreIds for movies', () => {
    const { genreIds, keywordTerms } = resolveGenreNames(['Horror', 'Thriller'], 'movie');
    expect(genreIds).toContain(27);  // Horror
    expect(genreIds).toContain(53);  // Thriller
    expect(keywordTerms).toHaveLength(0); // no keyword fallback for movies
  });

  it('puts Drama and Science Fiction in genreIds for movies', () => {
    const { genreIds } = resolveGenreNames(['Drama', 'Science Fiction'], 'movie');
    expect(genreIds).toContain(18);  // Drama
    expect(genreIds).toContain(878); // Science Fiction (movie id)
  });

  it('resolves the same mixed 4-genre list correctly for movies', () => {
    const { genreIds, keywordTerms } = resolveGenreNames(
      ['Horror', 'Thriller', 'Drama', 'Science Fiction'],
      'movie',
    );
    expect(genreIds).toContain(27);
    expect(genreIds).toContain(53);
    expect(genreIds).toContain(18);
    expect(genreIds).toContain(878);
    expect(keywordTerms).toHaveLength(0);
  });
});
