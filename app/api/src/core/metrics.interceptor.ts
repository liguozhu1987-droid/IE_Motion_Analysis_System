import { NestInterceptor, ExecutionContext, CallHandler, Injectable } from '@nestjs/common';
import { tap } from 'rxjs';
import { register, Counter, Histogram } from 'prom-client';

const httpRequests = new Counter({
  name: 'ie_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpDuration = new Histogram({
  name: 'ie_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

/** 指标拦截器：QPS / 延迟分位（/api/metrics 暴露） */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): any {
    const req = ctx.switchToHttp().getRequest();
    const start = process.hrtime.bigint();
    const method = req.method ?? 'GET';
    const route = req.route?.path ?? req.path ?? '';
    return next.handle().pipe(
      tap({
        next: () => this.finish(start, method, route, '2xx'),
        error: () => this.finish(start, method, route, '5xx'),
      }),
    );
  }

  private finish(start: bigint, method: string, route: string, status: string): void {
    const dur = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequests.inc({ method, route, status });
    httpDuration.observe({ method, route }, dur);
  }
}
