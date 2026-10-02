/**
 * Parse a stored timestamp. New rows are ISO-8601 UTC; older rows hold SQLite's
 * "YYYY-MM-DD HH:MM:SS", which is also UTC but has no zone marker, so it is
 * read as UTC here instead of as local time.
 */
export function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Sort comparator for stored timestamps, by instant. Comparing the raw strings breaks
 * while old ("YYYY-MM-DD HH:MM:SS") and new (ISO) rows are mixed: on the same day the
 * ' ' vs 'T' character decides the order, not the time. Missing or unparseable values
 * sort before every real timestamp, as an empty string did.
 */
export function compareTimestamps(a: string | null | undefined, b: string | null | undefined): number {
  const ta = parseTimestamp(a)?.getTime() ?? -Infinity;
  const tb = parseTimestamp(b)?.getTime() ?? -Infinity;
  return ta === tb ? 0 : ta < tb ? -1 : 1;
}
