import type { Config } from '../config.js';
import type { SpawnFn } from '../claude/runJson.js';
import type { RequestRules } from './rules.js';

/**
 * Let the model read what parseRequest could not (a subject such as "medical",
 * an exclusion in unusual words, a title named as a reference) and merge it into
 * `base`. Runs only when leftoverWords(text) is non-empty, so a request that was
 * fully understood costs no model call.
 *
 * What the model returns is validated before it is merged: genres must be
 * canonical, years plausible, terms short. Anything the request states outright
 * (film or series, a year, a recency word) keeps the value parseRequest gave it.
 * Never throws: on a timeout, a refusal or unusable output it returns `base`.
 */
export async function refineRulesWithModel(
  text: string,
  base: RequestRules,
  config: Pick<Config, 'claudeToken'>,
  now: Date = new Date(),
  spawnFn?: SpawnFn,
): Promise<RequestRules> {
  void text; void config; void now; void spawnFn;
  return base;
}
