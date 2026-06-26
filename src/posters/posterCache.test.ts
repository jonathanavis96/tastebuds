import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePosterCached, posterFilePath } from './posterCache.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'poster-cache-'));
}

describe('ensurePosterCached', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('fetches and writes the poster on a cache miss', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(bytes, { status: 200 }));
    const file = await ensurePosterCached('/abc.jpg', 42, { posterDir: dir, fetchImpl });

    expect(file).toBe(posterFilePath(dir, 42));
    expect(fetchImpl).toHaveBeenCalledWith('https://image.tmdb.org/t/p/w342/abc.jpg');
    expect(fs.readFileSync(file!)).toEqual(Buffer.from(bytes));
  });

  it('serves the cached file without re-fetching on a hit', async () => {
    const file = posterFilePath(dir, 7);
    fs.writeFileSync(file, Buffer.from([9, 9]));
    const fetchImpl = vi.fn();
    const result = await ensurePosterCached('/x.jpg', 7, { posterDir: dir, fetchImpl });

    expect(result).toBe(file);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null on a non-OK TMDB response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));
    const result = await ensurePosterCached('/missing.jpg', 1, { posterDir: dir, fetchImpl });
    expect(result).toBeNull();
    expect(fs.existsSync(posterFilePath(dir, 1))).toBe(false);
  });

  it('returns null when the fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'));
    const result = await ensurePosterCached('/x.jpg', 2, { posterDir: dir, fetchImpl });
    expect(result).toBeNull();
  });

  it('honours a custom size bucket', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    await ensurePosterCached('/y.jpg', 3, { posterDir: dir, fetchImpl, size: 500 });
    expect(fetchImpl).toHaveBeenCalledWith('https://image.tmdb.org/t/p/w500/y.jpg');
  });
});
