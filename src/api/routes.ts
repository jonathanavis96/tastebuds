import { Hono } from 'hono';
import type { Database } from 'better-sqlite3';
import type { Config } from '../config.js';
import { getAllProfiles, getProfile } from '../db/repos/profiles.js';
import { getRecommendations, updateRecommendationState } from '../db/repos/recommendations.js';
import { upsertWatchEvent, getWatchEvents, getEngagedTitleIds, deleteWatchEvent, setWatchNote, getWatchEvent } from '../db/repos/watchEvents.js';
import { getTitleById, updateTitleRatings, updateTitleRtUrl } from '../db/repos/titles.js';
import { retrieveCandidatePool, retrieveJointCandidatePool, retrieveRequestCandidates, retrieveJointRequestCandidates } from '../retrieval/retrieve.js';
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
    if (profile.is_derived) {
      // A derived (Joint) profile blends the two solo vectors; it has no own taste_vector and may have no signature row.
      sig = sig ?? { profile_id: body.profileId, taste_vector: null, prefs: '{}', refreshed_at: new Date().toISOString() };
    } else if (!sig || !sig.taste_vector) {
      return c.json({ error: 'No taste signature for profile' }, 400);
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
    let candidatePool;
    if (profile.is_derived) {
      const [soloA, soloB] = soloProfileIds();
      if (soloA == null || soloB == null)
        return c.json({ error: 'Two solo profiles are required for a Joint blend' }, 400);
      const jointOpts = { mediaType, genreIds: body.genreIds, excludeTitleIds, jointProfileId: body.profileId };
      candidatePool = hasRequest
        ? await retrieveJointRequestCandidates(db, soloA, soloB, request!, jointOpts, config)
        : await retrieveJointCandidatePool(db, soloA, soloB, jointOpts, config);
    } else {
      const soloOpts = { mediaType, genreIds: body.genreIds, excludeTitleIds };
      candidatePool = hasRequest
        ? await retrieveRequestCandidates(db, body.profileId, request!, soloOpts, config)
        : await retrieveCandidatePool(db, body.profileId, soloOpts, config);
    }

    await curateCandidates(candidatePool, profile, sig, body.request ?? null, config, db, undefined, balanceMedia, body.surprise === true);

    // OMDb enrichment — non-fatal; only for titles that have an imdb_id and no cached rating
    if (config.omdbApiKey) {
      const pendingRecs = getRecommendations(db, body.profileId, 'pending');
      for (const rec of pendingRecs) {
        try {
          const t = getTitleById(db, rec.title_id);
          if (t?.imdb_id && t.imdb_rating == null) {
            const ratings = await getOmdbRatings(t.imdb_id, config);
            updateTitleRatings(db, t.id, { imdb: ratings.imdb, rt: ratings.rottenTomatoes });
          }
        } catch {
          // enrichment failure must never break /generate
        }
      }
    }

    // RT URL resolution — non-fatal; resolve and store the real RT URL (and scraped
    // tomatometer score) for any pending rec whose title doesn't yet have one.
    {
      const pendingRecs = getRecommendations(db, body.profileId, 'pending');
      for (const rec of pendingRecs) {
        try {
          const t = getTitleById(db, rec.title_id);
          if (t && !t.rt_url) {
            const result = await resolveRtUrl(t.title, t.year, t.media_type);
            updateTitleRtUrl(db, t.id, result?.url ?? null);
            // Only store the scraped RT score when OMDb hasn't already provided one
            if (result?.score && t.rt_rating == null) {
              updateTitleRatings(db, t.id, { imdb: t.imdb_rating ?? null, rt: result.score });
            }
          }
        } catch {
          // RT resolution failure must never break /generate
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
