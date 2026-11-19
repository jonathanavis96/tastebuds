import type Database from 'better-sqlite3';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import type { Config } from '../config.js';
import { applyImdbGenres, applyImdbRatings } from '../db/repos/titles.js';

/** IMDb's daily non-commercial data files (https://developer.imdb.com/non-commercial-datasets/). */
export const IMDB_RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
export const IMDB_BASICS_URL = 'https://datasets.imdbws.com/title.basics.tsv.gz';

const USER_AGENT = 'TasteBuds/0.1 (self-hosted film and series recommender)';
/** The ratings file is about 8 MB; the basics file about 230 MB. */
const RATINGS_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/**
 * A new ratings file must list at least this share of the titles that have a
 * rating now. A well-formed file with a fraction of its usual rows would
 * otherwise clear the rating of every title it leaves out.
 */
const MIN_FILE_COVERAGE = 0.5;
const BASICS_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

export interface ImdbRatingsSyncResult {
  /** Titles whose rating or vote count changed. */
  updated: number;
  /** Titles that had a rating which IMDb no longer lists. */
  cleared: number;
  /** Titles with an imdb_id that were compared. */
  checked: number;
  /**
   * True when IMDb said the file had not changed since the last download, so
   * only titles never synced before were compared, against the file on disk.
   */
  unchanged: boolean;
}

interface CatalogueRow {
  id: number;
  imdb_id: string;
  imdb_rating: string | null;
  imdb_votes: number | null;
}

interface ImdbRating {
  rating: string;
  votes: number;
}

/** Where the ratings file is kept: beside the database, in imdb/. */
export function imdbRatingsPath(config: Pick<Config, 'dbPath'>): string {
  return join(dirname(config.dbPath), 'imdb', 'title.ratings.tsv.gz');
}

/**
 * Download IMDb's ratings file and make imdb_rating / imdb_votes match it for
 * every title with an imdb_id, stamping imdb_synced_at. The file is kept beside
 * the database so applyCachedImdbRatings can read it without a download.
 */
export async function syncImdbRatings(
  db: InstanceType<typeof Database>,
  config: Pick<Config, 'dbPath'>,
  fetchImpl: typeof fetch = fetch,
): Promise<ImdbRatingsSyncResult> {
  const path = imdbRatingsPath(config);
  const downloaded = await downloadRatings(path, fetchImpl);

  if (downloaded === null) {
    const rows = selectCatalogue(db, 'WHERE imdb_id IS NOT NULL AND imdb_synced_at IS NULL');
    const found = await readRatings(path, rows);
    return { ...writeComparison(db, rows, found, await fileTime(path)), unchanged: true };
  }

  // Read the new file before it replaces the old one, so a damaged download
  // fails here and the last good file stays in place.
  const rows = selectCatalogue(db, 'WHERE imdb_id IS NOT NULL');
  let found: Map<string, ImdbRating>;
  try {
    found = await readRatings(downloaded.tempPath, rows);
    const rated = rows.filter((r) => r.imdb_rating != null).length;
    if (found.size < rated * MIN_FILE_COVERAGE) {
      throw new Error(`IMDb ratings file lists only ${found.size} of ${rated} rated titles; the stored ratings are kept`);
    }
    await rename(downloaded.tempPath, path);
  } catch (err) {
    await rm(downloaded.tempPath, { force: true });
    throw err;
  }
  await saveEtag(path, downloaded.etag);
  return { ...writeComparison(db, rows, found, await fileTime(path)), unchanged: false };
}

/**
 * Set imdb_rating / imdb_votes for `titleIds` from the ratings file already on
 * disk (titles added since the last sync). Returns how many got a rating; 0 when
 * there is no file yet. A title the file does not list is left as it is: the
 * file on disk may be a day old, so only the nightly sync, on a fresh file,
 * decides that a title has no rating.
 */
export async function applyCachedImdbRatings(
  db: InstanceType<typeof Database>,
  config: Pick<Config, 'dbPath'>,
  titleIds: number[],
): Promise<number> {
  const path = imdbRatingsPath(config);
  const syncedAt = await fileTime(path).catch(() => null);
  if (syncedAt === null || titleIds.length === 0) return 0;

  const placeholders = titleIds.map(() => '?').join(',');
  const rows = selectCatalogue(db, `WHERE imdb_id IS NOT NULL AND id IN (${placeholders})`, titleIds);
  if (rows.length === 0) return 0;

  const found = await readRatings(path, rows, { stopWhenAllFound: true });
  const listed = rows.filter((r) => found.has(r.imdb_id));
  writeComparison(db, listed, found, syncedAt);
  return listed.length;
}

/**
 * Stream IMDb's title.basics file (about 230 MB, not kept) and store each
 * catalogue title's IMDb genres in imdb_genres. Returns how many rows changed.
 */
export async function syncImdbGenres(
  db: InstanceType<typeof Database>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ updated: number }> {
  const rows = db
    .prepare('SELECT id, imdb_id, imdb_genres FROM titles WHERE imdb_id IS NOT NULL')
    .all() as Array<{ id: number; imdb_id: string; imdb_genres: string | null }>;
  const byImdbId = groupByImdbId(rows);

  const res = await fetchImpl(IMDB_BASICS_URL, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(BASICS_DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) throw new Error(`IMDb basics download failed with HTTP ${res.status}`);

  // Columns: tconst, titleType, primaryTitle, originalTitle, isAdult, startYear,
  // endYear, runtimeMinutes, genres ("Crime,Drama" or \N).
  const writes: Array<{ id: number; genres: string }> = [];
  for await (const line of gzipLines(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>))) {
    const matches = byImdbId.get(line.slice(0, line.indexOf('\t')));
    if (!matches) continue;
    const raw = line.slice(line.lastIndexOf('\t') + 1);
    if (raw === '\\N' || raw === '') continue;
    const genres = JSON.stringify(raw.split(','));
    for (const row of matches) {
      if (row.imdb_genres !== genres) writes.push({ id: row.id, genres });
    }
  }

  applyImdbGenres(db, writes);
  return { updated: writes.length };
}

function selectCatalogue(
  db: InstanceType<typeof Database>,
  where: string,
  params: number[] = [],
): CatalogueRow[] {
  return db
    .prepare(`SELECT id, imdb_id, imdb_rating, imdb_votes FROM titles ${where}`)
    .all(...params) as CatalogueRow[];
}

/** Two catalogue rows can share an imdb_id (a film and a series TMDB mixed up). */
function groupByImdbId<T extends { imdb_id: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.imdb_id);
    if (list) list.push(row);
    else map.set(row.imdb_id, [row]);
  }
  return map;
}

/**
 * Download the ratings file to a temporary file beside `path`, sending the stored
 * ETag so IMDb can answer 304. Returns null when the file is unchanged (its
 * modification time is moved to now: it was just confirmed current).
 */
async function downloadRatings(
  path: string,
  fetchImpl: typeof fetch,
): Promise<{ tempPath: string; etag: string | null } | null> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  const hasFile = await stat(path).then(() => true, () => false);
  const storedEtag = hasFile ? await readFile(`${path}.etag`, 'utf8').catch(() => '') : '';
  if (storedEtag) headers['If-None-Match'] = storedEtag.trim();

  const res = await fetchImpl(IMDB_RATINGS_URL, {
    headers,
    signal: AbortSignal.timeout(RATINGS_DOWNLOAD_TIMEOUT_MS),
  });
  if (res.status === 304) {
    const now = new Date();
    await utimes(path, now, now);
    return null;
  }
  if (!res.ok || !res.body) throw new Error(`IMDb ratings download failed with HTTP ${res.status}`);

  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(tempPath));
  } catch (err) {
    await rm(tempPath, { force: true });
    throw err;
  }
  return { tempPath, etag: res.headers.get('etag') };
}

async function saveEtag(path: string, etag: string | null): Promise<void> {
  if (etag) await writeFile(`${path}.etag`, etag);
  else await rm(`${path}.etag`, { force: true });
}

/** The file's modification time in unix seconds: when IMDb last confirmed it. */
async function fileTime(path: string): Promise<number> {
  return Math.floor((await stat(path)).mtimeMs / 1000);
}

/** Lines of a gzipped TSV stream, without its header line. */
async function* gzipLines(source: Readable): AsyncGenerator<string> {
  const gunzip = createGunzip();
  source.on('error', (err) => gunzip.destroy(err));
  source.pipe(gunzip).setEncoding('utf8');
  let rest = '';
  let header = true;
  try {
    for await (const chunk of gunzip as AsyncIterable<string>) {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (header) header = false;
        else yield line;
      }
    }
    if (rest && !header) yield rest;
  } finally {
    source.destroy();
    gunzip.destroy();
  }
}

/**
 * The ratings of `rows` from a ratings file (tconst, averageRating, numVotes),
 * streamed. Only the catalogue's ids are kept, never the whole file.
 */
async function readRatings(
  path: string,
  rows: CatalogueRow[],
  { stopWhenAllFound = false } = {},
): Promise<Map<string, ImdbRating>> {
  const wanted = new Set(rows.map((r) => r.imdb_id));
  const found = new Map<string, ImdbRating>();
  if (wanted.size === 0) return found;
  for await (const line of gzipLines(createReadStream(path))) {
    const [tconst, average, votes] = line.split('\t');
    if (!wanted.has(tconst)) continue;
    const rating = Number(average);
    const voteCount = Number(votes);
    if (!Number.isFinite(rating) || !Number.isInteger(voteCount)) continue;
    found.set(tconst, { rating: rating.toFixed(1), votes: voteCount });
    if (stopWhenAllFound && found.size === wanted.size) break;
  }
  return found;
}

/** Write the file's answer for every row and count what changed. */
function writeComparison(
  db: InstanceType<typeof Database>,
  rows: CatalogueRow[],
  found: Map<string, ImdbRating>,
  syncedAt: number,
): Omit<ImdbRatingsSyncResult, 'unchanged'> {
  let updated = 0;
  let cleared = 0;
  const writes = rows.map((row) => {
    const imdb = found.get(row.imdb_id);
    if (imdb && (imdb.rating !== row.imdb_rating || imdb.votes !== row.imdb_votes)) updated++;
    if (!imdb && row.imdb_rating != null) cleared++;
    return { id: row.id, rating: imdb?.rating ?? null, votes: imdb?.votes ?? null };
  });
  applyImdbRatings(db, writes, syncedAt);
  return { updated, cleared, checked: rows.length };
}
