import type { spawn as nodeSpawn } from 'node:child_process';

export type SpawnFn = typeof nodeSpawn;

export class ClaudeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`claude -p timed out after ${timeoutMs / 1000}s`);
    this.name = 'ClaudeTimeoutError';
  }
}

export interface ClaudeJsonOpts {
  prompt: string;
  /** Replaces the CLI's default system prompt, so the call carries no agent harness. */
  system: string;
  model: string;
  /** JSON Schema with an object at the top level, passed as --json-schema. */
  schema: object;
  /** CLAUDE_CODE_OAUTH_TOKEN for the subprocess. */
  token: string;
  timeoutMs: number;
  spawnFn?: SpawnFn;
}

/**
 * One `claude -p` call that returns the structured output the schema asked for.
 * Runs lean: own system prompt, no tools, no MCP servers, no settings, no
 * session file. The default CLI setup sends about 17,700 tokens of harness per
 * call; this sends a few hundred. Rejects on spawn failure, non-zero exit,
 * timeout (ClaudeTimeoutError) or output that is not the requested object.
 */
export async function runClaudeJson<T>(opts: ClaudeJsonOpts): Promise<T> {
  void opts;
  throw new Error('not implemented');
}
