import type { Profile, Recommendation, WatchEvent } from './types.js';
import { authHeaders, clearToken, promptForToken } from './authToken.js';

const BASE = '/api';

/**
 * fetch() wrapper that attaches the shared-secret bearer token (see
 * authToken.ts) to every /api request. On a 401 (missing/stale/wrong token)
 * it clears the bad token, prompts once for a fresh one, and retries —
 * so a first-time visitor (or a rotated token) gets a single prompt instead
 * of every call silently failing.
 */
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const withAuth = (extra?: HeadersInit): RequestInit => ({
    ...init,
    headers: { ...(init.headers ?? {}), ...(extra ?? authHeaders()) },
  });

  let res = await fetch(`${BASE}${path}`, withAuth());
  if (res.status === 401) {
    clearToken();
    const token = promptForToken();
    if (token) {
      res = await fetch(`${BASE}${path}`, withAuth({ Authorization: `Bearer ${token}` }));
    }
  }
  return res;
}

export async function getProfiles(): Promise<Profile[]> {
  const res = await apiFetch('/profiles');
  if (!res.ok) throw new Error(`getProfiles failed: ${res.status}`);
  return res.json();
}

export interface CatalogueStats { total: number; movie: number; tv: number; }

export async function getStats(): Promise<CatalogueStats> {
  const res = await apiFetch('/stats');
  if (!res.ok) throw new Error(`getStats failed: ${res.status}`);
  return res.json();
}

export interface Calibration {
  count: number;
  avgError: number | null;
  withinOne: number | null;
}

export async function getCalibration(profileId: number): Promise<Calibration> {
  const res = await apiFetch(`/calibration/${profileId}`);
  if (!res.ok) throw new Error(`getCalibration failed: ${res.status}`);
  return res.json();
}

export async function getRecommendations(profileId: number): Promise<Recommendation[]> {
  const res = await apiFetch(`/recommendations/${profileId}`);
  if (!res.ok) throw new Error(`getRecommendations failed: ${res.status}`);
  return res.json();
}

export async function generateRecommendations(opts: {
  profileId: number;
  mediaType?: string;
  genreIds?: number[];
  request?: string;
  surprise?: boolean;
}): Promise<Recommendation[]> {
  const res = await apiFetch('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error(`generate failed: ${res.status}`);
  return res.json();
}

export async function rateTitle(profileId: number, titleId: number, rating: number, note?: string): Promise<void> {
  const res = await apiFetch('/rate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, titleId, rating, note }),
  });
  if (!res.ok) throw new Error(`rate failed: ${res.status}`);
}

export async function saveNote(profileId: number, titleId: number, note: string): Promise<void> {
  const res = await apiFetch('/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, titleId, note: note || null }),
  });
  if (!res.ok) throw new Error(`note failed: ${res.status}`);
}

export async function addToWatchlist(profileId: number, titleId: number): Promise<void> {
  const res = await apiFetch('/watchlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, titleId }),
  });
  if (!res.ok) throw new Error(`watchlist failed: ${res.status}`);
}

export async function markWatched(profileId: number, titleId: number, rating?: number): Promise<void> {
  const res = await apiFetch('/mark-watched', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, titleId, rating }),
  });
  if (!res.ok) throw new Error(`mark-watched failed: ${res.status}`);
}

export async function dismissRecommendation(profileId: number, recommendationId: number): Promise<void> {
  const res = await apiFetch('/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, recommendationId }),
  });
  if (!res.ok) throw new Error(`dismiss failed: ${res.status}`);
}

export async function undismissRecommendation(profileId: number, recommendationId: number): Promise<void> {
  const res = await apiFetch('/undismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, recommendationId }),
  });
  if (!res.ok) throw new Error(`undismiss failed: ${res.status}`);
}

export async function removeWatch(profileId: number, titleId: number): Promise<void> {
  const res = await apiFetch('/remove-watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, titleId }),
  });
  if (!res.ok) throw new Error(`remove-watch failed: ${res.status}`);
}

export async function getWatched(profileId: number): Promise<WatchEvent[]> {
  const res = await apiFetch(`/watched/${profileId}`);
  if (!res.ok) throw new Error(`getWatched failed: ${res.status}`);
  return res.json();
}

export async function getWatchlist(profileId: number): Promise<WatchEvent[]> {
  const res = await apiFetch(`/watchlist/${profileId}`);
  if (!res.ok) throw new Error(`getWatchlist failed: ${res.status}`);
  return res.json();
}

/**
 * Merge a partial config patch into a profile's config JSON (e.g. { rating_threshold: 7 }).
 * Pass null for a key to clear it (e.g. { rating_threshold: null } turns off the filter).
 */
export async function updateProfileConfig(
  profileId: number,
  patch: { rating_threshold?: number | null },
): Promise<void> {
  const res = await apiFetch(`/profile-config/${profileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`updateProfileConfig failed: ${res.status}`);
}
