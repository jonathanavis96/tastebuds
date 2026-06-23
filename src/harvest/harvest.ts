import type Database from 'better-sqlite3';
import { loadConfig, type Config } from '../config.js';
import { openDb } from '../db/open.js';
import { config as dotenvConfig } from 'dotenv';
import { getAllProfiles } from '../db/repos/profiles.js';
import { getTasteSignature } from '../db/repos/tasteSignatures.js';
import { getWatchEvents } from '../db/repos/watchEvents.js';
import { upsertTitle, getTitleByTmdbId } from '../db/repos/titles.js';
import { discoverTitles, getTrendingTitles, getTitleDetails } from '../tmdb/client.js';
import { mapTmdbToTitleRow } from '../tmdb/mappers.js';
import { embedText } from '../ollama/embed.js';
import type { TmdbTitle } from '../tmdb/types.js';

export interface HarvestResult {
  titlesAdded: number;
  titlesUpdated: number;
  errors: string[];
}

// TMDB genre name → ID map
const MOVIE_GENRE_MAP: Record<string, number> = {
  Action: 28,
  Adventure: 12,
  Animation: 16,
  Comedy: 35,
  Crime: 80,
  Drama: 18,
  Fantasy: 14,
  Horror: 27,
  Mystery: 9648,
  Romance: 10749,
  'Science Fiction': 878,
  Thriller: 53,
  Documentary: 99,
  Family: 10751,
};

const TV_GENRE_MAP: Record<string, number> = {
  'Action & Adventure': 10759,
  Animation: 16,
  Comedy: 35,
  Crime: 80,
  Drama: 18,
  Fantasy: 10765,
  Kids: 10762,
  Mystery: 9648,
  Reality: 10764,
  'Sci-Fi & Fantasy': 10765,
  Thriller: 53,
  Documentary: 99,
};

function genreNamesToIds(names: string[], mediaType: 'movie' | 'tv'): number[] {
  const map = mediaType === 'movie' ? MOVIE_GENRE_MAP : TV_GENRE_MAP;
  return names
    .map((name) => map[name])
    .filter((id): id is number => id !== undefined);
}

export async function runHarvest(
  db: InstanceType<typeof Database>,
  config: Config,
): Promise<HarvestResult> {
  const result: HarvestResult = { titlesAdded: 0, titlesUpdated: 0, errors: [] };

  const nonDerivedProfiles = getAllProfiles(db).filter((p) => !p.is_derived);

  // Collect unique tmdb_id+media_type pairs to harvest
  const toHarvest = new Map<string, { tmdbId: number; mediaType: 'movie' | 'tv' }>();

  for (const profile of nonDerivedProfiles) {
    const sig = getTasteSignature(db, profile.id);
    const prefs = sig ? (JSON.parse(sig.prefs) as { loved_genres?: string[] }) : {};
    const lovedGenres = prefs.loved_genres ?? [];

    const movieGenreIds = genreNamesToIds(lovedGenres, 'movie');
    const tvGenreIds = genreNamesToIds(lovedGenres, 'tv');

    // Discover + trending, collect into dedup map
    const fetches: Array<Promise<TmdbTitle[]>> = [
      discoverTitles({ mediaType: 'movie', genreIds: movieGenreIds }, config).catch((err) => {
        result.errors.push(`TMDB discover movie failed: ${String(err)}`);
        return [];
      }),
      discoverTitles({ mediaType: 'tv', genreIds: tvGenreIds }, config).catch((err) => {
        result.errors.push(`TMDB discover tv failed: ${String(err)}`);
        return [];
      }),
      getTrendingTitles('movie', config).catch((err) => {
        result.errors.push(`TMDB trending movie failed: ${String(err)}`);
        return [];
      }),
      getTrendingTitles('tv', config).catch((err) => {
        result.errors.push(`TMDB trending tv failed: ${String(err)}`);
        return [];
      }),
    ];

    const [movieDiscover, tvDiscover, trendingMovies, trendingTv] = await Promise.all(fetches);

    const allMovies = [...movieDiscover, ...trendingMovies];
    const allTv = [...tvDiscover, ...trendingTv];

    for (const t of allMovies) {
      const key = `${t.id}:movie`;
      if (!toHarvest.has(key)) toHarvest.set(key, { tmdbId: t.id, mediaType: 'movie' });
    }
    for (const t of allTv) {
      const key = `${t.id}:tv`;
      if (!toHarvest.has(key)) toHarvest.set(key, { tmdbId: t.id, mediaType: 'tv' });
    }
  }

  // Build per-profile sets of watched tmdb_ids (regardless of media_type).
  // If a tmdb_id appears in any watch_event for a profile, skip ALL media_type
  // variants — in practice TMDB IDs don't overlap between movies and TV, so this
  // is safe and makes the skip logic clean.
  const watchedTmdbIds = new Map<number, Set<number>>();
  for (const profile of nonDerivedProfiles) {
    const events = getWatchEvents(db, profile.id);
    const profileWatched = new Set<number>();
    for (const ev of events) {
      const titleRow = db
        .prepare('SELECT tmdb_id FROM titles WHERE id = ?')
        .get(ev.title_id) as { tmdb_id: number } | undefined;
      if (titleRow) {
        profileWatched.add(titleRow.tmdb_id);
      }
    }
    watchedTmdbIds.set(profile.id, profileWatched);
  }

  for (const [, { tmdbId, mediaType }] of toHarvest.entries()) {
    // Skip if ALL non-derived profiles have this tmdb_id in their watch_events
    const allWatched =
      nonDerivedProfiles.length > 0 &&
      nonDerivedProfiles.every((p) => watchedTmdbIds.get(p.id)?.has(tmdbId));
    if (allWatched) {
      continue;
    }

    try {
      const detail = await getTitleDetails(tmdbId, mediaType, config);
      const mapped = mapTmdbToTitleRow(detail, mediaType);

      const embedInput = `${mapped.title} ${mapped.synopsis ?? ''}`.slice(0, 500);
      let embedding: Buffer | null = null;

      try {
        const vec = await embedText(embedInput, config);
        // Serialize as little-endian Float32 buffer — sqlite-vec convention
        embedding = Buffer.from(new Float32Array(vec).buffer);
      } catch (embedErr) {
        result.errors.push(`embed failed for ${mapped.title}: ${String(embedErr)}`);
      }

      const existing = getTitleByTmdbId(db, tmdbId);
      upsertTitle(db, { ...mapped, embedding });

      if (existing) {
        result.titlesUpdated++;
      } else {
        result.titlesAdded++;
      }
    } catch (err) {
      result.errors.push(`Failed to process tmdb_id=${tmdbId} (${mediaType}): ${String(err)}`);
    }
  }

  return result;
}

// CLI entry point: `node dist/server/harvest/harvest.js` (also used by the cron)
if (process.argv[1]?.endsWith('harvest.ts') || process.argv[1]?.endsWith('harvest.js')) {
  dotenvConfig();
  const config = loadConfig();
  const db = openDb(config.dbPath);
  runHarvest(db, config).then((result) => {
    console.log(
      `Harvest complete: added ${result.titlesAdded}, updated ${result.titlesUpdated}, errors ${result.errors.length}`,
    );
    if (result.errors.length) console.log(result.errors.slice(0, 5));
  });
}
