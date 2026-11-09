import { SetMetadata } from '@nestjs/common';

export const SKIP_AUDIT = 'skip_audit';

/**
 * 跳过全局审计拦截器（v3.58：此前仅存在于注释，机制缺失）。
 *
 * 必要场景：端点返回值含明文凭证（代置临时口令 / 重置码）——拦截器会把响应体
 * 原样写进 after_json，明文落库即成二次泄露面。此类端点须由业务代码自行写
 * 「操作者 + 动作」审计（users.service 已写），再以本装饰器关掉拦截器的响应体留痕。
 */
export const SkipAudit = () => SetMetadata(SKIP_AUDIT, true);
