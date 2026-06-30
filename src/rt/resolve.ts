/**
 * Rotten Tomatoes URL resolution helpers.
 * Dependency-free — uses the global fetch (Node 18+).
 */

/**
 * Normalise a title for identity comparison: lowercase, replace punctuation with
 * spaces, collapse whitespace.
 */
export function normaliseTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse the page identity (title + release year) from RT page HTML.
 * Extracts og:title, strips the "- Rotten Tomatoes" suffix, and pulls out a
 * parenthesized year if present. Falls back to JSON year patterns in the body.
 */
export function parsePageIdentity(body: string): { title: string | null; year: number | null } {
  // Support both attribute orderings for the og:title meta tag
  const ogTitleMatch =
    body.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ??
    body.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);

  if (!ogTitleMatch) return { title: null, year: null };

  let rawTitle = ogTitleMatch[1];

  // Strip " - Rotten Tomatoes" or " | Rotten Tomatoes" suffix
  rawTitle = rawTitle.replace(/\s*[-|]\s*Rotten Tomatoes\s*$/i, '').trim();

  // Extract parenthesized year suffix: "Heat (1995)" → year=1995, title="Heat"
  let year: number | null = null;
  const yearMatch = rawTitle.match(/\((\d{4})\)\s*$/);
  if (yearMatch) {
    year = Number(yearMatch[1]);
    rawTitle = rawTitle.replace(/\s*\(\d{4}\)\s*$/, '').trim();
  }

  // Fallback: find year in common RT JSON patterns embedded in the page
  if (year === null) {
    const yearJsonMatch =
      body.match(/"releaseYear"\s*:\s*"?(\d{4})/i) ??
      body.match(/"startYear"\s*:\s*"?(\d{4})/i);
    if (yearJsonMatch) year = Number(yearJsonMatch[1]);
  }

  return { title: rawTitle || null, year };
}

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
 * Attempt to resolve the real Rotten Tomatoes URL for a title, verify the page
 * identity, and scrape the tomatometer score from the page HTML if available.
 *
 * Strategy:
 *  1. Try https://www.rottentomatoes.com/{path}/{slug}
 *  2. If 404 (or non-200), try {slug}_{year} suffix
 *  3. Return null on any failure (network errors included).
 *
 * After fetching a 200 page, the page's og:title and year are compared against
 * the input. On match (title match + year within ±1), returns `verified: true`
 * with the canonical URL and scraped score. On mismatch, returns a search-URL
 * shape: `url = https://www.rottentomatoes.com/search?search=<title>`,
 * `score = null`, `verified = false`.
 *
 * Default fetch follows redirects; response.url is the final URL after any redirect.
 */
export async function resolveRtUrl(
  title: string,
  year: number | null | undefined,
  mediaType: 'movie' | 'tv',
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string; score: string | null; verified: boolean } | null> {
  const path = mediaType === 'movie' ? 'm' : 'tv';
  const slug = slugifyRtTitle(title);
  const searchUrl = `https://www.rottentomatoes.com/search?search=${encodeURIComponent(title)}`;

  const tryPage = async (url: string): Promise<{ url: string; body: string } | null> => {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        redirect: 'follow',
      });
      if (res.status === 200) {
        return { url: res.url, body: await res.text() };
      }
      return null;
    } catch {
      return null;
    }
  };

  const verifyPage = (
    page: { url: string; body: string },
  ): { url: string; score: string | null; verified: boolean } => {
    const identity = parsePageIdentity(page.body);

    // Title must be present and normalised titles must match
    if (!identity.title || normaliseTitle(identity.title) !== normaliseTitle(title)) {
      return { url: searchUrl, score: null, verified: false };
    }

    // Year check: only enforce when both sides have a year; allow ±1 tolerance
    if (identity.year != null && year != null && Math.abs(identity.year - year) > 1) {
      return { url: searchUrl, score: null, verified: false };
    }

    return { url: page.url, score: parseTomatometer(page.body), verified: true };
  };

  // Attempt 1: bare slug
  const url1 = `https://www.rottentomatoes.com/${path}/${slug}`;
  const page1 = await tryPage(url1);
  if (page1 !== null) return verifyPage(page1);

  // Attempt 2: slug with year suffix
  if (year != null) {
    const url2 = `https://www.rottentomatoes.com/${path}/${slug}_${year}`;
    const page2 = await tryPage(url2);
    if (page2 !== null) return verifyPage(page2);
  }

  return null;
}
