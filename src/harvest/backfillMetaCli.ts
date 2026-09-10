/**
 * CLI entry point for `npm run backfill:meta`. Fills TMDB metadata
 * (original_language, runtime_minutes, vote_average, status) for catalogue
 * titles that have never had it fetched — useful for a one-off manual sweep
 * of the whole ~17.8k pre-existing catalogue outside the nightly cron/startup
 * kick.
 */
import { config as dotenvConfig } from 'dotenv';
import { loadConfig, META_BACKFILL_CAP_DEFAULT } from '../config.js';
import { openDb } from '../db/open.js';
import { backfillTitleMeta } from './backfillMeta.js';

dotenvConfig();
const config = loadConfig();
const db = openDb(config.dbPath);
const cap = config.metaBackfillCap ?? META_BACKFILL_CAP_DEFAULT;

backfillTitleMeta(db, config, { cap }).then((result) => {
  console.log(
    `Meta backfill complete: processed ${result.processed}, missing ${result.missing}, errors ${result.errors}`,
  );
  process.exit(0);
});
