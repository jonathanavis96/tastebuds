import { describe, it, expect } from 'vitest';
import { titleTags } from './tags.js';
import type { TaggableTitle } from './tags.js';

function title(over: Partial<TaggableTitle>): TaggableTitle {
  return { media_type: 'movie', genres: '[]', keywords: '[]', imdb_genres: null, ...over };
}

function tags(over: Partial<TaggableTitle>): string[] {
  return [...titleTags(title(over))].sort();
}

describe('titleTags', () => {
  it('maps TMDB film genres to themselves', () => {
    expect(tags({ genres: '["Thriller","Science Fiction"]' })).toEqual(['Science Fiction', 'Thriller']);
  });

  it('adds IMDb genres under their canonical names', () => {
    expect(tags({ genres: '["Drama"]', imdb_genres: '["Sci-Fi","Thriller","Reality-TV","Musical"]' }))
      .toEqual(['Drama', 'Music', 'Reality', 'Science Fiction', 'Thriller']);
  });

  it('splits a TMDB TV bundle by the IMDb genres when known', () => {
    expect(tags({ media_type: 'tv', genres: '["Sci-Fi & Fantasy"]', imdb_genres: '["Sci-Fi","Drama"]' }))
      .toEqual(['Drama', 'Science Fiction']);
    expect(tags({ media_type: 'tv', genres: '["Action & Adventure"]', imdb_genres: '["Adventure"]' }))
      .toEqual(['Adventure']);
  });

  it('counts a bundle as both halves when nothing says which', () => {
    expect(tags({ media_type: 'tv', genres: '["Sci-Fi & Fantasy"]' })).toEqual(['Fantasy', 'Science Fiction']);
    expect(tags({ media_type: 'tv', genres: '["Action & Adventure"]' })).toEqual(['Action', 'Adventure']);
    expect(tags({ media_type: 'tv', genres: '["Sci-Fi & Fantasy"]', imdb_genres: '["Drama"]', keywords: '["small town"]' }))
      .toEqual(['Drama', 'Fantasy', 'Science Fiction']);
  });

  it("splits Sci-Fi & Fantasy by what the series is about when IMDb's three genres name neither", () => {
    const bundle = { media_type: 'tv' as const, genres: '["Sci-Fi & Fantasy","Drama"]' };
    // IMDb lists three genres alphabetically, so "Sci-Fi" is often the one cut.
    expect(tags({ ...bundle, imdb_genres: '["Crime","Drama","Mystery"]', keywords: '["technology","dystopia","anthology"]' }))
      .toEqual(['Crime', 'Drama', 'Mystery', 'Science Fiction']);
    expect(tags({ ...bundle, imdb_genres: '["Action","Adventure","Drama"]', keywords: '["dragon","kingdom","based on novel or book"]' }))
      .toEqual(['Action', 'Adventure', 'Drama', 'Fantasy']);
    expect(tags({ ...bundle, imdb_genres: '["Drama","Horror","Thriller"]', keywords: '["post-apocalyptic future","undead"]' }))
      .toEqual(['Drama', 'Fantasy', 'Horror', 'Science Fiction', 'Thriller']);
  });

  it('needs a clear majority of pointers to put a series on one side', () => {
    const bundle = { media_type: 'tv' as const, genres: '["Sci-Fi & Fantasy"]', imdb_genres: '["Action","Adventure","Animation"]' };
    // Three sci-fi pointers against one fantasy pointer: science fiction.
    expect(tags({ ...bundle, keywords: '["space travel","alien","time travel","prophecy"]' }))
      .toEqual(['Action', 'Adventure', 'Animation', 'Science Fiction']);
    // One against four: fantasy.
    expect(tags({ ...bundle, keywords: '["teleportation","magic","reincarnation","sword and sorcery","isekai"]' }))
      .toEqual(['Action', 'Adventure', 'Animation', 'Fantasy']);
    // Two against two: both.
    expect(tags({ ...bundle, keywords: '["time travel","alien","magic","supernatural phenomena"]' }))
      .toEqual(['Action', 'Adventure', 'Animation', 'Fantasy', 'Science Fiction']);
    // A place name is not a pointer.
    expect(tags({ ...bundle, keywords: '["los angeles, california","nuclear war"]' }))
      .toEqual(['Action', 'Adventure', 'Animation', 'Science Fiction']);
  });

  it('looks for science fiction that IMDb may have cut after Fantasy', () => {
    const bundle = { media_type: 'tv' as const, genres: '["Sci-Fi & Fantasy"]' };
    // A full list of three ending before "Sci-Fi": the keywords decide.
    expect(tags({ ...bundle, imdb_genres: '["Drama","Fantasy","Horror"]', keywords: '["parallel world","telekinesis","monster"]' }))
      .toEqual(['Drama', 'Fantasy', 'Horror', 'Science Fiction']);
    expect(tags({ ...bundle, imdb_genres: '["Drama","Fantasy","Horror"]', keywords: '["magic","witch"]' }))
      .toEqual(['Drama', 'Fantasy', 'Horror']);
    // A list of two cut nothing: no science fiction, whatever the keywords say.
    expect(tags({ ...bundle, imdb_genres: '["Drama","Fantasy"]', keywords: '["parallel world","telekinesis"]' }))
      .toEqual(['Drama', 'Fantasy']);
  });

  it('reads War & Politics as War only with a second source', () => {
    const bundle = { media_type: 'tv' as const, genres: '["War & Politics","Drama"]' };
    expect(tags({ ...bundle, imdb_genres: '["Drama"]', keywords: '["white house","election"]' })).toEqual(['Drama']);
    expect(tags({ ...bundle, imdb_genres: '["Drama"]', keywords: '["world war ii"]' })).toEqual(['Drama', 'War']);
    expect(tags({ ...bundle, imdb_genres: '["Drama","History","War"]' })).toEqual(['Drama', 'History', 'War']);
  });

  it('takes Action & Adventure from IMDb alone when IMDb lists genres', () => {
    // "Action" and "Adventure" sort first, so IMDb's three never cut them.
    expect(tags({ media_type: 'tv', genres: '["Action & Adventure","Crime"]', imdb_genres: '["Crime","Drama","Mystery"]' }))
      .toEqual(['Crime', 'Drama', 'Mystery']);
  });

  it('reads a series keyword that names a genre', () => {
    expect(tags({ media_type: 'tv', keywords: '["psychological thriller","supernatural horror","small town"]' }))
      .toEqual(['Horror', 'Thriller']);
    expect(tags({ media_type: 'tv', keywords: '["suspense","romcom","science fiction","teen romance"]' }))
      .toEqual(['Comedy', 'Romance', 'Science Fiction', 'Thriller']);
  });

  it('leaves the genres TMDB tags for series itself to TMDB', () => {
    const drama = { media_type: 'tv' as const, genres: '["Drama","Crime"]' };
    expect(tags({ ...drama, keywords: '["dark comedy","legal drama","murder mystery","based on anime","neo western"]' }))
      .toEqual(['Crime', 'Drama']);
    // The last word says what it is: a horror comedy is a comedy, a comedy horror a horror.
    expect(tags({ ...drama, keywords: '["horror comedy"]' })).toEqual(['Crime', 'Drama']);
    expect(tags({ ...drama, keywords: '["comedy horror"]' })).toEqual(['Crime', 'Drama', 'Horror']);
  });

  it('never takes a genre from a film keyword', () => {
    expect(tags({ media_type: 'movie', genres: '["Comedy","Science Fiction"]', keywords: '["comedy horror","psychological thriller"]' }))
      .toEqual(['Comedy', 'Science Fiction']);
  });

  it('ignores keywords that merely mention a subject', () => {
    expect(tags({ media_type: 'tv', keywords: '["world war ii","dysfunctional family","crime boss","music band"]' })).toEqual([]);
  });

  it('never throws on malformed or missing JSON', () => {
    expect(tags({ genres: 'not json', keywords: '{"a":1}', imdb_genres: '[1, null, "Horror"]' })).toEqual(['Horror']);
    expect(tags({ genres: null as unknown as string, keywords: null as unknown as string })).toEqual([]);
  });
});
