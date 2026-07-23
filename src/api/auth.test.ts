import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createRateLimiter } from './auth.js';

function buildApp(max: number) {
  const app = new Hono();
  const limiter = createRateLimiter({ windowMs: 60_000, max, keyPrefix: 'test' });
  app.use('*', limiter);
  app.get('/ping', (c) => c.json({ ok: true }));
  return app;
}

describe('createRateLimiter', () => {
  it('allows up to max requests then 429s', async () => {
    const app = buildApp(3);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await app.request('/ping')).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('does not let a spoofed x-forwarded-for header reset the limit', async () => {
    // Regression test for the X-Forwarded-For spoofing finding: the documented
    // deployments (Docker, bare Node) have no trusted reverse proxy, so a client
    // sending a different x-forwarded-for per request must NOT get a fresh
    // bucket each time — the limiter must key on the real connection, not the
    // header. In this in-process test harness there's no real socket, so every
    // call falls back to the same 'unknown' bucket regardless of the header —
    // which is exactly the point: the header has zero effect on the key.
    const app = buildApp(2);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push(
        (await app.request('/ping', { headers: { 'x-forwarded-for': `10.0.0.${i}` } })).status,
      );
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('keeps GET/other routes independent via keyPrefix namespacing', async () => {
    const app = new Hono();
    const a = createRateLimiter({ windowMs: 60_000, max: 1, keyPrefix: 'a' });
    const b = createRateLimiter({ windowMs: 60_000, max: 1, keyPrefix: 'b' });
    app.get('/a', a, (c) => c.json({ ok: true }));
    app.get('/b', b, (c) => c.json({ ok: true }));

    expect((await app.request('/a')).status).toBe(200);
    expect((await app.request('/a')).status).toBe(429);
    // /b has its own bucket (different keyPrefix) — unaffected by /a's limit.
    expect((await app.request('/b')).status).toBe(200);
  });
});
