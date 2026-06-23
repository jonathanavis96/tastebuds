import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from './migrate.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(dbPath: string): InstanceType<typeof Database> {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  try {
    sqliteVec.load(db);
  } catch (err) {
    const vecPath = process.env.SQLITE_VEC_PATH;
    if (vecPath) {
      db.loadExtension(vecPath);
    } else {
      console.warn(
        '[tastebuds] sqlite-vec npm load failed; set SQLITE_VEC_PATH if vec0 extension needed:',
        err,
      );
    }
  }

  runMigrations(db);
  return db;
}
