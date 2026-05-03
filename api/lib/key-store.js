/**
 * Key Store — Neon PostgreSQL (Serverless SQL API)
 */
const NEON_SQL = process.env.NEON_SQL_ENDPOINT || 'https://ep-young-sound-ahwn29w0.c-3.us-east-1.aws.neon.tech/sql';
const NEON_URL = process.env.NEON_DATABASE_URL || 'postgresql://neondb_owner:npg_0mdBGEUf2DcV@ep-young-sound-ahwn29w0.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require';

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
  return parseInt(process.env.DAILY_LIMIT || '500');
}

function getConfig() {
  return { dailyLimit: getDailyLimit(), defaultModel: getDefaultModel() };
}

async function neonQuery(query, params = []) {
  const resp = await fetch(NEON_SQL, {
    method: 'POST',
    headers: {
      'neon-connection-string': NEON_URL,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, params }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Neon error ${resp.status}: ${err}`);
  }
  return resp.json();
}

// 建表
async function ensureTables() {
  await neonQuery(`
    CREATE TABLE IF NOT EXISTS key_store (
      api_key TEXT PRIMARY KEY,
      daily_count INT DEFAULT 0,
      total_requests INT DEFAULT 0,
      total_429 INT DEFAULT 0,
      cooldown_until BIGINT DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await neonQuery(`
    CREATE TABLE IF NOT EXISTS meta_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

// 午夜重置 — 仅在日期真正跨天时执行
async function midnightReset() {
  await ensureTables();
  const now = today();
  const r = await neonQuery("SELECT value FROM meta_state WHERE key = 'reset_date'");
  const stored = r.rows.length > 0 ? r.rows[0].value : null;
  if (stored !== now) {
    await neonQuery('UPDATE key_store SET daily_count = 0, cooldown_until = 0');
    await neonQuery(
      "INSERT INTO meta_state (key, value) VALUES ('reset_date', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [now]
    );
  }
  // Seed if empty
  const count = await neonQuery('SELECT COUNT(*) as n FROM key_store');
  if (parseInt(count.rows[0].n) === 0) {
    const envKeys = (process.env.MODELSCOPE_KEYS || '').split(',').map(k => k.trim()).filter(k => k.startsWith('ms-'));
    for (const k of envKeys) {
      await neonQuery('INSERT INTO key_store (api_key) VALUES ($1) ON CONFLICT DO NOTHING', [k]);
    }
  }
}

async function getData() {
  await midnightReset();
  const result = await neonQuery('SELECT * FROM key_store ORDER BY api_key');
  return {
    keys: result.rows.map(r => ({
      key: r.api_key,
      dailyCount: r.daily_count,
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
  return available.reduce((a, b) =>
    (data.dailyLimit - a.dailyCount) > (data.dailyLimit - b.dailyCount) ? a : b
  );
}

// ========== Public API ==========

export async function listKeys() {
  const data = await getData();
  const now = Date.now();
  return {
    ...getConfig(),
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
  if (!key || !key.startsWith('ms-')) return { ok: false, error: 'Key 必须以 ms- 开头' };
  try {
    await neonQuery(
      "INSERT INTO key_store (api_key) VALUES ($1) ON CONFLICT (api_key) DO NOTHING",
      [key]
    );
    return { ok: true, masked: mask(key) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function removeKey(keyOrMasked) {
  // Try exact match first, then masked match
  const data = await getData();
  const entry = data.keys.find(k => k.key === keyOrMasked || mask(k.key) === keyOrMasked);
  if (!entry) return { ok: false, error: '未找到 Key' };
  await neonQuery('DELETE FROM key_store WHERE api_key = $1', [entry.key]);
  return { ok: true };
}

export async function updateKey(oldKeyOrMasked, newKey) {
  if (!newKey.startsWith('ms-')) return { ok: false, error: '新 Key 必须以 ms- 开头' };
  const data = await getData();
  const entry = data.keys.find(k => k.key === oldKeyOrMasked || mask(k.key) === oldKeyOrMasked);
  if (!entry) return { ok: false, error: '未找到原 Key' };
  try {
    await neonQuery(
      'UPDATE key_store SET api_key = $1, daily_count = 0, cooldown_until = 0 WHERE api_key = $2',
      [newKey, entry.key]
    );
    return { ok: true, masked: mask(newKey) };
  } catch (e) {
    if (e.message.includes('duplicate key')) return { ok: false, error: '新 Key 已存在' };
    return { ok: false, error: e.message };
  }
}

export async function markUsed(key) {
  await neonQuery(
    'UPDATE key_store SET daily_count = daily_count + 1, total_requests = total_requests + 1 WHERE api_key = $1',
    [key]
  );
}

export async function mark429(key, cooldownMs = 300000) {
  const until = Date.now() + cooldownMs;
  await neonQuery(
    'UPDATE key_store SET cooldown_until = $1, total_429 = total_429 + 1 WHERE api_key = $2',
    [until, key]
  );
}

export async function pickAndUse() {
  const data = await getData();
  const selected = selectKey(data);
  if (!selected) return null;
  await neonQuery(
    'UPDATE key_store SET daily_count = daily_count + 1, total_requests = total_requests + 1 WHERE api_key = $1',
    [selected.key]
  );
  return selected.key;
}

export async function getKeyStats(key) {
  const r = await neonQuery('SELECT * FROM key_store WHERE api_key = $1', [key]);
  if (r.rows.length === 0) return null;
  const k = r.rows[0];
  const limit = getDailyLimit();
  return {
    key: k.api_key,
    masked: mask(k.api_key),
    dailyCount: k.daily_count,
    dailyLimit: limit,
    remaining: limit - k.daily_count,
    cooldownUntil: k.cooldown_until,
  };
}

export async function getPoolStats() {
  const data = await getData();
  const now = Date.now();
  return {
    totalKeys: data.keys.length,
    availableKeys: data.keys.filter(k => k.dailyCount < data.dailyLimit && k.cooldownUntil <= now).length,
    dailyLimit: data.dailyLimit,
  };
}

export { getData, getDefaultModel };
