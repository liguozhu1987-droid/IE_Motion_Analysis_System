import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { RulesService } from '../../core/rules/rules.service';
import { BaseRepository } from '../../core/database/base.repository';
import { DecompositionTask } from '../../entities/decomposition-task.entity';
import { TaskStation } from '../../entities/task-station.entity';
import { Element } from '../../entities/element.entity';
import { Station } from '../../entities/station.entity';
import { StationsService } from '../stations/stations.service';
import { AuthUser } from '../../auth/auth-user.interface';
import { AddStationsDto, CloneElementsDto, CreateTaskDto, ListTasksDto } from './tasks.dto';
import { findReadableTask } from '../../core/task-scope/task-scope';
import { taskElementId } from '../../core/shared/util';

class TaskRepository extends BaseRepository<DecompositionTask> {
  protected entityTarget() { return DecompositionTask; }
}
class TaskStationRepository extends BaseRepository<TaskStation> {
  protected entityTarget() { return TaskStation; }
}

/** DATE 列在 mssql 读回 Date、sqlite 读回 string —— 统一成 YYYY-MM-DD */
export const isoDate = (v: unknown): string => {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/**
 * 分解任务服务（Phase 2 / 定稿 §3.1–§3.8）。
 *
 * 纪律：
 *  - 所有查询带 tenant_id（BaseRepository 自动注入 + 显式复核），任务不可跨租户可见；
 *  - 工位级仍走 StationsService.filterVisible / assertReadable（ACL ∪ data_scope 四并集），
 *    不因任务实体绕过既有权限收口；不可见工位既不进任务也不进导出文件；
 *  - 任务号 DT-{YYYY}-{NNN} 租户内唯一、不可变；DB 唯一索引兜底并发撞号；
 *  - 归档任务（legacy/archived）可读可导出，但不允许再纳入工位或复制要素（归档只读）。
 */
@Injectable()
export class TasksService {
  private readonly log = new Logger(TasksService.name);
  private readonly tasks: TaskRepository;
  private readonly links: TaskStationRepository;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly stations: StationsService,
    private readonly rules: RulesService,
  ) {
    this.tasks = new TaskRepository(ds);
    this.links = new TaskStationRepository(ds);
  }

  private taskDto(t: DecompositionTask, stationCount: number) {
    return {
      task_id: t.task_id,
      task_no: t.task_no,
      line_id: t.line_id,
      name: t.name,
      round_type: t.round_type,
      round_no: Number(t.round_no),
      period_start: isoDate(t.period_start),
      period_end: isoDate(t.period_end),
      status: t.status,
      baseline_task_id: t.baseline_task_id ?? null,
      project_id: t.project_id ?? null,
      project_no_snapshot: t.project_no_snapshot ?? null,
      rule_versions: t.rule_versions ?? null,
      created_by: t.created_by ?? null,
      created_at: t.created_at,
      station_count: stationCount,
      is_legacy: t.round_type === 'legacy',
    };
  }

  /** 任务级可读性：租户一致 + 存在；不回显他租户任务的存在性 */
  async assertTaskReadable(taskId: string, user: AuthUser): Promise<DecompositionTask> {
    // Phase 3：与 TaskScopeService 共用 findReadableTask，保证「同租户 + 404」是唯一口径
    return findReadableTask(this.ds, taskId, user);
  }

  async list(q: ListTasksDto, user: AuthUser) {
    /* Phase 3 #107：station_id 过滤 = 只列包含该工位的任务（t_task_station 成员，租户内）。
       零成员直接返回空集，避免 where.task_id = In([]) 生成非法 SQL。 */
    let memberOf: string[] | null = null;
    if (q.station_id) {
      const links = await this.ds.getRepository(TaskStation)
        .find({ where: { tenant_id: user.tenantId, station_id: q.station_id } as any });
      memberOf = links.map((l) => l.task_id);
      if (memberOf.length === 0) return { items: [] };
    }
    const where: Record<string, unknown> = { tenant_id: user.tenantId };
    if (q.line_id) where.line_id = q.line_id;
    if (q.project_id) where.project_id = q.project_id;
    if (memberOf) where.task_id = In(memberOf);
    const rows = await this.tasks.find(where as any, { order: { created_at: 'DESC' }, take: Math.min(q.limit ?? 50, 100) });
    const links = rows.length
      ? await this.ds.getRepository(TaskStation).find({ where: { tenant_id: user.tenantId, task_id: In(rows.map((r) => r.task_id)) } })
      : [];
    const countBy = new Map<string, number>();
    for (const l of links) countBy.set(l.task_id, (countBy.get(l.task_id) ?? 0) + 1);
    return { items: rows.map((t) => this.taskDto(t, countBy.get(t.task_id) ?? 0)) };
  }

  async detail(taskId: string, user: AuthUser) {
    const t = await this.assertTaskReadable(taskId, user);
    const links = await this.links.find({ task_id: taskId, tenant_id: user.tenantId }, { order: { seq_no: 'ASC' } });
    return {
      ...this.taskDto(t, links.length),
      stations: links.map((l) => ({
        station_id: l.station_id,
        station_code_snapshot: l.station_code_snapshot,
        station_name_snapshot: l.station_name_snapshot,
        bol_version: Number(l.bol_version),
        seq_no: Number(l.seq_no),
      })),
    };
  }

  /** 生成 DT-{YYYY}-{NNN}：取本租户当年最大序号 +1；DB 唯一索引兜底并发 */
  private async nextTaskNo(tenantId: string): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `DT-${year}-`;
    const rows = await this.ds.getRepository(DecompositionTask)
      .createQueryBuilder('t')
      .select('t.task_no', 'task_no')
      .where('t.tenant_id = :tenant', { tenant: tenantId })
      .andWhere('t.task_no LIKE :prefix', { prefix: `${prefix}%` })
      .getRawMany<{ task_no: string }>();
    let max = 0;
    for (const r of rows) {
      const n = Number.parseInt(String(r.task_no).slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
  }

  private ruleFingerprint(): string {
    const s = this.rules.snapshot();
    return ['va_rules', 'waste_triggers', 'ecrsa_map', 'motion_standard']
      .map((k) => `${k}:${s[k]?.version ?? '?'}`).join('|').slice(0, 128);
  }

  async create(dto: CreateTaskDto, user: AuthUser) {
    if (dto.period_start && dto.period_end && dto.period_start > dto.period_end) {
      throw new BadRequestException('观测时间段起始日不能晚于结束日');
    }
    // 产线必须属于本租户（任务单产线约束）
    const line = await this.ds.getRepository(Station).findOne({ where: { tenant_id: user.tenantId, line_id: dto.line_id } as any });
    if (!line) throw new BadRequestException(`产线 ${dto.line_id} 在本租户下不存在或没有工位`);

    // 候选工位 = 该产线全部工位 ∩ 可见范围（filterVisible 唯一口径）
    const candidates = await this.ds.getRepository(Station).find({
      where: { tenant_id: user.tenantId, line_id: dto.line_id } as any,
      order: { station_id: 'ASC' },
    });
    const visible = await this.stations.filterVisible(candidates as any, user.userId, user.roles, user.dataScope, user.tenantId);
    const visibleIds = new Set(visible.map((s: any) => String(s.station_id)));
    const wanted = dto.station_ids?.length ? dto.station_ids : [...visibleIds];
    const chosen = wanted.filter((id) => visibleIds.has(id));
    if (dto.station_ids?.length && chosen.length === 0) {
      throw new ForbiddenException('所选工位均不在你的可见范围');
    }

    const taskNo = await this.nextTaskNo(user.tenantId);
    const taskId = taskNo; // 单主键，直接用人可读任务号作内部主键（租户内唯一由 DB 索引保证）
    let row: DecompositionTask;
    try {
      row = await this.tasks.create({
        task_id: taskId,
        tenant_id: user.tenantId,
        task_no: taskNo,
        line_id: dto.line_id,
        name: dto.name,
        round_type: dto.round_type ?? 'baseline',
        round_no: 1,
        period_start: dto.period_start ?? null,
        period_end: dto.period_end ?? null,
        status: 'active',
        baseline_task_id: dto.baseline_task_id ?? null,
        project_id: dto.project_id ?? null,
        project_no_snapshot: dto.project_no_snapshot ?? null,
        rule_versions: this.ruleFingerprint(),
        owner_user_id: user.userId,
        created_by: user.username,
        closed_at: null,
      } as Partial<DecompositionTask>);
    } catch (e) {
      // 并发撞号（UQ_task_tenant_no）：不静默重试，明确让用户再提交一次
      throw new BadRequestException(`任务号 ${taskNo} 已被占用，请重试（${(e as Error).message.slice(0, 120)}）`);
    }
    if (chosen.length) await this.linkStations(row, chosen, user);
    return this.detail(row.task_id, user);
  }

  /** 批量纳入工位：只认可见工位，锁定各自当前 station.version */
  async addStations(taskId: string, dto: AddStationsDto, user: AuthUser) {
    const t = await this.assertTaskReadable(taskId, user);
    if (t.status === 'archived' || t.round_type === 'legacy') {
      throw new BadRequestException('归档任务只读，不能纳入工位');
    }
    const candidates = await this.ds.getRepository(Station).find({ where: { station_id: In(dto.station_ids), tenant_id: user.tenantId } as any });
    const visible = await this.stations.filterVisible(candidates as any, user.userId, user.roles, user.dataScope, user.tenantId);
    const chosen = visible.filter((s: any) => String(s.line_id) === String(t.line_id)).map((s: any) => String(s.station_id));
    if (chosen.length === 0) throw new ForbiddenException('所选工位均不可见或不属于该任务产线');
    return this.linkStations(t, chosen, user);
  }

  private async linkStations(t: DecompositionTask, stationIds: string[], user: AuthUser) {
    const stations = await this.ds.getRepository(Station).find({ where: { station_id: In(stationIds), tenant_id: user.tenantId } as any });
    const existing = await this.links.find({ task_id: t.task_id, tenant_id: user.tenantId });
    const have = new Set(existing.map((l) => l.station_id));
    let maxSeq = existing.reduce((a, l) => Math.max(a, Number(l.seq_no)), 0);
    const fresh = stations.filter((s) => !have.has(s.station_id))
      .sort((a, b) => String(a.station_id).localeCompare(String(b.station_id)));
    if (fresh.length) {
      await this.links.createMany(fresh.map((s) => ({
        task_id: t.task_id,
        station_id: s.station_id,
        tenant_id: user.tenantId,
        station_code_snapshot: s.station_id,
        station_name_snapshot: s.name,
        bol_version: Number(s.version) || 1,
        ct_snapshot: s.ct ?? null,
        tt_snapshot: s.tt ?? null,
        seq_no: ++maxSeq,
      } as Partial<TaskStation>)));
    }
    return { added: fresh.length, total: have.size + fresh.length };
  }

  /**
   * 从基线任务复制要素快照作为新任务起点（任务隔离的可执行闭环）。
   * 不改源任务任何行；新行 element_id = {taskNo}-{stationId}-V{version}-{seq}（跨任务不撞号）。
   * 幂等：目标任务已存在同 (station, version, seq) 则跳过；归档任务不可作为复制目标。
   */
  async cloneElements(taskId: string, dto: CloneElementsDto, user: AuthUser) {
    const target = await this.assertTaskReadable(taskId, user);
    const source = await this.assertTaskReadable(dto.from_task_id, user);
    if (target.task_id === source.task_id) throw new BadRequestException('源任务与目标任务不能相同');
    if (target.line_id !== source.line_id) throw new BadRequestException('跨产线任务不能复制要素');
    if (target.status === 'archived' || target.round_type === 'legacy') {
      throw new BadRequestException('归档任务只读，不能作为复制目标');
    }
    // 源工位必须可读（逐工位 assertReadable，沿用既有 ACL）
    const srcLinks = await this.links.find({ task_id: source.task_id, tenant_id: user.tenantId });
    for (const l of srcLinks) await this.stations.assertReadable(l.station_id, user.userId, user.roles, user.dataScope);

    // 目标关联：缺的按源任务的 bol_version 补齐（锁定同一版本，不随 station.version 漂移）
    const tgtLinks = await this.links.find({ task_id: target.task_id, tenant_id: user.tenantId });
    const tgtByStation = new Map(tgtLinks.map((l) => [l.station_id, l]));
    const srcByStation = new Map(srcLinks.map((l) => [l.station_id, l]));
    const missing = [...srcByStation.entries()].filter(([sid]) => !tgtByStation.has(sid));
    if (missing.length) {
      await this.links.createMany(missing.map(([sid, l]) => ({
        task_id: target.task_id, station_id: sid, tenant_id: user.tenantId,
        station_code_snapshot: l.station_code_snapshot, station_name_snapshot: l.station_name_snapshot,
        bol_version: Number(l.bol_version), ct_snapshot: l.ct_snapshot, tt_snapshot: l.tt_snapshot,
        seq_no: tgtByStation.size + missing.findIndex(([s]) => s === sid) + 1,
      } as Partial<TaskStation>)));
      for (const [sid, l] of missing) tgtByStation.set(sid, l as TaskStation);
    }

    const elRepo = this.ds.getRepository(Element);
    const srcElements = await elRepo.find({ where: { tenant_id: user.tenantId, task_id: source.task_id } as any });
    // 只取源任务锁定版本的要素（与导出口径一致）
    const srcValid = srcElements.filter((e) => {
      const link = srcByStation.get(e.station_id);
      return link && Number(e.bol_version) === Number(link.bol_version);
    });
    const existing = await elRepo.find({ where: { tenant_id: user.tenantId, task_id: target.task_id } as any });
    const taken = new Set(existing.map((e) => `${e.station_id}|${e.bol_version}|${e.seq}`));
    const fresh = srcValid.filter((e) => !taken.has(`${e.station_id}|${e.bol_version}|${e.seq}`));
    if (!fresh.length) return { copied: 0, skipped: srcValid.length, task_id: target.task_id };

    const rows = fresh.map((e) => {
      const newId = taskElementId(target.task_no, e.station_id, Number(e.bol_version), Number(e.seq));
      if (newId.length > 96) throw new BadRequestException(`跨任务要素编码超长（96）：${newId}`);
      return elRepo.create({
        element_id: newId,
        tenant_id: user.tenantId,
        task_id: target.task_id,
        station_id: e.station_id,
        seq: e.seq,
        start_ms: e.start_ms,
        dur_s: e.dur_s,
        hand: e.hand,
        type: e.type,
        desc: e.desc,
        va_class: e.va_class,
        outlier_flag: e.outlier_flag,
        outlier_reason: e.outlier_reason,
        video_id: e.video_id,
        source: e.source,
        rating: e.rating,
        allowance: e.allowance,
        std_time: e.std_time,
        bol_version: e.bol_version,
      } as Partial<Element>);
    });
    await elRepo.save(rows, { chunk: 100 });
    this.log.log(`任务 ${target.task_no} 从 ${source.task_no} 复制要素 ${rows.length} 条（跳过 ${srcValid.length - rows.length}）`);
    return { copied: rows.length, skipped: srcValid.length - rows.length, task_id: target.task_id };
  }
}
