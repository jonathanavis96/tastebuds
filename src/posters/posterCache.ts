import fs from 'node:fs';
import path from 'node:path';

/**
 * Local poster cache. We display TMDB posters at w342 in every grid; rather than
 * depend on TMDB's CDN at view-time (slow, and unreachable if TMDB is down or the
 * box is offline), we fetch each poster ONCE on first display and cache it to disk
 * under the persistent data volume. ~39 KB per poster, a few hundred displayed
 * titles → well under 20 MB total. Zoom (w780) still hits TMDB directly.
 */
export interface PosterCacheDeps {
  /** Directory cached JPEGs live in (created on demand). */
  posterDir: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** TMDB size bucket. Defaults to w342 (the grid display size). */
  size?: number;
}

/** Absolute path of the cached file for a title (does not imply it exists yet). */
export function posterFilePath(posterDir: string, titleId: number): string {
  return path.join(posterDir, `${titleId}.jpg`);
}

/**
 * Ensure the w342 poster for `titleId` is cached locally, fetching it from TMDB on
 * a miss. Returns the file path, or null if there's no poster or the fetch failed
 * (callers serve a placeholder in that case). Concurrent misses for the same title
 * are harmless — both write identical bytes.
 */
export async function ensurePosterCached(
  posterPath: string,
  titleId: number,
  deps: PosterCacheDeps,
): Promise<string | null> {
  const file = posterFilePath(deps.posterDir, titleId);
  if (fs.existsSync(file)) return file;

  const size = deps.size ?? 342;
  const url = `https://image.tmdb.org/t/p/w${size}${posterPath}`;
  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) return null;
  fs.mkdirSync(deps.posterDir, { recursive: true });
  // Write atomically (tmp + rename) so a half-written file is never served.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return file;
}
