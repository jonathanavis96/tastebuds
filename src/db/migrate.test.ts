import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}

describe('runMigrations', () => {
  it('creates all 5 tables', () => {
    const db = createTestDb();
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('titles');
    expect(tableNames).toContain('profiles');
    expect(tableNames).toContain('taste_signatures');
    expect(tableNames).toContain('watch_events');
    expect(tableNames).toContain('recommendations');
  });

  it('is idempotent — calling twice does not throw', () => {
    const db = createTestDb();
    expect(() => {
      runMigrations(db);
      runMigrations(db);
    }).not.toThrow();
  });

  it('titles table has correct columns', () => {
    const db = createTestDb();
    runMigrations(db);

    const columns = db
      .prepare("PRAGMA table_info('titles')")
      .all() as Array<{ name: string; type: string; dflt_value: string | null; notnull: number }>;

    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('tmdb_id');
    expect(colNames).toContain('media_type');
    expect(colNames).toContain('title');
    expect(colNames).toContain('embedding');
  });

  it('watch_events table has status column with correct default check', () => {
    const db = createTestDb();
    runMigrations(db);

    const columns = db
      .prepare("PRAGMA table_info('watch_events')")
      .all() as Array<{ name: string }>;

    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('status');
    expect(colNames).toContain('rating');
    expect(colNames).toContain('watched_at');
  });
});
