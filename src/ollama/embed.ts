import type { Config } from '../config.js';

export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaError';
  }
}

export async function embedText(
  text: string,
  config: Pick<Config, 'ollamaUrl'>,
): Promise<number[]> {
  let response: Response;

  try {
    response = await fetch(`${config.ollamaUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    });
  } catch (err) {
    throw new OllamaError(
      `Ollama request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new OllamaError(`Ollama returned HTTP ${response.status}: ${body}`);
  }

  const json = (await response.json()) as { embedding?: number[] };

  if (!Array.isArray(json.embedding)) {
    throw new OllamaError(
      `Ollama response missing 'embedding' field: ${JSON.stringify(json)}`,
    );
  }

  return json.embedding;
}
