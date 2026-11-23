import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { Element } from '../../entities/element.entity';
import { Improvement } from '../../entities/improvement.entity';
import { RulesService } from '../../core/rules/rules.service';
import { StationRepository, LineRepository } from '../stations/stations.service';
import { ImprovementRepository } from '../compare/improvement.repository';
import { AnalysisService, AnalysisSource } from '../analysis/analysis.service';
import { getLineParams, estimateBenefit } from '../compare/engine';
import { buildCandidates, buildRedlineMarkers, checkRedlines } from './engine';
import { AdoptCandidatesDto, ImprovementQuery, UpdateImprovementDto } from './dto';
import { round2, today } from '../../core/shared/util';
import { StationsService } from '../stations/stations.service';
import { DataScope } from '../../auth/auth-user.interface';
import { TaskScopeService } from '../../core/task-scope/task-scope.service';
import { currentTenantId } from '../../tenant/tenant-context';

/** 四态流转合法迁移表（v3.66 P2：新增「进行中」——待实施→进行中→已完成→已验证） */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  待实施: ['进行中', '已完成'],
  进行中: ['已完成'],
  已完成: ['已验证'],
  已验证: [],
};

/** 建议书固定步骤与签署栏（MVP buildReport 常量平移） */
const REPORT_STEPS = [
  '按措施实施（IE+班长现场）',
  '现场确认一次：作业员照做/旧浪费动作消失',
  '重导SOP（带版本号）',
  '点“开始复测”并提交新分解',
  '前后对比页验证，状态置“已验证”',
];
const REPORT_SIGNATURES = ['改善责任人：', '班长确认：', 'IE主管抽审：', '日期：'];

/**
 * 改善建议服务（MVP suggestions/service.js 1:1 平移）：
 * 候选不落库（铁律①）/ 2 条红线确认后放行 / 采纳才写 t_improvement /
 * 三态流转（已验证要求存在复测版并回填 after_ct）/ 建议书一页数据。
 */
@Injectable()
export class SuggestionsService {
  private readonly stationRepo: StationRepository;
  private readonly impRepo: ImprovementRepository;
  private readonly lineRepo: LineRepository;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly analysis: AnalysisService,
    private readonly rules: RulesService,
    private readonly stations: StationsService,
    private readonly scope: TaskScopeService,
  ) {
    this.stationRepo = new StationRepository(ds);
    this.impRepo = new ImprovementRepository(ds);
    this.lineRepo = new LineRepository(ds);
  }

  /** 生成候选建议（不落库；日产量未配置时优先级按频次=1 计算并提示） */
  async generateCandidates(stationId: string, taskId?: string | null, source?: AnalysisSource) {
    const station = await this.stationRepo.findOne({ station_id: stationId });
    if (!station) throw new NotFoundException(`工位 ${stationId} 不存在`);

    const analysis = await this.analysis.analyzeStationAtVersion(station, station.version, taskId, source);
    const ecrsa = this.rules.getActive('ecrsa_map');
    const params = getLineParams(this.rules.getActive('benefit_params').json, station.line_id);
    const candidates = buildCandidates(analysis, ecrsa.json, params?.daily_output ?? null);

    return {
      station_id: station.station_id,
      station_name: station.name,
      version: station.version,
      ct: analysis.metrics.ct,
      candidates,
      freq_configured: Boolean(params),
      daily_output: params?.daily_output ?? null,
      note: params ? null : '日产量未配置：优先级按频次=1计算，配置后重算（对比页→参数设置）',
      rule_versions: { ecrsa_map: ecrsa.version },
    };
  }

  /** 采纳候选建议：红线未确认 → 422 REDLINE_CONFIRM_REQUIRED（requires 随信封透传） */
  async adoptCandidates(stationId: string, payload: AdoptCandidatesDto, explicitTaskId?: string | null) {
    const station = await this.stationRepo.findOne({ station_id: stationId });
    if (!station) throw new NotFoundException(`工位 ${stationId} 不存在`);
    // Wave2 / #106：采纳产生的改善任务写入当前分解任务（显式校验 / 自动继承 / legacy 回落）
    const taskId = (await this.scope.resolveCurrent(stationId, explicitTaskId)).task_id;

    const list = Array.isArray(payload.candidates) ? payload.candidates : [];
    if (list.length === 0) throw new BadRequestException('没有选中任何建议');

    const redline = this.rules.getActive('redline_keywords');
    const requires = checkRedlines(list, redline.json, payload.confirmations);
    if (requires.length > 0) {
      throw new UnprocessableEntityException({
        message: '红线确认未完成，暂不能采纳',
        code: 'REDLINE_CONFIRM_REQUIRED',
        requires,
      });
    }

    const markers = buildRedlineMarkers(payload.confirmations);
    const created = await this.impRepo.transaction(async (mgr) => {
      const ids: string[] = [];
      const batch = Date.now();
      for (let i = 0; i < list.length; i += 1) {
        const c = list[i];
        const impId = `IMP-${stationId}-${batch}-${String(i + 1).padStart(2, '0')}`;
        const measure = `${String(c.measure)}${markers.length > 0 ? ` ${markers.join(' ')}` : ''}`.slice(0, 300);
        const row = mgr.create(Improvement, {
          imp_id: impId,
          tenant_id: station.tenant_id,
          station_id: stationId,
          task_id: taskId,
          element_ids: (c.element_ids ?? []).join(','),
          waste_type: c.waste_type,
          method: c.method,
          measure,
          est_save_s: Number(c.est_save_s) || 0,
          priority: Number(c.priority) || 0,
          status: '待实施',
          owner: c.owner ?? null,
          due: c.due ? new Date(c.due) : null,
          before_ct: station.ct ?? null,
          after_ct: null,
        } as any);
        await mgr.save(row);
        ids.push(impId);
      }
      return ids;
    });

    return { station_id: stationId, created: created.length, imp_ids: created };
  }

  /**
   * v3.55 资源级写权校验（改善任务状态流转）。
   * 按任务所属工位反查 → 走 StationsService.assertWritable。
   * 此前只受 RBAC「suggestion:status」保护，同租户任意用户可改他人工位任务状态。
   */
  async assertImprovementWritable(impId: string, userId: string, roles: string[]): Promise<void> {
    const imp = await this.impRepo.findOne({ imp_id: impId });
    if (!imp) throw new NotFoundException(`改善建议 ${impId} 不存在`);
    await this.stations.assertWritable(imp.station_id, userId, roles);
  }

  /**
   * v3.55 资源级读权校验（改善任务建议书）。
   * 按任务所属工位反查 → 走 StationsService.assertReadable。
   */
  async assertImprovementReadable(impId: string, userId: string, roles: string[], scope: DataScope = 'own'): Promise<void> {
    const imp = await this.impRepo.findOne({ imp_id: impId });
    if (!imp) throw new NotFoundException(`改善建议 ${impId} 不存在`);
    await this.stations.assertReadable(imp.station_id, userId, roles, scope);
  }

  /**
   * 建议清单（JOIN 工位信息；支持 station_id/status/line_id/project_type/process/product_type 过滤；优先级降序）。
   * project_type 为任务直查维度；process/product_type 经 t_line 元数据内存过滤（BaseRepository 已限定当前租户）。
   * VO 附带产线/公司/区域展示维度，契约与 GET /dashboard/improvements 一致（v3.3）。
   *
   * v3.55：visibleStationIds 收口——只返回调用者可见工位的改善任务。
   * （此前租户内任意用户可见全部任务，含他人工位的措施/节省秒数/状态）
   */
  async listImprovements(query: ImprovementQuery = {}, visibleStationIds: string[] | null = null) {
    const where: Record<string, unknown> = {};
    if (query.station_id) where.station_id = query.station_id;
    // Wave2 / #106：?task_id= 按任务过滤；不传时逐字保持原有行为（dashboard / 报表调用零变化）
    if (query.task_id) where.task_id = query.task_id;
    if (query.status) where.status = query.status;
    if (query.project_type) where.project_type = query.project_type;
    if (query.line_id) where.station = { line_id: query.line_id };
    let rows = await this.impRepo.find(where, {
      order: { priority: 'DESC', created_at: 'DESC' },
      relations: ['station'],
    });
    // v3.55：可见工位收口（非全权角色）
    if (visibleStationIds) {
      const allow = new Set(visibleStationIds);
      rows = rows.filter((r) => allow.has(r.station_id));
    }
    // 工艺/产品类型过滤 + 展示维度（t_line 元数据，租户内）
    const dims = new Map((await this.lineRepo.find({})).map((l) => [l.line_id, l]));
    if (query.process) rows = rows.filter((r) => dims.get(r.station?.line_id ?? '')?.process_type === query.process);
    if (query.product_type) rows = rows.filter((r) => dims.get(r.station?.line_id ?? '')?.product_type === query.product_type);
    // 公司/区域元数据（显式 In 限定返回行涉及的租户，无上下文时也安全）
    const tenantIds = [...new Set(rows.map((r) => r.tenant_id))];
    const tenantRows = tenantIds.length > 0
      ? ((await this.ds.getRepository('t_tenant').find({ where: { tenant_id: In(tenantIds) } })) as any[])
      : [];
    const tenants = new Map(tenantRows.map((t) => [t.tenant_id as string, t]));
    const elementMeta = await this.loadElementMeta(rows);
    return { improvements: rows.map((r) => this.toVo(r, dims, tenants, elementMeta)) };
  }

  /** 改善任务 → 涉及要素的来源线/版本（不新增列：按 element_ids 反查 t_element） */
  private async loadElementMeta(rows: Improvement[]): Promise<Map<string, { source: string; bol_version: number }>> {
    const ids = [...new Set(rows.flatMap((r) => String(r.element_ids ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean)))];
    if (ids.length === 0) return new Map();
    const where: Record<string, unknown> = { element_id: In(ids) };
    const tenantId = currentTenantId();
    if (tenantId) where.tenant_id = tenantId;
    const elements = await this.ds.getRepository(Element).find({ where } as any);
    return new Map(elements.map((e) => [
      e.element_id,
      { source: String(e.source ?? 'manual'), bol_version: Number(e.bol_version) },
    ]));
  }

  /** 单条任务的来源线/版本：混合或缺失时返回 null，前端显示“—” */
  private elementMetaOf(
    elementIds: string,
    meta: Map<string, { source: string; bol_version: number }>,
  ): { element_source: string | null; bol_version: number | null } {
    const ids = String(elementIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const sources = new Set<string>();
    const versions = new Set<number>();
    for (const id of ids) {
      const m = meta.get(id);
      if (!m) continue;
      sources.add(m.source);
      versions.add(m.bol_version);
    }
    return {
      element_source: sources.size === 1 ? [...sources][0] : sources.size > 1 ? 'mixed' : null,
      bol_version: versions.size === 1 ? [...versions][0] : null,
    };
  }

  /** 三态流转：已验证要求存在复测版本（≥2 个 bol_version）并回填 after_ct=当前版CT */
  async updateStatus(impId: string, status: string, taskId?: string | null) {
    const imp = await this.impRepo.findOne({ imp_id: impId });
    if (!imp) throw new NotFoundException(`改善建议 ${impId} 不存在`);
    const patch = await this.statusPatch(imp, status, taskId);
    await this.impRepo.update({ imp_id: impId }, patch);
    const updated = await this.impRepo.findOne({ imp_id: impId });
    return this.toVo(updated as Improvement);
  }

  /** 唯一状态机入口：校验迁移合法 + 附带字段（已完成记实际完成时间；已验证要求复测并回填 after_ct） */
  private assertTransition(from: string, to: string) {
    const allowed = ALLOWED_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new ConflictException({
        message: `状态不能从「${from}」直接变为「${to}」`,
        allowed,
      });
    }
  }

  private async statusPatch(imp: Improvement, status: string, taskId?: string | null): Promise<Record<string, any>> {
    this.assertTransition(imp.status, status);
    const patch: Record<string, any> = { status, status_changed_at: new Date() };
    if (status === '已完成') patch.actual_completed_at = new Date();
    if (status === '已验证') {
      const station = await this.stationRepo.findOne({ station_id: imp.station_id });
      if (!station) throw new NotFoundException(`工位 ${imp.station_id} 不存在`);
      const scope = await this.scope.resolveCurrent(imp.station_id, taskId);
      const versionQb = this.ds.getRepository(Element)
        .createQueryBuilder('e')
        .select('COUNT(DISTINCT e.bol_version)', 'c')
        .where('e.station_id = :sid AND e.tenant_id = :tid', { sid: imp.station_id, tid: station.tenant_id });
      if (scope.task_id) versionQb.andWhere('e.task_id = :taskId', { taskId: scope.task_id });
      const versionRow = await versionQb.getRawOne();
      const versions = Number(versionRow?.c ?? 0);
      if (versions < 2) {
        throw new ConflictException({
          message: '尚未复测（不存在v(n+1)），不能置为已验证',
          hint: '先在该工位点“开始复测”并提交复测分解',
        });
      }
      const ctQb = this.ds.getRepository(Element)
        .createQueryBuilder('e')
        .select('COALESCE(SUM(e.std_time), 0)', 'ct')
        .where('e.station_id = :sid AND e.bol_version = :ver AND e.outlier_flag = 0 AND e.tenant_id = :tid',
          { sid: imp.station_id, ver: station.version, tid: station.tenant_id });
      if (scope.task_id) ctQb.andWhere('e.task_id = :taskId', { taskId: scope.task_id });
      const ctAgg = await ctQb.getRawOne();
      patch.after_ct = round2(Number(ctAgg?.ct ?? 0));
    }
    return patch;
  }

  /** v3.66 P2：编辑改善任务——责任人/截止/实际措施/状态（状态走同一状态机） */
  async updateImprovement(impId: string, body: UpdateImprovementDto, taskId?: string | null) {
    const imp = await this.impRepo.findOne({ imp_id: impId });
    if (!imp) throw new NotFoundException(`改善建议 ${impId} 不存在`);

    const patch: any = {};
    if (body.owner !== undefined) patch.owner = body.owner;
    if (body.due !== undefined) patch.due = body.due ? new Date(body.due) : null;
    if (body.actual_measure !== undefined) patch.actual_measure = body.actual_measure;
    if (body.status !== undefined && body.status !== imp.status) {
      Object.assign(patch, await this.statusPatch(imp, body.status, taskId));
    }
    if (Object.keys(patch).length > 0) await this.impRepo.update({ imp_id: impId }, patch);
    const updated = await this.impRepo.findOne({ imp_id: impId });
    return this.toVo(updated as Improvement);
  }

  /** 建议书一页数据（前端 window.print 导出） */
  async buildReport(impId: string, operator: string) {
    const imp = await this.impRepo.findOne({ imp_id: impId });
    if (!imp) throw new NotFoundException(`改善建议 ${impId} 不存在`);
    const station = await this.stationRepo.findOne({ station_id: imp.station_id });
    if (!station) throw new NotFoundException(`工位 ${imp.station_id} 不存在`);

    // 涉及要素按 element_id 解析（不按当前版本指针）：建议引用的是"提改进时的版本"，
    // 复测后版本指针前移，所引用要素仍须可在建议书中展示（MVP 同口径）。
    const ids = String(imp.element_ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    let involved: { seq: number; type: string; desc: string; std_time: number; va_class: string; source: string; bol_version: number }[] = [];
    if (ids.length > 0) {
      /* [task-scope:compat] 建议书按创建时记录的 element_id 精确取回（不是任务范围枚举），
         存量引用可能跨任务；t_improvement.task_id 归属属 #106，本轮不改写引用关系。 */
      const rows = await this.ds.getRepository(Element).find({
        where: { element_id: In(ids), tenant_id: station.tenant_id },
      });
      const byId = new Map(rows.map((r) => [r.element_id, r]));
      involved = ids.map((id) => byId.get(id)).filter(Boolean)
        .map((el) => ({
          seq: el.seq, type: el.type, desc: el.desc, std_time: Number(el.std_time),
          va_class: el.va_class, source: String(el.source ?? 'manual'), bol_version: Number(el.bol_version),
        }));
    }

    const params = getLineParams(this.rules.getActive('benefit_params').json, station.line_id);
    const estSave = Number(imp.est_save_s);
    const annual = params && estSave > 0
      ? (estimateBenefit(estSave, params).annual_yuan as number)
      : null;

    const srcs = new Set(involved.map((i) => i.source));
    const vers = new Set(involved.map((i) => i.bol_version));
    const provenance = {
      source: imp.source ?? null,
      element_source: srcs.size === 1 ? [...srcs][0] : srcs.size > 1 ? 'mixed' : null,
      bol_version: vers.size === 1 ? [...vers][0] : null,
      task_id: imp.task_id ?? null,
    };

    return {
      header: {
        station_id: station.station_id,
        station_name: station.name,
        line_id: station.line_id,
        version: station.version,
        imp_id: imp.imp_id,
        generated_at: new Date().toISOString(),
        generated_by: operator || 'IE',
      },
      problem: { waste_type: imp.waste_type, measure: imp.measure, involved, provenance },
      benefit: {
        est_save_s: estSave,
        annual_yuan: annual,
        before_ct: imp.before_ct === null ? null : Number(imp.before_ct),
        after_ct: imp.after_ct === null ? null : Number(imp.after_ct),
        params_configured: Boolean(params),
        formula: '节省秒数×日产量×365×费率(元/工时)÷3600×落地率',
      },
      steps: REPORT_STEPS,
      status: imp.status,
      signatures: REPORT_SIGNATURES,
    };
  }

  /**
   * 实体 → 响应 VO（decimal 列统一转 number）。
   * dims/tenants 为产线与公司元数据（可选）：清单/集团任务列表注入展示维度；
   * 单条流转等场景不传时维度字段为 null（前端按需兜底）。
   */
  private toVo(
    r: Improvement,
    dims?: Map<string, any>,
    tenants?: Map<string, any>,
    elementMeta?: Map<string, { source: string; bol_version: number }>,
  ) {
    const line = r.station ? dims?.get(r.station.line_id) : undefined;
    const tenant = tenants?.get(r.tenant_id);
    const meta = elementMeta ? this.elementMetaOf(r.element_ids, elementMeta) : { element_source: null, bol_version: null };
    return {
      imp_id: r.imp_id,
      station_id: r.station_id,
      /** Wave2 / #106：归属分解任务（兼容模式为 null，不冒充任务号） */
      task_id: r.task_id ?? null,
      /** 建议来源（rule / ai / manual）；元素级来源线见 element_source */
      source: r.source ?? null,
      element_source: meta.element_source,
      bol_version: meta.bol_version,
      element_ids: r.element_ids,
      waste_type: r.waste_type,
      method: r.method,
      measure: r.measure,
      est_save_s: Number(r.est_save_s),
      priority: r.priority,
      status: r.status,
      project_type: r.project_type,
      owner: r.owner,
      due: r.due,
      before_ct: r.before_ct === null ? null : Number(r.before_ct),
      after_ct: r.after_ct === null ? null : Number(r.after_ct),
      created_at: r.created_at,
      station_name: r.station?.name ?? null,
      station_version: r.station?.version ?? null,
      line_id: r.station?.line_id ?? null,
      line_name: line?.name ?? null,
      process_type: line?.process_type ?? null,
      product_type: line?.product_type ?? null,
      product_project: line?.product_project ?? null,
      tenant_id: r.tenant_id,
      company: tenant?.name ?? null,
      region: tenant?.region ?? null,
    };
  }
}
