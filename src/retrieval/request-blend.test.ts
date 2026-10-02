import { describe, it, expect, vi } from 'vitest';
import { blendRequestQueryBuf } from './retrieve.js';

describe('blendRequestQueryBuf with a request embedding of the wrong size', () => {
  it('falls back to the taste vector and warns with both sizes instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const buf = blendRequestQueryBuf([1, 0, 0], [0, 1]);
    expect(Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4))).toEqual([1, 0, 0]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/3.*2/));
    warn.mockRestore();
  });
});
