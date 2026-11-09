import type { DashboardFilters, Station } from '../api';
import SelectMenu from './SelectMenu';

interface Props {
  page: string;            // dashboard | stations | workbench | analysis | compare | ai-suggestions | improvements | change-password | admin-users
  lineId: string;
  station: Station | null;
  sameLineStations: Station[];
  onSwitchStation: (stationId: string) => void;
  /** L1 当前筛选（下钻路径：集团驾驶舱 › 华东 › 苏州精密） */
  dashFilters?: DashboardFilters;
  /** 点击面包屑区域 = 清除该筛选 */
  onDashFilter?: (patch: Partial<DashboardFilters>) => void;
  /** 首页落点（按权限：#/dashboard 或 #/stations） */
  homeHash: string;
  homeLabel: string;
}

const PAGE_LABEL: Record<string, string> = {
  dashboard: '综合看板',
  stations: '产线总览',
  workbench: '分解工作台',
  analysis: '分析结果',
  compare: '改善对比',
  diff: '版本 Diff',
  improvements: '改善任务',
  videos: '视频库',
  settings: '设置中心',
  standard: '动作标准库',
  'change-password': '修改密码',
  'admin-users': '用户管理',
  'ai-config': 'AI 配置',
  'ai-usage': 'AI 用量统计',
  'ai-suggestions': 'AI 建议',
  'ai-segment': 'AI 自动分解',
  'ai-waste': '浪费识别',
};

/** 面包屑：全程可见可点回溯；L1 下钻即筛选（区域/公司级可点清除） */
export default function Breadcrumb({ page, lineId, station, sameLineStations, onSwitchStation, dashFilters, onDashFilter, homeHash, homeLabel }: Props) {
  const onStationPage = Boolean(station);
  /* 与产线相关的页面才串「产线驾驶舱 › 产线」层级（设置/任务/用户管理是全局页） */
  const lineLinked = page === 'stations' || page === 'workbench' || page === 'analysis' || page === 'compare' || page === 'diff' || page === 'ai-suggestions' || page === 'ai-segment' || page === 'ai-waste';

  if (page === 'dashboard') {
    return (
      <nav className="crumb no-print">
        <a href="#/dashboard">综合看板</a>
        {dashFilters?.region && (
          <>
            <span className="crumb-sep">›</span>
            <a href="#/dashboard" onClick={(e) => { e.preventDefault(); onDashFilter?.({ region: undefined }); }}>{dashFilters.region}</a>
          </>
        )}
        {dashFilters?.company && (
          <>
            <span className="crumb-sep">›</span>
            <span className="crumb-cur"><b>{dashFilters.company}</b></span>
          </>
        )}
      </nav>
    );
  }

  return (
    <nav className="crumb no-print">
      <a href={homeHash}>{homeLabel}</a>
      {lineLinked && (
        <>
          <span className="crumb-sep">›</span>
          <a href="#/stations">产线总览</a>
        </>
      )}
      {lineLinked && lineId && (
        <>
          <span className="crumb-sep">›</span>
          <span className="crumb-cur">{lineId}</span>
        </>
      )}
      {onStationPage && (
        <>
          <span className="crumb-sep">›</span>
          {sameLineStations.length > 1 ? (
            /* v3.59.1 SelectMenu 自绘，根治原生 popup 漂移飞走 */
            <SelectMenu ariaLabel="切换工位" triggerClassName="crumb-switch"
              value={station!.station_id}
              onChange={(v) => onSwitchStation(v)}
              options={sameLineStations.map((s) => ({ value: s.station_id, label: `${s.name}（${s.station_id}）` }))} />
          ) : (
            <span className="crumb-cur">{station!.name}</span>
          )}
          <span className="crumb-sep">›</span>
          <span className="crumb-cur"><b>{PAGE_LABEL[page] ?? page}</b></span>
        </>
      )}
      {!onStationPage && page !== 'stations' && (
        <>
          <span className="crumb-sep">›</span>
          <span className="crumb-cur"><b>{PAGE_LABEL[page] ?? page}</b></span>
        </>
      )}
    </nav>
  );
}
