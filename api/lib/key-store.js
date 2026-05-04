/**
 * Key Store — Neon PostgreSQL (Serverless SQL API)
 * v3: 性能优化 — 模块级缓存降低重复调用，DB 调用从 ~18 次降至 ~5 次
 */
const NEON_SQL = process.env.NEON_SQL_ENDPOINT || 'https://ep-young-sound-ahwn29w0.c-3.us-east-1.aws.neon.tech/sql';
const NEON_URL = process.env.NEON_DATABASE_URL || 'postgresql://neondb_owner:npg_0mdBGEUf2DcV@ep-young-sound-ahwn29w0.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require';

function today() { return new Date().toISOString().slice(0, 10); }
function mask(key) { return key.length > 10 ? key.slice(0, 6) + '***' + key.slice(-4) : '***'; }
function getDefaultModel() { return process.env.DEFAULT_MODEL || 'deepseek-ai/DeepSeek-V4-Pro'; }
function getDailyLimit() { return parseInt(process.env.DAILY_LIMIT || '500'); }
function getConfig() { return { dailyLimit: getDailyLimit(), defaultModel: getDefaultModel() }; }

const KNOWN_MODELS = ['deepseek-ai/DeepSeek-V4-Pro', 'ZhipuAI/GLM-5'];

// ===== 模块级缓存：降低 DB 重复调用 =====
let _dataCache = null;      // { data, model, ts }
let _resetCache = null;     // { ts }
const DATA_TTL = 3000;      // getData 缓存 3s
const RESET_TTL = 5000;     // midnightReset 缓存 5s

async function neonQuery(query, params = []) {
  const resp = await fetch(NEON_SQL, {
    method: 'POST',
    headers: { 'neon-connection-string': NEON_URL, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, params }),
  });
  if (!resp.ok) { const err = await resp.text(); throw new Error(`Neon ${resp.status}: ${err}`); }
  return resp.json();
}

// Neon SQL API 不支持多语句，但 5s 缓存让 3 次调用的 overhead 可忽略
async function ensureTables() {
  await neonQuery(`CREATE TABLE IF NOT EXISTS key_store (
    api_key TEXT PRIMARY KEY, total_requests INT DEFAULT 0, total_429 INT DEFAULT 0,
    cooldown_until BIGINT DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await neonQuery(`CREATE TABLE IF NOT EXISTS key_model_usage (
    api_key TEXT NOT NULL, model TEXT NOT NULL, daily_count INT DEFAULT 0,
    PRIMARY KEY (api_key, model))`);
  await neonQuery(`CREATE TABLE IF NOT EXISTS meta_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

async function midnightReset() {
  // 5 秒内跳过重复检查
  const ts = Date.now();
  if (_resetCache && (ts - _resetCache.ts) < RESET_TTL) return;

  await ensureTables();
  const now = today();
  const r = await neonQuery("SELECT value FROM meta_state WHERE key = 'reset_date'");
  const stored = r.rows.length > 0 ? r.rows[0].value : null;
  if (stored !== now) {
    await neonQuery('UPDATE key_model_usage SET daily_count = 0');
    await neonQuery('UPDATE key_store SET cooldown_until = 0');
    await neonQuery("INSERT INTO meta_state (key, value) VALUES ('reset_date', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [now]);
  }
  const cnt = await neonQuery('SELECT COUNT(*) as n FROM key_store');
  if (parseInt(cnt.rows[0].n) === 0) {
    const envKeys = (process.env.MODELSCOPE_KEYS || '').split(',').map(k => k.trim()).filter(k => k.startsWith('ms-'));
    for (const k of envKeys) {
      await neonQuery('INSERT INTO key_store (api_key) VALUES ($1) ON CONFLICT DO NOTHING', [k]);
      for (const m of KNOWN_MODELS)
        await neonQuery('INSERT INTO key_model_usage (api_key, model, daily_count) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING', [k, m]);
    }
  }
  _resetCache = { ts };
}

// ========== Core ==========

async function getData(model) {
  const m = model || getDefaultModel();
  const ts = Date.now();
  // 缓存命中
  if (_dataCache && _dataCache.model === m && (ts - _dataCache.ts) < DATA_TTL) {
    return _dataCache.data;
  }

  await midnightReset();
  const keys = await neonQuery('SELECT * FROM key_store ORDER BY api_key');
  const usage = await neonQuery('SELECT * FROM key_model_usage WHERE model = $1', [m]);
  const usageMap = {};
  for (const u of usage.rows) usageMap[u.api_key] = u.daily_count;

  const data = {
    model: m,
    keys: keys.rows.map(r => ({
      key: r.api_key,
      masked: mask(r.api_key),
      dailyCount: usageMap[r.api_key] || 0,
      totalRequests: r.total_requests,
      total429: r.total_429,
      cooldownUntil: r.cooldown_until,
    })),
    ...getConfig(),
  };

  _dataCache = { data, model: m, ts };
  return data;
}

function selectKey(data) {
  const now = Date.now();
  const available = data.keys.filter(k => k.dailyCount < data.dailyLimit && k.cooldownUntil <= now);
  if (available.length === 0) return null;
  return available.reduce((a, b) => (data.dailyLimit - a.dailyCount) > (data.dailyLimit - b.dailyCount) ? a : b);
}

// ========== Public API ==========

export async function listKeys(model) {
  const m = model || getDefaultModel();
  const data = await getData(m);
  const now = Date.now();
  const limit = data.dailyLimit;

  const keyList = data.keys.map(k => ({
    key: k.key, masked: k.masked,
    dailyCount: k.dailyCount, dailyLimit: limit, remaining: limit - k.dailyCount,
    isExhausted: k.dailyCount >= limit, isCooling: k.cooldownUntil > now,
    cooldownRemainingS: Math.max(0, Math.ceil((k.cooldownUntil - now) / 1000)),
    totalRequests: k.totalRequests, total429: k.total429,
  }));

  return {
    model: m, dailyLimit: limit, defaultModel: getDefaultModel(),
    totalKeys: keyList.length,
    availableKeys: keyList.filter(k => !k.isExhausted && !k.isCooling).length,
    keys: keyList,
  };
}

export async function addKey(key) {
  if (!key || !key.startsWith('ms-')) return { ok: false, error: 'Key 必须以 ms- 开头' };
  try {
    await neonQuery("INSERT INTO key_store (api_key) VALUES ($1) ON CONFLICT (api_key) DO NOTHING", [key]);
    for (const m of KNOWN_MODELS)
      await neonQuery('INSERT INTO key_model_usage (api_key, model, daily_count) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING', [key, m]);
    _dataCache = null;
    return { ok: true, masked: mask(key) };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function removeKey(keyOrMasked) {
  const data = await getData(getDefaultModel());
  const entry = data.keys.find(k => k.key === keyOrMasked || k.masked === keyOrMasked);
  if (!entry) return { ok: false, error: '未找到 Key' };
  await neonQuery('DELETE FROM key_model_usage WHERE api_key = $1', [entry.key]);
  await neonQuery('DELETE FROM key_store WHERE api_key = $1', [entry.key]);
  _dataCache = null;
  return { ok: true };
}

export async function updateKey(oldKeyOrMasked, newKey) {
  if (!newKey.startsWith('ms-')) return { ok: false, error: '新 Key 必须以 ms- 开头' };
  const data = await getData(getDefaultModel());
  const entry = data.keys.find(k => k.key === oldKeyOrMasked || k.masked === oldKeyOrMasked);
  if (!entry) return { ok: false, error: '未找到原 Key' };
  try {
    await neonQuery('DELETE FROM key_model_usage WHERE api_key = $1', [entry.key]);
    await neonQuery('UPDATE key_store SET api_key = $1, cooldown_until = 0 WHERE api_key = $2', [newKey, entry.key]);
    for (const m of KNOWN_MODELS)
      await neonQuery('INSERT INTO key_model_usage (api_key, model, daily_count) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING', [newKey, m]);
    _dataCache = null;
    return { ok: true, masked: mask(newKey) };
  } catch (e) {
    if (e.message.includes('duplicate key')) return { ok: false, error: '新 Key 已存在' };
    return { ok: false, error: e.message };
  }
}

export async function mark429(key, cooldownMs = 300000) {
  const until = Date.now() + cooldownMs;
  await neonQuery('UPDATE key_store SET cooldown_until = $1, total_429 = total_429 + 1 WHERE api_key = $2', [until, key]);
  _dataCache = null;
}

// pickAndUse 现在一次性返回 key + stats + pool，不再需要单独调 getKeyStats/getPoolStats
export async function pickAndUse(model) {
  const m = model || getDefaultModel();
  const data = await getData(m);
  const selected = selectKey(data);
  if (!selected) return null;

  // 预扣
  await neonQuery(
    'UPDATE key_model_usage SET daily_count = daily_count + 1 WHERE api_key = $1 AND model = $2',
    [selected.key, m]
  );
  await neonQuery('UPDATE key_store SET total_requests = total_requests + 1 WHERE api_key = $1', [selected.key]);

  // stats
  const newDailyCount = selected.dailyCount + 1;
  const stats = {
    key: selected.key, masked: selected.masked,
    dailyCount: newDailyCount, dailyLimit: data.dailyLimit,
    remaining: data.dailyLimit - newDailyCount,
  };
  // pool（基于 getData 结果计算，无需再查库）
  const now = Date.now();
  const pool = {
    model: m,
    totalKeys: data.keys.length,
    availableKeys: data.keys.filter(k =>
      (k.key === selected.key
        ? newDailyCount < data.dailyLimit
        : k.dailyCount < data.dailyLimit && k.cooldownUntil <= now)
    ).length,
    dailyLimit: data.dailyLimit,
  };

  return { key: selected.key, stats, pool };
}

export async function getKeyStats(key, model) {
  const m = model || getDefaultModel();
  const data = await getData(m);
  const k = data.keys.find(x => x.key === key);
  if (!k) return null;
  return {
    key: k.key, masked: k.masked,
    dailyCount: k.dailyCount, dailyLimit: data.dailyLimit,
    remaining: data.dailyLimit - k.dailyCount,
    cooldownUntil: k.cooldownUntil,
  };
}

export async function getPoolStats(model) {
  const m = model || getDefaultModel();
  const data = await getData(m);
  const now = Date.now();
  return {
    model: m,
    totalKeys: data.keys.length,
    availableKeys: data.keys.filter(k => k.dailyCount < data.dailyLimit && k.cooldownUntil <= now).length,
    dailyLimit: data.dailyLimit,
  };
}

export async function syncKeyFromHeaders(key, model, headers) {
  try {
    const m = model || getDefaultModel();
    const limit = parseInt(headers.get('modelscope-ratelimit-model-requests-limit')) || null;
    const remaining = parseInt(headers.get('modelscope-ratelimit-model-requests-remaining'));
    if (limit && !isNaN(remaining)) {
      const used = limit - remaining;
      await neonQuery(
        'UPDATE key_model_usage SET daily_count = $1 WHERE api_key = $2 AND model = $3',
        [Math.max(0, used), key, m]
      );
      return { limit, remaining, used };
    }
  } catch {}
  return null;
}

export { getDefaultModel };
