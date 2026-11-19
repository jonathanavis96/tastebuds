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

/**
 * Subjects that put a "Sci-Fi & Fantasy" series on one side when IMDb's list
 * cannot (Black Mirror is listed as Crime, Drama, Mystery: Sci-Fi was cut).
 */
const SCI_FI_SUBJECTS = wordPattern([
  'science fiction', 'sci fi', 'dystopia', 'dystopian', 'post apocalyptic', 'time travel', 'time machine',
  'time loop', 'alien', 'extraterrestrial', 'ufo', 'space', 'spacecraft', 'spaceship', 'planet', 'astronaut',
  'artificial intelligence', 'robot', 'android', 'cyborg', 'cyberpunk', 'mecha', 'mutant', 'clone', 'cloning',
  'genetic engineering', 'virtual reality', 'simulation', 'parallel universe', 'parallel world', 'multiverse',
  'alternate history', 'alternate reality', 'alternate timeline', 'future', 'futuristic', 'technology',
  'scientist', 'experiment', 'nuclear war', 'superhero', 'teleportation', 'telekinesis', 'kaiju', 'steampunk',
]);
const WAR_SUBJECT = wordPattern(['war', 'battle', 'soldier', 'military', 'army']);
const FANTASY_SUBJECTS = wordPattern([
  'fantasy', 'magic', 'sorcery', 'sorcerer', 'witch', 'wizard', 'dragon', 'elf', 'elves', 'dwarf', 'troll',
  'fairy', 'mythology', 'curse', 'demon', 'vampire', 'werewolf', 'ghost', 'supernatural', 'paranormal',
  'god', 'goddess', 'underworld', 'afterlife', 'reincarnation', 'alchemy', 'mermaid', 'monster', 'exorcism',
  'possession', 'immortal', 'immortality', 'chosen one', 'isekai', 'yokai', 'zombie', 'undead', 'devil',
  'prophecy', 'folklore', 'shapeshifter', 'necromancer', 'occult',
]);

/** Any of `words` as whole words, with an optional plural, in text whose hyphens are spaces. */
function wordPattern(words: string[]): RegExp {
  return new RegExp(`(?<![a-z0-9])(?:${words.join('|')})(?:s|es)?(?![a-z0-9])`);
}

/**
 * Series keywords that are a genre name on their own. Only for what TMDB's TV
 * genre list cannot say: it has no Thriller, Horror, Romance or Music, and
 * bundles Science Fiction with Fantasy. Comedy, Drama, Crime, Mystery and the
 * rest it tags itself, and a keyword there misleads ("dark comedy" is on
 * Breaking Bad, "based on anime" on live-action remakes).
 */
const GENRE_KEYWORDS: Record<string, CanonGenre[]> = {
  'science fiction': ['Science Fiction'],
  'sci fi': ['Science Fiction'],
  romcom: ['Romance', 'Comedy'],
  'romantic comedy': ['Romance', 'Comedy'],
  'rom com': ['Romance', 'Comedy'],
};

/**
 * The last word of a series keyword that names such a genre: "psychological
 * thriller", "supernatural horror", "dark fantasy", "teen romance". The last
 * word is the kind of thing it is: a "horror comedy" is a comedy.
 */
const GENRE_KEYWORD_ENDINGS: Record<string, CanonGenre> = {
  thriller: 'Thriller',
  suspense: 'Thriller',
  horror: 'Horror',
  slasher: 'Horror',
  fantasy: 'Fantasy',
  romance: 'Romance',
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

/** IMDb's data file lists at most this many genres per title, in alphabetical order. */
const IMDB_GENRES_LISTED = 3;
/** A series is put on one side of "Sci-Fi & Fantasy" when its keywords point there this many times as often. */
const ONE_SIDED = 3;

/**
 * The genres a TMDB TV bundle stands for on this series, or null when `name` is
 * an ordinary genre. `imdbNames` are IMDb's own names; because IMDb lists three
 * at most, alphabetically, a late name such as "Sci-Fi" or "War" is often the
 * one cut, while "Action" and "Adventure" never are.
 */
function bundleGenres(name: string, imdbNames: string[], keywords: string[]): CanonGenre[] | null {
  const about = keywords.map((k) => k.toLowerCase().replace(/-/g, ' '));
  switch (name) {
    case 'action & adventure':
      if (imdbNames.length === 0) return ['Action', 'Adventure'];
      return (['Action', 'Adventure'] as const).filter((g) => imdbNames.includes(g));
    case 'war & politics':
      // Mostly political drama: War only with a second source for it.
      return imdbNames.includes('War') || about.some((k) => WAR_SUBJECT.test(k)) ? ['War'] : [];
    case 'sci-fi & fantasy':
      return sciFiOrFantasy(imdbNames, about);
    default:
      return null;
  }
}

function sciFiOrFantasy(imdbNames: string[], about: string[]): CanonGenre[] {
  // "Fantasy" sorts before "Sci-Fi": a list that reached Sci-Fi would name Fantasy too.
  if (imdbNames.includes('Sci-Fi')) return imdbNames.includes('Fantasy') ? ['Science Fiction', 'Fantasy'] : ['Science Fiction'];
  const sciFi = about.filter((k) => SCI_FI_SUBJECTS.test(k)).length;
  const fantasy = about.filter((k) => FANTASY_SUBJECTS.test(k)).length;
  if (imdbNames.includes('Fantasy')) {
    // Sci-Fi can only have been cut from a full list; then the keywords decide.
    const cut = imdbNames.length >= IMDB_GENRES_LISTED;
    return cut && sciFi > 0 && fantasy < ONE_SIDED * sciFi ? ['Fantasy', 'Science Fiction'] : ['Fantasy'];
  }
  if (sciFi > 0 && sciFi >= ONE_SIDED * fantasy) return ['Science Fiction'];
  if (fantasy > 0 && fantasy >= ONE_SIDED * sciFi) return ['Fantasy'];
  return ['Science Fiction', 'Fantasy'];
}

/**
 * The canonical genres a title carries, from every source that names one: TMDB
 * genres, IMDb genres and, for a series, keywords that literally name a genre
 * ("thriller", "supernatural horror"). TMDB's TV bundles ("Sci-Fi & Fantasy",
 * "Action & Adventure", "War & Politics") are split, see bundleGenres.
 */
export function titleTags(title: TaggableTitle): Set<CanonGenre> {
  const imdbNames = jsonStrings(title.imdb_genres);
  const keywords = jsonStrings(title.keywords);
  const tags = new Set<CanonGenre>(imdbNames.flatMap((g) => GENRE_NAMES[g.toLowerCase()] ?? []));
  for (const name of jsonStrings(title.genres)) {
    const n = name.toLowerCase();
    for (const g of bundleGenres(n, imdbNames, keywords) ?? GENRE_NAMES[n] ?? []) tags.add(g);
  }
  // Series only: TMDB has no Thriller, Horror or Science Fiction genre for them.
  // A film's two genre lists are curated, and a keyword such as "comedy horror"
  // on a satire would label it Horror.
  if (title.media_type === 'tv') {
    for (const k of keywords) for (const g of keywordGenres(k)) tags.add(g);
  }
  return tags;
}
