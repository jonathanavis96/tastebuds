import type Database from 'better-sqlite3';
import { loadConfig, type Config } from '../config.js';
import { openDb } from '../db/open.js';
import { config as dotenvConfig } from 'dotenv';
import { getAllProfiles } from '../db/repos/profiles.js';
import { getTasteSignature } from '../db/repos/tasteSignatures.js';
import { getWatchEvents } from '../db/repos/watchEvents.js';
import { upsertTitle, getTitleByTmdbId } from '../db/repos/titles.js';
import { getUsage, bumpHarvestAdded, today } from '../db/repos/apiUsage.js';
import { claimPage } from '../db/repos/harvestCursor.js';
import { discoverTitles, getTrendingTitles, getTitleDetails, searchKeyword } from '../tmdb/client.js';
import { mapTmdbToTitleRow } from '../tmdb/mappers.js';
import { embedText } from '../ollama/embed.js';
import {
  MOVIE_GENRE_MAP,
  TV_GENRE_MAP,
  resolveGenreNames,
} from '../tmdb/taxonomy.js';
import { resolveKeywordId } from './onDemand.js';
import type { TmdbTitle } from '../tmdb/types.js';

export interface HarvestResult {
  titlesAdded: number;
  titlesUpdated: number;
  errors: string[];
}

/**
 * Resolve loved genre names to TMDB genre ids for movies.
 * Movies have a full genre taxonomy including Horror (27) and Thriller (53),
 * so a direct id lookup is all that's needed.
 */
function movieGenreNamesToIds(names: string[]): number[] {
  return names
    .map((name) => MOVIE_GENRE_MAP[name])
    .filter((id): id is number => id !== undefined);
}

/**
 * Day-of-year (1-based) for the current UTC date. Used to rotate the broad
 * discovery page so each daily run pulls a different page of popular titles
 * rather than always fetching page 1.
 */
function dayOfYear(): number {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 0));
  const diff = now.getTime() - start.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export async function runHarvest(
  db: InstanceType<typeof Database>,
  config: Config,
): Promise<HarvestResult> {
  const result: HarvestResult = { titlesAdded: 0, titlesUpdated: 0, errors: [] };

  // ── Budget gate ───────────────────────────────────────────────────────────
  // Respect the configured daily target: don't re-ingest more titles than the
  // budget allows. We read the counter up front and stop adding once exhausted.
  const runDay = today();
  const usageAtStart = getUsage(db, runDay);
  let remaining = Math.max(0, config.harvestDailyTarget - usageAtStart.harvest_added);

  if (remaining === 0) {
    return result; // already hit today's budget
  }

  const nonDerivedProfiles = getAllProfiles(db).filter((p) => !p.is_derived);

  // Collect unique tmdb_id+media_type pairs to harvest
  const toHarvest = new Map<string, { tmdbId: number; mediaType: 'movie' | 'tv' }>();

  // ── Trending (profile-independent — fetch ONCE, not per profile) ──────────
  // Trending returns the same list regardless of profile, so fetching it inside
  // the per-profile loop just duplicated calls. It stays on page 1 (no cursor)
  // because trending is inherently volatile/shallow — page 1 IS the signal.
  const [trendingMovies, trendingTv] = await Promise.all([
    getTrendingTitles('movie', config).catch((err) => {
      result.errors.push(`TMDB trending movie failed: ${String(err)}`);
      return [] as TmdbTitle[];
    }),
    getTrendingTitles('tv', config).catch((err) => {
      result.errors.push(`TMDB trending tv failed: ${String(err)}`);
      return [] as TmdbTitle[];
    }),
  ]);
  for (const t of trendingMovies) {
    const key = `${t.id}:movie`;
    if (!toHarvest.has(key)) toHarvest.set(key, { tmdbId: t.id, mediaType: 'movie' });
  }
  for (const t of trendingTv) {
    const key = `${t.id}:tv`;
    if (!toHarvest.has(key)) toHarvest.set(key, { tmdbId: t.id, mediaType: 'tv' });
  }

  // ── Per-profile loved-genre discovery ─────────────────────────────────────
  for (const profile of nonDerivedProfiles) {
    const sig = getTasteSignature(db, profile.id);
    const prefs = sig ? (JSON.parse(sig.prefs) as { loved_genres?: string[] }) : {};
    const lovedGenres = prefs.loved_genres ?? [];

    // Movies: full genre taxonomy — Horror (27), Thriller (53), etc. all resolve to ids.
    const movieGenreIds = movieGenreNamesToIds(lovedGenres);

    // TV: use resolveGenreNames so Horror/Thriller (absent from TMDB's TV genre list)
    // are surfaced as keywordTerms rather than being silently dropped. Genre-id titles
    // (Drama, Comedy, …) go through the standard discover path; keyword-only genres
    // (Horror, Thriller for TV) go through keyword discovery below.
    const { genreIds: tvGenreIds, keywordTerms: tvKeywordTerms } = resolveGenreNames(lovedGenres, 'tv');

    // Loved-genre discovery, paged via the cursor so each run sweeps deeper.
    // Bucket key is the sorted genre-id signature so a profile's recurring query
    // keeps its own page position (independent of other profiles/buckets).
    const movieBucket = `movie:loved:${[...movieGenreIds].sort((a, b) => a - b).join(',') || 'none'}`;
    const tvBucket = `tv:loved:${[...tvGenreIds].sort((a, b) => a - b).join(',') || 'none'}`;

    const fetches: Array<Promise<TmdbTitle[]>> = [
      discoverTitles(
        { mediaType: 'movie', genreIds: movieGenreIds, page: claimPage(db, movieBucket, config.harvestMaxPage) },
        config,
      ).catch((err) => {
        result.errors.push(`TMDB discover movie failed: ${String(err)}`);
        return [];
      }),
      discoverTitles(
        { mediaType: 'tv', genreIds: tvGenreIds, page: claimPage(db, tvBucket, config.harvestMaxPage) },
        config,
      ).catch((err) => {
        result.errors.push(`TMDB discover tv failed: ${String(err)}`);
        return [];
      }),
    ];

    const [movieDiscover, tvDiscover] = await Promise.all(fetches);

    const allMovies = [...movieDiscover];
    const allTv = [...tvDiscover];

    for (const t of allMovies) {
      const key = `${t.id}:movie`;
      if (!toHarvest.has(key)) toHarvest.set(key, { tmdbId: t.id, mediaType: 'movie' });
    }
    for (const t of allTv) {
      const key = `${t.id}:tv`;
      if (!toHarvest.has(key)) toHarvest.set(key, { tmdbId: t.id, mediaType: 'tv' });
    }

    // ── TV keyword discovery for loved genres absent from TMDB's TV genre list ──
    // Horror and Thriller don't exist as TV genre ids — they must be discovered via
    // keyword search (e.g. "horror" → keyword id 315058). One discover call per
    // keyword term per profile. Shares the in-process keyword id cache with the
    // on-demand module so a single nightly harvest + a same-day request don't
    // double-spend on identical searchKeyword calls.
    for (const term of tvKeywordTerms) {
      try {
        const kwId = await resolveKeywordId(term, config, { searchKeyword });
        if (kwId == null) {
          result.errors.push(`TV keyword harvest: could not resolve keyword id for "${term}"`);
          continue;
        }
        const kwTitles = await discoverTitles(
          {
            mediaType: 'tv',
            keywordIds: [kwId],
            sortBy: 'vote_count.desc',
            voteCountGte: 50,
            page: claimPage(db, `tv:kw:${kwId}`, config.harvestMaxPage),
          },
          config,
        );
        for (const t of kwTitles) {
          const key = `${t.id}:tv`;
          if (!toHarvest.has(key)) toHarvest.set(key, { tmdbId: t.id, mediaType: 'tv' });
        }
      } catch (err) {
        result.errors.push(`TV keyword harvest for "${term}" failed: ${String(err)}`);
      }
    }
  }

  // ── Broad discovery slice (independent of loved_genres) ──────────────────
  // Ensures the DB grows across all genres every day, not just what the profiles
  // love. Rotates by day-of-year so each daily run fetches a different page of
  // the most-voted titles — capped to TMDB's page range 1..500.
  // All movie genres + all TV genres for round-robin broad coverage
  const allMovieGenreIds = Object.values(MOVIE_GENRE_MAP);
  const allTvGenreIds = [...new Set(Object.values(TV_GENRE_MAP))];

  // dayOfYear still selects WHICH genre gets a dedicated slice today; the PAGE
  // for every broad query now comes from that bucket's own cursor, so each
  // recurring slice sweeps deeper instead of re-listing page 1.
  const rrMovieGenre = allMovieGenreIds[dayOfYear() % allMovieGenreIds.length];
  const rrTvGenre = allTvGenreIds[dayOfYear() % allTvGenreIds.length];

  const broadFetches: Array<Promise<TmdbTitle[]>> = [
    // Global most-voted movies (no genre filter) — two consecutive cursor pages
    discoverTitles(
      { mediaType: 'movie', sortBy: 'vote_count.desc', voteCountGte: 300, page: claimPage(db, 'movie:broad', config.harvestMaxPage) },
      config,
    ).catch(() => []),
    // Global most-voted TV series
    discoverTitles(
      { mediaType: 'tv', sortBy: 'vote_count.desc', voteCountGte: 100, page: claimPage(db, 'tv:broad', config.harvestMaxPage) },
      config,
    ).catch(() => []),
    // Second consecutive page of each broad bucket for variety
    discoverTitles(
      { mediaType: 'movie', sortBy: 'vote_count.desc', voteCountGte: 300, page: claimPage(db, 'movie:broad', config.harvestMaxPage) },
      config,
    ).catch(() => []),
    discoverTitles(
      { mediaType: 'tv', sortBy: 'vote_count.desc', voteCountGte: 100, page: claimPage(db, 'tv:broad', config.harvestMaxPage) },
      config,
    ).catch(() => []),
    // Round-robin one movie genre for genre diversity (page from its own cursor)
    discoverTitles(
      {
        mediaType: 'movie',
        genreIds: [rrMovieGenre],
        sortBy: 'popularity.desc',
        page: claimPage(db, `movie:genre:${rrMovieGenre}`, config.harvestMaxPage),
      },
      config,
    ).catch(() => []),
    // Round-robin one TV genre for genre diversity (page from its own cursor)
    discoverTitles(
      {
        mediaType: 'tv',
        genreIds: [rrTvGenre],
        sortBy: 'popularity.desc',
        page: claimPage(db, `tv:genre:${rrTvGenre}`, config.harvestMaxPage),
      },
      config,
    ).catch(() => []),
  ];

  const broadResults = await Promise.all(broadFetches);
  for (let i = 0; i < broadResults.length; i++) {
    const mediaType: 'movie' | 'tv' = i % 2 === 0 ? 'movie' : 'tv';
    for (const t of broadResults[i]) {
      const key = `${t.id}:${mediaType}`;
      if (!toHarvest.has(key)) toHarvest.set(key, { tmdbId: t.id, mediaType });
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
    // Budget exhausted — stop ingesting
    if (remaining <= 0) break;

    // Skip if ALL non-derived profiles have this tmdb_id in their watch_events
    const allWatched =
      nonDerivedProfiles.length > 0 &&
      nonDerivedProfiles.every((p) => watchedTmdbIds.get(p.id)?.has(tmdbId));
    if (allWatched) {
      continue;
    }

    // Skip titles already in the DB — avoids re-fetching details for known titles
    // and focuses the budget on growing the DB with genuinely new content.
    const alreadyPresent = getTitleByTmdbId(db, tmdbId);
    if (alreadyPresent) {
      // We no longer update existing titles during harvest — budget is for growth.
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

      upsertTitle(db, { ...mapped, embedding });
      result.titlesAdded++;
      remaining--;
    } catch (err) {
      result.errors.push(`Failed to process tmdb_id=${tmdbId} (${mediaType}): ${String(err)}`);
    }
  }

  // Persist today's addition count so subsequent runs and /generate calls can
  // check the budget without re-counting rows.
  if (result.titlesAdded > 0) {
    bumpHarvestAdded(db, runDay, result.titlesAdded);
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
