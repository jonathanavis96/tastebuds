import type Database from 'better-sqlite3';
import type { WatchEventRow } from '../types.js';

export function upsertWatchEvent(
  db: InstanceType<typeof Database>,
  event: Omit<WatchEventRow, 'id' | 'created_at' | 'note'> & { note?: string | null },
): void {
  // note uses COALESCE on conflict so a later rate/watchlist action that carries no
  // note never wipes an insight the user already wrote for this title.
  db.prepare(`
    INSERT INTO watch_events (profile_id, title_id, status, rating, watched_at, note)
    VALUES (@profile_id, @title_id, @status, @rating, @watched_at, @note)
    ON CONFLICT (profile_id, title_id) DO UPDATE SET
      status     = excluded.status,
      rating     = excluded.rating,
      watched_at = excluded.watched_at,
      note       = COALESCE(excluded.note, watch_events.note)
  `).run({ ...event, note: event.note ?? null });
}

/** Set (or clear) the free-text taste note for an existing watch_event. */
export function setWatchNote(
  db: InstanceType<typeof Database>,
  profileId: number,
  titleId: number,
  note: string | null,
): void {
  db.prepare('UPDATE watch_events SET note = ? WHERE profile_id = ? AND title_id = ?')
    .run(note && note.trim() ? note.trim() : null, profileId, titleId);
}

/** Remove a profile's watch_event for a title (un-watch / remove from watchlist). */
export function deleteWatchEvent(
  db: InstanceType<typeof Database>,
  profileId: number,
  titleId: number,
): void {
  db.prepare('DELETE FROM watch_events WHERE profile_id = ? AND title_id = ?').run(profileId, titleId);
}

export function getWatchEvents(
  db: InstanceType<typeof Database>,
  profileId: number,
): WatchEventRow[] {
  return db
    .prepare('SELECT * FROM watch_events WHERE profile_id = ? ORDER BY created_at DESC')
    .all(profileId) as WatchEventRow[];
}

/** Single watch_event for a profile+title (so a card can show its true watched/rated/note state). */
export function getWatchEvent(
  db: InstanceType<typeof Database>,
  profileId: number,
  titleId: number,
): WatchEventRow | undefined {
  return db
    .prepare('SELECT * FROM watch_events WHERE profile_id = ? AND title_id = ?')
    .get(profileId, titleId) as WatchEventRow | undefined;
}

/**
 * Returns the set of title IDs that a given profile (or set of profiles) has
 * marked as 'watched'. Used to filter pending recs at read-time.
 */
export function getWatchedTitleIds(
  db: InstanceType<typeof Database>,
  profileIds: number[],
): Set<number> {
  if (profileIds.length === 0) return new Set();
  const placeholders = profileIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT title_id FROM watch_events WHERE profile_id IN (${placeholders}) AND status = 'watched'`,
    )
    .all(...profileIds) as Array<{ title_id: number }>;
  return new Set(rows.map(r => r.title_id));
}

/**
 * Returns the set of title IDs a profile (or set of profiles) has ENGAGED with —
 * i.e. has any watch_event marking it 'watched' OR 'watchlist'. An engaged title
 * should never reappear in Picks: a watched title is done, a watchlisted title is
 * already chosen. Used to exclude from the generate candidate pool AND to filter
 * pending recs at read-time. Wider than getWatchedTitleIds (which is watched-only).
 */
export function getEngagedTitleIds(
  db: InstanceType<typeof Database>,
  profileIds: number[],
): Set<number> {
  if (profileIds.length === 0) return new Set();
  const placeholders = profileIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT title_id FROM watch_events WHERE profile_id IN (${placeholders}) AND status IN ('watched','watchlist')`,
    )
    .all(...profileIds) as Array<{ title_id: number }>;
  return new Set(rows.map(r => r.title_id));
}

export function getRatedTitles(
  db: InstanceType<typeof Database>,
  profileId: number,
  minRating: number,
): WatchEventRow[] {
  return db
    .prepare(
      'SELECT * FROM watch_events WHERE profile_id = ? AND rating IS NOT NULL AND rating >= ? ORDER BY rating DESC',
    )
    .all(profileId, minRating) as WatchEventRow[];
}

/**
 * Titles the profile rated at or below `maxRating` — the "Not Your Thing" set.
 * Used to build the negative (anti-taste) signal that pushes recommendations away.
 */
export function getDislikedTitles(
  db: InstanceType<typeof Database>,
  profileId: number,
  maxRating: number,
): WatchEventRow[] {
  return db
    .prepare(
      'SELECT * FROM watch_events WHERE profile_id = ? AND rating IS NOT NULL AND rating <= ? ORDER BY rating ASC',
    )
    .all(profileId, maxRating) as WatchEventRow[];
}
