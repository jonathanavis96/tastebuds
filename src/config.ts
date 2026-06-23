import 'dotenv/config';

export interface Config {
  tmdbApiKey: string;
  ollamaUrl: string;
  claudeToken: string;
  port: number;
  dbPath: string;
  omdbApiKey: string | undefined;
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
  };
}
