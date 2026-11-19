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

  it('counts a bundle as both halves when IMDb is unknown or names neither', () => {
    expect(tags({ media_type: 'tv', genres: '["Sci-Fi & Fantasy"]' })).toEqual(['Fantasy', 'Science Fiction']);
    expect(tags({ media_type: 'tv', genres: '["Action & Adventure"]', imdb_genres: '["Crime"]' }))
      .toEqual(['Action', 'Adventure', 'Crime']);
  });

  it('reads a series keyword that names a genre', () => {
    expect(tags({ media_type: 'tv', keywords: '["psychological thriller","supernatural horror","small town"]' }))
      .toEqual(['Horror', 'Thriller']);
    expect(tags({ media_type: 'tv', keywords: '["suspense","sitcom","romcom","science fiction"]' }))
      .toEqual(['Comedy', 'Romance', 'Science Fiction', 'Thriller']);
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
