import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { RulesService } from '../../core/rules/rules.service';
import { analyzeStation } from '../analysis/engine';
import { round1, round2 } from '../../core/shared/util';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { CurrentUser } from '../../rbac/current-user.decorator';
import { AuthUser } from '../../auth/auth-user.interface';
import { DataScope } from '../../auth/auth-user.interface';
import { Line } from '../../entities/line.entity';
import { StationsService } from '../stations/stations.service';

/** 工艺类型标准枚举（与前端下拉一致；新增需同步前端 constants） */
const PROCESS_TYPES = ['装配', '注塑', '冲压', 'SMT', '焊接', '包装', '测试', '其他'];

class CreateLineDto {
  @IsString() @Matches(/^L\d{2}$/, { message: '产线编码须为 L01 形式（L + 两位数字）' })
  line_id!: string;
  @IsString() @MaxLength(64) name!: string;
  @IsOptional() @IsIn(PROCESS_TYPES, { message: `工艺类型须为：${PROCESS_TYPES.join('/')}` }) process_type?: string;
  @IsOptional() @IsString() @MaxLength(64) product_type?: string;
  @IsOptional() @IsString() @MaxLength(64) project_id?: string;
}

class PatchLineDto {
  @IsOptional() @IsString() @MaxLength(64) name?: string;
  @IsOptional() @IsIn(PROCESS_TYPES, { message: `工艺类型须为：${PROCESS_TYPES.join('/')}` }) process_type?: string;
  @IsOptional() @IsString() @MaxLength(64) product_type?: string;
  @IsOptional() @IsString() @MaxLength(64) project_id?: string;
}


export interface LineSummaryRow {
  line_id: string;
  line_name: string;
  process_type: string | null;
  product_type: string | null;
  product_project: string | null;
  station_count: number;
  decomposed_count: number;
  retested_count: number;
  balance_rate: number;
  va_pct: number;
  bottleneck_count: number;
  imp_pending: number;
  updated_at: Date | null;
}

/**
 * 产线概览（租户内，左侧对象树的唯一数据源）。
 * 设计目的：导航层需要「产线名称 + 一条状态」即可，不必为每条线各发一次 lineAnalysis；
 * 只返回聚合值（计数/均值），不含任何要素明细。
 * 权限：station:read（所有角色都有导航权）；租户范围由登录态 tenant_id 显式限定。
 */
@Controller('lines')
export class LinesController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rules: RulesService,
    private readonly stations: StationsService,
  ) {}

  /**
   * 产线概览（v3.55：按可见工位收口）。
   * 此前只按租户过滤 → 同租户任意用户可见全部产线的平衡率/VA%/工位数，
   * 等于把别人的分析结果摊开。现只统计调用者可见的工位；
   * 完全没有可见工位的产线不出现在列表中（不泄露产线存在性）。
   */
  @Get('summary')
  @RequirePermission('station:read')
  async summary(@CurrentUser() user: AuthUser) {
    return this.build(user.tenantId, user.userId, user.roles, user.dataScope);
  }

  /**
   * 轻量产线清单（新建分析对象向导的数据源）：编码/名称/工艺/产品/项目 + 工位数。
   * 与 /lines/summary 的区别：不算分析指标，纯主数据 + 计数，供下拉选择。
   *
   * v3.55：产线主数据保留可见（新建工位向导需选产线），但 station_count 按可见工位统计，
   * 避免通过计数反推他人工位规模。
   */
  @Get()
  @RequirePermission('station:read')
  async list(@CurrentUser() user: AuthUser) {
    const lineRepo = this.ds.getRepository(Line);
    const [lines, stations, projects] = await Promise.all([
      lineRepo.find({ where: { tenant_id: user.tenantId } as any, order: { line_id: 'ASC' } as any }) as Promise<any[]>,
      this.ds.getRepository('t_station').find({ where: { tenant_id: user.tenantId } as any }) as Promise<any[]>,
      this.ds.getRepository('t_project').find({ where: { tenant_id: user.tenantId } as any }) as Promise<any[]>,
    ]);
    let visible = stations;
    const visibleIds = await this.stations.visibleStationIds(user.userId, user.roles, user.tenantId, user.dataScope);
    if (visibleIds !== null) {
      const allow = new Set(visibleIds);
      visible = stations.filter((s) => allow.has(s.station_id));
    }
    const countByLine = new Map<string, number>();
    for (const s of visible) countByLine.set(s.line_id, (countByLine.get(s.line_id) ?? 0) + 1);
    const projectName = new Map<string, string>(projects.map((p) => [p.project_id, p.name]));
    return lines.map((l) => ({
      line_id: l.line_id,
      name: l.name,
      process_type: l.process_type,
      product_type: l.product_type,
      project_id: l.product_project === '-' ? '' : l.product_project,
      project_name: projectName.get(l.product_project) ?? null,
      station_count: countByLine.get(l.line_id) ?? 0,
    }));
  }

  /** 修改产线属性（向导里给已有产线补项目/工艺；后续也可用于产线维护） */
  @Patch(':lineId')
  @RequirePermission('station:write')
  async patch(@Param('lineId') lineId: string, @Body() dto: PatchLineDto, @CurrentUser() user: AuthUser) {
    const repo = this.ds.getRepository(Line);
    const row = (await repo.findOneBy({ tenant_id: user.tenantId, line_id: lineId } as any)) as any;
    if (!row) throw new NotFoundException(`产线 ${lineId} 不存在`);
    const next: any = { ...row };
    if (dto.name !== undefined) next.name = dto.name;
    if (dto.process_type !== undefined) next.process_type = dto.process_type;
    if (dto.product_type !== undefined) next.product_type = dto.product_type;
    if (dto.project_id !== undefined) next.product_project = dto.project_id.trim() || '-';
    await repo.save(next as any);
    return { line_id: lineId, name: next.name, process_type: next.process_type, product_type: next.product_type, project_id: next.product_project };
  }

  /** 新建产线（向导内联）：编码在前端按"下一个可用 Lxx"建议，后端做唯一性与格式校验 */
  @Post()
  @RequirePermission('station:write')
  async create(@Body() dto: CreateLineDto, @CurrentUser() user: AuthUser) {
    const repo = this.ds.getRepository(Line);
    const exists = await repo.countBy({ tenant_id: user.tenantId, line_id: dto.line_id } as any);
    if (exists > 0) {
      const row = (await repo.findOneBy({ tenant_id: user.tenantId, line_id: dto.line_id } as any)) as any;
      return { line_id: row.line_id, name: row.name, existed: true };
    }
    const row = repo.create({
      tenant_id: user.tenantId,
      line_id: dto.line_id,
      name: dto.name,
      process_type: dto.process_type ?? '装配',
      product_type: dto.product_type ?? '待补充',
      product_project: dto.project_id?.trim() || '-',
    } as any);
    await repo.save(row as any);
    return { line_id: dto.line_id, name: dto.name, existed: false };
  }

  /**
   * 删除产线（v3.21 主数据维护页）。
   * 护栏：产线下还有工位时拒绝——工位是分解数据的载体，删线会让工位变成"挂空线"的孤儿，
   * 必须先删/迁走工位（页面提示数量），避免误触造成数据悬挂。
   */
  @Delete(':lineId')
  @RequirePermission('station:write')
  async remove(@Param('lineId') lineId: string, @CurrentUser() user: AuthUser) {
    const repo = this.ds.getRepository(Line);
    const row = (await repo.findOneBy({ tenant_id: user.tenantId, line_id: lineId } as any)) as any;
    if (!row) throw new NotFoundException(`产线 ${lineId} 不存在`);
    const stationCount = await this.ds.getRepository('t_station').countBy({ tenant_id: user.tenantId, line_id: lineId } as any);
    if (stationCount > 0) {
      throw new BadRequestException(`产线 ${lineId} 下还有 ${stationCount} 个工位，请先在工位维护中删除或迁走工位`);
    }
    await repo.delete({ tenant_id: user.tenantId, line_id: lineId } as any);
    return { line_id: lineId, deleted: true };
  }

  /**
   * 产线概览构建（v3.55：按可见工位收口）。
   * userId/roles/scope 传入时，只统计调用者可见的工位——
   * 产线的平衡率/VA%/工位数等指标全部基于可见工位重算，不泄露他人工位分析结果。
   */
  private async build(tenantId: string, userId?: string, roles?: string[], scope: DataScope = 'own') {
    const stationRepo = this.ds.getRepository('t_station');
    const elementRepo = this.ds.getRepository('t_element');
    const lineRepo = this.ds.getRepository('t_line');
    const impRepo = this.ds.getRepository('t_improvement');
    const tenantRepo = this.ds.getRepository('t_tenant');

    const tenant = (await tenantRepo.findOneBy({ tenant_id: tenantId } as any)) as any;
    let stations = (await stationRepo.find({ where: { tenant_id: tenantId }, order: { station_id: 'ASC' } })) as any[];
    // v3.55：可见范围收口（非全权角色）
    if (userId && roles) {
      const visibleIds = await this.stations.visibleStationIds(userId, roles, tenantId, scope);
      if (visibleIds !== null) {
        const allow = new Set(visibleIds);
        stations = stations.filter((s) => allow.has(s.station_id));
      }
    }
    if (stations.length === 0) {
      return { company: tenant?.name ?? tenantId, region: tenant?.region ?? null, lines: [] as LineSummaryRow[] };
    }

    const [lines, elements, imps] = await Promise.all([
      lineRepo.find({ where: { tenant_id: tenantId } }) as Promise<any[]>,
      elementRepo.find({ where: { station_id: In(stations.map((s) => s.station_id)) } }) as Promise<any[]>,
      impRepo.find({ where: { tenant_id: tenantId, status: '待实施' } }) as Promise<any[]>,
    ]);
    const lineMeta = new Map(lines.map((l) => [l.line_id as string, l]));
    const elByStation = new Map<string, any[]>();
    for (const e of elements) {
      const arr = elByStation.get(e.station_id) ?? [];
      arr.push(e);
      elByStation.set(e.station_id, arr);
    }

    const vaRules = this.rules.getActive('va_rules');
    const wasteRules = this.rules.getActive('waste_triggers');
    const pendingByStation = new Map<string, number>();
    for (const i of imps) pendingByStation.set(i.station_id, (pendingByStation.get(i.station_id) ?? 0) + 1);

    interface Agg {
      ct_sum: number; va_sum: number; max_ct: number; n: number;
      decomposed: number; retested: number; bottleneck: number; imp_pending: number;
      updated_at: Date | null;
    }
    const agg = new Map<string, Agg>();
    let globalMaxCt = 0;
    const perStation: { line: string; ct: number }[] = [];

    for (const s of stations) {
      const els = (elByStation.get(s.station_id) ?? []).filter((e) => Number(e.bol_version) === Number(s.version));
      const a = analyzeStation(s, els, vaRules.json, wasteRules.json);
      const ct = a.metrics.ct;
      const cur = agg.get(s.line_id) ?? {
        ct_sum: 0, va_sum: 0, max_ct: 0, n: 0, decomposed: 0, retested: 0, bottleneck: 0, imp_pending: 0, updated_at: null,
      };
      cur.n += 1;
      cur.ct_sum = round2(cur.ct_sum + ct);
      cur.va_sum = round2(cur.va_sum + a.metrics.va);
      cur.max_ct = Math.max(cur.max_ct, ct);
      if (els.length > 0) cur.decomposed += 1;
      if (Number(s.version) > 1) cur.retested += 1;
      cur.imp_pending += pendingByStation.get(s.station_id) ?? 0;
      if (s.updated_at && (!cur.updated_at || new Date(s.updated_at) > new Date(cur.updated_at))) {
        cur.updated_at = new Date(s.updated_at);
      }
      agg.set(s.line_id, cur);
      perStation.push({ line: s.line_id, ct });
      globalMaxCt = Math.max(globalMaxCt, ct);
    }
    for (const p of perStation) {
      const cur = agg.get(p.line)!;
      if (Math.abs(p.ct - cur.max_ct) < 1e-6 && p.ct > 0) cur.bottleneck += 1;
    }
    void globalMaxCt;

    const rows: LineSummaryRow[] = [...agg.entries()].map(([lineId, a]) => {
      const meta = lineMeta.get(lineId) as any;
      return {
        line_id: lineId,
        line_name: meta?.name ?? lineId,
        process_type: meta?.process_type ?? null,
        product_type: meta?.product_type ?? null,
        product_project: meta?.product_project ?? null,
        station_count: a.n,
        decomposed_count: a.decomposed,
        retested_count: a.retested,
        balance_rate: a.max_ct > 0 ? round1((a.ct_sum / (a.max_ct * a.n)) * 100) : 0,
        va_pct: a.ct_sum > 0 ? round1((a.va_sum / a.ct_sum) * 100) : 0,
        bottleneck_count: a.bottleneck,
        imp_pending: a.imp_pending,
        updated_at: a.updated_at,
      };
    }).sort((x, y) => x.line_id.localeCompare(y.line_id));

    return { company: tenant?.name ?? tenantId, region: tenant?.region ?? null, lines: rows };
  }
}
