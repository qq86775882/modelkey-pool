# ModelKey Pool 🔑

> ModelScope 多 API Key 智能轮换代理 —— 一把 Key 日限 200 次？那就上号池。

## 这是什么

你有 N 个 ModelScope 账号，每个每天能调 200 次 `DeepSeek-V4-Pro`。这个工具把它们池化，对外暴露一个 **OpenAI 兼容接口**，内部自动轮换，日配额用完自动切下一把，午夜自动重置。

**你的所有 AI 工具（Cursor、Cline、Cherry Studio、LangChain...）只需要改一个 Base URL，就能无感享用 N × 200 次/天的额度。**

## 架构

```
┌──────────┐      OpenAI格式        ┌───────────────┐      Bearer ms-xxx      ┌────────────────┐
│  Cursor   │ ────────────────────▶  │  ModelKey Pool │ ──────────────────────▶  │  ModelScope    │
│  Cline    │                        │  localhost:8000│     Key1用完→Key2→Key3   │  DeepSeek-V4   │
│  任意客户端 │ ◀────────────────────  │                │ ◀──────────────────────  │                │
└──────────┘      OpenAI格式        └───────┬───────┘                          └────────────────┘
                                            │
                                    ┌───────┴───────┐
                                    │  KeyManager   │
                                    │  Key1: 198/200│
                                    │  Key2:  45/200│
                                    │  Key3:   0/200│  ← 新切进来的，优先用
                                    └───────────────┘
```

## 快速开始

### 1. 配置

```bash
cp .env.example .env
# 编辑 .env，把你的 Keys 填进去
```

`.env` 示例：
```env
MODELSCOPE_KEYS=ms-abc123xxx,ms-def456yyy,ms-ghi789zzz
DAILY_LIMIT=200
DEFAULT_MODEL=deepseek-ai/DeepSeek-V4-Pro
```

### 2. 启动

```bash
pip install -r requirements.txt
python main.py
```

或者 Docker：
```bash
docker compose up -d
```

### 3. 使用

把客户端的 Base URL 指向 `http://localhost:8000/v1` 即可：

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-ai/DeepSeek-V4-Pro",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### Cursor / Cline 配置

Settings 里把 OpenAI Base URL 改成：
```
http://localhost:8000/v1
```
API Key 随便填（`sk-no-needed`），模型名填 `deepseek-ai/DeepSeek-V4-Pro`。

## Key 选择策略

1. **跳过冷却中**的 Key（刚被 429 的）
2. **跳过日配额耗尽**的 Key（≥200 次的）
3. 剩余 Key 中选**剩余可用次数最多**的 → 天然负载均衡

## 接口

| 路径 | 说明 |
|------|------|
| `POST /v1/chat/completions` | OpenAI 兼容（支持 stream） |
| `GET /health` | 健康检查 |
| `GET /status` | Key 池详细状态 |

## 午夜自动重置

内置后台线程，每天 00:00 自动将所有 Key 的日计数归零 + 解除冷却。

## License

MIT
