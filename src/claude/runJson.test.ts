import { describe, it, expect, vi, afterEach } from 'vitest';
import { ClaudeAuthError, ClaudeTimeoutError, runClaudeJson } from './runJson.js';
import type { ClaudeJsonOpts, SpawnFn } from './runJson.js';

/** A child process that prints `stdout` and exits with `code` as soon as it is listened to. */
function fakeSpawn(stdout: string, code = 0, stderr = '') {
  const kill = vi.fn();
  const spawn = vi.fn().mockReturnValue({
    stdout: { on: vi.fn((evt: string, cb: (d: Buffer) => void) => { if (evt === 'data') cb(Buffer.from(stdout)); }) },
    stderr: { on: vi.fn((evt: string, cb: (d: Buffer) => void) => { if (evt === 'data' && stderr) cb(Buffer.from(stderr)); }) },
    on: vi.fn((evt: string, cb: (code: number) => void) => { if (evt === 'close') cb(code); }),
    kill,
  });
  return { spawn, kill };
}

function stalledSpawn() {
  const kill = vi.fn();
  const spawn = vi.fn().mockReturnValue({ stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), kill });
  return { spawn, kill };
}

const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

function opts(spawn: ReturnType<typeof vi.fn>, over: Partial<ClaudeJsonOpts> = {}): ClaudeJsonOpts {
  return {
    prompt: 'the prompt', system: 'the system prompt', model: 'claude-haiku-5-5', schema: SCHEMA,
    token: 'tok', timeoutMs: 30_000, spawnFn: spawn as unknown as SpawnFn, ...over,
  };
}

describe('runClaudeJson', () => {
  afterEach(() => vi.useRealTimers());

  it('runs a lean claude -p with its own system prompt, no tools, MCP, settings or session', async () => {
    const { spawn } = fakeSpawn(JSON.stringify({ structured_output: { answer: 'x' } }));
    await runClaudeJson(opts(spawn));
    const [cmd, args, options] = spawn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toEqual([
      '-p', 'the prompt',
      '--model', 'claude-haiku-5-5',
      '--system-prompt', 'the system prompt',
      '--tools', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--setting-sources', '',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(SCHEMA),
    ]);
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
  });

  it('leaves the CLI on its own login when the token is empty', async () => {
    const { spawn } = fakeSpawn(JSON.stringify({ structured_output: { answer: 'x' } }));
    await runClaudeJson(opts(spawn, { token: '' }));
    expect(spawn.mock.calls[0][2].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  });

  it('returns structured_output when the CLI gives it', async () => {
    const { spawn } = fakeSpawn(JSON.stringify({ result: 'ignored', structured_output: { answer: 'yes' } }));
    await expect(runClaudeJson(opts(spawn))).resolves.toEqual({ answer: 'yes' });
  });

  it('falls back to the JSON object inside the result text', async () => {
    const result = 'Here you go:\n```json\n{"answer": "fenced",}\n```';
    const { spawn } = fakeSpawn(JSON.stringify({ result }));
    await expect(runClaudeJson(opts(spawn))).resolves.toEqual({ answer: 'fenced' });
  });

  it.each([
    ['output that is not JSON', 'not json at all'],
    ['a result that is an array', JSON.stringify({ result: '[1, 2]' })],
    ['a result with no object', JSON.stringify({ result: 'I cannot help with that.' })],
    ['an error the CLI reported', JSON.stringify({ is_error: true, result: 'Credit balance is too low' })],
  ])('rejects %s', async (_name, stdout) => {
    const { spawn } = fakeSpawn(stdout);
    await expect(runClaudeJson(opts(spawn))).rejects.toThrow(/Unusable claude -p output/);
  });

  it('rejects a non-zero exit with what the CLI printed to stderr', async () => {
    const { spawn } = fakeSpawn('', 1, 'Invalid API key');
    await expect(runClaudeJson(opts(spawn))).rejects.toThrow(/exited with code 1: Invalid API key/);
  });

  it('reports the reason from the JSON envelope when stderr is empty', async () => {
    const stdout = JSON.stringify({ is_error: true, api_error_status: 529, result: 'API Error: 529 Overloaded' });
    const { spawn } = fakeSpawn(stdout, 1);
    await expect(runClaudeJson(opts(spawn))).rejects.toThrow(/exited with code 1: API Error: 529 Overloaded/);
  });

  it('reports a refused login as ClaudeAuthError, with the CLI’s own words', async () => {
    const stdout = JSON.stringify({ is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 Invalid bearer token' });
    const { spawn } = fakeSpawn(stdout, 1);
    const outcome = runClaudeJson(opts(spawn));
    await expect(outcome).rejects.toBeInstanceOf(ClaudeAuthError);
    await expect(outcome).rejects.toThrow(/could not sign in: Failed to authenticate. API Error: 401 Invalid bearer token/);
  });

  it('falls back to raw stdout when a failed call printed no envelope', async () => {
    const { spawn } = fakeSpawn('Segmentation fault', 139);
    await expect(runClaudeJson(opts(spawn))).rejects.toThrow(/exited with code 139: Segmentation fault/);
  });

  it('rejects when the CLI cannot be started', async () => {
    const spawn = vi.fn().mockReturnValue({
      stdout: { on: vi.fn() }, stderr: { on: vi.fn() },
      on: vi.fn((evt: string, cb: (e: Error) => void) => { if (evt === 'error') cb(new Error('ENOENT')); }),
    });
    await expect(runClaudeJson(opts(spawn))).rejects.toThrow(/Failed to spawn claude: ENOENT/);
  });

  it('stops a stalled call: SIGTERM at the timeout, SIGKILL 5 s later', async () => {
    vi.useFakeTimers();
    const { spawn, kill } = stalledSpawn();
    const outcome = runClaudeJson(opts(spawn, { timeoutMs: 1_000 }));
    const rejected = expect(outcome).rejects.toBeInstanceOf(ClaudeTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(kill).not.toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('leaves a call that finishes in time alone', async () => {
    vi.useFakeTimers();
    const { spawn, kill } = fakeSpawn(JSON.stringify({ structured_output: { answer: 'x' } }));
    await runClaudeJson(opts(spawn, { timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kill).not.toHaveBeenCalled();
  });
});
