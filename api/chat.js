import { pickAndUse, mark429, getKeyStats, getPoolStats } from './lib/key-store.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let body;
  try { body = req.body; } catch { res.status(400).json({ error: 'Invalid JSON' }); return; }

  const model = body.model || 'deepseek-ai/DeepSeek-V4-Pro';
  const key = await pickAndUse();
  if (!key) { res.status(503).json({ error: '所有 Key 今日配额已用尽' }); return; }

  // 用量响应头
  const [stats, pool] = await Promise.all([getKeyStats(key), getPoolStats()]);
  if (stats) {
    res.setHeader('X-Key-Pool-Key', stats.masked);
    res.setHeader('X-Key-Pool-Usage', `${stats.dailyCount}/${stats.dailyLimit}`);
    res.setHeader('X-Key-Pool-Remaining', String(stats.remaining));
  }
  res.setHeader('X-Key-Pool-Total', String(pool.totalKeys));
  res.setHeader('X-Key-Pool-Available', String(pool.availableKeys));

  try {
    const upstreamResp = await fetch('https://api-inference.modelscope.cn/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...body, model, stream: false }),
    });

    if (upstreamResp.status === 429) { await mark429(key); res.status(429).json({ error: 'Key 已限流' }); return; }

    if (!upstreamResp.ok) {
      const errText = await upstreamResp.text().catch(() => '');
      res.status(upstreamResp.status).json({ error: errText.slice(0, 200), status: upstreamResp.status });
      return;
    }

    // 透传 ModelScope 限流头
    ['modelscope-ratelimit-model-requests-limit',
     'modelscope-ratelimit-model-requests-remaining',
     'modelscope-ratelimit-requests-limit',
     'modelscope-ratelimit-requests-remaining'].forEach(h => {
      const v = upstreamResp.headers.get(h);
      if (v) res.setHeader(h, v);
    });

    const data = await upstreamResp.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
