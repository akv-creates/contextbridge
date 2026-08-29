// Express routes for folders — thin wrappers over the postgres layer.

import { Router } from 'express';
import {
  createFolder, listFolders, updateFolder, deleteFolder,
} from '../memory/postgres.js';

const router = Router();

// GET /folders?user_id=...
router.get('/', async (req, res, next) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id query param is required' });
    const folders = await listFolders(user_id);
    return res.json({ folders });
  } catch (err) { next(err); }
});

// POST /folders  { user_id, name, color? }
router.post('/', async (req, res, next) => {
  try {
    const { user_id, name, color } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    try {
      const folder = await createFolder(user_id, name, color);
      return res.status(201).json(folder);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A folder with that name already exists' });
      }
      throw err;
    }
  } catch (err) { next(err); }
});

// PATCH /folders/:id  { user_id, name?, color? }
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user_id, name, color } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    if (name === undefined && color === undefined) {
      return res.status(400).json({ error: 'name or color is required' });
    }
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (color !== undefined) patch.color = color;
    try {
      const folder = await updateFolder(user_id, id, patch);
      if (!folder) return res.status(404).json({ error: 'Folder not found' });
      return res.json(folder);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A folder with that name already exists' });
      }
      throw err;
    }
  } catch (err) { next(err); }
});

// DELETE /folders/:id?user_id=...
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id query param is required' });
    const ok = await deleteFolder(user_id, id);
    if (!ok) return res.status(404).json({ error: 'Folder not found' });
    return res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
