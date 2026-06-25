/**
 * TDD tests for the harvest page cursor.
 *
 * claimPage returns the page to fetch NOW and advances the stored cursor,
 * wrapping back to 1 after maxPage. Buckets are independent.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { claimPage, peekNextPage } from './harvestCursor.js';

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  return db;
}

describe('harvestCursor.claimPage', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns page 1 on the first ever claim for a bucket', () => {
    expect(claimPage(db, 'movie:broad', 30)).toBe(1);
  });

  it('advances one page per claim', () => {
    expect(claimPage(db, 'movie:broad', 30)).toBe(1);
    expect(claimPage(db, 'movie:broad', 30)).toBe(2);
    expect(claimPage(db, 'movie:broad', 30)).toBe(3);
    expect(peekNextPage(db, 'movie:broad')).toBe(4);
  });

  it('wraps back to page 1 after reaching maxPage', () => {
    // maxPage = 3 → pages should cycle 1, 2, 3, 1, 2, 3, …
    expect(claimPage(db, 'tv:broad', 3)).toBe(1);
    expect(claimPage(db, 'tv:broad', 3)).toBe(2);
    expect(claimPage(db, 'tv:broad', 3)).toBe(3);
    expect(claimPage(db, 'tv:broad', 3)).toBe(1);
    expect(claimPage(db, 'tv:broad', 3)).toBe(2);
  });

  it('keeps each bucket on its own independent cursor', () => {
    expect(claimPage(db, 'movie:broad', 30)).toBe(1);
    expect(claimPage(db, 'movie:broad', 30)).toBe(2);
    // A different bucket starts fresh at 1, unaffected by movie:broad
    expect(claimPage(db, 'tv:genre:18', 30)).toBe(1);
    expect(claimPage(db, 'movie:broad', 30)).toBe(3);
    expect(claimPage(db, 'tv:genre:18', 30)).toBe(2);
  });

  it('clamps a stored page that exceeds a shrunk maxPage back into range', () => {
    // Walk the cursor up with a large maxPage…
    claimPage(db, 'movie:broad', 100); // returns 1, stores next=2
    claimPage(db, 'movie:broad', 100); // returns 2, stores next=3
    claimPage(db, 'movie:broad', 100); // returns 3, stores next=4
    // …then shrink maxPage to 2: next stored (4) must clamp to ≤ maxPage and wrap.
    const page = claimPage(db, 'movie:broad', 2);
    expect(page).toBeLessThanOrEqual(2);
    expect(page).toBeGreaterThanOrEqual(1);
  });

  it('peekNextPage does not advance the cursor', () => {
    claimPage(db, 'movie:broad', 30); // now stores next=2
    expect(peekNextPage(db, 'movie:broad')).toBe(2);
    expect(peekNextPage(db, 'movie:broad')).toBe(2);
    expect(claimPage(db, 'movie:broad', 30)).toBe(2);
  });
});
