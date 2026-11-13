import { describe, it, expect } from 'vitest';
import { chartNotes, formatLift, radiusFor } from './tasteChart.js';
import type { TasteChart } from './types.js';

describe('taste chart helpers', () => {
  it('puts usual on the middle ring and clamps at one star', () => {
    expect(radiusFor(0)).toBe(0.5);
    expect(radiusFor(null)).toBe(0.5);
    expect(radiusFor(0.5)).toBe(0.75);
    expect(radiusFor(-3)).toBe(0);
  });

  it('formats lifts in stars', () => {
    expect(formatLift(0.34)).toBe('+0.3★');
    expect(formatLift(-0.68)).toBe('−0.7★');
    expect(formatLift(0.02)).toBe('about usual');
    expect(formatLift(null)).toBe('no ratings');
  });

  it('names highs and lows for one person, ignoring thin genres', () => {
    const chart: TasteChart = {
      axes: ['Horror', 'Comedy', 'War', 'Drama'],
      series: [{ profileId: 1, label: 'A', kind: 'person', lifts: [0.4, -0.6, 0.9, null], counts: [12, 30, 2, 0], total: 50 }],
    };
    expect(chartNotes(chart)).toEqual([
      'Rates Horror highest.',
      'Rates Comedy lowest.',
      'No ratings yet for Drama.',
    ]);
  });

  it('finds where a couple differs most', () => {
    const chart: TasteChart = {
      axes: ['Comedy', 'Action'],
      series: [
        { profileId: 1, label: 'A', kind: 'person', lifts: [-0.7, 0.2], counts: [30, 30], total: 60 },
        { profileId: 2, label: 'B', kind: 'person', lifts: [0.3, 0.1], counts: [20, 9], total: 30 },
        { profileId: 3, label: 'Together', kind: 'together', lifts: [-0.2, 0.3], counts: [40, 60], total: 100 },
      ],
    };
    expect(chartNotes(chart)).toEqual([
      'You differ most on Comedy.',
      'Together you rate Action highest.',
      'Together you rate Comedy lowest.',
    ]);
  });
});
