import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { Counter, register } from 'prom-client';
import { RulesService } from '../../core/rules/rules.service';
import { analyzeStation } from '../analysis/engine';
import { round1, round2 } from '../../core/shared/util';
import { TtlCache } from '../../core/shared/ttl-cache';
import { APP_CONFIG, AppConfig } from '../../core/config/configuration';

/**
 * 集团综合驾驶舱聚合服务（v3.3）。
 * 铁律：跨公司视图只含聚合指标（计数/均值/汇总），绝不返回工位要素明细；
 *       指标口径与既有分析引擎逐字一致（CT=非异常 std 合计；VA 加权=Σva/Σct；
 *       平衡率=ΣCT/(maxCT×工位数) —— 与 engine.buildLineAnalysis 同公式）。
 * 维度过滤：区域/公司（t_tenant）→ 工艺/产品类型（t_line）→ 工位/要素；
 *           项目类型只切任务聚合（t_improvement），不影响产线指标。
 */
export interface DashboardFilters {
  region?: string;
  company?: string;
  process?: string;
  product_type?: string;
  project?: string;
}

interface StationMetric {
  station_id: string; tenant_id: string; line_id: string;
  ct: number; va: number; va_pct: number;
}

interface LineAgg {
  tenant_id: string; line_id: string;
  station_count: number; ct_sum: number; va_sum: number; max_ct: number;
  imp_pending: number; updated_at: Date | null;
}

interface Scope {
  tenantMap: Map<string, any>;
  allowedLines: Map<string, any>;
  /** v3.25 层级配置化：lineKey → 派生 {region, company}（CMC factories 优先，本地线回退租户） */
  lineOrg: Map<string, { region: string; company: string }>;
  scoped: any[];
  stationMap: Map<string, any>;
  metrics: Map<string, StationMetric>;
  imps: any[];
}

const lineKey = (t: string, l: string) => `${t}|${l}`;

/**
 * 缓存结果计数（可观测性）：hit=命中 / miss=未命中并回源 / shared=合并到同键 in-flight。
 * 命名空间用 ie_ 前缀与既有指标一致；幂等获取（同一进程内模块被重复加载也不会重复注册）。
 */
function dashboardCacheCounter(): Counter<'result'> {
  const found = register.getSingleMetric('ie_dashboard_cache_total');
  if (found instanceof Counter) return found as Counter<'result'>;
  return new Counter<'result'>({
    name: 'ie_dashboard_cache_total',
    help: '驾驶舱聚合缓存结果（hit/miss/shared）',
    labelNames: ['result'],
    registers: [register],
  });
}

@Injectable()
export class DashboardService {
  /** 缓存只存成功结果；未命中时 single-flight 把同键并发压成一次聚合 */
  private readonly cache: TtlCache;
  private readonly cacheMetrics: Counter<'result'>;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rules: RulesService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    this.cache = new TtlCache({ ttlMs: this.cfg.dashboardCacheTtlMs, maxEntries: 64, label: 'dashboard' });
    this.cacheMetrics = dashboardCacheCounter();
  }

  /**
   * 大区/公司派生（v3.25 层级配置化）：
   *   t_line.cmc_line_id → CMC production_lines.factory_id → factories.region/name（实时直查，零同步）。
   *   大区配置位 = CMC factories.region（集团配"北美区"即在 CMC 维护），本系统不硬编码任何区域。
   *   无 CMC 关联的本地线 → 回退 t_tenant.region/name；CMC 不可达 → 同样回退（宁缺勿错，不伪造）。
   */
  private async resolveLineOrg(lines: any[], tenantMap: Map<string, any>):
      Promise<Map<string, { region: string; company: string }>> {
    const cmcIds = [...new Set(lines.map((l) => Number(l.cmc_line_id)).filter((n) => Number.isFinite(n) && n > 0))];
    const cmcOrg = new Map<number, { region: string | null; factory: string | null }>();
    if (cmcIds.length > 0) {
      try {
        const rows = (await this.ds.query(
          `SELECT pl.id AS line_id, f.region AS region, f.name AS factory
           FROM CMC.dbo.production_lines pl
           JOIN CMC.dbo.factories f ON f.id = pl.factory_id
           WHERE pl.id IN (${cmcIds.map((n) => Math.trunc(n)).join(',')})`,
        )) as any[];
        for (const r of rows) cmcOrg.set(Number(r.line_id), { region: r.region ?? null, factory: r.factory ?? null });
      } catch {
        /* CMC 不可达：回退租户值（SELECT-only，无副作用） */
      }
    }
    const org = new Map<string, { region: string; company: string }>();
    for (const l of lines) {
      const t = tenantMap.get(l.tenant_id);
      const co = l.cmc_line_id ? cmcOrg.get(Number(l.cmc_line_id)) : undefined;
      org.set(lineKey(l.tenant_id, l.line_id), {
        region: co?.region ?? t?.region ?? '未分区',
        company: co?.factory ?? t?.name ?? l.tenant_id,
      });
    }
    return org;
  }

  /**
   * 维度解析（summary 与 improvements 共用的取数链）：
   * 全量租户/产线 → CMC 派生大区/公司 → 内存筛选 → 工位（交集）→ 要素（生效版本）→ 任务（项目类型）。
   * v3.25：region/company 筛选从 t_tenant 硬编码列改为**派生键匹配**（CMC factories.region/name），
   * 租户集合不再被 region/company 预过滤——筛选下钻与显示层级同源，点击"China"不再筛空。
   * 返回均为内存结构，绝不含跨公司要素明细外泄（工位仅用于定位与聚合）。
   */
  private async resolveScope(f: DashboardFilters, tenantScope: string[] | null = null, visibleStationIds: string[] | null = null): Promise<Scope> {
    const tenantRepo = this.ds.getRepository('t_tenant');
    const lineRepo = this.ds.getRepository('t_line');
    const stationRepo = this.ds.getRepository('t_station');
    const elementRepo = this.ds.getRepository('t_element');
    const impRepo = this.ds.getRepository('t_improvement');

    // 1. 租户集合（region/company 改派生键内存过滤，不再下推到 t_tenant 列）
    //    v3.42：tenantScope 非空 → 只保留调用者租户（综合看板全角色开放后的租户隔离收口）；
    //    null = 跨租户全量（仅 sys_admin/ie_admin，controller 判定）。
    const tenants = (await tenantRepo.find({ order: { tenant_id: 'ASC' } })) as any[];
    const tenantMap = new Map(tenants.map((t) => [t.tenant_id as string, t]));
    const tenantIds = tenantScope ? [...tenantMap.keys()].filter((t) => tenantScope.includes(t)) : [...tenantMap.keys()];

    // 2. 产线维度（工艺/产品类型仍走 DB 过滤；租户集合内）
    const lineWhere: Record<string, unknown> = {};
    if (tenantIds.length > 0) lineWhere.tenant_id = In(tenantIds);
    if (f.process) lineWhere.process_type = f.process;
    if (f.product_type) lineWhere.product_type = f.product_type;
    const lines = tenantIds.length > 0 ? ((await lineRepo.find({ where: lineWhere, order: { line_id: 'ASC' } })) as any[]) : [];

    // 2'. 大区/公司派生（CMC 优先）+ region/company 内存筛选
    const lineOrg = await this.resolveLineOrg(lines, tenantMap);
    let allowed = lines;
    if (f.region) allowed = allowed.filter((l) => lineOrg.get(lineKey(l.tenant_id, l.line_id))?.region === f.region);
    if (f.company) allowed = allowed.filter((l) => lineOrg.get(lineKey(l.tenant_id, l.line_id))?.company === f.company);
    const allowedLines = new Map(allowed.map((l) => [lineKey(l.tenant_id, l.line_id), l]));

    // 3. 工位（租户内 ∩ 产线集合 ∩ **可见范围**）
    //    v3.55：visibleStationIds 非 null 时只保留调用者可见的工位——
    //    平衡率/VA%/瓶颈/任务统计全部基于该子集重算，不泄露他人工位结果。
    const allStations = tenantIds.length > 0
      ? ((await stationRepo.find({ where: { tenant_id: In(tenantIds) }, order: { station_id: 'ASC' } })) as any[])
      : [];
    const visibleSet = visibleStationIds ? new Set(visibleStationIds) : null;
    const scopedStations = visibleSet
      ? allStations.filter((s) => visibleSet.has(s.station_id))
      : allStations;
    const scoped = scopedStations.filter((s) => allowedLines.has(lineKey(s.tenant_id, s.line_id)));
    const stationMap = new Map(scoped.map((s) => [s.station_id as string, s]));

    // 4. 要素（一次取回，内存按工位生效版本过滤）
    const stationIds = scoped.map((s) => s.station_id as string);
    const elements = stationIds.length > 0 ? ((await elementRepo.find({ where: { station_id: In(stationIds) } })) as any[]) : [];
    const elByStation = new Map<string, any[]>();
    for (const e of elements) {
      const arr = elByStation.get(e.station_id) ?? [];
      arr.push(e);
      elByStation.set(e.station_id, arr);
    }

    // 5. 每工位指标（引擎纯函数，口径与单工位分析一致）
    const vaRules = this.rules.getActive('va_rules');
    const wasteRules = this.rules.getActive('waste_triggers');
    const metrics = new Map<string, StationMetric>();
    for (const s of scoped) {
      const els = (elByStation.get(s.station_id) ?? []).filter((e) => Number(e.bol_version) === Number(s.version));
      const a = analyzeStation(s, els, vaRules.json, wasteRules.json);
      metrics.set(s.station_id, {
        station_id: s.station_id, tenant_id: s.tenant_id, line_id: s.line_id,
        ct: a.metrics.ct, va: a.metrics.va, va_pct: a.metrics.va_pct,
      });
    }

    // 6. 改善任务（项目类型过滤只切任务侧；限定在范围内工位）
    const impWhere: Record<string, unknown> = {};
    if (tenantIds.length > 0) impWhere.tenant_id = In(tenantIds);
    if (f.project) impWhere.project_type = f.project;
    const imps = tenantIds.length > 0
      ? ((await impRepo.find({ where: impWhere })) as any[]).filter((i) => metrics.has(i.station_id))
      : [];

    return { tenantMap, allowedLines, lineOrg, scoped, stationMap, metrics, imps };
  }

  /**
   * 集团驾驶舱汇总（对外契约不变）。
   * 加缓存的动机：50 人早高峰会在同一时刻打开同一 URL（筛选条件也相同），
   * 而单次 summary 要做 5 张表全量取数 + 逐工位 analyzeStation()。
   * 30s TTL 兜住"先后到达"的请求，single-flight 兜住"同时到达"的请求。
   *
   * v3.55：visibleStationIds 收口——非全权角色的聚合只统计其可见工位；
   * 同时缓存键必须按可见范围分区（见 cacheKey），否则同租户不同用户的
   * 聚合结果会互相串味（这正是「看板显示别人数据」的技术根因之一）。
   */
  async summary(f: DashboardFilters, tenantId: string, crossTenant = false, visibleStationIds: string[] | null = null) {
    // v3.42：非全权角色锁本租户（决策 1 综合看板全角色开放后，租户边界必须收口）；
    // 缓存键按 scope 分区——同租户普通用户共享一份缓存，全权角色共享 'ALL' 一份。
    // v3.55：再按可见范围分区（不同用户可见集不同 → 缓存键必须区分）。
    const key = this.cacheKey('summary', crossTenant ? 'ALL' : tenantId, f, visibleStationIds);
    const outcome = await this.cache.resolve(key, () => this.computeSummary(f, crossTenant ? null : [tenantId], visibleStationIds));
    this.cacheMetrics.inc({ result: outcome.result });
    // 注意：不往响应体里加 cached 字段——前端与既有 contract 测试按字段白名单校验
    return outcome.value;
  }

  private async computeSummary(f: DashboardFilters, tenantScope: string[] | null, visibleStationIds: string[] | null) {
    const { allowedLines, lineOrg, scoped, metrics, imps } = await this.resolveScope(f, tenantScope, visibleStationIds);
    const vaRules = this.rules.getActive('va_rules');
    const wasteRules = this.rules.getActive('waste_triggers');

    // 7. 产线级聚合（平衡率公式与 engine.buildLineAnalysis 一致）
    const lineAgg = new Map<string, LineAgg>();
    for (const s of scoped) {
      const key = lineKey(s.tenant_id, s.line_id);
      const m = metrics.get(s.station_id)!;
      const agg = lineAgg.get(key) ?? {
        tenant_id: s.tenant_id, line_id: s.line_id,
        station_count: 0, ct_sum: 0, va_sum: 0, max_ct: 0, imp_pending: 0, updated_at: null,
      };
      agg.station_count += 1;
      agg.ct_sum = round2(agg.ct_sum + m.ct);
      agg.va_sum = round2(agg.va_sum + m.va);
      agg.max_ct = Math.max(agg.max_ct, m.ct);
      if (s.updated_at && (!agg.updated_at || new Date(s.updated_at) > new Date(agg.updated_at))) {
        agg.updated_at = new Date(s.updated_at);
      }
      lineAgg.set(key, agg);
    }
    for (const imp of imps) {
      if (imp.status !== '待实施') continue;
      const m = metrics.get(imp.station_id)!;
      const agg = lineAgg.get(lineKey(m.tenant_id, m.line_id));
      if (agg) agg.imp_pending += 1;
    }

    const lineRows = [...lineAgg.values()].map((a) => {
      const meta = allowedLines.get(lineKey(a.tenant_id, a.line_id))!;
      const org = lineOrg.get(lineKey(a.tenant_id, a.line_id))!;
      const bottleneck_count = scoped.filter((s) => {
        const m = metrics.get(s.station_id)!;
        return lineKey(s.tenant_id, s.line_id) === lineKey(a.tenant_id, a.line_id) && Math.abs(m.ct - a.max_ct) < 1e-6;
      }).length;
      return {
        line_id: a.line_id,
        line_name: meta.name,
        tenant_id: a.tenant_id,
        company: org.company,
        region: org.region,
        process_type: meta.process_type,
        product_type: meta.product_type,
        product_project: meta.product_project,
        station_count: a.station_count,
        balance_rate: a.max_ct > 0 ? round1((a.ct_sum / (a.max_ct * a.station_count)) * 100) : 0,
        avg_va_pct: a.ct_sum > 0 ? round1((a.va_sum / a.ct_sum) * 100) : 0,
        bottleneck_count,
        imp_pending: a.imp_pending,
        updated_at: a.updated_at,
      };
    });

    // 8. 维度分布（区域/公司/工艺/产品：工位级 VA 加权；项目：任务级）
    const groupBy = <T>(rows: T[], keyOf: (r: T) => string) => {
      const m = new Map<string, T[]>();
      for (const r of rows) {
        const k = keyOf(r);
        (m.get(k) ?? m.set(k, []).get(k)!).push(r);
      }
      return m;
    };
    const weightedVa = (rows: { ct_sum: number; va_sum: number }[]) =>
      rows.reduce((a, r) => a + r.ct_sum, 0) > 0
        ? round1((rows.reduce((a, r) => a + r.va_sum, 0) / rows.reduce((a, r) => a + r.ct_sum, 0)) * 100)
        : 0;

    // 工位级分组基元（带维度标签 + ct/va 加权原料）——v3.25：region/company 用 CMC 派生值
    const stationBase = scoped.map((s) => {
      const m = metrics.get(s.station_id)!;
      const meta = allowedLines.get(lineKey(s.tenant_id, s.line_id))!;
      const org = lineOrg.get(lineKey(s.tenant_id, s.line_id))!;
      return { station_id: s.station_id, region: org.region, tenant_id: s.tenant_id, company: org.company, process_type: meta.process_type, product_type: meta.product_type, ct_sum: m.ct, va_sum: m.va };
    });
    const lineBase = lineRows.map((l) => ({ ...l, ct_sum: lineAgg.get(lineKey(l.tenant_id, l.line_id))!.ct_sum, va_sum: lineAgg.get(lineKey(l.tenant_id, l.line_id))!.va_sum }));

    const by_region = [...groupBy(stationBase, (r) => r.region).entries()].map(([region, rows]) => ({
      region,
      company_count: new Set(rows.map((r) => r.company)).size,
      line_count: lineRows.filter((l) => l.region === region).length,
      station_count: rows.length,
      avg_va_pct: weightedVa(rows),
      imp_pending: lineRows.filter((l) => l.region === region).reduce((a, l) => a + l.imp_pending, 0),
    })).sort((a, b) => b.station_count - a.station_count);

    /* v3.25：公司按**派生公司名**聚合（CMC factory 优先）——同一 CMC 工厂在不同租户建的线
       归到同一家公司；筛选值从 tenant_id 改为公司名（与显示层级同源，下钻不再断链） */
    const by_company = [...groupBy(stationBase, (r) => r.company).entries()].map(([company, rows]) => {
      const cLines = lineRows.filter((l) => l.company === company);
      const stationIds = new Set(rows.map((r) => r.station_id));
      return {
        company,
        region: rows[0]?.region ?? '未分区',
        line_count: cLines.length,
        station_count: rows.length,
        avg_va_pct: weightedVa(rows),
        avg_balance_rate: cLines.length > 0 ? round1(cLines.reduce((a, l) => a + l.balance_rate, 0) / cLines.length) : 0,
        imp_pending: cLines.reduce((a, l) => a + l.imp_pending, 0),
        imp_verified: imps.filter((i) => stationIds.has(i.station_id) && i.status === '已验证').length,
      };
    }).sort((a, b) => b.station_count - a.station_count);

    const by_process = [...groupBy(stationBase, (r) => r.process_type).entries()].map(([process_type, rows]) => ({
      process_type,
      line_count: lineRows.filter((l) => l.process_type === process_type).length,
      station_count: rows.length,
      avg_va_pct: weightedVa(rows),
    })).sort((a, b) => b.station_count - a.station_count);

    const by_product = [...groupBy(stationBase, (r) => r.product_type).entries()].map(([product_type, rows]) => ({
      product_type,
      line_count: lineRows.filter((l) => l.product_type === product_type).length,
      station_count: rows.length,
      avg_va_pct: weightedVa(rows),
    })).sort((a, b) => b.station_count - a.station_count);

    const by_project = [...groupBy(imps, (i) => i.project_type).entries()].map(([project_type, rows]) => ({
      project_type,
      imp_count: rows.length,
      est_save_s: round1(rows.reduce((a, i) => a + Number(i.est_save_s), 0)),
      pending: rows.filter((i) => i.status === '待实施').length,
      done: rows.filter((i) => i.status === '已完成').length,
      verified: rows.filter((i) => i.status === '已验证').length,
    })).sort((a, b) => b.imp_count - a.imp_count);

    // 9. KPI（v3.25：company_count 按派生公司名计——同一 CMC 工厂跨租户的线归一家）
    const totalCt = round2(scoped.reduce((a, s) => a + metrics.get(s.station_id)!.ct, 0));
    const totalVa = round2(scoped.reduce((a, s) => a + metrics.get(s.station_id)!.va, 0));
    const kpis = {
      region_count: new Set(stationBase.map((r) => r.region)).size,
      company_count: new Set(stationBase.map((r) => r.company)).size,
      line_count: lineRows.length,
      station_count: scoped.length,
      avg_va_pct: totalCt > 0 ? round1((totalVa / totalCt) * 100) : 0,
      avg_balance_rate: lineRows.length > 0 ? round1(lineRows.reduce((a, l) => a + l.balance_rate, 0) / lineRows.length) : 0,
      bottleneck_line_count: lineRows.filter((l) => l.bottleneck_count > 0).length,
      imp_pending: imps.filter((i) => i.status === '待实施').length,
      imp_done: imps.filter((i) => i.status === '已完成').length,
      imp_verified: imps.filter((i) => i.status === '已验证').length,
      est_save_s_total: round1(imps.reduce((a, i) => a + Number(i.est_save_s), 0)),
    };

    // 10. 关注清单：平衡率最差 Top5 产线 + 临期（≤7天）待实施
    const topBottleneckLines = [...lineRows].sort((a, b) => a.balance_rate - b.balance_rate).slice(0, 5);
    const dueSoon = imps
      .filter((i) => i.status === '待实施' && i.due && new Date(i.due).getTime() - Date.now() <= 7 * 86400000)
      .sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime())
      .slice(0, 5)
      .map((i) => {
        const m = metrics.get(i.station_id)!;
        const meta = allowedLines.get(lineKey(m.tenant_id, m.line_id))!;
        const org = lineOrg.get(lineKey(m.tenant_id, m.line_id))!;
        return {
          imp_id: i.imp_id, station_id: i.station_id, measure: i.measure,
          project_type: i.project_type, est_save_s: Number(i.est_save_s),
          due: i.due, line_id: m.line_id, line_name: meta.name, company: org.company, region: org.region,
        };
      });

    return {
      scope: { region: f.region ?? 'all', company: f.company ?? 'all', process: f.process ?? 'all', product_type: f.product_type ?? 'all', project: f.project ?? 'all' },
      kpis,
      by_region,
      by_company,
      by_process,
      by_product,
      by_project,
      lines: [...lineRows].sort((a, b) => a.balance_rate - b.balance_rate),
      top_bottleneck_lines: topBottleneckLines,
      due_soon: dueSoon,
      rule_versions: { va_rules: vaRules.version, waste_triggers: wasteRules.version },
    };
  }

  /**
   * 跨公司改善任务列表（group:read）：维度链与 summary 完全一致（resolveScope 复用），
   * VO 形状与 GET /improvements 逐字段一致（v3.3 统一契约），附公司/区域/产线展示维度。
   * 支持 status 过滤（待实施/已完成/已验证）；排序优先级降序 → 创建时间降序。
   * v3.55：按可见工位收口（与 summary 同口径，缓存键同样分区）。
   */
  async improvements(f: DashboardFilters & { status?: string }, tenantId: string, crossTenant = false, visibleStationIds: string[] | null = null) {
    const key = this.cacheKey('improvements', crossTenant ? 'ALL' : tenantId, f, visibleStationIds);
    const outcome = await this.cache.resolve(key, () => this.computeImprovements(f, crossTenant ? null : [tenantId], visibleStationIds));
    this.cacheMetrics.inc({ result: outcome.result });
    return outcome.value;
  }

  private async computeImprovements(f: DashboardFilters & { status?: string }, tenantScope: string[] | null, visibleStationIds: string[] | null = null) {
    const { allowedLines, lineOrg, stationMap, metrics, imps } = await this.resolveScope(f, tenantScope, visibleStationIds);
    const rows = imps
      .filter((i) => !f.status || i.status === f.status)
      .sort((a, b) =>
        (Number(b.priority) || 0) - (Number(a.priority) || 0)
        || new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return {
      scope: { region: f.region ?? 'all', company: f.company ?? 'all', process: f.process ?? 'all', product_type: f.product_type ?? 'all', project: f.project ?? 'all', status: f.status ?? 'all' },
      improvements: rows.map((i) => {
        const m = metrics.get(i.station_id)!;
        const meta = allowedLines.get(lineKey(m.tenant_id, m.line_id))!;
        const org = lineOrg.get(lineKey(m.tenant_id, m.line_id));
        const st = stationMap.get(i.station_id)!;
        return {
          imp_id: i.imp_id,
          station_id: i.station_id,
          element_ids: i.element_ids,
          waste_type: i.waste_type,
          method: i.method,
          measure: i.measure,
          est_save_s: Number(i.est_save_s),
          priority: i.priority,
          status: i.status,
          project_type: i.project_type,
          owner: i.owner,
          due: i.due,
          before_ct: i.before_ct === null ? null : Number(i.before_ct),
          after_ct: i.after_ct === null ? null : Number(i.after_ct),
          created_at: i.created_at,
          station_name: st?.name ?? null,
          station_version: st?.version ?? null,
          line_id: m.line_id,
          line_name: meta?.name ?? null,
          process_type: meta?.process_type ?? null,
          product_type: meta?.product_type ?? null,
          product_project: meta?.product_project ?? null,
          tenant_id: m.tenant_id,
          company: org?.company ?? null,
          region: org?.region ?? null,
        };
      }),
    };
  }

  /**
   * 缓存键：`<kind>|<tenantId>|<规则版本>|<排序后的筛选>|<可见范围指纹>`。
   *
   * - 必须带 tenantId：resolveScope() 目前用 this.ds.getRepository(...) 原始仓储
   *   （绕过 ALS 租户过滤），结果只取决于 filters。但这是"当下"的实现细节——
   *   一旦有人把它改成 BaseRepository（自动附加 tenant_id 过滤），键里没有租户就会串租户，
   *   而且是那种"上线后偶发看到别家数据"的静默事故。键里先带上，成本为零。
   * - 必须带规则版本：summary 会回显 rule_versions，且 analyzeStation 的 VA 判定依赖规则；
   *   规则发布后若命中旧缓存，会返回"旧版本号 + 旧口径"的矛盾数据。getActive 是内存读，开销可忽略。
   * - 筛选必须排序拼接：对象键序不保证稳定，不排序会出现"同条件不同键"的缓存穿透。
   * - **必须带可见范围指纹（v3.55）**：聚合结果现在取决于调用者可见工位集。
   *   同租户不同用户可见集不同，若不分区 → A 打开看板后 B 拿到 A 的聚合结果，
   *   等于把"数据层收口"在缓存层又漏回去。指纹 = 可见集大小的稳定哈希。
   */
  private cacheKey(
    kind: 'summary' | 'improvements', tenantId: string,
    f: DashboardFilters & { status?: string }, visibleStationIds: string[] | null = null,
  ): string {
    const filters = Object.entries(f)
      .filter(([, v]) => v !== undefined && v !== null && String(v).length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${String(v)}`)
      .join('&');
    const rules = `${this.rules.getActive('va_rules').version}/${this.rules.getActive('waste_triggers').version}`;
    // 可见范围指纹：null（全权）→ 'ALL'；否则取排序后工位 id 的短哈希
    const scopeKey = visibleStationIds === null
      ? 'ALL'
      : `V${visibleStationIds.length}-${this.fingerprint(visibleStationIds)}`;
    return `${kind}|${tenantId || 'DEFAULT'}|${rules}|${filters}|${scopeKey}`;
  }

  /** 稳定短哈希（FNV-1a 32bit → 8 位十六进制）：可见工位集 → 缓存分区键 */
  private fingerprint(ids: string[]): string {
    let h = 0x811c9dc5;
    for (const id of [...ids].sort()) {
      for (let i = 0; i < id.length; i += 1) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      h ^= 0x2c;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }
}
