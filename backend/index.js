// Express entry point for ContextBridge backend — mounts routes and global middleware.

import dotenv from 'dotenv';
dotenv.config({ override: true }); // override: true ensures shell env vars don't shadow .env values
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { randomUUID } from 'crypto';
import { testConnection } from './memory/postgres.js';
import contextRouter from './routes/context.js';
import injectRouter from './routes/inject.js';
// injectRouter is also mounted at /context so POST /context/inject resolves per PRD §5.3

const app = express();
const PORT = process.env.PORT || 3001;

// Attach a request ID to every request for tracing (never log body).
app.use((req, _res, next) => {
  req.requestId = randomUUID();
  next();
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Morgan logs method + url + status — body is never included.
morgan.token('req-id', (req) => req.requestId);
app.use(morgan(':req-id :method :url :status :response-time ms'));

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  const dbOk = await testConnection();
  res.json({ status: 'ok', version: '1.0.0', db: dbOk ? 'connected' : 'error' });
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/context', contextRouter);
// Mount inject under /context so the full path is POST /context/inject (PRD §5.3).
app.use('/context', injectRouter);

// ── Global error handler ──────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[error]', req.requestId, err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    request_id: req.requestId,
  });
});

app.listen(PORT, () => {
  console.log(`[ContextBridge] Backend listening on port ${PORT}`);

  if (!process.env.GROQ_API_KEY) {
    console.error('[ContextBridge] WARNING: GROQ_API_KEY is not set — structurer will fail');
  }
  if (!process.env.DATABASE_URL) {
    console.error('[ContextBridge] WARNING: DATABASE_URL is not set — DB queries will fail');
  }
});

export default app;
