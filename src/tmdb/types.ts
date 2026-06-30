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
}

export interface DiscoverOpts {
  mediaType: 'movie' | 'tv';
  genreIds?: number[];
  /** TMDB keyword ids to pass as with_keywords= (comma-separated). */
  keywordIds?: number[];
  page?: number;
  /** TMDB sort_by value, e.g. 'vote_count.desc', 'popularity.desc'. */
  sortBy?: string;
  /** Minimum vote_count to filter out obscure titles. */
  voteCountGte?: number;
}
