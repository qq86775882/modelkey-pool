import { useState } from 'react';
import { api } from '../lib/api.js';

export default function AddKey({ toast, onAdded }) {
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    const val = key.trim();
    if (!val) { toast('请输入 Key', 'error'); return; }
    setLoading(true);
    try {
      await api.post('/api/keys', { key: val });
      toast('Key 添加成功！');
      setKey('');
      onAdded();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h3 style={{ fontWeight: 600, marginBottom: 16 }}>添加新 Key</h3>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>API Key（以 ms- 开头）</label>
          <input
            type="text"
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder="ms-xxxxxxxxxxxxxxxx"
            autoFocus
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? <><span className="spinner" /> 添加中...</> : '➕ 添加'}
        </button>
      </form>
      <p style={{ color: 'var(--muted)', fontSize: '.8rem', marginTop: 12 }}>
        添加后自动保存到 Netlify Blobs，重启不丢失。午夜自动重置用量。
      </p>
    </div>
  );
}
