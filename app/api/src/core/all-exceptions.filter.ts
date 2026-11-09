import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/** 全局异常过滤器：统一错误体 { title, status, detail, request_id }（与 MVP 口径一致） */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest();
    const res = ctx.getResponse();
    const requestId = (req.headers?.['x-request-id'] as string) || randomUUID().slice(0, 8);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = '服务器内部错误';
    let detail = '';
    const payload: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') detail = body;
      else if (body && typeof body === 'object') {
        const b = body as any;
        detail = Array.isArray(b.message) ? b.message.join('; ') : b.message ?? b.error ?? '';
        title = b.error ?? title;
        // 业务校验错误清单（V1/V2/V3/IMPORT 编码）随统一信封透传，前端逐条定位
        if (Array.isArray(b.errors)) payload.errors = b.errors;
        if (Array.isArray(b.warnings)) payload.warnings = b.warnings;
        // 业务附加字段：错误码 / 红线待确认清单 / 合法迁移表 / 操作提示
        if (typeof b.code === 'string') payload.code = b.code;
        if (Array.isArray(b.requires)) payload.requires = b.requires;
        if (b.allowed !== undefined) payload.allowed = b.allowed;
        if (typeof b.hint === 'string') payload.hint = b.hint;
      }
    } else if (exception instanceof Error) {
      detail = exception.message;
      this.log.error(`[${requestId}] ${exception.stack}`);
    }

    if (status >= 500) this.log.error(`[${requestId}] ${(exception as Error)?.message}`);
    res.status(status).json({ title, status, detail, ...payload, request_id: requestId });
  }
}
