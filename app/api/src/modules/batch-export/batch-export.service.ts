import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { RulesService } from '../../core/rules/rules.service';
import { StationRepository, StationsService } from '../stations/stations.service';
import { ElementRepository } from '../elements/element.repository';
import { analyzeStation, buildLineAnalysis } from '../analysis/engine';
import { TasksService, isoDate } from '../decomposition-tasks/tasks.service';
import { DecompositionTask } from '../../entities/decomposition-task.entity';
import { TaskStation } from '../../entities/task-station.entity';
import { AuthUser } from '../../auth/auth-user.interface';
import { round1, round2 } from '../../core/shared/util';
import { BatchExportQueryDto, flagOf } from './batch-export.dto';
import { bucketTable, makeBucketResolver, TimeBucket } from './time-buckets';
import { shortDesc, vaLabel } from './format';
import type { ExportModel, FocusRow, StationExportRow } from './export-model';

/** 单批上限（定稿 §7.2）：不静默截断，超限直接 400 让用户拆分范围 */
const MAX_STATIONS = 200;
const MAX_ELEMENTS = 100_000;
/** 三级校验容差（秒）——CT 为 round2 后的值，Σ原始 ST 与之允许 ≤0.01s 误差 */
const EPS = 0.011;

const ECRS_LABEL: Record<string, string> = { E: '取消', C: '合并', R: '重排', S: '简化' };

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 批量导出取数与派生（v1 不改库 MVP）。
 *
 * 纪律：
 *  - 只做 SELECT + 纯函数派生；不落库、不回写 ST、不改 va_class、不删除任何要素（RNVA 只压不删）。
 *  - 口径复用 analyzeStation / buildLineAnalysis，规则集一次加载；四类时间与焦点是**导出时派生列**。
 *  - 导出范围 = 可见工位（filterVisible = ACL ∪ data_scope）∩ 请求白名单；不可见工位直接剔除，不报错、不泄露。
 *  - 聚合（平衡率 / 瓶颈 / ΣVA）在工程计算**之前**按最终导出工位集合过滤，杜绝「筛了行没筛聚合值」。
 *  - AI 数据边界：04 表的浪费与措施只来自 waste_triggers ∪ ecrsa_map，不跨模块合并 AI 建议/证据全文。
 */
@Injectable()
export class BatchExportService {
  private readonly log = new Logger(BatchExportService.name);
  private readonly stationRepo: StationRepository;
  private readonly elementRepo: ElementRepository;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly stations: StationsService,
    private readonly rules: RulesService,
    private readonly tasks: TasksService,
  ) {
    this.stationRepo = new StationRepository(ds);
    this.elementRepo = new ElementRepository(ds);
  }

  async buildModel(q: BatchExportQueryDto, user: AuthUser): Promise<ExportModel> {
    /* ── 1) 规则集（单一来源，取版本号供封面/说明页追溯） ───────────────── */
    const vaRules = this.rules.getActive('va_rules');
    const wasteRules = this.rules.getActive('waste_triggers');
    const ecrsaRules = this.rules.getActive('ecrsa_map');
    const motionRules = this.rules.getActive('motion_standard');
    // Phase 2 / MS1.4：四类时间由生效 motion_standard.time_bucket 判定，改配置发布后即时生效
    const resolveBucket = makeBucketResolver(motionRules.json);
    const knownTypes: string[] = (vaRules.json?.types ?? []).map((t: any) => String(t.type));
    const knownTypeSet = new Set(knownTypes);
    const mappings: any[] = ecrsaRules.json?.mappings ?? [];

    /* ── 2) 分解任务（Phase 2 / 定稿 §3.8）：一个工作簿 = 一个任务 ───────── */
    let task: DecompositionTask | null = null;
    let linkByStation = new Map<string, TaskStation>();
    if (q.task_id) {
      task = await this.tasks.assertTaskReadable(q.task_id, user);
      if (String(task.line_id) !== String(q.line_id)) {
        throw new BadRequestException(`任务 ${task.task_no} 不属于产线 ${q.line_id}`);
      }
      const links = await this.ds.getRepository(TaskStation).find({
        where: { tenant_id: user.tenantId, task_id: task.task_id },
        order: { seq_no: 'ASC' },
      } as any);
      if (!links.length) throw new BadRequestException(`任务 ${task.task_no} 未关联任何工位`);
      linkByStation = new Map(links.map((l) => [String(l.station_id), l]));
    }

    /* ── 3) 可见工位（唯一口径：StationsService.filterVisible） ─────────── */
    const candidates = task
      ? await this.stationRepo.find(
        { station_id: In([...linkByStation.keys()]), tenant_id: user.tenantId } as any,
        { order: { station_id: 'ASC' } },
      ) as any[]
      : await this.stationRepo.find(
        { line_id: q.line_id }, { order: { station_id: 'ASC' } },
      ) as any[];
    if (candidates.length === 0) {
      throw new BadRequestException(`产线 ${q.line_id} 不存在或没有工位`);
    }
    const visibleAll = await this.stations.filterVisible(
      candidates, user.userId, user.roles, user.dataScope, user.tenantId,
    ) as any[];
    // 任务模式再与任务关联工位取交集：不可见 / 不属于该任务的工位都不进文件
    const visible = task
      ? visibleAll.filter((s) => linkByStation.has(String(s.station_id)))
      : visibleAll;
    const requested = q.stations
      ? new Set(q.stations.split(',').map((s) => s.trim()).filter(Boolean))
      : null;
    // 请求白名单与可见范围取交集：构造请求带不可见 id 时静默剔除，不回显存在性
    const byCode = (a: any, b: any) => String(a.station_id).localeCompare(String(b.station_id));
    const pool = (requested ? visible.filter((s) => requested.has(s.station_id)) : visible)
      .sort(task
        ? (a, b) => (Number(linkByStation.get(String(a.station_id))?.seq_no) || 0)
          - (Number(linkByStation.get(String(b.station_id))?.seq_no) || 0) || byCode(a, b)
        : byCode);
    if (pool.length > MAX_STATIONS) {
      throw new BadRequestException(`本次导出 ${pool.length} 个工位，超过 ${MAX_STATIONS} 个上限，请缩小范围分批导出`);
    }

    /* ── 4) 两条 SQL 取数：工位一次 + 要素一次，禁止按工位 N+1 ──────────── */
    const poolIds = pool.map((s) => String(s.station_id));
    const elementWhere: any = { station_id: In(poolIds) };
    // 任务模式按 task_id 硬隔离（两轮改善要素互不串）；兼容模式保持 v3.61/62 行为
    if (task) elementWhere.task_id = task.task_id;
    const allElements: any[] = poolIds.length
      /* [task-scope:compat] Phase 2 按产线兼容模式：指定 task_id 时上方 elementWhere 已带任务条件；
       未指定时按设计导出全产线当前版本，不额外按任务收窄（§3.8 兼容模式口径）。 */
      ? await this.elementRepo.find(elementWhere, { order: { seq: 'ASC' } } as any)
      : [];
    const byStation = new Map<string, any[]>();
    for (const s of poolIds) byStation.set(s, []);
    for (const el of allElements) {
      const list = byStation.get(String(el.station_id));
      if (list) list.push(el);
    }
    // 任务模式读 t_task_station 锁定的 bol_version（不随 station.version 漂移）；
    // 兼容模式读各工位当前生效版本；历史封存版一律不入表
    for (const [sid, list] of byStation) {
      const station = pool.find((s) => String(s.station_id) === sid);
      const locked = task ? Number(linkByStation.get(sid)?.bol_version) : Number(station?.version);
      byStation.set(sid, list.filter((el) => Number(el.bol_version) === locked));
    }
    const totalElements = [...byStation.values()].reduce((acc, list) => acc + list.length, 0);
    if (totalElements > MAX_ELEMENTS) {
      throw new BadRequestException(`本次导出 ${totalElements} 条要素，超过 ${MAX_ELEMENTS} 条上限，请缩小范围分批导出`);
    }

    const options = {
      includeOutliers: flagOf(q.include_outliers, false),
      includeUndecomposed: flagOf(q.include_undecomposed, false),
      // 无 analysis:read 时 04 表整体不生成（权限降级，03 表 VA 判定与四类时间仍保留）
      withFocus: user.permissions.has('analysis:read') && flagOf(q.with_focus, true),
      focusTop: Number(q.focus_top ?? 30),
    };

    // 未分解工位不进导出行时，也不参与聚合计算（否则 balance_rate / ΣCT 与表格对不上）
    const chosen = options.includeUndecomposed
      ? pool
      : pool.filter((s) => (byStation.get(String(s.station_id)) ?? []).length > 0);
    const rows = chosen.map((station) => ({
      station,
      elements: byStation.get(String(station.station_id)) ?? [],
    }));

    /* ── 4) 复用分析引擎（口径零变化） ──────────────────────────────────── */
    const analyses = rows.map(({ station, elements }) =>
      analyzeStation(station, elements, vaRules.json, wasteRules.json));
    const lineAnalysis = rows.length > 0
      ? buildLineAnalysis(q.line_id, rows, vaRules.json, wasteRules.json)
      : null;
    const maxCt = Math.max(0, ...analyses.map((a) => num(a.metrics.ct)));

    /* ── 5) 派生四类时间 / 焦点要素 ────────────────────────────────────── */
    const stations: StationExportRow[] = analyses.map((analysis, i) => {
      const station = rows[i].station;
      const classified: any[] = analysis.elements;
      const active = classified.filter((el) => Number(el.outlier_flag) === 0);
      const ct = num(analysis.metrics.ct);
      const buckets: Record<TimeBucket, number> = { manual: 0, machine: 0, walk: 0, wait: 0 };
      let unknownTypeS = 0;
      for (const el of active) {
        const st = num(el.std_time);
        buckets[resolveBucket(String(el.type))] += st;
        if (!knownTypeSet.has(String(el.type))) unknownTypeS += st;
      }
      for (const k of Object.keys(buckets) as TimeBucket[]) buckets[k] = round2(buckets[k]);
      return {
        stationId: String(station.station_id),
        stationName: String(station.name ?? station.station_id),
        version: Number(station.version),
        elements: rows[i].elements,
        classified,
        active,
        metrics: analysis.metrics,
        wastes: analysis.wastes,
        buckets,
        focusIds: new Set<string>(),
        isBottleneck: maxCt > 0 && Math.abs(ct - maxCt) < 1e-6,
        fallbackPct: ct > 0 ? round1((unknownTypeS / ct) * 100) : 0,
      };
    });

    const focus = options.withFocus
      ? this.buildFocusRows(stations, mappings, options.focusTop)
      : [];
    // 03 表 ★ 与 04 表行一一对应：按 element_id 精确回填（不靠编码拼接）
    const focusKeys = new Set(focus.map((f) => f.elementId));
    for (const s of stations) {
      for (const el of s.active) {
        if (focusKeys.has(String(el.element_id))) s.focusIds.add(String(el.element_id));
      }
    }

    /* ── 6) 三级校验：Σ四桶 = ΣST = CT（逐要素 / 逐工位 / 全任务） ───────── */
    this.assertBalanced(stations, resolveBucket);

    /* ── 7) 汇总与元数据 ────────────────────────────────────────────────── */
    const sum = (pick: (s: StationExportRow) => number) => round2(stations.reduce((acc, s) => acc + pick(s), 0));
    const ct = sum((s) => num(s.metrics.ct));
    const va = sum((s) => num(s.metrics.va));
    const rnva = sum((s) => num(s.metrics.rnva));
    const nva = sum((s) => num(s.metrics.nva));
    const machine = sum((s) => s.buckets.machine);
    const meta = await this.lineMeta(q.line_id, chosen[0]?.tenant_id, user.tenantId);

    return {
      meta: {
        lineId: q.line_id,
        ...meta,
        scopeNote: task
          ? `一个工作簿 = 一个分解任务（${task.task_no} · ${isoDate(task.period_start)}~${isoDate(task.period_end)}）；只导出该任务 t_task_station 锁定的 bol_version，工位按任务内 seq_no 排序；归档/历史归集任务仍可导出。`
          : '按产线的兼容模式：可见工位 × 各工位当前生效版本，不区分分解任务；若已启用多任务，请改用「按任务」导出以免混合不同轮次要素。',
        taskId: task?.task_id ?? null,
        taskNo: task?.task_no ?? null,
        taskName: task?.name ?? null,
        periodStart: isoDate(task?.period_start),
        periodEnd: isoDate(task?.period_end),
        roundType: task?.round_type ?? null,
        taskStatus: task?.status ?? null,
        exportedAt: new Date(),
        exporter: user.displayName || user.username,
        ruleVersions: {
          va_rules: vaRules.version,
          waste_triggers: wasteRules.version,
          ecrsa_map: ecrsaRules.version,
          motion_standard: motionRules.version,
        },
        stationCount: stations.length,
        decomposedCount: stations.filter((s) => s.elements.length > 0).length,
        elementCount: stations.reduce((acc, s) => acc + s.elements.length, 0),
        activeElementCount: stations.reduce((acc, s) => acc + s.active.length, 0),
        focusCount: focus.length,
      },
      totals: {
        ct, tt: num(lineAnalysis?.tt_s ?? stations[0]?.metrics.tt ?? 0),
        balanceRate: num(lineAnalysis?.balance_rate ?? 0),
        va, rnva, nva,
        vaPct: ct > 0 ? round1((va / ct) * 100) : 0,
        nvaPct: ct > 0 ? round1((nva / ct) * 100) : 0,
        manual: sum((s) => s.buckets.manual),
        machine,
        walk: sum((s) => s.buckets.walk),
        wait: sum((s) => s.buckets.wait),
        outlierCount: stations.reduce((acc, s) => acc + num(s.metrics.outlier_count), 0),
        operatorVaPct: ct - machine > 0 ? round1((va / (ct - machine)) * 100) : 0,
      },
      stations,
      focus,
      options,
      bucketResolver: resolveBucket,
      bucketTable: bucketTable(knownTypes, resolveBucket),
    };
  }

  /**
   * 焦点要素（定稿 §6.4）：候选 F1 命中浪费 / F2 NVA 且 ST≥0.5s / F3 ST≥1.0s 或 占CT≥3%；
   * 异常要素恒不进焦点表（数据质量问题 ≠ 改善机会）；按 ST×factor 降序取每工位 Top5、全任务 TopN。
   * 每要素只取**一条** ecrsa 映射（factor 最大者），天然满足 1 浪费 / 1 ECRS / 1 措施，
   * 解决 buildMotionDetail.directions 多句拼接导致的长文本问题。
   */
  private buildFocusRows(stations: StationExportRow[], mappings: any[], topN: number): FocusRow[] {
    const all: (FocusRow & { elementId: string })[] = [];
    for (const s of stations) {
      const ct = num(s.metrics.ct);
      const perStation: (FocusRow & { elementId: string })[] = [];
      for (const el of s.active) {
        const st = num(el.std_time);
        const ctPct = ct > 0 ? (st / ct) * 100 : 0;
        const hits = s.wastes.filter((w: any) => (w.element_ids ?? []).includes(String(el.element_id)));
        const wasteTypes = [...new Set(hits.map((w: any) => String(w.waste)))] as string[];
        const va = String(el.va_effective ?? el.va_class ?? '');
        const candidate = hits.length > 0
          || (va === 'NVA' && st >= 0.5)
          || st >= 1.0
          || ctPct >= 3;
        if (!candidate) continue;

        const best = mappings
          .filter((m) => wasteTypes.includes(String(m.waste)))
          .sort((a, b) => num(b.factor) - num(a.factor))[0];
        const factor = best ? num(best.factor) : 0.3; // 无命中取保守默认，不新造评分模型
        const measure = shortDesc(best?.measure ?? '', 24);
        perStation.push({
          elementId: String(el.element_id),
          stationId: s.stationId,
          seq: Number(el.seq),
          desc: shortDesc(el.desc),
          vaLabel: vaLabel(va),
          stdTime: round2(st),
          waste: String(best?.waste ?? wasteTypes[0] ?? ''),
          ecrs: ECRS_LABEL[String(best?.method ?? '')] ?? String(best?.method ?? ''),
          measure,
          compressible: best ? round2(st * factor) : null,
          potential: st * factor,
          ctPct: round1(ctPct),
        });
      }
      perStation.sort((a, b) => b.potential - a.potential || b.ctPct - a.ctPct
        || a.stationId.localeCompare(b.stationId) || a.seq - b.seq);
      all.push(...perStation.slice(0, 5));
    }
    all.sort((a, b) => b.potential - a.potential || b.ctPct - a.ctPct
      || a.stationId.localeCompare(b.stationId) || a.seq - b.seq);
    return all.slice(0, topN);
  }

  /** 生成前自检：不通过则抛错，绝不「带病出表」 */
  private assertBalanced(stations: StationExportRow[], resolveBucket: (t: string) => TimeBucket): void {
    for (const s of stations) {
      // ① 逐要素：E+F+G+H = ST 且恰一桶有值（按同一解析器单桶写入，恒等）
      for (const el of s.active) {
        const st = num(el.std_time);
        const bucketSum = (['manual', 'machine', 'walk', 'wait'] as TimeBucket[])
          .filter((b) => resolveBucket(String(el.type)) === b)
          .reduce((acc) => acc + st, 0);
        if (Math.abs(bucketSum - st) > EPS) {
          throw new BadRequestException(`工位 ${s.stationId} 序号 ${el.seq} 四类时间合计不等于标准工时，导出中止`);
        }
      }
      // ② 逐工位：Σ四桶 = ΣST = CT
      const stSum = round2(s.active.reduce((acc, el) => acc + num(el.std_time), 0));
      const bucketSum = round2(s.buckets.manual + s.buckets.machine + s.buckets.walk + s.buckets.wait);
      if (Math.abs(bucketSum - stSum) > EPS || Math.abs(stSum - num(s.metrics.ct)) > EPS) {
        throw new BadRequestException(
          `工位 ${s.stationId} 口径校验失败（Σ四桶=${bucketSum} / ΣST=${stSum} / CT=${s.metrics.ct}），导出中止`,
        );
      }
      // ③ VA + RNVA + NVA = CT
      const tri = num(s.metrics.va) + num(s.metrics.rnva) + num(s.metrics.nva);
      if (Math.abs(tri - num(s.metrics.ct)) > 0.02) {
        throw new BadRequestException(`工位 ${s.stationId} VA/RNVA/NVA 合计不等于 CT，导出中止`);
      }
    }
  }

  /** 产线 / 租户元数据：不可达时降级为编码本身，不猜（CMC 单一数据源 / 宁缺勿错） */
  private async lineMeta(lineId: string, tenantFromStation?: string, tenantFromUser?: string) {
    const empty = {
      lineName: lineId, company: '', region: '', productProject: '', processType: '',
    };
    const tenantId = tenantFromStation ?? tenantFromUser ?? '';
    if (!tenantId) return empty;
    try {
      const line = await this.ds.getRepository('t_line')
        .findOneBy({ tenant_id: tenantId, line_id: lineId } as any) as any;
      const tenant = await this.ds.getRepository('t_tenant')
        .findOneBy({ tenant_id: tenantId } as any) as any;
      return {
        lineName: String(line?.name ?? lineId),
        company: String(tenant?.name ?? ''),
        region: String(tenant?.region ?? ''),
        productProject: String(line?.product_project ?? ''),
        processType: String(line?.process_type ?? ''),
      };
    } catch (e) {
      this.log.warn(`产线元数据读取失败，降级为编码: ${(e as Error).message}`);
      return empty;
    }
  }
}
