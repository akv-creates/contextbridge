// Express routes for anonymous product telemetry — the demand-test signal
// for the consumer-memory experiment (activation, W2 retention, paywall CTR).
// Never accepts or stores message content; event_type is allow-listed in
// memory/postgres.js.

import { Router } from 'express';
import { recordEvent, joinWaitlist } from '../memory/postgres.js';

const router = Router();

// POST /events  { user_id, event_type, metadata? }
// Fire-and-forget from the extension — never blocks a user-facing flow.
router.post('/', async (req, res, next) => {
  try {
    const { user_id, event_type, metadata } = req.body;
    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'user_id is required' });
    }
    if (!event_type || typeof event_type !== 'string') {
      return res.status(400).json({ error: 'event_type is required' });
    }
    const row = await recordEvent(user_id, event_type, metadata);
    if (!row) return res.status(202).json({ ok: true, ignored: true }); // unknown event type — silently accepted, not stored
    return res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// POST /events/waitlist  { user_id, email?, source? }
router.post('/waitlist', async (req, res, next) => {
  try {
    const { user_id, email, source } = req.body;
    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'user_id is required' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    await joinWaitlist(user_id, email, source);
    return res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
