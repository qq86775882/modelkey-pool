/**
 * POST /api/keys-test — 测试一把 Key 是否可用
 */
import { getData } from "./lib/key-store.mjs";

export default async function handler(req) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  try {
    const { key, model, message } = await req.json();
    if (!key) {
      return new Response(JSON.stringify({ ok: false, error: "缺少 key" }), { status: 400, headers });
    }

    const { defaultModel } = await getData();
    const start = Date.now();

    const resp = await fetch("https://api-inference.modelscope.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || defaultModel,
        messages: [{ role: "user", content: message || "Hello, reply with just OK." }],
        max_tokens: 50,
      }),
    });
    const elapsed = Date.now() - start;

    if (resp.ok) {
      const data = await resp.json();
      return new Response(JSON.stringify({
        ok: true,
        status: resp.status,
        latencyMs: elapsed,
        model: data.model || "",
        reply: data.choices?.[0]?.message?.content?.slice(0, 200) || "",
        usage: data.usage || {},
      }), { headers });
    } else {
      const text = await resp.text();
      return new Response(JSON.stringify({
        ok: false,
        status: resp.status,
        latencyMs: elapsed,
        error: text.slice(0, 500),
      }), { headers });
    }
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      status: 0,
      latencyMs: 0,
      error: e.message,
    }), { headers });
  }
}
