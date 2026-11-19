import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runMigrations } from '../db/migrate.js';
import { upsertTitle } from '../db/repos/titles.js';
import { imdbRatingsPath } from '../imdb/dataset.js';
import { ratingsStartupDue } from './startup.js';

const HOUR_MS = 60 * 60 * 1000;

describe('ratingsStartupDue', () => {
  let dir: string;
  let config: { dbPath: string };
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tastebuds-startup-'));
    config = { dbPath: join(dir, 'tastebuds.db') };
    db = new Database(':memory:');
    runMigrations(db);
    upsertTitle(db, {
      tmdb_id: 1,
      media_type: 'movie',
      title: 'Title 1',
      year: 2020,
      genres: '[]',
      keywords: '[]',
      cast: '[]',
      synopsis: null,
      poster_path: null,
      embedding: null,
      updated_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRatingsFile(ageMs: number): void {
    const path = imdbRatingsPath(config);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
  }

  it('syncs ratings when the file is missing, and genres when no title has any', async () => {
    expect(await ratingsStartupDue(db, config)).toEqual({ ratings: true, genres: true });
  });

  it('syncs ratings only when the file is older than 36 hours', async () => {
    writeRatingsFile(30 * HOUR_MS);
    expect((await ratingsStartupDue(db, config)).ratings).toBe(false);
    writeRatingsFile(37 * HOUR_MS);
    expect((await ratingsStartupDue(db, config)).ratings).toBe(true);
  });

  it('skips genres once any title has them', async () => {
    db.prepare(`UPDATE titles SET imdb_genres = '["Drama"]'`).run();
    expect((await ratingsStartupDue(db, config)).genres).toBe(false);
  });
});
