import { pickAndUse, mark429, getKeyStats, getPoolStats, syncKeyFromHeaders } from './lib/key-store.js';

const MAX_RETRIES = 15;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== apiKey) { res.status(401).json({ error: 'Unauthorized' }); return; }
  }

  let body; try { body = req.body; } catch { res.status(400).json({ error: 'Invalid JSON' }); return; }
  const stream = body.stream === true;
  const model = body.model || process.env.DEFAULT_MODEL || 'deepseek-ai/DeepSeek-V4-Pro';

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const key = await pickAndUse(model);
    if (!key) { res.status(503).json({ error: '所有 Key 今日配额已用尽', code: 'ALL_KEYS_EXHAUSTED' }); return; }

    const [stats, pool] = await Promise.all([getKeyStats(key, model), getPoolStats(model)]);
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
        body: JSON.stringify({ ...body, model, stream }),
      });

      if (upstreamResp.status === 429) { await mark429(key); continue; }
      if (upstreamResp.status >= 500) { continue; }

      // 透传 ModelScope 限流头
      ['modelscope-ratelimit-model-requests-limit',
       'modelscope-ratelimit-model-requests-remaining',
       'modelscope-ratelimit-requests-limit',
       'modelscope-ratelimit-requests-remaining'].forEach(h => {
        try { const v = upstreamResp.headers.get(h); if (v) res.setHeader(h, v); } catch {}
      });

      // Stream
      if (stream && upstreamResp.ok) {
        res.status(200).setHeader('Content-Type', 'text/event-stream');
        const reader = upstreamResp.body.getReader();
        const decoder = new TextDecoder();
        try { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(decoder.decode(value, { stream: true })); } }
        finally { reader.releaseLock(); res.end(); }
        syncKeyFromHeaders(key, model, upstreamResp.headers).catch(() => {});
        return;
      }

      // 非 Stream
      if (upstreamResp.ok) {
        const data = await upstreamResp.json();
        syncKeyFromHeaders(key, model, upstreamResp.headers).catch(() => {});
        res.status(200).json(data);
        return;
      }

      const errText = await upstreamResp.text().catch(() => '');
      res.status(upstreamResp.status).json({ error: errText.slice(0, 500), code: 'UPSTREAM_ERROR', status: upstreamResp.status });
      return;
    } catch (e) {
      if (attempt < MAX_RETRIES - 1) { await mark429(key, 60000); continue; }
      res.status(502).json({ error: `请求失败: ${e.message}`, code: 'NETWORK_ERROR' });
      return;
    }
  }
}
