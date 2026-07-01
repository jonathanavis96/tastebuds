import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, ConfigError } from './config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      TMDB_API_KEY: 'test-tmdb-key',
      OLLAMA_URL: 'http://localhost:11434',
      CLAUDE_CODE_OAUTH_TOKEN: 'test-claude-token',
      PORT: '8094',
      DB_PATH: './data/tastebuds.db',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns correct config shape when all env vars set', () => {
    const config = loadConfig();
    expect(config.tmdbApiKey).toBe('test-tmdb-key');
    expect(config.ollamaUrl).toBe('http://localhost:11434');
    expect(config.claudeToken).toBe('test-claude-token');
    expect(config.port).toBe(8094);
    expect(config.dbPath).toBe('./data/tastebuds.db');
  });

  it('uses default ollamaUrl when not set', () => {
    delete process.env.OLLAMA_URL;
    const config = loadConfig();
    expect(config.ollamaUrl).toBe('http://localhost:11434');
  });

  it('uses default port 8094 when PORT not set', () => {
    delete process.env.PORT;
    const config = loadConfig();
    expect(config.port).toBe(8094);
  });

  it('throws ConfigError when TMDB_API_KEY missing', () => {
    delete process.env.TMDB_API_KEY;
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow('TMDB_API_KEY');
  });

  it('throws ConfigError when CLAUDE_CODE_OAUTH_TOKEN missing', () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('omdbApiKey is undefined when OMDB_API_KEY not set', () => {
    delete process.env.OMDB_API_KEY;
    const config = loadConfig();
    expect(config.omdbApiKey).toBeUndefined();
  });

  it('omdbApiKey is set when OMDB_API_KEY is provided', () => {
    process.env.OMDB_API_KEY = 'my-omdb-key';
    const config = loadConfig();
    expect(config.omdbApiKey).toBe('my-omdb-key');
  });

  it('does not throw when OMDB_API_KEY is missing', () => {
    delete process.env.OMDB_API_KEY;
    expect(() => loadConfig()).not.toThrow();
  });
});
