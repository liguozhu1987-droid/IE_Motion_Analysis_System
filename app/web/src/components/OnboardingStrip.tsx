import { useEffect, useState } from 'react';

interface Props {
  canWrite: boolean;
  canImport: boolean;
  hasStations: boolean;
  sampleStationId: string;
}

const KEY = 'ie_onboarding_dismissed';

/**
 * 三步上手引导条（驾驶舱顶部，可关闭，localStorage 记忆）。
 * 直击"用户进入后无从下手"：每步都是可点击动作而非文字说明。
 */
export default function OnboardingStrip({ canWrite, canImport, hasStations, sampleStationId }: Props) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(KEY, dismissed ? '1' : '0'); } catch { /* ignore */ }
  }, [dismissed]);

  if (dismissed) {
    return (
      <button className="onboarding-recall btn ghost sm no-print" onClick={() => setDismissed(false)}>
        💡 不知道从哪开始？查看三步上手引导
      </button>
    );
  }

  const step = (n: number, title: string, desc: string, action?: { label: string; href: string }) => (
    <div className="ob-step">
      <div className="ob-n">{n}</div>
      <div className="ob-body">
        <div className="ob-t">{title}</div>
        <div className="ob-d">{desc}</div>
        {action && <a className="btn sm primary" href={action.href}>{action.label}</a>}
      </div>
    </div>
  );

  const stationHref = sampleStationId ? `#/workbench/${sampleStationId}` : '#/stations';
  const analysisHref = sampleStationId ? `#/analysis/${sampleStationId}` : '#/stations';

  return (
    <div className="onboarding no-print">
      <div className="ob-head">
        <b>👋 三步上手</b>
        <span className="muted">IE 改善闭环：定对象 → 测现状 → 出方案</span>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={() => setDismissed(true)}>知道了，不再显示</button>
      </div>
      <div className="ob-steps">
        {step(1, '定对象',
          hasStations ? '在左侧对象树选择产线与工位' : '先建一个工位，或导入既有分解 CSV',
          { label: hasStations ? '去产线总览看看' : (canWrite ? '新建第一个工位' : '查看现有产线'), href: '#/stations' })}
        {step(2, '测现状', '进入分解工作台，视频打点分解作业要素并提交',
          { label: '进分解工作台', href: stationHref })}
        {step(3, '出方案', '在分析结果页一键生成改善建议，采纳后跟踪验证',
          { label: '看分析结果', href: analysisHref })}
      </div>
      {!hasStations && (
        <div className="ob-empty">
          当前还没有任何工位。{canWrite ? '点右上角“+ 新建工位”创建第一个工位；' : ''}
          {canImport ? '或在工位卡片上“导入 CSV”批量载入既有分解数据。' : ''}
        </div>
      )}
    </div>
  );
}
