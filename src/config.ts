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
   * to page 1. Each bucket advances one page per run. Defaults to 30 (~600 titles
   * per bucket before it loops). Set via HARVEST_MAX_PAGE env var.
   */
  harvestMaxPage: number;
}

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
      : 30,
  };
}
