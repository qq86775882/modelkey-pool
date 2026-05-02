/**
 * POST /api/keys-test — 测试 Key
 */
import { getDefaultModel } from './lib/key-store.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { key, model, message } = req.body;
  if (!key) return res.status(400).json({ ok: false, error: '缺少 key' });

  const start = Date.now();
  try {
    const resp = await fetch('https://api-inference.modelscope.cn/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || getDefaultModel(),
        messages: [{ role: 'user', content: message || 'Hello, reply with just OK.' }],
        max_tokens: 50,
      }),
    });
    const elapsed = Date.now() - start;

    if (resp.ok) {
      const data = await resp.json();
      return res.status(200).json({
        ok: true,
        status: resp.status,
        latencyMs: elapsed,
        model: data.model || '',
        reply: data.choices?.[0]?.message?.content?.slice(0, 200) || '',
        usage: data.usage || {},
      });
    }
    const text = await resp.text();
    return res.status(200).json({ ok: false, status: resp.status, latencyMs: elapsed, error: text.slice(0, 500) });
  } catch (e) {
    return res.status(200).json({ ok: false, status: 0, latencyMs: Date.now() - start, error: e.message });
  }
}
