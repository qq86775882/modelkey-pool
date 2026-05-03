/**
 * POST /api/chat — OpenAI 兼容代理，自动 Key 轮换
 * 支持 stream (SSE) 和非 stream 模式。
 */
import { pickAndUse, mark429, getData, getKeyStats, getPoolStats } from './lib/key-store.js';

const MAX_RETRIES = 15;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // 外部 API Key 鉴权（可选：未设 API_KEY 环境变量时跳过鉴权）
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== apiKey) {
      res.status(401).json({ error: 'Unauthorized: API Key 不正确', code: 'UNAUTHORIZED' });
      return;
    }
  }

  let body;
  try {
    body = req.body;
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  const stream = body.stream === true;
  const model = body.model || process.env.DEFAULT_MODEL || 'deepseek-ai/DeepSeek-V4-Pro';

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const key = await pickAndUse();
    if (!key) {
      res.status(503).json({
        error: '所有 Key 今日配额已用尽，请等待午夜重置',
        code: 'ALL_KEYS_EXHAUSTED',
      });
      return;
    }

    // 设置用量响应头
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
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ ...body, model, stream }),
      });

      // 429 → 标记冷却，重试
      if (upstreamResp.status === 429) {
        await mark429(key);
        continue;
      }

      // 透传 ModelScope 官方限流头
      ['modelscope-ratelimit-model-requests-limit',
       'modelscope-ratelimit-model-requests-remaining',
       'modelscope-ratelimit-requests-limit',
       'modelscope-ratelimit-requests-remaining'].forEach(h => {
        const v = upstreamResp.headers.get(h);
        if (v) res.setHeader(h, v);
      });

      // 5xx → 短暂冷却，重试
      if (upstreamResp.status >= 500) {
        continue;
      }

      // Stream 模式
      if (stream && upstreamResp.ok) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const reader = upstreamResp.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(decoder.decode(value, { stream: true }));
          }
        } catch (e) {
          // client disconnected
        } finally {
          reader.releaseLock();
          res.end();
        }
        return;
      }

      // 非 Stream 模式
      if (upstreamResp.ok) {
        const data = await upstreamResp.json();
        res.status(200).json(data);
        return;
      }

      // 其他错误
      const errText = await upstreamResp.text().catch(() => '');
      res.status(upstreamResp.status).json({
        error: errText.slice(0, 500),
        code: 'UPSTREAM_ERROR',
        status: upstreamResp.status,
      });
      return;
    } catch (e) {
      // 网络错误 → 重试
      if (attempt >= MAX_RETRIES - 1) {
        res.status(502).json({ error: `请求失败: ${e.message}`, code: 'NETWORK_ERROR' });
      }
    }
  }

  res.status(502).json({ error: '所有重试均失败', code: 'ALL_RETRIES_FAILED' });
}
