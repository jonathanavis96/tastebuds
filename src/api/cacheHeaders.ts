import type { MiddlewareHandler } from 'hono';

/**
 * Cache rules for the frontend. The build names each script and stylesheet
 * after its content (/assets/index-<hash>.js), so those can be kept for good;
 * the page that names them must be checked on every visit. Without a rule a
 * browser guesses how long to keep the page, and after a deploy it kept running
 * the old script against the new API: an empty Picks list, with no error.
 * API responses are left alone.
 */
export const cacheHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const path = c.req.path;
  if (path.startsWith('/api/')) return;
  c.header('Cache-Control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
};
