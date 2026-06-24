/**
 * TDD tests for the apiUsage budget-tracking repo.
 *
 * Verifies: get returns zeros for unknown day, bump+get round-trips,
 * multiple bumps accumulate, and two different days are independent.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { getUsage, bumpHarvestAdded, bumpRequestAdded } from './apiUsage.js';

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('getUsage', () => {
  it('returns zeros for a day with no row', () => {
    const db = createTestDb();
    const usage = getUsage(db, '2026-01-01');
    expect(usage.harvest_added).toBe(0);
    expect(usage.request_added).toBe(0);
  });
});

describe('bumpHarvestAdded', () => {
  it('creates a row on first bump and returns the accumulated count', () => {
    const db = createTestDb();
    bumpHarvestAdded(db, '2026-01-01', 10);
    const usage = getUsage(db, '2026-01-01');
    expect(usage.harvest_added).toBe(10);
    expect(usage.request_added).toBe(0); // other counter untouched
  });

  it('accumulates across multiple bumps on the same day', () => {
    const db = createTestDb();
    bumpHarvestAdded(db, '2026-01-02', 5);
    bumpHarvestAdded(db, '2026-01-02', 3);
    const usage = getUsage(db, '2026-01-02');
    expect(usage.harvest_added).toBe(8);
  });
});

describe('bumpRequestAdded', () => {
  it('creates a row on first bump and returns the accumulated count', () => {
    const db = createTestDb();
    bumpRequestAdded(db, '2026-01-03', 7);
    const usage = getUsage(db, '2026-01-03');
    expect(usage.request_added).toBe(7);
    expect(usage.harvest_added).toBe(0); // other counter untouched
  });

  it('accumulates across multiple bumps on the same day', () => {
    const db = createTestDb();
    bumpRequestAdded(db, '2026-01-04', 4);
    bumpRequestAdded(db, '2026-01-04', 6);
    const usage = getUsage(db, '2026-01-04');
    expect(usage.request_added).toBe(10);
  });
});

describe('day rollover independence', () => {
  it('two different days have completely separate counters', () => {
    const db = createTestDb();
    bumpHarvestAdded(db, '2026-01-05', 100);
    bumpRequestAdded(db, '2026-01-05', 50);

    // A different day should still start at zero
    const nextDay = getUsage(db, '2026-01-06');
    expect(nextDay.harvest_added).toBe(0);
    expect(nextDay.request_added).toBe(0);

    // And the first day should be unchanged
    const firstDay = getUsage(db, '2026-01-05');
    expect(firstDay.harvest_added).toBe(100);
    expect(firstDay.request_added).toBe(50);
  });

  it('bumping one day does not affect another', () => {
    const db = createTestDb();
    bumpHarvestAdded(db, '2026-02-01', 20);
    bumpHarvestAdded(db, '2026-02-02', 30);

    expect(getUsage(db, '2026-02-01').harvest_added).toBe(20);
    expect(getUsage(db, '2026-02-02').harvest_added).toBe(30);
  });
});

describe('mixed harvest + request bumps', () => {
  it('both counters accumulate independently on the same day', () => {
    const db = createTestDb();
    bumpHarvestAdded(db, '2026-03-01', 15);
    bumpRequestAdded(db, '2026-03-01', 8);
    bumpHarvestAdded(db, '2026-03-01', 5);

    const usage = getUsage(db, '2026-03-01');
    expect(usage.harvest_added).toBe(20);
    expect(usage.request_added).toBe(8);
  });
});
