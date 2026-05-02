# 🔑 ModelKey Pool v2

> ModelScope 多 API Key 智能轮换代理 — React + Netlify Functions 全栈版

你有 N 个 ModelScope 账号，每个每天能调 200 次 `DeepSeek-V4-Pro`。这个工具把它们池化，对外暴露 **OpenAI 兼容接口**，内部自动轮换，日配额用完自动切下一把，午夜自动重置。

内置 **Web 管理面板**，支持 Key 增删改查 + 测试。

## 🏗️ 架构

```
┌──────────┐                  ┌─────────────────────┐                ┌────────────────┐
│  Cursor   │                  │  Netlify Functions   │                │  ModelScope    │
│  Cline    │ ── OpenAI ────▶  │  /api/chat           │ ─────────────▶  │  DeepSeek-V4   │
│  任意客户端 │                  │  (自动 Key 轮换)      │                │                │
└──────────┘                  ├─────────────────────┤                └────────────────┘
                              │  /api/keys (CRUD)    │
┌──────────┐                  │  /api/keys-test      │
│  管理面板  │ ── REST ──────▶  ├─────────────────────┤
│  (React)  │                  │  Netlify Blobs       │
│           │                  │  (持久化存储)         │
└──────────┘                  └─────────────────────┘
```

## 🚀 快速开始

### 1. 安装

```bash
npm install
```

### 2. 配置

```bash
cp .env.example .env
# 编辑 .env，填入你的 ModelScope Keys
```

### 3. 本地开发

```bash
npm run netlify-dev
```

打开 `http://localhost:8888` — 左边是管理面板，API 走 Netlify Functions。

### 4. 部署到 Netlify

```bash
# 安装 Netlify CLI
npx netlify login
npx netlify init

# 部署
npx netlify deploy --prod
```

或者直接在 Netlify 网页端连接 GitHub 仓库，自动部署。

## 📡 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/keys` | 列出所有 Key 状态 |
| `POST` | `/api/keys` | 添加 Key `{key: "ms-xxx"}` |
| `PUT` | `/api/keys` | 更新 Key `{old_key, new_key}` |
| `DELETE` | `/api/keys?key=ms-xxx` | 删除 Key |
| `POST` | `/api/keys-test` | 测试 Key `{key, model?, message?}` |
| `POST` | `/api/chat` | OpenAI 兼容代理（支持 stream） |

## 🧩 客户端接入

将 OpenAI Base URL 改为你的 Netlify 域名：

```
https://your-site.netlify.app/api/chat
```

API Key 随便填即可（`sk-no-needed`），模型名用 `deepseek-ai/DeepSeek-V4-Pro`。

## 📦 技术栈

- **前端**: React 18 + Vite
- **后端**: Netlify Functions (Node.js)
- **存储**: Netlify Blobs (持久化)
- **部署**: Netlify (静态 + Serverless)

## 📝 环境变量

部署到 Netlify 后，在 Dashboard → Site settings → Environment variables 中设置：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MODELSCOPE_KEYS` | 初始 Key 列表（逗号分隔） | - |
| `DAILY_LIMIT` | 每把 Key 日限额 | 200 |
| `DEFAULT_MODEL` | 默认模型 | deepseek-ai/DeepSeek-V4-Pro |
