import cron from 'node-cron';
import { openDb } from '../db/open.js';
import { loadConfig } from '../config.js';
import { runHarvest } from './harvest.js';

const config = loadConfig();
const db = openDb(config.dbPath);

cron.schedule('0 3 * * *', async () => {
  console.log('[tastebuds] Starting daily harvest at', new Date().toISOString());
  try {
    const result = await runHarvest(db, config);
    console.log('[tastebuds] Harvest complete:', result);
  } catch (err) {
    console.error('[tastebuds] Harvest failed:', err);
  }
});

console.log('[tastebuds] Harvest cron scheduled for 03:00 daily');
