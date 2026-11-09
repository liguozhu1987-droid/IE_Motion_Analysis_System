import { Module } from '@nestjs/common';
import { AlertMonitorService } from './alert-monitor.service';
import { AlertMailerService } from './mailer.service';
import { AlertsController } from './alerts.controller';

/**
 * 告警监控模块（盘点第 3 类）：日志告警默认开；SMTP 未配只落日志。
 * P0-4：新增 GET /api/alerts/status 只读观测端点（audit:read）。
 */
@Module({
  controllers: [AlertsController],
  providers: [AlertMailerService, AlertMonitorService],
  // P0-4：视频派生 worker 不再自行发信，磁盘告警统一由 AlertMonitorService 走这条通道
  exports: [AlertMailerService, AlertMonitorService],
})
export class AlertModule {}
