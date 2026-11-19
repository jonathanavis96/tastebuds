export interface TmdbTitle {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  genre_ids: number[];
  overview: string;
  poster_path: string | null;
  popularity?: number;
  vote_count?: number;
}

export interface TmdbTitleDetail extends TmdbTitle {
  genres: Array<{ id: number; name: string }>;
  keywords?: {
    keywords?: Array<{ name: string }>;
    results?: Array<{ name: string }>;
  };
  credits?: {
    cast: Array<{ name: string }>;
  };
  /** Top-level imdb_id present on movie responses */
  imdb_id?: string | null;
  /** From append_to_response=external_ids */
  external_ids?: {
    imdb_id?: string | null;
  };
  original_language?: string;
  /** Movie-only: runtime in minutes. */
  runtime?: number | null;
  /** TV-only: per-season/episode runtimes; first positive entry is used. */
  episode_run_time?: number[];
  vote_average?: number;
  status?: string;
}

/** 'all': a title must carry every id (TMDB comma). 'any': one of them is enough (TMDB pipe). */
export type IdMatch = 'all' | 'any';

export interface DiscoverOpts {
  mediaType: 'movie' | 'tv';
  genreIds?: number[];
  /** How genreIds combine; 'all' when omitted. TMDB cannot mix the two in one parameter. */
  genreMatch?: IdMatch;
  /** TMDB keyword ids to pass as with_keywords=. */
  keywordIds?: number[];
  /** How keywordIds combine; 'all' when omitted. */
  keywordMatch?: IdMatch;
  /** Titles carrying any of these genre ids are left out. */
  withoutGenreIds?: number[];
  /** Titles carrying any of these keyword ids are left out. */
  withoutKeywordIds?: number[];
  /** Inclusive release (film) or first-air (series) date bounds, YYYY-MM-DD. */
  releasedFrom?: string;
  releasedTo?: string;
  /** ISO 639-1 original language, e.g. 'en'. */
  originalLanguage?: string;
  page?: number;
  /** TMDB sort_by value, e.g. 'vote_count.desc', 'popularity.desc'. */
  sortBy?: string;
  /** Minimum vote_count to filter out obscure titles. */
  voteCountGte?: number;
}
