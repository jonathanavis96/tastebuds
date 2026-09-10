import 'dotenv/config';

export interface Config {
  tmdbApiKey: string;
  ollamaUrl: string;
  claudeToken: string;
  /**
   * Unused — TasteBuds is a single-user LAN/Tailscale-only tool (no public
   * internet exposure), so there is no bearer-token gate on the API. Kept as
   * an optional field for backwards compatibility with existing .env files
   * that still set TASTEBUDS_TOKEN; harmless if present, not required.
   */
  tastebudsToken?: string;
  port: number;
  /**
   * Hostname the Node HTTP server itself binds to. Defaults to '0.0.0.0' (all
   * interfaces) — required inside Docker for docker-compose's port publishing
   * to reach the container at all (BIND_HOST in .env/docker-compose.yml controls
   * the HOST-side interface for that case, not this).
   *
   * For a BARE NODE deploy (no Docker), BIND_HOST is not consulted anywhere —
   * this is the only knob that controls what the process listens on, and the
   * '0.0.0.0' default means it listens on every interface on the host,
   * including any public one, with no auth in front of it. Set HOST=127.0.0.1
   * in .env for a bare-Node, this-machine-only deploy.
   *
   * Optional (with a `??` fallback at the one call site in server.ts) so
   * hand-built Config literals in tests don't all need updating — mirrors the
   * pattern used for harvestPagesPerBucket/harvestGenresPerRun/harvestCron below.
   */
  bindHost?: string;
  dbPath: string;
  omdbApiKey: string | undefined;
  /**
   * Maximum new titles to ingest during the daily harvest run.
   * Defaults to 500. Set via HARVEST_DAILY_TARGET env var.
   */
  harvestDailyTarget: number;
  /**
   * Maximum new titles to ingest across all on-demand request lookups in one day.
   * Defaults to 500. Set via REQUEST_LOOKUP_DAILY_BUDGET env var.
   */
  requestLookupDailyBudget: number;
  /**
   * Deepest TMDB discover page the harvest cursor sweeps to before wrapping back
   * to page 1. Each bucket advances one page per run. Defaults to 100 (~2,000
   * titles per bucket before it loops). Set via HARVEST_MAX_PAGE env var.
   */
  harvestMaxPage: number;
  /**
   * How many consecutive cursor pages each GLOBAL broad bucket (movie:broad,
   * tv:broad) sweeps per nightly run. The daily-add ceiling is candidate fan-out
   * (distinct not-yet-stored titles surfaced), NOT the budget cap — so widening
   * this is the lever that grows titles-added per night. Defaults to 4. Set via
   * HARVEST_PAGES_PER_BUCKET. Always populated by loadConfig.
   */
  harvestPagesPerBucket?: number;
  /**
   * How many round-robin genre slices to fetch PER media type each nightly run
   * (each paged from its own cursor; the window rotates by day-of-year so every
   * genre is swept over a full cycle). Widens cross-genre fan-out. Defaults to 4.
   * Set via HARVEST_GENRES_PER_RUN. Always populated by loadConfig.
   */
  harvestGenresPerRun?: number;
  /**
   * Cron expression for the nightly harvest schedule (container TZ = UTC).
   * Defaults to '0 3 * * *' (03:00 UTC ≈ 05:00 SAST). Set via HARVEST_CRON.
   * Always populated by loadConfig.
   */
  harvestCron?: string;
  /**
   * Maximum titles to enrich with OMDb ratings during the nightly backfill run.
   * Defaults to 800. Set via RATINGS_BACKFILL_CAP env var.
   * Rationale: OMDb free tier allows ~1 000 calls/day; leave ~200 for live /generate.
   */
  ratingsBackfillCap?: number;
  /**
   * Maximum titles to enrich with TMDB metadata (original_language,
   * runtime_minutes, vote_average, status) during the nightly/startup
   * backfill run. Defaults to 20000 — enough to sweep the whole ~17.8k
   * pre-existing catalogue in one pass. Set via META_BACKFILL_CAP env var.
   */
  metaBackfillCap?: number;
  /**
   * Overrides for the retrieval hard filters (see src/retrieval/filters.ts
   * DEFAULT_HARD_FILTERS). Each is optional; unset keys keep the default. Set via
   * RETRIEVAL_MIN_YEAR, RETRIEVAL_MIN_RUNTIME, RETRIEVAL_MIN_VOTES_MOVIE,
   * RETRIEVAL_MIN_VOTES_TV, RETRIEVAL_MIN_VOTE_AVERAGE and RETRIEVAL_LANGUAGES
   * (comma-separated ISO 639-1 codes; these are ADDED to the languages learned
   * from the liked history, English is always included).
   */
  hardFilters?: {
    minYear?: number;
    minRuntimeMovie?: number;
    minVotesMovie?: number;
    minVotesTv?: number;
    minVoteAverage?: number;
    languages?: string[];
  };
}

/** Default nightly harvest cron expression (container TZ = UTC). */
export const HARVEST_CRON_DEFAULT = '0 3 * * *';
/** Default OMDb ratings backfill cap per nightly run. */
export const RATINGS_BACKFILL_CAP_DEFAULT = 800;
/** Default TMDB metadata backfill cap per run. */
export const META_BACKFILL_CAP_DEFAULT = 20000;

/** Default consecutive pages swept per global broad bucket per harvest run. */
export const HARVEST_PAGES_PER_BUCKET_DEFAULT = 4;
/** Default round-robin genre slices fetched per media type per harvest run. */
export const HARVEST_GENRES_PER_RUN_DEFAULT = 4;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(): Config {
  const tmdbApiKey = process.env.TMDB_API_KEY;
  if (!tmdbApiKey) {
    throw new ConfigError('Missing required env var: TMDB_API_KEY');
  }

  const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!claudeToken) {
    throw new ConfigError('Missing required env var: CLAUDE_CODE_OAUTH_TOKEN');
  }

  const tastebudsToken = process.env.TASTEBUDS_TOKEN;

  return {
    tmdbApiKey,
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    claudeToken,
    tastebudsToken,
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 8094,
    bindHost: process.env.HOST ?? '0.0.0.0',
    dbPath: process.env.DB_PATH ?? './data/tastebuds.db',
    omdbApiKey: process.env.OMDB_API_KEY,
    harvestDailyTarget: process.env.HARVEST_DAILY_TARGET
      ? parseInt(process.env.HARVEST_DAILY_TARGET, 10)
      : 500,
    requestLookupDailyBudget: process.env.REQUEST_LOOKUP_DAILY_BUDGET
      ? parseInt(process.env.REQUEST_LOOKUP_DAILY_BUDGET, 10)
      : 500,
    harvestMaxPage: process.env.HARVEST_MAX_PAGE
      ? parseInt(process.env.HARVEST_MAX_PAGE, 10)
      : 100,
    harvestPagesPerBucket: process.env.HARVEST_PAGES_PER_BUCKET
      ? parseInt(process.env.HARVEST_PAGES_PER_BUCKET, 10)
      : HARVEST_PAGES_PER_BUCKET_DEFAULT,
    harvestGenresPerRun: process.env.HARVEST_GENRES_PER_RUN
      ? parseInt(process.env.HARVEST_GENRES_PER_RUN, 10)
      : HARVEST_GENRES_PER_RUN_DEFAULT,
    harvestCron: process.env.HARVEST_CRON ?? HARVEST_CRON_DEFAULT,
    ratingsBackfillCap: process.env.RATINGS_BACKFILL_CAP
      ? parseInt(process.env.RATINGS_BACKFILL_CAP, 10)
      : RATINGS_BACKFILL_CAP_DEFAULT,
    metaBackfillCap: process.env.META_BACKFILL_CAP
      ? parseInt(process.env.META_BACKFILL_CAP, 10)
      : META_BACKFILL_CAP_DEFAULT,
    hardFilters: parseHardFilterEnv(process.env),
  };
}

/** Read the optional RETRIEVAL_* overrides; only keys that parse cleanly are set. */
export function parseHardFilterEnv(env: NodeJS.ProcessEnv): Config['hardFilters'] {
  const num = (key: string): number | undefined => {
    const raw = env[key];
    if (raw == null || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const out: NonNullable<Config['hardFilters']> = {};
  const minYear = num('RETRIEVAL_MIN_YEAR');
  const minRuntimeMovie = num('RETRIEVAL_MIN_RUNTIME');
  const minVotesMovie = num('RETRIEVAL_MIN_VOTES_MOVIE');
  const minVotesTv = num('RETRIEVAL_MIN_VOTES_TV');
  const minVoteAverage = num('RETRIEVAL_MIN_VOTE_AVERAGE');
  if (minYear != null) out.minYear = minYear;
  if (minRuntimeMovie != null) out.minRuntimeMovie = minRuntimeMovie;
  if (minVotesMovie != null) out.minVotesMovie = minVotesMovie;
  if (minVotesTv != null) out.minVotesTv = minVotesTv;
  if (minVoteAverage != null) out.minVoteAverage = minVoteAverage;
  const langs = (env.RETRIEVAL_LANGUAGES ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (langs.length > 0) out.languages = langs;
  return Object.keys(out).length > 0 ? out : undefined;
}
