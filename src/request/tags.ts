import type { TitleRow } from '../db/types.js';
import type { CanonGenre } from './rules.js';

export type TaggableTitle = Pick<TitleRow, 'media_type' | 'genres' | 'keywords' | 'imdb_genres'>;

/** TMDB (film and TV) and IMDb genre names, lowercased, → canonical genres. */
const GENRE_NAMES: Record<string, CanonGenre[]> = {
  action: ['Action'],
  adventure: ['Adventure'],
  animation: ['Animation'],
  comedy: ['Comedy'],
  crime: ['Crime'],
  documentary: ['Documentary'],
  drama: ['Drama'],
  family: ['Family'],
  kids: ['Family'],
  fantasy: ['Fantasy'],
  history: ['History'],
  horror: ['Horror'],
  music: ['Music'],
  musical: ['Music'],
  mystery: ['Mystery'],
  reality: ['Reality'],
  'reality-tv': ['Reality'],
  'game-show': ['Reality'],
  romance: ['Romance'],
  'science fiction': ['Science Fiction'],
  'sci-fi': ['Science Fiction'],
  thriller: ['Thriller'],
  war: ['War'],
  western: ['Western'],
  'film-noir': ['Crime'],
};

/** TMDB's TV bundles: each names more than one genre, and IMDb's genres say which applies. */
const BUNDLES: Record<string, CanonGenre[]> = {
  'sci-fi & fantasy': ['Science Fiction', 'Fantasy'],
  'action & adventure': ['Action', 'Adventure'],
  'war & politics': ['War'],
};

/** Keywords that are a genre name on their own. */
const GENRE_KEYWORDS: Record<string, CanonGenre[]> = {
  'science fiction': ['Science Fiction'],
  'sci fi': ['Science Fiction'],
  romcom: ['Romance', 'Comedy'],
  'romantic comedy': ['Romance', 'Comedy'],
  'rom com': ['Romance', 'Comedy'],
  whodunit: ['Mystery'],
  docuseries: ['Documentary'],
};

/**
 * The last word of a keyword that names a genre: "psychological thriller",
 * "supernatural horror", "dark comedy", "courtroom drama". Words that are just
 * as often a subject ("war", "family", "crime", "music") are left out.
 */
const GENRE_KEYWORD_ENDINGS: Record<string, CanonGenre> = {
  thriller: 'Thriller',
  suspense: 'Thriller',
  horror: 'Horror',
  slasher: 'Horror',
  comedy: 'Comedy',
  sitcom: 'Comedy',
  drama: 'Drama',
  fantasy: 'Fantasy',
  romance: 'Romance',
  mystery: 'Mystery',
  documentary: 'Documentary',
  animation: 'Animation',
  anime: 'Animation',
  western: 'Western',
  musical: 'Music',
};

/** A JSON array of strings from a column that may be null or malformed; [] when unusable. */
export function jsonStrings(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function keywordGenres(keyword: string): CanonGenre[] {
  const k = keyword.toLowerCase().replace(/-/g, ' ').trim();
  const exact = GENRE_KEYWORDS[k];
  if (exact) return exact;
  const ending = GENRE_KEYWORD_ENDINGS[k.slice(k.lastIndexOf(' ') + 1)];
  return ending ? [ending] : [];
}

/**
 * The canonical genres a title carries, from every source that names one: TMDB
 * genres, IMDb genres, and keywords that literally name a genre ("thriller",
 * "supernatural horror"). TMDB's TV bundles ("Sci-Fi & Fantasy",
 * "Action & Adventure") are split using IMDb's genres when those are known.
 */
export function titleTags(title: TaggableTitle): Set<CanonGenre> {
  const imdb = new Set(jsonStrings(title.imdb_genres).flatMap((g) => GENRE_NAMES[g.toLowerCase()] ?? []));
  const tags = new Set<CanonGenre>(imdb);
  for (const name of jsonStrings(title.genres)) {
    const n = name.toLowerCase();
    const bundle = BUNDLES[n];
    if (!bundle) {
      for (const g of GENRE_NAMES[n] ?? []) tags.add(g);
      continue;
    }
    // "Sci-Fi & Fantasy" + IMDb "Sci-Fi" → Science Fiction only. When IMDb names
    // neither half (or is unknown), the bundle counts as both.
    const confirmed = bundle.filter((g) => imdb.has(g));
    for (const g of confirmed.length > 0 ? confirmed : bundle) tags.add(g);
  }
  for (const k of jsonStrings(title.keywords)) for (const g of keywordGenres(k)) tags.add(g);
  return tags;
}
