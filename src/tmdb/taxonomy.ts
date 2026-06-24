/**
 * TMDB genre taxonomy for movies and TV, plus keyword-based fallbacks for TV
 * genres that don't exist in the official TV genre list.
 *
 * TMDB TV has NO "Horror" and NO "Thriller" genres — these vibes are only
 * discoverable via keyword search (e.g. keyword "horror" → id 315058).
 * Movies DO include both, so we keep them in MOVIE_GENRE_MAP.
 *
 * Export everything so both harvest.ts and the on-demand module can share
 * a single authoritative map.
 */

/** Movie genre name → TMDB genre id. */
export const MOVIE_GENRE_MAP: Record<string, number> = {
  Action: 28,
  Adventure: 12,
  Animation: 16,
  Comedy: 35,
  Crime: 80,
  Drama: 18,
  Fantasy: 14,
  Horror: 27,
  Mystery: 9648,
  Romance: 10749,
  'Science Fiction': 878,
  Thriller: 53,
  Documentary: 99,
  Family: 10751,
};

/**
 * TV genre name → TMDB genre id.
 *
 * Notable omissions vs. the movie map (intentional — these genres don't exist
 * in TMDB's TV genre list):
 *   - Horror  → use keyword "horror"  (see TV_KEYWORD_GENRES below)
 *   - Thriller → use keyword "thriller" (see TV_KEYWORD_GENRES below)
 *
 * "Science Fiction" is an alias for "Sci-Fi & Fantasy" (id 10765) so that
 * profiles using the movie genre name ("Science Fiction") still resolve to
 * the correct TV genre.
 */
export const TV_GENRE_MAP: Record<string, number> = {
  'Action & Adventure': 10759,
  Animation: 16,
  Comedy: 35,
  Crime: 80,
  Drama: 18,
  Fantasy: 10765,
  Kids: 10762,
  Mystery: 9648,
  Reality: 10764,
  'Sci-Fi & Fantasy': 10765,
  // "Science Fiction" is the movie pref word — map it to the TV equivalent
  'Science Fiction': 10765,
  Documentary: 99,
  Family: 10751,
};

/**
 * Genres that exist as a vibe but are absent from TMDB's TV genre taxonomy.
 * For TV, these must be fetched via keyword discovery (with_keywords=) instead
 * of with_genres=. The value is the keyword string to pass to searchKeyword().
 *
 * Canonical genre name → keyword search term
 */
export const TV_KEYWORD_GENRES: Record<string, string> = {
  Horror: 'horror',
  Thriller: 'thriller',
};

/** Result of resolving a list of genre names for a given media type. */
export interface GenreResolution {
  /** TMDB genre ids to use with with_genres= */
  genreIds: number[];
  /** Keyword search terms (one per absent-genre) to resolve and use with with_keywords= */
  keywordTerms: string[];
}

/**
 * Resolve a list of canonical genre names into TMDB genre ids + keyword terms
 * for the given media type.
 *
 * - For movies: all genres map to ids via MOVIE_GENRE_MAP (Horror=27, Thriller=53, etc.)
 * - For TV: valid-in-taxonomy genres → ids via TV_GENRE_MAP;
 *           Horror/Thriller → keywordTerms (to be resolved at runtime via searchKeyword)
 *
 * Unknown genre names are silently dropped (no TMDB id and not a keyword genre).
 */
export function resolveGenreNames(names: string[], mediaType: 'movie' | 'tv'): GenreResolution {
  if (mediaType === 'movie') {
    // Movies: straightforward name→id lookup, no keyword fallback needed
    const genreIds = names
      .map((n) => MOVIE_GENRE_MAP[n])
      .filter((id): id is number => id !== undefined);
    return { genreIds, keywordTerms: [] };
  }

  // TV: split names into map-able genres vs. keyword-only genres
  const genreIds: number[] = [];
  const keywordTerms: string[] = [];

  for (const name of names) {
    const kwTerm = TV_KEYWORD_GENRES[name];
    if (kwTerm !== undefined) {
      // This genre has no TV genre id — must be fetched via keyword
      keywordTerms.push(kwTerm);
    } else {
      const id = TV_GENRE_MAP[name];
      if (id !== undefined) genreIds.push(id);
      // else: unknown genre name, silently skip
    }
  }

  return { genreIds, keywordTerms };
}
