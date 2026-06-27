import type Database from 'better-sqlite3';

/**
 * Content-addressed embedding cache (migration 009). The key is a sha256 of the EXACT
 * text that was embedded, so an identical embed input returns the stored vector instead
 * of re-calling Ollama. Used for note-augmented title embeddings, whose text only changes
 * when the user edits the note — letting a "Not interested" click reuse every vector.
 */

export function getCachedEmbedding(
  db: InstanceType<typeof Database>,
  textHash: string,
): Buffer | null {
  const row = db.prepare('SELECT vec FROM embedding_cache WHERE text_hash = ?').get(textHash) as
    | { vec: Buffer }
    | undefined;
  return row?.vec ?? null;
}

export function putCachedEmbedding(
  db: InstanceType<typeof Database>,
  textHash: string,
  vec: Buffer,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO embedding_cache (text_hash, vec, created_at) VALUES (?, ?, ?)',
  ).run(textHash, vec, new Date().toISOString());
}
