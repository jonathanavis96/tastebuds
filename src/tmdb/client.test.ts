import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { discoverTitles, getTrendingTitles, getTitleDetails, searchTitles } from './client.js';
import { mapTmdbToTitleRow } from './mappers.js';
import type { TmdbTitleDetail } from './types.js';

const mockConfig = { tmdbApiKey: 'test-key' };

const mockMovie: TmdbTitleDetail = {
  id: 550,
  title: 'Fight Club',
  release_date: '1999-10-15',
  genre_ids: [18, 53],
  overview: 'An insomniac office worker forms an underground fight club.',
  poster_path: '/fight_club.jpg',
  genres: [{ id: 18, name: 'Drama' }, { id: 53, name: 'Thriller' }],
  keywords: { keywords: [{ name: 'fight' }, { name: 'identity' }] },
  credits: { cast: [{ name: 'Brad Pitt' }, { name: 'Edward Norton' }, { name: 'Helena Bonham Carter' }] },
};

const mockTvShow: TmdbTitleDetail = {
  id: 1396,
  name: 'Breaking Bad',
  first_air_date: '2008-01-20',
  genre_ids: [18, 80],
  overview: 'A chemistry teacher becomes a drug kingpin.',
  poster_path: '/breaking_bad.jpg',
  genres: [{ id: 18, name: 'Drama' }, { id: 80, name: 'Crime' }],
  keywords: { results: [{ name: 'drugs' }, { name: 'New Mexico' }] },
  credits: { cast: [{ name: 'Bryan Cranston' }, { name: 'Aaron Paul' }] },
};

describe('discoverTitles', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('returns results array for movie discovery', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ results: [mockMovie], total_pages: 1, page: 1 }),
        { status: 200 },
      ),
    );

    const results = await discoverTitles({ mediaType: 'movie', genreIds: [18] }, mockConfig);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(550);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('discover/movie'),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('api_key=test-key'),
    );
  });

  it('returns results for tv discovery', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [mockTvShow] }), { status: 200 }),
    );

    const results = await discoverTitles({ mediaType: 'tv' }, mockConfig);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(1396);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('discover/tv'));
  });

  it('throws on non-200 response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status_message: 'Invalid API key' }), { status: 401 }),
    );

    await expect(discoverTitles({ mediaType: 'movie' }, mockConfig)).rejects.toThrow('401');
  });
});

describe('getTrendingTitles', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('returns weekly trending movies', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [mockMovie] }), { status: 200 }),
    );

    const results = await getTrendingTitles('movie', mockConfig);
    expect(results).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('trending/movie/week'));
  });

  it('returns weekly trending tv', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [mockTvShow] }), { status: 200 }),
    );

    const results = await getTrendingTitles('tv', mockConfig);
    expect(results).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('trending/tv/week'));
  });
});

describe('getTitleDetails', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('fetches movie details with keywords and credits appended', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockMovie), { status: 200 }),
    );

    const detail = await getTitleDetails(550, 'movie', mockConfig);
    expect(detail.id).toBe(550);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('movie/550'),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('append_to_response=keywords,credits,external_ids'),
    );
  });
});

describe('searchTitles', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('searches movies and returns results array', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [mockMovie] }), { status: 200 }),
    );

    const results = await searchTitles('Fight Club', 'movie', mockConfig);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(550);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('search/movie'));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('query=Fight%20Club'));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('api_key=test-key'));
  });

  it('searches tv shows and returns results array', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [mockTvShow] }), { status: 200 }),
    );

    const results = await searchTitles('Breaking Bad', 'tv', mockConfig);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(1396);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('search/tv'));
  });

  it('includes year param as &year= for movies', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [mockMovie] }), { status: 200 }),
    );

    await searchTitles('Fight Club', 'movie', mockConfig, 1999);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('&year=1999'));
  });

  it('includes year param as &first_air_date_year= for tv', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [mockTvShow] }), { status: 200 }),
    );

    await searchTitles('Breaking Bad', 'tv', mockConfig, 2008);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('&first_air_date_year=2008'));
  });

  it('omits year param when year is not provided', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [mockMovie] }), { status: 200 }),
    );

    await searchTitles('Fight Club', 'movie', mockConfig);
    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('year=');
  });

  it('throws on non-200 response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status_message: 'Invalid API key' }), { status: 401 }),
    );

    await expect(searchTitles('Fight Club', 'movie', mockConfig)).rejects.toThrow('401');
  });
});

describe('mapTmdbToTitleRow', () => {
  it('maps movie fields correctly', () => {
    const row = mapTmdbToTitleRow(mockMovie, 'movie');
    expect(row.tmdb_id).toBe(550);
    expect(row.media_type).toBe('movie');
    expect(row.title).toBe('Fight Club');
    expect(row.year).toBe(1999);
    expect(JSON.parse(row.genres)).toEqual(['Drama', 'Thriller']);
    expect(JSON.parse(row.keywords)).toEqual(['fight', 'identity']);
    expect(JSON.parse(row.cast)).toEqual(['Brad Pitt', 'Edward Norton', 'Helena Bonham Carter']);
    expect(row.synopsis).toBe('An insomniac office worker forms an underground fight club.');
    expect(row.poster_path).toBe('/fight_club.jpg');
    expect((row as Record<string, unknown>).on_viu).toBeUndefined();
  });

  it('extracts imdb_id from external_ids (preferred over top-level)', () => {
    const withExternalIds: TmdbTitleDetail = {
      ...mockMovie,
      external_ids: { imdb_id: 'tt0137523' },
      imdb_id: 'tt_toplevel',
    };
    const row = mapTmdbToTitleRow(withExternalIds, 'movie');
    expect(row.imdb_id).toBe('tt0137523');
  });

  it('falls back to top-level imdb_id when external_ids missing', () => {
    const withTopLevel: TmdbTitleDetail = { ...mockMovie, imdb_id: 'tt0137523' };
    const row = mapTmdbToTitleRow(withTopLevel, 'movie');
    expect(row.imdb_id).toBe('tt0137523');
  });

  it('returns null imdb_id when neither field is present', () => {
    const row = mapTmdbToTitleRow(mockMovie, 'movie');
    expect(row.imdb_id).toBeNull();
  });

  it('maps tv fields correctly — uses name and first_air_date', () => {
    const row = mapTmdbToTitleRow(mockTvShow, 'tv');
    expect(row.tmdb_id).toBe(1396);
    expect(row.media_type).toBe('tv');
    expect(row.title).toBe('Breaking Bad');
    expect(row.year).toBe(2008);
    expect(JSON.parse(row.genres)).toEqual(['Drama', 'Crime']);
    expect(JSON.parse(row.keywords)).toEqual(['drugs', 'New Mexico']);
  });

  it('handles missing keywords gracefully', () => {
    const noKeywords: TmdbTitleDetail = { ...mockMovie, keywords: undefined };
    const row = mapTmdbToTitleRow(noKeywords, 'movie');
    expect(JSON.parse(row.keywords)).toEqual([]);
  });

  it('truncates cast to 5 members', () => {
    const manyCast: TmdbTitleDetail = {
      ...mockMovie,
      credits: {
        cast: [
          { name: 'A' }, { name: 'B' }, { name: 'C' },
          { name: 'D' }, { name: 'E' }, { name: 'F' },
        ],
      },
    };
    const row = mapTmdbToTitleRow(manyCast, 'movie');
    expect(JSON.parse(row.cast)).toHaveLength(5);
  });
});
