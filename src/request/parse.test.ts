import { describe, it, expect } from 'vitest';
import { leftoverWords, parseRequest } from './parse.js';
import { describeRules } from './describe.js';
import type { CanonGenre, RuleClause, YearSource } from './rules.js';

const NOW = new Date('2026-11-19T12:00:00Z');

type Clause = { g: CanonGenre[] } | { theme: string[] };

/**
 * One request as typed and the rules it must parse to. Omitted keys mean: no
 * film/series, the default window from 2015, no floor, no exclusions, no
 * references. `needsModel` marks a subject the parser is not expected to know.
 */
interface Expected {
  text: string;
  media?: 'movie' | 'tv';
  yearMin?: number;
  yearSource?: YearSource;
  minImdb?: number;
  language?: string;
  hiddenGem?: boolean;
  must: Clause[];
  mustNot?: Clause[];
  similarTo?: string[];
  needsModel?: boolean;
}

/** The terms a theme clause must contain (a theme clause holds the union of its themes' terms). */
const THEME_TERMS: Record<string, string[]> = {
  'mind-bending': ['mind bending', 'mind-bending', 'mindfuck', 'time travel', 'time loop', 'time machine', 'time paradox', 'alternate reality', 'alternative reality', 'alternate timeline', 'alternate universe', 'parallel universe', 'parallel world', 'multiverse', 'simulation', 'simulated reality', 'virtual reality', 'dream', 'dream world', 'subconscious', 'memory', 'memory loss', 'amnesia', 'surreal', 'surrealism', 'twist ending', 'plot twist', 'nonlinear timeline', 'paradox', 'hallucination', 'consciousness', 'high concept', 'psychological thriller', 'identity crisis', 'reality'],
  'apocalypse': ['apocalypse', 'apocalyptic', 'post-apocalyptic', 'post apocalyptic', 'post-apocalyptic future', 'end of the world', 'world ending', 'doomsday', 'extinction', 'pandemic', 'global threat', 'disaster'],
  'dystopia': ['dystopia', 'dystopian', 'totalitarian', 'authoritarian', 'totalitarianism'],
  'space': ['space', 'outer space', 'spacecraft', 'spaceship', 'space travel', 'space station', 'space mission', 'astronaut', 'planet', 'alien planet', 'mars', 'moon', 'interstellar', 'space opera', 'galaxy'],
  'time': ['time travel', 'time loop', 'time machine', 'time paradox', 'alternate timeline', 'time', 'future', 'past'],
  'superpowers': ['superpower', 'super power', 'superpowers', 'super powers', 'superhero', 'superhuman', 'mutant', 'supernatural power', 'hidden powers', 'telekinesis', 'special powers'],
  'medical': ['medical', 'medical drama', 'medical procedural', 'hospital', 'doctor', 'surgeon', 'nurse', 'medicine', 'emergency room', 'physician', 'paramedic'],
  'stephen king': ['stephen king'],
  'devil': ['devil', 'demon', 'demonic', 'demonic possession', 'satan', 'satanic', 'satanism', 'possession', 'exorcism', 'exorcist', 'antichrist', 'demonology'],
  'nun': ['nun', 'evil nun', 'convent'],
};

const REQUESTS: Expected[] = [
  { text: 'Sci-fi and mind bending', must: [{ g: ['Science Fiction'] }, { theme: ['mind-bending'] }] },
  { text: 'mind-bending sci-fi', must: [{ g: ['Science Fiction'] }, { theme: ['mind-bending'] }] },
  { text: 'Thriller series', media: 'tv', must: [{ g: ['Thriller'] }] },
  { text: 'New romantic comedy', yearMin: 2025, yearSource: 'recent', must: [{ g: ['Romance'] }, { g: ['Comedy'] }] },
  { text: 'Something interesting thriller vibe', must: [{ g: ['Thriller'] }] },
  { text: 'get some more thriller based series that are scary.', media: 'tv', must: [{ g: ['Thriller'] }, { g: ['Horror'] }] },
  { text: 'scary thrillers', must: [{ g: ['Horror'] }, { g: ['Thriller'] }] },
  { text: 'Thrillers with momentum', must: [{ g: ['Thriller'] }] },
  { text: 'Sci-fi and mind-bending and clever.', must: [{ g: ['Science Fiction'] }, { theme: ['mind-bending'] }] },
  { text: 'Mind bending sci-fi thriller', must: [{ g: ['Science Fiction'] }, { g: ['Thriller'] }, { theme: ['mind-bending'] }] },
  { text: 'world ending dystopian sci-fi thriller', must: [{ g: ['Science Fiction'] }, { g: ['Thriller'] }, { theme: ['apocalypse', 'dystopia'] }] },
  { text: 'world ending dystopian thriller science fiction', must: [{ g: ['Science Fiction'] }, { g: ['Thriller'] }, { theme: ['apocalypse', 'dystopia'] }] },
  { text: 'world ending dystopian science fiction thriller', must: [{ g: ['Science Fiction'] }, { g: ['Thriller'] }, { theme: ['apocalypse', 'dystopia'] }] },
  { text: 'Medical dramas', must: [{ g: ['Drama'] }, { theme: ['medical'] }] },
  { text: 'Very scary movie', media: 'movie', must: [{ g: ['Horror'] }] },
  { text: 'Very scare movies', media: 'movie', must: [{ g: ['Horror'] }] },
  { text: 'More scary movies with good ratings.', media: 'movie', minImdb: 7.0, must: [{ g: ['Horror'] }] },
  { text: 'Can you write something thriller light like inception something on those lines', must: [{ g: ['Thriller'] }], mustNot: [{ g: ['Horror'] }], similarTo: ['inception something on those lines'] },
  { text: 'Space, time, mind bending movies', media: 'movie', must: [{ theme: ['space', 'time', 'mind-bending'] }] },
  { text: 'Thrillers mind bending action', must: [{ g: ['Thriller'] }, { g: ['Action'] }, { theme: ['mind-bending'] }] },
  { text: 'casual easy watch', must: [{ g: ['Comedy', 'Family', 'Romance', 'Animation', 'Adventure'] }], mustNot: [{ g: ['Horror'] }] },
  { text: 'Thriller mystery', must: [{ g: ['Thriller'] }, { g: ['Mystery'] }] },
  { text: 'Thriller American series', media: 'tv', language: 'en', must: [{ g: ['Thriller'] }] },
  { text: 'Stephen King series', media: 'tv', must: [{ theme: ['stephen king'] }], needsModel: true },
  { text: 'Sci-fi mind bending thriller', must: [{ g: ['Science Fiction'] }, { g: ['Thriller'] }, { theme: ['mind-bending'] }] },
  { text: 'Mind bending Sci-fi thriller', must: [{ g: ['Science Fiction'] }, { g: ['Thriller'] }, { theme: ['mind-bending'] }] },
  { text: 'Sci-fi mind bending thriller released after 2020', yearMin: 2021, yearSource: 'stated', must: [{ g: ['Science Fiction'] }, { g: ['Thriller'] }, { theme: ['mind-bending'] }] },
  { text: 'Sci-fi thriller post 2020', yearMin: 2021, yearSource: 'stated', must: [{ g: ['Science Fiction'] }, { g: ['Thriller'] }] },
  { text: 'Top rated thrillers', minImdb: 7.5, must: [{ g: ['Thriller'] }] },
  { text: 'Sci fi', must: [{ g: ['Science Fiction'] }] },
  { text: 'Action', must: [{ g: ['Action'] }] },
  { text: 'post 2020 high octane action', yearMin: 2021, yearSource: 'stated', must: [{ g: ['Action'] }] },
  { text: 'Fast paced action', must: [{ g: ['Action'] }] },
  { text: 'action thriller in english', language: 'en', must: [{ g: ['Action'] }, { g: ['Thriller'] }] },
  { text: 'Mind bending Sci fi action', must: [{ g: ['Science Fiction'] }, { g: ['Action'] }, { theme: ['mind-bending'] }] },
  { text: 'High octane action', must: [{ g: ['Action'] }] },
  { text: 'English action', language: 'en', must: [{ g: ['Action'] }] },
  { text: 'New action thriller', yearMin: 2025, yearSource: 'recent', must: [{ g: ['Action'] }, { g: ['Thriller'] }] },
  { text: 'Top rated action thriller', minImdb: 7.5, must: [{ g: ['Action'] }, { g: ['Thriller'] }] },
  { text: 'Sci-fi action thriller', must: [{ g: ['Science Fiction'] }, { g: ['Action'] }, { g: ['Thriller'] }] },
  { text: '2020 recent sci-Fi action thriller.', yearMin: 2020, yearSource: 'stated', must: [{ g: ['Science Fiction'] }, { g: ['Action'] }, { g: ['Thriller'] }] },
  { text: 'Recent sifi action thriller', yearMin: 2024, yearSource: 'recent', must: [{ g: ['Science Fiction'] }, { g: ['Action'] }, { g: ['Thriller'] }] },
  { text: 'scary sci-fi thriller', must: [{ g: ['Horror'] }, { g: ['Science Fiction'] }, { g: ['Thriller'] }] },
  { text: 'Sci-fi post apocalypse planet super powers', must: [{ g: ['Science Fiction'] }, { theme: ['apocalypse', 'space', 'superpowers'] }] },
  { text: 'Thriller action', must: [{ g: ['Thriller'] }, { g: ['Action'] }] },
  { text: 'Action thriller Sci fi', must: [{ g: ['Action'] }, { g: ['Thriller'] }, { g: ['Science Fiction'] }] },
  { text: 'Action thriller fast paced', must: [{ g: ['Action'] }, { g: ['Thriller'] }] },
  { text: 'Scary Sunday night movie. No devils or nuns.', media: 'movie', must: [{ g: ['Horror'] }], mustNot: [{ theme: ['devil'] }, { theme: ['nun'] }] },
  { text: 'Scary Sunday night movie. No devils or nuns', media: 'movie', must: [{ g: ['Horror'] }], mustNot: [{ theme: ['devil'] }, { theme: ['nun'] }] },
  { text: 'Scary movies. Good reviews.', media: 'movie', minImdb: 7.0, must: [{ g: ['Horror'] }] },
  { text: 'High rated new series. Hidden gems.', media: 'tv', minImdb: 7.0, yearMin: 2025, yearSource: 'recent', hiddenGem: true, must: [] },
  { text: 'Thriller', must: [{ g: ['Thriller'] }] },
  { text: 'sci-fi thriller', must: [{ g: ['Science Fiction'] }, { g: ['Thriller'] }] },
  { text: 'The invite, the drama type of movie s', media: 'movie', must: [], similarTo: ['The invite', 'the drama'] },
  { text: 'New thriller and horror movies', media: 'movie', yearMin: 2025, yearSource: 'recent', must: [{ g: ['Thriller', 'Horror'] }] },
  { text: 'Creepy thriller horror', must: [{ g: ['Horror'] }, { g: ['Thriller'] }] },
  { text: 'Sci fi thriller scary', must: [{ g: ['Science Fiction'] }, { g: ['Thriller'] }, { g: ['Horror'] }] },
  { text: 'Scary Sci fi thriller action', must: [{ g: ['Horror'] }, { g: ['Science Fiction'] }, { g: ['Thriller'] }, { g: ['Action'] }] },
  { text: 'Gripping Sci fi thriller', must: [{ g: ['Thriller'] }, { g: ['Science Fiction'] }] },
  { text: 'Sci fi thriller', must: [{ g: ['Science Fiction'] }, { g: ['Thriller'] }] },
  { text: 'Sci fi thriller action', must: [{ g: ['Science Fiction'] }, { g: ['Thriller'] }, { g: ['Action'] }] },
  { text: 'Thriller new 2025', yearMin: 2025, yearSource: 'stated', must: [{ g: ['Thriller'] }] },
];

function sameSet<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && b.every((x) => a.includes(x));
}

function matches(actual: RuleClause, want: Clause): boolean {
  if ('g' in want) return actual.terms.length === 0 && sameSet(actual.genres, want.g);
  const terms = want.theme.flatMap((t) => THEME_TERMS[t]);
  return actual.genres.length === 0 && terms.every((t) => actual.terms.includes(t));
}

/** The clauses match as a set: same count, and each expected clause has its own match. */
function expectClauses(actual: RuleClause[], want: Clause[]): void {
  const labels = JSON.stringify(actual.map((c) => c.label));
  expect(actual.length, `clauses ${labels}`).toBe(want.length);
  const left = [...actual];
  for (const w of want) {
    const i = left.findIndex((a) => matches(a, w));
    expect(i, `no clause for ${JSON.stringify(w)} among ${labels}`).toBeGreaterThanOrEqual(0);
    left.splice(i, 1);
  }
}

function chips(text: string): string[] {
  return describeRules(parseRequest(text, NOW));
}

describe('parseRequest on every request typed so far', () => {
  for (const want of REQUESTS.filter((r) => !r.needsModel)) {
    it(want.text, () => {
      const r = parseRequest(want.text, NOW);
      expect({
        mediaType: r.mediaType, yearMin: r.yearMin, yearMax: r.yearMax, yearSource: r.yearSource,
        minImdb: r.minImdb, language: r.language, hiddenGem: r.hiddenGem, similarTo: r.similarTo,
      }).toEqual({
        mediaType: want.media ?? null, yearMin: want.yearMin ?? 2015, yearMax: null,
        yearSource: want.yearSource ?? 'default', minImdb: want.minImdb ?? null,
        language: want.language ?? null, hiddenGem: want.hiddenGem ?? false, similarTo: want.similarTo ?? [],
      });
      expectClauses(r.must, want.must);
      expectClauses(r.mustNot, want.mustNot ?? []);
      expect(leftoverWords(want.text, NOW)).toEqual([]);
    });
  }

  it('leaves a subject it does not know for the model', () => {
    for (const want of REQUESTS.filter((r) => r.needsModel)) {
      expect(leftoverWords(want.text, NOW).length, want.text).toBeGreaterThan(0);
      expect(parseRequest(want.text, NOW).mediaType).toBe(want.media ?? null);
    }
    expect(leftoverWords('Stephen King series', NOW)).toEqual(['stephen', 'king']);
  });
});

describe('the app\'s example prompts', () => {
  it.each([
    ['something funny and easy to watch', ['Funny', 'Easy watch', '2015 or newer', 'No horror']],
    ['a gripping thriller for tonight', ['Thriller', '2015 or newer']],
    ['a feel-good film for a rainy day', ['Feel-good', 'Films', '2015 or newer', 'No horror']],
    ['something mind-bending and clever', ['Mind-bending', '2015 or newer']],
    ['a short movie under 90 minutes', ['Films', '2015 or newer', 'Under 90 min']],
    ['a cosy series to binge', ['Cosy', 'Series', '2015 or newer', 'No horror']],
    ['something romantic but not cheesy', ['Romantic', '2015 or newer']],
    ['a true-story drama', ['True story', 'Drama', '2015 or newer']],
    ['a hidden-gem sci-fi', ['Sci-fi', '2015 or newer', 'Hidden gems']],
    ['something dark and tense', ['Tense', '2015 or newer']],
  ])('%s', (text, want) => {
    expect(chips(text)).toEqual(want);
    expect(leftoverWords(text, NOW)).toEqual([]);
  });

  it('does not turn a quality the data cannot show into an exclusion', () => {
    expect(parseRequest('not too long and not boring', NOW).mustNot).toEqual([]);
    expect(parseRequest('kids movie no scary stuff', NOW).mustNot).toEqual([{ label: 'scary', genres: ['Horror'], terms: [] }]);
  });

  it('reads a tone word as a rule: never horror, and an easy genre when no genre is named', () => {
    const easy = parseRequest('a feel-good film for a rainy day', NOW);
    expect(easy.must[0].genres).toEqual(['Comedy', 'Family', 'Romance', 'Animation', 'Adventure']);
    expect(easy.mustNot).toEqual([{ label: 'horror', genres: ['Horror'], terms: [] }]);
    expect(easy.tone).toBe('Feel-good');
    const soft = parseRequest('thriller light like Inception', NOW);
    expect(soft.must.map((c) => c.genres)).toEqual([['Thriller']]);
    expect(soft.mustNot).toEqual([{ label: 'horror', genres: ['Horror'], terms: [] }]);
  });

  it('keeps a feel-good comedy free of horror and shows the tone as a chip', () => {
    const rules = parseRequest('feel-good comedy', NOW);
    expect(rules.must.map((c) => c.genres)).toEqual([['Comedy']]);
    expect(rules.mustNot).toEqual([{ label: 'horror', genres: ['Horror'], terms: [] }]);
    expect(chips('feel-good comedy')).toEqual(['Comedy', 'Feel-good', '2015 or newer', 'No horror']);
    expect(chips('something funny and light, nothing scary')).toEqual(['Funny', 'Light', '2015 or newer', 'No scary']);
  });

  it('leaves the tone as a hint when the request asks for horror itself', () => {
    const rules = parseRequest('a cosy horror film', NOW);
    expect(rules.must.map((c) => c.genres)).toEqual([['Horror']]);
    expect(rules.mustNot).toEqual([]);
    expect(rules.tone).toBeNull();
  });

  it('keeps a stated runtime over the short-film default', () => {
    expect(parseRequest('a short movie under 90 minutes', NOW).maxRuntime).toBe(90);
    expect(parseRequest('a short film', NOW).maxRuntime).toBe(100);
    expect(parseRequest('movies under 2 hours', NOW).maxRuntime).toBe(120);
    expect(parseRequest('films over 2.5 hours', NOW).minRuntime).toBe(150);
  });
});

describe('year windows', () => {
  it.each([
    ['90s action', 1990, 1999, 'stated'],
    ["the '80s", 1980, 1989, 'stated'],
    ['the eighties', 1980, 1989, 'stated'],
    ['1970s horror', 1970, 1979, 'stated'],
    ['thrillers from 2019', 2019, 2019, 'stated'],
    ['new thrillers from 2025', 2025, null, 'stated'],
    ['from 2019 onwards', 2019, null, 'stated'],
    ['a 2019 thriller', 2019, 2019, 'stated'],
    ['between 2010 and 2015', 2010, 2015, 'stated'],
    ['2010-2015 comedies', 2010, 2015, 'stated'],
    ['before 2000', null, 1999, 'stated'],
    ['pre 2000 action', null, 1999, 'stated'],
    ['released after 2020', 2021, null, 'stated'],
    ['since 2020', 2020, null, 'stated'],
    ['2018 onwards', 2018, null, 'stated'],
    ['classic westerns', null, null, 'any'],
    ['best horror of all time', null, null, 'any'],
    ['old movies', null, null, 'any'],
    ['scary sci-fi thriller, any year', null, null, 'any'],
    ['thrillers from any era', null, null, 'any'],
    ['this year', 2026, 2026, 'stated'],
    ['last year', 2025, 2025, 'stated'],
    ['the latest comedies', 2025, null, 'recent'],
    ['something recent', 2024, null, 'recent'],
    ['a comedy', 2015, null, 'default'],
  ])('%s', (text, yearMin, yearMax, yearSource) => {
    const r = parseRequest(text, NOW);
    expect([r.yearMin, r.yearMax, r.yearSource]).toEqual([yearMin, yearMax, yearSource]);
    expect(leftoverWords(text, NOW)).toEqual([]);
  });

  it('reads the "best" of "best horror of all time" as a rating floor too', () => {
    expect(parseRequest('best horror of all time', NOW).minImdb).toBe(7.5);
  });

  it('takes a year with a recency word as that year or newer', () => {
    const r = parseRequest('Thriller new 2025', NOW);
    expect([r.yearMin, r.yearMax, r.yearSource]).toEqual([2025, null, 'stated']);
  });

  it('does not read a runtime as a year or a decade', () => {
    const r = parseRequest('under 90 minutes', NOW);
    expect([r.yearMin, r.yearSource, r.maxRuntime]).toEqual([2015, 'default', 90]);
  });
});

describe('spelling and punctuation', () => {
  it.each(['sci fi', 'sci-fi', 'scifi', 'sifi', 'SCI-FI!!', 'Sci Fi movies.', 'science-fiction'])(
    '%s is science fiction', (text) => {
      expect(parseRequest(text, NOW).must.map((c) => c.genres)).toEqual([['Science Fiction']]);
      expect(leftoverWords(text, NOW)).toEqual([]);
    },
  );

  it('ignores trailing junk such as a stray "s"', () => {
    expect(parseRequest('horror movie s', NOW).mediaType).toBe('movie');
    expect(leftoverWords('horror movie s', NOW)).toEqual([]);
  });

  it('gives clauses short human labels', () => {
    expect(parseRequest('scary thriller', NOW).must.map((c) => c.label)).toEqual(['Scary', 'Thriller']);
    expect(parseRequest('mind-bending medical drama', NOW).must.map((c) => c.label)).toEqual(['Mind-bending, Medical', 'Drama']);
  });

  it('labels a genre named twice by its noun', () => {
    const r = parseRequest('Creepy thriller horror', NOW);
    expect(r.must.map((c) => c.label)).toEqual(['Horror', 'Thriller']);
  });

  it('joins two genre nouns with and/or/&// into one clause, but not mood words', () => {
    for (const text of ['thriller and horror', 'thriller or horror', 'thriller & horror', 'thriller/horror']) {
      expect(parseRequest(text, NOW).must.map((c) => c.genres), text).toEqual([['Thriller', 'Horror']]);
    }
    expect(parseRequest('scary and funny', NOW).must.map((c) => c.genres)).toEqual([['Horror'], ['Comedy']]);
    expect(parseRequest('rom-com', NOW).must.map((c) => c.genres)).toEqual([['Romance'], ['Comedy']]);
  });
});

describe('exclusions', () => {
  it('reads "no X or Y" as one clause each, with known relatives', () => {
    const r = parseRequest('Scary Sunday night movie. No devils or nuns.', NOW);
    expect(r.mustNot.map((c) => c.label)).toEqual(['devils', 'nuns']);
    expect(r.mustNot[0].terms).toEqual(expect.arrayContaining(['demon', 'demonic', 'satan', 'possession', 'exorcism']));
    expect(r.mustNot[1].terms).toContain('convent');
  });

  it('turns a negated genre word into a genre clause', () => {
    expect(parseRequest('a comedy, no horror', NOW).mustNot).toEqual([{ label: 'horror', genres: ['Horror'], terms: [] }]);
    expect(parseRequest('nothing too scary', NOW).mustNot).toEqual([{ label: 'scary', genres: ['Horror'], terms: [] }]);
  });

  it('turns any other negated noun into a term clause, singular and plural', () => {
    expect(parseRequest('horror without clowns', NOW).mustNot).toEqual([{ label: 'clowns', genres: [], terms: ['clown', 'clowns'] }]);
    expect(parseRequest('horror, no gore', NOW).mustNot[0].terms).toEqual(['gore', 'gory', 'splatter', 'torture']);
  });

  it('reads "not a series" as films', () => {
    expect(parseRequest('a thriller, not a series', NOW).mediaType).toBe('movie');
  });

  it('does not exclude anything for a bare "not too long"', () => {
    expect(parseRequest('a thriller, not too long', NOW).mustNot).toEqual([]);
    expect(leftoverWords('a thriller, not too long', NOW)).toEqual([]);
  });
});

describe('references', () => {
  it('keeps the phrase as typed and does not read genre words inside it', () => {
    const r = parseRequest('The invite, the drama type of movie s', NOW);
    expect(r.similarTo).toEqual(['The invite', 'the drama']);
    expect(r.must).toEqual([]);
    expect(r.mediaType).toBe('movie');
  });

  it.each([
    ['something like The Matrix and Inception', ['The Matrix', 'Inception']],
    ['similar to Severance', ['Severance']],
    ['in the vein of Zodiac, but newer', ['Zodiac']],
  ])('%s', (text, want) => {
    expect(parseRequest(text, NOW).similarTo).toEqual(want);
  });

  it('does not take "like" in a wish, or a phrase of rule words, as a title', () => {
    expect(parseRequest("I'd like a thriller", NOW).similarTo).toEqual([]);
    expect(parseRequest('something like a scary movie', NOW).similarTo).toEqual([]);
    expect(parseRequest('a thriller kind of show', NOW)).toMatchObject({ similarTo: [], mediaType: 'tv' });
  });
});

describe('other rule words', () => {
  it.each([
    ['Korean thriller', { language: 'ko' }],
    ['British comedy', { language: 'en' }],
    ['highly rated drama', { minImdb: 7.0 }],
    ['top rated drama', { minImdb: 7.5 }],
    ['underrated thrillers', { hiddenGem: true }],
    ['a flick', { mediaType: 'movie' }],
    ['a miniseries', { mediaType: 'tv' }],
    ['show me something funny', { mediaType: null }],
    ['movies or series', { mediaType: null }],
  ])('%s', (text, want) => {
    expect(parseRequest(text, NOW)).toMatchObject(want);
  });

  it('leaves only unknown content words over', () => {
    expect(leftoverWords('Thriller new 2025', NOW)).toEqual([]);
    expect(leftoverWords('a film about chess', NOW)).toEqual(['chess']);
    expect(leftoverWords('', NOW)).toEqual([]);
  });
});

describe('words that only look like a rule', () => {
  it('keeps a number that opens a referenced title out of the year window', () => {
    const odyssey = parseRequest('movies like 2001 a space odyssey', NOW);
    expect([odyssey.yearMin, odyssey.yearSource]).toEqual([2015, 'default']);
    expect(odyssey.similarTo).toEqual(['2001 a space odyssey']);
    expect(odyssey.must).toEqual([]);
    const war = parseRequest('1917 type of movie', NOW);
    expect([war.yearMin, war.yearSource, war.similarTo]).toEqual([2015, 'default', ['1917']]);
  });

  it('reads "time" as a subject only when it is listed as one', () => {
    expect(chips('a good time, something funny')).toEqual(['Funny', '2015 or newer']);
    expect(chips('no time to waste, a thriller')).toEqual(['Thriller', '2015 or newer']);
    expect(chips('sci-fi about time')).toEqual(['Sci-fi', 'Time', '2015 or newer']);
  });

  it('reads "best friends" as a subject, not as a rating word', () => {
    const r = parseRequest('best friends comedy', NOW);
    expect(r.minImdb).toBeNull();
    expect(chips('best friends comedy')).toEqual(['Friendship', 'Comedy', '2015 or newer']);
    expect(leftoverWords('best friends comedy', NOW)).toEqual([]);
  });

  it('knows true crime and Christmas without a model call', () => {
    expect(chips('true crime documentary series')).toEqual(['True crime', 'Documentary', 'Series', '2015 or newer']);
    expect(chips('christmas movies')).toEqual(['Christmas', 'Films', '2015 or newer']);
    expect(leftoverWords('true crime documentary series', NOW)).toEqual([]);
    expect(leftoverWords('christmas movies', NOW)).toEqual([]);
  });
});

describe('more than one exclusion, and exclusions that have no rule', () => {
  const excluded = (text: string) => parseRequest(text, NOW).mustNot.map((c) => c.label);
  const required = (text: string) => parseRequest(text, NOW).must.map((c) => c.label);

  it('reads each "no …" joined by "and" as its own exclusion', () => {
    expect([required('no horror and no comedy'), excluded('no horror and no comedy')]).toEqual([[], ['horror', 'comedy']]);
    expect([required('not romance and not horror'), excluded('not romance and not horror')]).toEqual([[], ['romance', 'horror']]);
    expect([required('no kids and no animation'), excluded('no kids and no animation')]).toEqual([[], ['kids', 'animation']]);
    expect([required('thriller, no gore and no nuns'), excluded('thriller, no gore and no nuns')]).toEqual([['Thriller'], ['gore', 'nuns']]);
    expect([required('without romance and without gore'), excluded('without romance and without gore')]).toEqual([[], ['romance', 'gore']]);
  });

  it('never makes a negator itself an excluded word', () => {
    for (const text of ['no horror and no comedy', 'not romance and not horror', 'no gore or no nuns']) {
      expect(parseRequest(text, NOW).mustNot.flatMap((c) => c.terms)).not.toContain('no');
      expect(parseRequest(text, NOW).mustNot.flatMap((c) => c.terms)).not.toContain('not');
    }
  });

  it('never reads a negated language as a request for that language', () => {
    for (const text of ['not in english', 'comedy but not in english', 'not in french', 'nothing in english', 'not english']) {
      expect(parseRequest(text, NOW).language, text).toBeNull();
    }
    expect(required('comedy but not in english')).toEqual(['Comedy']);
    expect(parseRequest('comedy in english', NOW).language).toBe('en');
  });
});


describe('soft (mood) clauses', () => {
  const must = (text: string) => parseRequest(text, NOW).must.map((c) => [c.label, c.soft === true]);

  it('marks mood words and feels soft, and genre nouns and subjects hard', () => {
    expect(must('scary')).toEqual([['Scary', true]]);
    expect(must('horror')).toEqual([['Horror', false]]);
    expect(must('mind bending')).toEqual([['Mind-bending', true]]);
    expect(must('time travel')).toEqual([['Time travel', false]]);
    expect(must('sci-fi mind bending scary')).toEqual([['Sci-fi', false], ['Mind-bending', true], ['Scary', true]]);
    expect(must('a gripping, funny rom-com')).toEqual([['Gripping', true], ['Funny', true], ['Romance', true]]);
    expect(must('psychological drama')).toEqual([['Psychological', true], ['Drama', false]]);
  });

  it('never makes an exclusion soft', () => {
    const r = parseRequest('scary movie, no nuns and not scary clowns', NOW);
    expect(r.mustNot.length).toBeGreaterThan(0);
    expect(r.mustNot.every((c) => c.soft === undefined)).toBe(true);
    expect(parseRequest('no nuns', NOW).mustNot).toEqual([{ label: 'nuns', genres: [], terms: ['nun', 'evil nun', 'convent'] }]);
  });

  it('keeps a clause hard when a noun or a subject shares it', () => {
    // "scary horror": one Horror clause, named by the noun.
    expect(must('scary horror')).toEqual([['Horror', false]]);
    expect(must('horror, scary')).toEqual([['Horror', false]]);
    // Themes form one any-of clause; with a subject in it, it must hold.
    expect(must('mind bending space')).toEqual([['Mind-bending, Space', false]]);
    // A family-friendly request is a requirement, not a mood.
    expect(must('kid friendly')).toEqual([['Family', false]]);
  });
});
