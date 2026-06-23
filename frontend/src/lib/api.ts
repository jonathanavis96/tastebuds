import type { Profile, Recommendation, WatchEvent } from './types.js';

const BASE = '/api';

export async function getProfiles(): Promise<Profile[]> {
  const res = await fetch(`${BASE}/profiles`);
  if (!res.ok) throw new Error(`getProfiles failed: ${res.status}`);
  return res.json();
}

export async function getRecommendations(profileId: number): Promise<Recommendation[]> {
  const res = await fetch(`${BASE}/recommendations/${profileId}`);
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
  const res = await fetch(`${BASE}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error(`generate failed: ${res.status}`);
  return res.json();
}

export async function rateTitle(profileId: number, titleId: number, rating: number, note?: string): Promise<void> {
  const res = await fetch(`${BASE}/rate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, titleId, rating, note }),
  });
  if (!res.ok) throw new Error(`rate failed: ${res.status}`);
}

export async function saveNote(profileId: number, titleId: number, note: string): Promise<void> {
  const res = await fetch(`${BASE}/note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, titleId, note: note || null }),
  });
  if (!res.ok) throw new Error(`note failed: ${res.status}`);
}

export async function addToWatchlist(profileId: number, titleId: number): Promise<void> {
  const res = await fetch(`${BASE}/watchlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, titleId }),
  });
  if (!res.ok) throw new Error(`watchlist failed: ${res.status}`);
}

export async function markWatched(profileId: number, titleId: number, rating?: number): Promise<void> {
  const res = await fetch(`${BASE}/mark-watched`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, titleId, rating }),
  });
  if (!res.ok) throw new Error(`mark-watched failed: ${res.status}`);
}

export async function dismissRecommendation(profileId: number, recommendationId: number): Promise<void> {
  const res = await fetch(`${BASE}/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, recommendationId }),
  });
  if (!res.ok) throw new Error(`dismiss failed: ${res.status}`);
}

export async function removeWatch(profileId: number, titleId: number): Promise<void> {
  const res = await fetch(`${BASE}/remove-watch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, titleId }),
  });
  if (!res.ok) throw new Error(`remove-watch failed: ${res.status}`);
}

export async function getWatched(profileId: number): Promise<WatchEvent[]> {
  const res = await fetch(`${BASE}/watched/${profileId}`);
  if (!res.ok) throw new Error(`getWatched failed: ${res.status}`);
  return res.json();
}

export async function getWatchlist(profileId: number): Promise<WatchEvent[]> {
  const res = await fetch(`${BASE}/watchlist/${profileId}`);
  if (!res.ok) throw new Error(`getWatchlist failed: ${res.status}`);
  return res.json();
}
