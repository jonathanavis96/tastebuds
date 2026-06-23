export interface SeedItem {
  title: string;
  year?: number;
  mediaType: 'movie' | 'tv';
  rating?: number;
  status: 'watched' | 'watchlist' | 'rated';
  // Profile key — must match a seeded profile's name (case-insensitive).
  // The default seed creates "Alex", "Sam" and "Joint", so use alex|sam|joint.
  profile: string;
}

export function parseSeedJson(raw: unknown): SeedItem[] {
  if (!Array.isArray(raw)) throw new Error('Seed data must be a JSON array');
  return raw.map((item: unknown, i: number) => {
    if (typeof item !== 'object' || item === null) throw new Error(`Item ${i} is not an object`);
    const obj = item as Record<string, unknown>;
    if (typeof obj.title !== 'string') throw new Error(`Item ${i}: title must be a string`);
    if (!['movie', 'tv'].includes(obj.mediaType as string))
      throw new Error(`Item ${i}: mediaType must be 'movie' or 'tv'`);
    if (!['watched', 'watchlist', 'rated'].includes(obj.status as string))
      throw new Error(`Item ${i}: status must be watched|watchlist|rated`);
    if (typeof obj.profile !== 'string' || obj.profile.trim() === '')
      throw new Error(`Item ${i}: profile must be a non-empty string (a seeded profile name)`);
    return {
      title: obj.title,
      year: typeof obj.year === 'number' ? obj.year : undefined,
      mediaType: obj.mediaType as 'movie' | 'tv',
      rating: typeof obj.rating === 'number' ? obj.rating : undefined,
      status: obj.status as 'watched' | 'watchlist' | 'rated',
      profile: obj.profile,
    };
  });
}
