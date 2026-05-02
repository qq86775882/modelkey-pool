/**
 * POST /api/chat — OpenAI 兼容代理，自动 Key 轮换
 */
import { pickAndUse, mark429, getData } from './lib/key-store.js';

const MAX_RETRIES = 15;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;
  const { defaultModel } = await getData();
  if (!body.model) body.model = defaultModel;
  const isStream = body.stream === true;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const key = await pickAndUse();
    if (!key) {
      return res.status(503).json({
        error: { message: '所有 API Key 日配额已用完，等待午夜重置', type: 'quota_exhausted', code: 503 },
      });
    }

    try {
      const resp = await fetch('https://api-inference.modelscope.cn/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (resp.ok) {
        if (isStream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('X-Key-Pool-Key', key.slice(0, 6) + '***');
          // Pipe stream
          const reader = resp.body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { res.end(); break; }
              res.write(value);
            }
          };
          pump();
          return;
        }
        const data = await resp.json();
        return res.status(200).json(data);
      }

      if (resp.status === 429) { await mark429(key); continue; }
      if (resp.status >= 500) { await mark429(key, 60000); continue; }

      return res.status(resp.status).send(await resp.text());
    } catch {
      await mark429(key, 60000);
      continue;
    }
  }

  return res.status(502).json({
    error: { message: '所有 Key 均失败', type: 'all_keys_failed', code: 502 },
  });
}
