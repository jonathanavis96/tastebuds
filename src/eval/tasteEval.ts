/**
 * Offline taste test. Hides part of each profile's history, trains on the rest
 * and checks how well each model orders the hidden titles.
 *
 *   npm run eval:taste -- path/to/COPY-of-tastebuds.db
 *
 * Point it at a copy: it opens the file read-only, but a live database in WAL
 * mode should not be read across a network share while the app writes to it.
 *
 * Two numbers per profile and model:
 *   like-vs-no  How often a hidden title rated 4★+ outscores a hidden title rated
 *               2.5★ or below or dismissed as "Not interested" (0.5 = coin flip).
 *   star order  Over every pair of hidden rated titles with different ratings,
 *               how often the higher-rated one scores higher.
 * Two ways of hiding:
 *   recent      The latest 30% of each profile's events (by timestamp).
 *   5-fold      Random fifths, each hidden in turn, repeated 10 times (steadier).
 */
import { loadEvalData, type EvalData, type EvalEvent, type EvalProfile } from './data.js';
import { buildSoloTaste, scoreSolo, scoreJoint, type ModelOptions, type JointWeights, TODAY_JOINT } from './models.js';

export interface Metric { likeVsNo: number | null; starOrder: number | null; nPos: number; nNeg: number; nRated: number }

/** Fraction of (a, b) pairs, a should beat b, where score(a) > score(b); ties count half. */
function pairwise(pairs: Array<[number, number]>): number | null {
  if (pairs.length === 0) return null;
  let s = 0;
  for (const [a, b] of pairs) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / pairs.length;
}

export function metrics(test: EvalEvent[], scores: number[]): { likePairs: Array<[number, number]>; starPairs: Array<[number, number]>; nPos: number; nNeg: number; nRated: number } {
  const pos: number[] = [];
  const neg: number[] = [];
  const rated: Array<[number, number]> = [];
  test.forEach((e, i) => {
    if (e.rating == null || e.rating <= 2.5) neg.push(scores[i]);
    else if (e.rating >= 4) pos.push(scores[i]);
    if (e.rating != null) rated.push([e.rating, scores[i]]);
  });
  const likePairs: Array<[number, number]> = [];
  for (const p of pos) for (const n of neg) likePairs.push([p, n]);
  const starPairs: Array<[number, number]> = [];
  for (let i = 0; i < rated.length; i++) for (let j = 0; j < rated.length; j++) {
    if (rated[i][0] > rated[j][0]) starPairs.push([rated[i][1], rated[j][1]]);
  }
  return { likePairs, starPairs, nPos: pos.length, nNeg: neg.length, nRated: rated.length };
}

type Split = { train: EvalEvent[]; test: EvalEvent[] };

export function recentSplit(events: EvalEvent[], frac = 0.3): Split {
  const cut = Math.round(events.length * (1 - frac));
  return { train: events.slice(0, cut), test: events.slice(cut) };
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function foldSplits(events: EvalEvent[], k = 5, repeats = 10, seed = 7): Split[] {
  const out: Split[] = [];
  const rand = rng(seed);
  for (let r = 0; r < repeats; r++) {
    const idx = events.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    for (let f = 0; f < k; f++) {
      const testSet = new Set(idx.filter((_, i) => i % k === f));
      out.push({ train: events.filter((_, i) => !testSet.has(i)), test: events.filter((_, i) => testSet.has(i)) });
    }
  }
  return out;
}

/** Pool the pairs across splits, then score: every hidden pair counts once per split it appears in. */
function evaluate(splits: Split[], score: (s: Split) => number[]): Metric {
  const like: Array<[number, number]> = [];
  const star: Array<[number, number]> = [];
  let nPos = 0, nNeg = 0, nRated = 0;
  for (const s of splits) {
    if (s.test.length === 0) continue;
    const m = metrics(s.test, score(s));
    like.push(...m.likePairs); star.push(...m.starPairs);
    nPos += m.nPos; nNeg += m.nNeg; nRated += m.nRated;
  }
  const reps = Math.max(1, splits.length / 5);
  return { likeVsNo: pairwise(like), starOrder: pairwise(star), nPos: nPos / (splits.length > 1 ? reps : 1), nNeg: nNeg / (splits.length > 1 ? reps : 1), nRated: nRated / (splits.length > 1 ? reps : 1) };
}

export interface ModelSpec { key: string; label: string; opts: ModelOptions; joint?: JointWeights }

export const SOLO_MODELS: ModelSpec[] = [
  { key: 'today-vector', label: 'Today: taste vector only (cosine)', opts: { cosineOnly: true } },
  { key: 'today', label: 'Today: full ranking score', opts: {} },
  { key: 'knn', label: 'A. Nearest liked/disliked titles instead of one average vector', opts: { knn: true } },
  { key: 'learned', label: 'B. Learned genre + keyword weights (ratings and dismissals)', opts: { learned: true } },
  { key: 'media', label: 'C. Separate movie and series taste', opts: { mediaSplit: true } },
  { key: 'knn+learned', label: 'A + B', opts: { knn: true, learned: true } },
];

export function soloScorer(p: EvalProfile, data: EvalData, opts: ModelOptions) {
  return (s: Split) => {
    const taste = buildSoloTaste(s.train, data.titles, p.prefs, opts);
    return scoreSolo(taste, s.test.map(e => data.titles.get(e.titleId)!), opts);
  };
}

/**
 * Joint scorer. The partners' solo histories are used in full except for the
 * titles hidden in this split, so a solo rating of the same title cannot leak
 * the answer.
 */
export function jointScorer(joint: EvalProfile, a: EvalProfile, b: EvalProfile, data: EvalData, opts: ModelOptions, w: JointWeights = TODAY_JOINT) {
  return (s: Split) => {
    const hidden = new Set(s.test.map(e => e.titleId));
    const own = buildSoloTaste(s.train, data.titles, joint.prefs, opts);
    const ta = buildSoloTaste(a.events.filter(e => !hidden.has(e.titleId)), data.titles, a.prefs, opts);
    const tb = buildSoloTaste(b.events.filter(e => !hidden.has(e.titleId)), data.titles, b.prefs, opts);
    return scoreJoint(own, ta, tb, s.test.map(e => data.titles.get(e.titleId)!), opts, w);
  };
}

export function runProfile(splitsOf: (p: EvalProfile) => Split[], scorer: (s: Split) => number[], p: EvalProfile): Metric {
  return evaluate(splitsOf(p), scorer);
}

const fmt = (x: number | null) => (x == null ? '  n/a' : x.toFixed(3));

/** For repeated k-fold: in how many repeats does `cand` beat `base` on like-vs-no (or star order when there are no "no"s)? */
function repeatWins(splits: Split[], k: number, base: (s: Split) => number[], cand: (s: Split) => number[]): { wins: number; ties: number; repeats: number } {
  let wins = 0, ties = 0, repeats = 0;
  for (let r = 0; r * k < splits.length; r++) {
    const group = splits.slice(r * k, r * k + k);
    const mb = evaluate(group, base);
    const mc = evaluate(group, cand);
    const vb = mb.likeVsNo ?? mb.starOrder;
    const vc = mc.likeVsNo ?? mc.starOrder;
    if (vb == null || vc == null) continue;
    repeats++;
    if (Math.abs(vc - vb) < 1e-9) ties++;
    else if (vc > vb) wins++;
  }
  return { wins, ties, repeats };
}

export const JOINT_MODELS: ModelSpec[] = [
  ...SOLO_MODELS,
  { key: 'own-only', label: "Couple's own history only", opts: {}, joint: { own: 1 } },
  { key: 'partners-only', label: 'Partners only', opts: {}, joint: { own: 0 } },
  { key: 'veto-override', label: 'D. Together-ratings override the solo veto', opts: { vetoOverride: true } },
  { key: 'knn+veto', label: 'A + D', opts: { knn: true, vetoOverride: true } },
  { key: 'knn+learn+veto', label: 'A + B + D', opts: { knn: true, learned: true, vetoOverride: true } },
];

function main(): void {
  const path = process.argv[2];
  if (!path) { console.error('usage: tsx src/eval/tasteEval.ts <copy-of-db>'); process.exit(2); }
  const data = loadEvalData(path);
  const solos = data.profiles.filter(p => !p.isDerived);
  const joint = data.profiles.find(p => p.isDerived);
  console.log(`Loaded ${data.profiles.length} profiles; ${data.noteMisses} note embeddings missing from the cache (title embedding used).`);
  for (const p of data.profiles) {
    const rated = p.events.filter(e => e.rating != null).length;
    console.log(`  ${p.name}: ${rated} rated, ${p.events.length - rated} dismissed`);
  }
  const rows: Array<{ profile: string; scorer: (m: ModelSpec) => (s: Split) => number[]; models: ModelSpec[]; p: EvalProfile }> = [];
  for (const p of solos) rows.push({ profile: p.name, p, models: SOLO_MODELS, scorer: m => soloScorer(p, data, m.opts) });
  if (joint && solos.length === 2) {
    rows.push({ profile: `${joint.name} (as Joint)`, p: joint, models: JOINT_MODELS,
      scorer: m => jointScorer(joint, solos[0], solos[1], data, m.opts, m.joint) });
  }
  for (const row of rows) {
    const recent = [recentSplit(row.p.events)];
    const folds = foldSplits(row.p.events);
    const today = row.scorer(row.models.find(m => m.key === 'today')!);
    const r0 = evaluate(recent, today);
    console.log(`\n${row.profile}  — hidden (recent 30%): ${r0.nPos.toFixed(0)} liked, ${r0.nNeg.toFixed(0)} no, ${r0.nRated.toFixed(0)} rated`);
    console.log('  model            recent: like-vs-no  star-order | 5-fold: like-vs-no  star-order | repeats beating today');
    for (const m of row.models) {
      const sc = row.scorer(m);
      const r = evaluate(recent, sc);
      const f = evaluate(folds, sc);
      const w = m.key === 'today' ? '' : (() => { const x = repeatWins(folds, 5, today, sc); return `${x.wins}/${x.repeats}${x.ties ? ` (${x.ties} tied)` : ''}`; })();
      console.log(`  ${m.key.padEnd(15)}  ${fmt(r.likeVsNo).padStart(18)}  ${fmt(r.starOrder).padStart(10)} | ${fmt(f.likeVsNo).padStart(18)}  ${fmt(f.starOrder).padStart(10)} | ${w}`);
    }
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) main();
