import type { TitleRow } from '../db/types.js';
import type { TmdbTitleDetail } from './types.js';

export function mapTmdbToTitleRow(
  detail: TmdbTitleDetail,
  mediaType: 'movie' | 'tv',
): Omit<TitleRow, 'id' | 'embedding'> {
  const rawYear =
    mediaType === 'movie'
      ? (detail.release_date ?? '').slice(0, 4)
      : (detail.first_air_date ?? '').slice(0, 4);

  const year = parseInt(rawYear, 10) || null;

  const genreNames = (detail.genres ?? []).map((g) => g.name);

  const keywordList = [
    ...(detail.keywords?.keywords ?? []),
    ...(detail.keywords?.results ?? []),
  ].map((k) => k.name);

  const castList = (detail.credits?.cast ?? []).slice(0, 5).map((c) => c.name);

  const imdb_id = detail.external_ids?.imdb_id ?? detail.imdb_id ?? null;

  return {
    tmdb_id: detail.id,
    media_type: mediaType,
    title: detail.title ?? detail.name ?? '',
    year,
    genres: JSON.stringify(genreNames),
    keywords: JSON.stringify(keywordList),
    cast: JSON.stringify(castList),
    synopsis: detail.overview || null,
    poster_path: detail.poster_path,
    updated_at: new Date().toISOString(),
    imdb_id,
    imdb_rating: null,
    rt_rating: null,
    rt_url: null,
    popularity: detail.popularity ?? null,
    vote_count: detail.vote_count ?? null,
    rating_checked_at: null,
  };
}
