import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Config } from '../config.js';
import { ensurePosterCached } from '../posters/posterCache.js';
import { getAllProfiles, getProfile } from '../db/repos/profiles.js';
import { getRecommendations, updateRecommendationState, getCalibration } from '../db/repos/recommendations.js';
import { upsertWatchEvent, getWatchEvents, getEngagedTitleIds, deleteWatchEvent, setWatchNote, getWatchEvent } from '../db/repos/watchEvents.js';
import { getTitleById, updateTitleRatings, updateTitleRtUrl, countTitles } from '../db/repos/titles.js';
import { retrieveCandidatePool, retrieveJointCandidatePool, retrieveRequestCandidates, retrieveJointRequestCandidates, retrieveColdStartPool } from '../retrieval/retrieve.js';
import { getOmdbRatings } from '../omdb/client.js';
import { getTasteSignature } from '../db/repos/tasteSignatures.js';
import { curateCandidates } from '../curation/curate.js';
import { refreshTasteVector } from '../retrieval/retrieve.js';
import { resolveRtUrl } from '../rt/resolve.js';
import { ensureRequestCoverage } from '../harvest/onDemand.js';

export function createApiRoutes(db: Database, config: Config): Hono {
  const api = new Hono();

  api.get('/profiles', (c) => {
    const profiles = getAllProfiles(db);
    return c.json(profiles);
  });

  // Catalogue size readout for the header — total titles + movie/series split.
  api.get('/stats', (c) => {
    return c.json(countTitles(db));
  });

  // Prediction calibration for a profile (predicted vs actual ratings).
  api.get('/calibration/:profileId', (c) => {
    const profileId = Number(c.req.param('profileId'));
    if (!Number.isFinite(profileId)) return c.json({ error: 'invalid profileId' }, 400);
    return c.json(getCalibration(db, profileId));
  });

  // Local poster cache: serve the w342 poster for a title from disk, fetching it
  // from TMDB once on first display. Removes the runtime dependency on TMDB's CDN
  // (and the via.placeholder.com fallback) for everything the grids render.
  const posterDir = path.join(path.dirname(config.dbPath), 'posters');
  // 1x1.5 dark placeholder with a film glyph, served when a title has no poster.
  const PLACEHOLDER_SVG =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 342 513" width="342" height="513">` +
    `<rect width="342" height="513" fill="#16213e"/>` +
    `<g fill="none" stroke="#3a4570" stroke-width="6" stroke-linejoin="round">` +
    `<rect x="121" y="196" width="100" height="120" rx="8"/>` +
    `<path d="M121 226 H221 M121 286 H221 M141 196 V316 M201 196 V316"/></g>` +
    `<text x="171" y="360" fill="#6b6b8a" font-family="system-ui,sans-serif" font-size="20" text-anchor="middle">No poster</text>` +
    `</svg>`;
  const placeholderResponse = () =>
    new Response(PLACEHOLDER_SVG, {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
    });

  api.get('/poster/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const t = Number.isFinite(id) ? getTitleById(db, id) : undefined;
    if (!t?.poster_path) return placeholderResponse();
    const file = await ensurePosterCached(t.poster_path, id, { posterDir });
    if (!file) return placeholderResponse();
    const buf = fs.readFileSync(file);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  });

  // Attach display/detail fields from the joined title (the embedding Buffer is omitted).
  // Also fold in this profile's own watch_event (if any) so a card opened from Picks
  // shows its TRUE state — watched/rated/noted — and supports re-rating + note edits.
  const enrichRec = (rec: { title_id: number; profile_id?: number }) => {
    const t = getTitleById(db, rec.title_id);
    const we = rec.profile_id != null ? getWatchEvent(db, rec.profile_id, rec.title_id) : undefined;
    return {
      ...rec,
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
      cast: t?.cast ?? null,
      tmdb_id: t?.tmdb_id ?? null,
      imdb_id: t?.imdb_id ?? null,
      imdb_rating: t?.imdb_rating ?? null,
      rt_rating: t?.rt_rating ?? null,
      rt_url: t?.rt_url ?? null,
    };
  };

  // The two solo (non-derived) profiles that a derived/Joint profile blends.
  // Resolved by `is_derived = 0` rather than by name, so profiles can be renamed
  // freely without touching code (default seed = "Alex" + "Sam").
  const soloProfileIds = (): number[] =>
    getAllProfiles(db).filter(p => !p.is_derived).map(p => p.id);

  // The set of profile IDs whose engagement should hide a title from `profileId`'s
  // Picks. For a derived (Joint) profile, that's either solo partner OR the couple
  // together; for a solo profile, just itself.
  const engagementMemberIds = (profileId: number): number[] => {
    const profile = getProfile(db, profileId);
    if (!profile?.is_derived) return [profileId];
    return [...new Set([...soloProfileIds(), profileId])];
  };

  api.get('/recommendations/:profileId', (c) => {
    const profileId = parseInt(c.req.param('profileId'));
    if (isNaN(profileId)) return c.json({ error: 'Invalid profileId' }, 400);

    // Hide any title the profile has ENGAGED with — watched OR on the watchlist.
    // A watched title is done; a watchlisted title is already chosen. Neither should
    // remain in Picks. (Was watched-only before, so watchlist items leaked through.)
    const engagedIds = getEngagedTitleIds(db, engagementMemberIds(profileId));

    const recs = getRecommendations(db, profileId, 'pending')
      .filter(r => !engagedIds.has(r.title_id))
      .map(enrichRec);
    return c.json(recs);
  });

  api.post('/generate', async (c) => {
    const body = await c.req.json<{
      profileId: number;
      mediaType?: string;
      genreIds?: number[];
      request?: string;
      surprise?: boolean;
    }>();
    if (!body.profileId) return c.json({ error: 'profileId required' }, 400);

    const profile = getProfile(db, body.profileId);
    if (!profile) return c.json({ error: 'Profile not found' }, 404);
    let sig = getTasteSignature(db, body.profileId);
    // Cold start: a freshly seeded profile has never rated anything, so it has no
    // taste_vector (and a Joint can't blend two missing solo vectors). Instead of
    // 400-ing, fall back to a loved-genre/random pool so a new user can bootstrap
    // by rating what /generate surfaces (the first ratings build the real vector).
    let coldStart = false;
    if (profile.is_derived) {
      // A derived (Joint) profile blends the two solo vectors; it has no own taste_vector and may have no signature row.
      sig = sig ?? { profile_id: body.profileId, taste_vector: null, prefs: '{}', refreshed_at: new Date().toISOString() };
      const [soloA, soloB] = soloProfileIds();
      const aHasVec = soloA != null && !!getTasteSignature(db, soloA)?.taste_vector;
      const bHasVec = soloB != null && !!getTasteSignature(db, soloB)?.taste_vector;
      coldStart = !aHasVec || !bHasVec;
    } else if (!sig || !sig.taste_vector) {
      sig = sig ?? { profile_id: body.profileId, taste_vector: null, prefs: '{}', refreshed_at: new Date().toISOString() };
      coldStart = true;
    }

    // Exclude from the candidate pool:
    //  - current pending recs (prevents duplicates as recommendations accumulate)
    //  - dismissed titles ("Not interested" is permanent, never re-suggest)
    //  - ENGAGED titles: anything watched or on the watchlist (already seen / already
    //    chosen) — for Joint, that's the couple's combined engagement. Stops Sonnet
    //    wasting picks on titles you've already rated or queued.
    const existingPending = getRecommendations(db, body.profileId, 'pending');
    const dismissed = getRecommendations(db, body.profileId, 'dismissed');
    const engagedIds = getEngagedTitleIds(db, engagementMemberIds(body.profileId));
    const excludeTitleIds = [...new Set([
      ...existingPending.map(r => r.title_id),
      ...dismissed.map(r => r.title_id),
      ...engagedIds,
    ])];

    // balanceMedia = true when no mediaType filter is set (all-tab)
    const balanceMedia = !body.mediaType;
    const mediaType = body.mediaType as 'movie' | 'tv' | undefined;

    // A free-text request ("mind-bending sci-fi") is EMBEDDED and retrieved against
    // (blended with taste), returning a flat request-relevant list — so the pool
    // actually matches the ask instead of the model picking the least-wrong titles
    // from a generic taste pool. Surprise Me has no request and keeps the 7+2+1 pool.
    const request = body.request?.trim();
    const hasRequest = !!request && body.surprise !== true;

    // When the user has typed a free-text request, seed the DB with titles that
    // match the request's genre/keyword vibe BEFORE retrieval runs. This ensures
    // "scary thrillers" finds horror series even if the daily harvest hasn't
    // covered them yet (TV Horror/Thriller aren't in TMDB's genre list — they
    // need keyword discovery which only fires on-demand here).
    // Non-fatal: a TMDB blip must never break /generate.
    if (hasRequest) {
      try {
        await ensureRequestCoverage(db, request!, mediaType, config);
      } catch {
        // swallow — coverage failure degrades quality, not correctness
      }
    }

    // For a derived (Joint) profile, blend the two solo profiles.
    // Cold start (no taste vector to rank against) routes to the loved-genre/random
    // fallback pool for both solo and Joint — the request path needs a vector too.
    let candidatePool;
    if (profile.is_derived) {
      const [soloA, soloB] = soloProfileIds();
      if (soloA == null || soloB == null)
        return c.json({ error: 'Two solo profiles are required for a Joint blend' }, 400);
      const jointOpts = { mediaType, genreIds: body.genreIds, excludeTitleIds, jointProfileId: body.profileId };
      candidatePool = coldStart
        ? await retrieveColdStartPool(db, body.profileId, jointOpts, config)
        : hasRequest
          ? await retrieveJointRequestCandidates(db, soloA, soloB, request!, jointOpts, config)
          : await retrieveJointCandidatePool(db, soloA, soloB, jointOpts, config);
    } else {
      const soloOpts = { mediaType, genreIds: body.genreIds, excludeTitleIds };
      candidatePool = coldStart
        ? await retrieveColdStartPool(db, body.profileId, soloOpts, config)
        : hasRequest
          ? await retrieveRequestCandidates(db, body.profileId, request!, soloOpts, config)
          : await retrieveCandidatePool(db, body.profileId, soloOpts, config);
    }

    await curateCandidates(candidatePool, profile, sig, body.request ?? null, config, db, undefined, balanceMedia, body.surprise === true);

    // OMDb enrichment + RT URL/score resolution — non-fatal; OMDb is the authority
    // for both imdb and rt ratings. resolveRtUrl is only called when OMDb supplies
    // no RT value this pass, and a scraped score is never persisted unless verified.
    {
      const pendingRecs = getRecommendations(db, body.profileId, 'pending');
      for (const rec of pendingRecs) {
        try {
          const t = getTitleById(db, rec.title_id);
          if (!t) continue;

          // OMDb: authority for both imdb and rt ratings; fetch when either is missing
          let omdbRt: string | null = null;
          if (config.omdbApiKey && t.imdb_id && (t.imdb_rating == null || t.rt_rating == null)) {
            const ratings = await getOmdbRatings(t.imdb_id, config);
            omdbRt = ratings.rottenTomatoes;
            updateTitleRatings(db, t.id, { imdb: ratings.imdb, rt: ratings.rottenTomatoes });
          }

          // RT URL: only resolve when we have no URL and OMDb provided no RT this pass
          if (!t.rt_url && omdbRt == null) {
            const result = await resolveRtUrl(t.title, t.year, t.media_type);
            updateTitleRtUrl(db, t.id, result?.url ?? null);
            // Only persist scraped score when verified; never overwrite OMDb RT with unverified scrape
            if (result?.verified && result.score) {
              updateTitleRatings(db, t.id, { imdb: t.imdb_rating ?? null, rt: result.score });
            }
          }
        } catch {
          // enrichment failure must never break /generate
        }
      }
    }

    // Filter the response the same way /recommendations does, so an engaged title
    // (e.g. a still-pending rec from before it was watched/watchlisted) never shows
    // in the cards immediately after generating.
    const respEngagedIds = getEngagedTitleIds(db, engagementMemberIds(body.profileId));
    const recs = getRecommendations(db, body.profileId, 'pending')
      .filter(r => !respEngagedIds.has(r.title_id))
      .map(enrichRec);
    return c.json(recs);
  });

  api.post('/rate', async (c) => {
    const body = await c.req.json<{ profileId: number; titleId: number; rating: number; note?: string | null }>();
    if (!body.profileId || !body.titleId || body.rating == null) {
      return c.json({ error: 'profileId, titleId, and rating required' }, 400);
    }
    // Ratings are 1–5 stars with half-star steps (the column CHECK enforces 1–5).
    if (body.rating < 1 || body.rating > 5) {
      return c.json({ error: 'rating must be between 1 and 5' }, 400);
    }
    upsertWatchEvent(db, {
      profile_id: body.profileId,
      title_id: body.titleId,
      status: 'watched',
      rating: body.rating,
      watched_at: new Date().toISOString(),
      note: body.note ?? null,
    });
    await refreshTasteVector(db, body.profileId, config);
    return c.json({ ok: true });
  });

  // Save (or clear) a free-text taste note for a title the profile has engaged with.
  // The note is folded into the taste vector, so re-embed afterwards.
  api.post('/note', async (c) => {
    const body = await c.req.json<{ profileId: number; titleId: number; note: string | null }>();
    if (!body.profileId || !body.titleId) return c.json({ error: 'profileId and titleId required' }, 400);
    setWatchNote(db, body.profileId, body.titleId, body.note ?? null);
    await refreshTasteVector(db, body.profileId, config);
    return c.json({ ok: true });
  });

  api.post('/watchlist', async (c) => {
    const body = await c.req.json<{ profileId: number; titleId: number }>();
    if (!body.profileId || !body.titleId) return c.json({ error: 'profileId and titleId required' }, 400);
    upsertWatchEvent(db, {
      profile_id: body.profileId,
      title_id: body.titleId,
      status: 'watchlist',
      rating: null,
      watched_at: null,
    });
    return c.json({ ok: true });
  });

  api.post('/mark-watched', async (c) => {
    const body = await c.req.json<{ profileId: number; titleId: number; rating?: number }>();
    if (!body.profileId || !body.titleId) return c.json({ error: 'profileId and titleId required' }, 400);
    upsertWatchEvent(db, {
      profile_id: body.profileId,
      title_id: body.titleId,
      status: 'watched',
      rating: body.rating ?? null,
      watched_at: new Date().toISOString(),
    });
    if (body.rating) await refreshTasteVector(db, body.profileId, config);
    return c.json({ ok: true });
  });

  api.post('/dismiss', async (c) => {
    const body = await c.req.json<{ profileId: number; recommendationId: number }>();
    if (!body.profileId || !body.recommendationId) {
      return c.json({ error: 'profileId and recommendationId required' }, 400);
    }
    updateRecommendationState(db, body.recommendationId, 'dismissed');
    // "Not interested" is a mild negative signal — fold it into the taste vector.
    await refreshTasteVector(db, body.profileId, config);
    return c.json({ ok: true });
  });

  // Undo a dismiss — restore the rec to pending so it shows in Picks again, and
  // recompute the taste vector so the (now-removed) negative signal stops biasing it.
  api.post('/undismiss', async (c) => {
    const body = await c.req.json<{ profileId: number; recommendationId: number }>();
    if (!body.profileId || !body.recommendationId) {
      return c.json({ error: 'profileId and recommendationId required' }, 400);
    }
    updateRecommendationState(db, body.recommendationId, 'pending');
    await refreshTasteVector(db, body.profileId, config);
    return c.json({ ok: true });
  });

  // Remove a watch_event (un-watch / remove from watchlist) — for things added by mistake.
  api.post('/remove-watch', async (c) => {
    const body = await c.req.json<{ profileId: number; titleId: number }>();
    if (!body.profileId || !body.titleId) return c.json({ error: 'profileId and titleId required' }, 400);
    deleteWatchEvent(db, body.profileId, body.titleId);
    await refreshTasteVector(db, body.profileId, config);
    return c.json({ ok: true });
  });

  // Attach display + detail fields to a watch event so list cards can open a detail view.
  const enrichEvent = (e: { title_id: number }) => {
    const t = getTitleById(db, e.title_id);
    return {
      ...e,
      title: t?.title ?? null,
      year: t?.year ?? null,
      poster_path: t?.poster_path ?? null,
      synopsis: t?.synopsis ?? null,
      media_type: t?.media_type ?? null,
      genres: t?.genres ?? null,
      cast: t?.cast ?? null,
      imdb_id: t?.imdb_id ?? null,
      imdb_rating: t?.imdb_rating ?? null,
      rt_rating: t?.rt_rating ?? null,
      rt_url: t?.rt_url ?? null,
    };
  };

  api.get('/watched/:profileId', (c) => {
    const profileId = parseInt(c.req.param('profileId'));
    if (isNaN(profileId)) return c.json({ error: 'Invalid profileId' }, 400);
    const events = getWatchEvents(db, profileId).filter(e => e.status === 'watched').map(enrichEvent);
    return c.json(events);
  });

  api.get('/watchlist/:profileId', (c) => {
    const profileId = parseInt(c.req.param('profileId'));
    if (isNaN(profileId)) return c.json({ error: 'Invalid profileId' }, 400);
    const events = getWatchEvents(db, profileId).filter(e => e.status === 'watchlist').map(enrichEvent);
    return c.json(events);
  });

  return api;
}
