// FAISS vector store — session-level similarity search over MiniLM embeddings.
// Embedding loader lives in ../memory/embeddings.js so item-level retrieval
// (Smart Slice) can reuse the same model singleton.

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { embed, EMBEDDING_DIMS } from './embeddings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const INDEX_PATH = path.join(DATA_DIR, 'faiss.index');
const META_PATH = path.join(DATA_DIR, 'faiss.meta.json');

let faissIndex = null;
let metadata = [];

async function getFaiss() {
  if (!faissIndex) {
    // faiss-node only exposes a CJS default export — named destructuring
    // from the dynamic import (`{ IndexFlatL2 }`) silently resolves to
    // undefined, so we have to reach into `.default`.
    const faissModule = await import('faiss-node');
    const { IndexFlatL2 } = faissModule.default || faissModule;

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (fs.existsSync(INDEX_PATH)) {
      try {
        faissIndex = IndexFlatL2.read(INDEX_PATH);
        const raw = fs.readFileSync(META_PATH, 'utf8');
        metadata = JSON.parse(raw);
        console.log('[faiss] Loaded existing index with', faissIndex.ntotal(), 'vectors');
      } catch (err) {
        console.error('[faiss] Failed to load existing index, creating fresh:', err.message);
        faissIndex = new IndexFlatL2(EMBEDDING_DIMS);
        metadata = [];
      }
    } else {
      faissIndex = new IndexFlatL2(EMBEDDING_DIMS);
      metadata = [];
      console.log('[faiss] Created new index (384-dim, all-MiniLM-L6-v2)');
    }
  }
  return faissIndex;
}

function persistIndex(index) {
  index.write(INDEX_PATH);
  fs.writeFileSync(META_PATH, JSON.stringify(metadata), 'utf8');
}

export async function saveEmbedding(sessionId, text) {
  const index = await getFaiss();
  const vector = await embed(text);
  index.add(vector);
  metadata.push(sessionId);
  persistIndex(index);
  console.log('[faiss] Saved embedding for session:', sessionId);
}

export async function searchSimilar(text, k = 3) {
  const index = await getFaiss();
  if (index.ntotal() === 0) return [];

  const vector = await embed(text);
  const actualK = Math.min(k, index.ntotal());
  const result = index.search(vector, actualK);

  return result.labels.map((label, i) => ({
    sessionId: metadata[label] || null,
    score: result.distances[i],
  })).filter((r) => r.sessionId !== null);
}
