/**
 * Data for the per-profile taste chart (a radar chart, one spoke per genre).
 *
 * Each value is how a person rates a genre compared with their own usual
 * rating, in stars: +0.5 means half a star above their usual, −0.7 means 0.7
 * below. "Not interested" taps count as a 2.5★ rating. Small samples are
 * pulled toward zero (n / (n + 3)), so one 5★ western does not draw a spike.
 *
 * The spokes are chosen from the household's own data: the genres (with at
 * least MIN_AXIS_TITLES titles) whose ratings differ most from each person's
 * usual, summed across profiles. Database-only.
 */
import type Database from 'better-sqlite3';
import { TV_KEYWORD_GENRES } from '../tmdb/taxonomy.js';

/** TMDB's movie and series genre names that mean the same thing share one spoke. */
const GENRE_ALIASES: Record<string, string> = {
  'Action & Adventure': 'Action',
  'Science Fiction': 'Sci-Fi',
  'Sci-Fi & Fantasy': 'Sci-Fi',
  'War & Politics': 'War',
  Kids: 'Family',
};

/** Spoke order around the circle, so related genres sit next to each other. */
const AXIS_ORDER = [
  'Action', 'Adventure', 'Thriller', 'Crime', 'Mystery', 'Horror', 'Sci-Fi', 'Fantasy',
  'Animation', 'Family', 'Comedy', 'Romance', 'Drama', 'History', 'War', 'Western', 'Documentary',
];

export const MAX_AXES = 8;
const MIN_AXES = 3;
/** A genre needs this many titles across the household to be a spoke. */
const MIN_AXIS_TITLES = 8;
/** Fallback when too few genres pass MIN_AXIS_TITLES. */
const MIN_FILL_TITLES = 3;
const DISMISS_AS_RATING = 2.5;
const SHRINK_K = 3;

export interface TasteSeries {
  profileId: number;
  label: string;
  /** 'together' = the Joint profile's own ratings (what the couple rated as a pair). */
  kind: 'person' | 'together';
  /** Stars above (+) or below (−) this profile's usual rating, per axis; null = no titles of that genre. */
  lifts: Array<number | null>;
  counts: number[];
  /** Ratings plus "Not interested" taps this series is built from. */
  total: number;
}

export interface TasteChart {
  axes: string[];
  series: TasteSeries[];
}

interface Row { genres: string; keywords: string; media_type: string; y: number }

/** The chart's genre names for one title: aliases merged, and series' horror/thriller keywords counted as genres. */
export function chartGenres(genresJson: string, keywordsJson: string, mediaType: string): string[] {
  const out = new Set<string>();
  for (const g of parseList(genresJson)) out.add(GENRE_ALIASES[g] ?? g);
  if (mediaType === 'tv') {
    const kws = parseList(keywordsJson).map(k => k.toLowerCase());
    for (const [genre, term] of Object.entries(TV_KEYWORD_GENRES)) {
      if (kws.some(k => k.includes(term))) out.add(genre);
    }
  }
  return [...out];
}

function parseList(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function loadRows(db: InstanceType<typeof Database>, profileId: number): Row[] {
  const rated = db.prepare(`
    SELECT t.genres, t.keywords, t.media_type, we.rating AS y, we.title_id
    FROM watch_events we JOIN titles t ON t.id = we.title_id
    WHERE we.profile_id = ? AND we.rating IS NOT NULL
  `).all(profileId) as Array<Row & { title_id: number }>;
  const seen = new Set(rated.map(r => r.title_id));
  const dismissed = db.prepare(`
    SELECT DISTINCT r.title_id, t.genres, t.keywords, t.media_type
    FROM recommendations r JOIN titles t ON t.id = r.title_id
    WHERE r.profile_id = ? AND r.state = 'dismissed'
  `).all(profileId) as Array<Omit<Row, 'y'> & { title_id: number }>;
  return [
    ...rated,
    ...dismissed.filter(d => !seen.has(d.title_id)).map(d => ({ ...d, y: DISMISS_AS_RATING })),
  ];
}

interface GenreStat { n: number; lift: number; z: number }

/** Per-genre lift (shrunk, in stars) and z-score against the profile's own mean. */
export function genreStats(rows: Row[]): Map<string, GenreStat> {
  const out = new Map<string, GenreStat>();
  if (rows.length === 0) return out;
  const mean = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  const sd = Math.sqrt(rows.reduce((s, r) => s + (r.y - mean) ** 2, 0) / rows.length);
  const acc = new Map<string, { n: number; sum: number }>();
  for (const r of rows) {
    for (const g of chartGenres(r.genres, r.keywords, r.media_type)) {
      const a = acc.get(g) ?? { n: 0, sum: 0 };
      a.n++; a.sum += r.y;
      acc.set(g, a);
    }
  }
  for (const [g, { n, sum }] of acc) {
    const diff = sum / n - mean;
    out.set(g, {
      n,
      lift: (n / (n + SHRINK_K)) * diff,
      z: sd > 0 ? diff / (sd / Math.sqrt(n)) : 0,
    });
  }
  return out;
}

/** Pick the spokes: the genres that most separate likes from dislikes across all profiles. */
export function chooseAxes(statsByProfile: Array<Map<string, GenreStat>>): string[] {
  const total = new Map<string, { n: number; sep: number }>();
  for (const stats of statsByProfile) {
    for (const [g, s] of stats) {
      const t = total.get(g) ?? { n: 0, sep: 0 };
      t.n += s.n; t.sep += Math.abs(s.z);
      total.set(g, t);
    }
  }
  const entries = [...total.entries()];
  const picked = entries
    .filter(([, t]) => t.n >= MIN_AXIS_TITLES)
    .sort((a, b) => b[1].sep - a[1].sep || b[1].n - a[1].n)
    .slice(0, MAX_AXES)
    .map(([g]) => g);
  if (picked.length < MAX_AXES) {
    const fill = entries
      .filter(([g, t]) => !picked.includes(g) && t.n >= MIN_FILL_TITLES)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, MAX_AXES - picked.length)
      .map(([g]) => g);
    picked.push(...fill);
  }
  if (picked.length < MIN_AXES) return [];
  const rank = (g: string) => { const i = AXIS_ORDER.indexOf(g); return i === -1 ? AXIS_ORDER.length : i; };
  return picked.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * The chart for one profile. A solo profile gets one shape; the Joint (derived)
 * profile gets each person's shape plus the couple's together-ratings.
 */
export function tasteChartForProfile(db: InstanceType<typeof Database>, profileId: number): TasteChart | null {
  const profiles = db.prepare('SELECT id, name, is_derived FROM profiles ORDER BY id').all() as Array<{
    id: number; name: string; is_derived: number;
  }>;
  const me = profiles.find(p => p.id === profileId);
  if (!me) return null;
  const rowsBy = new Map(profiles.map(p => [p.id, loadRows(db, p.id)]));
  const statsBy = new Map(profiles.map(p => [p.id, genreStats(rowsBy.get(p.id)!)]));
  const axes = chooseAxes([...statsBy.values()]);

  const shown = me.is_derived
    ? [...profiles.filter(p => !p.is_derived), me]
    : [me];
  const series: TasteSeries[] = shown.map(p => {
    const stats = statsBy.get(p.id)!;
    return {
      profileId: p.id,
      label: p.is_derived ? 'Together' : p.name,
      kind: p.is_derived ? 'together' : 'person',
      lifts: axes.map(g => { const s = stats.get(g); return s ? Math.round(s.lift * 100) / 100 : null; }),
      counts: axes.map(g => stats.get(g)?.n ?? 0),
      total: rowsBy.get(p.id)!.length,
    };
  });
  return { axes, series };
}
