import { describe, it, expect } from 'vitest';
import { compareTimestamps, parseTimestamp } from './time';

describe('parseTimestamp', () => {
  it('reads the old SQLite format as UTC', () => {
    expect(parseTimestamp('2026-10-01 20:00:00')?.toISOString()).toBe('2026-10-01T20:00:00.000Z');
  });
  it('reads ISO UTC', () => {
    expect(parseTimestamp('2026-10-01T20:00:00.000Z')?.toISOString()).toBe('2026-10-01T20:00:00.000Z');
  });
  it('returns null for empty or garbage', () => {
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp('nope')).toBeNull();
  });
});

describe('compareTimestamps', () => {
  // Same calendar day, both formats. As text, ' ' < 'T', so the old row always sorts
  // first whatever its time; by instant the old 20:00 row is the later one.
  const oldLate = '2026-10-01 20:00:00';
  const newEarly = '2026-10-01T19:00:00.000Z';
  const newLater = '2026-10-01T21:30:00.000Z';

  it('orders mixed old and new formats by instant, ascending', () => {
    const sorted = [oldLate, newLater, newEarly].sort(compareTimestamps);
    expect(sorted).toEqual([newEarly, oldLate, newLater]);
  });
  it('orders mixed formats by instant, descending (newest first)', () => {
    const sorted = [newEarly, oldLate, newLater].sort((a, b) => compareTimestamps(b, a));
    expect(sorted).toEqual([newLater, oldLate, newEarly]);
  });
  it('treats an old-format and a new-format value for the same instant as equal', () => {
    expect(compareTimestamps('2026-10-01 20:00:00', '2026-10-01T20:00:00.000Z')).toBe(0);
  });
  it('puts missing or unparseable values before every real timestamp', () => {
    // (Array.sort moves a bare undefined element to the end without calling the
    // comparator, so undefined is checked directly.)
    const sorted = [newEarly, null, 'nope', oldLate].sort(compareTimestamps);
    expect(sorted.slice(2)).toEqual([newEarly, oldLate]);
    expect(compareTimestamps(undefined, newEarly)).toBeLessThan(0);
    expect(compareTimestamps(null, undefined)).toBe(0);
  });
});
