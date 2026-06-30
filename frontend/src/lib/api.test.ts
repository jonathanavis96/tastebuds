import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getProfiles, getRecommendations, rateTitle, addToWatchlist, updateProfileConfig } from './api.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getProfiles', () => {
  it('fetches from /api/profiles and returns array', async () => {
    const mockProfiles = [{ id: 1, name: 'Alex', media_weighting: 0.3, is_derived: 0, config: '{}' }];
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(mockProfiles), { status: 200 }));
    const result = await getProfiles();
    expect(fetch).toHaveBeenCalledWith('/api/profiles');
    expect(result).toEqual(mockProfiles);
  });

  it('throws on non-200 response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(getProfiles()).rejects.toThrow('getProfiles failed: 500');
  });
});

describe('getRecommendations', () => {
  it('fetches from /api/recommendations/:profileId', async () => {
    const mockRecs = [{ id: 1, profile_id: 1, title_id: 2, category: 'Top pick', score: 0.9, why_blurb: 'Great', request_text: null, state: 'pending', created_at: '2026-06-22T00:00:00.000Z' }];
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(mockRecs), { status: 200 }));
    const result = await getRecommendations(1);
    expect(fetch).toHaveBeenCalledWith('/api/recommendations/1');
    expect(result).toEqual(mockRecs);
  });
});

describe('rateTitle', () => {
  it('POSTs to /api/rate with correct body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await rateTitle(1, 42, 4);
    expect(fetch).toHaveBeenCalledWith('/api/rate', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ profileId: 1, titleId: 42, rating: 4 }),
    }));
  });
});

describe('addToWatchlist', () => {
  it('POSTs to /api/watchlist', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await addToWatchlist(2, 99);
    expect(fetch).toHaveBeenCalledWith('/api/watchlist', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ profileId: 2, titleId: 99 }),
    }));
  });
});

describe('updateProfileConfig', () => {
  it('PATCHes /api/profile-config/:profileId with the rating threshold', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await updateProfileConfig(1, { rating_threshold: 7 });
    expect(fetch).toHaveBeenCalledWith('/api/profile-config/1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ rating_threshold: 7 }),
    }));
  });

  it('sends null to clear the threshold', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await updateProfileConfig(1, { rating_threshold: null });
    expect(fetch).toHaveBeenCalledWith('/api/profile-config/1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ rating_threshold: null }),
    }));
  });

  it('throws on non-200 response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(updateProfileConfig(1, { rating_threshold: 7 })).rejects.toThrow('updateProfileConfig failed: 500');
  });
});
