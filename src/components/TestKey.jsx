import { useState } from 'react';
import { api } from '../lib/api.js';

export default function TestKey({ defaultModel, toast }) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState(defaultModel || 'deepseek-ai/DeepSeek-V4-Pro');
  const [message, setMessage] = useState('Hello, reply with just OK.');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    const val = key.trim();
    if (!val) { toast('请输入 Key', 'error'); return; }
    setLoading(true);
    setResult(null);
    try {
      const data = await api.post('/api/keys-test', {
        key: val,
        model: model.trim(),
        message: message.trim(),
      });
      setResult(data);
    } catch (e) {
      setResult({ ok: false, error: e.message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h3 style={{ fontWeight: 600, marginBottom: 16 }}>测试 Key 可用性</h3>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>API Key</label>
          <input
            type="text"
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder="ms-xxxxxxxxxxxxxxxx"
          />
        </div>
        <div className="form-group">
          <label>模型</label>
          <input
            type="text"
            value={model}
            onChange={e => setModel(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>测试消息</label>
          <input
            type="text"
            value={message}
            onChange={e => setMessage(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? <><span className="spinner" /> 测试中...</> : '🧪 开始测试'}
        </button>
      </form>

      {result && (
        <div className={`test-result ${result.ok ? 'success' : 'fail'}`}>
          {result.ok ? (
            <>
              <strong>✅ 测试成功</strong>
              <p style={{ marginTop: 8, color: 'var(--muted)' }}>
                延迟: {result.latencyMs}ms | 模型: {result.model}
              </p>
              <p style={{ color: 'var(--muted)' }}>
                Tokens: prompt={result.usage?.prompt_tokens ?? '-'}
                completion={result.usage?.completion_tokens ?? '-'}
              </p>
              <div className="reply">{result.reply}</div>
            </>
          ) : (
            <>
              <strong>❌ 测试失败</strong>
              <p style={{ marginTop: 8, color: 'var(--muted)' }}>
                状态码: {result.status} | 延迟: {result.latencyMs}ms
              </p>
              <div className="reply">{result.error}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
