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

export interface CompareQuery {
  v1?: number | string;
  v2?: number | string;
}

/**
 * 对比服务（MVP compare/service.js 1:1 平移）：
 * 三层配对 + ΔCT 权威口径 + 收益估算（参数未配置即阻断）。
 * 规则：仅对比存在的两个版本，默认最近两版（v(n) vs v(n+1)）。
 */
@Injectable()
export class CompareService {
  private readonly stationRepo: StationRepository;
  private readonly impRepo: ImprovementRepository;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly analysis: AnalysisService,
    private readonly rules: RulesService,
  ) {
    this.stationRepo = new StationRepository(ds);
    this.impRepo = new ImprovementRepository(ds);
  }

  /** 该工位存在要素的版本列表（降序；封存版本只读可对比） */
  private async listVersions(stationId: string, tenantId: string): Promise<number[]> {
    const rows = (await this.ds.getRepository(Element)
      .createQueryBuilder('e')
      .select('DISTINCT e.bol_version', 'v')
      .where('e.station_id = :sid AND e.tenant_id = :tid', { sid: stationId, tid: tenantId })
      .orderBy('e.bol_version', 'DESC')
      .getRawMany()) as any[];
    return rows.map((r) => Number(r.v));
  }

  async compareVersions(stationId: string, query: CompareQuery = {}) {
    const station = await this.stationRepo.findOne({ station_id: stationId });
    if (!station) throw new NotFoundException(`工位 ${stationId} 不存在`);

    const versions = await this.listVersions(stationId, station.tenant_id);
    if (versions.length < 2) {
      throw new ConflictException('该工位尚无复测版本，无法对比');
    }
    const currV = Number(query.v1 ?? versions[0]);
    const prevV = Number(query.v2 ?? versions[1]);
    if (!versions.includes(prevV) || !versions.includes(currV)) {
      throw new NotFoundException(`版本 ${prevV}/${currV} 不存在`);
    }

    const prevAnalysis = await this.analysis.analyzeStationAtVersion(station, prevV);
    const currAnalysis = await this.analysis.analyzeStationAtVersion(station, currV);
    const prevActive = prevAnalysis.elements.filter((el: any) => Number(el.outlier_flag) === 0);
    const currActive = currAnalysis.elements.filter((el: any) => Number(el.outlier_flag) === 0);

    // 已采纳建议引用过的要素ID（前端标注"已被建议覆盖"）
    const improvements = await this.impRepo.find({ station_id: stationId });
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
      prev: { version: prevV, ct: ctPrev, metrics: prevAnalysis.metrics, element_count: prevActive.length },
      curr: { version: currV, ct: ctCurr, metrics: currAnalysis.metrics, element_count: currActive.length },
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
    const stats: Record<string, number> = { 待实施: 0, 已完成: 0, 已验证: 0 };
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
