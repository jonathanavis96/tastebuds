import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { cacheHeaders } from './cacheHeaders.js';

function app() {
  const a = new Hono();
  a.use('*', cacheHeaders);
  a.get('/api/profiles', c => c.json([]));
  a.get('/assets/index-abc123.js', c => c.text('js'));
  a.get('*', c => c.html('<html></html>'));
  return a;
}

describe('cacheHeaders', () => {
  it('makes the browser check the page on every visit, so a deploy is picked up at once', async () => {
    for (const path of ['/', '/index.html', '/watchlist']) {
      expect((await app().request(path)).headers.get('Cache-Control')).toBe('no-cache');
    }
  });

  it('lets the browser keep a content-named script or stylesheet for good', async () => {
    expect((await app().request('/assets/index-abc123.js')).headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('leaves API responses alone', async () => {
    expect((await app().request('/api/profiles')).headers.get('Cache-Control')).toBeNull();
  });
});
