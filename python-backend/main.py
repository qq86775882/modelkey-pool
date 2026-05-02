"""
ModelKey Pool —— ModelScope 多 Key 智能轮换代理

对外暴露 OpenAI 兼容的 /v1/chat/completions 端点，
内部自动在多把 ModelScope API Key 之间轮换，
日配额用尽自动切换，遇到 429 自动冷却。

内置 Web 管理面板 (/)：增删改查、测试 Key、实时状态。
"""

import json
import logging
import time
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import (
    MODELSCOPE_BASE_URL,
    DEFAULT_MODEL,
    PROXY_PORT,
    LOG_LEVEL,
    DAILY_LIMIT,
    get_keys,
)
from key_manager import KeyManager

# ---------- 日志 ----------
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("modelkey-pool")

# ---------- 初始化 ----------
keys = get_keys()
key_mgr = KeyManager(keys)
http_client: httpx.AsyncClient | None = None

# ---------- Pydantic 模型 ----------

class KeyAddRequest(BaseModel):
    key: str

class KeyUpdateRequest(BaseModel):
    old_key: str
    new_key: str

class KeyTestRequest(BaseModel):
    key: str
    model: str = DEFAULT_MODEL
    message: str = "Hello, reply with just 'OK'."


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    limits = httpx.Limits(max_keepalive_connections=20, max_connections=50)
    http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(120.0, connect=10.0),
        limits=limits,
    )
    logger.info(f"🚀 ModelKey Pool 启动，{len(keys)} 把 Key，日限额 {DAILY_LIMIT}/Key")
    yield
    key_mgr.shutdown()
    if http_client:
        await http_client.aclose()
    logger.info("ModelKey Pool 已关闭")


app = FastAPI(title="ModelKey Pool", version="1.1.0", lifespan=lifespan)

# ---------- 静态文件（Web 管理面板）----------
import os as _os
_STATIC_DIR = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "static")


@app.get("/", response_class=HTMLResponse)
async def admin_panel():
    """Web 管理面板首页"""
    html_path = _os.path.join(_STATIC_DIR, "admin.html")
    if _os.path.exists(html_path):
        with open(html_path, encoding="utf-8") as f:
            return HTMLResponse(f.read())
    return HTMLResponse("<h1>admin.html not found</h1>", status_code=404)


# ---------- 管理 API ----------

@app.get("/api/keys")
async def list_keys():
    """获取所有 Key 的状态"""
    return {
        "daily_limit": DAILY_LIMIT,
        "default_model": DEFAULT_MODEL,
        "total_keys": len(key_mgr.get_all_keys()),
        "available_keys": key_mgr.available_count(),
        "keys": key_mgr.get_all_status(),
    }


@app.post("/api/keys")
async def add_key(req: KeyAddRequest):
    """添加一把新 Key"""
    result = key_mgr.add_key(req.key)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@app.delete("/api/keys/{key_id}")
async def delete_key(key_id: str):
    """删除一把 Key（key_id 可以是完整 key 或 masked 形式）"""
    # URL decode
    from urllib.parse import unquote
    key_id = unquote(key_id)
    result = key_mgr.remove_key(key_id)
    if not result["ok"]:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@app.put("/api/keys")
async def update_key(req: KeyUpdateRequest):
    """更新一把 Key"""
    result = key_mgr.update_key(req.old_key, req.new_key)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@app.post("/api/keys/test")
async def test_key(req: KeyTestRequest):
    """测试一把 Key 是否可用"""
    import time as _time
    start = _time.time()
    try:
        resp = await http_client.post(
            f"{MODELSCOPE_BASE_URL}/chat/completions",
            json={
                "model": req.model,
                "messages": [{"role": "user", "content": req.message}],
                "max_tokens": 50,
            },
            headers={"Authorization": f"Bearer {req.key}"},
        )
        elapsed = round((_time.time() - start) * 1000)
        if resp.status_code == 200:
            data = resp.json()
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            return {
                "ok": True,
                "status": resp.status_code,
                "latency_ms": elapsed,
                "model": data.get("model", ""),
                "reply": content[:200],
                "usage": data.get("usage", {}),
            }
        else:
            return {
                "ok": False,
                "status": resp.status_code,
                "latency_ms": elapsed,
                "error": resp.text[:500],
            }
    except Exception as e:
        elapsed = round((_time.time() - start) * 1000)
        return {"ok": False, "status": 0, "latency_ms": elapsed, "error": str(e)}


# ---------- 核心代理 ----------

MAX_RETRIES = 15


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    if "model" not in body or not body.get("model"):
        body["model"] = DEFAULT_MODEL

    is_stream = body.get("stream", False)
    tried_keys: set[str] = set()

    for attempt in range(MAX_RETRIES):
        key_state = key_mgr.select_key()
        if key_state is None:
            if is_stream:
                async def no_key_stream():
                    err = json.dumps({"error": {"message": "所有 API Key 日配额已用完，等待午夜重置", "type": "quota_exhausted", "code": 503}})
                    yield f"data: {err}\n\ndata: [DONE]\n\n"
                return StreamingResponse(no_key_stream(), media_type="text/event-stream")
            return JSONResponse(status_code=503, content={"error": {"message": "所有 API Key 日配额已用完", "type": "quota_exhausted", "code": 503}})

        current_key = key_state.key
        tried_keys.add(current_key)
        key_mgr.mark_used(current_key)
        headers = {"Authorization": f"Bearer {current_key}", "Content-Type": "application/json"}

        try:
            if is_stream:
                return StreamingResponse(
                    _stream_proxy(body, current_key, headers, tried_keys, attempt),
                    media_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Key-Pool-Key": key_state.masked},
                )
            else:
                resp = await http_client.post(f"{MODELSCOPE_BASE_URL}/chat/completions", json=body, headers=headers)
                if resp.status_code == 200:
                    data = resp.json()
                    if isinstance(data, dict):
                        data["x_key_pool_key"] = key_state.masked
                    return JSONResponse(content=data)
                elif resp.status_code == 429:
                    key_mgr.mark_429(current_key)
                    continue
                elif resp.status_code in (500, 502, 503):
                    key_mgr.mark_error(current_key)
                    continue
                else:
                    return JSONResponse(status_code=resp.status_code, content=resp.json() if "application/json" in resp.headers.get("content-type", "") else {"error": resp.text})
        except (httpx.ConnectError, httpx.TimeoutException, httpx.RemoteProtocolError) as e:
            logger.warning(f"Key {key_state.masked} 网络错误: {e}")
            key_mgr.mark_error(current_key)
            continue

    return JSONResponse(status_code=502, content={"error": {"message": f"所有 Key 均失败", "type": "all_keys_failed", "code": 502}})


async def _stream_proxy(body, current_key, headers, tried_keys, attempt):
    last_error = None
    while attempt < MAX_RETRIES:
        try:
            async with http_client.stream("POST", f"{MODELSCOPE_BASE_URL}/chat/completions", json=body, headers=headers) as resp:
                if resp.status_code == 200:
                    async for chunk in resp.aiter_bytes():
                        yield chunk
                    return
                elif resp.status_code == 429:
                    key_mgr.mark_429(current_key)
                elif resp.status_code in (500, 502, 503):
                    key_mgr.mark_error(current_key)
                else:
                    yield await resp.aread()
                    return
        except (httpx.ConnectError, httpx.TimeoutException, httpx.RemoteProtocolError) as e:
            last_error = str(e)
            key_mgr.mark_error(current_key)

        attempt += 1
        key_state = key_mgr.select_key()
        if key_state is None:
            break
        current_key = key_state.key
        tried_keys.add(current_key)
        key_mgr.mark_used(current_key)
        headers = {"Authorization": f"Bearer {current_key}", "Content-Type": "application/json"}

    err = json.dumps({"error": {"message": f"流式请求失败: {last_error or '所有Key不可用'}", "type": "stream_failed", "code": 502}})
    yield f"data: {err}\n\ndata: [DONE]\n\n".encode()


# ---------- 健康检查 ----------

@app.get("/health")
async def health():
    available = key_mgr.available_count()
    return {"status": "ok" if available > 0 else "exhausted", "available_keys": available, "total_keys": len(keys)}


@app.get("/status")
async def status():
    return {
        "daily_limit_per_key": DAILY_LIMIT,
        "default_model": DEFAULT_MODEL,
        "total_keys": len(keys),
        "available_keys": key_mgr.available_count(),
        "keys": key_mgr.get_all_status(),
    }


# ---------- 入口 ----------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PROXY_PORT, log_level=LOG_LEVEL.lower())
