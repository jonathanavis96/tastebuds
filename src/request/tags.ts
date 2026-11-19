import type { TitleRow } from '../db/types.js';
import type { CanonGenre } from './rules.js';

export type TaggableTitle = Pick<TitleRow, 'media_type' | 'genres' | 'keywords' | 'imdb_genres'>;

/**
 * The canonical genres a title carries, from every source that names one: TMDB
 * genres, IMDb genres, and keywords that literally name a genre ("thriller",
 * "supernatural horror"). TMDB's TV bundles ("Sci-Fi & Fantasy",
 * "Action & Adventure") are split using IMDb's genres when those are known.
 */
export function titleTags(title: TaggableTitle): Set<CanonGenre> {
  void title;
  throw new Error('not implemented');
}
