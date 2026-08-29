// POST /context/capture-file — capture context from an uploaded .docx/.pptx
// instead of a chat transcript. Extracts text, then runs the exact same
// privacy-gate + structuring pipeline as chat capture (engine/capture-flow.js).

import { Router } from 'express';
import multer from 'multer';
import { extractDocumentText } from '../engine/document-extractor.js';
import { runCaptureFlow } from '../engine/capture-flow.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB — generous for a single doc/deck
});

const router = Router();

router.post('/capture-file', upload.single('file'), async (req, res, next) => {
  try {
    const { user_id } = req.body;
    const file = req.file;

    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'user_id is required and must be a string' });
    }
    if (!file) {
      return res.status(400).json({ error: 'file is required (multipart field name: "file")' });
    }

    const { text, truncated } = await extractDocumentText(file.buffer, file.originalname);

    const ext = file.originalname.toLowerCase().split('.').pop();
    const sourceModel = ext === 'pptx' ? 'pptx' : 'docx';

    const messages = [
      { role: 'user', content: `[Uploaded document: ${file.originalname}]\n\n${text}` },
    ];

    const result = await runCaptureFlow(sourceModel, messages, user_id);
    return res.status(201).json({ ...result, source_filename: file.originalname, truncated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Multer errors (e.g. file too large, unexpected field) surface via the
// `error` argument to this route's callback chain rather than a thrown error
// with .status, so handle them explicitly.
router.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  next(err);
});

export default router;
