/**
 * Rotten Tomatoes URL resolution helpers.
 * Dependency-free — uses the global fetch (Node 18+).
 */

/** Per page: /generate walks every pending pick, so a stalled site must not hold it. */
const RT_TIMEOUT_MS = 10_000;

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
  // Support both attribute orderings for the og:title meta tag, and allow
  // arbitrary extra attributes between property and content (e.g. data-x="y").
  const ogTitleMatch =
    body.match(/<meta\b[^>]*\bproperty=["']og:title["'][^>]*\bcontent=["']([^"']+)["']/i) ??
    body.match(/<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:title["']/i);

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

  // Fallback: find year in common RT JSON patterns embedded in the page. Some
  // pages carry only the JSON-LD release date (dateCreated), and without a year
  // a same-named film from another decade would pass on its title alone.
  if (year === null) {
    const yearJsonMatch =
      body.match(/"releaseYear"\s*:\s*"?(\d{4})/i) ??
      body.match(/"startYear"\s*:\s*"?(\d{4})/i) ??
      body.match(/"dateCreated"\s*:\s*"(\d{4})-/);
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

/** Every `<script>` body whose opening tag matches `attr` (e.g. `type="application/ld+json"`). */
function scriptBodies(body: string, attr: RegExp): string[] {
  const bodies: string[] = [];
  for (const m of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (attr.test(m[1])) bodies.push(m[2]);
  }
  return bodies;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** "96", 96 or "96%" → "96%"; anything else (empty, "--", missing) → null. */
function asPercent(value: unknown): string | null {
  const match = String(value ?? '').trim().match(/^(\d{1,3})%?$/);
  return match ? `${match[1]}%` : null;
}

/** The ratingValue of an aggregateRating named "Tomatometer" anywhere in a JSON-LD document. */
function findTomatometerRating(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findTomatometerRating(item);
      if (found) return found;
    }
    return null;
  }
  if (node == null || typeof node !== 'object') return null;
  const rating = (node as Record<string, unknown>).aggregateRating as Record<string, unknown> | undefined;
  if (rating?.name === 'Tomatometer') return asPercent(rating.ratingValue);
  return findTomatometerRating((node as Record<string, unknown>)['@graph'] ?? null);
}

/**
 * The page's own critics score, e.g. "96%", or null when the page shows none.
 *
 * Read from the page's JSON-LD (`aggregateRating` named "Tomatometer"), else from
 * the media scorecard (`criticsScore.scorePercent`). Every page, the 404 page too,
 * also carries a site-wide trending block full of `"tomatometer":NN` values for
 * other titles, so a loose pattern over the whole page is never used.
 */
export function parseTomatometer(body: string): string | null {
  for (const ld of scriptBodies(body, /type=["']application\/ld\+json["']/i)) {
    const score = findTomatometerRating(parseJson(ld));
    if (score) return score;
  }
  for (const card of scriptBodies(body, /id=["']media-scorecard-json["']/i)) {
    const data = parseJson(card) as { criticsScore?: { scorePercent?: unknown } } | null;
    const score = asPercent(data?.criticsScore?.scorePercent);
    if (score) return score;
  }
  return null;
}

/** True when the page is the title asked for: same normalised title, year within one when both are known. */
function pageMatches(body: string, title: string, year: number | null | undefined): boolean {
  const identity = parsePageIdentity(body);
  if (!identity.title || normaliseTitle(identity.title) !== normaliseTitle(title)) return false;
  return identity.year == null || year == null || Math.abs(identity.year - year) <= 1;
}

const RT_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

/**
 * What one known Rotten Tomatoes page says now.
 *  - `{ verified: true, url, score }`: the page is this title (same check as
 *    resolveRtUrl); `url` is where any redirect ended; `score` is null when the
 *    page has no critics score.
 *  - `{ verified: false }`: the site answered but the page is not this title
 *    (a 404, or a redirect to another title).
 *  - `null`: no answer (network error, timeout, blocked or server error).
 */
export async function readRtScore(
  url: string,
  title: string,
  year: number | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ verified: true; url: string; score: string | null } | { verified: false } | null> {
  try {
    const res = await fetchImpl(url, {
      headers: RT_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(RT_TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 410) return { verified: false };
    if (res.status !== 200) return null;
    const body = await res.text();
    if (!pageMatches(body, title, year)) return { verified: false };
    return { verified: true, url: res.url || url, score: parseTomatometer(body) };
  } catch {
    return null;
  }
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
        headers: RT_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(RT_TIMEOUT_MS),
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
  ): { url: string; score: string | null; verified: boolean } =>
    pageMatches(page.body, title, year)
      ? { url: page.url, score: parseTomatometer(page.body), verified: true }
      : { url: searchUrl, score: null, verified: false };

  // Attempt 1: bare slug
  const url1 = `https://www.rottentomatoes.com/${path}/${slug}`;
  const page1 = await tryPage(url1);
  let gotAnyPage = false;
  if (page1 !== null) {
    gotAnyPage = true;
    const result1 = verifyPage(page1);
    if (result1.verified) return result1;
    // 200 but wrong identity — fall through and try the year-suffixed URL before giving up
  }

  // Attempt 2: slug with year suffix.
  // Tried whenever url1 was a 404 OR returned a 200 with a mismatched identity.
  if (year != null) {
    const url2 = `https://www.rottentomatoes.com/${path}/${slug}_${year}`;
    const page2 = await tryPage(url2);
    if (page2 !== null) {
      gotAnyPage = true;
      const result2 = verifyPage(page2);
      if (result2.verified) return result2;
    }
  }

  // Neither attempt produced a verified match.
  // If we received at least one 200 page (wrong content), return a search-URL fallback
  // so the caller can surface something to the user. If both 404'd, return null.
  return gotAnyPage ? { url: searchUrl, score: null, verified: false } : null;
}
