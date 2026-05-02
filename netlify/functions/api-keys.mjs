/**
 * /api/keys — Key 池 CRUD
 * GET    → 列出所有 Key 状态
 * POST   → 添加 Key
 * DELETE → 删除 Key (query: ?key=xxx)
 * PUT    → 更新 Key
 */
import { listKeys, addKey, removeKey, updateKey } from "./lib/key-store.mjs";

export default async function handler(req) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    if (req.method === "GET") {
      return new Response(JSON.stringify(await listKeys()), { headers });
    }

    if (req.method === "POST") {
      const { key } = await req.json();
      const result = await addKey(key);
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 400,
        headers,
      });
    }

    if (req.method === "PUT") {
      const { old_key, new_key } = await req.json();
      const result = await updateKey(old_key, new_key);
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 400,
        headers,
      });
    }

    if (req.method === "DELETE") {
      const url = new URL(req.url);
      const key = url.searchParams.get("key");
      if (!key) {
        return new Response(JSON.stringify({ ok: false, error: "缺少 key 参数" }), { status: 400, headers });
      }
      const result = await removeKey(decodeURIComponent(key));
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 404,
        headers,
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers });
  }
}
