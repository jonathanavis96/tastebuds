import 'dotenv/config';

export interface Config {
  tmdbApiKey: string;
  ollamaUrl: string;
  claudeToken: string;
  port: number;
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
}

/** Default nightly harvest cron expression (container TZ = UTC). */
export const HARVEST_CRON_DEFAULT = '0 3 * * *';

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

  return {
    tmdbApiKey,
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    claudeToken,
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 8094,
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
  };
}
