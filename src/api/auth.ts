import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler, Next } from 'hono';

/**
 * Constant-time string comparison (avoids leaking the secret via response-time
 * side channels). `timingSafeEqual` throws on mismatched lengths, so a length
 * mismatch is handled separately — but we still perform a dummy compare first
 * so the overall timing doesn't trivially reveal "wrong length" vs "wrong value".
 */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Compare bufB against itself so the call takes comparable time either way,
    // then report the real (false) result.
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Requires `Authorization: Bearer <token>` matching the configured shared
 * secret (`TASTEBUDS_TOKEN`). This is the only gate in front of every /api
 * route — without it any caller who can reach the port can read/write any
 * profileId (IDOR) and trigger the paid `claude -p` subprocess via /generate.
 * Since this repo is also distributed publicly, a self-hosted deployment
 * exposed to a LAN/the internet must not be reachable without this token.
 */
export function createAuthMiddleware(token: string): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const header = c.req.header('Authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!provided || !constantTimeEqual(provided, token)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  };
}

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
