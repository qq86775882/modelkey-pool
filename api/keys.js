/**
 * /api/keys — Key CRUD
 */
import { listKeys, addKey, removeKey, updateKey } from './lib/key-store.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      return res.status(200).json(await listKeys());
    }
    if (req.method === 'POST') {
      const result = await addKey(req.body.key);
      return res.status(result.ok ? 200 : 400).json(result);
    }
    if (req.method === 'PUT') {
      const result = await updateKey(req.body.old_key, req.body.new_key);
      return res.status(result.ok ? 200 : 400).json(result);
    }
    if (req.method === 'DELETE') {
      const key = req.query.key;
      if (!key) return res.status(400).json({ ok: false, error: '缺少 key 参数' });
      const result = await removeKey(decodeURIComponent(key));
      return res.status(result.ok ? 200 : 404).json(result);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
