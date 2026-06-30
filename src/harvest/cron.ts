import cron from 'node-cron';
import type Database from 'better-sqlite3';
import { type Config, HARVEST_CRON_DEFAULT, RATINGS_BACKFILL_CAP_DEFAULT } from '../config.js';
import { runHarvest } from './harvest.js';
import { backfillRatings } from './backfillRatings.js';

/**
 * Register the daily harvest cron on the running server's db/config.
 *
 * MUST be called from server.ts at boot. Previously this module registered the
 * schedule at import time but was never imported by the server entrypoint, so
 * node-cron never ran and the nightly harvest never fired (api_usage.harvest_added
 * stayed 0 forever; the catalogue only grew via seed import + on-demand requests).
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
    try {
      const result = await runHarvest(db, config);
      console.log('[tastebuds] Harvest complete:', result);
    } catch (err) {
      console.error('[tastebuds] Harvest failed:', err);
    }

    try {
      const dailyCap = config.ratingsBackfillCap ?? RATINGS_BACKFILL_CAP_DEFAULT;
      const backfillResult = await backfillRatings(db, config, { dailyCap });
      console.log('[tastebuds] Ratings backfill complete:', backfillResult);
    } catch (err) {
      console.error('[tastebuds] Ratings backfill failed:', err);
    }
  });

  console.log(`[tastebuds] Harvest cron scheduled for '${schedule}' (UTC)`);
}
