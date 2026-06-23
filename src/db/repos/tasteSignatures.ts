import type Database from 'better-sqlite3';
import type { TasteSignatureRow } from '../types.js';

export function upsertTasteSignature(
  db: InstanceType<typeof Database>,
  sig: TasteSignatureRow,
): void {
  db.prepare(`
    INSERT INTO taste_signatures (profile_id, taste_vector, prefs, refreshed_at)
    VALUES (@profile_id, @taste_vector, @prefs, @refreshed_at)
    ON CONFLICT (profile_id) DO UPDATE SET
      taste_vector = excluded.taste_vector,
      prefs        = excluded.prefs,
      refreshed_at = excluded.refreshed_at
  `).run(sig);
}

export function getTasteSignature(
  db: InstanceType<typeof Database>,
  profileId: number,
): TasteSignatureRow | null {
  return (
    (db
      .prepare('SELECT * FROM taste_signatures WHERE profile_id = ?')
      .get(profileId) as TasteSignatureRow | undefined) ?? null
  );
}
