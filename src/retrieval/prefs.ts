/** Shape of a taste_signatures.prefs JSON column. */
export interface PrefsJson {
  loved_genres?: string[];
  hated_genres?: string[];
  loved_themes?: string[];
  hated_themes?: string[];
  preferred_era?: string;
  media_weighting?: number;
}

/**
 * Parse a prefs column. A missing, empty or unreadable value (a hand-edited
 * row) yields empty prefs and logs, so one bad row cannot crash a request.
 */
export function parsePrefs(raw: string | null | undefined): PrefsJson {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as PrefsJson;
    console.warn('Ignoring prefs that are not a JSON object');
  } catch (err) {
    console.warn(`Ignoring unreadable prefs (${String(err)})`);
  }
  return {};
}
