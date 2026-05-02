import { useState } from 'react';
import { api } from '../lib/api.js';

export default function EditModal({ target, onClose, onSaved, toast }) {
  const [newKey, setNewKey] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSave(e) {
    e.preventDefault();
    const val = newKey.trim();
    if (!val) { toast('请输入新 Key', 'error'); return; }
    setLoading(true);
    try {
      await api.put('/api/keys', {
        old_key: target.key,
        new_key: val,
      });
      toast('Key 更新成功');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h3>✏️ 编辑 Key</h3>
        <form onSubmit={handleSave}>
          <div className="form-group">
            <label>当前 Key</label>
            <input type="text" value={target.masked} readOnly style={{ opacity: .6 }} />
          </div>
          <div className="form-group">
            <label>新 Key</label>
            <input
              type="text"
              value={newKey}
              onChange={e => setNewKey(e.target.value)}
              placeholder="ms-xxxxxxxxxxxxxxxx"
              autoFocus
            />
          </div>
          <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" className="btn btn-outline" onClick={onClose}>取消</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? <><span className="spinner" /> 保存中...</> : '💾 保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
