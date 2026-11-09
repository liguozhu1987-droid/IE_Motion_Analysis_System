interface Props {
  stationId: string;
  active: 'workbench' | 'analysis' | 'compare' | 'ai-suggestions' | 'ai-segment' | 'ai-waste';
}

/** 工位工作区页签：分解 / AI分解 / 分析 / 对比 / AI建议 / 浪费识别（替代顶栏跳转，保持上下文） */
export default function StationTabs({ stationId, active }: Props) {
  const tabs: { key: Props['active']; label: string; perm: string }[] = [
    { key: 'workbench', label: '分解工作台', perm: 'element:read' },
    { key: 'ai-segment', label: 'AI 自动分解', perm: 'element:write' },
    { key: 'analysis', label: '分析结果', perm: 'analysis:read' },
    { key: 'compare', label: '改善对比', perm: 'compare:read' },
    { key: 'ai-suggestions', label: 'AI 建议', perm: 'suggestion:generate' },
    { key: 'ai-waste', label: '浪费识别', perm: 'suggestion:generate' },
  ];
  return (
    <div className="station-tabs no-print">
      {tabs.map((t) => (
        <a key={t.key} href={`#/${t.key}/${stationId}`}
          className={active === t.key ? 'on' : ''}>
          {t.label}
        </a>
      ))}
    </div>
  );
}
