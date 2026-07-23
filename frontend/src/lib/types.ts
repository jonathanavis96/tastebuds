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

/** Dismiss-reason tile keys (Phase-1.5 step 3), mirrored from src/curation/dismissFeedback.ts. */
export type DismissReason = 'not_my_genre' | 'too_dark' | 'seen_enough' | 'cast_vibe' | 'not_in_mood';

/** The ≤5 tiles shown after "Not interested", in the spec's order. */
export const DISMISS_REASON_TILES: Array<{ key: DismissReason; label: string }> = [
  { key: 'not_my_genre', label: 'Not my genre' },
  { key: 'too_dark', label: 'Too dark/violent' },
  { key: 'seen_enough', label: 'Seen enough like it' },
  { key: 'cast_vibe', label: 'Cast/vibe' },
  { key: 'not_in_mood', label: 'Not in the mood' },
];
