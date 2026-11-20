/**
 * CLI entry point for `npm run backfill:meta`. Fills TMDB metadata
 * (original_language, runtime_minutes, vote_average, status) for catalogue
 * titles that have never had it fetched, and reads it again for recent titles
 * whose last read is a week old — the same job as the nightly cron and startup
 * kick, run by hand.
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
