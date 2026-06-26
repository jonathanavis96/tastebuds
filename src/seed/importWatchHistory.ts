import { readFileSync } from 'node:fs';
import { openDb } from '../db/open.js';
import { runMigrations } from '../db/migrate.js';
import { upsertWatchEvent } from '../db/repos/watchEvents.js';
import { getAllProfiles } from '../db/repos/profiles.js';
import { upsertTitle, getTitleByTmdbId } from '../db/repos/titles.js';
import { refreshTasteVector } from '../retrieval/retrieve.js';
import { parseSeedJson, type SeedItem } from './parseSeedFile.js';
import { loadConfig } from '../config.js';
import { searchTitles, getTitleDetails } from '../tmdb/client.js';
import { mapTmdbToTitleRow } from '../tmdb/mappers.js';
import { embedText } from '../ollama/embed.js';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

export interface ImportResult {
  imported: number;
  skipped: number;
  notFound: string[];
  resolved: number;
}

/**
 * Seed ratings come from the source recommender on a 0–10 scale (e.g. 9.5, 8),
 * but the app stores ratings on a 0.5–5 star scale (half-stars allowed). Map by
 * halving to stars and snapping to the nearest half-star, clamped to 1–5:
 *   10 → 5,  9.5 → 5,  8 → 4,  7 → 3.5,  5 → 2.5,  2 → 1.
 */
export function toAppRating(seedRating: number): number {
  const stars = Math.round(seedRating) / 2; // nearest half-star
  return Math.min(5, Math.max(1, stars));
}

/**
 * Import seed items as watch_events, honouring Decision Override #2:
 *   - "joint" items → stored under the Joint profile's watch_events ONLY
 *     (so the joint watched list is accurate and those titles appear as
 *     already-seen in joint recommendations)
 *   - Solo taste signatures are built ONLY from their OWN rows;
 *     joint-rated titles are NEVER folded into either solo signature.
 *   - refreshTasteVector is called for the solo profiles only (not Joint,
 *     which is a live query-time blend).
 *
 * When a title is not found in the local DB by name, it is resolved via
 * TMDB search, ingested (with embedding), and then linked as a watch_event.
 */
export async function importFromSeedJson(
  db: ReturnType<typeof openDb>,
  config: ReturnType<typeof loadConfig>,
  seedData: SeedItem[],
): Promise<ImportResult> {
  const profiles = getAllProfiles(db);
  const profileMap = new Map(profiles.map(p => [p.name.toLowerCase(), p.id]));

  let imported = 0;
  let skipped = 0;
  let resolved = 0;
  const notFound: string[] = [];

  for (const item of seedData) {
    // Override #2: joint rows go into the Joint profile's watch_events (not folded into a solo profile)
    const lookupKey = item.profile.toLowerCase(); // matches a seeded profile name, case-insensitive
    const profileId = profileMap.get(lookupKey);
    if (!profileId) {
      skipped++;
      continue;
    }

    // Find the title in the local DB by normalised title + optional year + media_type
    let titleRow = (item.year
      ? (db.prepare(`
          SELECT * FROM titles
          WHERE LOWER(title) = LOWER(?)
            AND year = ?
            AND media_type = ?
          LIMIT 1
        `).get(item.title, item.year, item.mediaType) as { id: number } | undefined)
      : (db.prepare(`
          SELECT * FROM titles
          WHERE LOWER(title) = LOWER(?)
            AND media_type = ?
          LIMIT 1
        `).get(item.title, item.mediaType) as { id: number } | undefined));

    if (!titleRow) {
      // Attempt to resolve via TMDB search
      const searchResults = await searchTitles(item.title, item.mediaType, config, item.year);

      if (searchResults.length === 0) {
        notFound.push(`${item.title} (${item.year ?? '?'}) [${item.mediaType}]`);
        skipped++;
        continue;
      }

      // Pick the best match: prefer a result whose release/air year matches item.year (±1)
      let bestMatch = searchResults[0];
      if (item.year !== undefined) {
        const yearMatch = searchResults.find(r => {
          const rawDate = item.mediaType === 'movie' ? r.release_date : r.first_air_date;
          const resultYear = rawDate ? parseInt(rawDate.slice(0, 4), 10) : null;
          return resultYear !== null && Math.abs(resultYear - item.year!) <= 1;
        });
        if (yearMatch) bestMatch = yearMatch;
      }

      const tmdbId = bestMatch.id;
      const newlyIngested = !getTitleByTmdbId(db, tmdbId);

      if (newlyIngested) {
        // Fetch full detail, map, embed, and upsert
        const detail = await getTitleDetails(tmdbId, item.mediaType, config);
        const mapped = mapTmdbToTitleRow(detail, item.mediaType);

        const embedInput = `${mapped.title} ${mapped.synopsis ?? ''}`.slice(0, 500);
        let embedding: Buffer | null = null;

        try {
          const vec = await embedText(embedInput, config);
          embedding = Buffer.from(new Float32Array(vec).buffer);
        } catch {
          // Non-fatal: ingest title without embedding, don't abort the import
        }

        upsertTitle(db, { ...mapped, embedding });
        resolved++;
      }

      // Re-read the now-inserted (or pre-existing by tmdb_id) title row
      titleRow = getTitleByTmdbId(db, tmdbId) as { id: number } | undefined;

      if (!titleRow) {
        notFound.push(`${item.title} (${item.year ?? '?'}) [${item.mediaType}]`);
        skipped++;
        continue;
      }
    }

    const status = item.status === 'watchlist' ? 'watchlist' : 'watched';
    upsertWatchEvent(db, {
      profile_id: profileId,
      title_id: titleRow.id,
      status,
      rating: item.rating != null ? toAppRating(item.rating) : null,
      watched_at: status === 'watched' ? new Date().toISOString() : null,
    });
    imported++;
  }

  // Refresh taste vectors for the solo (non-derived) profiles only.
  // A derived/Joint profile's taste is a live query-time blend — no stored vector.
  for (const p of profiles) {
    if (!p.is_derived) await refreshTasteVector(db, p.id, config);
  }

  return { imported, skipped, notFound, resolved };
}

// CLI entry point
if (process.argv[1]?.endsWith('importWatchHistory.ts') || process.argv[1]?.endsWith('importWatchHistory.js')) {
  const seedFile = process.argv[2];
  if (!seedFile) {
    console.error('Usage: tsx src/seed/importWatchHistory.ts <seed-file.json>');
    process.exit(1);
  }
  const config = loadConfig();
  const db = openDb(config.dbPath);
  runMigrations(db);
  const raw = JSON.parse(readFileSync(seedFile, 'utf8')) as unknown;
  const seedData = parseSeedJson(raw);
  importFromSeedJson(db, config, seedData).then(result => {
    console.log(`Imported: ${result.imported}, Skipped: ${result.skipped}`);
    console.log(`Resolved (ingested via TMDB search): ${result.resolved}`);
    if (result.notFound.length) console.log('Not found in DB:', result.notFound);
  });
}
