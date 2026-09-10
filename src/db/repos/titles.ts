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
  'original_language',
  'runtime_minutes',
  'vote_average',
  'status',
  'meta_checked_at',
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

export function updateTitleRatings(
  db: InstanceType<typeof Database>,
  titleId: number,
  ratings: { imdb: string | null; rt: string | null },
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE titles SET imdb_rating = ?, rt_rating = ?, rating_checked_at = ? WHERE id = ?
  `).run(ratings.imdb, ratings.rt, now, titleId);
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

export function getTitleByTmdbId(
  db: InstanceType<typeof Database>,
  tmdbId: number,
): TitleRow | null {
  return (
    (db.prepare('SELECT * FROM titles WHERE tmdb_id = ?').get(tmdbId) as TitleRow | undefined) ??
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
