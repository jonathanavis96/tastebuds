import type Database from 'better-sqlite3';
import type { TitleRow } from '../types.js';

const OPTIONAL_TITLE_FIELDS = [
  'imdb_id',
  'imdb_rating',
  'rt_rating',
  'rt_url',
  'popularity',
  'vote_count',
  'rating_checked_at',
  'rt_checked_at',
  'original_language',
  'runtime_minutes',
  'vote_average',
  'status',
  'meta_checked_at',
  'imdb_votes',
  'imdb_synced_at',
  'imdb_genres',
  'imdb_id_checked_at',
  'rt_verified_at',
] as const;

type OptionalTitleField = (typeof OPTIONAL_TITLE_FIELDS)[number];

export function upsertTitle(
  db: InstanceType<typeof Database>,
  title: Omit<TitleRow, 'id'> | (Omit<TitleRow, 'id' | OptionalTitleField> & Partial<Pick<TitleRow, OptionalTitleField>>),
): void {
  db.prepare(`
    INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, embedding, updated_at, imdb_id, imdb_rating, rt_rating, popularity, vote_count, original_language, runtime_minutes, vote_average, status, meta_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tmdb_id, media_type) DO UPDATE SET
      title       = excluded.title,
      year        = excluded.year,
      genres      = excluded.genres,
      keywords    = excluded.keywords,
      cast        = excluded.cast,
      synopsis    = excluded.synopsis,
      poster_path = excluded.poster_path,
      embedding   = excluded.embedding,
      updated_at  = excluded.updated_at,
      imdb_id     = COALESCE(excluded.imdb_id, titles.imdb_id),
      popularity  = excluded.popularity,
      vote_count  = excluded.vote_count,
      original_language = COALESCE(excluded.original_language, titles.original_language),
      runtime_minutes   = COALESCE(excluded.runtime_minutes, titles.runtime_minutes),
      vote_average      = COALESCE(excluded.vote_average, titles.vote_average),
      status            = COALESCE(excluded.status, titles.status),
      meta_checked_at   = COALESCE(excluded.meta_checked_at, titles.meta_checked_at)
  `).run(
    title.tmdb_id,
    title.media_type,
    title.title,
    title.year,
    title.genres,
    title.keywords,
    title.cast,
    title.synopsis,
    title.poster_path,
    title.embedding,
    title.updated_at,
    (title as Partial<TitleRow>).imdb_id ?? null,
    (title as Partial<TitleRow>).imdb_rating ?? null,
    (title as Partial<TitleRow>).rt_rating ?? null,
    (title as Partial<TitleRow>).popularity ?? null,
    (title as Partial<TitleRow>).vote_count ?? null,
    (title as Partial<TitleRow>).original_language ?? null,
    (title as Partial<TitleRow>).runtime_minutes ?? null,
    (title as Partial<TitleRow>).vote_average ?? null,
    (title as Partial<TitleRow>).status ?? null,
    (title as Partial<TitleRow>).meta_checked_at ?? null,
  );
}

export function updateTitleRtUrl(
  db: InstanceType<typeof Database>,
  titleId: number,
  url: string | null,
): void {
  db.prepare('UPDATE titles SET rt_url = ? WHERE id = ?').run(url, titleId);
}

export function updateTitleImdbId(
  db: InstanceType<typeof Database>,
  titleId: number,
  imdbId: string | null,
): void {
  db.prepare('UPDATE titles SET imdb_id = ? WHERE id = ?').run(imdbId, titleId);
}

/**
 * Save OMDb's answer and stamp rating_checked_at. OMDb lags its sources, so it
 * never replaces an IMDb rating the ratings file has confirmed (imdb_synced_at)
 * or a Rotten Tomatoes score read from the title's own page (rt_verified_at).
 */
export function updateTitleRatings(
  db: InstanceType<typeof Database>,
  titleId: number,
  ratings: { imdb: string | null; rt: string | null },
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE titles SET
      imdb_rating = CASE WHEN imdb_synced_at IS NULL THEN ? ELSE imdb_rating END,
      rt_rating   = CASE WHEN rt_verified_at IS NULL THEN ? ELSE rt_rating END,
      rating_checked_at = ?
    WHERE id = ?
  `).run(ratings.imdb, ratings.rt, now, titleId);
}

/** Store IMDb's genres (as OMDb lists them) for a title that has none yet. */
export function fillTitleImdbGenres(
  db: InstanceType<typeof Database>,
  titleId: number,
  genres: string[],
): void {
  db.prepare('UPDATE titles SET imdb_genres = ? WHERE id = ? AND imdb_genres IS NULL')
    .run(JSON.stringify(genres), titleId);
}

/**
 * Write what IMDb's ratings file says for each title, in one transaction:
 * rating as one-decimal text and its vote count, or both cleared when the file
 * does not list the title. Every row is stamped imdb_synced_at = `syncedAt`.
 */
export function applyImdbRatings(
  db: InstanceType<typeof Database>,
  rows: Array<{ id: number; rating: string | null; votes: number | null }>,
  syncedAt: number,
): void {
  const stmt = db.prepare('UPDATE titles SET imdb_rating = ?, imdb_votes = ?, imdb_synced_at = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) stmt.run(r.rating, r.votes, syncedAt, r.id);
  })();
}

/** Store IMDb's genres (JSON array) for each title, in one transaction. */
export function applyImdbGenres(
  db: InstanceType<typeof Database>,
  rows: Array<{ id: number; genres: string }>,
): void {
  const stmt = db.prepare('UPDATE titles SET imdb_genres = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) stmt.run(r.genres, r.id);
  })();
}

/** Record that TMDB was asked for a missing imdb_id, and the id when it had one. */
export function markTitleImdbIdChecked(
  db: InstanceType<typeof Database>,
  titleId: number,
  imdbId: string | null,
): void {
  db.prepare('UPDATE titles SET imdb_id = COALESCE(?, imdb_id), imdb_id_checked_at = ? WHERE id = ?')
    .run(imdbId, Math.floor(Date.now() / 1000), titleId);
}

/**
 * Save what the title's own Rotten Tomatoes page says: its URL (after any
 * redirect) and its critics score, or no score when the page shows none.
 * Stamps rt_verified_at and rt_checked_at.
 */
export function setTitleRtFromPage(
  db: InstanceType<typeof Database>,
  titleId: number,
  page: { url: string; score: string | null },
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE titles SET rt_url = ?, rt_rating = ?, rt_verified_at = ?, rt_checked_at = ? WHERE id = ?')
    .run(page.url, page.score, now, now, titleId);
}

/**
 * Record that no Rotten Tomatoes page could be confirmed as this title. A stored
 * page is dropped with its score, since it belongs to another title; a score
 * that came without a page (OMDb's) is kept.
 */
export function setTitleRtUnconfirmed(db: InstanceType<typeof Database>, titleId: number): void {
  db.prepare(`
    UPDATE titles SET
      rt_rating = CASE WHEN rt_url IS NULL THEN rt_rating ELSE NULL END,
      rt_url = NULL, rt_verified_at = NULL, rt_checked_at = ?
    WHERE id = ?
  `).run(Math.floor(Date.now() / 1000), titleId);
}

/**
 * Save a scraped Rotten Tomatoes score. Unlike updateTitleRatings this leaves
 * rating_checked_at alone: OMDb has not been asked about this title.
 */
export function updateTitleRtRating(
  db: InstanceType<typeof Database>,
  titleId: number,
  rt: string,
): void {
  db.prepare('UPDATE titles SET rt_rating = ? WHERE id = ?').run(rt, titleId);
}

/** Record a Rotten Tomatoes attempt, whatever it found, so it is not repeated soon. */
export function markTitleRtChecked(
  db: InstanceType<typeof Database>,
  titleId: number,
): void {
  db.prepare('UPDATE titles SET rt_checked_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), titleId);
}

/**
 * Backfill write for a single title's TMDB metadata (language, runtime, TMDB
 * rating, release status), plus a fresh popularity/vote_count snapshot when
 * available. Always stamps meta_checked_at so the row is not re-selected by
 * backfillTitleMeta on the next run. popularity/vote_count are only
 * overwritten when the caller actually has a value for them.
 */
export function updateTitleMeta(
  db: InstanceType<typeof Database>,
  id: number,
  meta: {
    original_language: string | null;
    runtime_minutes: number | null;
    vote_average: number | null;
    status: string | null;
    popularity?: number | null;
    vote_count?: number | null;
    meta_checked_at: number;
  },
): void {
  const hasPopularity = meta.popularity !== undefined;
  const hasVoteCount = meta.vote_count !== undefined;
  db.prepare(`
    UPDATE titles SET
      original_language = ?,
      runtime_minutes   = ?,
      vote_average      = ?,
      status            = ?,
      popularity        = CASE WHEN ? = 1 THEN ? ELSE popularity END,
      vote_count        = CASE WHEN ? = 1 THEN ? ELSE vote_count END,
      meta_checked_at   = ?
    WHERE id = ?
  `).run(
    meta.original_language,
    meta.runtime_minutes,
    meta.vote_average,
    meta.status,
    hasPopularity ? 1 : 0,
    hasPopularity ? meta.popularity : null,
    hasVoteCount ? 1 : 0,
    hasVoteCount ? meta.vote_count : null,
    meta.meta_checked_at,
    id,
  );
}

export function getTitleById(
  db: InstanceType<typeof Database>,
  id: number,
): TitleRow | null {
  return (db.prepare('SELECT * FROM titles WHERE id = ?').get(id) as TitleRow | undefined) ?? null;
}

/** TMDB numbers movies and series separately, so a title is its id plus its media type. */
export function getTitleByTmdbId(
  db: InstanceType<typeof Database>,
  tmdbId: number,
  mediaType: 'movie' | 'tv',
): TitleRow | null {
  return (
    (db.prepare('SELECT * FROM titles WHERE tmdb_id = ? AND media_type = ?').get(tmdbId, mediaType) as TitleRow | undefined) ??
    null
  );
}

/** Catalogue size for the header readout: total titles plus the movie/series split. */
export function countTitles(
  db: InstanceType<typeof Database>,
): { total: number; movie: number; tv: number } {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM titles').get() as { n: number }).n;
  const movie = (db.prepare("SELECT COUNT(*) AS n FROM titles WHERE media_type = 'movie'").get() as { n: number }).n;
  const tv = (db.prepare("SELECT COUNT(*) AS n FROM titles WHERE media_type = 'tv'").get() as { n: number }).n;
  return { total, movie, tv };
}

export function getUnwatchedTitles(
  db: InstanceType<typeof Database>,
  profileId: number,
  opts: { mediaType?: string; genreIds?: number[] },
): TitleRow[] {
  let query = `
    SELECT t.* FROM titles t
    WHERE t.id NOT IN (
      SELECT title_id FROM watch_events WHERE profile_id = ?
    )
  `;
  const params: unknown[] = [profileId];

  if (opts.mediaType) {
    query += ' AND t.media_type = ?';
    params.push(opts.mediaType);
  }

  return db.prepare(query).all(...params) as TitleRow[];
}
