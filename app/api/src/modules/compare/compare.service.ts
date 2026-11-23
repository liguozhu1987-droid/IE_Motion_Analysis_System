import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Element } from '../../entities/element.entity';
import { RulesService } from '../../core/rules/rules.service';
import { StationRepository } from '../stations/stations.service';
import { AnalysisService } from '../analysis/analysis.service';
import { ImprovementRepository } from './improvement.repository';
import { estimateBenefit, getLineParams, pairElements } from './engine';
import { round1, round2 } from '../../core/shared/util';
import { TaskScopeService } from '../../core/task-scope/task-scope.service';
import { TaskScope } from '../../core/task-scope/task-scope';

export type ElementSource = 'manual' | 'ai_assisted';
type VersionLine = 'manual' | 'ai' | 'mixed';

interface VersionMeta {
  version: number;
  element_count: number;
  /** 版本内来源线：全 AI→ai，全手工→manual，两者都有→mixed（legacy，禁止参与对比） */
  line: VersionLine;
}

export interface CompareQuery {
  v1?: number | string;
  v2?: number | string;
  /** Phase 3 / D1：可选任务上下文；不传 → 自动继承 / legacy 回落 */
  task_id?: string;
  /** 预留：指定来源线（manual / ai_assisted）；缺省按同一来源线自动挑选最近两版 */
  source?: ElementSource | string;
}

/**
 * 对比服务（MVP compare/service.js 1:1 平移）：
 * 三层配对 + ΔCT 权威口径 + 收益估算（参数未配置即阻断）。
 * 规则：仅对比存在的两个版本，默认最近两版（v(n) vs v(n+1)）。
 *
 * v3.67（2026-11-23）来源线隔离：
 *  - AI 自动分解与手工分解是两条并行基线，**不是**改善前后版本；
 *  - 默认只在同一来源线内挑选最近两版；跨线或混合版本直接 409；
 *  - 响应回带 source_line / available_lines，前端据此展示来源线选择。
 */
@Injectable()
export class CompareService {
  private readonly stationRepo: StationRepository;
  private readonly impRepo: ImprovementRepository;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly analysis: AnalysisService,
    private readonly rules: RulesService,
    private readonly scope: TaskScopeService,
  ) {
    this.stationRepo = new StationRepository(ds);
    this.impRepo = new ImprovementRepository(ds);
  }

  /** 该工位存在要素的版本列表（降序；含来源线判定；封存版本只读可对比） */
  private async listVersionMeta(stationId: string, tenantId: string, scope: TaskScope): Promise<VersionMeta[]> {
    const qb = this.ds.getRepository(Element)
      .createQueryBuilder('e')
      .select('e.bol_version', 'v')
      .addSelect('COUNT(*)', 'total')
      .addSelect("SUM(CASE WHEN e.source = 'ai_assisted' THEN 1 ELSE 0 END)", 'ai')
      .where('e.station_id = :sid AND e.tenant_id = :tid', { sid: stationId, tid: tenantId });
    // Phase 3：版本列表也必须按任务隔离，否则会列出其它任务才有的版本
    if (scope.task_id) qb.andWhere('e.task_id = :taskId', { taskId: scope.task_id });
    const rows = (await qb
      .groupBy('e.bol_version')
      .orderBy('e.bol_version', 'DESC')
      .getRawMany()) as any[];
    return rows.map((r) => {
      const total = Number(r.total ?? 0);
      const ai = Number(r.ai ?? 0);
      const line: VersionLine = total > 0 && ai === total ? 'ai' : ai === 0 ? 'manual' : 'mixed';
      return { version: Number(r.v), element_count: total, line };
    });
  }

  private static lineLabel(line: VersionLine): string {
    if (line === 'ai') return 'AI 自动分解';
    if (line === 'manual') return '手工分解';
    return '混合来源';
  }

  private static sourceOf(meta: VersionMeta): ElementSource | undefined {
    if (meta.line === 'ai') return 'ai_assisted';
    if (meta.line === 'manual') return 'manual';
    return undefined;
  }

  private mixedError(meta: VersionMeta): never {
    throw new ConflictException({
      message: `版本 v${meta.version} 同时包含 AI 与手工要素（legacy 混合版本），不能参与来源线对比。请先在分解工作台拆分为单一来源版本。`,
      code: 'MIXED_SOURCE_VERSION',
      version: meta.version,
    });
  }

  private crossSourceError(curr: VersionMeta, prev: VersionMeta): never {
    throw new ConflictException({
      message: `AI 自动分解与手工分解是两条并行的分解线，不能作为改善前后版本对比（v${prev.version}=${CompareService.lineLabel(prev.line)}，v${curr.version}=${CompareService.lineLabel(curr.line)}）。请在同一来源线内选择两个版本。`,
      code: 'CROSS_SOURCE_COMPARE',
      prev_line: prev.line,
      curr_line: curr.line,
    });
  }

  private availableLines(versions: VersionMeta[]) {
    return (['manual', 'ai'] as const)
      .map((line) => {
        const list = versions.filter((v) => v.line === line).map((v) => v.version);
        return {
          line,
          source: line === 'ai' ? 'ai_assisted' : 'manual',
          label: CompareService.lineLabel(line),
          versions: list,
          count: list.length,
          latest_version: list[0] ?? null,
        };
      })
      .filter((x) => x.count > 0);
  }

  async compareVersions(stationId: string, query: CompareQuery = {}) {
    const station = await this.stationRepo.findOne({ station_id: stationId });
    if (!station) throw new NotFoundException(`工位 ${stationId} 不存在`);

    const scope = await this.scope.resolveCurrent(stationId, query.task_id);
    const versions = await this.listVersionMeta(stationId, station.tenant_id, scope);
    if (versions.length < 2) {
      throw new ConflictException('该工位尚无复测版本，无法对比');
    }

    const byVersion = new Map<number, VersionMeta>(versions.map((v) => [v.version, v]));
    const metaOf = (v: number): VersionMeta | undefined => byVersion.get(v);
    const lineList = (line: 'manual' | 'ai') => versions.filter((v) => v.line === line);

    const requestedSource: 'manual' | 'ai' | null =
      query.source === 'ai_assisted' ? 'ai'
        : query.source === 'manual' ? 'manual'
          : null;

    const hasV1 = query.v1 !== undefined && query.v1 !== null && String(query.v1) !== '';
    const hasV2 = query.v2 !== undefined && query.v2 !== null && String(query.v2) !== '';

    let currV: number;
    let prevV: number;

    if (hasV1 || hasV2) {
      const explicitV1 = hasV1 ? Number(query.v1) : null;
      const explicitV2 = hasV2 ? Number(query.v2) : null;

      if (explicitV1 !== null) {
        const m = metaOf(explicitV1);
        if (!m) throw new NotFoundException(`版本 v${explicitV1} 不存在`);
        if (m.line === 'mixed') this.mixedError(m);
        currV = explicitV1;
      } else {
        currV = NaN;
      }

      if (explicitV2 !== null) {
        const m = metaOf(explicitV2);
        if (!m) throw new NotFoundException(`版本 v${explicitV2} 不存在`);
        if (m.line === 'mixed') this.mixedError(m);
        prevV = explicitV2;
      } else {
        prevV = NaN;
      }

      // 只给一侧时，在它同一条来源线内补另一侧（优先相邻、方向合理）
      if (explicitV1 !== null && explicitV2 === null) {
        const m = metaOf(currV)!;
        const siblings = lineList(m.line as 'manual' | 'ai')
          .filter((v) => v.version !== currV)
          .sort((a, b) => b.version - a.version);
        const picked = siblings.find((v) => v.version < currV) ?? siblings[0];
        if (!picked) {
          throw new ConflictException({
            message: `该工位在「${CompareService.lineLabel(m.line)}」来源线只有一个版本，无法对比。`,
            code: 'SOURCE_NO_RETEST',
            source_line: m.line,
            available_lines: this.availableLines(versions),
          });
        }
        prevV = picked.version;
      } else if (explicitV2 !== null && explicitV1 === null) {
        const m = metaOf(prevV)!;
        const siblings = lineList(m.line as 'manual' | 'ai')
          .filter((v) => v.version !== prevV)
          .sort((a, b) => a.version - b.version);
        const picked = siblings.find((v) => v.version > prevV) ?? siblings[0];
        if (!picked) {
          throw new ConflictException({
            message: `该工位在「${CompareService.lineLabel(m.line)}」来源线只有一个版本，无法对比。`,
            code: 'SOURCE_NO_RETEST',
            source_line: m.line,
            available_lines: this.availableLines(versions),
          });
        }
        currV = picked.version;
      }
    } else {
      // 默认：只在同一来源线内挑最近两版；优先最新线，其次另一条线
      let selected: 'manual' | 'ai' | null = requestedSource;
      if (!selected) {
        const linesWithPair = (['ai', 'manual'] as const)
          .filter((line) => lineList(line).length >= 2)
          .sort((a, b) => {
            const ta = Math.max(...lineList(a).map((v) => v.version));
            const tb = Math.max(...lineList(b).map((v) => v.version));
            return tb - ta;
          });
        if (linesWithPair.length > 0) {
          selected = linesWithPair[0];
        } else {
          const nonMixed = versions.find((v) => v.line !== 'mixed');
          if (!nonMixed) this.mixedError(versions[0]);
          selected = nonMixed.line as 'manual' | 'ai';
        }
      }
      const list = lineList(selected);
      if (list.length < 2) {
        throw new ConflictException({
          message: `该工位在「${CompareService.lineLabel(selected)}」来源线尚无复测版本，无法对比。请在同一来源线内先完成一次复测。`,
          code: 'SOURCE_NO_RETEST',
          source_line: selected,
          available_lines: this.availableLines(versions),
        });
      }
      currV = list[0].version;
      prevV = list[1].version;
    }

    const currMeta = metaOf(currV)!;
    const prevMeta = metaOf(prevV)!;
    if (currV === prevV) {
      throw new ConflictException({ message: '当前版本与对比版本不能相同', code: 'SAME_VERSION' });
    }
    if (currMeta.line === 'mixed') this.mixedError(currMeta);
    if (prevMeta.line === 'mixed') this.mixedError(prevMeta);
    if (currMeta.line !== prevMeta.line) this.crossSourceError(currMeta, prevMeta);
    if (requestedSource && currMeta.line !== requestedSource) {
      throw new ConflictException({
        message: `所选版本不属于「${CompareService.lineLabel(requestedSource)}」来源线。`,
        code: 'SOURCE_MISMATCH',
        requested_source: requestedSource,
        actual_line: currMeta.line,
        available_lines: this.availableLines(versions),
      });
    }

    const prevAnalysis = await this.analysis.analyzeStationAtVersion(
      station, prevV, scope.task_id, CompareService.sourceOf(prevMeta),
    );
    const currAnalysis = await this.analysis.analyzeStationAtVersion(
      station, currV, scope.task_id, CompareService.sourceOf(currMeta),
    );
    const prevActive = prevAnalysis.elements.filter((el: any) => Number(el.outlier_flag) === 0);
    const currActive = currAnalysis.elements.filter((el: any) => Number(el.outlier_flag) === 0);

    // 已采纳建议引用过的要素ID（前端标注"已被建议覆盖"）；按任务隔离，避免跨任务误标
    const impWhere: Record<string, unknown> = { station_id: stationId };
    if (scope.task_id) impWhere.task_id = scope.task_id;
    const improvements = await this.impRepo.find(impWhere as any);
    const referenced = new Set<string>();
    for (const imp of improvements) {
      for (const id of String(imp.element_ids ?? '').split(',')) {
        if (id.trim()) referenced.add(id.trim());
      }
    }

    const { pairs, added, removed, pairing_rate: pairingRate } = pairElements(prevActive, currActive, referenced);

    const ctPrev = prevAnalysis.metrics.ct;
    const ctCurr = currAnalysis.metrics.ct;
    const deltaCt = round2(ctPrev - ctCurr);
    const params = getLineParams(this.rules.getActive('benefit_params').json, station.line_id);

    let benefit = null;
    if (params) {
      benefit = estimateBenefit(deltaCt, params);
    }

    return {
      station: { station_id: station.station_id, name: station.name, line_id: station.line_id, tt_s: station.tt },
      /** 本次对比所属来源线（ai / manual）；两条线不混合 */
      source_line: currMeta.line,
      available_lines: this.availableLines(versions),
      prev: {
        version: prevV, ct: ctPrev, metrics: prevAnalysis.metrics,
        element_count: prevActive.length, line: prevMeta.line,
      },
      curr: {
        version: currV, ct: ctCurr, metrics: currAnalysis.metrics,
        element_count: currActive.length, line: currMeta.line,
      },
      delta_ct: deltaCt,
      pairing_rate: pairingRate,
      pairs,
      added,
      removed,
      benefit,
      params_configured: Boolean(params),
      warnings: pairingRate < 60 ? ['前后要素配对率低于60%，建议以工位级对比（ΔCT）为准'] : [],
    };
  }

  /** 一页对比报告数据（前端 window.print 导出 PDF/PPT 截图） */
  async buildCompareReport(stationId: string, query: CompareQuery = {}) {
    const data = await this.compareVersions(stationId, query);

    const improvements = await this.impRepo.find({ station_id: stationId });
    const stats: Record<string, number> = { 待实施: 0, 进行中: 0, 已完成: 0, 已验证: 0 };
    for (const imp of improvements) stats[imp.status] = (stats[imp.status] ?? 0) + 1;
    const wasteRemoved = data.pairs
      .filter((p: any) => p.quality === 'unmatched' && /持住|延迟|寻找|检查|移物|休息/.test(p.prev.desc)).length;

    return {
      header: {
        line_id: data.station.line_id,
        station_id: data.station.station_id,
        station_name: data.station.name,
        prev_version: data.prev.version,
        curr_version: data.curr.version,
        source_line: data.source_line,
        generated_at: new Date().toISOString(),
      },
      kpi: {
        prev_ct: data.prev.ct,
        curr_ct: data.curr.ct,
        delta_ct: data.delta_ct,
        delta_pct: data.prev.ct > 0 ? round1((data.delta_ct / data.prev.ct) * 100) : 0,
        va_pct_prev: data.prev.metrics.va_pct,
        va_pct_curr: data.curr.metrics.va_pct,
        nva_pct_prev: data.prev.metrics.nva_pct,
        nva_pct_curr: data.curr.metrics.nva_pct,
        pairing_rate: data.pairing_rate,
        improvement_stats: stats,
        removed_elements: wasteRemoved,
      },
      pairs: data.pairs,
      added: data.added,
      removed: data.removed,
      benefit: data.benefit,
      warnings: data.warnings,
      signatures: ['IE工程师：', '主管抽审：', '日期：'],
    };
  }
}
