import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AuthProvider, useAuth } from './auth';
import StationTree from './components/StationTree';
import GroupTree from './components/GroupTree';
import Breadcrumb from './components/Breadcrumb';
import StationTabs from './components/StationTabs';
import ContextPanel from './components/ContextPanel';
import OnboardingStrip from './components/OnboardingStrip';
import UserMenu from './components/UserMenu';
import { api, type AiSuggestElementSource, type AiWasteElementSource, type DashboardFilters, type DashboardSummary, type LinesSummary, type Station } from './api';

// 按路由拆包（报告 W3）：页面组件走 React.lazy 动态导入，避免单 chunk 过大拖累驾驶舱首屏 LCP。
// 常驻 shell 组件（树/面包屑/页签/上下文面板）保持静态导入，路由切换时才按需加载对应页面 chunk。
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const StationListPage = lazy(() => import('./pages/StationListPage'));
const ImprovementsPage = lazy(() => import('./pages/ImprovementsPage'));
const MasterDataPage = lazy(() => import('./pages/MasterDataPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const StandardConfigPage = lazy(() => import('./pages/StandardConfigPage'));
const WorkbenchPage = lazy(() => import('./pages/WorkbenchPage'));
const AnalysisPage = lazy(() => import('./pages/AnalysisPage'));
const ComparePage = lazy(() => import('./pages/ComparePage'));
const DiffPage = lazy(() => import('./pages/DiffPage'));
const UserManagementPage = lazy(() => import('./pages/UserManagementPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const OidcCallbackPage = lazy(() => import('./pages/OidcCallbackPage'));
const VideoLibraryPage = lazy(() => import('./pages/VideoLibraryPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const ChangePasswordPage = lazy(() => import('./pages/ChangePasswordPage'));
const AiConfigPage = lazy(() => import('./pages/AiConfigPage'));
const AiSuggestionsPage = lazy(() => import('./pages/AiSuggestionsPage'));
const AiSegmentPage = lazy(() => import('./pages/AiSegmentPage'));
const AiWastePage = lazy(() => import('./pages/AiWastePage'));
const AiUsagePage = lazy(() => import('./pages/AiUsagePage'));
const HelpPage = lazy(() => import('./pages/HelpPage'));

/** 路由 chunk 加载中的占位（替代整页白屏） */
function PageFallback() {
  return <div className="boot">加载中…</div>;
}

type Route =
  | { page: 'dashboard' | 'stations' | 'improvements' | 'settings' | 'standard' | 'master' | 'ai-config' | 'ai-usage' | 'videos' }
  | { page: 'workbench' | 'analysis' | 'compare' | 'ai-suggestions' | 'ai-segment'; id: string; source?: AiSuggestElementSource }
  | { page: 'ai-waste'; id: string; source?: AiWasteElementSource }
  | { page: 'diff'; id: string; vA: number; vB: number }
  | { page: 'change-password' | 'register' | 'forgot-password' | 'admin-users' | 'oidc-callback' }
  | { page: 'help' };

const ROUTE_PERMISSION: Record<Route['page'], string> = {
  dashboard: 'group:read',
  stations: 'station:read',
  master: 'station:read',
  improvements: 'suggestion:generate',
  settings: 'settings:benefit-read',
  standard: 'rule:read',
  workbench: 'element:read',
  'ai-segment': 'element:write',
  analysis: 'analysis:read',
  compare: 'compare:read',
  diff: 'element:read',
  'change-password': 'auth:self',
  'admin-users': 'user:read',
  'ai-config': 'user:read',
  'ai-usage': 'suggestion:generate',
  'ai-suggestions': 'suggestion:generate',
  'ai-waste': 'suggestion:generate',
  help: '',
  register: '',
  'forgot-password': '',
  /* 公开页：回调页在未登录时也要能渲染；登录成功后由 PUBLIC_PAGES 逻辑立刻分流 */
  'oidc-callback': '',
  videos: 'station:read',
};

/** 未登录即可访问的页面 */
const PUBLIC_PAGES: Route['page'][] = ['register', 'forgot-password', 'oidc-callback'];

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [page, id, p3, p4] = raw.split('/').filter(Boolean);
  if (page === 'change-password') return { page };
  /* v3.57 统一身份回调：#/oidc/callback?otk=... 或 ?error=...（query 由页面自行解析） */
  if (page === 'oidc' && id?.startsWith('callback')) return { page: 'oidc-callback' };
  if (page === 'videos') return { page: 'videos' };
  if (page === 'register') return { page };
  if (page === 'forgot-password') return { page };
  if (page === 'admin-users') return { page };
  if (page === 'help') return { page: 'help' };
  if (page === 'dashboard') return { page: 'dashboard' };
  if (page === 'improvements') return { page: 'improvements' };
  if (page === 'settings') return { page: 'settings' };
  if (page === 'standard') return { page: 'standard' };
  if (page === 'master') return { page: 'master' };
  if (page === 'ai-config') return { page: 'ai-config' };
  if (page === 'ai-usage') return { page: 'ai-usage' };
  if (page === 'diff' && id && p3 && p4) {
    const vA = Number(p3);
    const vB = Number(p4);
    if (Number.isFinite(vA) && Number.isFinite(vB) && vA !== vB) {
      return { page: 'diff', id: decodeURIComponent(id), vA, vB };
    }
  }
  if ((page === 'workbench' || page === 'analysis' || page === 'compare' || page === 'ai-suggestions' || page === 'ai-segment') && id) {
    /* v3.46：hash 不支持 query 的既定事实的修补——ai-suggestions 分支拆 ?source=
       （完全复用 ai-waste 拆分写法：先取 ? 前 sid，仅 manual/ai_assisted 才带 source；
       mixed/缺省不带——保证 legacy hash 解析结果逐字节不变） */
    if (page === 'ai-suggestions') {
      const [sid, query] = id.split('?');
      const src = new URLSearchParams(query ?? '').get('source');
      return {
        page: 'ai-suggestions', id: decodeURIComponent(sid),
        ...(src === 'manual' || src === 'ai_assisted' ? { source: src as AiSuggestElementSource } : {}),
      };
    }
    return { page, id: decodeURIComponent(id) };
  }
  /* v3.45：hash 不支持 query 的既定事实的修补——仅 ai-waste 分支拆 ?source=
     （工作台「前往浪费识别 →」链接带 source=manual 直达手工分解线页签）。
     source 缺省/非法值回落 'ai_assisted'；其余路由分支行为逐字节不变。 */
  if (page === 'ai-waste' && id) {
    const [sid, query] = id.split('?');
    const src = new URLSearchParams(query ?? '').get('source');
    const source: AiWasteElementSource = src === 'manual' ? 'manual' : 'ai_assisted';
    return { page: 'ai-waste', id: decodeURIComponent(sid), source };
  }
  return { page: 'stations' };
}

function Shell() {
  const { user, booting, can } = useAuth();
  const [route, setRoute] = useState<Route>(parseHash);
  const [stations, setStations] = useState<Station[]>([]);
  /** 产线概览（导航层：名称/平衡率/待办；随工位变化刷新） */
  const [linesSummary, setLinesSummary] = useState<LinesSummary | null>(null);
  /** 新建分析对象向导的打开信号（对象树/顶栏触发，递增即打开） */
  const [createSignal, setCreateSignal] = useState(0);
  const [selectedLine, setSelectedLine] = useState('');
  const [stationDetail, setStationDetail] = useState<Station | null>(null);
  const [treeCollapsed, setTreeCollapsed] = useState(() => {
    try { return localStorage.getItem('ie_tree_collapsed') === '1'; } catch { return false; }
  });

  /* 集团驾驶舱状态（v3.3）：筛选 + 聚合结果 + 无筛选维度字典；树/面包屑/关注面板共用 */
  const canGroup = can('group:read');
  const [dashFilters, setDashFilters] = useState<DashboardFilters>({});
  const [dashSummary, setDashSummary] = useState<DashboardSummary | null>(null);
  const [dashDim, setDashDim] = useState<DashboardSummary | null>(null);
  const [dashLoading, setDashLoading] = useState(false);
  const [dashDimVersion, setDashDimVersion] = useState(0);

  /* hash 路由 */
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  /* 登录落地页按权限分流：有 group:read → 集团驾驶舱；否则产线驾驶舱（仅无 hash 时设置） */
  useEffect(() => {
    if (booting || !user) return;
    if (!window.location.hash) {
      window.location.hash = canGroup ? '#/dashboard' : '#/stations';
    }
  }, [booting, user, canGroup]);

  /* 全量工位（对象树数据源）；工位增删/复测后由 'stations:changed' 事件触发刷新。
     依赖 user：登录前请求会 401（无 access token），登录成功后必须重新拉取，
     否则对象树会一直停留在空态。 */
  const reloadStations = useCallback(() => {
    api.stations().then(setStations).catch(() => setStations([]));
    api.linesSummary().then(setLinesSummary).catch(() => setLinesSummary(null));
  }, []);
  useEffect(() => {
    if (!user) { setStations([]); setLinesSummary(null); return; }
    reloadStations();
    const onChanged = () => { reloadStations(); setDashDimVersion((v) => v + 1); };
    window.addEventListener('stations:changed', onChanged);
    return () => window.removeEventListener('stations:changed', onChanged);
  }, [user, reloadStations]);

  /* 维度字典：无筛选全量一次（数据变更时重取） */
  useEffect(() => {
    if (!canGroup) return;
    let alive = true;
    api.dashboard.summary()
      .then((s) => { if (alive) setDashDim(s); })
      .catch(() => { if (alive) setDashDim(null); });
    return () => { alive = false; };
  }, [canGroup, dashDimVersion]);

  /* 当前筛选聚合（L1 页面与关注面板数据源） */
  useEffect(() => {
    if (!canGroup) return;
    let alive = true;
    setDashLoading(true);
    api.dashboard.summary(dashFilters)
      .then((s) => { if (alive) setDashSummary(s); })
      .catch(() => { if (alive) setDashSummary(null); })
      .finally(() => { if (alive) setDashLoading(false); });
    return () => { alive = false; };
  }, [canGroup, dashFilters]);

  const patchDashFilters = useCallback((patch: Partial<DashboardFilters>) => {
    setDashFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  /* 默认选中第一条产线 */
  useEffect(() => {
    if (!selectedLine && stations.length > 0) {
      setSelectedLine([...new Set(stations.map((s) => s.line_id))].sort()[0]);
    }
  }, [stations, selectedLine]);

  /* 当前工位详情（面包屑/摘要面板/页签共用）
   * v3.55：服务端按可见范围收口后，普通用户直接输入他人工位 URL 会拿到 403。
   * 此处给出明确提示（而不是静默置空 → 页面空白无解释），并把左侧树选中项拉回自己的范围。 */
  const routeStationId = 'id' in route ? route.id : '';
  const [deniedStation, setDeniedStation] = useState<string | null>(null);
  useEffect(() => {
    if (!routeStationId) { setStationDetail(null); setDeniedStation(null); return; }
    let alive = true;
    api.station(routeStationId)
      .then((s) => { if (alive) { setStationDetail(s); setDeniedStation(null); setSelectedLine(s.line_id); } })
      .catch((e: unknown) => {
        if (!alive) return;
        setStationDetail(null);
        const status = (e as { status?: number })?.status;
        if (status === 403) setDeniedStation(routeStationId);
        else setDeniedStation(null);
      });
    return () => { alive = false; };
  }, [routeStationId]);

  const toggleCollapse = () => {
    setTreeCollapsed((v) => {
      try { localStorage.setItem('ie_tree_collapsed', v ? '0' : '1'); } catch { /* ignore */ }
      return !v;
    });
  };

  /* 进入产线驾驶舱（L2）：集团树/产线汇总表/关注面板共用。
     注意：必须声明在下方条件 return 之前——React 钩子调用顺序不能随登录态变化，
     否则从登录页进入主界面时会报 "Rendered more hooks than during the previous render"。 */
  const openLine = useCallback((lineId: string) => {
    setSelectedLine(lineId);
    if (parseHash().page !== 'stations') window.location.hash = '#/stations';
  }, []);

  /* v3.24 顶栏「系统管理」下拉：设置/用户/改密归口（行业惯例：配置类低频项收进一处）。
     钩子必须在条件 return 之前（坑㉑：登录后白屏教训） */
  const [sysOpen, setSysOpen] = useState(false);
  const sysRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sysOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (sysRef.current && !sysRef.current.contains(e.target as Node)) setSysOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSysOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [sysOpen]);
  const canSettings = can('settings:benefit-read') || can('rule:read');
  const canUsers = can('user:read');

  if (booting) return <div className="boot">正在恢复会话…</div>;
  if (!user) {
    if (route.page === 'oidc-callback') return <Suspense fallback={<PageFallback />}><OidcCallbackPage /></Suspense>;
    if (route.page === 'register') return <Suspense fallback={<PageFallback />}><RegisterPage /></Suspense>;
    if (route.page === 'forgot-password') return <Suspense fallback={<PageFallback />}><ForgotPasswordPage /></Suspense>;
    return <Suspense fallback={<PageFallback />}><LoginPage /></Suspense>;
  }
  if (user.mustChangePwd) return <Suspense fallback={<PageFallback />}><ChangePasswordPage forced /></Suspense>;
  if (PUBLIC_PAGES.includes(route.page)) {
    window.location.hash = canGroup ? '#/dashboard' : '#/stations';
    return null;
  }

  const denied = route.page === 'help'
    ? false
    : route.page === 'settings'
      ? !can('settings:benefit-read') && !can('rule:read')
      : !can(ROUTE_PERMISSION[route.page]);
  const onStationRoute = route.page === 'workbench' || route.page === 'analysis' || route.page === 'compare' || route.page === 'diff' || route.page === 'ai-suggestions' || route.page === 'ai-segment' || route.page === 'ai-waste';
  const lineForPanel = stationDetail?.line_id ?? selectedLine;
  const sameLineStations = stations.filter((s) => s.line_id === lineForPanel);
  const sampleStationId = sameLineStations[0]?.station_id ?? '';
  const homeHash = canGroup ? '#/dashboard' : '#/stations';
  const homeLabel = canGroup ? '综合看板' : '产线总览';
  const sysActive = route.page === 'settings' || route.page === 'admin-users' || route.page === 'change-password' || route.page === 'ai-config' || route.page === 'ai-usage';

  const switchStation = (id: string) => {
    const keep = onStationRoute ? route.page : 'workbench';
    window.location.hash = `#/${keep}/${id}`;
  };

  const requestCreate = () => {
    if (route.page !== 'stations') window.location.hash = '#/stations';
    setCreateSignal((v) => v + 1);
  };

  return (
    <div className="app">
      <header className="topbar no-print">
        <div className="brand">
          <span className="brand-mark" aria-hidden>IE</span>
          IE改善效率平台
        </div>
        {/* v3.24 顶栏信息架构重整（对照 IE 工时软件行业惯例）：
            业务区（看板/产线/改善）｜ 配置区（主数据/标准）｜ 系统区（下拉归口）——
            三区分隔线替代 7 项平铺，低频配置收进「系统管理」下拉 */}
        <nav className="nav">
          {/* v3.42 决策 #1：综合看板全角色可见（原「集团看板」改名） */}
          {canGroup && (
            <a className={route.page === 'dashboard' ? 'active' : ''} href="#/dashboard">综合看板</a>
          )}
          <a className={route.page === 'stations' || onStationRoute ? 'active' : ''} href="#/stations">产线总览</a>
          {can('suggestion:generate') && (
            <a className={route.page === 'improvements' ? 'active' : ''} href="#/improvements">改善任务</a>
          )}
          {can('station:read') && (
            <a className={route.page === 'videos' ? 'active' : ''} href="#/videos">视频库</a>
          )}
          <span className="nav-sep" aria-hidden />
          {can('station:read') && (
            <a className={route.page === 'master' ? 'active' : ''} href="#/master">主数据</a>
          )}
          {can('rule:read') && (
            <a className={route.page === 'standard' ? 'active' : ''} href="#/standard">动作标准库</a>
          )}
          <span className="nav-sep" aria-hidden />
          <div className={`nav-drop${sysOpen ? ' open' : ''}`} ref={sysRef}>
            <button type="button" className={`nav-drop-btn${sysActive ? ' active' : ''}`}
              onClick={() => setSysOpen((v) => !v)} aria-haspopup="menu" aria-expanded={sysOpen}>
              系统管理<span className="nav-caret" aria-hidden>▾</span>
            </button>
            {sysOpen && (
              <div className="nav-drop-menu" role="menu">
                {canSettings && (
                  <a role="menuitem" href="#/settings" className={route.page === 'settings' ? 'active' : ''}
                    onClick={() => setSysOpen(false)}>设置中心<small>收益参数 · 规则库</small></a>
                )}
                {canUsers && (
                  <a role="menuitem" href="#/admin-users" className={route.page === 'admin-users' ? 'active' : ''}
                    onClick={() => setSysOpen(false)}>用户管理<small>账号与角色</small></a>
                )}
                {/* AI 配置：ai:governance 治理权限可见（配额 + 自定义类型）；AI 服务状态区对 user:read 开放 */}
                {can('user:read') && (
                  <a role="menuitem" href="#/ai-config" className={route.page === 'ai-config' ? 'active' : ''}
                    onClick={() => setSysOpen(false)}>AI 配置<small>服务状态 · 配额 · 自定义类型</small></a>
                )}
                {can('suggestion:generate') && (
                  <a role="menuitem" href="#/ai-usage" className={route.page === 'ai-usage' ? 'active' : ''}
                    onClick={() => setSysOpen(false)}>AI 用量统计<small>Token 消耗 · 调用明细</small></a>
                )}
                <a role="menuitem" href="#/change-password" className={route.page === 'change-password' ? 'active' : ''}
                  onClick={() => setSysOpen(false)}>修改密码</a>
              </div>
            )            }
          </div>
          <a className={route.page === 'help' ? 'active' : ''} href="#/help">帮助</a>
        </nav>
        {/* v3.56 用户区下沉为组件：头像 + 角色 + 行级可见范围 + 权限清单浮层 */}
        <UserMenu />
      </header>

      <div className="shell">
        {route.page === 'dashboard' ? (
          <GroupTree
            dim={dashDim}
            filters={dashFilters}
            collapsed={treeCollapsed}
            onToggleCollapse={toggleCollapse}
            onFilter={patchDashFilters}
            onOpenLine={openLine}
          />
        ) : route.page === 'help' ? null : (
          <StationTree
            stations={stations}
            lines={linesSummary?.lines ?? []}
            company={linesSummary?.company ?? ''}
            region={linesSummary?.region ?? null}
            selectedLine={selectedLine}
            currentStationId={routeStationId}
            collapsed={treeCollapsed}
            onToggleCollapse={toggleCollapse}
            onSelectLine={(l) => { setSelectedLine(l); if (route.page !== 'stations') window.location.hash = '#/stations'; }}
            onOpenStation={(id) => { window.location.hash = `#/workbench/${id}`; }}
            canWrite={can('station:write')}
            onCreateStation={requestCreate}
          />
        )}

        <div className={`shell-main${route.page === 'workbench' ? ' wb-route' : ''}`}>
          {onStationRoute ? (
            /* 工位路由：面包屑与工位页签合并为一行（旧两行 84px → 一行 ≈36px），
               竖向空间全部让给工作台作业区 */
            <div className="station-head no-print">
              <Breadcrumb
                page={route.page}
                lineId={lineForPanel}
                station={onStationRoute ? stationDetail : null}
                sameLineStations={sameLineStations}
                onSwitchStation={switchStation}
                homeHash={homeHash}
                homeLabel={homeLabel}
              />
              <StationTabs stationId={routeStationId} active={route.page === 'diff' ? 'workbench' : route.page} />
            </div>
          ) : route.page === 'help' ? null : (
            <Breadcrumb
              page={route.page}
              lineId={lineForPanel}
              station={onStationRoute ? stationDetail : null}
              sameLineStations={sameLineStations}
              onSwitchStation={switchStation}
              dashFilters={route.page === 'dashboard' ? dashFilters : undefined}
              onDashFilter={patchDashFilters}
              homeHash={homeHash}
              homeLabel={homeLabel}
            />
          )}
          {route.page === 'stations' && can('element:write') && (
            <div className="container" style={{ paddingBottom: 0 }}>
              <OnboardingStrip
                canWrite={can('station:write')}
                canImport={can('element:write')}
                hasStations={stations.length > 0}
                sampleStationId={sampleStationId}
              />
            </div>
          )}
          {/* 工作台是"作业面"：突破全局 1560 版宽，独占视口宽度（视频与检查器都更宽） */}
          <main className={`container${route.page === 'workbench' ? ' container-wide' : ''}`}>
            {(route.page === 'dashboard' || route.page === 'stations') && !denied && (
              <div className="help-banner no-print">
                <p>📖 首次使用或想了解各模块操作？打开《系统使用帮助》，含核心概念、功能指引与常见问题。</p>
                <a className="btn sm primary" href="#/help">打开帮助中心</a>
              </div>
            )}
            <Suspense fallback={<PageFallback />}>
            {denied ? (
              <div className="deny-card">
                <div className="eyebrow">Access Denied · 403</div>
                <h3>当前角色无权访问该页面</h3>
                <p>
                  本页面需要权限 <span className="deny-code">{ROUTE_PERMISSION[route.page] || '—'}</span>
                  ，你的账号未获得该权限。权限由所属角色决定，请联系管理员调整授权后再访问。
                </p>
                <div className="deny-actions">
                  <a className="btn sm primary" href={homeHash}>返回{homeLabel}</a>
                  <a className="btn sm" href="#/help">查看帮助中心</a>
                </div>
              </div>
            ) : deniedStation ? (
              /* v3.55：工位级可见范围收口——他人工位统一给明确解释，
                 并给出回到自己范围的出口（左侧树 / 工位清单）。 */
              <div className="deny-card">
                <div className="eyebrow">Out Of Scope · 403</div>
                <h3>工位 <span className="mono">{deniedStation}</span> 不在你的可见范围内</h3>
                <p>
                  按行级授权规则，你只能查看<b>自己建立的</b>、<b>被共享给你的</b>，以及<b>你负责产线上</b>的工位分析结果。
                  如需访问该工位，请联系工位拥有人或管理员为你添加共享授权。
                </p>
                <div className="deny-actions">
                  <a className="btn sm primary" href="#/stations">回到工位清单</a>
                </div>
              </div>
            ) : route.page === 'dashboard' ? (
              <DashboardPage
                filters={dashFilters}
                summary={dashSummary}
                dim={dashDim}
                loading={dashLoading}
                onChange={patchDashFilters}
                onReset={() => setDashFilters({})}
                onOpenLine={openLine}
              />
            ) : route.page === 'stations' ? (
              <StationListPage
                stations={stations}
                lineId={selectedLine}
                onLineChange={setSelectedLine}
                createSignal={createSignal}
                company={linesSummary?.company ?? ''}
                region={linesSummary?.region ?? null}
              />
            ) : route.page === 'improvements' ? (
              <ImprovementsPage />
            ) : route.page === 'videos' ? (
              <VideoLibraryPage />
            ) : route.page === 'master' ? (
              <MasterDataPage />
            ) : route.page === 'settings' ? (
              <SettingsPage />
            ) : route.page === 'standard' ? (
              <StandardConfigPage />
            ) : route.page === 'workbench' ? (
              <WorkbenchPage stationId={route.id} />
            ) : route.page === 'analysis' ? (
              <AnalysisPage stationId={route.id} />
            ) : route.page === 'compare' ? (
              <ComparePage stationId={route.id} />
            ) : route.page === 'diff' ? (
              <DiffPage stationId={route.id} vA={route.vA} vB={route.vB} />
            ) : route.page === 'admin-users' ? (
              <UserManagementPage />
            ) : route.page === 'ai-config' ? (
              <AiConfigPage />
            ) : route.page === 'ai-usage' ? (
              <AiUsagePage />
            ) : route.page === 'ai-suggestions' ? (
              <AiSuggestionsPage stationId={route.id} initialSource={route.source} />
            ) : route.page === 'ai-segment' ? (
              <AiSegmentPage stationId={route.id} />
            ) : route.page === 'ai-waste' ? (
              <AiWastePage stationId={route.id} initialSource={route.source} />
            ) : route.page === 'help' ? (
              <HelpPage />
            ) : (
              <ChangePasswordPage forced={false} />
            )}
            </Suspense>
          </main>
        </div>

        {/* 工作台收起右侧面板：把横向空间让给视频（分解时看画面优先） */}
        {(route.page === 'dashboard' || route.page === 'stations' || route.page === 'analysis' || route.page === 'compare') && (
          <ContextPanel
            mode={route.page === 'dashboard' ? 'group' : onStationRoute && stationDetail ? 'station' : 'line'}
            lineId={lineForPanel}
            station={stationDetail}
            dash={route.page === 'dashboard' ? dashSummary : null}
            onOpenLine={openLine}
            onOpenStation={(id) => { window.location.hash = `#/workbench/${id}`; }}
            lineRow={(linesSummary?.lines ?? []).find((l) => l.line_id === lineForPanel) ?? null}
            company={linesSummary?.company}
            region={linesSummary?.region ?? null}
          />
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
