/**
 * POST /generate without HTTP: make a batch of picks for one profile and return
 * the feed. A typed request is read into rules and every pick obeys all of
 * them (src/request); a call without one (Generate More, Surprise Me, cold
 * start) curates a taste pool as before.
 */
import type { Database } from 'better-sqlite3';
import type { Config } from '../config.js';
import type { ProfileRow, TasteSignatureRow } from '../db/types.js';
import { getProfile } from '../db/repos/profiles.js';
import { clearPendingRecommendations, getRecommendations, upsertRecommendation } from '../db/repos/recommendations.js';
import { getEngagedTitleIds } from '../db/repos/watchEvents.js';
import { getTitleById } from '../db/repos/titles.js';
import { getTasteSignature } from '../db/repos/tasteSignatures.js';
import { embedText } from '../ollama/embed.js';
import {
  blendRequestQueryBuf,
  jointRequestBase,
  retrieveCandidatePool,
  retrieveColdStartPool,
  retrieveJointCandidatePool,
  soloRequestBase,
  type CandidateTitle,
  type RequestBase,
} from '../retrieval/retrieve.js';
import { titleIdsPassing, type HardFilters } from '../retrieval/filters.js';
import {
  FULL_SET,
  findReferenceTitles,
  olderRoom,
  requestSlate,
  requestVector,
  retrieveUnderRules,
  withReferences,
  type RulesRetrieval,
} from '../retrieval/requestRules.js';
import { arrangeRequestPicks, curateCandidates, curateRequest, withoutTmdbIdClashes, type CurationResult, type SpawnFn } from '../curation/curate.js';
import { ensureRulesCoverage, mergeRequestGenresToProfile, type OnDemandDeps } from '../harvest/onDemand.js';
import { ensureFreshRatings } from '../ratings/freshness.js';
import { parseRequest } from '../request/parse.js';
import { refineRulesWithModel } from '../request/modelParse.js';
import { describeRules, describeYearWindow } from '../request/describe.js';
import { titleObeys } from '../request/enforce.js';
import type { RequestRules, RequestSummary } from '../request/rules.js';
import { engagementMemberIds, feedFor, hardFiltersFor, soloProfileIds, type FeedResponse } from './feed.js';

/** Below this many matching titles, TMDB is asked for more before picking. */
export const DISCOVERY_THRESHOLD = 30;

export interface GenerateBody {
  profileId?: unknown;
  mediaType?: string;
  genreIds?: number[];
  request?: string;
  surprise?: boolean;
}

/** Test seams; each defaults to the real implementation. */
export interface GenerateDeps {
  spawnFn?: SpawnFn;
  embedFn?: (text: string, config: Pick<Config, 'ollamaUrl'>) => Promise<number[]>;
  onDemandDeps?: OnDemandDeps;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export type GenerateOutcome =
  | { ok: true; feed: FeedResponse }
  | { ok: false; status: 400 | 404; error: string };

interface Context {
  db: Database;
  config: Config;
  profile: ProfileRow;
  sig: TasteSignatureRow;
  coldStart: boolean;
  mediaType: 'movie' | 'tv' | undefined;
  hardFilters: HardFilters;
  /** The profile's own IMDb setting, when it has one. */
  minImdbRating: number | undefined;
  /** Pending, dismissed and engaged titles: never picked again. */
  excludeTitleIds: number[];
  /** Highest pending id before this call: rows after it are this call's picks. */
  lastOldId: number;
  hadPending: boolean;
  deps: GenerateDeps;
}

/**
 * Make one batch of picks for `body.profileId` and return the feed. A request
 * (`body.request`, not Surprise Me) returns its summary beside the recs; any
 * other call returns `request: null` and stores no summary.
 */
export async function generatePicks(
  db: Database,
  config: Config,
  body: GenerateBody,
  deps: GenerateDeps = {},
): Promise<GenerateOutcome> {
  if (typeof body.profileId !== 'number' || !body.profileId) return { ok: false, status: 400, error: 'profileId required' };
  const profileId = body.profileId;
  const profile = getProfile(db, profileId);
  if (!profile) return { ok: false, status: 404, error: 'Profile not found' };
  if (profile.is_derived && soloProfileIds(db).length < 2) {
    return { ok: false, status: 400, error: 'Two solo profiles are required for a Joint blend' };
  }

  const ctx = buildContext(db, config, profile, body, deps);
  const request = body.request?.trim();
  if (request && body.surprise !== true) return { ok: true, feed: await generateForRequest(ctx, request) };
  await generateFromPool(ctx, body);
  return { ok: true, feed: { recs: feedFor(db, config, profileId).recs, request: null } };
}

function buildContext(db: Database, config: Config, profile: ProfileRow, body: GenerateBody, deps: GenerateDeps): Context {
  const placeholderSig = (): TasteSignatureRow =>
    ({ profile_id: profile.id, taste_vector: null, prefs: '{}', refreshed_at: new Date().toISOString() });
  let sig = getTasteSignature(db, profile.id);
  // Cold start: a freshly seeded profile has never rated anything, so it has no
  // taste_vector (and a Joint can't blend two missing solo vectors; with one
  // missing it ranks by the other partner). Instead of failing, fall back to a
  // loved-genre/random pool so a new user can bootstrap by rating what comes back.
  let coldStart = false;
  if (profile.is_derived) {
    const [soloA, soloB] = soloProfileIds(db);
    coldStart = !getTasteSignature(db, soloA)?.taste_vector && !getTasteSignature(db, soloB)?.taste_vector;
  } else {
    coldStart = !sig?.taste_vector;
  }
  sig ??= placeholderSig();

  // Exclude from every candidate set:
  //  - current pending recs (prevents duplicates as recommendations accumulate)
  //  - dismissed titles ("Not interested" is permanent, never re-suggest); for a
  //    Joint call a "not interested" from either partner is a veto for the couple
  //  - ENGAGED titles: anything watched or on the watchlist (for Joint, the
  //    couple's combined engagement)
  const memberIds = engagementMemberIds(db, profile.id);
  const existingPending = getRecommendations(db, profile.id, 'pending');
  const dismissedBy = profile.is_derived ? memberIds : [profile.id];
  const dismissed = dismissedBy.flatMap(pid => getRecommendations(db, pid, 'dismissed'));
  const excludeTitleIds = [...new Set([
    ...existingPending.map(r => r.title_id),
    ...dismissed.map(r => r.title_id),
    ...getEngagedTitleIds(db, memberIds),
  ])];

  // Per-profile IMDb rating threshold from the profile's config JSON; a missing
  // or malformed config means no threshold.
  let minImdbRating: number | undefined;
  try {
    const cfg = JSON.parse(profile.config ?? '{}') as Record<string, unknown>;
    if (typeof cfg.rating_threshold === 'number') minImdbRating = cfg.rating_threshold;
  } catch { /* malformed config → no filter */ }

  return {
    db, config, profile, sig, coldStart, deps, minImdbRating, excludeTitleIds,
    mediaType: body.mediaType === 'movie' || body.mediaType === 'tv' ? body.mediaType : undefined,
    hardFilters: hardFiltersFor(db, config, memberIds),
    lastOldId: existingPending.reduce((m, r) => Math.max(m, r.id), 0),
    hadPending: existingPending.length > 0,
  };
}

/**
 * This call's new pending picks, oldest id first, stamped with one time so the
 * feed keeps the batch together and in the order it was stored (rank order).
 */
function takeBatch(ctx: Context): number[] {
  const fresh = getRecommendations(ctx.db, ctx.profile.id, 'pending')
    .filter(r => r.id > ctx.lastOldId)
    .sort((a, b) => a.id - b.id);
  if (fresh.length > 0) {
    ctx.db.prepare('UPDATE recommendations SET created_at = ? WHERE id IN (SELECT value FROM json_each(?))')
      .run(new Date().toISOString(), JSON.stringify(fresh.map(r => r.id)));
  }
  return fresh.map(r => r.title_id);
}

/**
 * A fresh generate replaces the profile's pending set. The old rows go only once
 * this call has written at least one new pick (they were excluded from the
 * candidates, so no new pick collides with one), so a failed or empty generate
 * never leaves Picks empty. Shown/dismissed recs and watch history are untouched,
 * and so is a pending pick the profile has watched, rated or watchlisted (its row
 * carries the predicted_rating the calibration widget needs). A media-filtered
 * generate replaces only picks of that media type.
 */
function replaceOldPending(ctx: Context, fresh: number[]): void {
  if (ctx.hadPending && fresh.length > 0) clearPendingRecommendations(ctx.db, ctx.profile.id, ctx.lastOldId, ctx.mediaType);
}

// ── Calls without a request ──────────────────────────────────────────────────

async function generateFromPool(ctx: Context, body: GenerateBody): Promise<void> {
  const { db, config, profile } = ctx;
  const surprise = body.surprise === true;
  // A thin pool is widened year → runtime → votes; log when that happens so a
  // surprising pick can be traced to a relaxed filter.
  const onWidened = (steps: string[]) => {
    if (steps.length > 0) console.log(`[tastebuds] /generate profile=${profile.id} widened filters: ${steps.join(' → ')}`);
  };
  const opts = {
    mediaType: ctx.mediaType, genreIds: body.genreIds, excludeTitleIds: ctx.excludeTitleIds,
    minImdbRating: ctx.minImdbRating, hardFilters: ctx.hardFilters, onWidened,
  };
  let pool;
  if (profile.is_derived) {
    const [soloA, soloB] = soloProfileIds(db);
    const jointOpts = { ...opts, jointProfileId: profile.id };
    pool = ctx.coldStart
      ? await retrieveColdStartPool(db, profile.id, jointOpts, config)
      : await retrieveJointCandidatePool(db, soloA, soloB, jointOpts, config);
  } else {
    pool = ctx.coldStart
      ? await retrieveColdStartPool(db, profile.id, opts, config)
      : await retrieveCandidatePool(db, profile.id, opts, config);
  }
  // Surprise Me keeps the text typed beside it in the prompt, as a hint.
  await curateCandidates(pool, profile, ctx.sig, body.request?.trim() || null, config, db, ctx.deps.spawnFn, !ctx.mediaType, surprise);

  const fresh = takeBatch(ctx);
  // Surprise Me appends to the list and never replaces it (see App.svelte).
  if (!surprise) replaceOldPending(ctx, fresh);
  await ensureFreshRatings(db, fresh, config, ctx.deps.fetchImpl);
}

// ── Calls with a request ─────────────────────────────────────────────────────

interface Planned {
  /** The rules as read, with film vs series and the reference years applied. */
  rules: RequestRules;
  retrieval: RulesRetrieval;
}

interface RequestPick {
  title: CandidateTitle;
  result: CurationResult;
  older: boolean;
}

/** Times each stage of a request (read, embed, discovery, retrieval, curation, ratings), for the one log line per request. */
class Stages {
  readonly ms: Record<string, number> = {};
  async run<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      this.ms[name] = (this.ms[name] ?? 0) + Date.now() - started;
    }
  }
}

async function generateForRequest(ctx: Context, text: string): Promise<FeedResponse> {
  const { db, config, profile, deps } = ctx;
  const now = deps.now?.() ?? new Date();
  const stages = new Stages();

  const read = await stages.run('read', () =>
    refineRulesWithModel(text, parseRequest(text, now), config, now, deps.spawnFn));
  // Film vs series: the request's own words win, then the app's Films/Series filter.
  const asked: RequestRules = { ...read, mediaType: read.mediaType ?? ctx.mediaType ?? null };
  try {
    mergeRequestGenresToProfile(db, profile.id, asked);
  } catch (err) {
    console.warn(`[tastebuds] request genres not saved to profile ${profile.id}: ${String(err)}`);
  }

  const base = requestBase(ctx);
  const requestEmbedding = await stages.run('embed', () => (deps.embedFn ?? embedText)(text, config));
  const plan = (): Planned => planRequest(ctx, asked, base, requestEmbedding, now);

  let planned = await stages.run('retrieval', plan);
  let discovered = 0;
  if (planned.retrieval.inWindow.length < DISCOVERY_THRESHOLD) {
    discovered = await stages.run('discovery', () => discover(ctx, planned.rules));
    if (discovered > 0) planned = await stages.run('retrieval', plan);
  }
  const { rules, retrieval } = planned;
  const understood = describeRules(rules);
  const matched = retrieval.inWindow.length;

  const why = understood.length > 0 ? `Matches your request: ${understood.join(', ')}.` : 'Matches your request.';

  let picks: RequestPick[] = [];
  if (matched + retrieval.older.length > 0) {
    picks = await stages.run('curation', () => choosePicks(ctx, text, understood, retrieval, why));
    picks = keepObeying(picks, retrieval);
    picks = await stages.run('ratings', () => freshlyRated(ctx, picks, planned, why));
  }

  const olderCount = picks.filter(p => p.older).length;
  const summary: RequestSummary = { text, understood, matched, note: summaryNote(rules, retrieval.olderRules, matched, picks.length, olderCount) };
  const ruleNote = olderCount > 0 ? olderPickNote(rules, matched) : null;
  for (const p of picks) {
    upsertRecommendation(db, {
      profile_id: profile.id,
      title_id: p.title.id,
      category: p.result.category,
      score: p.title.score,
      why_blurb: p.result.why,
      request_text: text,
      state: 'pending',
      kind: 'core',
      predicted_rating: p.result.predictedRating,
      request_summary: JSON.stringify(summary),
      rule_note: p.older ? ruleNote : null,
    });
  }
  replaceOldPending(ctx, takeBatch(ctx));

  const fmt = (name: string) => (stages.ms[name] == null ? '-' : `${stages.ms[name]}ms`);
  console.log(
    `[tastebuds] request profile=${profile.id} text=${JSON.stringify(text)} chips=[${understood.join(', ')}] ` +
    `matched=${matched} picked=${picks.length} older=${olderCount}` +
    `${retrieval.olderRules ? ` widened=${describeYearWindow(retrieval.olderRules) ?? 'any year'}` : ''} discovered=${discovered} ` +
    `read=${fmt('read')} embed=${fmt('embed')} discovery=${fmt('discovery')} retrieval=${fmt('retrieval')} curation=${fmt('curation')} ratings=${fmt('ratings')}`,
  );

  // Nothing matched: nothing was stored and the older picks stay as they are,
  // but the feed is empty so the app shows that, not older picks as the answer.
  return { recs: picks.length > 0 ? feedFor(db, config, profile.id).recs : [], request: summary };
}

function requestBase(ctx: Context): RequestBase {
  if (!ctx.profile.is_derived) return soloRequestBase(ctx.db, ctx.profile.id);
  const [soloA, soloB] = soloProfileIds(ctx.db);
  return jointRequestBase(ctx.db, soloA, soloB, ctx.profile.id);
}

/** References, the final rules and the retrieval under them. Database only, so it is cheap to run again after discovery. */
function planRequest(ctx: Context, asked: RequestRules, base: RequestBase, requestEmbedding: number[], now: Date): Planned {
  const refs = findReferenceTitles(ctx.db, asked.similarTo);
  // The profile's own IMDb setting is a rule of every request it makes, so it is
  // part of the rules the viewer is shown; the larger of it and the request's
  // own floor applies.
  const ownFloor = Math.max(ctx.minImdbRating ?? 0, asked.minImdb ?? 0);
  const rules = withReferences(ownFloor > 0 ? { ...asked, minImdb: ownFloor } : asked, refs);
  const vec = requestVector(requestEmbedding, refs);
  const queryVec = base.tasteVec ? blendRequestQueryBuf(base.tasteVec, vec) : Buffer.from(new Float32Array(vec).buffer);
  // Under both sits the hard filters' floor. The floor is checked as a rule, so
  // a title with no IMDb rating fails it.
  const minImdb = Math.max(ownFloor, ctx.hardFilters.minImdbRating);
  const hardFilters = requestHardFilters(ctx, rules);
  const retrieval = retrieveUnderRules(ctx.db, { ...rules, minImdb }, {
    queryVec,
    hardFilters,
    vetoProfileIds: base.vetoProfileIds,
    excludeTitleIds: [...ctx.excludeTitleIds, ...refs.map(r => r.id)],
    affinity: base.affinity,
  }, now);
  return { rules, retrieval };
}

/** A language the request names replaces the household's language list for that request. */
function requestHardFilters(ctx: Context, rules: RequestRules): HardFilters {
  return rules.language ? { ...ctx.hardFilters, languages: [rules.language] } : ctx.hardFilters;
}

/** Ask TMDB for titles inside the rules. Never fails the request; returns how many titles were added. */
async function discover(ctx: Context, rules: RequestRules): Promise<number> {
  try {
    const result = await ensureRulesCoverage(ctx.db, rules, ctx.mediaType, ctx.config, ctx.deps.onDemandDeps);
    if (result.errors.length > 0) console.warn(`[tastebuds] request discovery: ${result.errors.length} errors, first: ${result.errors[0]}`);
    return result.added;
  } catch (err) {
    console.warn(`[tastebuds] request discovery failed: ${String(err)}`);
    return 0;
  }
}

/**
 * The model orders the slate and writes the "why" lines; the code decides the
 * final list (arrangeRequestPicks). When the call fails the ranked titles
 * already obey the rules, so they are kept in rank order with a plain line.
 */
async function choosePicks(ctx: Context, text: string, understood: string[], r: RulesRetrieval, why: string): Promise<RequestPick[]> {
  const seen = new Set<number>();
  const slate = requestSlate(r, r.rules.mediaType === null);
  const recent = withoutTmdbIdClashes(slate.recent, seen);
  const older = withoutTmdbIdClashes(slate.older, seen);
  const room = olderRoom(r);
  let chosen: CurationResult[] = [];
  try {
    chosen = await curateRequest(
      { text, understood, candidates: recent, older, olderRoom: room, mediaOpen: r.rules.mediaType === null },
      ctx.profile, ctx.sig, ctx.config, ctx.deps.spawnFn,
    );
  } catch (err) {
    console.warn(`[tastebuds] request curation failed for profile ${ctx.profile.id}, keeping the ranked titles: ${(err as Error).message}`);
  }
  const arranged = arrangeRequestPicks(chosen, { recent, older, olderRoom: room }, why, FULL_SET);
  const byTmdb = new Map([...recent, ...older].map(c => [c.tmdb_id, c]));
  return [
    ...arranged.recent.map(result => ({ title: byTmdb.get(result.tmdbId)!, result, older: false })),
    ...arranged.older.map(result => ({ title: byTmdb.get(result.tmdbId)!, result, older: true })),
  ];
}

function rulesFor(p: RequestPick, r: RulesRetrieval): RequestRules {
  return p.older && r.olderRules ? r.olderRules : r.rules;
}

/** Every pick checked once more before it is stored. A failure here is a bug upstream: the pick is dropped and logged. */
function keepObeying(picks: RequestPick[], r: RulesRetrieval): RequestPick[] {
  return picks.filter((p) => {
    const check = titleObeys(rulesFor(p, r), p.title);
    if (!check.ok) console.error(`[tastebuds] BUG: pick "${p.title.title}" broke its request's rules (${check.failed.join('; ')}); dropped`);
    return check.ok;
  });
}

/**
 * Make the picks' ratings current, then keep only those still above the floor
 * with the fresh values. A pick that no longer passes is replaced by the next
 * ranked title of its group, whose ratings are refreshed and checked the same
 * way (one extra round at most).
 */
async function freshlyRated(ctx: Context, picks: RequestPick[], planned: Planned, why: string): Promise<RequestPick[]> {
  const r = planned.retrieval;
  const hardFilters = { ...requestHardFilters(ctx, planned.rules), minYear: null };
  const passing = async (list: RequestPick[]): Promise<RequestPick[]> => {
    if (list.length === 0) return [];
    await ensureFreshRatings(ctx.db, list.map(p => p.title.id), ctx.config, ctx.deps.fetchImpl);
    const hardOk = titleIdsPassing(ctx.db, hardFilters, list.map(p => p.title.id));
    return list.filter((p) => {
      const fresh = getTitleById(ctx.db, p.title.id);
      return fresh != null && hardOk.has(fresh.id) && titleObeys(rulesFor(p, r), fresh).ok;
    });
  };
  const kept = await passing(picks);
  if (kept.length === picks.length) return kept;

  const used = new Set(picks.map(p => p.title.id));
  const next = (group: CandidateTitle[], older: boolean): RequestPick[] => {
    const lost = picks.filter(p => p.older === older).length - kept.filter(p => p.older === older).length;
    return group.filter(t => !used.has(t.id)).slice(0, lost).map(title => ({
      title, older, result: { tmdbId: title.tmdb_id, why, category: 'Based on your request', kind: 'core', predictedRating: null },
    }));
  };
  const replaced = await passing([...next(r.inWindow, false), ...next(r.older, true)]);
  const all = [...kept, ...replaced];
  return [...all.filter(p => !p.older), ...all.filter(p => p.older)];
}

/** Why an older title is in the list: "Older pick: only 6 titles from 2021 on matched." */
function olderPickNote(rules: RequestRules, matched: number): string {
  return `Older pick: ${countPhrase(matched)} from ${rules.yearMin} on matched.`;
}

function countPhrase(n: number): string {
  return n === 0 ? 'no titles' : n === 1 ? 'only 1 title' : `only ${n} titles`;
}

/**
 * A plain sentence for the viewer when the list is short or older titles were
 * added, saying what would show more; null for a full list from the window.
 */
function summaryNote(rules: RequestRules, olderRules: RequestRules | null, matched: number, picked: number, older: number): string | null {
  if (older > 0 && olderRules) {
    return `${capitalise(countPhrase(matched))} from ${rules.yearMin} on matched, so ${older} from ${olderRules.yearMin} to ${olderRules.yearMax} ` +
      `${older === 1 ? 'was' : 'were'} added. Say "any year" to see older ones.`;
  }
  if (picked >= FULL_SET) return null;
  const found = matched === 0 ? 'Nothing in the library matches all of this.'
    : `${capitalise(countPhrase(Math.min(matched, picked)))} ${Math.min(matched, picked) === 1 ? 'matches' : 'match'} all of this.`;
  const looser = [
    rules.yearSource === 'default' ? 'any year' : rules.yearSource === 'any' ? null : 'a wider year range',
    rules.must.length > 0 ? 'fewer genres or themes' : null,
    rules.mustNot.length > 0 ? 'fewer exclusions' : null,
    rules.minImdb !== null ? 'a lower IMDb rating' : null,
    rules.mediaType !== null ? 'both films and series' : null,
    rules.language !== null ? 'any language' : null,
  ].filter((s): s is string => s !== null);
  return looser.length > 0 ? `${found} Asking for ${joinOr(looser)} would show more.` : found;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function joinOr(items: string[]): string {
  if (items.length <= 2) return items.join(' or ');
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}
