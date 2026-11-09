import { useCallback, useEffect, useState } from 'react';
import { api, RBAC_ACTION_LABEL, type RbacAuditVo } from '../api';
import SelectMenu from '../components/SelectMenu';

/**
 * 权限变更审计（v3.50 页签三，v3.58 增强）：
 * 谁在什么时候改了哪个角色/用户的权限，改前改后一目了然。
 * 对应行业软件「治理与合规柱」的审计日志要求——可追溯性是底线。
 *
 * v3.58：① 一次取全（后端已支持不带 entity 返回全部 RBAC 动作，无需前端两次查询合并）
 *       ② 支持按动作 / 操作人 / 对象精确追溯 ③ 导出 CSV 供体系审核与留档。
 */
export default function RbacAuditPanel() {
  const [logs, setLogs] = useState<RbacAuditVo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const [operator, setOperator] = useState('');
  const [entityId, setEntityId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await api.adminAudit({
        action: action || undefined,
        operator: operator.trim() || undefined,
        entityId: entityId.trim() || undefined,
        limit: 200,
      });
      setLogs(r.logs ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [action, operator, entityId]);

  useEffect(() => { void load(); }, [load]);

  const brief = (v: any): string => {
    if (v === null || v === undefined) return '-';
    try {
      const o = typeof v === 'string' ? JSON.parse(v) : v;
      if (Array.isArray(o)) return o.join('、');
      return Object.entries(o).map(([k, val]) => `${k}=${Array.isArray(val) ? val.join('/') : String(val)}`).join('，');
    } catch {
      return String(v);
    }
  };

  /** 导出 CSV（带 BOM，Excel 直接打开不乱码） */
  const exportCsv = () => {
    const head = ['时间', '操作人', '动作', '对象', '变更前', '变更后', '来源 IP'];
    const rows = logs.map((l) => [
      new Date(l.at).toLocaleString('zh-CN', { hour12: false }),
      l.operator, RBAC_ACTION_LABEL[l.action] ?? l.action, l.entityId ?? '',
      brief(l.before), brief(l.after), l.ip || '',
    ]);
    const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `权限变更审计_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="page-head">
        <h1 style={{ fontSize: 18 }}>权限变更审计</h1>
        <span className="sub">建号 / 改角色 / 改权限 / 审批 / 口令处置，全部留痕</span>
        <div className="spacer" />
        <button className="btn sm" onClick={() => void load()} disabled={busy}>刷新</button>
        <button className="btn sm" onClick={exportCsv} disabled={logs.length === 0}>导出 CSV</button>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {/* v3.59 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
          <SelectMenu ariaLabel="按动作筛选" value={action} triggerStyle={{ width: 180 }}
            onChange={(v) => setAction(v)}
            options={[
              { value: '', label: '全部动作' },
              ...Object.keys(RBAC_ACTION_LABEL).map((k) => ({ value: k, label: RBAC_ACTION_LABEL[k] })),
            ]} />
          <input
            placeholder="操作人（用户名模糊匹配）"
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
            style={{ width: 200 }}
          />
          <input
            placeholder="对象 ID（角色/用户 ID，精确）"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            style={{ width: 240 }}
          />
          {(action || operator || entityId) && (
            <button className="btn sm" onClick={() => { setAction(''); setOperator(''); setEntityId(''); }}>清除筛选</button>
          )}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          按「对象 ID」筛选可回答「谁改过这个角色/这个账号」；按「动作」筛选可回答「这段时间都改了些什么」。
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      <div className="card">
        {logs.length === 0 ? (
          <div className="empty">暂无权限变更记录</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>时间</th><th>操作人</th><th>动作</th><th>对象</th>
                <th>变更前</th><th>变更后</th><th>来源 IP</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.logId}>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(l.at).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>{l.operator}</td>
                  <td><span className="tag t-blue">{RBAC_ACTION_LABEL[l.action] ?? l.action}</span></td>
                  <td className="muted" style={{ fontSize: 12 }}>{l.entityId ?? '-'}</td>
                  <td className="muted" style={{ fontSize: 12, maxWidth: 260 }}>{brief(l.before)}</td>
                  <td style={{ fontSize: 12, maxWidth: 260 }}>{brief(l.after)}</td>
                  <td className="muted">{l.ip || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
