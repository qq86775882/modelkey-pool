/**
 * Key Store — 基于 Netlify Blobs 的持久化 Key 管理
 *
 * 存储格式 (keys.json blob):
 * {
 *   dailyLimit: 200,
 *   defaultModel: "deepseek-ai/DeepSeek-V4-Pro",
 *   lastResetDate: "2026-05-02",
 *   keys: [
 *     { key: "ms-xxx", totalRequests: 123, total429: 2, dailyCount: 45, cooldownUntil: 0 }
 *   ]
 * }
 */
import { getStore } from "@netlify/blobs";

const STORE_NAME = "modelkey-pool";
const BLOB_KEY = "keys.json";

let _store = null;
function store() {
  if (!_store) _store = getStore(STORE_NAME);
  return _store;
}

function mask(key) {
  return key.length > 10 ? key.slice(0, 6) + "***" + key.slice(-4) : "***";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function loadData() {
  try {
    const raw = await store().get(BLOB_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveData(data) {
  await store().set(BLOB_KEY, JSON.stringify(data, null, 2));
}

/** 获取或初始化数据，自动处理午夜重置 */
async function getData() {
  let data = await loadData();
  if (!data) {
    data = {
      dailyLimit: parseInt(process.env.DAILY_LIMIT || "200"),
      defaultModel: process.env.DEFAULT_MODEL || "deepseek-ai/DeepSeek-V4-Pro",
      lastResetDate: today(),
      keys: [],
    };
    // 从环境变量加载初始 Key
    const envKeys = (process.env.MODELSCOPE_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
    for (const k of envKeys) {
      data.keys.push({ key: k, totalRequests: 0, total429: 0, dailyCount: 0, cooldownUntil: 0 });
    }
    await saveData(data);
  }

  // 午夜重置检查
  const now = today();
  if (data.lastResetDate !== now) {
    for (const k of data.keys) {
      k.dailyCount = 0;
      k.cooldownUntil = 0;
    }
    data.lastResetDate = now;
    await saveData(data);
  }

  return data;
}

/** 选最优 Key：跳过冷却/耗尽，选剩余次数最多的 */
function selectKey(data) {
  const now = Date.now();
  const available = data.keys.filter(k =>
    k.dailyCount < data.dailyLimit && k.cooldownUntil <= now
  );
  if (available.length === 0) return null;
  return available.reduce((a, b) =>
    (data.dailyLimit - a.dailyCount) > (data.dailyLimit - b.dailyCount) ? a : b
  );
}

// ========== 导出的操作函数 ==========

export async function listKeys() {
  const data = await getData();
  const now = Date.now();
  return {
    dailyLimit: data.dailyLimit,
    defaultModel: data.defaultModel,
    totalKeys: data.keys.length,
    availableKeys: data.keys.filter(k => k.dailyCount < data.dailyLimit && k.cooldownUntil <= now).length,
    keys: data.keys.map(k => ({
      key: k.key,
      masked: mask(k.key),
      dailyCount: k.dailyCount,
      dailyLimit: data.dailyLimit,
      remaining: data.dailyLimit - k.dailyCount,
      isExhausted: k.dailyCount >= data.dailyLimit,
      isCooling: k.cooldownUntil > now,
      cooldownRemainingS: Math.max(0, Math.ceil((k.cooldownUntil - now) / 1000)),
      totalRequests: k.totalRequests,
      total429: k.total429,
    })),
  };
}

export async function addKey(key) {
  if (!key || !key.startsWith("ms-")) return { ok: false, error: "Key 必须以 ms- 开头" };
  const data = await getData();
  if (data.keys.find(k => k.key === key)) return { ok: false, error: "Key 已存在" };
  data.keys.push({ key, totalRequests: 0, total429: 0, dailyCount: 0, cooldownUntil: 0 });
  await saveData(data);
  return { ok: true, masked: mask(key) };
}

export async function removeKey(keyOrMasked) {
  const data = await getData();
  const idx = data.keys.findIndex(k => k.key === keyOrMasked || mask(k.key) === keyOrMasked);
  if (idx === -1) return { ok: false, error: "未找到 Key" };
  data.keys.splice(idx, 1);
  await saveData(data);
  return { ok: true };
}

export async function updateKey(oldKeyOrMasked, newKey) {
  if (!newKey.startsWith("ms-")) return { ok: false, error: "新 Key 必须以 ms- 开头" };
  const data = await getData();
  const entry = data.keys.find(k => k.key === oldKeyOrMasked || mask(k.key) === oldKeyOrMasked);
  if (!entry) return { ok: false, error: "未找到原 Key" };
  if (data.keys.find(k => k.key === newKey && k !== entry)) return { ok: false, error: "新 Key 已存在" };
  entry.key = newKey;
  await saveData(data);
  return { ok: true, masked: mask(newKey) };
}

/** 标记使用：计数+1 */
export async function markUsed(key) {
  const data = await getData();
  const entry = data.keys.find(k => k.key === key);
  if (!entry) return;
  entry.dailyCount++;
  entry.totalRequests++;
  await saveData(data);
}

/** 标记 429：进入冷却 */
export async function mark429(key, cooldownMs = 300000) {
  const data = await getData();
  const entry = data.keys.find(k => k.key === key);
  if (!entry) return;
  entry.cooldownUntil = Date.now() + cooldownMs;
  entry.total429++;
  await saveData(data);
}

/** 选 Key 并标记使用，返回选中的 key 或 null */
export async function pickAndUse() {
  const data = await getData();
  const selected = selectKey(data);
  if (!selected) return null;
  selected.dailyCount++;
  selected.totalRequests++;
  await saveData(data);
  return selected.key;
}

export { getData };
