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
