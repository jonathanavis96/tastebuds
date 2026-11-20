import {
  defaultRules, GOOD_RATING_FLOOR, NEW_YEARS, RECENT_YEARS, TOP_RATING_FLOOR,
} from './rules.js';
import type { CanonGenre, RequestRules, RuleClause } from './rules.js';
import { EASY_GENRES, FILLER, LEXICON, MAX_PHRASE_WORDS, THEMES, VOCAB } from './vocabulary.js';
import type { Entry } from './vocabulary.js';

/** "A short film" with no stated length means at most this many minutes. */
const SHORT_FILM_MAX_MINUTES = 100;

interface Token {
  /** Lowercase, as typed. */
  w: string;
  /** Singular vocabulary form ("thrillers" → "thriller"), or `w` when the word is unknown. */
  norm: string;
  /** Original case, for reference titles. */
  raw: string;
  punct: boolean;
  /** Already turned into a rule. */
  used: boolean;
}

interface GenreHit {
  genres: CanonGenre[];
  label: string;
  noun: boolean;
  pos: number;
  end: number;
}

type Window = [number | null, number | null];

/** Everything read from the request so far, before it is assembled into rules. */
interface Reading {
  cy: number;
  /** The lowercased request; every span a pattern has read is blanked to spaces. */
  work: string;
  windows: Window[];
  bareYears: number[];
  recency: 'new' | 'recent' | null;
  anyYear: boolean;
  maxRuntime: number | null;
  shortFilm: boolean;
  minRuntime: number | null;
  media: Set<'movie' | 'tv'>;
  notMedia: Set<'movie' | 'tv'>;
  language: string | null;
  floor: number | null;
  hiddenGem: boolean;
  easyPos: number | null;
  /** The chip of the first tone word ("Feel-good", "Cosy"). */
  easyLabel: string | null;
  genreHits: GenreHit[];
  themes: { key: string; pos: number }[];
  mustNot: RuleClause[];
  similarTo: string[];
}

/**
 * Read a free-text request into rules without any model call: film or series,
 * years and recency words, genres, moods, rating words, runtime, language,
 * exclusions ("no nuns") and "like <title>" references. Pure and deterministic;
 * `now` fixes the current year for the recency windows.
 */
export function parseRequest(text: string, now: Date = new Date()): RequestRules {
  return analyse(text, now).rules;
}

/**
 * The content words of `text` that parseRequest did not turn into a rule and
 * that are not filler ("something", "movie", "tonight"). Empty means the request
 * was fully understood, so no model call is needed to read it.
 */
export function leftoverWords(text: string, now: Date = new Date()): string[] {
  return analyse(text, now).leftover;
}

function analyse(text: string, now: Date): { rules: RequestRules; leftover: string[] } {
  const r = newReading(text, now.getFullYear());
  readRuntime(r);
  readYears(r);
  const toks = tokenize(r.work, text);
  readReferences(toks, r);
  readNegations(toks, r);
  readWords(toks, r);
  return { rules: assemble(r, toks, now), leftover: unread(toks) };
}

function newReading(text: string, cy: number): Reading {
  return {
    cy, work: normalise(text), windows: [], bareYears: [], recency: null, anyYear: false,
    maxRuntime: null, shortFilm: false, minRuntime: null, media: new Set(), notMedia: new Set(),
    language: null, floor: null, hiddenGem: false, easyPos: null, easyLabel: null, genreHits: [], themes: [],
    mustNot: [], similarTo: [],
  };
}

/**
 * Lowercase, curly quotes to "'", a dash between digits to "~" (a year range)
 * and every other dash to a space ("sci-fi" → "sci fi"). Keeps the length, so a
 * position in the result is the same position in the original text.
 */
function normalise(text: string): string {
  const chars = text.split('').map((c) => {
    const lower = c.toLowerCase();
    return lower.length === 1 ? lower : c;
  });
  const out = chars.map((c, i) => {
    if ('’‘`´'.includes(c)) return "'";
    if (!'-–—_'.includes(c)) return c;
    return digitAround(chars, i, -1) && digitAround(chars, i, 1) ? '~' : ' ';
  });
  return out.join('');
}

function digitAround(chars: string[], i: number, step: number): boolean {
  let j = i + step;
  while (chars[j] === ' ') j += step;
  return /\d/.test(chars[j] ?? '');
}

/** Run `re` over the unread text; each match `read` accepts is blanked so nothing reads it again. */
function consume(r: Reading, re: RegExp, read: (m: RegExpMatchArray) => boolean): void {
  for (const m of [...r.work.matchAll(re)]) {
    if (!read(m)) continue;
    const start = m.index!;
    r.work = r.work.slice(0, start) + ' '.repeat(m[0].length) + r.work.slice(start + m[0].length);
  }
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, few: 3, 'couple of': 2,
};

function toNumber(s: string): number {
  return NUMBER_WORDS[s] ?? Number(s);
}

const N = '(\\d+(?:\\.\\d+)?|an?|one|two|three)';
const UNIT = '(hours?|hrs?|h|minutes?|mins?|m)';

function minutes(m: RegExpMatchArray): number {
  const n = toNumber(m[1]);
  return Math.round(m[2].startsWith('h') ? n * 60 : n);
}

function readRuntime(r: Reading): void {
  const setMax = (m: RegExpMatchArray) => { r.maxRuntime = minutes(m); return true; };
  consume(r, new RegExp(`\\b(?:under|less than|shorter than|below|at most|max(?:imum)?|no (?:more|longer) than|up to|within)\\s+${N}\\s*${UNIT}\\b`, 'g'), setMax);
  consume(r, new RegExp(`\\b${N}\\s*${UNIT}\\s+(?:or less|or under|or shorter|max|tops)\\b`, 'g'), setMax);
  consume(r, new RegExp(`\\b(?:over|more than|longer than|at least|above)\\s+${N}\\s*${UNIT}\\b`, 'g'), (m) => {
    r.minRuntime = minutes(m);
    return true;
  });
  // Only "short" is consumed: the film word after it still decides film vs series.
  consume(r, /\bshort\s+(?=(?:film|movie|flick)s?\b)/g, () => { r.shortFilm = true; return true; });
}

const Y = '(19\\d\\d|20\\d\\d)';
const DECADE_WORDS: Record<string, number> = {
  fifties: 1950, sixties: 1960, seventies: 1970, eighties: 1980, nineties: 1990,
};

function readYears(r: Reading): void {
  const ok = (...ys: number[]) => ys.every((y) => y >= 1900 && y <= r.cy + 1);
  const win = (re: RegExp, make: (y: number, y2: number) => Window) =>
    consume(r, re, (m) => {
      const [y, y2] = [Number(m[1]), Number(m[2] ?? m[1])];
      if (!ok(y, y2)) return false;
      r.windows.push(make(y, y2));
      return true;
    });

  win(new RegExp(`\\b(?:between\\s+|from\\s+)?${Y}\\s*(?:~|to|and|through|thru|till|until)\\s*${Y}\\b`, 'g'),
    (a, b) => [Math.min(a, b), Math.max(a, b)]);
  win(new RegExp(`\\b(?:after|post|later than|newer than)\\s+${Y}\\b`, 'g'), (y) => [y + 1, null]);
  win(new RegExp(`\\bsince\\s+${Y}\\b`, 'g'), (y) => [y, null]);
  win(new RegExp(`\\b${Y}\\s*(?:\\+|onwards?\\b|or (?:later|newer|after)\\b|and (?:later|newer|up)\\b)`, 'g'), (y) => [y, null]);
  win(new RegExp(`\\b(?:before|pre|prior to|older than|earlier than)\\s+${Y}\\b`, 'g'), (y) => [null, y - 1]);
  win(new RegExp(`\\b(?:until|till|up to|through|thru)\\s+${Y}\\b`, 'g'), (y) => [null, y]);
  win(new RegExp(`\\b${Y}\\s+or (?:earlier|older|before)\\b`, 'g'), (y) => [null, y]);

  consume(r, /(?:\bthe\s+)?'?\b((?:19|20)?\d0)'?s\b/g, (m) => {
    const v = Number(m[1]);
    const start = m[1].length === 4 ? v : v >= 30 ? 1900 + v : 2000 + v;
    if (!ok(start)) return false;
    r.windows.push([start, start + 9]);
    return true;
  });
  consume(r, /(?:\bthe\s+)?\b(fifties|sixties|seventies|eighties|nineties)\b/g, (m) => {
    r.windows.push([DECADE_WORDS[m[1]], DECADE_WORDS[m[1]] + 9]);
    return true;
  });
  consume(r, /\bthis year\b/g, () => { r.windows.push([r.cy, r.cy]); return true; });
  consume(r, /\blast year\b/g, () => { r.windows.push([r.cy - 1, r.cy - 1]); return true; });
  consume(r, /\b(?:last|past)\s+(\d+|two|three|four|five|ten|few|couple of)\s+years?\b/g, (m) => {
    r.windows.push([r.cy - toNumber(m[1]) + 1, null]);
    return true;
  });
  consume(r, new RegExp(`\\b${Y}\\b`, 'g'), (m) => {
    if (!ok(Number(m[1])) || startsReferencedTitle(r.work, m.index!, m[0].length)) return false;
    r.bareYears.push(Number(m[1]));
    return true;
  });
}

/** "like 2001: A Space Odyssey", "1917 type of film": the number opens a title, it is not a year. */
function startsReferencedTitle(work: string, start: number, length: number): boolean {
  return /\b(?:like|similar to|reminiscent of|vein of)\s+$/.test(work.slice(0, start))
    || /^\s+(?:type|kind|sort|style)\s+of\b/.test(work.slice(start + length));
}

function tokenize(work: string, text: string): Token[] {
  return [...work.matchAll(/[a-z0-9]+(?:'[a-z0-9]+)*|[,.;:!?&/~+]/g)].map((m) => {
    const w = m[0];
    const punct = !/[a-z0-9]/.test(w);
    return { w, norm: punct ? w : normWord(w), raw: text.slice(m.index!, m.index! + w.length), punct, used: false };
  });
}

function normWord(w: string): string {
  const base = w.replace(/'s$/, '');
  const bare = base.replace(/'/g, '');
  return [base, bare, ...singulars(bare)].find((c) => VOCAB.has(c)) ?? bare;
}

function singulars(w: string): string[] {
  const out: string[] = [];
  if (w.endsWith('ies')) out.push(`${w.slice(0, -3)}y`);
  if (/(?:s|x|z|ch|sh)es$/.test(w)) out.push(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) out.push(w.slice(0, -1));
  return out;
}

function singular(w: string): string {
  return singulars(w).find((s) => s.length > 1) ?? w;
}

function matchAt(toks: Token[], i: number): { entry: Entry; len: number } | null {
  for (let len = Math.min(MAX_PHRASE_WORDS, toks.length - i); len >= 1; len--) {
    const span = toks.slice(i, i + len);
    if (span.some((t) => t.punct || t.used)) continue;
    const entry = LEXICON.get(span.map((t) => t.norm).join(' '));
    if (entry) return { entry, len };
  }
  return null;
}

function markUsed(toks: Token[], from: number, to: number): void {
  for (let k = from; k < to; k++) toks[k].used = true;
}

function phrase(toks: Token[]): string {
  return toks.filter((t) => !t.punct).map((t) => t.raw).join(' ');
}

const SENTENCE_END = new Set(['.', ';', ':', '!', '?']);
const PART_BREAK = new Set([',', '&', '/', 'and', 'or']);
/** "I'd like a thriller" is a wish, not a reference to a title called "a thriller". */
const LIKE_AS_VERB = new Set(['i', 'we', 'you', 'they', 'would', "i'd", "we'd", "you'd", 'd', 'feel', 'feels', 'dont', "don't", 'really', 'also']);
const REFERENCE_KINDS = new Set(['type', 'kind', 'sort', 'style']);

/**
 * "like X", "similar to X", "in the vein of X", "X type of movie". The phrase is
 * kept as typed and its words are not read as genres; a part made only of known
 * rule words ("a thriller kind of show") is not a title and is read normally.
 */
function readReferences(toks: Token[], r: Reading): void {
  for (let i = 0; i < toks.length; i++) {
    const after = referenceStart(toks, i);
    if (after !== null) {
      let end = after;
      while (end < toks.length && !SENTENCE_END.has(toks[end].w) && toks[end].w !== 'but') end++;
      if (takeReferences(toks, after, end, r)) markUsed(toks, i, after);
      continue;
    }
    const ofMedia = toks[i + 1]?.w === 'of' && isMediaWord(toks, toks[i + 2]?.norm === 'a' ? i + 3 : i + 2);
    if (REFERENCE_KINDS.has(toks[i].norm) && ofMedia) {
      let start = i;
      while (start > 0 && !SENTENCE_END.has(toks[start - 1].w)) start--;
      if (takeReferences(toks, start, i, r)) markUsed(toks, i, i + 2);
    }
  }
}

/** Index of the first word of the reference after a trigger at `i`, or null. */
function referenceStart(toks: Token[], i: number): number | null {
  const w = (k: number) => toks[k]?.w;
  if (toks[i].used) return null;
  if (w(i) === 'like' && !LIKE_AS_VERB.has(w(i - 1) ?? '')) return i + 1;
  if (w(i) === 'similar' && w(i + 1) === 'to') return i + 2;
  if (w(i) === 'reminiscent' && w(i + 1) === 'of') return i + 2;
  if (w(i) === 'in' && w(i + 1) === 'the' && w(i + 2) === 'vein' && w(i + 3) === 'of') return i + 4;
  return null;
}

function isMediaWord(toks: Token[], k: number): boolean {
  return k < toks.length && LEXICON.get(toks[k].norm)?.kind === 'media';
}

/** Split toks[from, to) at commas and "and"/"or"; keep each part that names a title. */
function takeReferences(toks: Token[], from: number, to: number, r: Reading): boolean {
  let found = false;
  let start = from;
  for (let k = from; k <= to; k++) {
    if (k < to && !PART_BREAK.has(toks[k].w)) continue;
    const part = toks.slice(start, k);
    if (namesTitle(part)) {
      r.similarTo.push(phrase(part));
      markUsed(toks, start, k);
      found = true;
    }
    start = k + 1;
  }
  return found;
}

function namesTitle(part: Token[]): boolean {
  if (part.some((t) => t.used)) return false;
  const content = part.filter((t) => !t.punct && !FILLER.has(t.norm));
  if (content.length === 0) return false;
  return part[0].w === 'the' || content.some((t) => !VOCAB.has(t.norm));
}

const NEGATORS = new Set(['no', 'not', 'without', 'nothing', 'avoid', 'never', 'dont']);
const NEGATION_SKIP = new Set([
  'too', 'any', 'more', 'a', 'an', 'the', 'so', 'very', 'overly', 'much', 'want', 'like', 'need',
  'include', 'with', 'anything', 'something', 'of', 'that', 'in',
]);

/** "no X", "not X", "without X", "but not X", "no X or Y" → mustNot clauses. */
function readNegations(toks: Token[], r: Reading): void {
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].used || !NEGATORS.has(toks[i].norm)) continue;
    let j = i + 1;
    while (j < toks.length && !toks[j].used && NEGATION_SKIP.has(toks[j].norm)) j++;
    let negated = false;
    for (let len = negateItem(toks, j, r); len > 0; len = negateItem(toks, j, r)) {
      negated = true;
      j += len;
      const next = toks[j]?.norm;
      const joins = next === 'or' || next === 'nor' || (next === 'and' && matchAt(toks, j + 1)?.entry.kind !== 'genre');
      // "no horror and no comedy": the second "no" starts its own exclusion.
      if (!joins || NEGATORS.has(toks[j + 1]?.norm ?? '')) break;
      j++;
    }
    if (negated) toks[i].used = true;
  }
}

/** Read one excluded thing at `j`; returns how many tokens it took (0 when there is none). */
function negateItem(toks: Token[], j: number, r: Reading): number {
  const t = toks[j];
  if (!t || t.punct || t.used || NEGATORS.has(t.norm)) return 0;
  const m = matchAt(toks, j);
  if (m) {
    const label = phrase(toks.slice(j, j + m.len)).toLowerCase();
    const e = m.entry;
    if (e.kind === 'theme' && isIdiom(e.theme, toks, j, m.len)) return 0;
    // A negated language, rating word or the like has no rule to become; it is
    // taken out of the reading so that "not in English" never asks for English.
    if (e.kind === 'genre') for (const g of e.genres) r.mustNot.push({ label, genres: [g], terms: [] });
    if (e.kind === 'theme') r.mustNot.push({ label, genres: [], terms: [...THEMES[e.theme].terms] });
    if (e.kind === 'media') r.notMedia.add(e.media);
    markUsed(toks, j, j + m.len);
    return m.len;
  }
  if (!isContentWord(t)) return 0;
  let end = j + 1;
  while (end < toks.length && isContentWord(toks[end]) && !toks[end].used && !VOCAB.has(toks[end].norm)) end++;
  const words = toks.slice(j, end).map((x) => x.w.replace(/'/g, ''));
  const typed = words.join(' ');
  const single = [...words.slice(0, -1), singular(words[words.length - 1])].join(' ');
  r.mustNot.push({ label: typed, genres: [], terms: [...new Set([single, typed])] });
  markUsed(toks, j, end);
  return end - j;
}

function isContentWord(t: Token): boolean {
  return !t.punct && !FILLER.has(t.norm) && !/^\d+$/.test(t.w) && t.w.length > 1;
}

const JOINERS = new Set(['and', 'or', '&', '/']);

function readWords(toks: Token[], r: Reading): void {
  for (let i = 0; i < toks.length; i++) {
    const m = matchAt(toks, i);
    if (!m) continue;
    markUsed(toks, i, i + m.len);
    applyEntry(m.entry, toks, i, m.len, r);
    i += m.len - 1;
  }
}

function applyEntry(e: Entry, toks: Token[], i: number, len: number, r: Reading): void {
  switch (e.kind) {
    case 'genre':
      r.genreHits.push({ genres: e.genres, label: e.label, noun: e.noun, pos: i, end: i + len });
      return;
    case 'theme':
      if (isIdiom(e.theme, toks, i, len)) return;
      if (!r.themes.some((t) => t.key === e.theme)) r.themes.push({ key: e.theme, pos: i });
      return;
    case 'easy':
      if (r.easyPos === null) Object.assign(r, { easyPos: i, easyLabel: e.label });
      return;
    case 'media':
      // "show me something" asks for something; it does not say series.
      if (!(toks[i].norm === 'show' && ['me', 'us'].includes(toks[i + 1]?.w))) r.media.add(e.media);
      return;
    case 'language':
      r.language ??= e.code;
      return;
    case 'rating':
      r.floor = Math.max(r.floor ?? 0, e.floor === 'top' ? TOP_RATING_FLOOR : GOOD_RATING_FLOOR);
      return;
    case 'hiddenGem':
      r.hiddenGem = true;
      return;
    case 'recency':
      if (r.recency !== 'new') r.recency = e.recency;
      return;
    case 'anyYear':
      r.anyYear = true;
  }
}

const TIME_IDIOM_BEFORE = new Set([
  'good', 'great', 'nice', 'long', 'short', 'first', 'this', 'that', 'any', 'some', 'much', 'more', 'same',
  'next', 'last', 'every', 'no', 'have', 'has', 'had', 'the', 'of', 'in', 'on', 'at', 'one', 'spare', 'free',
]);

/** "a good time", "the first time", "time to relax": the word "time" is not the subject Time. */
function isIdiom(theme: string, toks: Token[], i: number, len: number): boolean {
  if (theme !== 'time' || len !== 1) return false;
  return TIME_IDIOM_BEFORE.has(toks[i - 1]?.w ?? '') || ['to', 'for'].includes(toks[i + 1]?.w ?? '');
}

interface Placed {
  pos: number;
  noun: boolean;
  clause: RuleClause;
}

/**
 * Genre hits → clauses. Two genre nouns joined by "and"/"or"/"&"/"/" form one
 * either-of clause; words simply listed each make their own clause. The same
 * genres named twice are one clause, labelled by the noun when there is one.
 */
function genreClauses(hits: GenreHit[], toks: Token[]): Placed[] {
  const groups: GenreHit[][] = [];
  for (const h of hits) {
    const group = groups[groups.length - 1];
    const prev = group?.[group.length - 1];
    const joined = prev && prev.noun && h.noun && h.pos === prev.end + 1 && JOINERS.has(toks[prev.end].w);
    if (joined) group.push(h);
    else groups.push([h]);
  }
  const placed: Placed[] = [];
  const add = (p: Placed) => {
    const key = [...p.clause.genres].sort().join('|');
    const same = placed.find((q) => [...q.clause.genres].sort().join('|') === key);
    if (!same) placed.push(p);
    else if (p.noun && !same.noun) Object.assign(same, { noun: true, clause: { ...same.clause, label: p.clause.label } });
  };
  for (const g of groups) {
    const [first] = g;
    if (g.length === 1) {
      for (const genre of first.genres) {
        const label = first.genres.length > 1 ? genre : first.label;
        add({ pos: first.pos, noun: first.noun, clause: { label, genres: [genre], terms: [] } });
      }
      continue;
    }
    const genres = [...new Set(g.flatMap((h) => h.genres))];
    add({ pos: first.pos, noun: true, clause: { label: g.map((h) => h.label).join(' or '), genres, terms: [] } });
  }
  return placed;
}

function themeClause(themes: Reading['themes']): Placed | null {
  if (themes.length === 0) return null;
  const label = themes.map((t) => THEMES[t.key].label).join(', ');
  const terms = [...new Set(themes.flatMap((t) => THEMES[t.key].terms))];
  return { pos: themes[0].pos, noun: true, clause: { label, genres: [], terms } };
}

function assemble(r: Reading, toks: Token[], now: Date): RequestRules {
  const rules = defaultRules(now);
  const placed = genreClauses(r.genreHits, toks);
  const mustNot = [...r.mustNot];
  // A tone word ("feel-good", "light", "cosy") is a rule: never Horror, and with
  // no genre named, one of the easy genres. "Cosy horror" asks for horror, so
  // there the word only steers the ordering.
  const tone = r.easyPos !== null && r.easyLabel !== null && !placed.some((p) => p.clause.genres.includes('Horror'))
    ? r.easyLabel
    : null;
  if (tone !== null && r.easyPos !== null) {
    if (placed.length === 0) placed.push({ pos: r.easyPos, noun: false, clause: { label: tone, genres: [...EASY_GENRES], terms: [] } });
    if (!mustNot.some((c) => c.genres.includes('Horror'))) mustNot.push({ label: 'horror', genres: ['Horror'], terms: [] });
  }
  const theme = themeClause(r.themes);
  if (theme) placed.push(theme);
  rules.must = placed.sort((a, b) => a.pos - b.pos).map((p) => p.clause);
  rules.mustNot = mustNot;
  rules.mediaType = mediaType(r);
  Object.assign(rules, yearWindow(r));
  rules.minImdb = r.floor;
  rules.maxRuntime = r.maxRuntime ?? (r.shortFilm ? SHORT_FILM_MAX_MINUTES : null);
  rules.minRuntime = r.minRuntime;
  rules.language = r.language;
  rules.hiddenGem = r.hiddenGem;
  rules.similarTo = r.similarTo;
  rules.tone = tone;
  return rules;
}

function mediaType(r: Reading): RequestRules['mediaType'] {
  if (r.media.size === 1) return [...r.media][0];
  if (r.media.size === 0 && r.notMedia.size === 1) return r.notMedia.has('tv') ? 'movie' : 'tv';
  return null;
}

/** Stated windows win, then a bare year, then a recency word, then "classic", then the default. */
function yearWindow(r: Reading): Partial<Pick<RequestRules, 'yearMin' | 'yearMax' | 'yearSource'>> {
  if (r.windows.length > 0) {
    const mins = r.windows.map((w) => w[0]);
    const maxes = r.windows.map((w) => w[1]);
    return {
      yearMin: mins.includes(null) ? null : Math.min(...(mins as number[])),
      yearMax: maxes.includes(null) ? null : Math.max(...(maxes as number[])),
      yearSource: 'stated',
    };
  }
  if (r.bareYears.length > 0) {
    // "Thriller new 2025": a year with a recency word means that year or newer.
    const yearMax = r.recency ? null : Math.max(...r.bareYears);
    return { yearMin: Math.min(...r.bareYears), yearMax, yearSource: 'stated' };
  }
  if (r.recency) {
    const back = (r.recency === 'new' ? NEW_YEARS : RECENT_YEARS) - 1;
    return { yearMin: r.cy - back, yearMax: null, yearSource: 'recent' };
  }
  if (r.anyYear) return { yearMin: null, yearMax: null, yearSource: 'any' };
  return {};
}

/** A negator with nothing after it to exclude ("not too long") carries no rule. */
function unread(toks: Token[]): string[] {
  const words = toks.filter((t) => !t.used && isContentWord(t) && !NEGATORS.has(t.norm)).map((t) => t.w);
  return [...new Set(words)];
}
