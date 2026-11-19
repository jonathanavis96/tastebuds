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
  imdb_votes?: number | null;
  /** Canonical genres (the server's titleTags), in place of the raw TMDB genres. */
  tags?: string[];
  /** Why this pick bends the request's rules, e.g. an older title when too few recent ones matched. */
  rule_note?: string | null;
}

/** What the server read a typed request as, mirrored from src/request/rules.ts. */
export interface RequestSummary {
  /** The request as typed. */
  text: string;
  /** One short chip per rule, in reading order: ["Thriller", "Films", "2025 or newer"]. */
  understood: string[];
  /** How many titles in the library satisfy every rule. */
  matched: number;
  note: string | null;
}

/** One request's picks in the list, or (text null) the picks made without one. */
export interface FeedSection {
  text: string | null;
  summary: RequestSummary | null;
  recIds: number[];
}

/** GET /recommendations, POST /generate and Clear list: the picks, in sections, newest request first. */
export interface FeedResponse {
  /** Every pick, in the order of `sections`. */
  recs: Recommendation[];
  sections: FeedSection[];
  /** The request just run, on POST /generate with a request; otherwise null. */
  request: RequestSummary | null;
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

/** Dismiss-reason tile keys, mirrored from src/curation/dismissFeedback.ts. */
export type DismissReason = 'not_my_genre' | 'too_dark' | 'seen_enough' | 'cast_vibe' | 'not_in_mood';

/** The ≤5 tiles shown after "Not interested", in the spec's order. */
export const DISMISS_REASON_TILES: Array<{ key: DismissReason; label: string }> = [
  { key: 'not_my_genre', label: 'Not my genre' },
  { key: 'too_dark', label: 'Too dark/violent' },
  { key: 'seen_enough', label: 'Seen enough like it' },
  { key: 'cast_vibe', label: 'Cast/vibe' },
  { key: 'not_in_mood', label: 'Not in the mood' },
];

/** One shape on the taste chart: stars above/below this profile's usual rating, per genre spoke. */
export interface TasteSeries {
  profileId: number;
  label: string;
  kind: 'person' | 'together';
  lifts: Array<number | null>;
  counts: number[];
  total: number;
}

export interface TasteChart {
  axes: string[];
  series: TasteSeries[];
}
