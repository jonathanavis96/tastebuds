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
    popularity          REAL,
    vote_count          INTEGER,
    rating_checked_at   INTEGER,
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
    predicted_rating REAL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

export const MIGRATE_001_ADD_KIND = `
  ALTER TABLE recommendations ADD COLUMN kind TEXT NOT NULL DEFAULT 'core'
`;

// Migration 008: predicted_rating on recommendations — the star rating Sonnet
// predicts for each pick at curation time, compared against the user's actual
// rating to produce the calibration stat. Nullable (older recs have none).
export const MIGRATE_008_ADD_PREDICTED_RATING = [
  `ALTER TABLE recommendations ADD COLUMN predicted_rating REAL`,
];

// Migration 006: daily API usage budget tracking table.
// Persists per-day counters for harvest and request-driven title ingestion so
// each configured daily budget is respected across restarts and partial runs.
export const MIGRATE_006_API_USAGE = `
  CREATE TABLE IF NOT EXISTS api_usage (
    day              TEXT PRIMARY KEY,
    harvest_added    INTEGER NOT NULL DEFAULT 0,
    request_added    INTEGER NOT NULL DEFAULT 0
  )
`;

// Migration 007: per-bucket harvest page cursor.
// One row per discovery "bucket" (e.g. "movie:broad", "tv:genre:18",
// "movie:loved:18,28"). next_page is the TMDB discover page to fetch on the NEXT
// harvest for that bucket — lets the nightly harvest sweep DEEPER through the
// catalogue each run instead of re-listing page 1 (which mostly returns titles
// already in the DB). Wraps back to page 1 at harvestMaxPage.
export const MIGRATE_007_HARVEST_CURSOR = `
  CREATE TABLE IF NOT EXISTS harvest_cursor (
    bucket      TEXT PRIMARY KEY,
    next_page   INTEGER NOT NULL DEFAULT 1
  )
`;

// Migration 009: content-addressed embedding cache. Keyed by a sha256 of the EXACT
// text that was embedded, so a note-augmented title embedding ("title — synopsis — note")
// is computed once and reused on every later taste-vector refresh — only a CHANGED note
// (new text → new hash) triggers a fresh Ollama call. Stops a single "Not interested"
// click from re-embedding the whole rated history (notes cover ~half the ratings).
export const MIGRATE_009_EMBEDDING_CACHE = `
  CREATE TABLE IF NOT EXISTS embedding_cache (
    text_hash   TEXT PRIMARY KEY,
    vec         BLOB NOT NULL,
    created_at  TEXT NOT NULL
  )
`;

// Migration 010: TMDB popularity score and vote count. The nightly harvest already
// sorts discover results by vote_count.desc / popularity.desc, so the data is on
// the wire — these columns just persist it. The backfill query is reordered to
// vote_count DESC, popularity DESC so most-established titles get OMDb enrichment first.
export const MIGRATE_010_ADD_POPULARITY = [
  `ALTER TABLE titles ADD COLUMN popularity REAL`,
  `ALTER TABLE titles ADD COLUMN vote_count INTEGER`,
];

// Migration 011: OMDb check marker. When the nightly backfill queries OMDb for a
// title and OMDb has no rating, imdb_rating stays NULL — without a "checked" marker
// that title would be re-selected and re-queried every night, draining the free-tier
// quota. rating_checked_at (unix epoch seconds, set by updateTitleRatings in JS) marks
// the last successful OMDb attempt so backfillRatings can exclude already-checked titles
// regardless of whether OMDb returned data.
export const MIGRATE_011_ADD_RATING_CHECKED_AT = [
  `ALTER TABLE titles ADD COLUMN rating_checked_at INTEGER`,
];

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
