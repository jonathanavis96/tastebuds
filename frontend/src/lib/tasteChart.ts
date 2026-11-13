import type { TasteChart, TasteSeries } from './types.js';

/** Stars above/below usual that reach the chart's edge (or centre). */
export const FULL_SCALE_STARS = 1;

/** Radius 0..1 for a lift: 0.5 is the person's usual, the edge is +1★, the centre −1★. No data sits on the usual ring. */
export function radiusFor(lift: number | null): number {
  if (lift == null) return 0.5;
  const t = Math.max(-1, Math.min(1, lift / FULL_SCALE_STARS));
  return 0.5 + 0.5 * t;
}

/** x, y of spoke i (of n) at radius r (0..1) for a chart of the given centre and outer radius. Spoke 0 points up. */
export function spokePoint(i: number, n: number, r: number, centre: number, outer: number): [number, number] {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  return [centre + Math.cos(a) * outer * r, centre + Math.sin(a) * outer * r];
}

/** "+0.3★" / "−0.7★" / "no ratings". */
export function formatLift(lift: number | null): string {
  if (lift == null) return 'no ratings';
  const v = Math.round(lift * 10) / 10;
  if (v === 0) return 'about usual';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}★`;
}

/** Below this many stars from usual, a genre is not called out as high or low. */
const NOTABLE = 0.1;
/** A genre needs this many titles behind it before the notes name it. */
const MIN_NOTE_TITLES = 5;

function ranked(chart: TasteChart, s: TasteSeries): Array<{ axis: string; lift: number }> {
  return chart.axes
    .map((axis, i) => ({ axis, lift: s.counts[i] >= MIN_NOTE_TITLES ? s.lifts[i] : null }))
    .filter((x): x is { axis: string; lift: number } => x.lift != null)
    .sort((a, b) => b.lift - a.lift);
}

function list(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** Plain-language lines under the chart. */
export function chartNotes(chart: TasteChart): string[] {
  const notes: string[] = [];
  const people = chart.series.filter(s => s.kind === 'person');
  const together = chart.series.find(s => s.kind === 'together');

  if (together && people.length === 2) {
    const [a, b] = people;
    let best: { axis: string; gap: number } | null = null;
    chart.axes.forEach((axis, i) => {
      const la = a.lifts[i];
      const lb = b.lifts[i];
      if (la == null || lb == null || a.counts[i] < MIN_NOTE_TITLES || b.counts[i] < MIN_NOTE_TITLES) return;
      const gap = Math.abs(la - lb);
      if (!best || gap > best.gap) best = { axis, gap };
    });
    const differ = best as { axis: string; gap: number } | null;
    if (differ && differ.gap >= NOTABLE) notes.push(`You differ most on ${differ.axis}.`);
    const r = ranked(chart, together);
    const high = r.filter(x => x.lift >= NOTABLE).slice(0, 2).map(x => x.axis);
    const low = r.filter(x => x.lift <= -NOTABLE).reverse().slice(0, 2).map(x => x.axis);
    if (high.length) notes.push(`Together you rate ${list(high)} highest.`);
    if (low.length) notes.push(`Together you rate ${list(low)} lowest.`);
    return notes;
  }

  const me = chart.series[0];
  if (!me) return notes;
  const r = ranked(chart, me);
  const high = r.filter(x => x.lift >= NOTABLE).slice(0, 2).map(x => x.axis);
  const low = r.filter(x => x.lift <= -NOTABLE).reverse().slice(0, 2).map(x => x.axis);
  const none = chart.axes.filter((_, i) => me.lifts[i] == null);
  if (high.length) notes.push(`Rates ${list(high)} highest.`);
  if (low.length) notes.push(`Rates ${list(low)} lowest.`);
  if (none.length) notes.push(`No ratings yet for ${list(none)}.`);
  return notes;
}
