/**
 * POST /api/chat — OpenAI 兼容代理，自动 Key 轮换
 *
 * 支持 stream (SSE) 和非 stream 模式。
 * 自动选取最优 Key，失败时切换重试。
 */
import { pickAndUse, mark429, getData } from "./lib/key-store.mjs";

const MAX_RETRIES = 15;

export default async function handler(req) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  // 默认模型
  const { defaultModel } = await getData();
  if (!body.model) body.model = defaultModel;
  const isStream = body.stream === true;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const key = await pickAndUse();
    if (!key) {
      return new Response(JSON.stringify({
        error: { message: "所有 API Key 日配额已用完，等待午夜重置", type: "quota_exhausted", code: 503 },
      }), {
        status: 503,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    try {
      const resp = await fetch("https://api-inference.modelscope.cn/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      // 成功
      if (resp.ok) {
        if (isStream) {
          return new Response(resp.body, {
            status: 200,
            headers: {
              ...headers,
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "X-Key-Pool-Key": key.slice(0, 6) + "***",
            },
          });
        }
        const data = await resp.json();
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      // 429 限流
      if (resp.status === 429) {
        await mark429(key);
        continue;
      }

      // 5xx 短暂冷却
      if (resp.status >= 500) {
        await mark429(key, 60000);
        continue;
      }

      // 其他错误直接返回
      return new Response(resp.body, {
        status: resp.status,
        headers: { ...headers, "Content-Type": resp.headers.get("content-type") || "application/json" },
      });

    } catch {
      // 网络错误
      await mark429(key, 60000);
      continue;
    }
  }

  return new Response(JSON.stringify({
    error: { message: "所有 Key 均失败", type: "all_keys_failed", code: 502 },
  }), {
    status: 502,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
