import { InjectDataSource } from '@nestjs/typeorm';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RulesService } from '../../core/rules/rules.service';
import { StationRepository } from '../stations/stations.service';
import { ElementRepository } from '../elements/element.repository';
import { analyzeStation, buildLineAnalysis } from './engine';
import { TaskScopeService } from '../../core/task-scope/task-scope.service';
import { scopeMarker, withTask } from '../../core/task-scope/task-scope';

export type AnalysisSource = 'manual' | 'ai_assisted';

/**
 * 来源线过滤：manual 兼容历史 null/空来源（按手工处理），ai_assisted 精确匹配。
 * 与 source_counts 的口径保持一致。
 */
export function filterBySource<T extends { source?: string | null }>(elements: T[], source?: AnalysisSource): T[] {
  if (!source) return elements;
  if (source === 'manual') return elements.filter((el) => el.source !== 'ai_assisted');
  return elements.filter((el) => el.source === 'ai_assisted');
}

/**
 * 分析服务：加载（租户隔离）→ 引擎计算（纯函数）→ 组装响应。
 * 规则版本随响应带回（va_rules / waste_triggers 的 RV 号），保证结论可追溯。
 *
 * v3.67 来源线隔离：可选 source 过滤，AI 分解与手工分解分别分析、分别出结论；
 * 响应回带 element_source / source_counts，下游措施据此带上溯源依据。
 */
@Injectable()
export class AnalysisService {
  private readonly stationRepo: StationRepository;
  private readonly elementRepo: ElementRepository;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rules: RulesService,
    private readonly scope: TaskScopeService,
  ) {
    this.stationRepo = new StationRepository(ds);
    this.elementRepo = new ElementRepository(ds);
  }

  /** 单工位分析（VA 归类 + 6 类浪费 + 双手图 + 待复核/异常清单） */
  async analyzeStation(stationId: string, taskId?: string | null, source?: AnalysisSource) {
    const station = await this.stationRepo.findOne({ station_id: stationId });
    if (!station) throw new NotFoundException(`工位 ${stationId} 不存在`);
    const scope = await this.scope.resolveCurrent(stationId, taskId);
    const allElements = await this.elementRepo.find(
      withTask({ station_id: stationId, bol_version: station.version }, scope),
      { order: { seq: 'ASC' } },
    );
    const sourceCounts = {
      manual: allElements.filter((el: any) => el.source !== 'ai_assisted').length,
      ai_assisted: allElements.filter((el: any) => el.source === 'ai_assisted').length,
    };
    const elements = filterBySource(allElements, source);
    const vaRules = this.rules.getActive('va_rules');
    const wasteRules = this.rules.getActive('waste_triggers');
    const result = analyzeStation(station, elements, vaRules.json, wasteRules.json);
    return {
      ...result,
      detail: this.buildMotionDetail(result.elements, result.wastes),
      element_source: source ?? 'all',
      source_counts: sourceCounts,
      rule_versions: { va_rules: vaRules.version, waste_triggers: wasteRules.version },
      task_scope: scopeMarker(scope),
    };
  }

  /**
   * 动作分析明细（v3.48；与「Motion analysis_改善建议.xlsx · 动作分析-VA」同构）：
   * 每个生效要素一行——seq / ST / 作业内容 / VA 分类 / 浪费类型 / 改善方向。
   *
   * 口径（纯规则，零 LLM）：
   *  - 浪费类型 = waste_triggers 命中该要素的 waste 名（要素级 + 工位级聚合并集）；
   *  - 改善方向 = ecrsa_map 中该 waste 的 measure 模板（按 waste 去重、保序）。
   * LLM 生成的个性化浪费证据与问题清单在「浪费识别 / AI 建议」两个独立模块页呈现——
   * 本表不跨模块合并数据（双模块边界铁律），只做规则口径的全要素总览。
   */
  private buildMotionDetail(classified: any[], wastes: any[]) {
    const measuresByWaste = new Map<string, string[]>();
    try {
      const ecrsa = this.rules.getActive('ecrsa_map').json;
      for (const m of ecrsa?.mappings ?? []) {
        if (!m?.waste || !m?.measure) continue;
        const list = measuresByWaste.get(m.waste) ?? [];
        if (!list.includes(m.measure)) list.push(m.measure);
        measuresByWaste.set(m.waste, list);
      }
    } catch { /* 规则缺失时仅展示浪费类型，改善方向列留空——不阻断分析 */ }
    return classified
      .filter((el) => Number(el.outlier_flag) === 0)
      .sort((a: any, b: any) => Number(a.seq) - Number(b.seq))
      .map((el: any) => {
        const hits = wastes.filter((w: any) => w.element_ids.includes(el.element_id));
        // 同名浪费可能被多个触发器命中（如 WT13 要素级 + WT14 工位级）→ 去重保序
        const wasteTypes = [...new Set(hits.map((w: any) => w.waste as string))];
        const directions = [...new Set(hits.flatMap((w: any) => measuresByWaste.get(w.waste) ?? []))];
        return {
          element_id: el.element_id,
          seq: Number(el.seq),
          type: el.type,
          desc: el.desc,
          va_class: el.va_effective,
          std_time: Number(el.std_time),
          waste_types: wasteTypes,
          directions,
        };
      });
  }

  /** 指定版本工位分析（compare 模块用：对比任意两版；封存版本同样可分析——只读） */
  async analyzeStationAtVersion(station: any, version: number, taskId?: string | null, source?: AnalysisSource) {
    const scope = await this.scope.resolveCurrent(station.station_id, taskId);
    const allElements = await this.elementRepo.find(
      withTask({ station_id: station.station_id, bol_version: version }, scope),
      { order: { seq: 'ASC' } },
    );
    const sourceCounts = {
      manual: allElements.filter((el: any) => el.source !== 'ai_assisted').length,
      ai_assisted: allElements.filter((el: any) => el.source === 'ai_assisted').length,
    };
    const elements = filterBySource(allElements, source);
    const vaRules = this.rules.getActive('va_rules');
    const wasteRules = this.rules.getActive('waste_triggers');
    const result = analyzeStation(station, elements, vaRules.json, wasteRules.json);
    return { ...result, element_source: source ?? 'all', source_counts: sourceCounts };
  }

  /**
   * 产线分析（山积图行 + 平衡率 + 瓶颈榜 Top5）
   *
   * v3.55：visibleStationIds 收口——产线级分析会返回整条线所有工位的 CT/VA/浪费明细，
   * 这是「进示例装配线看别人结果」的主要入口。传入可见工位集合后，
   * **在引擎计算之前**过滤（不是计算完再筛行），否则 balance_rate/totals/bottleneck
   * 仍是全线的聚合值，等于换个姿势泄露。visibleStationIds=null/undefined → 不限制。
   */
  async analyzeLine(lineId: string, visibleStationIds?: string[] | null, taskId?: string | null, source?: AnalysisSource) {
    // 产线级聚合：按产线解析一次任务上下文，避免逐工位解析出现口径漂移
    const scope = await this.scope.resolveForLineCurrent(lineId, taskId);
    let stations = await this.stationRepo.find({ line_id: lineId }, { order: { station_id: 'ASC' } });
    if (stations.length === 0) throw new NotFoundException(`产线 ${lineId} 不存在或无工位`);
    if (visibleStationIds) {
      const allow = new Set(visibleStationIds);
      stations = stations.filter((s) => allow.has(s.station_id));
      if (stations.length === 0) throw new NotFoundException(`产线 ${lineId} 不在你的可见范围`);
    }
    const rows: { station: any; elements: any[] }[] = [];
    for (const station of stations) {
      const all = await this.elementRepo.find(
        withTask({ station_id: station.station_id, bol_version: station.version }, scope),
        { order: { seq: 'ASC' } },
      );
      const elements = filterBySource(all, source);
      // 来源线过滤后无要素的工位不参与产线聚合，避免用空行拉低平衡率
      if (source && elements.length === 0) continue;
      rows.push({ station, elements });
    }
    if (rows.length === 0) {
      throw new NotFoundException(`产线 ${lineId} 在「${source === 'ai_assisted' ? 'AI 自动分解' : '手工分解'}」来源线下没有要素`);
    }
    const vaRules = this.rules.getActive('va_rules');
    const wasteRules = this.rules.getActive('waste_triggers');
    const result = buildLineAnalysis(lineId, rows, vaRules.json, wasteRules.json);
    // v3.3 enrich：产线元数据（名称/工艺/产品/区域/公司）——驾驶舱页头与摘要面板展示
    const meta = await this.lineMeta(lineId, stations[0]?.tenant_id);
    return {
      ...result,
      ...meta,
      element_source: source ?? 'all',
      rule_versions: { va_rules: vaRules.version, waste_triggers: wasteRules.version },
    };
  }

  /** 产线元数据（t_line + t_tenant join；无记录时降级为 lineId 本身） */
  private async lineMeta(lineId: string, tenantId?: string) {
    const empty = { line_name: lineId, process_type: null, product_type: null, product_project: null, region: null, company: null };
    if (!tenantId) return empty;
    const line = (await this.ds.getRepository('t_line').findOneBy({ tenant_id: tenantId, line_id: lineId } as any)) as any;
    if (!line) return empty;
    const tenant = (await this.ds.getRepository('t_tenant').findOneBy({ tenant_id: tenantId } as any)) as any;
    return {
      line_name: line.name ?? lineId,
      process_type: line.process_type ?? null,
      product_type: line.product_type ?? null,
      product_project: line.product_project ?? null,
      region: tenant?.region ?? null,
      company: tenant?.name ?? null,
    };
  }
}
