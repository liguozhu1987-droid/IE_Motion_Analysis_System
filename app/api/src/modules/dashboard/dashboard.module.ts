import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { StationsModule } from '../stations/stations.module';

/**
 * 集团综合驾驶舱模块（v3.3）：GET /dashboard/summary 跨租户聚合。
 * 直接注入 DataSource 做聚合查询（绕过 BaseRepository 租户过滤，
 * 由 group:read 权限把关——只读计数/均值，不读要素明细）。
 * v3.55：引入 StationsModule → 控制器按调用者可见工位收口聚合范围。
 */
@Module({
  imports: [StationsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
