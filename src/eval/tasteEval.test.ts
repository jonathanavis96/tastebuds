import { describe, it, expect } from 'vitest';
import { metrics, recentSplit, foldSplits } from './tasteEval.js';
import type { EvalEvent } from './data.js';

const ev = (rating: number | null, i: number): EvalEvent => ({ titleId: i, rating, vec: new Float32Array(1), time: i, order: i });

describe('taste test maths', () => {
  it('pairs liked (4★+) against no (≤2.5★ or dismissed), and orders stars', () => {
    const test = [ev(5, 1), ev(4, 2), ev(2, 3), ev(null, 4), ev(3, 5)];
    const m = metrics(test, [0.9, 0.1, 0.5, 0.2, 0.3]);
    expect(m.nPos).toBe(2);
    expect(m.nNeg).toBe(2);
    // 5★ beats both noes; 4★ beats neither.
    const wins = m.likePairs.filter(([a, b]) => a > b).length;
    expect(wins).toBe(2);
    expect(m.likePairs).toHaveLength(4);
    // Rated pairs with different stars: (5,4)(5,2)(5,3)(4,2)(4,3)(3,2) = 6.
    expect(m.starPairs).toHaveLength(6);
  });

  it('hides the latest 30% and folds cover every event once per repeat', () => {
    const events = Array.from({ length: 10 }, (_, i) => ev(4, i));
    const s = recentSplit(events);
    expect(s.test.map(e => e.titleId)).toEqual([7, 8, 9]);
    const folds = foldSplits(events, 5, 2);
    expect(folds).toHaveLength(10);
    const firstRepeat = folds.slice(0, 5).flatMap(f => f.test.map(e => e.titleId)).sort((a, b) => a - b);
    expect(firstRepeat).toEqual(events.map(e => e.titleId));
  });
});
