import type Database from 'better-sqlite3';
import type { TitleRow } from '../types.js';

export function upsertTitle(
  db: InstanceType<typeof Database>,
  title: Omit<TitleRow, 'id'> | (Omit<TitleRow, 'id' | 'imdb_id' | 'imdb_rating' | 'rt_rating' | 'rt_url' | 'popularity' | 'vote_count'> & Partial<Pick<TitleRow, 'imdb_id' | 'imdb_rating' | 'rt_rating' | 'rt_url' | 'popularity' | 'vote_count'>>),
): void {
  db.prepare(`
    INSERT INTO titles (tmdb_id, media_type, title, year, genres, keywords, cast, synopsis, poster_path, embedding, updated_at, imdb_id, imdb_rating, rt_rating, popularity, vote_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      vote_count  = excluded.vote_count
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
  db.prepare(`
    UPDATE titles SET imdb_rating = ?, rt_rating = ? WHERE id = ?
  `).run(ratings.imdb, ratings.rt, titleId);
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
