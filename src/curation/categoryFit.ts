import type { TitleRow } from '../db/types.js';
import { HIDDEN_GEM_MAX_IMDB_VOTES } from '../request/rules.js';
import type { CanonGenre } from '../request/rules.js';
import { titleTags } from '../request/tags.js';
import { EASY_GENRES } from '../request/vocabulary.js';

type LabelledTitle = Pick<TitleRow, 'media_type' | 'genres' | 'keywords' | 'imdb_genres' | 'imdb_votes'>;

/** A comfort watch is never one of these. */
const UNCOMFORTABLE: CanonGenre[] = ['Horror', 'Thriller', 'War'];

/**
 * The label the model chose, when the title earns it; otherwise `fallback`.
 * The model writes "Hidden gem" and "Comfort watch" by feel and sometimes
 * misfits them (a horror film as a comfort watch), so each has a rule here:
 *  - Hidden gem: known IMDb votes, at most HIDDEN_GEM_MAX_IMDB_VOTES (the same
 *    line as a "hidden gem" request).
 *  - Comfort watch: one of the easy genres (Comedy, Family, Romance, Animation,
 *    Adventure) and none of Horror, Thriller or War.
 * Every other label is kept as written.
 */
export function fittingCategory(category: string, title: LabelledTitle, fallback: string): string {
  if (category === 'Hidden gem') {
    return title.imdb_votes !== null && title.imdb_votes <= HIDDEN_GEM_MAX_IMDB_VOTES ? category : fallback;
  }
  if (category === 'Comfort watch') {
    const tags = titleTags(title);
    const easy = EASY_GENRES.some((g) => tags.has(g));
    return easy && !UNCOMFORTABLE.some((g) => tags.has(g)) ? category : fallback;
  }
  return category;
}
