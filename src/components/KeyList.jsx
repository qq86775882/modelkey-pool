import { api } from '../lib/api.js';

function progressClass(used, limit) {
  const pct = used / limit;
  if (pct >= 1) return 'danger';
  if (pct >= 0.8) return 'warn';
  return 'safe';
}

export default function KeyList({ keys, dailyLimit, onRefresh, onEdit, toast }) {
  async function handleDelete(key) {
    if (!confirm('确定要删除这把 Key 吗？')) return;
    try {
      await api.del(`/api/keys?key=${encodeURIComponent(key)}`);
      toast('Key 已删除');
      onRefresh();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  if (!keys || keys.length === 0) {
    return (
      <div className="empty">
        <div className="icon">📭</div>
        <p>还没有添加任何 Key，去「添加 Key」页面添加吧</p>
      </div>
    );
  }

  return (
    <div>
      <div className="section-head">
        <h3>所有 Key</h3>
        <button className="btn btn-outline btn-sm" onClick={onRefresh}>🔄 刷新</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>今日用量</th>
              <th>状态</th>
              <th>总请求</th>
              <th>429次数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {keys.map(k => {
              let tag;
              if (k.isExhausted) {
                tag = <span className="status-tag err">🚫 日配额用完</span>;
              } else if (k.isCooling) {
                tag = <span className="status-tag warn">⏳ 冷却 {Math.ceil(k.cooldownRemainingS)}s</span>;
              } else {
                tag = <span className="status-tag ok">✅ 正常</span>;
              }

              const cls = progressClass(k.dailyCount, dailyLimit);
              const width = Math.min(100, (k.dailyCount / dailyLimit) * 100);

              return (
                <tr key={k.key}>
                  <td className="key-mono">{k.masked}</td>
                  <td>
                    {k.dailyCount} / {dailyLimit}
                    <div className="progress-bar">
                      <div className={`progress-fill ${cls}`} style={{ width: `${width}%` }} />
                    </div>
                  </td>
                  <td>{tag}</td>
                  <td>{k.totalRequests.toLocaleString()}</td>
                  <td>{k.total429}</td>
                  <td className="btn-row">
                    <button className="btn btn-outline btn-xs" onClick={() => onEdit(k)}>✏️</button>
                    <button className="btn btn-danger btn-xs" onClick={() => handleDelete(k.key)}>🗑</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
