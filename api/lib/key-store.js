/**
 * Key Store — Vercel KV 优先 / 内存回退
 */
let kv = null;
try {
  const mod = await import('@vercel/kv');
  kv = mod.kv;
} catch {
  // KV not available, use in-memory
}

const memoryStore = new Map();
let memoryResetDate = null;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function mask(key) {
  return key.length > 10 ? key.slice(0, 6) + '***' + key.slice(-4) : '***';
}

function getDefaultModel() {
  return process.env.DEFAULT_MODEL || 'deepseek-ai/DeepSeek-V4-Pro';
}

function getDailyLimit() {
  return parseInt(process.env.DAILY_LIMIT || '200');
}

async function getData() {
  if (kv) {
    try {
      const raw = await kv.get('modelkey-pool:data');
      if (raw) return raw;
    } catch {}
  }

  // Fallback: memory or init from env
// 兜底 Key 列表：环境变量为空时使用
const FALLBACK_KEYS = [
  'ms-9888e4a5-5b07-47d9-839e-e39cd2f12121',
  'ms-4f9a791e-c673-4872-8193-85af83eb236d',
  'ms-ed151332-dfb5-4cda-a6be-80d090e5590f',
  'ms-e6becd98-b08d-494a-9df4-9b4ba87917c3',
  'ms-b674b42f-0fe4-4804-9b06-d30756a07c35',
  'ms-8cd46fa0-b9e7-4869-abce-6d69b9df1964',
];

  const now = today();
  if (memoryResetDate !== now) {
    memoryStore.clear();
    memoryResetDate = now;
    // Load keys from env, fallback to hardcoded list
    const envKeys = (process.env.MODELSCOPE_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
    const initialKeys = envKeys.length > 0 ? envKeys : FALLBACK_KEYS;
    for (const k of initialKeys) {
      memoryStore.set(k, { key: k, totalRequests: 0, total429: 0, dailyCount: 0, cooldownUntil: 0 });
    }
  }

  const keys = [];
  for (const [, v] of memoryStore) keys.push(v);

  return { keys, dailyLimit: getDailyLimit(), defaultModel: getDefaultModel() };
}

async function saveData(data) {
  if (kv) {
    try { await kv.set('modelkey-pool:data', data); } catch {}
  }
  // In memory mode: update Map
  memoryStore.clear();
  for (const k of data.keys) {
    memoryStore.set(k.key, { ...k });
  }
}

function selectKey(data) {
  const now = Date.now();
  const available = data.keys.filter(k => k.dailyCount < data.dailyLimit && k.cooldownUntil <= now);
  if (available.length === 0) return null;
  return available.reduce((a, b) => (data.dailyLimit - a.dailyCount) > (data.dailyLimit - b.dailyCount) ? a : b);
}

// ========== Public API ==========

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
      totalRequests: k.totalRequests || 0,
      total429: k.total429 || 0,
    })),
  };
}

export async function addKey(key) {
  if (!key || !key.startsWith('ms-')) return { ok: false, error: 'Key 必须以 ms- 开头' };
  const data = await getData();
  if (data.keys.find(k => k.key === key)) return { ok: false, error: 'Key 已存在' };
  data.keys.push({ key, totalRequests: 0, total429: 0, dailyCount: 0, cooldownUntil: 0 });
  await saveData(data);
  return { ok: true, masked: mask(key) };
}

export async function removeKey(keyOrMasked) {
  const data = await getData();
  const idx = data.keys.findIndex(k => k.key === keyOrMasked || mask(k.key) === keyOrMasked);
  if (idx === -1) return { ok: false, error: '未找到 Key' };
  data.keys.splice(idx, 1);
  await saveData(data);
  return { ok: true };
}

export async function updateKey(oldKeyOrMasked, newKey) {
  if (!newKey.startsWith('ms-')) return { ok: false, error: '新 Key 必须以 ms- 开头' };
  const data = await getData();
  const entry = data.keys.find(k => k.key === oldKeyOrMasked || mask(k.key) === oldKeyOrMasked);
  if (!entry) return { ok: false, error: '未找到原 Key' };
  if (data.keys.find(k => k.key === newKey && k !== entry)) return { ok: false, error: '新 Key 已存在' };
  entry.key = newKey;
  await saveData(data);
  return { ok: true, masked: mask(newKey) };
}

export async function markUsed(key) {
  const data = await getData();
  const entry = data.keys.find(k => k.key === key);
  if (!entry) return;
  entry.dailyCount++;
  entry.totalRequests = (entry.totalRequests || 0) + 1;
  await saveData(data);
}

export async function mark429(key, cooldownMs = 300000) {
  const data = await getData();
  const entry = data.keys.find(k => k.key === key);
  if (!entry) return;
  entry.cooldownUntil = Date.now() + cooldownMs;
  entry.total429 = (entry.total429 || 0) + 1;
  await saveData(data);
}

export async function pickAndUse() {
  const data = await getData();
  const selected = selectKey(data);
  if (!selected) return null;
  selected.dailyCount++;
  selected.totalRequests = (selected.totalRequests || 0) + 1;
  await saveData(data);
  return selected.key;
}

export { getData, getDefaultModel };
