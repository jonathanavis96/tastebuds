/**
 * Milliseconds for a stored timestamp. Older rows hold SQLite's "YYYY-MM-DD HH:MM:SS"
 * (UTC, no zone marker); newer rows are ISO-8601. Unparseable values sort first.
 * Same rule as frontend/src/lib/time.ts, which the server build cannot import.
 */
export function parseTimestamp(value: string | null | undefined): number {
  if (!value) return -Infinity;
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? -Infinity : t;
}
