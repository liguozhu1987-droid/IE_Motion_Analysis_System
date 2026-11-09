import { Injectable } from '@nestjs/common';
import { DataSource, Repository, EntityTarget, ObjectLiteral, EntityManager } from 'typeorm';
import { currentTenantId } from '../../tenant/tenant-context';

/**
 * 显式事务全局串行锁（模块级 Promise 链）。
 * 动因：sqlite 驱动单连接共享，两个事务的 BEGIN 会互相踩；串行后彻底消除竞争。
 * 前一个事务成败不影响后一个入队（.then(fn, fn)）。
 */
let txChain: Promise<unknown> = Promise.resolve();
function withTxLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = txChain.then(fn, fn);
  txChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 租户安全仓库基类：所有 find/create/save/remove 强制附加 tenant_id 条件。
 * 用法：class StationRepo extends BaseRepository<Station> {} 注入即可。
 * 无租户上下文（如 seed/迁移脚本）时退化为不过滤——调用方须显式传 tenantId。
 */
@Injectable()
export class BaseRepository<T extends ObjectLiteral & { tenant_id?: string }> {
  constructor(protected readonly dataSource: DataSource) {}

  protected get repo(): Repository<T> {
    return this.dataSource.getRepository(this.entityTarget());
  }

  protected entityTarget(): EntityTarget<T> {
    throw new Error('子类必须实现 entityTarget()');
  }

  /** 自动带租户过滤的查询 */
  async find(where: ObjectLiteral = {}, opts: { order?: any; take?: number; relations?: string[] } = {}): Promise<T[]> {
    return this.repo.find({
      where: this.withTenant(where),
      order: opts.order,
      take: opts.take,
      relations: opts.relations,
    } as any);
  }

  async findOne(where: ObjectLiteral = {}): Promise<T | null> {
    return this.repo.findOne({ where: this.withTenant(where) } as any);
  }

  async count(where: ObjectLiteral = {}): Promise<number> {
    return this.repo.count({ where: this.withTenant(where) } as any);
  }

  /** 插入时自动注入 tenant_id */
  async create(data: Partial<T>): Promise<T> {
    const entity = this.repo.create({ ...data, tenant_id: this.resolveTenant(data.tenant_id) } as any);
    return this.repo.save(entity as any);
  }

  async createMany(items: Partial<T>[]): Promise<T[]> {
    const entities = items.map((d) => this.repo.create({ ...d, tenant_id: this.resolveTenant(d.tenant_id) } as any));
    return this.repo.save(entities as any);
  }

  /** 更新（自动租户过滤）；返回受影响行数 */
  async update(where: ObjectLiteral, patch: ObjectLiteral): Promise<number> {
    const r = await this.repo.update(this.withTenant(where) as any, patch as any);
    return r.affected ?? 0;
  }

  async remove(where: ObjectLiteral): Promise<number> {
    const r = await this.repo.delete(this.withTenant(where) as any);
    return r.affected ?? 0;
  }

  /**
   * 事务执行器（queryRunner 手动事务：兼容 sqlite 驱动 dataSource.transaction 的已知问题）。
   * 全局串行锁：TypeORM sqlite 驱动为全进程单一连接，并发显式事务会互相踩
   * （"cannot start a transaction within a transaction"）；生产 SQL Server 为连接池，
   * 串行化仅影响并发写吞吐（本平台写流量极低，可忽略）。
   * 注意：禁止在事务回调内再次调用 transaction()（会自锁）——当前无此用法。
   */
  async transaction<R>(fn: (manager: EntityManager) => Promise<R>): Promise<R> {
    return withTxLock(async () => {
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        const result = await fn(qr.manager);
        await qr.commitTransaction();
        return result;
      } catch (e) {
        await qr.rollbackTransaction();
        throw e;
      } finally {
        await qr.release();
      }
    });
  }

  private withTenant(where: ObjectLiteral): ObjectLiteral {
    const tid = currentTenantId();
    if (!tid) return where; // 无上下文：调用方显式负责
    return { ...where, tenant_id: where.tenant_id ?? tid };
  }

  private resolveTenant(explicit?: string): string {
    return explicit ?? currentTenantId() ?? 'DEFAULT';
  }
}
