import cron from 'node-cron';
import type Database from 'better-sqlite3';
import {
  type Config,
  HARVEST_CRON_DEFAULT,
  RATINGS_BACKFILL_CAP_DEFAULT,
  META_BACKFILL_CAP_DEFAULT,
  RT_REFRESH_CAP_DEFAULT,
} from '../config.js';
import { runHarvest } from './harvest.js';
import { backfillRatings } from './backfillRatings.js';
import { backfillTitleMeta } from './backfillMeta.js';
import { fillMissingImdbIds, IMDB_ID_FILL_CAP_DEFAULT } from '../imdb/fillIds.js';
import { syncImdbGenres, syncImdbRatings } from '../imdb/dataset.js';
import { refreshRtScores } from '../rt/refresh.js';

/** Run one nightly step and log its result; a failing step never stops the next one. */
async function runStep(label: string, step: () => Promise<unknown>): Promise<void> {
  try {
    console.log(`[tastebuds] ${label} complete:`, await step());
  } catch (err) {
    console.error(`[tastebuds] ${label} failed:`, err);
  }
}

/**
 * The nightly run, in order: harvest new titles, find missing imdb_ids, make
 * IMDb ratings match IMDb's ratings file, ask OMDb about titles it has never
 * seen (Rotten Tomatoes for films), re-read Rotten Tomatoes pages, then TMDB
 * metadata. IMDb genres are re-read on the 1st of each month (a 230 MB file).
 */
export async function runNightly(
  db: InstanceType<typeof Database>,
  config: Config,
  today: Date = new Date(),
): Promise<void> {
  await runStep('Harvest', () => runHarvest(db, config));
  await runStep('IMDb id fill', () => fillMissingImdbIds(db, config, { cap: IMDB_ID_FILL_CAP_DEFAULT }));
  await runStep('IMDb ratings sync', () => syncImdbRatings(db, config));
  if (today.getUTCDate() === 1) await runStep('IMDb genres sync', () => syncImdbGenres(db));
  await runStep('Ratings backfill', () =>
    backfillRatings(db, config, { dailyCap: config.ratingsBackfillCap ?? RATINGS_BACKFILL_CAP_DEFAULT }),
  );
  await runStep('Rotten Tomatoes refresh', () =>
    refreshRtScores(db, { cap: config.rtRefreshCap ?? RT_REFRESH_CAP_DEFAULT }),
  );
  await runStep('Meta backfill', () =>
    backfillTitleMeta(db, config, { cap: config.metaBackfillCap ?? META_BACKFILL_CAP_DEFAULT }),
  );
}

/**
 * Register the daily harvest cron on the running server's db/config.
 *
 * MUST be called from server.ts at boot: a schedule registered at import time
 * in a module the server never imports never runs.
 *
 * Schedule is configurable via HARVEST_CRON (container TZ = UTC); defaults to
 * '0 3 * * *' (03:00 UTC ≈ 05:00 SAST). Shares the server's db handle/config so
 * it doesn't open a second connection.
 */
export function startHarvestCron(
  db: InstanceType<typeof Database>,
  config: Config,
): void {
  const schedule = config.harvestCron ?? HARVEST_CRON_DEFAULT;
  cron.schedule(schedule, async () => {
    console.log('[tastebuds] Starting daily harvest at', new Date().toISOString());
    await runNightly(db, config);
  });

  console.log(`[tastebuds] Harvest cron scheduled for '${schedule}' (UTC)`);
}
