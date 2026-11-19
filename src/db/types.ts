export interface TitleRow {
  id: number;
  tmdb_id: number;
  media_type: 'movie' | 'tv';
  title: string;
  year: number | null;
  genres: string; // JSON array of genre name strings
  keywords: string; // JSON array
  cast: string; // JSON array
  synopsis: string | null;
  poster_path: string | null;
  embedding: Buffer | null;
  updated_at: string; // ISO datetime
  imdb_id: string | null;
  imdb_rating: string | null;
  rt_rating: string | null;
  rt_url: string | null;
  popularity: number | null;
  vote_count: number | null;
  rating_checked_at: number | null;
  rt_checked_at: number | null;
  original_language: string | null;
  runtime_minutes: number | null;
  vote_average: number | null;
  status: string | null;
  meta_checked_at: number | null;
  /** Votes behind imdb_rating, from IMDb's ratings file. */
  imdb_votes: number | null;
  /** Unix seconds when IMDb's ratings file last confirmed or cleared imdb_rating. */
  imdb_synced_at: number | null;
  /** IMDb's genres as a JSON array, or null when not known yet. */
  imdb_genres: string | null;
  /** Unix seconds when TMDB was last asked for a missing imdb_id. */
  imdb_id_checked_at: number | null;
  /** Unix seconds when rt_rating was last read from the title's own RT page; null = unverified. */
  rt_verified_at: number | null;
}

export interface ProfileRow {
  id: number;
  name: string;
  media_weighting: number; // 0.0–1.0, higher = more movies
  is_derived: number; // 0 or 1
  config: string; // JSON
}

export interface TasteSignatureRow {
  profile_id: number;
  taste_vector: Buffer | null;
  prefs: string; // JSON: { loved_genres: string[], hated_genres: string[], loved_themes: string[], hated_themes: string[], preferred_era: string, media_weighting: number }
  refreshed_at: string;
}

export interface WatchEventRow {
  id: number;
  profile_id: number;
  title_id: number;
  status: 'watchlist' | 'watched';
  rating: number | null;
  watched_at: string | null;
  note: string | null;
  created_at: string;
}

export interface RecommendationRow {
  id: number;
  profile_id: number;
  title_id: number;
  category: string;
  score: number;
  why_blurb: string;
  request_text: string | null;
  state: 'pending' | 'shown' | 'dismissed';
  kind: 'core' | 'wildcard' | 'adversarial'; // defaults to 'core' via DB column default
  predicted_rating: number | null; // Sonnet's predicted star rating (1–5) for this pick
  dismiss_reason: string | null; // tile key chosen on dismiss (see DismissReason), null if none/not dismissed
  /** JSON RequestSummary (src/request/rules.ts) for a pick made from a request; null otherwise. */
  request_summary: string | null;
  /** Why this pick is an exception to the request's default year window; null for an ordinary pick. */
  rule_note: string | null;
  created_at: string;
}
