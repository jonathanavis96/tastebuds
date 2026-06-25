import type Database from 'better-sqlite3';
import {
  CREATE_TITLES,
  CREATE_PROFILES,
  CREATE_TASTE_SIGNATURES,
  CREATE_WATCH_EVENTS,
  CREATE_RECOMMENDATIONS,
  MIGRATE_001_ADD_KIND,
  MIGRATE_002_ADD_IMDB_COLS,
  MIGRATE_003_ADD_RT_URL,
  MIGRATE_004_ADD_NOTE,
  MIGRATE_005_DEDUP_PENDING,
  MIGRATE_006_API_USAGE,
  MIGRATE_007_HARVEST_CURSOR,
} from './schema.js';

export function runMigrations(db: InstanceType<typeof Database>): void {
  db.transaction(() => {
    db.exec(CREATE_TITLES);
    db.exec(CREATE_PROFILES);
    db.exec(CREATE_TASTE_SIGNATURES);
    db.exec(CREATE_WATCH_EVENTS);
    db.exec(CREATE_RECOMMENDATIONS);

    // Migration 001: add kind column to recommendations (idempotent)
    const recCols = db.prepare("PRAGMA table_info('recommendations')").all() as Array<{ name: string }>;
    const hasKind = recCols.some(c => c.name === 'kind');
    if (!hasKind) {
      db.exec(MIGRATE_001_ADD_KIND);
    }

    // Migration 002: add imdb_id, imdb_rating, rt_rating to titles (idempotent)
    const titleCols = db.prepare("PRAGMA table_info('titles')").all() as Array<{ name: string }>;
    const titleColNames = titleCols.map(c => c.name);
    for (const sql of MIGRATE_002_ADD_IMDB_COLS) {
      // Extract column name from "ALTER TABLE titles ADD COLUMN <name> ..."
      const colName = sql.split('ADD COLUMN ')[1].split(' ')[0];
      if (!titleColNames.includes(colName)) {
        db.exec(sql);
      }
    }

    // Migration 003: add rt_url to titles (idempotent)
    // Re-read cols in case we just altered the table above
    const titleCols3 = db.prepare("PRAGMA table_info('titles')").all() as Array<{ name: string }>;
    const titleColNames3 = titleCols3.map(c => c.name);
    for (const sql of MIGRATE_003_ADD_RT_URL) {
      const colName = sql.split('ADD COLUMN ')[1].split(' ')[0];
      if (!titleColNames3.includes(colName)) {
        db.exec(sql);
      }
    }

    // Migration 004: add note (free-text taste insight) to watch_events (idempotent)
    const weCols = db.prepare("PRAGMA table_info('watch_events')").all() as Array<{ name: string }>;
    const weColNames = weCols.map(c => c.name);
    for (const sql of MIGRATE_004_ADD_NOTE) {
      const colName = sql.split('ADD COLUMN ')[1].split(' ')[0];
      if (!weColNames.includes(colName)) {
        db.exec(sql);
      }
    }

    // Migration 005: dedupe pending recs + enforce one pending rec per (profile, title) (idempotent)
    const recIndexes = db.prepare("PRAGMA index_list('recommendations')").all() as Array<{ name: string }>;
    const hasPendingUnique = recIndexes.some(i => i.name === 'idx_rec_pending_unique');
    if (!hasPendingUnique) {
      for (const sql of MIGRATE_005_DEDUP_PENDING) {
        db.exec(sql);
      }
    }

    // Migration 006: create api_usage table for daily budget tracking (idempotent via IF NOT EXISTS)
    db.exec(MIGRATE_006_API_USAGE);

    // Migration 007: create harvest_cursor table for per-bucket page sweeping (idempotent via IF NOT EXISTS)
    db.exec(MIGRATE_007_HARVEST_CURSOR);
  })();
}
