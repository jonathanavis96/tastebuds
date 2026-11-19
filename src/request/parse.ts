import type { RequestRules } from './rules.js';

/**
 * Read a free-text request into rules without any model call: film or series,
 * years and recency words, genres, moods, rating words, runtime, language,
 * exclusions ("no nuns") and "like <title>" references. Pure and deterministic;
 * `now` fixes the current year for the recency windows.
 */
export function parseRequest(text: string, now: Date = new Date()): RequestRules {
  void text; void now;
  throw new Error('not implemented');
}

/**
 * The content words of `text` that parseRequest did not turn into a rule and
 * that are not filler ("something", "movie", "tonight"). Empty means the request
 * was fully understood, so no model call is needed to read it.
 */
export function leftoverWords(text: string, now: Date = new Date()): string[] {
  void text; void now;
  throw new Error('not implemented');
}
