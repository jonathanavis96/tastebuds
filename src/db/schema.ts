export const CREATE_TITLES = `
  CREATE TABLE IF NOT EXISTS titles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id     INTEGER NOT NULL,
    media_type  TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
    title       TEXT NOT NULL,
    year        INTEGER,
    genres      TEXT NOT NULL DEFAULT '[]',
    keywords    TEXT NOT NULL DEFAULT '[]',
    cast        TEXT NOT NULL DEFAULT '[]',
    synopsis    TEXT,
    poster_path TEXT,
    embedding   BLOB,
    updated_at  TEXT NOT NULL,
    imdb_id     TEXT,
    imdb_rating TEXT,
    rt_rating   TEXT,
    rt_url      TEXT,
    UNIQUE (tmdb_id, media_type)
  )
`;

export const MIGRATE_002_ADD_IMDB_COLS = [
  `ALTER TABLE titles ADD COLUMN imdb_id TEXT`,
  `ALTER TABLE titles ADD COLUMN imdb_rating TEXT`,
  `ALTER TABLE titles ADD COLUMN rt_rating TEXT`,
];

export const MIGRATE_003_ADD_RT_URL = [
  `ALTER TABLE titles ADD COLUMN rt_url TEXT`,
];

export const CREATE_PROFILES = `
  CREATE TABLE IF NOT EXISTS profiles (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL UNIQUE,
    media_weighting  REAL NOT NULL DEFAULT 0.5,
    is_derived       INTEGER NOT NULL DEFAULT 0,
    config           TEXT NOT NULL DEFAULT '{}'
  )
`;

export const CREATE_TASTE_SIGNATURES = `
  CREATE TABLE IF NOT EXISTS taste_signatures (
    profile_id   INTEGER PRIMARY KEY REFERENCES profiles(id),
    taste_vector BLOB,
    prefs        TEXT NOT NULL DEFAULT '{}',
    refreshed_at TEXT NOT NULL
  )
`;

export const CREATE_WATCH_EVENTS = `
  CREATE TABLE IF NOT EXISTS watch_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    title_id   INTEGER NOT NULL REFERENCES titles(id),
    status     TEXT NOT NULL CHECK (status IN ('watchlist', 'watched')),
    rating     INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
    watched_at TEXT,
    note       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (profile_id, title_id)
  )
`;

export const MIGRATE_004_ADD_NOTE = [
  `ALTER TABLE watch_events ADD COLUMN note TEXT`,
];

export const CREATE_RECOMMENDATIONS = `
  CREATE TABLE IF NOT EXISTS recommendations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id   INTEGER NOT NULL REFERENCES profiles(id),
    title_id     INTEGER NOT NULL REFERENCES titles(id),
    category     TEXT NOT NULL,
    score        REAL NOT NULL,
    why_blurb    TEXT NOT NULL,
    request_text TEXT,
    state        TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'shown', 'dismissed')),
    kind         TEXT NOT NULL DEFAULT 'core',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

export const MIGRATE_001_ADD_KIND = `
  ALTER TABLE recommendations ADD COLUMN kind TEXT NOT NULL DEFAULT 'core'
`;

// Migration 005: at most ONE pending recommendation per (profile_id, title_id).
// Without this, two overlapping /generate calls each read the pending set before
// either inserted, so the read-time excludeTitleIds missed the other's picks and
// the same title landed as two pending rows. First dedupe any existing duplicates
// (keep the earliest), then enforce it at the DB with a partial unique index.
export const MIGRATE_005_DEDUP_PENDING = [
  `DELETE FROM recommendations
     WHERE state = 'pending'
       AND id NOT IN (
         SELECT MIN(id) FROM recommendations
         WHERE state = 'pending'
         GROUP BY profile_id, title_id
       )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rec_pending_unique
     ON recommendations (profile_id, title_id) WHERE state = 'pending'`,
];
