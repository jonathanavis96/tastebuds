import type Database from 'better-sqlite3';
import type { RecommendationRow } from '../types.js';

type UpsertRec = Omit<RecommendationRow, 'id' | 'created_at' | 'kind'> & {
  kind?: 'core' | 'wildcard' | 'adversarial';
};

export function upsertRecommendation(
  db: InstanceType<typeof Database>,
  rec: UpsertRec,
): void {
  const row = { ...rec, kind: rec.kind ?? 'core' };
  // At most one pending rec per (profile_id, title_id) — guarded by the partial
  // unique index (MIGRATE_005). A racing/duplicate pending insert is silently
  // skipped (DO NOTHING) rather than creating a duplicate row or throwing.
  db.prepare(`
    INSERT INTO recommendations (profile_id, title_id, category, score, why_blurb, request_text, state, kind)
    VALUES (@profile_id, @title_id, @category, @score, @why_blurb, @request_text, @state, @kind)
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
      ? 'ORDER BY created_at DESC, score DESC'
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

/** Remove a profile's existing pending recommendations so a fresh generate replaces them (no duplicate accumulation). */
export function clearPendingRecommendations(
  db: InstanceType<typeof Database>,
  profileId: number,
): void {
  db.prepare("DELETE FROM recommendations WHERE profile_id = ? AND state = 'pending'").run(profileId);
}

export function updateRecommendationState(
  db: InstanceType<typeof Database>,
  id: number,
  state: 'pending' | 'shown' | 'dismissed',
): void {
  db.prepare('UPDATE recommendations SET state = ? WHERE id = ?').run(state, id);
}
