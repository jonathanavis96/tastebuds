import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { config as dotenvConfig } from 'dotenv';
import { openDb } from './db/open.js';
import { runMigrations } from './db/migrate.js';
import { createApiRoutes } from './api/routes.js';
import { startHarvestCron } from './harvest/cron.js';
import { backfillTitleMeta } from './harvest/backfillMeta.js';
import { loadConfig, META_BACKFILL_CAP_DEFAULT } from './config.js';

dotenvConfig();
const config = loadConfig();
const db = openDb(config.dbPath);
runMigrations(db);
startHarvestCron(db, config);

// One-off startup kick: fills TMDB meta for any titles that have never had it
// (meta_checked_at IS NULL) — e.g. a freshly deployed container whose DB was
// seeded before these columns existed. Runs in the background; the nightly
// cron job covers ongoing top-ups after this.
void (async () => {
  try {
    const cap = config.metaBackfillCap ?? META_BACKFILL_CAP_DEFAULT;
    const result = await backfillTitleMeta(db, config, { cap });
    console.log('[tastebuds] Startup meta backfill complete:', result);
  } catch (err) {
    console.error('[tastebuds] Startup meta backfill failed:', err);
  }
})();

const app = new Hono();
app.route('/api', createApiRoutes(db, config));
app.use('/*', serveStatic({ root: './dist/frontend' }));
app.get('*', serveStatic({ path: './dist/frontend/index.html' }));

const bindHost = config.bindHost ?? '0.0.0.0';
serve({ fetch: app.fetch, port: config.port, hostname: bindHost }, (info) => {
  console.log(`TasteBuds running on http://${bindHost}:${info.port}`);
});
