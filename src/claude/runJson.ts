import { spawn as nodeSpawn } from 'node:child_process';

export type SpawnFn = typeof nodeSpawn;

export class ClaudeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`claude -p timed out after ${timeoutMs / 1000}s`);
    this.name = 'ClaudeTimeoutError';
  }
}

/** The API refused the CLI's login (HTTP 401 or 403): trying again gives the same answer. */
export class ClaudeAuthError extends Error {
  constructor(reason: string) {
    super(`claude -p could not sign in: ${reason}`);
    this.name = 'ClaudeAuthError';
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

/** Grace after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5_000;

/**
 * One `claude -p` call that returns the structured output the schema asked for.
 * Runs lean: own system prompt, no tools, no MCP servers, no settings, no
 * session file. The default CLI setup sends about 17,700 tokens of harness per
 * call; this sends a few hundred. Rejects on spawn failure, non-zero exit
 * (ClaudeAuthError when the login was refused), timeout (ClaudeTimeoutError) or
 * output that is not the requested object.
 */
export async function runClaudeJson<T>(opts: ClaudeJsonOpts): Promise<T> {
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const args = [
    '-p', opts.prompt,
    '--model', opts.model,
    '--system-prompt', opts.system,
    '--tools', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--setting-sources', '',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(opts.schema),
  ];
  // An empty token leaves the CLI on the machine's own login.
  const env = opts.token ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: opts.token } : { ...process.env };

  return new Promise<T>((resolve, reject) => {
    // stdin is ignored: the prompt is an argument, and an open stdin makes the
    // CLI wait about 3 s for input on every call.
    const proc = spawnFn('claude', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), KILL_GRACE_MS).unref();
      reject(new ClaudeTimeoutError(opts.timeoutMs));
    }, opts.timeoutMs);
    timer.unref();

    proc.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(exitError(code, stdout, stderr));
        return;
      }
      try {
        resolve(structuredResult(stdout) as T);
      } catch (err) {
        reject(new Error(`Unusable claude -p output: ${(err as Error).message}\nOutput: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/**
 * The error for a non-zero exit. With --output-format json the CLI writes its
 * reason into the envelope on stdout and leaves stderr empty, so both are read:
 * an expired token would otherwise fail every call with no reason in the log.
 */
function exitError(code: number | null, stdout: string, stderr: string): Error {
  let reason = stderr.trim();
  let status: unknown;
  try {
    const outer = JSON.parse(stdout) as { result?: unknown; api_error_status?: unknown };
    status = outer.api_error_status;
    if (!reason && typeof outer.result === 'string') reason = outer.result;
  } catch {
    if (!reason) reason = stdout.trim();
  }
  reason = reason.slice(0, 500);
  if (status === 401 || status === 403) return new ClaudeAuthError(reason);
  return new Error(`claude -p exited with code ${code}: ${reason}`);
}

/**
 * The object from the CLI's JSON envelope: `structured_output` when the CLI
 * filled it (already parsed, quote-safe), otherwise the JSON object inside the
 * `result` text, which older CLIs return and which may be wrapped in markdown
 * fences or prose.
 */
function structuredResult(stdout: string): object {
  const outer = JSON.parse(stdout) as { is_error?: boolean; result?: unknown; structured_output?: unknown };
  if (outer.is_error) throw new Error(`the CLI reported an error: ${String(outer.result).slice(0, 200)}`);
  if (isPlainObject(outer.structured_output)) return outer.structured_output;
  if (typeof outer.result !== 'string') throw new Error('no structured_output and no result text');
  const inner = extractJsonObject(outer.result);
  if (!isPlainObject(inner)) throw new Error('result is not a JSON object');
  return inner;
}

function extractJsonObject(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t.replace(/,(\s*[\]}])/g, '$1'));
}

function isPlainObject(v: unknown): v is object {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
