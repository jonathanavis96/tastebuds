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

  it('migration 010 adds popularity and vote_count to titles and is idempotent', () => {
    const db = createTestDb();
    runMigrations(db);

    const columns = db
      .prepare("PRAGMA table_info('titles')")
      .all() as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('popularity');
    expect(colNames).toContain('vote_count');

    // Re-running migrations must not throw (idempotent)
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('migration 011 adds rating_checked_at to titles and is idempotent', () => {
    const db = createTestDb();
    runMigrations(db);

    const columns = db
      .prepare("PRAGMA table_info('titles')")
      .all() as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('rating_checked_at');

    // Re-running migrations must not throw (idempotent)
    expect(() => runMigrations(db)).not.toThrow();
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

  it("profiles.config defaults to '{}' and supports rating_threshold round-trip", () => {
    const db = createTestDb();
    runMigrations(db);

    // Insert with the default config (no explicit config value → DEFAULT '{}')
    db.prepare("INSERT INTO profiles (name, media_weighting, is_derived) VALUES (?, ?, ?)").run('TestUser', 0.5, 0);
    const row = db.prepare("SELECT config FROM profiles WHERE name = ?").get('TestUser') as { config: string };

    // Default parses to an empty object with no rating_threshold
    const defaultCfg = JSON.parse(row.config);
    expect(typeof defaultCfg).toBe('object');
    expect(defaultCfg.rating_threshold).toBeUndefined();

    // Round-trip: store a rating_threshold and read it back
    db.prepare("UPDATE profiles SET config = ? WHERE name = ?")
      .run(JSON.stringify({ rating_threshold: 7 }), 'TestUser');
    const updated = db.prepare("SELECT config FROM profiles WHERE name = ?").get('TestUser') as { config: string };
    const updatedCfg = JSON.parse(updated.config);
    expect(updatedCfg.rating_threshold).toBe(7);

    // Null threshold (user turns filter off) also round-trips cleanly
    db.prepare("UPDATE profiles SET config = ? WHERE name = ?")
      .run(JSON.stringify({ rating_threshold: null }), 'TestUser');
    const cleared = db.prepare("SELECT config FROM profiles WHERE name = ?").get('TestUser') as { config: string };
    const clearedCfg = JSON.parse(cleared.config);
    expect(clearedCfg.rating_threshold).toBeNull();
  });
});
