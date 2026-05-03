/**
 * Key Store — Neon PostgreSQL (Serverless SQL API)
 * v2: per-model 用量追踪 (Key × Model)
 */
const NEON_SQL = process.env.NEON_SQL_ENDPOINT || 'https://ep-young-sound-ahwn29w0.c-3.us-east-1.aws.neon.tech/sql';
const NEON_URL = process.env.NEON_DATABASE_URL || 'postgresql://neondb_owner:npg_0mdBGEUf2DcV@ep-young-sound-ahwn29w0.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require';

function today() { return new Date().toISOString().slice(0, 10); }
function mask(key) { return key.length > 10 ? key.slice(0, 6) + '***' + key.slice(-4) : '***'; }
function getDefaultModel() { return process.env.DEFAULT_MODEL || 'deepseek-ai/DeepSeek-V4-Pro'; }
function getDailyLimit() { return parseInt(process.env.DAILY_LIMIT || '500'); }
function getConfig() { return { dailyLimit: getDailyLimit(), defaultModel: getDefaultModel() }; }

const KNOWN_MODELS = ['deepseek-ai/DeepSeek-V4-Pro', 'ZhipuAI/GLM-5'];

async function neonQuery(query, params = []) {
  const resp = await fetch(NEON_SQL, {
    method: 'POST',
    headers: { 'neon-connection-string': NEON_URL, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, params }),
  });
  if (!resp.ok) { const err = await resp.text(); throw new Error(`Neon ${resp.status}: ${err}`); }
  return resp.json();
}

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
  await ensureTables();
  const now = today();
  const r = await neonQuery("SELECT value FROM meta_state WHERE key = 'reset_date'");
  const stored = r.rows.length > 0 ? r.rows[0].value : null;
  if (stored !== now) {
    await neonQuery('UPDATE key_model_usage SET daily_count = 0');
    await neonQuery('UPDATE key_store SET cooldown_until = 0');
    await neonQuery("INSERT INTO meta_state (key, value) VALUES ('reset_date', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [now]);
  }
  // Seed keys
  const cnt = await neonQuery('SELECT COUNT(*) as n FROM key_store');
  if (parseInt(cnt.rows[0].n) === 0) {
    const envKeys = (process.env.MODELSCOPE_KEYS || '').split(',').map(k => k.trim()).filter(k => k.startsWith('ms-'));
    for (const k of envKeys) {
      await neonQuery('INSERT INTO key_store (api_key) VALUES ($1) ON CONFLICT DO NOTHING', [k]);
      for (const m of KNOWN_MODELS)
        await neonQuery('INSERT INTO key_model_usage (api_key, model, daily_count) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING', [k, m]);
    }
  }
}

// ========== Core ==========

async function getData(model) {
  await midnightReset();
  const keys = await neonQuery('SELECT * FROM key_store ORDER BY api_key');
  const usage = await neonQuery('SELECT * FROM key_model_usage WHERE model = $1', [model || getDefaultModel()]);
  const usageMap = {};
  for (const u of usage.rows) usageMap[u.api_key] = u.daily_count;
  return {
    model: model || getDefaultModel(),
    keys: keys.rows.map(r => ({
      key: r.api_key,
      dailyCount: usageMap[r.api_key] || 0,
      totalRequests: r.total_requests,
      total429: r.total_429,
      cooldownUntil: r.cooldown_until,
    })),
    ...getConfig(),
  };
}

function selectKey(data) {
  const now = Date.now();
  const available = data.keys.filter(k => k.dailyCount < data.dailyLimit && k.cooldownUntil <= now);
  if (available.length === 0) return null;
  return available.reduce((a, b) => (data.dailyLimit - a.dailyCount) > (data.dailyLimit - b.dailyCount) ? a : b);
}

// ========== Public API ==========

export async function listKeys(model) {
  await midnightReset();
  const m = model || getDefaultModel();
  const keys = await neonQuery('SELECT * FROM key_store ORDER BY api_key');
  const usage = await neonQuery('SELECT * FROM key_model_usage WHERE model = $1', [m]);
  const usageMap = {};
  for (const u of usage.rows) usageMap[u.api_key] = u.daily_count;
  const now = Date.now();
  const limit = getDailyLimit();

  const keyList = keys.rows.map(r => {
    const dc = usageMap[r.api_key] || 0;
    return {
      key: r.api_key, masked: mask(r.api_key),
      dailyCount: dc, dailyLimit: limit, remaining: limit - dc,
      isExhausted: dc >= limit, isCooling: r.cooldown_until > now,
      cooldownRemainingS: Math.max(0, Math.ceil((r.cooldown_until - now) / 1000)),
      totalRequests: r.total_requests, total429: r.total_429,
    };
  });

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
    return { ok: true, masked: mask(key) };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function removeKey(keyOrMasked) {
  const keys = await neonQuery('SELECT api_key FROM key_store');
  const entry = keys.rows.find(k => k.api_key === keyOrMasked || mask(k.api_key) === keyOrMasked);
  if (!entry) return { ok: false, error: '未找到 Key' };
  await neonQuery('DELETE FROM key_model_usage WHERE api_key = $1', [entry.api_key]);
  await neonQuery('DELETE FROM key_store WHERE api_key = $1', [entry.api_key]);
  return { ok: true };
}

export async function updateKey(oldKeyOrMasked, newKey) {
  if (!newKey.startsWith('ms-')) return { ok: false, error: '新 Key 必须以 ms- 开头' };
  const keys = await neonQuery('SELECT api_key FROM key_store');
  const entry = keys.rows.find(k => k.api_key === oldKeyOrMasked || mask(k.api_key) === oldKeyOrMasked);
  if (!entry) return { ok: false, error: '未找到原 Key' };
  try {
    await neonQuery('DELETE FROM key_model_usage WHERE api_key = $1', [entry.api_key]);
    await neonQuery('UPDATE key_store SET api_key = $1, cooldown_until = 0 WHERE api_key = $2', [newKey, entry.api_key]);
    for (const m of KNOWN_MODELS)
      await neonQuery('INSERT INTO key_model_usage (api_key, model, daily_count) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING', [newKey, m]);
    return { ok: true, masked: mask(newKey) };
  } catch (e) {
    if (e.message.includes('duplicate key')) return { ok: false, error: '新 Key 已存在' };
    return { ok: false, error: e.message };
  }
}

export async function mark429(key, cooldownMs = 300000) {
  const until = Date.now() + cooldownMs;
  await neonQuery('UPDATE key_store SET cooldown_until = $1, total_429 = total_429 + 1 WHERE api_key = $2', [until, key]);
}

export async function pickAndUse(model) {
  const m = model || getDefaultModel();
  const data = await getData(m);
  const selected = selectKey(data);
  if (!selected) return null;
  await neonQuery(
    'UPDATE key_model_usage SET daily_count = daily_count + 1 WHERE api_key = $1 AND model = $2',
    [selected.key, m]
  );
  await neonQuery('UPDATE key_store SET total_requests = total_requests + 1 WHERE api_key = $1', [selected.key]);
  return selected.key;
}

export async function getKeyStats(key, model) {
  const m = model || getDefaultModel();
  const r = await neonQuery('SELECT * FROM key_model_usage WHERE api_key = $1 AND model = $2', [key, m]);
  const ks = await neonQuery('SELECT cooldown_until FROM key_store WHERE api_key = $1', [key]);
  if (r.rows.length === 0) return null;
  const u = r.rows[0];
  const limit = getDailyLimit();
  return {
    key, masked: mask(key),
    dailyCount: u.daily_count, dailyLimit: limit,
    remaining: limit - u.daily_count,
    cooldownUntil: ks.rows[0]?.cooldown_until || 0,
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
  } catch {} // 静默
  return null;
}

export { getDefaultModel };
