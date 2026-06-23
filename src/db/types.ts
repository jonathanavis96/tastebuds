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
  created_at: string;
}
