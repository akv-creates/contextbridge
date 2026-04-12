// FAISS vector store — embeds session text via local transformers (free, no API needed).

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const INDEX_PATH = path.join(DATA_DIR, 'faiss.index');
const META_PATH = path.join(DATA_DIR, 'faiss.meta.json');

// all-MiniLM-L6-v2 produces 384-dim vectors — fast, free, runs locally.
const EMBEDDING_DIMS = 384;
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

let faissIndex = null;
let embedder = null;
let metadata = [];

async function getEmbedder() {
  if (!embedder) {
    const { pipeline } = await import('@xenova/transformers');
    console.log('[faiss] Loading local embedding model (first run downloads ~25MB)...');
    embedder = await pipeline('feature-extraction', EMBEDDING_MODEL);
    console.log('[faiss] Embedding model ready');
  }
  return embedder;
}

async function getFaiss() {
  if (!faissIndex) {
    const { IndexFlatL2 } = await import('faiss-node');

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

async function embed(text) {
  const pipe = await getEmbedder();
  const output = await pipe(text.slice(0, 512), { pooling: 'mean', normalize: true });
  // output.data is a Float32Array of length 384
  return Array.from(output.data);
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
