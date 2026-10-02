import type Database from 'better-sqlite3';
import type { RecommendationRow } from '../types.js';

type UpsertRec = Omit<RecommendationRow, 'id' | 'created_at' | 'kind' | 'predicted_rating' | 'dismiss_reason'> & {
  kind?: 'core' | 'wildcard' | 'adversarial';
  predicted_rating?: number | null;
};

export function upsertRecommendation(
  db: InstanceType<typeof Database>,
  rec: UpsertRec,
): void {
  const row = { ...rec, kind: rec.kind ?? 'core', predicted_rating: rec.predicted_rating ?? null, created_at: new Date().toISOString() };
  // At most one pending rec per (profile_id, title_id) — guarded by the partial
  // unique index (MIGRATE_005). A racing/duplicate pending insert is silently
  // skipped (DO NOTHING) rather than creating a duplicate row or throwing.
  db.prepare(`
    INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, kind, predicted_rating, created_at)
    VALUES (@profile_id, @title_id, @category, @score, @why_blurb, @request_text, @state, @kind, @predicted_rating, @created_at)
    ON CONFLICT (profile_id, title_id) WHERE state = 'pending' DO NOTHING
  `).run(row);
}

export function getRecommendations(
  db: InstanceType<typeof Database>,
  profileId: number,
  state?: string,
): RecommendationRow[] {
  if (state !== undefined) {
    const order = state === 'pending'
      ? 'ORDER BY julianday(created_at) DESC, score DESC'
      : 'ORDER BY score DESC';
    return db
      .prepare(
        `SELECT * FROM recommendations WHERE profile_id = ? AND state = ? ${order}`,
      )
      .all(profileId, state) as RecommendationRow[];
  }
  return db
    .prepare('SELECT * FROM recommendations WHERE profile_id = ? ORDER BY score DESC')
    .all(profileId) as RecommendationRow[];
}

/**
 * Remove a profile's existing pending recommendations so a fresh generate replaces
 * them (no duplicate accumulation). With `upToId`, only pending rows with
 * id <= upToId go, so picks written after that point survive.
 *
 * A pending pick whose title the profile has watched, rated or watchlisted is kept:
 * rating a pick never moves it out of 'pending', and its row holds the
 * predicted_rating that getCalibration pairs with the actual rating. Such picks are
 * already hidden from Picks, so keeping them does not bring them back into the feed.
 */
export function clearPendingRecommendations(
  db: InstanceType<typeof Database>,
  profileId: number,
  upToId?: number,
): void {
  const untouched = 'AND title_id NOT IN (SELECT title_id FROM watch_events WHERE profile_id = ?)';
  if (upToId === undefined) {
    db.prepare(`DELETE FROM recommendations WHERE profile_id = ? AND state = 'pending' ${untouched}`).run(profileId, profileId);
    return;
  }
  db.prepare(`DELETE FROM recommendations WHERE profile_id = ? AND state = 'pending' AND id <= ? ${untouched}`).run(profileId, upToId, profileId);
}

export interface Calibration {
  /** Number of watched+rated titles that also had a predicted rating. */
  count: number;
  /** Mean absolute error between predicted and actual stars (null if count 0). */
  avgError: number | null;
  /** Fraction (0–1) of titles where the prediction was within 1 star (null if count 0). */
  withinOne: number | null;
}

/**
 * Prediction calibration for a profile: compares Sonnet's predicted_rating (set at
 * curation time) against the user's ACTUAL rating, over watched+rated titles that
 * had a prediction. Uses the most recent prediction per title. Empty until picks
 * generated after the predicted_rating feature are watched and rated.
 */
export function getCalibration(
  db: InstanceType<typeof Database>,
  profileId: number,
): Calibration {
  const rows = db.prepare(`
    SELECT we.rating AS actual,
      (SELECT r.predicted_rating FROM recommendations r
        WHERE r.profile_id = we.profile_id AND r.title_id = we.title_id
          AND r.predicted_rating IS NOT NULL
        ORDER BY julianday(r.created_at) DESC LIMIT 1) AS predicted
    FROM watch_events we
    WHERE we.profile_id = ? AND we.status = 'watched' AND we.rating IS NOT NULL
  `).all(profileId) as Array<{ actual: number; predicted: number | null }>;

  const paired = rows.filter(r => r.predicted != null) as Array<{ actual: number; predicted: number }>;
  if (paired.length === 0) return { count: 0, avgError: null, withinOne: null };

  const errors = paired.map(r => Math.abs(r.predicted - r.actual));
  const avgError = errors.reduce((s, e) => s + e, 0) / errors.length;
  const withinOne = errors.filter(e => e <= 1).length / errors.length;
  return { count: paired.length, avgError, withinOne };
}

export function updateRecommendationState(
  db: InstanceType<typeof Database>,
  id: number,
  state: 'pending' | 'shown' | 'dismissed',
): void {
  db.prepare('UPDATE recommendations SET state = ? WHERE id = ?').run(state, id);
}

export function getRecommendationById(
  db: InstanceType<typeof Database>,
  id: number,
): RecommendationRow | null {
  return (
    (db.prepare('SELECT * FROM recommendations WHERE id = ?').get(id) as RecommendationRow | undefined) ?? null
  );
}

/**
 * Record which reason tile the user picked for a dismissed rec (optional follow-up
 * to /dismiss), or clear it (pass null — used on /undismiss so a restored rec
 * doesn't keep a stale reason from a previous dismissal).
 */
export function setDismissReason(
  db: InstanceType<typeof Database>,
  id: number,
  reason: string | null,
): void {
  db.prepare('UPDATE recommendations SET dismiss_reason = ? WHERE id = ?').run(reason, id);
}
