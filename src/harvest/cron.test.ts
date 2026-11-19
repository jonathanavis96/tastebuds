import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';

const { calls, record } = vi.hoisted(() => {
  const calls: string[] = [];
  const record = (name: string, fail = false) =>
    vi.fn(async () => {
      calls.push(name);
      if (fail) throw new Error(`${name} broke`);
      return { ok: true };
    });
  return { calls, record };
});

vi.mock('./harvest.js', () => ({ runHarvest: record('harvest', true) }));
vi.mock('../imdb/fillIds.js', () => ({ fillMissingImdbIds: record('imdb-ids'), IMDB_ID_FILL_CAP_DEFAULT: 1500 }));
vi.mock('../imdb/dataset.js', () => ({ syncImdbRatings: record('imdb-ratings'), syncImdbGenres: record('imdb-genres') }));
vi.mock('./backfillRatings.js', () => ({ backfillRatings: record('omdb') }));
vi.mock('../rt/refresh.js', () => ({ refreshRtScores: record('rt') }));
vi.mock('./backfillMeta.js', () => ({ backfillTitleMeta: record('meta') }));

import { runNightly } from './cron.js';

const db = {} as InstanceType<typeof Database>;
const config = {} as Config;

describe('runNightly', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('runs every step in order, past a step that fails', async () => {
    await runNightly(db, config, new Date('2026-11-19T03:00:00Z'));
    expect(calls).toEqual(['harvest', 'imdb-ids', 'imdb-ratings', 'omdb', 'rt', 'meta']);
  });

  it('re-reads IMDb genres on the 1st of the month', async () => {
    await runNightly(db, config, new Date('2026-12-01T03:00:00Z'));
    expect(calls).toEqual(['harvest', 'imdb-ids', 'imdb-ratings', 'imdb-genres', 'omdb', 'rt', 'meta']);
  });
});
