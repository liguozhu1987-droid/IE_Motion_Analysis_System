import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AuthUser } from '../auth/auth-user.interface';

/** 审计落库失败的可见性（v3.58）：静默吞异常 = 追溯链断了还以为没断 */
const SENSITIVE_KEYS = new Set(['tempPassword', 'code', 'resetCode', 'password',
  'newPassword', 'oldPassword', 'accessToken', 'refreshToken']);

/** 深度脱敏：命中敏感键一律替换，避免明文凭证随响应体落入审计表 */
function sanitize(v: any, depth = 0): any {
  if (v === null || v === undefined) return v;
  if (depth > 4) return '[TRUNCATED]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitize(x, depth + 1));
  if (typeof v !== 'object') return v;
  const out: Record<string, any> = {};
  Object.entries(v).forEach(([k, val]) => {
    out[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : sanitize(val, depth + 1);
  });
  return out;
}

/** 审计服务：写操作异步落 t_audit_log，不阻塞响应 */
@Injectable()
export class AuditService {
  private readonly log = new Logger('AuditService');

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  record(user: AuthUser | null, action: string, entity: string, entityId: string | null, before: any, after: any, ip: string): void {
    const repo = this.ds.getRepository('t_audit_log');
    // transaction:false：单行 INSERT 无需自带 BEGIN——sqlite 单连接共享下，
    // 即发即忘的审计保存若自带事务，会与请求的显式事务race（BEGIN 套 BEGIN）。
    // v3.58.1 截断兜底：action/entity 超 DB 列长（128/64）时截断——列长不匹配的
    // TDS 错误只会让整条审计静默丢失（比截断更糟）。action 由 path 派生可能极长。
    const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
    void repo.save(repo.create({
      log_id: randomUUID(),
      tenant_id: user?.tenantId ?? 'DEFAULT',
      user_id: user?.userId ?? null,
      username: user?.username ?? null,
      action: clip(action, 128), entity: clip(entity, 64), entity_id: entityId ? clip(entityId, 64) : null,
      before_json: before ? JSON.stringify(sanitize(before)) : null,
      after_json: after ? JSON.stringify(sanitize(after)) : null,
      ip,
    } as any), { transaction: false } as any)
      .catch((e) => this.log.error(`审计写入失败 ${action}/${entity}/${entityId ?? '-'}: ${(e as Error).message}`));
  }
}
