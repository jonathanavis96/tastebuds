import type Database from 'better-sqlite3';
import type { ProfileRow } from '../types.js';

export function upsertProfile(
  db: InstanceType<typeof Database>,
  profile: Omit<ProfileRow, 'id'>,
): void {
  db.prepare(`
    INSERT INTO profiles (name, media_weighting, is_derived, config)
    VALUES (@name, @media_weighting, @is_derived, @config)
    ON CONFLICT (name) DO UPDATE SET
      media_weighting = excluded.media_weighting,
      is_derived      = excluded.is_derived,
      config          = excluded.config
  `).run(profile);
}

export function getProfile(
  db: InstanceType<typeof Database>,
  id: number,
): ProfileRow | null {
  return (
    (db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow | undefined) ?? null
  );
}

export function getAllProfiles(db: InstanceType<typeof Database>): ProfileRow[] {
  return db.prepare('SELECT * FROM profiles ORDER BY id').all() as ProfileRow[];
}
