/**
 * Reading a profile's Picks feed, shared by GET /recommendations and
 * POST /generate: which profiles' engagement hides a title, the household's
 * hard filters, and the enriched pending picks with the request behind them.
 */
import type { Database } from 'better-sqlite3';
import type { Config } from '../config.js';
import type { RecommendationRow } from '../db/types.js';
import { getAllProfiles, getProfile } from '../db/repos/profiles.js';
import { getRecommendations } from '../db/repos/recommendations.js';
import { getEngagedTitleIds, getWatchEvent } from '../db/repos/watchEvents.js';
import { getTitleById } from '../db/repos/titles.js';
import { defaultHardFilters, floorFilters, languagesFromHistory, titleIdsPassing, type HardFilters } from '../retrieval/filters.js';
import { titleTags } from '../request/tags.js';
import type { RequestSummary } from '../request/rules.js';

export interface FeedResponse {
  recs: ReturnType<typeof enrichRec>[];
  request: RequestSummary | null;
}

// The two solo (non-derived) profiles that a derived/Joint profile blends.
// Resolved by `is_derived = 0` rather than by name, so profiles can be renamed
// freely without touching code (default seed = "Alex" + "Sam").
export function soloProfileIds(db: Database): number[] {
  return getAllProfiles(db).filter(p => !p.is_derived).map(p => p.id);
}

function derivedProfileIds(db: Database): number[] {
  return getAllProfiles(db).filter(p => p.is_derived).map(p => p.id);
}

/**
 * The set of profile IDs whose engagement should hide a title from `profileId`'s
 * Picks. For a derived (Joint) profile, that's either solo partner OR the couple
 * together; for a solo profile, itself plus the couple (a title watched together
 * has been seen by both, so it must not resurface in either solo feed).
 */
export function engagementMemberIds(db: Database, profileId: number): number[] {
  const profile = getProfile(db, profileId);
  if (!profile?.is_derived) return [...new Set([profileId, ...derivedProfileIds(db)])];
  return [...new Set([...soloProfileIds(db), profileId])];
}

/**
 * Hard filters for a /generate call: the configured defaults, with the language
 * set widened by whatever the household has actually liked (English always).
 */
export function hardFiltersFor(db: Database, config: Config, memberIds: number[]): HardFilters {
  const overrides = config.hardFilters ?? {};
  const learned = languagesFromHistory(db, memberIds);
  return {
    ...defaultHardFilters(),
    ...Object.fromEntries(Object.entries(overrides).filter(([k, v]) => k !== 'languages' && v != null)),
    languages: [...new Set([...learned, ...(overrides.languages ?? [])])],
  };
}

/**
 * Attach display/detail fields from the joined title (the embedding Buffer is
 * omitted), its canonical genre tags, and this profile's own watch_event (if
 * any), so a card opened from Picks shows its TRUE state — watched/rated/noted —
 * and supports re-rating + note edits. The batch's request_summary is returned
 * once, beside the recs, not on each one.
 */
export function enrichRec(db: Database, { request_summary: _summary, ...rec }: RecommendationRow) {
  const t = getTitleById(db, rec.title_id);
  const we = getWatchEvent(db, rec.profile_id, rec.title_id);
  return {
    ...rec,
    rule_note: rec.rule_note ?? null,
    we_status: we?.status ?? null,
    rating: we?.rating ?? null,
    watched_at: we?.watched_at ?? null,
    note: we?.note ?? null,
    title: t?.title ?? null,
    year: t?.year ?? null,
    poster_path: t?.poster_path ?? null,
    synopsis: t?.synopsis ?? null,
    media_type: t?.media_type ?? null,
    genres: t?.genres ?? null,
    tags: t ? [...titleTags(t)] : [],
    cast: t?.cast ?? null,
    tmdb_id: t?.tmdb_id ?? null,
    imdb_id: t?.imdb_id ?? null,
    imdb_rating: t?.imdb_rating ?? null,
    imdb_votes: t?.imdb_votes ?? null,
    rt_rating: t?.rt_rating ?? null,
    rt_url: t?.rt_url ?? null,
    vote_average: t?.vote_average ?? null,
    vote_count: t?.vote_count ?? null,
    original_language: t?.original_language ?? null,
    runtime_minutes: t?.runtime_minutes ?? null,
  };
}

/**
 * Pending recs are read back through the loosest filters the widening ladder can
 * reach, so junk stored before the filters existed (unreleased, zero-vote, shorts,
 * other languages) disappears from the feed without touching the rows, while a
 * legitimately widened pick is never hidden. Engaged titles (watched or
 * watchlisted) are hidden too.
 */
function visibleRecs(db: Database, config: Config, profileId: number, recs: RecommendationRow[]): RecommendationRow[] {
  const memberIds = engagementMemberIds(db, profileId);
  const engagedIds = getEngagedTitleIds(db, memberIds);
  const floor = floorFilters(hardFiltersFor(db, config, memberIds));
  // A pick made for a typed request was checked against that request before it
  // was stored, its language included ("Korean thriller"), so the household's
  // language list is not applied to it a second time.
  const titleIds = (requested: boolean) => recs.filter(r => (r.request_summary != null) === requested).map(r => r.title_id);
  const passing = new Set([
    ...titleIdsPassing(db, floor, titleIds(false)),
    ...titleIdsPassing(db, { ...floor, languages: [] }, titleIds(true)),
  ]);
  return recs.filter(r => !engagedIds.has(r.title_id) && passing.has(r.title_id));
}

/**
 * Newest batch first, as getRecommendations returns them, and within a batch
 * (one created_at, see takeBatch in generate.ts) in the order they were stored.
 */
function inBatchOrder(recs: RecommendationRow[]): RecommendationRow[] {
  const batchRank = new Map<string, number>();
  recs.forEach((r, i) => { if (!batchRank.has(r.created_at)) batchRank.set(r.created_at, i); });
  return [...recs].sort((a, b) => batchRank.get(a.created_at)! - batchRank.get(b.created_at)! || a.id - b.id);
}

/** The visible pending picks, newest batch first, and the stored summary of the request behind the newest of them. */
export function feedFor(db: Database, config: Config, profileId: number): FeedResponse {
  const visible = inBatchOrder(visibleRecs(db, config, profileId, getRecommendations(db, profileId, 'pending')));
  return { recs: visible.map(r => enrichRec(db, r)), request: parseRequestSummary(visible[0]?.request_summary ?? null) };
}

/** The RequestSummary stored with a pick, or null when there is none or it does not parse. */
function parseRequestSummary(raw: string | null): RequestSummary | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw) as Partial<RequestSummary> | null;
    if (v && typeof v.text === 'string' && Array.isArray(v.understood) && typeof v.matched === 'number') {
      return {
        text: v.text,
        understood: v.understood.filter((u): u is string => typeof u === 'string'),
        matched: v.matched,
        note: typeof v.note === 'string' ? v.note : null,
      };
    }
  } catch { /* stored text is not JSON */ }
  return null;
}
