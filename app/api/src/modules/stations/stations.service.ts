import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BaseRepository } from '../../core/database/base.repository';
import { RulesService } from '../../core/rules/rules.service';
import { Station } from '../../entities/station.entity';
import { Line } from '../../entities/line.entity';
import { NotFoundException, BadRequestException, ForbiddenException, ConflictException } from '@nestjs/common';
import { round2 } from '../../core/shared/util';
import { DataScope } from '../../auth/auth-user.interface';
import { FULL_ACCESS_ROLES } from '../../rbac/full-access';
import { currentTenantId } from '../../tenant/tenant-context';

/**
 * 工位服务（MVP stations/service.js 平移示例）。
 * 封存语义不变：开始复测 = version+1（旧版因指针移开天然只读）；
 * 写守卫 = 任何要素写操作要求 bol_version = station.version。
 */
export class StationRepository extends BaseRepository<Station> {
  protected entityTarget() { return Station; }
}

/** 产线仓储（v3.3：t_line 元数据，建工位时 upsert） */
export class LineRepository extends BaseRepository<Line> {
  protected entityTarget() { return Line; }
}

/**
 * v3.42 工位 ACL（归属+共享）：
 *  - admin 判定：角色即租户级全权（sys_admin/ie_admin，由控制器传入 hasFullAccess）
 *  - 可见性 = owner 是我 ∪ 工位协作者 ∪ 产线级授权（grantor 名下该线工位）
 *  - 写权 = owner / admin / 协作者 editor（acl_role×RBAC 交集在控制器完成——无 station:write 权限者根本进不了写端点）
 */
/* v3.56：全权角色集合已抽到 rbac/full-access.ts（单一数据源），本文件直接沿用导入名。 */

/**
 * v3.55 个人数据范围（行级，t_user.data_scope）：
 *   own    = 仅本人相关（我建立的 + 别人共享给我的）
 *   line   = 本人负责产线的全部工位 + 本人相关
 *   tenant = 本租户全部工位
 *   all    = 全集团（聚合层可跨租户；明细层仍锁本租户）
 *
 * 口径铁律：data_scope 与 RBAC 权限点**正交**，不是替代关系——
 *   RBAC 权限点决定「能调哪些接口」，data_scope 决定「能看到哪些工位」。
 *   两者叠加：没有 element:read 权限点，data_scope=tenant 也读不到要素明细。
 *
 * 类型统一从 auth/auth-user.interface 引入（登录态载体），避免两处定义漂移。
 */

/**
 * v3.44 P2-1 ROI 功能区子区校验：[{"name","x","y","w","h"}]，坐标相对操作区 ROI（0–1）。
 * 上限 8 区（单工位功能区再多已无解释价值）；名称 1–20 字且不得重复（HOI 推断按名称回填「对象」）。
 */
function validateRoiZones(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  let arr: any[];
  try { arr = JSON.parse(raw); } catch { throw new BadRequestException('roi_zones 须为 JSON 数组字符串，如 [{"name":"扫码枪卡位","x":0.1,"y":0.2,"w":0.3,"h":0.4}]'); }
  if (!Array.isArray(arr)) throw new BadRequestException('roi_zones 须为 JSON 数组');
  if (arr.length > 8) throw new BadRequestException('roi_zones 子区数上限 8（建议只框物料/工具的固定卡位）');
  const names = new Set<string>();
  const out = arr.map((it, i) => {
    const name = String(it?.name ?? '').trim();
    if (!name || name.length > 20) throw new BadRequestException(`roi_zones[${i}].name 须为 1–20 字的功能区名称`);
    if (names.has(name)) throw new BadRequestException(`roi_zones 名称重复：「${name}」`);
    names.add(name);
    const nums = [it?.x, it?.y, it?.w, it?.h];
    if (nums.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
      throw new BadRequestException(`roi_zones[${i}] 的 x/y/w/h 须为 0–1 的数字（相对操作区）`);
    }
    if (it.x + it.w > 1.0001 || it.y + it.h > 1.0001 || it.w < 0.02 || it.h < 0.02) {
      throw new BadRequestException(`roi_zones[${i}] 越界：须满足 x+w≤1、y+h≤1 且宽高 ≥0.02`);
    }
    // v3.44：同 roi，四舍五入到 4 位小数（拖拽浮点噪声不入库）
    const r4 = (v: number) => Math.round(v * 10000) / 10000;
    return { name, x: r4(it.x), y: r4(it.y), w: r4(it.w), h: r4(it.h) };
  });
  return out.length ? JSON.stringify(out) : null;
}

@Injectable()
export class StationsService {
  private readonly repo: StationRepository;
  private readonly lineRepo: LineRepository;

  constructor(
    private readonly ds: DataSource,
    // v3.44 P2-2：SOP 封闭词表校验（RulesModule 是 @Global，直接注入）
    private readonly rules: RulesService,
  ) {
    this.repo = new StationRepository(ds);
    this.lineRepo = new LineRepository(ds);
  }

  /** 是否租户级全权角色（看全部 + 写全部，绕过 ACL 过滤） */
  hasFullAccess(roles: string[]): boolean {
    return roles.some((r) => FULL_ACCESS_ROLES.has(r));
  }

  /**
   * 可见性过滤（v3.42）：admin/全权角色原样返回；普通用户 = 我的 + 共享给我的（工位级 ∪ 产线级）。
   * 产线级授权语义：grantor_user_id 名下 line_id 产线的全部工位对 grantee 可见。
   *
   * v3.55：叠加 data_scope 行级范围（此前为空转字段）。两者口径：
   *   - ACL（owner/协作者/产线共享）= **资源级授权**；
   *   - data_scope = **行级可见范围**，在 ACL 之上追加可见范围（不缩小 ACL 已授权项）。
   *   语义 = 「我可见的」= ACL可见 ∪ scope可见。
   *   scope=own 时 ACL 已覆盖「我建立的 + 共享给我的」，故 own 不追加任何额外项。
   */
  async filterVisible(stations: Station[], userId: string, roles: string[], scope: DataScope = 'own', tenantId?: string): Promise<Station[]> {
    if (this.hasFullAccess(roles)) return stations;
    if (stations.length === 0) return stations;
    const visibleIds = await this.resolveVisibleStationIds(userId, roles, scope, stations, tenantId);
    return stations.filter((s) => visibleIds.has(s.station_id));
  }

  /**
   * v3.55 可见工位 ID 集合（唯一口径实现）。
   *
   * @param candidates 限定候选集（按租户/产线预筛后的工位）；scope=tenant 时以候选集为上限
   * @returns 可见工位 ID 集合
   *
   * ACL 三条（并集）：
   *   ① owner_user_id = 我
   *   ② 我是该工位协作者（t_station_collaborator，viewer/editor 都可读）
   *   ③ 该产线被共享给我（t_line_share grantee=我）
   * data_scope 追加（行级范围）：
   *   own → 不追加；line → 我参与（拥有/协作/被共享）的产线上的全部工位；
   *   tenant/all → 候选集全取（跨租户明细不由本层放行，租户隔离在前置层已保证）
   */
  private async resolveVisibleStationIds(
    userId: string, roles: string[], scope: DataScope, candidates?: Station[], tenantId?: string,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    const u = userId.replace(/'/g, "''");
    const candIds = candidates ? candidates.map((s) => s.station_id) : null;
    /** 候选集过滤片段（表别名不同，逐查询传入前缀） */
    const cand = (alias: string) => (candIds
      ? ` AND ${alias}.station_id IN (${candIds.map((i) => `'${i.replace(/'/g, "''")}'`).join(',')})`
      : '');

    // 请求方租户（按构造正确：显式约束，不依赖候选集兜底；缺省回退到请求上下文租户）
    // v3.59.2 修复：此前 line 分支的 myLines 三连查无租户约束，跨租户同名 line_id 串号可越权看到他租户工位。
    const t = (tenantId ?? currentTenantId() ?? '').replace(/'/g, "''");
    const tc = t ? ` AND t_station.tenant_id = '${t}'` : '';
    const tcs = t ? ` AND s.tenant_id = '${t}'` : '';
    const tls = t ? ` AND ls.tenant_id = '${t}'` : '';

    // ① owner（限定本租户）
    for (const r of await this.ds.query(
      `SELECT station_id FROM t_station WHERE owner_user_id = '${u}'${tc}${cand('t_station')}`,
    ) as any[]) out.add(r.station_id);

    // ② 工位级协作者（viewer 也可读 —— 读写分权；限定本租户）
    for (const r of await this.ds.query(
      `SELECT c.station_id FROM t_station_collaborator c
       JOIN t_station s ON s.station_id = c.station_id
       WHERE c.user_id = '${u}'${tcs}${cand('c')}`,
    ) as any[]) out.add(r.station_id);

    // ③ 产线级共享（grantee=我 → 该产线全部工位；限定本租户）
    for (const r of await this.ds.query(
      `SELECT s.station_id FROM t_line_share ls
       JOIN t_station s ON s.line_id = ls.line_id AND s.tenant_id = ls.tenant_id
       WHERE ls.grantee_user_id = '${u}'${tls}${cand('s')}`,
    ) as any[]) out.add(r.station_id);

    // ④ data_scope 行级范围
    if (scope === 'line') {
      // 我参与的所有产线（拥有 / 协作 / 被共享）—— 严格限定本租户，杜绝跨租户同名 line_id 串号越权
      const myLines = new Set<string>();
      for (const r of await this.ds.query(
        `SELECT DISTINCT line_id FROM t_station WHERE owner_user_id = '${u}'${tc}`,
      ) as any[]) myLines.add(r.line_id);
      for (const r of await this.ds.query(
        `SELECT DISTINCT s.line_id FROM t_station_collaborator c
         JOIN t_station s ON s.station_id = c.station_id WHERE c.user_id = '${u}'${tcs}`,
      ) as any[]) myLines.add(r.line_id);
      for (const r of await this.ds.query(
        `SELECT DISTINCT line_id FROM t_line_share ls WHERE ls.grantee_user_id = '${u}'${tls}`,
      ) as any[]) myLines.add(r.line_id);
      if (myLines.size > 0) {
        const inLines = [...myLines].map((l) => `'${l.replace(/'/g, "''")}'`).join(',');
        for (const r of await this.ds.query(
          `SELECT station_id FROM t_station WHERE line_id IN (${inLines})${tc}${cand('t_station')}`,
        ) as any[]) out.add(r.station_id);
      }
    } else if (scope === 'tenant' || scope === 'all') {
      // 候选集全取（tenant 隔离已由本层 tenant_id 约束 + 前置租户层双重保证；all 亦不在明细层跨租户放行）
      if (candidates) {
        for (const s of candidates) out.add(s.station_id);
      } else {
        // 无候选集时走仓储（BaseRepository 固附加 tenant_id 过滤），不用裸 SQL——避免跨租户泄露
        for (const s of await this.repo.find({} as any) as any[]) out.add(s.station_id);
      }
    }
    // scope=own：ACL 三条已完整覆盖「我建立的 + 共享给我的」，不追加
    return out;
  }

  /**
   * v3.55 资源级读权校验（与 assertWritable 对称）。
   * 读权限口径 = ACL 可见（owner/协作者/产线共享）∪ data_scope 行级范围。
   * 不可见 → 403（与写路径同码，前端统一按「无权限」处理）。
   *
   * 与 assertWritable 的区别：写只认 editor（协作者 editor / 产线 editor / owner / admin），
   * 读认全部协作者角色（viewer 也可读）——读写分权，ACL 矩阵语义不倒退。
   */
  async assertReadable(stationId: string, userId: string, roles: string[], scope: DataScope = 'own'): Promise<Station> {
    const s = await this.get(stationId);
    if (this.hasFullAccess(roles)) return s;
    const visible = await this.filterVisible([s], userId, roles, scope, s.tenant_id);
    if (visible.length === 0) {
      throw new ForbiddenException(`工位 ${stationId} 不在你的可见范围（仅本人相关/共享给你的可查看）`);
    }
    return s;
  }

  /**
   * v3.55 可见工位 ID 集合（聚合类端点用：看板/产线总览/改善清单）。
   * 与 filterVisible 同口径。返回 null 表示「不限制」（全权角色）。
   */
  async visibleStationIds(userId: string, roles: string[], tenantId: string, scope: DataScope = 'own'): Promise<string[] | null> {
    // 全权角色 → null 表示「不限制」
    if (this.hasFullAccess(roles)) return null;
    const all = await this.repo.find({} as any) as any[];
    const visible = await this.filterVisible(all, userId, roles, scope, tenantId);
    return visible.map((s) => s.station_id);
  }

  /**
   * 资源级写权校验（v3.42）：owner / admin / editor 协作者 / 产线级 editor 授权。
   * RBAC 层（station:write 权限点）已由 PermissionsGuard 把关；这里是「这个工位归不归你管」。
   */
  async assertWritable(stationId: string, userId: string, roles: string[]): Promise<Station> {
    const s = await this.get(stationId);
    if (this.hasFullAccess(roles)) return s;
    if (s.owner_user_id === userId) return s;
    const collab = (await this.ds.query(
      `SELECT acl_role FROM t_station_collaborator
       WHERE station_id = '${stationId.replace(/'/g, "''")}' AND user_id = '${userId.replace(/'/g, "''")}'`,
    )) as any[];
    if (collab.some((r) => r.acl_role === 'editor')) return s;
    // 产线级 editor 授权：工位 owner 把该线共享给我（editor）
    if (s.owner_user_id) {
      const ls = (await this.ds.query(
        `SELECT acl_role FROM t_line_share
         WHERE tenant_id = '${s.tenant_id.replace(/'/g, "''")}' AND line_id = '${s.line_id.replace(/'/g, "''")}'
           AND grantor_user_id = '${s.owner_user_id.replace(/'/g, "''")}' AND grantee_user_id = '${userId.replace(/'/g, "''")}'`,
      )) as any[];
      if (ls.some((r) => r.acl_role === 'editor')) return s;
    }
    throw new ForbiddenException(`工位 ${stationId} 不在你的可写范围（仅拥有人/协作者/管理员可操作）`);
  }

  /** 归属人展示名（同名工位徽标/共享列表用；批量去 N+1） */
  async ownerNames(userIds: string[]): Promise<Record<string, string>> {
    const uniq = [...new Set(userIds.filter(Boolean))];
    if (uniq.length === 0) return {};
    const inIds = uniq.map((i) => `'${i.replace(/'/g, "''")}'`).join(',');
    const rows = (await this.ds.query(
      `SELECT user_id, display_name FROM t_user WHERE user_id IN (${inIds})`,
    )) as any[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.user_id] = r.display_name;
    return out;
  }

  async list(lineId?: string) {
    const where = lineId ? { line_id: lineId } : {};
    return this.repo.find(where, { order: { station_id: 'ASC' } });
  }

  /** v3.42：list + ACL 过滤（控制器接线用；保持 list 原签名兼容既有调用方） */
  async listVisible(lineId: string | undefined, userId: string, roles: string[], scope: DataScope = 'own') {
    const all = await this.list(lineId);
    const visible = await this.filterVisible(all, userId, roles, scope, currentTenantId());
    // 归属人展示名批量 enrich（同名徽标/共享来源展示；一次 IN 查询防 N+1）
    const names = await this.ownerNames(visible.map((s) => s.owner_user_id ?? ''));
    return visible.map((s) => ({ ...s, owner_name: s.owner_user_id ? names[s.owner_user_id] ?? s.owner_user_id : null }));
  }

  async get(stationId: string) {
    const s = await this.repo.findOne({ station_id: stationId });
    if (!s) throw new NotFoundException(`工位 ${stationId} 不存在`);
    return s;
  }

  async create(input: { station_id: string; line_id: string; name: string; tt?: number; operator: string; tenantId: string; ownerUserId?: string }) {
    if (!/^[A-Za-z0-9]+-ST\d{2}$/.test(input.station_id)) {
      throw new BadRequestException('工位编码须符合 L01-ST01 / BJFA1-ST01 形式（产线码-ST序号）');
    }
    /* 编码前缀必须与所属产线一致：BJFA1-ST06 只能建在 BJFA1 下，
       避免"输 L30 的编码却挂到当前选中的 L01"这类跨线脏数据（v3.7 修复） */
    const prefix = input.station_id.split('-')[0];
    if (prefix !== input.line_id) {
      throw new BadRequestException(`工位编码 ${input.station_id} 的产线前缀为 ${prefix}，与所属产线 ${input.line_id} 不一致`);
    }
    /* 产线必须先存在（向导里先建线/选线），否则 t_line 会退化成以编码当名称的占位行 */
    const lineExists = await this.lineRepo.count({ tenant_id: input.tenantId, line_id: input.line_id });
    if (lineExists === 0) {
      throw new BadRequestException(`产线 ${input.line_id} 不存在，请先建立该产线（新建分析对象 → 产线 → 新建产线）`);
    }
    const exists = await this.repo.count({ station_id: input.station_id });
    if (exists > 0) throw new BadRequestException(`工位 ${input.station_id} 已存在`);
    // v3.42 同名护栏：同一归属人名下工位名称唯一（跨用户允许同名）
    if (input.ownerUserId) {
      const dup = await this.repo.count({ tenant_id: input.tenantId, owner_user_id: input.ownerUserId, name: input.name } as any);
      if (dup > 0) throw new BadRequestException(`您的名下已有名为「${input.name}」的工位，请换一个名称`);
    }
    const station = await this.repo.create({
      station_id: input.station_id,
      line_id: input.line_id,
      name: input.name,
      owner_user_id: input.ownerUserId ?? null,
      tt: input.tt ?? null,
      version: 1,
      ct: null,
      updated_by: input.operator,
      updated_at: new Date(),
    } as any);
    // 产线记录已在校验阶段确认存在；ensureLine 保留给导入等旁路（幂等补齐）
    return station;
  }

  /** 产线记录不存在则建（默认：装配/待补充/-；演示数据与导入可再完善） */
  async ensureLine(tenantId: string, lineId: string) {
    const exists = await this.lineRepo.count({ tenant_id: tenantId, line_id: lineId });
    if (exists === 0) {
      await this.lineRepo.create({ tenant_id: tenantId, line_id: lineId, name: lineId } as any);
    }
  }

  /**
   * 自 CMC 创建分析工位（v3.21）：基础信息零维护——用户只提供"工位名称"，
   * 产线/项目/工厂全部实时查 CMC 校验并快照到本地。
   *
   * 【铁律】CMC 库全程只读：本方法对 CMC.dbo.* 只执行 SELECT（产线存在性/项目分配关系/
   * cbco 最新项目信息），绝不 INSERT/UPDATE/DELETE；一切写入只落在 CN_AME 本地库
   * （t_line/t_project 快照 + t_station 主记录）。CMC 是唯一数据源，本地快照仅是物化副本，
   * 呈现与统计以 CMC 实时查询为准（前端总览页直查 CMC 接口）。
   *
   * 快照意义：既有分析/驾驶舱链路按 t_line/t_project 关联，工位若不落本地行，
   * 工位会变成"挂空线"的孤儿（v3.7 踩过：t_line 缺行时驾驶舱退化成编码当名称）。
   */
  async createFromCmc(input: {
    cmc_line_id: number; station_id?: string; program_number?: string; name: string; tt?: number;
    operator: string; tenantId: string; ownerUserId?: string;
  }) {
    /* 1) 产线：CMC 实时校验（停用/不存在一律拒绝，宁缺勿错） */
    const lineRows = (await this.ds.query(
      `SELECT pl.id, pl.code, pl.name, pl.process_type, f.code AS factory_code
       FROM CMC.dbo.production_lines pl
       JOIN CMC.dbo.factories f ON f.id = pl.factory_id
       WHERE pl.id = ${Math.trunc(input.cmc_line_id)} AND pl.is_enabled = 1`,
    )) as any[];
    if (lineRows.length === 0) {
      throw new BadRequestException('CMC 中不存在该产线或已停用——基础信息以产能系统为准，请刷新后重选');
    }
    const line = lineRows[0];

    /* 2) 项目：给了项目号就必须在该产线的启用分配清单里（分配关系以 CMC 为准） */
    let project: any = null;
    if (input.program_number) {
      if (!/^[A-Za-z0-9\-_]+$/.test(input.program_number)) {
        throw new BadRequestException('项目编号仅允许字母/数字/短横/下划线');
      }
      const pnLit = `'${input.program_number.replace(/'/g, "''")}'`;
      const alloc = (await this.ds.query(
        `SELECT a.program_number, a.ct_standard
         FROM CMC.dbo.project_line_allocations a
         WHERE a.line_id = ${Math.trunc(input.cmc_line_id)} AND a.program_number = ${pnLit} AND a.is_enabled = 1`,
      )) as any[];
      if (alloc.length === 0) {
        throw new BadRequestException(`项目 ${input.program_number} 未分配给产线 ${line.code}（以 CMC 分配关系为准）`);
      }
      project = (await this.ds.query(
        `SELECT TOP 1 program_number, program_description, customer, program_phase
         FROM CMC.dbo.cbco_records
         WHERE program_number = ${pnLit}
         ORDER BY year DESC, id DESC`,
      )) as any[];
      project = project[0] ?? null;
    }

    /* 3) 工位编码：v3.22 用户可手动维护（如 PA10），为空则按 {CMC产线码}-ST{两位序号} 自动生成。
       两种路径统一过校验：格式（L01-ST01/BJFA1-ST01/PA10 兼容）+ 前缀一致 + 唯一性。
       前缀校验放宽：手动编码允许不带产线码前缀（PA10 这类现场习称），但带前缀时必须一致。 */
    let stationId: string;
    if (input.station_id) {
      stationId = input.station_id;
      if (!/^[A-Za-z0-9][A-Za-z0-9\-_]{1,31}$/.test(stationId)) {
        throw new BadRequestException(`工位编码 ${stationId} 仅允许字母/数字/短横/下划线，2~32 位`);
      }
      const dashPrefix = stationId.includes('-') ? stationId.split('-')[0] : null;
      if (dashPrefix && dashPrefix !== line.code) {
        throw new BadRequestException(`工位编码 ${stationId} 的产线前缀 ${dashPrefix} 与所属产线 ${line.code} 不一致`);
      }
    } else {
      const siblings = (await this.repo.find({ line_id: line.code } as any, { order: { station_id: 'DESC' } as any })) as any[];
      let maxSeq = 0;
      for (const s of siblings) {
        const m = /^.*-ST(\d{2})$/.exec(s.station_id);
        if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
      }
      if (maxSeq >= 99) throw new BadRequestException(`产线 ${line.code} 下工位序号已满（ST01~ST99）`);
      stationId = `${line.code}-ST${String(maxSeq + 1).padStart(2, '0')}`;
    }
    const exists = await this.repo.count({ station_id: stationId });
    if (exists > 0) throw new BadRequestException(`工位 ${stationId} 已存在`);

    /* 4) 本地快照：产线行（upsert）+ 项目行（upsert）——CMC 变了下次创建自动刷新覆盖 */
    const processCn = ({ FA: '装配', bonding: '焊接', IHE: '测试', IHR: '测试', Tailgate: '其他' } as Record<string, string>)[line.process_type] ?? line.process_type ?? '其他';
    // repo.save 语义 = upsert（主键在则 UPDATE、不在则 INSERT），天然适配"刷新快照"
    await this.lineRepo.create({
      tenant_id: input.tenantId,
      line_id: line.code,
      name: line.name,
      process_type: processCn,
      product_project: input.program_number ?? '-',
      cmc_line_id: line.id,
      factory_code: line.factory_code,
    } as any);
    if (project) {
      await this.ds.getRepository('t_project').save({
        tenant_id: input.tenantId,
        project_id: project.program_number,
        name: project.program_description ?? project.program_number,
        customer: project.customer ?? '',
        stage: project.program_phase ?? '量产',
        status: 'active',
      } as any);
    }

    /* 5) 工位主记录 */
    const station = await this.repo.create({
      station_id: stationId,
      tenant_id: input.tenantId,
      line_id: line.code,
      name: input.name,
      owner_user_id: input.ownerUserId ?? null,
      tt: input.tt ?? null,
      version: 1,
      ct: null,
      program_number: input.program_number ?? null,
      cmc_line_id: line.id,
      updated_by: input.operator,
      updated_at: new Date(),
    } as any);
    return station;
  }

  async patch(stationId: string, patch: { name?: string; tt?: number; roi?: string | null; roi_zones?: string | null; sop_steps?: string | null; operator: string }, actor?: { userId: string; roles: string[] }) {
    if (actor) await this.assertWritable(stationId, actor.userId, actor.roles);
    const s = await this.get(stationId);
    // v3.42 同名护栏：改名后不得与归属人名下其他工位重名
    if (patch.name !== undefined && patch.name !== s.name && s.owner_user_id) {
      const dup = await this.repo.count({ tenant_id: s.tenant_id, owner_user_id: s.owner_user_id, name: patch.name } as any);
      if (dup > 0) throw new BadRequestException(`您的名下已有名为「${patch.name}」的工位，请换一个名称`);
    }
    // v3.43 ROI：结构 {"x","y","w","h"} 归一化 0–1，x+w≤1、y+h≤1；null=清除标定
    let roi = s.roi;
    if (patch.roi !== undefined) {
      if (patch.roi === null || patch.roi === '') {
        roi = null;
      } else {
        let j: any;
        try { j = JSON.parse(patch.roi); } catch { throw new BadRequestException('roi 须为 JSON 字符串，如 {"x":0.18,"y":0.3,"w":0.6,"h":0.5}'); }
        const nums = [j?.x, j?.y, j?.w, j?.h];
        if (nums.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
          throw new BadRequestException('roi 的 x/y/w/h 须为 0–1 的数字');
        }
        if (j.x + j.w > 1.0001 || j.y + j.h > 1.0001 || j.w < 0.05 || j.h < 0.05) {
          throw new BadRequestException('roi 越界：须满足 x+w≤1、y+h≤1 且宽高 ≥0.05（太小没有分析价值）');
        }
        // v3.44：四舍五入到 4 位小数——拖拽浮点噪声（0.6000000000000001）曾顶爆 roi 列 64 字符上限（400 实锤）
        const r4 = (v: number) => Math.round(v * 10000) / 10000;
        roi = JSON.stringify({ x: r4(j.x), y: r4(j.y), w: r4(j.w), h: r4(j.h) });
      }
    }
    // v3.44 P2-1 ROI 功能区子区：[{"name","x","y","w","h"}] 坐标相对 ROI；null=清除
    let roiZones = s.roi_zones;
    if (patch.roi_zones !== undefined) {
      roiZones = validateRoiZones(patch.roi_zones);
    }
    // v3.44 P2-2 SOP 步骤序列：[{"verb","object"}]，verb ∈ motion_standard 封闭词表；null=清除
    let sopSteps = s.sop_steps;
    if (patch.sop_steps !== undefined) {
      sopSteps = this.validateSopSteps(patch.sop_steps);
    }
    const n = await this.repo.update({ station_id: stationId }, {
      name: patch.name ?? s.name,
      tt: patch.tt ?? s.tt,
      roi,
      roi_zones: roiZones,
      sop_steps: sopSteps,
      updated_by: patch.operator,
      updated_at: new Date(),
    });
    if (n === 0) throw new NotFoundException(`工位 ${stationId} 不存在`);
    return this.get(stationId);
  }

  /**
   * v3.44 P2-2 SOP 封闭词表校验：verb 必须在 motion_standard（一级/二级）词表内。
   * 封闭词表是「SOP 先导自动命名」可信的根基——AI 命名空间被词表封闭，幻觉无处容身。
   */
  private validateSopSteps(raw: string | null): string | null {
    if (raw === null || raw === '') return null;
    let arr: any[];
    try { arr = JSON.parse(raw); } catch { throw new BadRequestException('sop_steps 须为 JSON 数组字符串，如 [{"verb":"拿取","object":"后横梁"}]'); }
    if (!Array.isArray(arr)) throw new BadRequestException('sop_steps 须为 JSON 数组');
    if (arr.length > 40) throw new BadRequestException('sop_steps 步骤数上限 40（超出请拆分工序）');
    const verbs = new Set<string>();
    try {
      const std = this.rules.getActive('motion_standard');
      for (const g of std?.json?.groups ?? []) {
        if (g?.level1) verbs.add(String(g.level1).trim());
        for (const sub of g?.subs ?? []) if (sub?.level2) verbs.add(String(sub.level2).trim());
      }
    } catch { /* 词表拉不到时跳过封闭校验（结构校验仍然生效） */ }
    const out = arr.map((it, i) => {
      const verb = String(it?.verb ?? '').trim();
      if (!verb || verb.length > 32) throw new BadRequestException(`sop_steps[${i}].verb 须为 1–32 字的动作动词`);
      if (verbs.size > 0 && !verbs.has(verb)) {
        throw new BadRequestException(`sop_steps[${i}].verb「${verb}」不在动作标准库词表内（SOP 对齐只认封闭词表，请先在动作标准库维护）`);
      }
      const object = it?.object == null ? undefined : String(it.object).trim();
      if (object && object.length > 64) throw new BadRequestException(`sop_steps[${i}].object 超长（≤64 字）`);
      return object ? { verb, object } : { verb };
    });
    return JSON.stringify(out);
  }

  /**
   * 开始复测：version+1（封存旧版）。
   * 单条 UPDATE 本身原子，无需显式事务；多语句事务（要素提交 DELETE→INSERT→CT 重算）
   * 阶段1 平移时用 BaseRepository.transaction（queryRunner）实现，并在 SQL Server 生产库验证。
   *
   * v3.19 空版本护栏：当前版本无要素时拒绝再开复测。此前无此护栏，「开始复测」被误点/测试
   * 点击会无限堆积空壳版本（L01-ST01 曾积到 v45 而只有 v1 有要素，版本清单被空版本撑爆，
   * 且作废一次只能回退一版，误点多次几乎无法恢复）。封存语义不变：有要素才值得封存。
   */
  async startRetest(stationId: string, operator: string) {
    const s = await this.get(stationId);
    const cnt = await this.ds.getRepository('t_element').count({
      where: { station_id: stationId, bol_version: s.version, tenant_id: s.tenant_id } as any,
    });
    if (cnt === 0) {
      throw new BadRequestException(`当前版本 v${s.version} 还没有任何要素，无需复测——直接在本版本继续分解即可`);
    }
    const n = await this.repo.update({ station_id: stationId }, {
      version: s.version + 1,
      updated_by: operator,
      updated_at: new Date(),
    });
    if (n === 0) throw new NotFoundException(`工位 ${stationId} 不存在`);
    return this.get(stationId);
  }

  /** 回写 CT（要素提交/VA 改判后调用；tenant 过滤防跨租户串算） */
  async recalcCt(stationId: string, operator: string) {
    const s = await this.get(stationId);
    const rows = await this.ds.getRepository('t_element').find({
      where: { station_id: stationId, bol_version: s.version, outlier_flag: 0, tenant_id: s.tenant_id },
    } as any) as any[];
    const ct = round2(rows.reduce((sum, r) => sum + Number(r.std_time), 0));
    await this.repo.update({ station_id: stationId }, { ct, updated_by: operator, updated_at: new Date() });
    return ct;
  }

  /**
   * 版本清单（前端工作台"已封存版本"与版本切换；MVP StationDetail.versions 同口径）。
   * 版本自 t_element.bol_version 聚合推导；无要素的历史版本（如刚复测的新版）也要出现（element_count=0）。
   */
  async versions(stationId: string) {
    const s = await this.get(stationId);
    const rows = await this.ds.getRepository('t_element')
      .createQueryBuilder('e')
      .select('e.bol_version', 'version')
      .addSelect('COUNT(*)', 'element_count')
      .addSelect('COALESCE(SUM(CASE WHEN e.outlier_flag = 0 THEN e.std_time ELSE 0 END), 0)', 'ct')
      .where('e.station_id = :sid AND e.tenant_id = :tid', { sid: stationId, tid: s.tenant_id })
      .groupBy('e.bol_version')
      .orderBy('e.bol_version', 'ASC')
      .getRawMany() as any[];
    const byVer = new Map<number, any>(rows.map((r) => [Number(r.version), r]));
    const out: { version: number; element_count: number; ct: number; is_current: boolean; is_sealed: boolean }[] = [];
    for (let v = 1; v <= s.version; v += 1) {
      const row = byVer.get(v);
      out.push({
        version: v,
        element_count: row ? Number(row.element_count) : 0,
        ct: row ? round2(Number(row.ct)) : 0,
        is_current: v === s.version,
        is_sealed: v < s.version,
      });
    }
    return out;
  }

  /**
   * 作废复测（MVP DELETE /stations/:id/retest 同口径）：
   * 删除当前版本（复测草稿）全部要素 + 版本指针回退一位。旧版要素不动（天然只读）。
   */
  async cancelRetest(stationId: string, operator: string) {
    const s = await this.get(stationId);
    if (s.version <= 1) throw new BadRequestException('v1 为首个版本，无复测可作废');
    /* v3.47 跨线销毁守卫（P0-B5）：作废复测会物理删除当前版本全部要素且无软删/无回收站，
       若该版本是 AI 自动分解写入的成果，一次点击即永久丢失。此处先盘 AI 要素，非空即拒绝。 */
    const aiCount = await this.ds.getRepository('t_element').count({
      where: { station_id: stationId, bol_version: s.version, tenant_id: s.tenant_id, source: 'ai_assisted' } as any,
    });
    if (aiCount > 0) {
      throw new ConflictException(
        `当前版本 v${s.version} 含 ${aiCount} 条 AI 自动分解要素，「作废复测」会将其物理删除且无法恢复。` +
        `请在「AI 自动分解」页签处理该版本；若确需以手工分解接管，请联系 IE 主管执行版本接管。`,
      );
    }
    await this.ds.getRepository('t_element').delete({
      station_id: stationId, bol_version: s.version, tenant_id: s.tenant_id,
    } as any);
    await this.repo.update({ station_id: stationId }, {
      version: s.version - 1, updated_by: operator, updated_at: new Date(),
    });
    return this.get(stationId);
  }

  /**
   * 删除工位（v3.21 主数据维护页）：级联删除要素（全部版本）与改善记录。
   * 这是全系统破坏性最强的操作——前端必须弹确认框列出将删除的要素/改善条数；
   * 后端用显式事务保证"子表删干净主表才删"，中途失败整体回滚（清理顺序：先子表后主表）。
   */
  async remove(stationId: string, actor?: { userId: string; roles: string[] }) {
    if (actor) await this.assertWritable(stationId, actor.userId, actor.roles);
    const s = await this.get(stationId);
    const [elements, improvements] = await Promise.all([
      this.ds.getRepository('t_element').countBy({ station_id: stationId } as any),
      this.ds.getRepository('t_improvement').countBy({ station_id: stationId } as any),
    ]);
    await this.repo.transaction(async (m) => {
      // AI 派生数据一并级联（v3.30）：t_ai_suggestion_batch.station_id 有 FK 指向 t_station，
      // 不清会顶爆 FK_ai_batch_station 使删除 500；建议永远待审=派生分析产物，工位删除即失去意义。
      // 顺序（先子表后主表）：建议 → 批次；t_improvement.ai_suggestion_id 无 FK，且本工位改善记录随下行删除。
      await m.getRepository('t_ai_suggestion').delete({ station_id: stationId } as any);
      await m.getRepository('t_ai_suggestion_batch').delete({ station_id: stationId } as any);
      // P3-9 浪费识别派生数据（v3.40）：独立三表 t_ai_waste_*（AI 自动分解线），
      // 同为工位派生分析产物；先 finding/issue 后 batch（t_ai_waste_finding/issue.batch_id FK → t_ai_waste_batch）。
      await m.getRepository('t_ai_waste_finding').delete({ station_id: stationId } as any);
      await m.getRepository('t_ai_waste_issue').delete({ station_id: stationId } as any);
      await m.getRepository('t_ai_waste_batch').delete({ station_id: stationId } as any);
      await m.getRepository('t_element').delete({ station_id: stationId } as any);
      await m.getRepository('t_improvement').delete({ station_id: stationId } as any);
      // v3.42 协作者授权随工位删除（铁律：引用 t_station 的子表先进级联）
      await m.getRepository('t_station_collaborator').delete({ station_id: stationId } as any);
      await m.getRepository('t_station').delete({ station_id: stationId } as any);
    });
    return { station_id: stationId, deleted: true, cascaded: { elements, improvements } };
  }

  // ================= v3.42 共享与协作 =================

  /** 共享工位给用户（仅 owner/admin 可操作；user 必须同租户） */
  async shareStation(stationId: string, granteeUserId: string, aclRole: string, operator: string, actor: { userId: string; roles: string[] }) {
    if (!['editor', 'viewer'].includes(aclRole)) throw new BadRequestException('acl_role 仅允许 editor / viewer');
    const s = await this.get(stationId);
    const isOwner = s.owner_user_id === actor.userId;
    if (!isOwner && !this.hasFullAccess(actor.roles)) {
      throw new ForbiddenException('只有工位拥有人或管理员可以共享');
    }
    if (granteeUserId === s.owner_user_id) throw new BadRequestException('该用户已是工位拥有人');
    const grantee = (await this.ds.query(
      `SELECT user_id, display_name FROM t_user WHERE user_id = '${granteeUserId.replace(/'/g, "''")}' AND tenant_id = '${s.tenant_id.replace(/'/g, "''")}'`,
    )) as any[];
    if (grantee.length === 0) throw new BadRequestException('被授权用户不存在或不属于当前公司');
    await this.ds.query(
      `MERGE t_station_collaborator AS tgt
       USING (SELECT '${stationId.replace(/'/g, "''")}' AS station_id, '${granteeUserId.replace(/'/g, "''")}' AS user_id) AS src
       ON tgt.station_id = src.station_id AND tgt.user_id = src.user_id
       WHEN MATCHED THEN UPDATE SET acl_role = '${aclRole}', granted_by = '${operator.replace(/'/g, "''")}', granted_at = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN INSERT (station_id, user_id, acl_role, granted_by) VALUES (src.station_id, src.user_id, '${aclRole}', '${operator.replace(/'/g, "''")}');`,
    );
    return { station_id: stationId, user_id: granteeUserId, acl_role: aclRole, display_name: grantee[0]?.display_name ?? granteeUserId };
  }

  /** 移除工位协作者（owner/admin） */
  async unshareStation(stationId: string, granteeUserId: string, actor: { userId: string; roles: string[] }) {
    const s = await this.get(stationId);
    if (s.owner_user_id !== actor.userId && !this.hasFullAccess(actor.roles)) {
      throw new ForbiddenException('只有工位拥有人或管理员可以移除共享');
    }
    await this.ds.query(
      `DELETE FROM t_station_collaborator WHERE station_id = '${stationId.replace(/'/g, "''")}' AND user_id = '${granteeUserId.replace(/'/g, "''")}'`,
    );
    return { station_id: stationId, user_id: granteeUserId, removed: true };
  }

  /** 工位协作者清单（owner/admin 管理用） */
  async collaborators(stationId: string) {
    await this.get(stationId);
    const rows = (await this.ds.query(
      `SELECT c.user_id, c.acl_role, c.granted_by, c.granted_at, u.display_name, u.username
       FROM t_station_collaborator c LEFT JOIN t_user u ON u.user_id = c.user_id
       WHERE c.station_id = '${stationId.replace(/'/g, "''")}' ORDER BY c.granted_at ASC`,
    )) as any[];
    return rows;
  }

  /** 整线共享（grantor 名下该产线现有+未来工位共享给 grantee；仅产线 owner/admin 可操作） */
  async shareLine(lineId: string, granteeUserId: string, aclRole: string, operator: string, actor: { userId: string; roles: string[]; tenantId: string }) {
    if (!['editor', 'viewer'].includes(aclRole)) throw new BadRequestException('acl_role 仅允许 editor / viewer');
    if (!this.hasFullAccess(actor.roles)) {
      // 必须是该线至少一个工位的 owner 才能整线共享（防止把别人产线共享出去）
      const owned = await this.repo.count({ tenant_id: actor.tenantId, line_id: lineId, owner_user_id: actor.userId } as any);
      if (owned === 0) throw new ForbiddenException(`您在产线 ${lineId} 名下没有工位，不能整线共享`);
    }
    if (granteeUserId === actor.userId) throw new BadRequestException('不能共享给自己');
    const grantee = (await this.ds.query(
      `SELECT user_id FROM t_user WHERE user_id = '${granteeUserId.replace(/'/g, "''")}' AND tenant_id = '${actor.tenantId.replace(/'/g, "''")}'`,
    )) as any[];
    if (grantee.length === 0) throw new BadRequestException('被授权用户不存在或不属于当前公司');
    await this.ds.query(
      `MERGE t_line_share AS tgt
       USING (SELECT '${actor.tenantId.replace(/'/g, "''")}' AS tenant_id, '${lineId.replace(/'/g, "''")}' AS line_id,
                     '${actor.userId.replace(/'/g, "''")}' AS grantor_user_id, '${granteeUserId.replace(/'/g, "''")}' AS grantee_user_id) AS src
       ON tgt.tenant_id = src.tenant_id AND tgt.line_id = src.line_id
         AND tgt.grantor_user_id = src.grantor_user_id AND tgt.grantee_user_id = src.grantee_user_id
       WHEN MATCHED THEN UPDATE SET acl_role = '${aclRole}', granted_at = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN INSERT (tenant_id, line_id, grantor_user_id, grantee_user_id, acl_role)
         VALUES (src.tenant_id, src.line_id, src.grantor_user_id, src.grantee_user_id, '${aclRole}');`,
    );
    return { line_id: lineId, grantee_user_id: granteeUserId, acl_role: aclRole };
  }

  /** 取消整线共享 */
  async unshareLine(lineId: string, granteeUserId: string, actor: { userId: string; roles: string[]; tenantId: string }) {
    if (!this.hasFullAccess(actor.roles)) {
      await this.ds.query(
        `DELETE FROM t_line_share WHERE tenant_id = '${actor.tenantId.replace(/'/g, "''")}' AND line_id = '${lineId.replace(/'/g, "''")}'
         AND grantor_user_id = '${actor.userId.replace(/'/g, "''")}' AND grantee_user_id = '${granteeUserId.replace(/'/g, "''")}'`,
      );
    } else {
      await this.ds.query(
        `DELETE FROM t_line_share WHERE tenant_id = '${actor.tenantId.replace(/'/g, "''")}' AND line_id = '${lineId.replace(/'/g, "''")}'
         AND grantee_user_id = '${granteeUserId.replace(/'/g, "''")}'`,
      );
    }
    return { line_id: lineId, grantee_user_id: granteeUserId, removed: true };
  }

  /** 我共享出去的整线授权清单（管理用） */
  async myLineShares(tenantId: string, grantorUserId: string) {
    return (await this.ds.query(
      `SELECT ls.line_id, ls.grantee_user_id, ls.acl_role, ls.granted_at, u.display_name
       FROM t_line_share ls LEFT JOIN t_user u ON u.user_id = ls.grantee_user_id
       WHERE ls.tenant_id = '${tenantId.replace(/'/g, "''")}' AND ls.grantor_user_id = '${grantorUserId.replace(/'/g, "''")}'
       ORDER BY ls.line_id ASC`,
    )) as any[];
  }

  /** 共享弹窗用户候选：本租户 active 用户（轻量字段；比 GET /users 少 user:read 门槛） */
  async shareCandidates(tenantId: string) {
    return (await this.ds.query(
      `SELECT user_id, username, display_name FROM t_user
       WHERE tenant_id = '${tenantId.replace(/'/g, "''")}' AND status = 'active' ORDER BY username ASC`,
    )) as any[];
  }
}
