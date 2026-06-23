export interface Profile {
  id: number;
  name: string;
  media_weighting: number;
  is_derived: number;
  config: string;
}

export interface TitleInfo {
  id: number;
  tmdb_id: number;
  media_type: 'movie' | 'tv';
  title: string;
  year: number | null;
  genres: string;
  synopsis: string | null;
  poster_path: string | null;
}

export type RecKind = 'core' | 'wildcard' | 'adversarial';

export interface Recommendation {
  id: number;
  profile_id: number;
  title_id: number;
  category: string;
  kind?: RecKind;
  score: number;
  why_blurb: string;
  request_text: string | null;
  state: string;
  created_at: string;
  // This profile's own watch state for the title (folded in by enrichRec), so a
  // card opened from Picks reflects watched/rated/noted and supports re-rating.
  we_status?: string | null;
  rating?: number | null;
  watched_at?: string | null;
  note?: string | null;
  title?: string;
  year?: number;
  poster_path?: string | null;
  synopsis?: string | null;
  media_type?: 'movie' | 'tv' | null;
  genres?: string | null;
  cast?: string | null;
  tmdb_id?: number | null;
  imdb_id?: string | null;
  imdb_rating?: string | null;
  rt_rating?: string | null;
  rt_url?: string | null;
}

export interface WatchEvent {
  id: number;
  profile_id: number;
  title_id: number;
  status: string;
  rating: number | null;
  watched_at: string | null;
  note?: string | null;
  created_at: string;
  title?: string;
  year?: number;
  poster_path?: string | null;
  synopsis?: string | null;
  media_type?: 'movie' | 'tv' | null;
  genres?: string | null;
  cast?: string | null;
  imdb_id?: string | null;
  imdb_rating?: string | null;
  rt_rating?: string | null;
  rt_url?: string | null;
}

export type MediaFilter = 'all' | 'movie' | 'tv';
