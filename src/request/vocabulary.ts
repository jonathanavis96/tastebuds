import type { CanonGenre } from './rules.js';

/**
 * The words parseRequest knows. Every phrase is written lowercase, with hyphens
 * as spaces and each word in its singular form: the parser reduces "Sci-Fi
 * thrillers" to "sci fi thriller" before looking anything up.
 */

/** A subject the request can name; all of a request's subjects form one any-of clause. */
export interface Theme {
  label: string;
  terms: string[];
}

export const THEMES: Record<string, Theme> = {
  'mind-bending': {
    label: 'Mind-bending',
    terms: [
      'mind bending', 'mind-bending', 'mindfuck', 'time travel', 'time loop', 'time machine',
      'time paradox', 'alternate reality', 'alternative reality', 'alternate timeline',
      'alternate universe', 'parallel universe', 'parallel world', 'multiverse', 'simulation',
      'simulated reality', 'virtual reality', 'dream', 'dream world', 'subconscious', 'memory',
      'memory loss', 'amnesia', 'surreal', 'surrealism', 'twist ending', 'plot twist',
      'nonlinear timeline', 'paradox', 'hallucination', 'consciousness', 'high concept',
      'psychological thriller', 'identity crisis', 'reality',
    ],
  },
  apocalypse: {
    label: 'Apocalypse',
    terms: [
      'apocalypse', 'apocalyptic', 'post-apocalyptic', 'post apocalyptic',
      'post-apocalyptic future', 'end of the world', 'world ending', 'doomsday', 'extinction',
      'pandemic', 'global threat', 'disaster',
    ],
  },
  dystopia: {
    label: 'Dystopian',
    terms: ['dystopia', 'dystopian', 'totalitarian', 'authoritarian', 'totalitarianism'],
  },
  space: {
    label: 'Space',
    terms: [
      'space', 'outer space', 'spacecraft', 'spaceship', 'space travel', 'space station',
      'space mission', 'astronaut', 'planet', 'alien planet', 'mars', 'moon', 'interstellar',
      'space opera', 'galaxy',
    ],
  },
  time: {
    label: 'Time',
    terms: [
      'time travel', 'time loop', 'time machine', 'time paradox', 'alternate timeline', 'time',
      'future', 'past',
    ],
  },
  'time travel': {
    label: 'Time travel',
    terms: [
      'time travel', 'time traveler', 'time traveller', 'time loop', 'time machine',
      'time paradox', 'alternate timeline',
    ],
  },
  superpowers: {
    label: 'Superpowers',
    terms: [
      'superpower', 'super power', 'superpowers', 'super powers', 'superhero', 'superhuman',
      'mutant', 'supernatural power', 'hidden powers', 'telekinesis', 'special powers',
    ],
  },
  medical: {
    label: 'Medical',
    terms: [
      'medical', 'medical drama', 'medical procedural', 'hospital', 'doctor', 'surgeon', 'nurse',
      'medicine', 'emergency room', 'physician', 'paramedic',
    ],
  },
  'true story': {
    label: 'True story',
    terms: [
      'true story', 'based on true story', 'based on a true story', 'based on real events',
      'real events', 'true events', 'biography', 'biographical', 'biopic', 'historical figure',
    ],
  },
  heist: { label: 'Heist', terms: ['heist', 'robbery', 'bank robbery', 'caper', 'con artist', 'thief'] },
  spy: { label: 'Spy', terms: ['spy', 'espionage', 'secret agent', 'cia', 'mi6', 'kgb'] },
  zombie: { label: 'Zombies', terms: ['zombie', 'undead', 'zombie apocalypse', 'living dead'] },
  vampire: { label: 'Vampires', terms: ['vampire', 'dracula', 'bloodsucker'] },
  'serial killer': { label: 'Serial killer', terms: ['serial killer', 'serial murderer', 'psychopath'] },
  alien: {
    label: 'Aliens',
    terms: ['alien', 'extraterrestrial', 'alien invasion', 'ufo', 'first contact', 'alien abduction'],
  },
  survival: { label: 'Survival', terms: ['survival', 'survivor', 'stranded', 'wilderness'] },
  revenge: { label: 'Revenge', terms: ['revenge', 'vengeance', 'retribution', 'avenger'] },
  courtroom: {
    label: 'Courtroom',
    terms: ['courtroom', 'trial', 'lawyer', 'legal drama', 'attorney', 'court case', 'jury'],
  },
  'haunted house': {
    label: 'Haunted',
    terms: ['haunted house', 'haunted', 'haunting', 'ghost', 'poltergeist'],
  },
  witch: { label: 'Witches', terms: ['witch', 'witchcraft', 'coven'] },
  werewolf: { label: 'Werewolves', terms: ['werewolf', 'lycanthrope'] },
  monster: { label: 'Monsters', terms: ['monster', 'creature', 'kaiju', 'giant monster'] },
  cult: { label: 'Cults', terms: ['cult', 'sect', 'cult leader'] },
  conspiracy: { label: 'Conspiracy', terms: ['conspiracy', 'cover up', 'cover-up'] },
  dinosaur: { label: 'Dinosaurs', terms: ['dinosaur', 'jurassic'] },
  ai: {
    label: 'AI',
    terms: ['artificial intelligence', 'artificial intelligence (a.i.)', 'robot', 'android', 'cyborg'],
  },
  sport: {
    label: 'Sport',
    terms: ['sport', 'sports', 'football', 'soccer', 'basketball', 'baseball', 'boxing', 'athlete'],
  },
  psychological: {
    label: 'Psychological',
    terms: ['psychological', 'psychology', 'psychological thriller', 'paranoia', 'mental illness'],
  },
  devil: {
    label: 'Devils',
    terms: [
      'devil', 'demon', 'demonic', 'demonic possession', 'satan', 'satanic', 'satanism',
      'possession', 'exorcism', 'exorcist', 'antichrist', 'demonology',
    ],
  },
  nun: { label: 'Nuns', terms: ['nun', 'evil nun', 'convent'] },
  gore: { label: 'Gore', terms: ['gore', 'gory', 'splatter', 'torture'] },
  'jump scare': { label: 'Jump scares', terms: ['jump scare'] },
  friendship: {
    label: 'Friendship',
    terms: ['friendship', 'best friend', 'buddy', 'buddy comedy', 'female friendship', 'male friendship'],
  },
  'true crime': {
    label: 'True crime',
    terms: ['true crime', 'based on true story', 'based on a true story', 'real crime', 'criminal investigation', 'murder investigation'],
  },
  christmas: { label: 'Christmas', terms: ['christmas', 'xmas', 'santa claus', 'santa', 'christmas eve', 'holiday season'] },
  halloween: { label: 'Halloween', terms: ['halloween', 'trick or treat', 'trick or treating'] },
};

const THEME_WORDS: Record<string, string[]> = {
  'mind-bending': [
    'mind bending', 'mindbending', 'mind bender', 'mind blowing', 'mind twisting', 'mindfuck',
    'mind fuck', 'trippy', 'twisty',
  ],
  apocalypse: [
    'apocalypse', 'apocalyptic', 'post apocalyptic', 'post apocalypse', 'world ending',
    'end of the world', 'end of world', 'doomsday',
  ],
  dystopia: ['dystopian', 'dystopia'],
  space: ['space', 'outer space', 'planet', 'astronaut', 'spaceship', 'galaxy', 'interstellar'],
  time: ['time'],
  'time travel': ['time travel', 'time traveling', 'time travelling', 'time loop', 'time machine'],
  superpowers: ['superpower', 'super power', 'superhero', 'super hero', 'mutant'],
  medical: ['medical', 'hospital', 'doctor', 'surgeon', 'nurse', 'paramedic'],
  'true story': [
    'true story', 'based on a true story', 'based on true story', 'real event', 'true event',
    'biopic', 'biographical', 'biography',
  ],
  heist: ['heist', 'robbery', 'caper'],
  spy: ['spy', 'espionage', 'secret agent'],
  zombie: ['zombie', 'undead'],
  vampire: ['vampire', 'dracula'],
  'serial killer': ['serial killer'],
  alien: ['alien', 'extraterrestrial', 'ufo', 'alien invasion'],
  survival: ['survival'],
  revenge: ['revenge', 'vengeance'],
  courtroom: ['courtroom', 'legal', 'lawyer'],
  'haunted house': ['haunted house', 'haunted', 'haunting', 'ghost'],
  witch: ['witch', 'witchcraft'],
  werewolf: ['werewolf'],
  monster: ['monster', 'creature', 'kaiju'],
  cult: ['cult'],
  conspiracy: ['conspiracy'],
  dinosaur: ['dinosaur'],
  ai: ['ai', 'artificial intelligence', 'robot', 'android'],
  sport: ['sport', 'football', 'soccer', 'boxing'],
  psychological: ['psychological'],
  devil: ['devil', 'demon', 'demonic', 'satan', 'satanic', 'possession', 'exorcism', 'exorcist', 'antichrist'],
  nun: ['nun', 'convent'],
  gore: ['gore', 'gory', 'splatter', 'torture'],
  'jump scare': ['jump scare'],
  friendship: ['best friend', 'friendship', 'buddy'],
  'true crime': ['true crime'],
  christmas: ['christmas', 'xmas', 'festive'],
  halloween: ['halloween'],
};

/**
 * Themes that name a feel rather than a subject. Like a mood word, a feel is a
 * soft rule (RuleClause.soft): space, time travel, true story or christmas say
 * what a title is about and always hold, while "mind-bending" or
 * "psychological" describe how it plays, which titles' keywords record unevenly.
 */
export const FEEL_THEMES: ReadonlySet<string> = new Set(['mind-bending', 'psychological']);

/**
 * A genre or mood word. `noun` marks a genre noun ("thriller", "horror"), which
 * may be joined to the next one by "and"/"or" into one either-of clause; mood
 * words ("scary", "gripping") never join. `soft` marks a mood word, whose
 * clause may be missed by a close match (RuleClause.soft); every mood word is
 * soft except "kid friendly" / "family friendly", which is a hard requirement.
 */
interface GenreWord {
  genres: CanonGenre[];
  label: string;
  noun: boolean;
  soft: boolean;
}

function genre(g: CanonGenre, label: string, noun: boolean, words: string[], soft = !noun): [string, GenreWord][] {
  return words.map((w) => [w, { genres: [g], label, noun, soft }]);
}

const GENRE_WORDS: [string, GenreWord][] = [
  ...genre('Thriller', 'Thriller', true, ['thriller', 'suspense']),
  ...genre('Thriller', 'Gripping', false, ['gripping']),
  ...genre('Thriller', 'Tense', false, ['tense', 'suspenseful', 'nail biting', 'nail biter', 'heart pounding']),
  ...genre('Thriller', 'Edge-of-seat', false, ['edge of your seat', 'edge of the seat', 'edge of seat']),
  ...genre('Horror', 'Horror', true, ['horror', 'slasher']),
  ...genre('Horror', 'Scary', false, ['scary', 'scare', 'scariest', 'frightening', 'terrifying', 'horrifying']),
  ...genre('Horror', 'Spooky', false, ['spooky']),
  ...genre('Horror', 'Creepy', false, ['creepy']),
  ...genre('Science Fiction', 'Sci-fi', true, ['sci fi', 'scifi', 'sifi', 'syfy', 'science fiction']),
  ...genre('Action', 'Action', true, ['action']),
  ...genre('Action', 'Action', false, ['action packed', 'high octane', 'adrenaline', 'explosive']),
  ...genre('Comedy', 'Comedy', true, ['comedy', 'sitcom']),
  ...genre('Comedy', 'Funny', false, ['funny', 'hilarious', 'comedic', 'laugh']),
  ...genre('Romance', 'Romance', true, ['romance', 'love story']),
  ...genre('Romance', 'Romantic', false, ['romantic']),
  ...genre('Crime', 'Crime', true, ['crime', 'gangster', 'mafia']),
  ...genre('Mystery', 'Mystery', true, ['mystery', 'whodunit', 'whodunnit', 'murder mystery']),
  ...genre('Drama', 'Drama', true, ['drama']),
  ...genre('Drama', 'Dramatic', false, ['dramatic']),
  ...genre('Fantasy', 'Fantasy', true, ['fantasy']),
  ...genre('Animation', 'Animation', true, ['animation', 'anime', 'cartoon']),
  ...genre('Animation', 'Animated', false, ['animated']),
  ...genre('Documentary', 'Documentary', true, ['documentary', 'docuseries', 'doc', 'docu']),
  ...genre('Adventure', 'Adventure', true, ['adventure']),
  ...genre('Family', 'Family', true, ['family', 'kid']),
  ...genre('Family', 'Family', false, ['kid friendly', 'family friendly'], false),
  ...genre('War', 'War', true, ['war']),
  ...genre('Western', 'Western', true, ['western', 'cowboy']),
  ...genre('History', 'History', true, ['history']),
  ...genre('History', 'Historical', false, ['historical', 'period']),
  ...genre('Music', 'Musical', true, ['musical', 'music']),
  ...genre('Reality', 'Reality', true, ['reality show', 'reality tv']),
  ['rom com', { genres: ['Romance', 'Comedy'], label: 'Rom-com', noun: false, soft: true }],
  ['romcom', { genres: ['Romance', 'Comedy'], label: 'Rom-com', noun: false, soft: true }],
];

/** "Easy watch" means one of these, and never Horror, when the request names no genre. */
export const EASY_GENRES: CanonGenre[] = ['Comedy', 'Family', 'Romance', 'Animation', 'Adventure'];

/**
 * Tone words, each with the chip it shows. A tone is a rule: the title may not
 * be Horror (see parse.ts), and with no genre named it must be one of EASY_GENRES.
 */
const EASY_WORDS: [string, string[]][] = [
  ['Easy watch', ['easy watch', 'easy watching', 'easy to watch', 'easy', 'casual']],
  ['Light', ['light', 'light hearted', 'lighthearted']],
  ['Feel-good', ['feel good', 'feelgood']],
  ['Cosy', ['cosy', 'cozy']],
  ['Comforting', ['comfort', 'comforting']],
  ['Relaxing', ['chill', 'relaxing']],
  ['Wholesome', ['wholesome']],
  ['Heartwarming', ['heartwarming']],
  ['Uplifting', ['uplifting']],
];

const MEDIA_WORDS: [string, 'movie' | 'tv'][] = [
  ['movie', 'movie'], ['film', 'movie'], ['flick', 'movie'], ['feature', 'movie'],
  ['series', 'tv'], ['show', 'tv'], ['tv', 'tv'], ['tv show', 'tv'], ['tv series', 'tv'],
  ['miniseries', 'tv'], ['mini series', 'tv'], ['binge', 'tv'], ['season', 'tv'], ['episode', 'tv'],
];

/** Original-language codes and the words that ask for them. */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', ko: 'Korean', ja: 'Japanese', fr: 'French', es: 'Spanish', de: 'German',
  it: 'Italian', hi: 'Hindi', zh: 'Chinese', sv: 'Swedish', da: 'Danish', no: 'Norwegian',
  tr: 'Turkish', pt: 'Portuguese',
};

const LANGUAGE_WORDS: [string, string][] = [
  ...Object.entries(LANGUAGE_NAMES).map(([code, name]): [string, string] => [name.toLowerCase(), code]),
  ['american', 'en'], ['british', 'en'], ['bollywood', 'hi'], ['mandarin', 'zh'],
];

const TOP_RATING_WORDS = ['top rated', 'highest rated', 'best rated', 'best'];
const GOOD_RATING_WORDS = [
  'high rated', 'highly rated', 'rated highly', 'good rating', 'good review', 'great rating',
  'great review', 'well reviewed', 'well rated', 'highly reviewed', 'acclaimed',
  'critically acclaimed',
];
const HIDDEN_GEM_WORDS = ['hidden gem', 'underrated', 'lesser known', 'under the radar', 'overlooked'];
const NEW_WORDS = ['new', 'newest', 'latest', 'just released', 'brand new', 'new release', 'newly released'];
const RECENT_WORDS = ['recent', 'recently', 'recently released'];
const ANY_YEAR_WORDS = [
  'classic', 'old', 'older', 'oldie', 'vintage', 'retro', 'of all time', 'all time', 'old school',
  'any year', 'any era', 'any decade', 'any age', 'all years', 'all eras', 'from any year', 'from any era',
];

export type Entry =
  | ({ kind: 'genre' } & GenreWord)
  | { kind: 'theme'; theme: string }
  | { kind: 'easy'; label: string }
  | { kind: 'media'; media: 'movie' | 'tv' }
  | { kind: 'language'; code: string }
  | { kind: 'rating'; floor: 'good' | 'top' }
  | { kind: 'hiddenGem' }
  | { kind: 'recency'; recency: 'new' | 'recent' }
  | { kind: 'anyYear' };

function build(): Map<string, Entry> {
  const map = new Map<string, Entry>();
  const add = (words: string[], entry: Entry) => { for (const w of words) map.set(w, entry); };
  for (const [theme, words] of Object.entries(THEME_WORDS)) add(words, { kind: 'theme', theme });
  for (const [w, g] of GENRE_WORDS) map.set(w, { kind: 'genre', ...g });
  for (const [label, words] of EASY_WORDS) add(words, { kind: 'easy', label });
  for (const [w, media] of MEDIA_WORDS) map.set(w, { kind: 'media', media });
  for (const [w, code] of LANGUAGE_WORDS) map.set(w, { kind: 'language', code });
  add(TOP_RATING_WORDS, { kind: 'rating', floor: 'top' });
  add(GOOD_RATING_WORDS, { kind: 'rating', floor: 'good' });
  add(HIDDEN_GEM_WORDS, { kind: 'hiddenGem' });
  add(NEW_WORDS, { kind: 'recency', recency: 'new' });
  add(RECENT_WORDS, { kind: 'recency', recency: 'recent' });
  add(ANY_YEAR_WORDS, { kind: 'anyYear' });
  return map;
}

/** Phrase (singular words, spaces) → what it means. */
export const LEXICON: ReadonlyMap<string, Entry> = build();

/**
 * Words that carry no rule: articles, pronouns, request verbs, occasions
 * ("tonight", "Sunday night") and pace or quality words ("fast paced",
 * "clever"), which stay in the embedded text and only affect ordering.
 */
export const FILLER: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'it', 'its', 'they', 'them',
  'their', 'he', 'she', 'this', 'that', 'these', 'those', 'some', 'something', 'anything', 'any',
  'one', 'all', 'both', 'what', 'which', 'who', 'where', 'whatever', 'there', 'here', 'now',
  'get', 'got', 'give', 'find', 'recommend', 'suggest', 'want', 'wanna', 'need', 'looking',
  'look', 'search', 'please', 'can', 'could', 'would', 'will', 'should', 'write', 'pick',
  'choose', 'help', 'try', 'let', 'show', 'see', 'watch', 'watching', 'watchable', 'view',
  'more', 'another', 'other', 'else', 'few', 'many', 'much', 'very', 'really', 'so', 'too',
  'quite', 'pretty', 'just', 'also', 'maybe', 'perhaps', 'if', 'and', 'or', 'but', 'nor',
  'with', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'from', 'about', 'into', 'as', 'up',
  'out', 'is', 'are', 'be', 'was', 'were', 'been', 'am', 'have', 'has', 'had', 'do', 'does',
  'based', 'type', 'kind', 'sort', 'style', 'like', 'similar', 'line', 'vein', 'stuff',
  'thing', 'story', 'plot', 'tonight', 'today', 'tomorrow', 'night', 'evening', 'weekend',
  'afternoon', 'morning', 'day', 'rainy', 'date', 'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'saturday', 'sunday', 'year', 'release', 'released', 'made', 'rated', 'rating',
  'review', 'fast', 'paced', 'pace', 'pacing', 'slow', 'burn', 'clever', 'smart',
  'intelligent', 'interesting', 'vibe', 'momentum', 'good', 'great', 'nice', 'decent',
  'solid', 'fun', 'entertaining', 'enjoyable', 'engaging', 'dark', 'intense', 'deep', 'short',
  'long', 'quality', 'well', 'written', 'top', 'sure', 'lol', 'thanks', 'id', 'im', 'ive',
  'youd', 'wed', 'lets', 'thats', 'whats',
  // What a title should not feel like cannot be checked against its data, so
  // "not cheesy" is no exclusion; the words still steer the ordering.
  'boring', 'cheesy', 'corny', 'cringe', 'cringey', 'silly', 'stupid', 'dumb', 'bad', 'weird',
  'predictable', 'depressing', 'sad', 'heavy', 'serious', 'dull', 'lame', 'generic', 'cliche',
  'cliched', 'childish', 'trashy', 'pretentious', 'mainstream',
]);

/** Every word that appears in a phrase or the filler list, for reducing plurals. */
export const VOCAB: ReadonlySet<string> = new Set([
  ...[...LEXICON.keys()].flatMap((p) => p.split(' ')),
  ...FILLER,
]);

export const MAX_PHRASE_WORDS = Math.max(...[...LEXICON.keys()].map((p) => p.split(' ').length));

/**
 * Whether a phrase is a mood word or a feel ("scary", "Mind-bending",
 * "edge-of-seat"): a clause the model adds under such a label is soft like the
 * parser's own. Anything else the model adds is hard.
 */
export function isMoodPhrase(phrase: string): boolean {
  const key = phrase.toLowerCase().replace(/[-_]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const entry = LEXICON.get(key);
  if (entry?.kind === 'genre') return entry.soft;
  return entry?.kind === 'theme' && FEEL_THEMES.has(entry.theme);
}
