import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { config as dotenvConfig } from 'dotenv';
import { openDb } from './db/open.js';
import { runMigrations } from './db/migrate.js';
import { createApiRoutes } from './api/routes.js';
import { startHarvestCron } from './harvest/cron.js';
import { loadConfig } from './config.js';

dotenvConfig();
const config = loadConfig();
const db = openDb(config.dbPath);
runMigrations(db);
startHarvestCron(db, config);

const app = new Hono();
app.route('/api', createApiRoutes(db, config));
app.use('/*', serveStatic({ root: './dist/frontend' }));
app.get('*', serveStatic({ path: './dist/frontend/index.html' }));

serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`TasteBuds running on http://0.0.0.0:${info.port}`);
});
