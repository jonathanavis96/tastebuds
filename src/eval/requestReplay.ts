/**
 * Request replay check: for each free-text request ever made, how many of the
 * picks returned for it obey the request?
 *
 *   npm run eval:requests -- --db path/to/COPY.db --expect path/to/expectations.json
 *       [--picks old|new] [--imdb path/to/title.ratings.tsv.gz] [--json out.json] [--verbose]
 *
 * It scores the picks stored in `recommendations`, so it reports what the app
 * returned at the time. --picks old keeps only picks made before requests were
 * read into rules (they have no request_summary), --picks new only the ones made
 * since; `npm run eval:rerun` makes fresh picks for every past request on a copy.
 * --imdb replaces the stored IMDb ratings with the ones in IMDb's ratings file,
 * for a database whose ratings are known to be stale.
 *
 * The expectations file is written by hand: for each request text, the rules a
 * person reads in it (film or series, year window, genres, themes, exclusions,
 * rating floor). This file checks picks against those rules with its own small
 * checker and deliberately imports nothing from src/request: it would prove
 * nothing to check the rule checker with itself.
 *
 * Three cumulative scores per request:
 *   stated   film/series, a stated or "new/recent" year, genres and moods,
 *            exclusions, rating words, language
 *   +recent  the same, plus "recent by default" when no year was stated (an
 *            older pick counts only if it carries a note saying why)
 *   +rated   the same, plus a real IMDb rating at or above the profile's setting
 */
import Database from 'better-sqlite3';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

interface ExpClause { g?: string[]; theme?: string[] }

interface Expectation {
  text: string;
  media?: 'movie' | 'tv';
  yearMin?: number;
  yearMax?: number;
  yearSource?: 'stated' | 'recent' | 'default' | 'any';
  minImdb?: number;
  language?: string;
  hiddenGem?: boolean;
  must: ExpClause[];
  mustNot?: ExpClause[];
}

interface ExpectationFile {
  now: string;
  themes: Record<string, string[]>;
  requests: Expectation[];
}

interface PickRow {
  profile_id: number;
  request_text: string;
  rule_note: string | null;
  title: string;
  year: number | null;
  media_type: 'movie' | 'tv';
  genres: string;
  keywords: string;
  synopsis: string | null;
  imdb_id: string | null;
  imdb_rating: string | null;
  imdb_votes: number | null;
  imdb_genres: string | null;
  original_language: string | null;
}

export interface PickScore {
  title: string;
  year: number | null;
  media: 'movie' | 'tv';
  imdb: number | null;
  /** Rules broken, by group; an empty object means the pick obeys everything. */
  broken: { stated: string[]; recent: string[]; rated: string[] };
  note: string | null;
}

export interface RequestScore {
  text: string;
  profileId: number;
  picks: PickScore[];
  stated: number;
  recent: number;
  rated: number;
}

const DEFAULT_RECENT_YEARS = 6;
const MIN_IMDB_VOTES = { movie: 1000, tv: 500 } as const;
const HIDDEN_GEM_MAX_VOTES = 50_000;

/** IMDb and TMDB genre names → the names the expectations use. */
const GENRE_ALIASES: Record<string, string[]> = {
  'Sci-Fi': ['Science Fiction'],
  Kids: ['Family'],
  Musical: ['Music'],
  'Reality-TV': ['Reality'],
};

/**
 * Series keywords that name a genre outright, for the genres TMDB's TV list
 * lacks. The last word is what the series is: "horror comedy" is a comedy.
 */
const KEYWORD_GENRES: Array<[RegExp, string]> = [
  [/(^| )thriller$|^suspense$/, 'Thriller'],
  [/(^| )horror$|^slasher$/, 'Horror'],
  [/^science fiction$|^sci-fi$/, 'Science Fiction'],
  [/(^| )fantasy$/, 'Fantasy'],
  [/(^| )romance$|^romcom$|^romantic comedy$/, 'Romance'],
  [/^romcom$|^romantic comedy$/, 'Comedy'],
  [/(^| )musical$/, 'Music'],
];

function jsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * What makes a "Sci-Fi & Fantasy" series one or the other. IMDb's data file
 * lists three genres per title in alphabetical order, so Sci-Fi is often cut and
 * IMDb saying nothing proves nothing (Black Mirror: Crime, Drama, Mystery).
 */
const SCI_FI_SIGNS = /\b(science fiction|sci-fi|dystopian?|post-apocalyptic|time travel|time machine|time loop|aliens?|extraterrestrial|ufo|space|spacecraft|spaceship|planet|astronauts?|artificial intelligence|robots?|androids?|cyborgs?|cyberpunk|mutants?|clon(e|es|ing)|genetic engineering|virtual reality|simulation|parallel (universe|world)|multiverse|alternate (history|reality|timeline)|future|futuristic|technology|scientists?|experiments?|nuclear war|superhero(es)?|teleportation|telekinesis|mecha|kaiju|steampunk)\b/;
const FANTASY_SIGNS = /\b(fantasy|magic|sorcery|sorcerer|witch(es)?|wizards?|dragons?|elf|elves|dwarf|trolls?|fairy|mythology|curse|demons?|vampires?|werewol(f|ves)|ghosts?|supernatural|paranormal|gods?|goddess|underworld|afterlife|reincarnation|alchemy|mermaids?|monsters?|exorcism|possession|immortal(ity)?|chosen one|isekai|yokai|zombies?|undead|devil|prophecy|folklore|shapeshifter|necromancer|occult)\b/;

/**
 * Which side of TMDB's "Sci-Fi & Fantasy" a series is on. IMDb names win where
 * they can: a list with Sci-Fi is complete for Fantasy (it sorts earlier), a
 * list with Fantasy may have lost Sci-Fi only if it is full (three names).
 * Where IMDb cannot say, the keywords do: one side when they point there three
 * times as often as to the other, otherwise both.
 */
function sciFiOrFantasy(imdb: string[], keywords: string[]): string[] {
  if (imdb.includes('Sci-Fi')) return [];
  const lower = keywords.map((k) => k.toLowerCase());
  const sciFi = lower.filter((k) => SCI_FI_SIGNS.test(k)).length;
  const fantasy = lower.filter((k) => FANTASY_SIGNS.test(k)).length;
  if (imdb.includes('Fantasy')) return imdb.length >= 3 && sciFi > 0 && fantasy < 3 * sciFi ? ['Science Fiction'] : [];
  if (sciFi > 0 && sciFi >= 3 * fantasy) return ['Science Fiction'];
  if (fantasy > 0 && fantasy >= 3 * sciFi) return ['Fantasy'];
  return ['Science Fiction', 'Fantasy'];
}

function genresOf(p: PickRow): Set<string> {
  const imdb = jsonArray(p.imdb_genres);
  const keywords = jsonArray(p.keywords);
  // IMDb's own genres always count, under the names the expectations use.
  const out = new Set<string>(imdb.flatMap((g) => GENRE_ALIASES[g] ?? [g]));
  for (const g of jsonArray(p.genres)) {
    if (g === 'Sci-Fi & Fantasy') { for (const name of sciFiOrFantasy(imdb, keywords)) out.add(name); continue; }
    // "Action" and "Adventure" sort first, so IMDb's three never cut them.
    if (g === 'Action & Adventure') { if (imdb.length === 0) { out.add('Action'); out.add('Adventure'); } continue; }
    // Mostly political drama: War needs IMDb or a keyword to say so.
    if (g === 'War & Politics') { if (keywords.some((k) => /\b(war|battle|soldier|military|army)\b/i.test(k))) out.add('War'); continue; }
    for (const name of GENRE_ALIASES[g] ?? [g]) out.add(name);
  }
  // TMDB has no Thriller or Horror genre for series, so a keyword naming one
  // counts there. Films have both genre fields; a keyword such as "comedy
  // horror" on a satire would mislabel them.
  if (p.media_type === 'tv') {
    for (const kw of keywords) {
      const k = kw.toLowerCase();
      for (const [re, genre] of KEYWORD_GENRES) if (re.test(k)) out.add(genre);
    }
  }
  return out;
}

function mentions(p: PickRow, terms: string[]): boolean {
  const hay = [...jsonArray(p.keywords), p.title, p.synopsis ?? ''].join(' \n ').toLowerCase();
  return terms.some((t) => {
    const escaped = t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}(e?s)?($|[^a-z0-9])`).test(hay);
  });
}

function clauseHolds(c: ExpClause, p: PickRow, genres: Set<string>, themes: Record<string, string[]>): boolean {
  if (c.g?.some((g) => genres.has(g))) return true;
  const terms = (c.theme ?? []).flatMap((name) => themes[name] ?? []);
  return terms.length > 0 && mentions(p, terms);
}

const clauseName = (c: ExpClause): string => [...(c.g ?? []), ...(c.theme ?? [])].join('/');

export function scorePick(
  exp: Expectation,
  p: PickRow,
  themes: Record<string, string[]>,
  nowYear: number,
  profileFloor: number | null,
): PickScore {
  const stated: string[] = [];
  const recent: string[] = [];
  const rated: string[] = [];
  const genres = genresOf(p);
  const imdb = p.imdb_rating != null && p.imdb_rating !== '' ? Number(p.imdb_rating) : null;

  if (exp.media && p.media_type !== exp.media) stated.push(`is a ${p.media_type === 'tv' ? 'series' : 'film'}`);

  const source = exp.yearSource ?? 'default';
  const yearMin = exp.yearMin ?? (source === 'default' ? nowYear - (DEFAULT_RECENT_YEARS - 1) : null);
  const yearMax = exp.yearMax ?? null;
  const outside = p.year == null || (yearMin != null && p.year < yearMin) || (yearMax != null && p.year > yearMax);
  if (outside && source !== 'any') {
    const want = yearMax != null ? `${yearMin ?? ''}–${yearMax}` : `${yearMin}+`;
    // With no year in the request, an older pick is allowed when it says why.
    if (source === 'default') { if (!p.rule_note) recent.push(`${p.year ?? 'no year'}, default is ${want}`); }
    else stated.push(`${p.year ?? 'no year'}, asked ${want}`);
  }

  for (const c of exp.must) if (!clauseHolds(c, p, genres, themes)) stated.push(`not ${clauseName(c)}`);
  for (const c of exp.mustNot ?? []) if (clauseHolds(c, p, genres, themes)) stated.push(`has ${clauseName(c)}`);
  if (exp.minImdb != null && (imdb == null || imdb < exp.minImdb)) stated.push(`IMDb ${imdb ?? 'none'} < ${exp.minImdb}`);
  if (exp.language && p.original_language !== exp.language) stated.push(`language ${p.original_language ?? '?'}`);
  if (exp.hiddenGem && (p.imdb_votes == null || p.imdb_votes > HIDDEN_GEM_MAX_VOTES)) stated.push('not a hidden gem');

  if (imdb == null) rated.push('no IMDb rating');
  else if ((p.imdb_votes ?? 0) < MIN_IMDB_VOTES[p.media_type]) rated.push(`only ${p.imdb_votes ?? 0} IMDb votes`);
  else if (profileFloor != null && imdb < profileFloor) rated.push(`IMDb ${imdb} < profile ${profileFloor}`);

  return { title: p.title, year: p.year, media: p.media_type, imdb, broken: { stated, recent, rated }, note: p.rule_note };
}

/** tconst → [rating, votes] for the given ids, streamed from IMDb's ratings file. */
async function readImdbRatings(file: string, ids: Set<string>): Promise<Map<string, [string, number]>> {
  const out = new Map<string, [string, number]>();
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    const tab = line.indexOf('\t');
    if (!ids.has(line.slice(0, tab))) continue;
    const [, rating, votes] = line.split('\t');
    out.set(line.slice(0, tab), [rating, Number(votes)]);
  }
  return out;
}

function hasColumn(db: InstanceType<typeof Database>, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

export type PickSet = 'all' | 'old' | 'new';

function loadPicks(db: InstanceType<typeof Database>, which: PickSet): PickRow[] {
  const titleCol = (name: string) => (hasColumn(db, 'titles', name) ? `t.${name}` : 'NULL');
  const ruleNote = hasColumn(db, 'recommendations', 'rule_note') ? 'r.rule_note' : 'NULL';
  // Before migration 016 there is no request_summary column: every pick is an old one.
  const hasSummary = hasColumn(db, 'recommendations', 'request_summary');
  if (which === 'new' && !hasSummary) return [];
  const only = !hasSummary || which === 'all' ? '' : `AND r.request_summary IS ${which === 'new' ? 'NOT NULL' : 'NULL'}`;
  return db.prepare(`
    SELECT r.profile_id, r.request_text, ${ruleNote} AS rule_note,
           t.title, t.year, t.media_type, t.genres, t.keywords, t.synopsis, t.imdb_id, t.imdb_rating,
           ${titleCol('imdb_votes')} AS imdb_votes, ${titleCol('imdb_genres')} AS imdb_genres, t.original_language
    FROM recommendations r JOIN titles t ON t.id = r.title_id
    WHERE r.request_text IS NOT NULL ${only}
    ORDER BY r.id
  `).all() as PickRow[];
}

export async function scoreStoredPicks(
  db: InstanceType<typeof Database>,
  expectations: ExpectationFile,
  opts: { picks?: PickSet; imdbFile?: string } = {},
): Promise<{ scores: RequestScore[]; unknown: string[] }> {
  const picks = loadPicks(db, opts.picks ?? 'all');
  const imdbFile = opts.imdbFile;
  if (imdbFile) {
    const ratings = await readImdbRatings(imdbFile, new Set(picks.map((p) => p.imdb_id).filter((x): x is string => !!x)));
    for (const p of picks) {
      const r = p.imdb_id ? ratings.get(p.imdb_id) : undefined;
      p.imdb_rating = r ? r[0] : null;
      p.imdb_votes = r ? r[1] : null;
    }
  }
  const floors = new Map<number, number | null>();
  for (const row of db.prepare('SELECT id, config FROM profiles').all() as Array<{ id: number; config: string }>) {
    let floor: number | null = null;
    try {
      const v = (JSON.parse(row.config || '{}') as { rating_threshold?: unknown }).rating_threshold;
      if (typeof v === 'number') floor = v;
    } catch { /* unreadable config: no floor */ }
    floors.set(row.id, floor);
  }
  const byText = new Map(expectations.requests.map((e) => [e.text, e]));
  const nowYear = new Date(expectations.now).getFullYear();
  const grouped = new Map<string, RequestScore>();
  const unknown = new Set<string>();
  for (const p of picks) {
    const exp = byText.get(p.request_text);
    if (!exp) { unknown.add(p.request_text); continue; }
    const key = `${p.profile_id}\u0000${p.request_text}`;
    const score = grouped.get(key) ?? { text: p.request_text, profileId: p.profile_id, picks: [], stated: 0, recent: 0, rated: 0 };
    const s = scorePick(exp, p, expectations.themes, nowYear, floors.get(p.profile_id) ?? null);
    score.picks.push(s);
    const okStated = s.broken.stated.length === 0;
    const okRecent = okStated && s.broken.recent.length === 0;
    if (okStated) score.stated++;
    if (okRecent) score.recent++;
    if (okRecent && s.broken.rated.length === 0) score.rated++;
    grouped.set(key, score);
  }
  return { scores: [...grouped.values()], unknown: [...unknown] };
}

export function formatReport(scores: RequestScore[], verbose: boolean): string {
  const lines: string[] = [];
  const sum = (f: (s: RequestScore) => number) => scores.reduce((n, s) => n + f(s), 0);
  const total = sum((s) => s.picks.length);
  const pct = (n: number) => (total === 0 ? 'n/a' : `${n}/${total} (${Math.round((100 * n) / total)}%)`);
  lines.push(`${scores.length} requests, ${total} picks`);
  lines.push(`  obey the stated rules:              ${pct(sum((s) => s.stated))}`);
  lines.push(`  ...and recent by default:           ${pct(sum((s) => s.recent))}`);
  lines.push(`  ...and really rated at the setting: ${pct(sum((s) => s.rated))}`);
  lines.push(`  requests where every pick obeys everything: ${scores.filter((s) => s.picks.length > 0 && s.rated === s.picks.length).length}/${scores.length}`);
  lines.push('');
  lines.push('stated +recent +rated  of  request');
  for (const s of scores) {
    lines.push(`${String(s.stated).padStart(6)} ${String(s.recent).padStart(7)} ${String(s.rated).padStart(6)}  ${String(s.picks.length).padStart(2)}  [p${s.profileId}] ${s.text}`);
    if (!verbose) continue;
    for (const p of s.picks) {
      const broken = [...p.broken.stated, ...p.broken.recent, ...p.broken.rated];
      const mark = broken.length === 0 ? 'ok ' : 'NO ';
      lines.push(`          ${mark} ${p.title} (${p.year ?? '?'}, ${p.media === 'tv' ? 'series' : 'film'}, IMDb ${p.imdb ?? 'none'})${broken.length ? ': ' + broken.join('; ') : ''}${p.note ? ` [note: ${p.note}]` : ''}`);
    }
  }
  return lines.join('\n');
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const dbPath = arg('db');
  const expectPath = arg('expect');
  if (!dbPath || !expectPath) {
    console.error('usage: npm run eval:requests -- --db COPY.db --expect expectations.json [--picks old|new] [--imdb title.ratings.tsv.gz] [--json out.json] [--verbose]');
    process.exit(2);
  }
  const which = arg('picks');
  const picks: PickSet = which === 'old' || which === 'new' ? which : 'all';
  const expectations = JSON.parse(readFileSync(expectPath, 'utf8')) as ExpectationFile;
  const db = new Database(dbPath, { readonly: true });
  const { scores, unknown } = await scoreStoredPicks(db, expectations, { picks, imdbFile: arg('imdb') });
  console.log(formatReport(scores, process.argv.includes('--verbose')));
  if (unknown.length > 0) console.log(`\nNo expectation written for: ${unknown.map((u) => JSON.stringify(u)).join(', ')}`);
  const jsonOut = arg('json');
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(scores, null, 1));
}

if (process.argv[1] && /requestReplay\.(ts|js)$/.test(process.argv[1])) void main();
