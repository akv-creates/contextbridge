// Local embedding pipeline — all-MiniLM-L6-v2 via @xenova/transformers.
// 384-dim vectors, runs on CPU, no API cost. Used by both session-level FAISS
// and per-item retrieval (Smart Slice).

const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMS = 384;

let embedder = null;

export async function getEmbedder() {
  if (!embedder) {
    const { pipeline } = await import('@xenova/transformers');
    console.log('[embeddings] Loading MiniLM (first run downloads ~25MB)…');
    embedder = await pipeline('feature-extraction', EMBEDDING_MODEL);
    console.log('[embeddings] Ready');
  }
  return embedder;
}

// Embed one string → plain number[] (length 384). Truncates to 512 chars to
// match the model's context window and keep latency bounded.
export async function embed(text) {
  const pipe = await getEmbedder();
  const output = await pipe(String(text || '').slice(0, 512), {
    pooling: 'mean',
    normalize: true,
  });
  return Array.from(output.data);
}

// Batch-embed an array of strings — still serial under the hood (transformers.js
// doesn't expose true batch inference cheaply on CPU), but this is the single
// choke point if we ever swap in a batching runtime.
export async function embedMany(texts) {
  const out = [];
  for (const t of texts) out.push(await embed(t));
  return out;
}

// Cosine similarity between two normalized 384-dim vectors — since embeddings
// are L2-normalized by the pipeline, this is just the dot product.
export function cosineSim(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}
