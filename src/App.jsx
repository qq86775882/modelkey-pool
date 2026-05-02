import { useState, useEffect, useCallback } from 'react';
import KeyList from './components/KeyList.jsx';
import AddKey from './components/AddKey.jsx';
import TestKey from './components/TestKey.jsx';
import Toast from './components/Toast.jsx';
import EditModal from './components/EditModal.jsx';
import { api } from './lib/api.js';

const TABS = [
  { id: 'keys', label: '🔑 Key 列表' },
  { id: 'add',  label: '➕ 添加 Key' },
  { id: 'test', label: '🧪 测试 Key' },
];

export default function App() {
  const [tab, setTab] = useState('keys');
  const [data, setData] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [editTarget, setEditTarget] = useState(null);

  const toast = useCallback((msg, type = 'success') => {
    const id = Date.now();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const d = await api.get('/api/keys');
      setData(d);
    } catch (e) {
      console.error('刷新失败:', e);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const available = data?.availableKeys ?? 0;
  const total = data?.totalKeys ?? 0;

  return (
    <div className="container">
      {/* Header */}
      <div className="header">
        <div>
          <h1>🔑 ModelKey Pool</h1>
          <span className="subtitle">ModelScope DeepSeek-V4-Pro 多 Key 轮换代理</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '.75rem', color: 'var(--muted)' }}>🔄 自动刷新</span>
          <span className="badge">
            <span className={`dot ${total === 0 ? 'orange' : available > 0 ? 'green' : 'red'}`} />
            {total === 0 ? '无 Key' : available > 0 ? '运行中' : '全部耗尽'}
          </span>
        </div>
      </div>

      {/* Stats */}
      <div className="stats">
        <div className="stat-card">
          <div className="label">Key 总数</div>
          <div className="value blue">{total}</div>
        </div>
        <div className="stat-card">
          <div className="label">可用 Key</div>
          <div className="value green">{available}</div>
        </div>
        <div className="stat-card">
          <div className="label">日限额 / 把</div>
          <div className="value">{data?.dailyLimit ?? '-'}</div>
        </div>
        <div className="stat-card">
          <div className="label">理论日总量</div>
          <div className="value orange">{(total * (data?.dailyLimit ?? 0)).toLocaleString()}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === 'keys' && (
        <KeyList
          keys={data?.keys ?? []}
          dailyLimit={data?.dailyLimit ?? 200}
          onRefresh={refresh}
          onEdit={setEditTarget}
          toast={toast}
        />
      )}
      {tab === 'add' && <AddKey toast={toast} onAdded={() => { refresh(); setTab('keys'); }} />}
      {tab === 'test' && <TestKey defaultModel={data?.defaultModel} toast={toast} />}

      {/* Toast */}
      <Toast toasts={toasts} />

      {/* Edit Modal */}
      {editTarget && (
        <EditModal
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => { setEditTarget(null); refresh(); }}
          toast={toast}
        />
      )}
    </div>
  );
}
