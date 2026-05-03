/**
 * GET  /api/keys → 列出所有 Key 状态
 * POST /api/keys → 添加 Key { key: "ms-xxx" }
 * PUT  /api/keys → 更新 Key { old_key, new_key }
 * DELETE /api/keys?key=xxx → 删除 Key
 */
import { listKeys, addKey, removeKey, updateKey } from './lib/key-store.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      return res.json(await listKeys(req.query.model));
    }

    if (req.method === 'POST') {
      const { key } = req.body;
      const result = await addKey(key);
      return res.status(result.ok ? 200 : 400).json(result);
    }

    if (req.method === 'DELETE') {
      const key = req.query.key;
      const result = await removeKey(key);
      return res.status(result.ok ? 200 : 400).json(result);
    }

    if (req.method === 'PUT') {
      const { old_key, new_key } = req.body;
      const result = await updateKey(old_key, new_key);
      return res.status(result.ok ? 200 : 400).json(result);
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
