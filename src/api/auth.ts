import type { Context, MiddlewareHandler, Next } from 'hono';

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

  const clientKey = (c: Context): string => {
    const fwd = c.req.header('x-forwarded-for');
    const ip = (fwd ? fwd.split(',')[0]?.trim() : undefined)
      || c.req.header('x-real-ip')
      || 'unknown';
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
