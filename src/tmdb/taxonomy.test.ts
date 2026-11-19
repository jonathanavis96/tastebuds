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
import { resolveGenreNames, tmdbQueryForGenre } from './taxonomy.js';
import { CANON_GENRES } from '../request/rules.js';

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

describe('tmdbQueryForGenre', () => {
  it('maps every canonical film genre to a TMDB genre id except Reality', () => {
    for (const genre of CANON_GENRES) {
      const query = tmdbQueryForGenre(genre, 'movie');
      if (genre === 'Reality') expect(query).toBeNull();
      else expect(query).toEqual({ genreId: expect.any(Number) });
    }
    expect(tmdbQueryForGenre('History', 'movie')).toEqual({ genreId: 36 });
    expect(tmdbQueryForGenre('Music', 'movie')).toEqual({ genreId: 10402 });
    expect(tmdbQueryForGenre('War', 'movie')).toEqual({ genreId: 10752 });
    expect(tmdbQueryForGenre('Western', 'movie')).toEqual({ genreId: 37 });
  });

  it('maps series genres to the TV ids, bundles included', () => {
    expect(tmdbQueryForGenre('Science Fiction', 'tv')).toEqual({ genreId: 10765 });
    expect(tmdbQueryForGenre('Fantasy', 'tv')).toEqual({ genreId: 10765 });
    expect(tmdbQueryForGenre('Action', 'tv')).toEqual({ genreId: 10759 });
    expect(tmdbQueryForGenre('Adventure', 'tv')).toEqual({ genreId: 10759 });
    expect(tmdbQueryForGenre('War', 'tv')).toEqual({ genreId: 10768 });
    expect(tmdbQueryForGenre('Reality', 'tv')).toEqual({ genreId: 10764 });
    expect(tmdbQueryForGenre('Western', 'tv')).toEqual({ genreId: 37 });
  });

  it('asks for series Thriller and Horror by keyword', () => {
    expect(tmdbQueryForGenre('Thriller', 'tv')).toEqual({ keyword: 'thriller' });
    expect(tmdbQueryForGenre('Horror', 'tv')).toEqual({ keyword: 'horror' });
  });

  it('returns null for series genres TMDB has no genre or keyword rule for', () => {
    expect(tmdbQueryForGenre('Romance', 'tv')).toBeNull();
    expect(tmdbQueryForGenre('History', 'tv')).toBeNull();
    expect(tmdbQueryForGenre('Music', 'tv')).toBeNull();
  });
});
