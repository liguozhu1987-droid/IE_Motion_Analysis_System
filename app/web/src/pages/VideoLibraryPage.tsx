import { useEffect, useState } from 'react';
import { api, type VideoAssetView } from '../api';

const STATUS_TEXT: Record<string, string> = {
  auto: '自动清理',
  extended: '已延期',
  permanent: '永久保留',
};

function retentionText(row: VideoAssetView): string {
  if (row.retention_status === 'permanent') return '永久保留';
  if (row.days_left === null) return '—';
  if (row.days_left <= 0) return '已到期（下一轮扫描删除）';
  return `剩余 ${row.days_left} 天`;
}

function fmtDate(v: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 视频库（v3.57）：源视频保留期的「站内可见标记 + 操作入口」。
 * 数据契约 GET /api/videos/assets：默认只返回当前用户可见范围内的源视频，
 * can_manage 由后端判定（上传者本人或全权管理员），前端只做展示收口、不自行推断权限。
 */
export default function VideoLibraryPage() {
  const [rows, setRows] = useState<VideoAssetView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await api.videos.assets();
      setRows(data);
      setError(null);
    } catch (e: any) {
      setError(e?.detail ?? e?.message ?? '视频库加载失败');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const act = async (row: VideoAssetView, fn: () => Promise<unknown>, okText: string) => {
    setBusy(row.file_name);
    setMsg(null);
    setError(null);
    try {
      await fn();
      setMsg(okText);
      await load(true);
    } catch (e: any) {
      setError(e?.detail ?? e?.message ?? '操作失败');
    } finally {
      setBusy(null);
    }
  };

  const remove = (row: VideoAssetView) => {
    const ok = window.confirm(
      `确定立即永久删除《${row.file_name}》？\n源视频与派生文件（proxy/截图/索引）会一并清除，且不可恢复。`,
    );
    if (!ok) return;
    void act(row, () => api.videos.deleteAsset(row.file_name), '已删除（审计已记录）');
  };

  const sorted = [...rows].sort((a, b) => {
    if (a.retention_status === 'permanent' && b.retention_status !== 'permanent') return 1;
    if (b.retention_status === 'permanent' && a.retention_status !== 'permanent') return -1;
    return (a.days_left ?? Number.MAX_SAFE_INTEGER) - (b.days_left ?? Number.MAX_SAFE_INTEGER);
  });
  const active = rows.filter((r) => r.retention_status !== 'permanent').length;
  const permanent = rows.length - active;

  return (
    <div>
      <div className="page-head">
        <h1>视频库</h1>
        <span className="sub">
          共 {rows.length} 个源视频 · 自动清理 {active} · 永久保留 {permanent}
          {' · '}到期前 3 天邮件提醒，未选择继续保留则到期自动删除
        </span>
        <div className="spacer" />
        <button className="btn sm" onClick={() => void load()} disabled={loading}>刷新</button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}

      <div className="card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>源视频</th><th>上传人</th><th>上传时间</th>
                <th>保留策略</th><th>到期</th><th>提醒</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr><td colSpan={7} className="empty">加载中…</td></tr>
              )}
              {!loading && sorted.length === 0 && (
                <tr><td colSpan={7} className="empty">当前可见范围内没有源视频</td></tr>
              )}
              {sorted.map((row) => (
                <tr key={row.file_name}>
                  <td>
                    <span className="video-name mono">{row.file_name}</span>
                  </td>
                  <td>{row.owner_username ?? row.owner_user_id}</td>
                  <td className="mono">{fmtDate(row.created_at)}</td>
                  <td>
                    <span className={`tag video-status video-status-${row.retention_status}`}>
                      {STATUS_TEXT[row.retention_status] ?? row.retention_status}
                    </span>
                  </td>
                  <td>
                    {retentionText(row)}
                    {row.retention_status !== 'permanent' && row.retention_until && (
                      <div className="muted mono">{fmtDate(row.retention_until)}</div>
                    )}
                  </td>
                  <td className="muted">
                    {row.notify_attempts > 0 ? `已提醒 ${row.notify_attempts} 次` : '未提醒'}
                  </td>
                  <td>
                    <div className="video-actions">
                      <a className="btn sm" href={row.play_url} target="_blank" rel="noreferrer">播放</a>
                      {row.can_manage ? (
                        <>
                          {row.retention_status !== 'permanent' && (
                            <button className="btn sm" disabled={busy === row.file_name}
                              onClick={() => void act(row, () => api.videos.setRetention(row.file_name, 'extend'),
                                '已延期 10 天')}>再保留 10 天</button>
                          )}
                          {row.retention_status !== 'permanent' && (
                            <button className="btn sm" disabled={busy === row.file_name}
                              onClick={() => void act(row, () => api.videos.setRetention(row.file_name, 'permanent'),
                                '已设为永久保留')}>永久保留</button>
                          )}
                          <button className="btn sm danger" disabled={busy === row.file_name}
                            onClick={() => remove(row)}>立即删除</button>
                        </>
                      ) : (
                        <span className="muted">仅上传者或管理员可操作</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="muted video-footnote">
        删除为硬删：源文件与 proxy/截图/索引一并清除，不做回收站；每次删除都会写审计（触发人、视频、来源）。
        SMTP 未配置时提醒仅落站内状态并记日志与失败计数，不阻断到期删除。
      </div>
    </div>
  );
}
