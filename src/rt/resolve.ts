/**
 * Rotten Tomatoes URL resolution helpers.
 * Dependency-free — uses the global fetch (Node 18+).
 */

/**
 * Convert a title string to a Rotten Tomatoes slug.
 * e.g. "They Cloned Tyrone" → "they_cloned_tyrone"
 *      "Spider-Man: No Way Home" → "spider_man_no_way_home"
 */
export function slugifyRtTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['']/g, '')        // remove apostrophes (straight + curly)
    .replace(/[^a-z0-9]+/g, '_')      // non-alphanumeric runs → underscore
    .replace(/^_+|_+$/g, '');         // trim leading/trailing underscores
}

/**
 * Parse the tomatometer score from an RT page body.
 * Looks for the first `"tomatometer":<digits>` match.
 * Returns e.g. "98%" or null if not found.
 */
export function parseTomatometer(body: string): string | null {
  const match = body.match(/"tomatometer"\s*:\s*(\d+)/);
  if (!match) return null;
  return `${match[1]}%`;
}

/**
 * Attempt to resolve the real Rotten Tomatoes URL for a title, and also
 * scrape the tomatometer score from the page HTML if available.
 *
 * Strategy:
 *  1. Try https://www.rottentomatoes.com/{path}/{slug}
 *  2. If 404 (or non-200), try {slug}_{year} suffix
 *  3. Return null on any failure (network errors included).
 *
 * Default fetch follows redirects; response.url is the final URL after any redirect.
 *
 * Returns { url, score } where score is like "98%" or null if not found in page.
 * Returns null (the whole object) only when no valid 200 page resolves.
 */
export async function resolveRtUrl(
  title: string,
  year: number | null | undefined,
  mediaType: 'movie' | 'tv',
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string; score: string | null } | null> {
  const path = mediaType === 'movie' ? 'm' : 'tv';
  const slug = slugifyRtTitle(title);

  const tryUrl = async (url: string): Promise<{ url: string; score: string | null } | null> => {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        redirect: 'follow',
      });
      if (res.status === 200) {
        const body = await res.text();
        return { url: res.url, score: parseTomatometer(body) };
      }
      return null;
    } catch {
      return null;
    }
  };

  // Attempt 1: bare slug
  const url1 = `https://www.rottentomatoes.com/${path}/${slug}`;
  const result1 = await tryUrl(url1);
  if (result1 !== null) return result1;

  // Attempt 2: slug with year suffix
  if (year != null) {
    const url2 = `https://www.rottentomatoes.com/${path}/${slug}_${year}`;
    const result2 = await tryUrl(url2);
    if (result2 !== null) return result2;
  }

  return null;
}
