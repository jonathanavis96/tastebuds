import type { Context, MiddlewareHandler, Next } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

interface RateLimiterOptions {
  /** Rolling window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per key within the window. */
  max: number;
  /** Namespaces the in-memory bucket map (so two limiters don't share counters). */
  keyPrefix: string;
}

/**
 * Small in-memory fixed-window rate limiter, keyed by caller IP. Deliberately
 * simple (no Redis/deps) — this app runs as a single Node process, so a
 * process-local Map is sufficient. Not shared across restarts or replicas,
 * which is fine for a single-instance self-hosted service.
 */
export function createRateLimiter(opts: RateLimiterOptions): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Keyed by the actual TCP peer address (via @hono/node-server's getConnInfo,
  // which reads the raw socket), NEVER by x-forwarded-for/x-real-ip. The
  // documented deployments (Docker, bare Node) have no trusted reverse proxy
  // sanitizing those headers, so trusting them would let a client spoof a
  // fresh IP per request and evade the limit entirely. A client cannot forge
  // its own socket's peer address. When no real socket is available (e.g. the
  // in-process test harness, which drives the app without a listening server),
  // every caller shares one fallback bucket — still safe, just coarser.
  const clientKey = (c: Context): string => {
    let ip = 'unknown';
    try {
      ip = getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      // Not running under @hono/node-server's serve() — no socket to read.
    }
    return `${opts.keyPrefix}:${ip}`;
  };

  return async (c: Context, next: Next) => {
    const now = Date.now();

    // Opportunistic cleanup so the map can't grow unbounded under sustained traffic.
    if (hits.size > 1000) {
      for (const [k, v] of hits) {
        if (now >= v.resetAt) hits.delete(k);
      }
    }

    const key = clientKey(c);
    let entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > opts.max) {
      c.header('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ error: 'Too many requests' }, 429);
    }
    return next();
  };
}
