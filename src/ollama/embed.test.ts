import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { embedText, OllamaError } from './embed.js';

const mockConfig = { ollamaUrl: 'http://localhost:11434' };

describe('embedText', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns embedding array on success', async () => {
    const mockEmbedding = [0.1, 0.2, 0.3, 0.4, 0.5];
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: mockEmbedding }), { status: 200 }),
    );

    const result = await embedText('Test movie about a heist', mockConfig);

    expect(result).toEqual(mockEmbedding);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'Test movie about a heist' }),
      }),
    );
  });

  it('throws OllamaError containing "Ollama" on network error', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(embedText('Some text', mockConfig)).rejects.toThrow(OllamaError);

    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(embedText('Some text', mockConfig)).rejects.toThrow('Ollama');
  });

  it('throws OllamaError containing status code on non-200 response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'model not found' }), { status: 500 }),
    );
    await expect(embedText('Some text', mockConfig)).rejects.toThrow(OllamaError);

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'model not found' }), { status: 500 }),
    );
    await expect(embedText('Some text', mockConfig)).rejects.toThrow('500');
  });

  it('throws OllamaError if embedding field is missing from response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ result: 'unexpected' }), { status: 200 }),
    );

    await expect(embedText('Some text', mockConfig)).rejects.toThrow(OllamaError);
  });
});
