/**
 * API usage budget tracking — persists per-day counters so we don't blow
 * the TMDB free tier or Ollama embed budget in a single day.
 *
 * harvest_added   — new titles ingested during the daily harvest
 * request_added   — new titles ingested on-demand for a user request
 *
 * Both are additive: each harvest/request run bumps the day's counter and
 * the caller stops once it hits the configured daily target.
 */

import type Database from 'better-sqlite3';

interface UsageRow {
  day: string;
  harvest_added: number;
  request_added: number;
}

/** Return today's string in YYYY-MM-DD format (UTC). */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Return the usage counters for a given day.
 * Returns zeros when no row exists (first run of the day).
 */
export function getUsage(
  db: InstanceType<typeof Database>,
  day: string,
): { harvest_added: number; request_added: number } {
  const row = db
    .prepare('SELECT harvest_added, request_added FROM api_usage WHERE day = ?')
    .get(day) as UsageRow | undefined;
  return {
    harvest_added: row?.harvest_added ?? 0,
    request_added: row?.request_added ?? 0,
  };
}

/**
 * Increment the harvest_added counter for the given day by n.
 * Creates the row if it doesn't exist yet (UPSERT on day).
 */
export function bumpHarvestAdded(db: InstanceType<typeof Database>, day: string, n: number): void {
  db.prepare(`
    INSERT INTO api_usage (day, harvest_added, request_added)
    VALUES (?, ?, 0)
    ON CONFLICT (day) DO UPDATE SET harvest_added = harvest_added + excluded.harvest_added
  `).run(day, n);
}

/**
 * Increment the request_added counter for the given day by n.
 * Creates the row if it doesn't exist yet (UPSERT on day).
 */
export function bumpRequestAdded(db: InstanceType<typeof Database>, day: string, n: number): void {
  db.prepare(`
    INSERT INTO api_usage (day, harvest_added, request_added)
    VALUES (?, 0, ?)
    ON CONFLICT (day) DO UPDATE SET request_added = request_added + excluded.request_added
  `).run(day, n);
}
