import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { AlertMonitorService } from './alert-monitor.service';

/**
 * 告警只读观测面（P0-4）：各规则当前状态、上次触发时间、最近一次告警内容。
 * 权限沿用 audit:read（运维/审计只读口，不向普通用户暴露系统内部状态）；
 * 不回传 SMTP 账号/密码，只回传是否启用。
 * 前端页面不在本次范围：本端点先供运维脚本与 /api/metrics 旁的排障使用。
 */
@Controller('alerts')
export class AlertsController {
  constructor(private readonly monitor: AlertMonitorService) {}

  @Get('status')
  @RequirePermission('audit:read')
  status(): Record<string, unknown> {
    return this.monitor.getStatus();
  }
}
