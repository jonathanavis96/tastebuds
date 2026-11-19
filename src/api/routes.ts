import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Config } from '../config.js';
import { ensurePosterCached } from '../posters/posterCache.js';
import { getAllProfiles, patchProfileConfig } from '../db/repos/profiles.js';
import { archivePendingBeyond, updateRecommendationState, getCalibration, getRecommendationById, setDismissReason } from '../db/repos/recommendations.js';
import { upsertWatchEvent, getWatchEvents, deleteWatchEvent, setWatchNote, getWatchEvent } from '../db/repos/watchEvents.js';
import { getTitleById, countTitles } from '../db/repos/titles.js';
import { refreshTasteVector } from '../retrieval/retrieve.js';
import { applyDismissReasonToPrefs, removeDismissReasonFromPrefs, DISMISS_REASON_TILES, type DismissReason } from '../curation/dismissFeedback.js';
import { createRateLimiter } from './auth.js';
import { tasteChartForProfile } from '../retrieval/tasteChart.js';
import { feedFor } from './feed.js';
import { generatePicks, type GenerateBody } from './generate.js';

export function createApiRoutes(db: Database, config: Config): Hono {
  const api = new Hono();

  // Rate limiting — this is a single-user LAN/Tailscale-only tool (no public
  // internet exposure, no per-caller auth token), but /generate spawns a paid
  // `claude -p` subprocess per call, so a runaway/misbehaving client still
  // shouldn't be able to hammer the DB or rack up unlimited API cost.
  // General cap on all mutating (non-GET) endpoints.
  const mutationLimiter = createRateLimiter({ windowMs: 60_000, max: 30, keyPrefix: 'mutate' });
  api.use('*', async (c, next) => {
    if (c.req.method === 'GET') return next();
    return mutationLimiter(c, next);
  });
  // Tighter, dedicated cap on /generate specifically — it's the expensive one
  // (spawns `claude -p`), so it gets its own stricter budget on top.
  const generateLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 5, keyPrefix: 'generate' });
  api.use('/generate', generateLimiter);
  // One /generate at a time per profile. A generate decides whether to clear the
  // profile's old pending picks by looking for pending rows newer than the ones it
  // started with, so an overlapping generate for the same profile could otherwise
  // see the other call's picks as its own and clear picks it should have kept.
  const generateQueue = new Map<number, Promise<void>>();
  api.use('/generate', async (c, next) => {
    let profileId: unknown;
    try {
      profileId = (await c.req.json<{ profileId?: unknown }>())?.profileId;
    } catch {
      return next(); // the handler reports the bad body
    }
    if (typeof profileId !== 'number') return next();
    const previous = generateQueue.get(profileId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => mine);
    generateQueue.set(profileId, tail);
    await previous;
    try {
      await next();
    } finally {
      release();
      if (generateQueue.get(profileId) === tail) generateQueue.delete(profileId);
    }
  });

  api.get('/profiles', (c) => {
    const profiles = getAllProfiles(db);
    return c.json(profiles);
  });

  // Per-profile taste chart (radar): genre spokes chosen from the household's ratings. DB-only.
  api.get('/taste-chart/:profileId', (c) => {
    const id = Number(c.req.param('profileId'));
    if (!Number.isInteger(id)) return c.json({ error: 'Invalid profileId' }, 400);
    const chart = tasteChartForProfile(db, id);
    if (!chart) return c.json({ error: 'Profile not found' }, 404);
    return c.json(chart);
  });

  // Catalogue size readout for the header — total titles + movie/series split.
  api.get('/stats', (c) => {
    return c.json(countTitles(db));
  });

  // Update known keys in a profile's config JSON (partial merge — existing keys preserved).
  // Used by the frontend to persist per-profile preferences (currently just rating_threshold).
  // The patch is allowlisted + type-checked rather than merged verbatim: an unvalidated
  // merge would let a caller inject arbitrary keys/oversized blobs into the stored config.
  const PROFILE_CONFIG_ALLOWED_KEYS = new Set(['rating_threshold']);
  api.patch('/profile-config/:profileId', async (c) => {
    const profileId = Number(c.req.param('profileId'));
    if (!Number.isFinite(profileId)) return c.json({ error: 'invalid profileId' }, 400);
    const body = await c.req.json<Record<string, unknown>>();
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body ?? {})) {
      if (!PROFILE_CONFIG_ALLOWED_KEYS.has(key)) continue;
      if (key === 'rating_threshold' && value !== null && typeof value !== 'number') continue;
      patch[key] = value;
    }
    if (Object.keys(patch).length === 0) return c.json({ error: 'no valid config keys in patch' }, 400);
    const ok = patchProfileConfig(db, profileId, patch);
    if (!ok) return c.json({ error: 'Profile not found' }, 404);
    return c.json({ ok: true });
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

  // Runs after a change is already stored, so a failed refresh (Ollama down) must not
  // report that change as failed. The next successful refresh rebuilds from all history.
  const refreshTaste = async (profileId: number): Promise<void> => {
    try {
      await refreshTasteVector(db, profileId, config);
    } catch (err) {
      console.warn(`[tastebuds] taste refresh failed for profile ${profileId}: ${String(err)}`);
    }
  };

  api.get('/recommendations/:profileId', (c) => {
    const profileId = parseInt(c.req.param('profileId'));
    if (isNaN(profileId)) return c.json({ error: 'Invalid profileId' }, 400);

    // Hide any title the profile has ENGAGED with — watched OR on the watchlist.
    // A watched title is done; a watchlisted title is already chosen. Neither should
    // remain in Picks. (Was watched-only before, so watchlist items leaked through.)
    return c.json(feedFor(db, config, profileId));
  });

  // "Clear list": every pick leaves Picks (kept as 'shown', see archivePendingBeyond).
  api.post('/recommendations/:profileId/clear', (c) => {
    const profileId = parseInt(c.req.param('profileId'));
    if (isNaN(profileId)) return c.json({ error: 'Invalid profileId' }, 400);
    archivePendingBeyond(db, profileId, 0);
    return c.json(feedFor(db, config, profileId));
  });

  // The work lives in generatePicks (src/api/generate.ts), so the replay tool
  // can call it without HTTP; the limits and the per-profile queue stay here.
  api.post('/generate', async (c) => {
    const outcome = await generatePicks(db, config, await c.req.json<GenerateBody>());
    return outcome.ok ? c.json(outcome.feed) : c.json({ error: outcome.error }, outcome.status);
  });

  api.post('/rate', async (c) => {
    const body = await c.req.json<{ profileId: number; titleId: number; rating: number; note?: string | null }>();
    if (!body.profileId || !body.titleId || body.rating == null) {
      return c.json({ error: 'profileId, titleId, and rating required' }, 400);
    }
    // Ratings are 1–5 stars with half-star steps (the column CHECK enforces 1–5).
    if (!isValidRating(body.rating)) {
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
    await refreshTaste(body.profileId);
    return c.json({ ok: true });
  });

  // Save (or clear) a free-text taste note for a title the profile has engaged with.
  // The note is folded into the taste vector, so re-embed afterwards.
  api.post('/note', async (c) => {
    const body = await c.req.json<{ profileId: number; titleId: number; note: string | null }>();
    if (!body.profileId || !body.titleId) return c.json({ error: 'profileId and titleId required' }, 400);
    setWatchNote(db, body.profileId, body.titleId, body.note ?? null);
    await refreshTaste(body.profileId);
    return c.json({ ok: true });
  });

  api.post('/watchlist', async (c) => {
    const body = await c.req.json<{ profileId: number; titleId: number }>();
    if (!body.profileId || !body.titleId) return c.json({ error: 'profileId and titleId required' }, 400);
    // A title already watched (and possibly rated) stays as it is: overwriting it
    // with a watchlist row would erase the rating and drop it from the taste vector.
    if (getWatchEvent(db, body.profileId, body.titleId)?.status === 'watched') {
      return c.json({ ok: true });
    }
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
    if (body.rating != null && !isValidRating(body.rating)) {
      return c.json({ error: 'rating must be between 1 and 5' }, 400);
    }
    upsertWatchEvent(db, {
      profile_id: body.profileId,
      title_id: body.titleId,
      status: 'watched',
      rating: body.rating ?? null,
      watched_at: new Date().toISOString(),
    });
    if (body.rating) await refreshTaste(body.profileId);
    return c.json({ ok: true });
  });

  api.post('/dismiss', async (c) => {
    const body = await c.req.json<{ profileId: number; recommendationId: number }>();
    if (!body.profileId || !body.recommendationId) {
      return c.json({ error: 'profileId and recommendationId required' }, 400);
    }
    // Same ownership check as /dismiss-reason: one profile must not dismiss another's rec.
    const rec = getRecommendationById(db, body.recommendationId);
    if (!rec || rec.profile_id !== body.profileId) {
      return c.json({ error: 'recommendation not found' }, 404);
    }
    updateRecommendationState(db, body.recommendationId, 'dismissed');
    // "Not interested" is a mild negative signal — fold it into the taste vector.
    await refreshTaste(body.profileId);
    return c.json({ ok: true });
  });

  // Optional follow-up to /dismiss: the user tapped a "why" reason tile. Stores
  // the chosen reason on the rec row and — for the tiles that map to a durable
  // taste signal (not_my_genre / seen_enough → hated_genres, too_dark →
  // hated_themes) — merges it into the profile's prefs so future retrieval
  // steers away from it. cast_vibe / not_in_mood store the
  // reason but write back nothing (see applyDismissReasonToPrefs).
  const dismissReasonKeys = new Set(DISMISS_REASON_TILES.map(t => t.key));
  api.post('/dismiss-reason', async (c) => {
    const body = await c.req.json<{ profileId: number; recommendationId: number; reason: DismissReason }>();
    if (!body.profileId || !body.recommendationId || !dismissReasonKeys.has(body.reason)) {
      return c.json({ error: 'profileId, recommendationId and a valid reason are required' }, 400);
    }
    const rec = getRecommendationById(db, body.recommendationId);
    // Ownership check folded into the same 404 as a genuinely missing rec, so a
    // caller can't distinguish "doesn't exist" from "belongs to another profile"
    // (an IDOR — profile B posting profile A's rec must not write into A's prefs
    // or B's, and must not reveal that the rec exists at all).
    if (!rec || rec.profile_id !== body.profileId) {
      return c.json({ error: 'recommendation not found' }, 404);
    }
    // A reason only makes sense for a rec that was actually dismissed — otherwise
    // a caller could write reason-derived hated_genres/hated_themes for a title
    // the user never rejected.
    if (rec.state !== 'dismissed') {
      return c.json({ error: 'recommendation is not dismissed' }, 409);
    }
    // Re-selecting the same tile is a harmless no-op (the merge is idempotent).
    if (rec.dismiss_reason === body.reason) {
      return c.json({ ok: true });
    }
    // The user is switching tiles (e.g. "not my genre" → "too dark"). Reverse
    // whatever the PREVIOUS reason wrote back before applying the new one —
    // otherwise both reasons' signals accumulate (stale hated_genres left
    // behind after switching to a reason that writes to hated_themes instead).
    if (rec.dismiss_reason) {
      try {
        removeDismissReasonFromPrefs(db, body.profileId, rec.title_id, rec.dismiss_reason as DismissReason);
      } catch {
        // non-fatal — affinity persistence must not break the dismiss flow
      }
    }
    setDismissReason(db, body.recommendationId, body.reason);
    try {
      applyDismissReasonToPrefs(db, body.profileId, rec.title_id, body.reason);
    } catch {
      // non-fatal — affinity persistence must not break the dismiss flow
    }
    return c.json({ ok: true });
  });

  // Undo a dismiss — restore the rec to pending so it shows in Picks again, and
  // recompute the taste vector so the (now-removed) negative signal stops biasing it.
  api.post('/undismiss', async (c) => {
    const body = await c.req.json<{ profileId: number; recommendationId: number }>();
    if (!body.profileId || !body.recommendationId) {
      return c.json({ error: 'profileId and recommendationId required' }, 400);
    }
    const rec = getRecommendationById(db, body.recommendationId);
    // Same ownership check as /dismiss-reason: a rec that belongs to a different
    // profile must not be touched (state flipped, or its reason reversed into
    // the wrong profile's prefs) by this call.
    if (rec && rec.profile_id !== body.profileId) {
      return c.json({ error: 'recommendation not found' }, 404);
    }
    updateRecommendationState(db, body.recommendationId, 'pending');
    // Reverse any reason-tile write-back so the negative signal doesn't outlive
    // the dismissal it came from, then clear the stored reason itself.
    if (rec?.dismiss_reason) {
      try {
        removeDismissReasonFromPrefs(db, body.profileId, rec.title_id, rec.dismiss_reason as DismissReason);
      } catch {
        // non-fatal — undo must not be blocked by a failed prefs cleanup
      }
      setDismissReason(db, body.recommendationId, null);
    }
    await refreshTaste(body.profileId);
    return c.json({ ok: true });
  });

  // Remove a watch_event (un-watch / remove from watchlist) — for things added by mistake.
  api.post('/remove-watch', async (c) => {
    const body = await c.req.json<{ profileId: number; titleId: number }>();
    if (!body.profileId || !body.titleId) return c.json({ error: 'profileId and titleId required' }, 400);
    deleteWatchEvent(db, body.profileId, body.titleId);
    await refreshTaste(body.profileId);
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

/** A star rating: a number from 1 to 5 in half-star steps. */
function isValidRating(r: unknown): r is number {
  return typeof r === 'number' && Number.isFinite(r) && r >= 1 && r <= 5 && Number.isInteger(r * 2);
}
