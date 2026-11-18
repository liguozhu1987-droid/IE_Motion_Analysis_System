import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { AuthUser } from '../../auth/auth-user.interface';
import { DecompositionTask } from '../../entities/decomposition-task.entity';
import { TaskStation } from '../../entities/task-station.entity';
import { Station } from '../../entities/station.entity';
import { NO_SCOPE, TaskScope, TaskScopeSource, findReadableTask, scopeOf } from './task-scope';
import { markTaskScope } from './task-scope-context';
import { currentTenantId } from '../../tenant/tenant-context';

const isActive = (t: DecompositionTask) => String(t.status) === 'active' && t.round_type !== 'legacy';
const isLegacy = (t: DecompositionTask) => t.round_type === 'legacy';

/**
 * Phase 3 / Wave 1 · 任务上下文解析服务（D1）。
 *
 * 之所以做成只依赖 DataSource 的 @Global 服务：StationsService 也要用它给新建工位
 * 自动关联任务，若反过来注入 TasksService/StationsService 会形成模块循环依赖。
 * 任务可读性校验仍走 findReadableTask —— 与 TasksService.assertTaskReadable 同一实现。
 *
 * 【兼容保护】自动继承/回落路径的查询整体 try/catch：隔离 SQLite 空库可能没有
 * 任务表，此时降级为 NO_SCOPE（不附加 task_id 条件，行为与改造前完全一致）；
 * 显式 task_id 的 404/400/409 一律不吞，权限语义不打折。
 */
@Injectable()
export class TaskScopeService {
  private readonly log = new Logger(TaskScopeService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /**
   * 便捷入口：从请求级租户 ALS 取 tenantId，供没有 AuthUser 参数的 Service 使用。
   * 自动继承/回落与显式校验都只依赖 tenantId，故语义与 resolve() 完全一致。
   */
  async resolveCurrent(stationId: string, explicit?: string | null): Promise<TaskScope> {
    return this.resolve({ tenantId: currentTenantId() ?? 'DEFAULT' } as AuthUser, stationId, explicit);
  }

  async resolveForLineCurrent(lineId: string, explicit?: string | null): Promise<TaskScope> {
    return this.resolveForLine({ tenantId: currentTenantId() ?? 'DEFAULT' } as AuthUser, lineId, explicit);
  }

  /** 单工位上下文（读/写要素的主入口） */
  async resolve(user: AuthUser, stationId: string, explicit?: string | null): Promise<TaskScope> {
    const scope = await this.resolveStation(user, stationId, explicit);
    markTaskScope(scope);
    return scope;
  }

  /** 产线级上下文（产线分析 / 对比；产线归属多个生效任务时要求显式指定） */
  async resolveForLine(user: AuthUser, lineId: string, explicit?: string | null): Promise<TaskScope> {
    let scope: TaskScope;
    if (explicit) {
      const t = await findReadableTask(this.ds, explicit, user);
      if (String(t.line_id) !== String(lineId)) {
        throw new BadRequestException(`任务 ${t.task_no} 不属于产线 ${lineId}`);
      }
      scope = scopeOf(t, 'explicit');
    } else {
      scope = await this.guardAuto(async () => {
        const tasks = await this.tasksOfLine(user.tenantId, lineId);
        return this.autoScope(tasks, `产线 ${lineId}`);
      });
    }
    markTaskScope(scope);
    return scope;
  }

  /**
   * 跨工位 / 跨产线聚合（dashboard / lines）：返回 station_id → scope。
   *
   * 任务属于单产线，但驾驶舱与产线概览天然跨产线：显式指定任务时，
   * 只有该任务产线的工位采用它；其余工位按各自默认上下文（自动继承或
   * 本产线 legacy）解析，绝不因「工位不属于该任务」把整张看板打成 400。
   * 这样既保证 A 任务要素不串进 B 任务，也不破坏既有跨产线聚合口径。
   */
  async resolveStationMap(
    stations: { station_id: string; tenant_id: string; line_id: string }[],
    explicit?: string | null,
  ): Promise<Map<string, TaskScope>> {
    let explicitTask: DecompositionTask | null = null;
    if (explicit) {
      explicitTask = await findReadableTask(this.ds, explicit,
        { tenantId: currentTenantId() ?? 'DEFAULT' } as AuthUser);
    }
    const out = new Map<string, TaskScope>();
    for (const s of stations) {
      const user = { tenantId: s.tenant_id ?? currentTenantId() ?? 'DEFAULT' } as AuthUser;
      const scope = explicitTask && String(s.line_id) === String(explicitTask.line_id)
        ? scopeOf(explicitTask, 'explicit')
        : await this.resolve(user, String(s.station_id));
      out.set(String(s.station_id), scope);
    }
    if (out.size) markTaskScope([...out.values()][0]);
    return out;
  }

  /**
   * A-103-6：新建工位自动关联当前任务写 t_task_station（锁 bol_version）。
   * 前端无需新增必填步骤；多生效任务或无任务按 D2 回落 legacy / none 并标注。
   * 失败只告警不阻断建工位（隔离 SQLite 无任务表时必须能建工位）。
   */
  async linkNewStation(
    user: AuthUser,
    station: { station_id: string; line_id: string; name: string; version: number; ct?: number | null; tt?: number | null },
    explicit?: string | null,
  ): Promise<{ task_id: string | null; linked: boolean; source: TaskScopeSource }> {
    try {
      let scope: TaskScope;
      if (explicit) {
        const t = await findReadableTask(this.ds, explicit, user);
        if (String(t.line_id) !== String(station.line_id)) {
          throw new BadRequestException(`任务 ${t.task_no} 不属于产线 ${station.line_id}`);
        }
        scope = scopeOf(t, 'explicit');
      } else {
        scope = await this.guardAuto(async () => {
          const tasks = await this.tasksOfLine(user.tenantId, station.line_id);
          const active = tasks.filter(isActive);
          if (active.length === 1) return scopeOf(active[0], 'inherited');
          // 多生效任务时不臆测归属：回落 legacy 并标注（不返回 409，建工位不应被打断）
          const legacy = tasks.find(isLegacy);
          return legacy ? scopeOf(legacy, 'legacy-fallback') : NO_SCOPE;
        });
      }
      if (!scope.task_id) return { task_id: null, linked: false, source: scope.source };

      const repo = this.ds.getRepository(TaskStation);
      const exists = await repo.findOne({
        where: { tenant_id: user.tenantId, task_id: scope.task_id, station_id: station.station_id },
      } as any);
      if (!exists) {
        const links = await repo.find({ where: { tenant_id: user.tenantId, task_id: scope.task_id } } as any);
        const maxSeq = links.reduce((a, l) => Math.max(a, Number(l.seq_no) || 0), 0);
        await repo.save(repo.create({
          task_id: scope.task_id,
          station_id: station.station_id,
          tenant_id: user.tenantId,
          station_code_snapshot: station.station_id,
          station_name_snapshot: station.name,
          bol_version: Number(station.version) || 1,
          ct_snapshot: station.ct ?? null,
          tt_snapshot: station.tt ?? null,
          seq_no: maxSeq + 1,
        } as any));
      }
      markTaskScope(scope);
      return { task_id: scope.task_id, linked: true, source: scope.source };
    } catch (e) {
      if (e instanceof BadRequestException || e instanceof NotFoundException) throw e;
      this.log.warn(`新建工位任务关联降级（不阻断建工位）: ${(e as Error).message}`);
      return { task_id: null, linked: false, source: 'none' };
    }
  }

  private async resolveStation(user: AuthUser, stationId: string, explicit?: string | null): Promise<TaskScope> {
    if (explicit) {
      const t = await findReadableTask(this.ds, explicit, user);
      const station = await this.ds.getRepository(Station).findOne({
        where: { station_id: stationId, tenant_id: user.tenantId },
      } as any);
      if (!station) throw new NotFoundException(`工位 ${stationId} 不存在`);
      if (String(station.line_id) !== String(t.line_id)) {
        throw new BadRequestException(`任务 ${t.task_no} 不属于产线 ${station.line_id}`);
      }
      return scopeOf(t, 'explicit');
    }
    return this.guardAuto(async () => {
      const station = await this.ds.getRepository(Station).findOne({
        where: { station_id: stationId, tenant_id: user.tenantId },
      } as any);
      if (!station) return NO_SCOPE;
      const links = await this.ds.getRepository(TaskStation).find({
        where: { tenant_id: user.tenantId, station_id: stationId },
      } as any);
      const ids = [...new Set(links.map((l) => String(l.task_id)))];
      let tasks: DecompositionTask[] = [];
      if (ids.length) {
        tasks = await this.ds.getRepository(DecompositionTask).find({
          where: { tenant_id: user.tenantId, task_id: In(ids) },
        } as any);
      }
      const active = tasks.filter(isActive);
      if (active.length) return this.autoScope(active, `工位 ${stationId}`);
      const all = await this.tasksOfLine(user.tenantId, station.line_id);
      const legacy = all.find(isLegacy);
      return legacy ? scopeOf(legacy, 'legacy-fallback') : NO_SCOPE;
    });
  }

  private autoScope(tasks: DecompositionTask[], subject: string): TaskScope {
    const active = tasks.filter(isActive);
    if (active.length === 1) return scopeOf(active[0], 'inherited');
    if (active.length > 1) {
      throw new ConflictException({
        message: `${subject} 归属多个生效分解任务，请显式指定 task_id`,
        candidates: active.map((t) => ({ task_id: t.task_id, task_no: t.task_no, name: t.name })),
      });
    }
    const legacy = tasks.find(isLegacy);
    return legacy ? scopeOf(legacy, 'legacy-fallback') : NO_SCOPE;
  }

  private async tasksOfLine(tenantId: string, lineId: string): Promise<DecompositionTask[]> {
    return this.ds.getRepository(DecompositionTask).find({
      where: { tenant_id: tenantId, line_id: lineId },
    } as any);
  }

  /** 自动继承/回落路径的兼容保护：业务异常原样抛，环境性异常降级 NO_SCOPE */
  private async guardAuto(fn: () => Promise<TaskScope>): Promise<TaskScope> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ConflictException || e instanceof BadRequestException || e instanceof NotFoundException) throw e;
      this.log.warn(`任务上下文解析降级为兼容模式: ${(e as Error).message}`);
      return NO_SCOPE;
    }
  }
}
