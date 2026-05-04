import { pickAndUse, mark429, syncKeyFromHeaders } from './lib/key-store.js';

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
    const result = await pickAndUse(model);
    if (!result) { res.status(503).json({ error: '所有 Key 今日配额已用尽', code: 'ALL_KEYS_EXHAUSTED' }); return; }

    const { key, stats, pool } = result;

    // stats 和 pool 已由 pickAndUse 一次返回，不再单独调 getKeyStats/getPoolStats
    res.setHeader('X-Key-Pool-Key', stats.masked);
    res.setHeader('X-Key-Pool-Usage', `${stats.dailyCount}/${stats.dailyLimit}`);
    res.setHeader('X-Key-Pool-Remaining', String(stats.remaining));
    res.setHeader('X-Key-Pool-Total', String(pool.totalKeys));
    res.setHeader('X-Key-Pool-Available', String(pool.availableKeys));

    try {
      const upstreamResp = await fetch('https://api-inference.modelscope.cn/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ ...body, model, stream }),
      });

      if (upstreamResp.status === 429) {
        syncKeyFromHeaders(key, model, upstreamResp.headers).catch(() => {});
        continue;
      }
      if (upstreamResp.status >= 500) { await mark429(key, 10000); continue; }

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
        try { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(decoder.decode(value, { stream: true })); } } catch {}
        res.end();
        return;
      }

      // 非 stream → 同步真实用量
      if (upstreamResp.ok) {
        syncKeyFromHeaders(key, model, upstreamResp.headers).catch(() => {});
      }

      const data = await upstreamResp.json();
      res.status(upstreamResp.status).json(data);
      return;
    } catch (e) {
      await mark429(key, Math.min((attempt + 1) * 5000, 30000));
    }
  }
  res.status(503).json({ error: '所有 Key 暂时不可用', code: 'ALL_KEYS_DOWN' });
}
