import { describe, it, expect } from 'vitest';
import { parseTimestamp } from './time';

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
